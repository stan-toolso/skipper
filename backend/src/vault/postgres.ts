import pg from 'pg';
import { AppError } from '../errors.js';
import { connect as sshConnect, openTunnel, type SshSession, type Tunnel } from './ssh.js';
import type { PostgresCredentials } from './types.js';

/**
 * Client PostgreSQL des éléments du coffre : une connexion par requête, éventuellement à travers un
 * tunnel SSH, en lecture seule si l'élément l'exige. Une seule instruction par appel (protocole étendu) ;
 * les lignes passent par un curseur : au plus maxRows + 1 lignes quittent la base.
 */

export const SQL_MAX_ROWS = 200;
export const SQL_TIMEOUT_MS = 30_000;
/** Base de connexion d'un élément rattaché à un serveur entier, quand l'agent n'en nomme pas une. */
export const MAINTENANCE_DATABASE = 'postgres';

/** Nom de base PostgreSQL acceptable : lettres, chiffres, `_`, `-` et `$`, 63 octets au plus (cité en identifiant dans le SQL). */
export function validateDatabaseName(name: string | null | undefined, label = 'Le nom de la base'): string {
  const n = (name ?? '').trim();
  if (!n || Buffer.byteLength(n, 'utf8') > 63 || !/^[A-Za-z0-9_][A-Za-z0-9_$-]*$/.test(n)) throw new AppError(`${label} est invalide : lettres, chiffres, _ - $, 63 caractères au plus${n ? ` (« ${n} »)` : ''}`);
  return n;
}

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

/**
 * TLS : avec un certificat d'autorité fourni, la chaîne est vérifiée contre lui seul, sans contrôle du nom
 * d'hôte (Cloud SQL nomme l'instance, pas son adresse) ; sinon contre les autorités publiques, nom compris,
 * sauf VAULT_POSTGRES_SSL_VERIFY=false (certificats auto-signés).
 */
function sslConfig(creds: PostgresCredentials): pg.ClientConfig['ssl'] {
  if (!creds.ssl) return false;
  if (creds.sslCa) return { ca: creds.sslCa, rejectUnauthorized: true, checkServerIdentity: () => undefined };
  return { rejectUnauthorized: process.env.VAULT_POSTGRES_SSL_VERIFY !== 'false' };
}

/** Codes TLS d'une chaîne non reconnue par les autorités publiques (RDS, Cloud SQL, autorité privée). */
const UNTRUSTED_CHAIN = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

/** Message d'échec de connexion, avec la marche à suivre quand l'autorité du serveur manque. */
export function connectionErrorMessage(creds: Pick<PostgresCredentials, 'username' | 'host' | 'port' | 'database' | 'sslCa'>, err: Error & { code?: string }): string {
  let msg = `Connexion PostgreSQL à ${creds.username}@${creds.host}:${creds.port}/${creds.database} impossible : ${err.message}`;
  if (err.code && UNTRUSTED_CHAIN.has(err.code)) {
    msg += creds.sslCa
      ? ' (le certificat d\'autorité de l\'élément ne valide pas la chaîne du serveur : vérifiez qu\'il s\'agit du bon, par exemple le bundle de la région pour RDS)'
      : ' (autorité inconnue : collez le certificat de l\'autorité du serveur dans l\'élément du coffre, par exemple le bundle de la région pour RDS : https://truststore.pki.rds.amazonaws.com/<région>/<région>-bundle.pem)';
  }
  return msg;
}

/** Ouvre le tunnel SSH si besoin puis la connexion PostgreSQL. */
async function open(creds: PostgresCredentials, readOnly: boolean): Promise<Opened> {
  let ssh: SshSession | null = null;
  let tunnel: Tunnel | null = null;
  let host = creds.host;
  let port = creds.port;
  if (creds.via) {
    ssh = await sshConnect(creds.via.credentials, creds.via.item.hostKey);
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
    ssl: sslConfig(creds),
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
    throw e instanceof AppError ? e : new AppError(connectionErrorMessage(creds, e), 'POSTGRES');
  }
  return { client, close, sshHostKey: ssh?.hostKey ?? null };
}

/** L'instruction renvoie-t-elle des lignes (SELECT, WITH, VALUES, TABLE) ? */
const returnsRows = (sql: string) => /^\s*\(*\s*(select|with|values|table)\b/i.test(sql);

/**
 * Exécute une instruction SQL (une seule par appel : le protocole étendu en refuse plusieurs), dans une
 * transaction READ ONLY pour un élément en lecture seule. Les instructions qui renvoient des lignes passent
 * par un curseur : au plus `maxRows + 1` lignes sont lues.
 */
export async function query(creds: PostgresCredentials, sql: string, readOnly: boolean, maxRows = SQL_MAX_ROWS): Promise<QueryResult & { sshHostKey: string | null }> {
  const started = Date.now();
  const opened = await open(creds, readOnly);
  const sqlError = (err: Error) => {
    throw new AppError(`Erreur SQL : ${err.message}`, 'POSTGRES');
  };
  try {
    const c = opened.client;
    await c.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    // Verrouille le mode de la transaction : un SET TRANSACTION READ WRITE ultérieur est refusé.
    await c.query('SELECT 1');
    let statements: QueryResult['statements'];
    try {
      if (returnsRows(sql)) {
        await c.query('SAVEPOINT skipper_cursor');
        let declared = true;
        try {
          await c.query({ text: `DECLARE skipper_cur NO SCROLL CURSOR FOR ${sql}`, values: [] });
        } catch (err) {
          if (!/DECLARE CURSOR|data-modifying|cannot be declared/i.test((err as Error).message)) sqlError(err as Error);
          declared = false;
          await c.query('ROLLBACK TO SAVEPOINT skipper_cursor');
        }
        if (declared) {
          const raw = await c.query({ text: `FETCH FORWARD ${maxRows + 1} FROM skipper_cur`, rowMode: 'array' as const, values: [] }).catch(sqlError);
          await c.query('CLOSE skipper_cur');
          statements = [statementOf(raw as pg.QueryArrayResult, maxRows, 'SELECT')];
        } else {
          const raw = await c.query({ text: sql, rowMode: 'array' as const, values: [] }).catch(sqlError);
          statements = [statementOf(raw as pg.QueryArrayResult, maxRows)];
        }
      } else {
        const raw = await c.query({ text: sql, rowMode: 'array' as const, values: [] }).catch(sqlError);
        statements = [statementOf(raw as pg.QueryArrayResult, maxRows)];
      }
      await c.query(readOnly ? 'ROLLBACK' : 'COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    return { statements, durationMs: Date.now() - started, sshHostKey: opened.sshHostKey };
  } finally {
    await opened.close();
  }
}

function statementOf(r: pg.QueryArrayResult, maxRows: number, command?: string): QueryResult['statements'][number] {
  const fields = r.fields.map((f) => f.name);
  const rows = r.rows.slice(0, maxRows).map((values) => Object.fromEntries(fields.map((name, i) => [name, values[i]])));
  const truncated = r.rows.length > maxRows;
  return { command: command ?? r.command, rowCount: truncated ? null : (fields.length ? r.rows.length : r.rowCount), fields, rows, truncated };
}

/** Vérifie la connexion et renvoie la version du serveur (serverWide : l'élément couvre toutes les bases, la connexion de test passe par la base de maintenance). */
export async function probe(creds: PostgresCredentials, serverWide = false): Promise<{ detail: string; sshHostKey: string | null }> {
  const opened = await open(creds, true);
  try {
    const { rows } = await opened.client.query<{ version: string; db: string; usr: string; databases: string }>(
      'SELECT version() AS version, current_database() AS db, current_user AS usr, (SELECT count(*) FROM pg_database WHERE datallowconn) AS databases',
    );
    const scope = serverWide ? `toutes les bases (${rows[0].databases}, connexion par ${rows[0].db})` : `base ${rows[0].db}`;
    return { detail: `${rows[0].version.split(',')[0]} · ${scope} · utilisateur ${rows[0].usr}`, sshHostKey: opened.sshHostKey };
  } finally {
    await opened.close();
  }
}

/** Requête listant les bases du serveur (nom, propriétaire, taille quand le rôle peut s'y connecter). */
export function databasesSql(): string {
  return `SELECT d.datname AS database, pg_catalog.pg_get_userbyid(d.datdba) AS owner,
       CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_size_pretty(pg_database_size(d.datname)) END AS size,
       d.datistemplate AS template
       FROM pg_database d WHERE d.datallowconn ORDER BY d.datname`;
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
    const footer = s.truncated ? `\n(${s.rows.length} lignes affichées, d'autres existent : affinez la requête ou utilisez LIMIT)` : `\n(${s.rows.length} ligne(s))`;
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
