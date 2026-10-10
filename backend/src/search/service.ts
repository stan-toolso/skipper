import { pool } from '../db/pool.js';
import { vaultService } from '../vault/service.js';
import { kindLabels as vaultKindLabels } from '../vault/types.js';

/**
 * Recherche globale (palette ⌘K) : projets, worktrees, sessions, terminaux, tâches et éléments du coffre
 * que la personne peut voir. Chaque mot de la requête doit apparaître ; les titres qui commencent par la
 * requête viennent d'abord, puis ceux qui la contiennent, puis le reste par date de mise à jour.
 */

export type SearchKind = 'PROJECT' | 'WORKTREE' | 'SESSION' | 'TERMINAL' | 'TASK' | 'VAULT_ITEM';
export const SEARCH_KINDS: SearchKind[] = ['PROJECT', 'WORKTREE', 'SESSION', 'TERMINAL', 'TASK', 'VAULT_ITEM'];

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  detail: string | null;
  projectId: string | null;
  projectName: string | null;
  /** Projet dont la personne n'est pas membre (super administrateur). */
  outsideProjects: boolean;
  worktreeBranch: string | null;
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
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const words = (query: string) => query.trim().split(/\s+/).filter(Boolean);

interface RawRow {
  id: string;
  title: string;
  detail: string | null;
  project_id: string | null;
  project_name: string | null;
  worktree_branch: string | null;
  status: string | null;
  activity: string | null;
  updated_at: Date;
  total: string;
}

/** Requête d'un type : `haystack` concatène les colonnes cherchées, `title` sert au classement. */
async function searchKind(kind: SearchKind, sql: { from: string; title: string; detail: string; haystack: string; projectId: string; worktreeBranch: string; status: string; activity: string; updatedAt: string; where: string }, scope: SearchScope, query: string, limit: number): Promise<SearchGroup | null> {
  if (!scope.projectIds.length) return null;
  const params: unknown[] = [scope.projectIds];
  const terms = words(query).map((w) => `${sql.haystack} ILIKE $${params.push(`%${escapeLike(w)}%`)}`);
  const q = query.trim().toLowerCase();
  const rank = q ? `CASE WHEN lower(${sql.title}) LIKE $${params.push(`${escapeLike(q)}%`)} THEN 0 WHEN lower(${sql.title}) LIKE $${params.push(`%${escapeLike(q)}%`)} THEN 1 ELSE 2 END` : '2';
  params.push(limit);
  const { rows } = await pool.query<RawRow>(
    `SELECT x.id, ${sql.title} AS title, ${sql.detail} AS detail, ${sql.projectId} AS project_id, p.name AS project_name, ${sql.worktreeBranch} AS worktree_branch,
            ${sql.status} AS status, ${sql.activity} AS activity, ${sql.updatedAt} AS updated_at, count(*) OVER () AS total
     FROM ${sql.from} LEFT JOIN projects p ON p.id = ${sql.projectId}
     WHERE ${sql.projectId} = ANY($1::uuid[]) ${sql.where} ${terms.map((t) => `AND ${t}`).join(' ')}
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
      worktreeBranch: r.worktree_branch,
      status: r.status,
      activity: r.activity,
      updatedAt: r.updated_at,
    })),
  };
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const searchService = {
  async search(scope: SearchScope, query: string, kinds: SearchKind[] | null | undefined, limit: number | null | undefined): Promise<SearchGroup[]> {
    const n = Math.min(Math.max(limit ?? 8, 1), 50);
    const wanted = kinds?.length ? SEARCH_KINDS.filter((k) => kinds.includes(k)) : SEARCH_KINDS;
    const jobs: Record<SearchKind, () => Promise<SearchGroup | null>> = {
      PROJECT: () =>
        searchKind('PROJECT', { from: 'projects x', title: 'x.name', detail: 'x.description', haystack: "(x.name || ' ' || x.slug || ' ' || coalesce(x.description, ''))", projectId: 'x.id', worktreeBranch: 'NULL', status: 'NULL', activity: 'NULL', updatedAt: 'x.updated_at', where: '' }, scope, query, n),
      WORKTREE: () =>
        searchKind('WORKTREE', { from: 'worktrees x', title: 'coalesce(x.label, x.branch)', detail: "CASE WHEN x.label IS NULL THEN x.name ELSE x.branch END", haystack: "(x.branch || ' ' || x.name || ' ' || coalesce(x.label, ''))", projectId: 'x.project_id', worktreeBranch: 'x.branch', status: "CASE WHEN x.archived_at IS NULL THEN NULL ELSE 'archived' END", activity: 'NULL', updatedAt: 'x.created_at', where: '' }, scope, query, n),
      SESSION: () =>
        searchKind('SESSION', { from: 'sessions x LEFT JOIN worktrees w ON w.id = x.worktree_id', title: 'x.name', detail: 'x.provider', haystack: 'x.name', projectId: 'x.project_id', worktreeBranch: 'w.branch', status: 'x.status::text', activity: 'x.activity', updatedAt: 'x.updated_at', where: 'AND x.archived_at IS NULL' }, scope, query, n),
      TERMINAL: () =>
        searchKind('TERMINAL', { from: 'terminals x LEFT JOIN worktrees w ON w.id = x.worktree_id', title: 'x.name', detail: 'NULL', haystack: 'x.name', projectId: 'x.project_id', worktreeBranch: 'w.branch', status: 'x.status::text', activity: 'NULL', updatedAt: 'x.created_at', where: `AND (x.created_by IS NULL OR x.created_by = '${scope.userId}')` }, scope, query, n),
      TASK: () =>
        searchKind('TASK', { from: 'tasks x', title: 'x.title', detail: 'x.priority::text', haystack: "(x.title || ' ' || x.description || ' ' || coalesce(x.branch, ''))", projectId: 'x.project_id', worktreeBranch: 'x.branch', status: 'x.status::text', activity: 'NULL', updatedAt: 'x.updated_at', where: '' }, scope, query, n),
      VAULT_ITEM: async () => {
        const items = await vaultService.listAccessible(scope.userId);
        const q = normalize(query.trim());
        const ws = q.split(/\s+/).filter(Boolean);
        const matching = items.filter((i) => ws.every((w) => normalize(`${i.name} ${i.description} ${JSON.stringify(i.settings)}`).includes(w)));
        const rank = (name: string) => (!q ? 2 : normalize(name).startsWith(q) ? 0 : normalize(name).includes(q) ? 1 : 2);
        matching.sort((a, b) => rank(a.name) - rank(b.name) || b.updatedAt.getTime() - a.updatedAt.getTime());
        if (!matching.length) return null;
        const members = new Set(scope.memberProjectIds);
        return {
          kind: 'VAULT_ITEM' as const,
          total: matching.length,
          hits: matching.slice(0, n).map((i) => ({ kind: 'VAULT_ITEM' as const, id: i.id, title: i.name, detail: vaultKindLabels[i.kind], projectId: i.ownerProjectId, projectName: null, outsideProjects: Boolean(i.ownerProjectId) && !members.has(i.ownerProjectId!), worktreeBranch: null, status: i.kind, activity: null, updatedAt: i.updatedAt })),
        };
      },
    };
    const groups = await Promise.all(wanted.map((k) => jobs[k]().catch((err) => (console.error(`[search] ${k}`, err), null))));
    return groups.filter((g): g is SearchGroup => g !== null);
  },
};
