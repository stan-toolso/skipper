import { pool } from '../db/pool.js';
import { vaultService } from '../vault/service.js';
import { kindLabels as vaultKindLabels } from '../vault/types.js';
import { log } from '../log.js';
import { idPrefixOf, shortRefOf, uuidRange } from './idPrefix.js';

/**
 * Recherche globale (palette ⌘K) : projets, sessions, terminaux, tâches et éléments du coffre
 * que la personne peut voir. Chaque mot de la requête doit apparaître ; les titres qui commencent par la
 * requête viennent d'abord, puis ceux qui la contiennent, puis le reste par date de mise à jour. Une requête qui
 * ressemble à un identifiant (« 313c1101 ») trouve aussi la session (même archivée), la tâche, le projet ou le
 * terminal dont l'identifiant commence par elle.
 */

export type SearchKind = 'PROJECT' | 'SESSION' | 'TERMINAL' | 'TASK' | 'VAULT_ITEM';
export const SEARCH_KINDS: SearchKind[] = ['PROJECT', 'SESSION', 'TERMINAL', 'TASK', 'VAULT_ITEM'];

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  detail: string | null;
  projectId: string | null;
  projectName: string | null;
  /** Projet dont la personne n'est pas membre (super administrateur). */
  outsideProjects: boolean;
  worksessionBranch: string | null;
  status: string | null;
  activity: string | null;
  updatedAt: Date;
}

export interface SearchGroup {
  kind: SearchKind;
  hits: SearchHit[];
  /** Correspondances du type, celles renvoyées comprises. */
  total: number;
}

export interface SearchScope {
  userId: string;
  /** Projets dont la personne est membre. */
  memberProjectIds: string[];
  /** Projets interrogés (tous pour un super administrateur). */
  projectIds: string[];
  /** Fenêtre dédiée à un projet : les éléments du coffre se limitent à ceux de ce projet (projectIds ne contient alors que lui). */
  onlyProjectId?: string;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const words = (query: string) => query.trim().split(/\s+/).filter(Boolean);


interface RawRow {
  id: string;
  title: string;
  detail: string | null;
  project_id: string | null;
  project_name: string | null;
  worksession_branch: string | null;
  status: string | null;
  activity: string | null;
  updated_at: Date;
  total: string;
}

/** Requête d'un type : `haystack` concatène les colonnes cherchées, `title` sert au classement. */
/**
 * `hidden` : condition des éléments écartés d'ordinaire (sessions archivées) mais retrouvés par leur identifiant.
 * Une requête qui ressemble à un identifiant (`idPrefixOf`) trouve aussi l'élément dont l'identifiant commence par
 * elle, classé en tête.
 */
async function searchKind(kind: SearchKind, sql: { from: string; title: string; detail: string; haystack: string; projectId: string; worksessionBranch: string; status: string; activity: string; updatedAt: string; where: string; visible?: string }, scope: SearchScope, query: string, limit: number): Promise<SearchGroup | null> {
  if (!scope.projectIds.length) return null;
  const params: unknown[] = [scope.projectIds];
  const terms = words(query).map((w) => `${sql.haystack} ILIKE $${params.push(`%${escapeLike(w)}%`)}`);
  const visible = sql.visible ?? 'TRUE';
  const textMatch = `(${[visible, ...terms].join(' AND ')})`;
  const prefix = idPrefixOf(query);
  const idMatch = prefix ? `x.id::text LIKE $${params.push(`${prefix}%`)}` : null;
  const q = query.trim().toLowerCase();
  const rank = q ? `CASE ${idMatch ? `WHEN ${idMatch} THEN -1 ` : ''}WHEN lower(${sql.title}) LIKE $${params.push(`${escapeLike(q)}%`)} THEN 0 WHEN lower(${sql.title}) LIKE $${params.push(`%${escapeLike(q)}%`)} THEN 1 ELSE 2 END` : '2';
  params.push(limit);
  const { rows } = await pool.query<RawRow>(
    `SELECT x.id, ${sql.title} AS title, ${sql.detail} AS detail, ${sql.projectId} AS project_id, p.name AS project_name, ${sql.worksessionBranch} AS worksession_branch,
            ${sql.status} AS status, ${sql.activity} AS activity, ${sql.updatedAt} AS updated_at, count(*) OVER () AS total
     FROM ${sql.from} LEFT JOIN projects p ON p.id = ${sql.projectId}
     WHERE ${sql.projectId} = ANY($1::uuid[]) ${sql.where} AND ${idMatch ? `(${idMatch} OR ${textMatch})` : textMatch}
     ORDER BY ${rank}, ${sql.updatedAt} DESC NULLS LAST
     LIMIT $${params.length}`,
    params,
  );
  if (!rows.length) return null;
  const members = new Set(scope.memberProjectIds);
  return {
    kind,
    total: Number(rows[0].total),
    hits: rows.map((r) => ({
      kind,
      id: r.id,
      title: r.title,
      detail: r.detail || null,
      projectId: r.project_id,
      projectName: r.project_name,
      outsideProjects: Boolean(r.project_id) && !members.has(r.project_id!),
      worksessionBranch: r.worksession_branch,
      status: r.status,
      activity: r.activity,
      updatedAt: r.updated_at,
    })),
  };
}

export interface ResolvedRef {
  prefix: string;
  kind: 'task' | 'session';
  id: string;
}

/** Débuts d'identifiants résolus en une seule requête au plus. */
export const MAX_REFS = 200;

/**
 * Débuts d'identifiants cités seuls dans un texte (« **56f64f35** : … ») : ceux qui désignent une seule tâche ou
 * session (même archivée) des projets donnés. Les autres (commit, identifiant d'un projet inaccessible, préfixe
 * ambigu) sont omis : ils restent du texte. Cherché par plages de la clé primaire (index), sans `LIKE`.
 */
export async function resolveRefs(projectIds: string[], prefixes: string[]): Promise<ResolvedRef[]> {
  const wanted = [...new Set(prefixes.map(shortRefOf).filter((p): p is string => p !== null))].slice(0, MAX_REFS);
  if (!wanted.length || !projectIds.length) return [];
  const ranges = wanted.map(uuidRange);
  const { rows } = await pool.query<{ prefix: string; kind: 'task' | 'session'; id: string }>(
    `WITH r(prefix, lo, hi) AS (SELECT * FROM unnest($2::text[], $3::uuid[], $4::uuid[]))
     SELECT r.prefix, 'task' AS kind, t.id FROM r JOIN tasks t ON t.id BETWEEN r.lo AND r.hi WHERE t.project_id = ANY($1::uuid[])
     UNION ALL
     SELECT r.prefix, 'session' AS kind, s.id FROM r JOIN sessions s ON s.id BETWEEN r.lo AND r.hi WHERE s.project_id = ANY($1::uuid[]) AND s.kind = 'session'`,
    [projectIds, wanted, ranges.map((r) => r[0]), ranges.map((r) => r[1])],
  );
  const byPrefix = new Map<string, ResolvedRef[]>();
  for (const r of rows) byPrefix.set(r.prefix, [...(byPrefix.get(r.prefix) ?? []), { prefix: r.prefix, kind: r.kind, id: r.id }]);
  return [...byPrefix.values()].filter((list) => list.length === 1).map((list) => list[0]);
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const searchService = {
  async search(scope: SearchScope, query: string, kinds: SearchKind[] | null | undefined, limit: number | null | undefined): Promise<SearchGroup[]> {
    const n = Math.min(Math.max(limit ?? 8, 1), 50);
    const wanted = kinds?.length ? SEARCH_KINDS.filter((k) => kinds.includes(k)) : SEARCH_KINDS;
    const jobs: Record<SearchKind, () => Promise<SearchGroup | null>> = {
      PROJECT: () =>
        searchKind('PROJECT', { from: 'projects x', title: 'x.name', detail: 'x.description', haystack: "(x.name || ' ' || x.slug || ' ' || coalesce(x.description, ''))", projectId: 'x.id', worksessionBranch: 'NULL', status: 'NULL', activity: 'NULL', updatedAt: 'x.updated_at', where: '' }, scope, query, n),
      SESSION: () =>
        searchKind('SESSION', { from: 'sessions x LEFT JOIN worksessions w ON w.id = x.worksession_id', title: 'x.name', detail: 'x.provider', haystack: 'x.name', projectId: 'x.project_id', worksessionBranch: 'w.branch', status: "CASE WHEN x.archived_at IS NOT NULL THEN 'archived' ELSE x.status::text END", activity: 'x.activity', updatedAt: 'x.updated_at', where: "AND x.kind = 'session'", visible: 'x.archived_at IS NULL' }, scope, query, n),
      TERMINAL: () =>
        searchKind('TERMINAL', { from: 'terminals x LEFT JOIN worksessions w ON w.id = x.worksession_id', title: 'x.name', detail: 'NULL', haystack: 'x.name', projectId: 'x.project_id', worksessionBranch: 'w.branch', status: 'x.status::text', activity: 'NULL', updatedAt: 'x.created_at', where: `AND (x.created_by IS NULL OR x.created_by = '${scope.userId}')` }, scope, query, n),
      TASK: () =>
        searchKind('TASK', { from: 'tasks x', title: 'x.title', detail: 'x.priority::text', haystack: "(x.title || ' ' || x.description || ' ' || coalesce(x.branch, ''))", projectId: 'x.project_id', worksessionBranch: 'x.branch', status: 'x.status::text', activity: 'NULL', updatedAt: 'x.updated_at', where: '' }, scope, query, n),
      VAULT_ITEM: async () => {
        const items = await vaultService.listAccessible(scope.userId);
        const q = normalize(query.trim());
        const ws = q.split(/\s+/).filter(Boolean);
        const matching = items.filter((i) => (!scope.onlyProjectId || i.ownerProjectId === scope.onlyProjectId) && ws.every((w) => normalize(`${i.name} ${i.description} ${JSON.stringify(i.settings)}`).includes(w)));
        const rank = (name: string) => (!q ? 2 : normalize(name).startsWith(q) ? 0 : normalize(name).includes(q) ? 1 : 2);
        matching.sort((a, b) => rank(a.name) - rank(b.name) || b.updatedAt.getTime() - a.updatedAt.getTime());
        if (!matching.length) return null;
        const members = new Set(scope.memberProjectIds);
        return {
          kind: 'VAULT_ITEM' as const,
          total: matching.length,
          hits: matching.slice(0, n).map((i) => ({ kind: 'VAULT_ITEM' as const, id: i.id, title: i.name, detail: vaultKindLabels[i.kind], projectId: i.ownerProjectId, projectName: null, outsideProjects: Boolean(i.ownerProjectId) && !members.has(i.ownerProjectId!), worksessionBranch: null, status: i.kind, activity: null, updatedAt: i.updatedAt })),
        };
      },
    };
    const groups = await Promise.all(wanted.map((k) => jobs[k]().catch((err) => (log.error(`[search] ${k}`, err), null))));
    return groups.filter((g): g is SearchGroup => g !== null);
  },
};
