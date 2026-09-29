import pg from 'pg';
import { AppError } from '../errors.js';
import { connect as sshConnect, openTunnel, type SshSession, type Tunnel } from './ssh.js';
import type { PostgresCredentials } from './types.js';

/**
 * Client PostgreSQL pour les connexions des projets : une connexion par requête, éventuellement à
 * travers un tunnel SSH, en lecture seule si la connexion l'exige.
 */

export const SQL_MAX_ROWS = 200;
export const SQL_TIMEOUT_MS = 30_000;

export interface QueryResult {
  /** Une entrée par instruction exécutée. */
  statements: { command: string; rowCount: number | null; fields: string[]; rows: Record<string, unknown>[]; truncated: boolean }[];
  durationMs: number;
}

interface Opened {
  client: pg.Client;
  close(): Promise<void>;
  /** Clé d'hôte SSH présentée par le serveur intermédiaire, le cas échéant. */
  sshHostKey: string | null;
}

/** Ouvre le tunnel SSH si besoin puis la connexion PostgreSQL. */
async function open(creds: PostgresCredentials, readOnly: boolean): Promise<Opened> {
  let ssh: SshSession | null = null;
  let tunnel: Tunnel | null = null;
  let host = creds.host;
  let port = creds.port;
  if (creds.via) {
    ssh = await sshConnect(creds.via.credentials, creds.via.connection.hostKey);
    tunnel = await openTunnel(ssh, creds.host, creds.port);
    host = '127.0.0.1';
    port = tunnel.port;
  }
  const client = new pg.Client({
    host,
    port,
    user: creds.username,
    password: creds.password ?? undefined,
    database: creds.database,
    ssl: creds.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15_000,
    statement_timeout: SQL_TIMEOUT_MS,
    application_name: 'skipper',
  });
  const close = async () => {
    await client.end().catch(() => undefined);
    await tunnel?.close();
    ssh?.close();
  };
  try {
    await client.connect();
    if (readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  } catch (err) {
    await close();
    const e = err as Error;
    throw e instanceof AppError ? e : new AppError(`Connexion PostgreSQL à ${creds.username}@${creds.host}:${creds.port}/${creds.database} impossible : ${e.message}`, 'POSTGRES');
  }
  return { client, close, sshHostKey: ssh?.hostKey ?? null };
}

/** Exécute une ou plusieurs instructions SQL (protocole simple, sans paramètres). */
export async function query(creds: PostgresCredentials, sql: string, readOnly: boolean, maxRows = SQL_MAX_ROWS): Promise<QueryResult & { sshHostKey: string | null }> {
  const started = Date.now();
  const opened = await open(creds, readOnly);
  try {
    const raw = await opened.client.query({ text: sql, rowMode: 'array' as const }).catch((err: Error) => {
      throw new AppError(`Erreur SQL : ${err.message}`, 'POSTGRES');
    });
    const results = (Array.isArray(raw) ? raw : [raw]) as pg.QueryArrayResult[];
    const statements = results.map((r) => {
      const fields = r.fields.map((f) => f.name);
      const rows = r.rows.slice(0, maxRows).map((values) => Object.fromEntries(fields.map((name, i) => [name, values[i]])));
      return { command: r.command, rowCount: r.rowCount, fields, rows, truncated: r.rows.length > maxRows };
    });
    return { statements, durationMs: Date.now() - started, sshHostKey: opened.sshHostKey };
  } finally {
    await opened.close();
  }
}

/** Vérifie la connexion et renvoie la version du serveur. */
export async function probe(creds: PostgresCredentials): Promise<{ detail: string; sshHostKey: string | null }> {
  const opened = await open(creds, true);
  try {
    const { rows } = await opened.client.query<{ version: string; db: string; usr: string }>('SELECT version() AS version, current_database() AS db, current_user AS usr');
    return { detail: `${rows[0].version.split(',')[0]} · base ${rows[0].db} · utilisateur ${rows[0].usr}`, sshHostKey: opened.sshHostKey };
  } finally {
    await opened.close();
  }
}

/** Valeur SQL présentable en texte (dates, JSON, tableaux, binaires). */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex').slice(0, 64)}${v.length > 32 ? '…' : ''}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Tableau Markdown compact d'un résultat, pour l'agent. */
export function renderResult(result: QueryResult): string {
  const parts = result.statements.map((s) => {
    if (s.fields.length === 0) return `${s.command}${s.rowCount != null ? ` : ${s.rowCount} ligne(s) affectée(s)` : ''}`;
    if (s.rows.length === 0) return `${s.command} : aucune ligne (colonnes : ${s.fields.join(', ')})`;
    const header = `| ${s.fields.join(' | ')} |\n| ${s.fields.map(() => '---').join(' | ')} |`;
    const body = s.rows.map((row) => `| ${s.fields.map((f) => formatValue(row[f]).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`).join('\n');
    const footer = s.truncated ? `\n(${s.rowCount ?? '?'} lignes au total, ${s.rows.length} affichées : affinez la requête ou utilisez LIMIT)` : `\n(${s.rows.length} ligne(s))`;
    return `${header}\n${body}${footer}`;
  });
  return `${parts.join('\n\n')}\n\nDurée : ${result.durationMs} ms`;
}

/** Requête décrivant le schéma : tables et colonnes, éventuellement d'une seule table. */
export function schemaSql(table: string | null): string {
  const filter = table
    ? `AND (c.table_name = ${literal(table.includes('.') ? table.split('.').pop()! : table)}${table.includes('.') ? ` AND c.table_schema = ${literal(table.split('.')[0])}` : ''})`
    : '';
  return table
    ? `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
       FROM information_schema.columns c
       WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') ${filter}
       ORDER BY c.table_schema, c.table_name, c.ordinal_position`
    : `SELECT t.table_schema, t.table_name, t.table_type, (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS columns
       FROM information_schema.tables t
       WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY t.table_schema, t.table_name`;
}

function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
