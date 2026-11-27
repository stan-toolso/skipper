import { pool } from '../db/pool.js';
import type { AgentHandoff, ArtifactKind, SharedPage, SharedPageMember, SharedPageVersion, VersionAlert, VersionSource } from './types.js';

interface Row {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  link_access: boolean;
  public_access: boolean;
  project_access: boolean;
  version: number;
  project_id: string | null;
  session_id: string | null;
  source_path: string | null;
  agent_handoff: AgentHandoff;
  history_enabled: boolean;
  kind: ArtifactKind;
  refresh_minutes: number | null;
  data_refreshed_at: Date | null;
  viewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
const toPage = (r: Row): SharedPage => ({
  id: r.id,
  ownerId: r.owner_id,
  title: r.title,
  description: r.description,
  linkAccess: r.link_access,
  publicAccess: r.public_access ?? false,
  projectAccess: r.project_access ?? false,
  version: r.version,
  projectId: r.project_id,
  sessionId: r.session_id,
  sourcePath: r.source_path,
  agentHandoff: r.agent_handoff ?? 'manual',
  historyEnabled: r.history_enabled ?? true,
  kind: r.kind ?? 'page',
  refreshMinutes: r.refresh_minutes ?? null,
  dataRefreshedAt: r.data_refreshed_at ?? null,
  viewedAt: r.viewed_at ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface VersionRow {
  page_id: string;
  version: number;
  size: number;
  created_by: string | null;
  session_id: string | null;
  created_at: Date;
  kind: ArtifactKind | null;
  refresh_minutes: number | null;
  sources: VersionSource[] | null;
  alerts?: VersionAlert[] | null;
}
const toVersion = (r: VersionRow): SharedPageVersion => ({
  pageId: r.page_id,
  version: r.version,
  size: r.size,
  createdById: r.created_by,
  sessionId: r.session_id,
  createdAt: r.created_at,
  kind: r.kind ?? null,
  refreshMinutes: r.refresh_minutes ?? null,
  sources: r.sources ?? null,
  alerts: r.alerts ?? null,
});
const VERSION_META = 'page_id, version, size, created_by, session_id, created_at, kind, refresh_minutes, sources, alerts';

/**
 * Fige dans la dernière version l'état de l'artefact qui n'est pas dans son HTML : type, rafraîchissement, définition des
 * sources (nom, type, requête ou script ; pas les données) et des alertes (sans leur état). Appelé à chaque publication et à chaque changement des
 * sources ou du rafraîchissement de la dernière version.
 */
const SNAPSHOT_SQL = `UPDATE shared_page_versions v
    SET kind = p.kind,
        refresh_minutes = p.refresh_minutes,
        sources = CASE WHEN p.kind = 'data' THEN
          (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', s.name, 'kind', s.kind, 'config', s.config) ORDER BY s.position, s.name), '[]'::jsonb)
             FROM shared_page_sources s WHERE s.page_id = p.id) END,
        alerts = CASE WHEN p.kind = 'data' THEN
          (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', a.name, 'source', a.source, 'config', a.config) ORDER BY a.position, a.name), '[]'::jsonb)
             FROM shared_page_alerts a WHERE a.page_id = p.id) END
   FROM shared_pages p
  WHERE p.id = v.page_id AND v.page_id = $1 AND v.version = p.version`;

interface MemberRow {
  page_id: string;
  user_id: string;
  added_by: string | null;
  message: string | null;
  created_at: Date;
}
const toMember = (r: MemberRow): SharedPageMember => ({ pageId: r.page_id, userId: r.user_id, addedById: r.added_by, message: r.message ?? null, createdAt: r.created_at });

export const sharedPageRepository = {
  async findById(id: string): Promise<SharedPage | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM shared_pages WHERE id = $1', [id]);
    return rows[0] ? toPage(rows[0]) : null;
  },

  /** Pages possédées par la personne ou partagées avec elle, les plus récemment mises à jour d'abord. */
  async listFor(userId: string): Promise<SharedPage[]> {
    const { rows } = await pool.query<Row>(
      `SELECT p.* FROM shared_pages p WHERE p.owner_id = $1 OR EXISTS (SELECT 1 FROM shared_page_members m WHERE m.page_id = p.id AND m.user_id = $1) ORDER BY p.updated_at DESC`,
      [userId],
    );
    return rows.map(toPage);
  },

  /**
   * Artefacts d'un projet que la personne peut voir : les siens, ceux qu'on lui a partagés, et ceux dont le lien est
   * ouvert à toute personne de Skipper (`openLinks` : jamais pour un invité). Les plus récemment mis à jour d'abord.
   */
  async listForProject(projectId: string, userId: string, openLinks: boolean): Promise<SharedPage[]> {
    const { rows } = await pool.query<Row>(
      `SELECT p.* FROM shared_pages p
        WHERE p.project_id = $1
          AND (p.owner_id = $2 OR ($3 AND p.link_access) OR ($3 AND p.project_access AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.project_id AND pm.user_id = $2 AND pm.role <> 'guest')) OR EXISTS (SELECT 1 FROM shared_page_members m WHERE m.page_id = p.id AND m.user_id = $2))
        ORDER BY p.updated_at DESC`,
      [projectId, userId, openLinks],
    );
    return rows.map(toPage);
  },

  /** Favoris de la personne qu'elle peut encore voir, dans l'ordre où elle les a ajoutés. */
  async listFavorites(userId: string, openLinks: boolean): Promise<SharedPage[]> {
    const { rows } = await pool.query<Row>(
      `SELECT p.* FROM shared_page_favorites f JOIN shared_pages p ON p.id = f.page_id
        WHERE f.user_id = $1
          AND (p.owner_id = $1 OR ($2 AND p.link_access) OR ($2 AND p.project_access AND p.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.project_id AND pm.user_id = $1 AND pm.role <> 'guest')) OR EXISTS (SELECT 1 FROM shared_page_members m WHERE m.page_id = p.id AND m.user_id = $1))
        ORDER BY f.created_at`,
      [userId, openLinks],
    );
    return rows.map(toPage);
  },

  /** Parmi ces pages, celles que la personne a mises en favori. */
  async favoriteIds(userId: string, pageIds: string[]): Promise<Set<string>> {
    if (!pageIds.length) return new Set();
    const { rows } = await pool.query<{ page_id: string }>('SELECT page_id FROM shared_page_favorites WHERE user_id = $1 AND page_id = ANY($2::uuid[])', [userId, pageIds]);
    return new Set(rows.map((r) => r.page_id));
  },

  async setFavorite(userId: string, pageId: string, favorite: boolean): Promise<void> {
    if (favorite) await pool.query('INSERT INTO shared_page_favorites (user_id, page_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, pageId]);
    else await pool.query('DELETE FROM shared_page_favorites WHERE user_id = $1 AND page_id = $2', [userId, pageId]);
  },

  async listOwned(userId: string, limit: number): Promise<SharedPage[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM shared_pages WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT $2', [userId, limit]);
    return rows.map(toPage);
  },

  /** Crée la page et sa première version dans une même transaction. */
  async create(input: { ownerId: string; title: string; description: string | null; linkAccess: boolean; projectAccess?: boolean; projectId: string | null; sessionId: string | null; sourcePath: string | null; html: Buffer; kind?: ArtifactKind }): Promise<SharedPage> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Row>(
        `INSERT INTO shared_pages (owner_id, title, description, link_access, project_id, session_id, source_path, kind, project_access) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [input.ownerId, input.title, input.description, input.linkAccess, input.projectId, input.sessionId, input.sourcePath, input.kind ?? 'page', input.projectAccess ?? false],
      );
      await client.query('INSERT INTO shared_page_versions (page_id, version, html, size, created_by, session_id) VALUES ($1, 1, $2, $3, $4, $5)', [rows[0].id, input.html, input.html.length, input.ownerId, input.sessionId]);
      await client.query('COMMIT');
      return toPage(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** Nouvelle version (la ligne est verrouillée : deux publications concurrentes se suivent). */
  async addVersion(pageId: string, input: { title: string; description: string | null | undefined; linkAccess: boolean | null; projectAccess?: boolean | null; projectId: string | null; sessionId: string | null; sourcePath: string | null; html: Buffer; createdBy: string; kind?: ArtifactKind | null }): Promise<SharedPage | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Row>(
        `UPDATE shared_pages SET version = version + 1, title = $2, description = COALESCE($3, description), link_access = COALESCE($4, link_access),
                project_id = COALESCE($5, project_id), session_id = $6, source_path = $7, kind = COALESCE($8, kind),
                project_access = COALESCE($9, project_access), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [pageId, input.title, input.description ?? null, input.linkAccess, input.projectId, input.sessionId, input.sourcePath, input.kind ?? null, input.projectAccess ?? null],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('INSERT INTO shared_page_versions (page_id, version, html, size, created_by, session_id) VALUES ($1, $2, $3, $4, $5, $6)', [pageId, rows[0].version, input.html, input.html.length, input.createdBy, input.sessionId]);
      await client.query('COMMIT');
      return toPage(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Copie d'une page : nouvelle page (version 1 = le contenu de `version` de la source) avec le type, le réglage du
   * rafraîchissement, les sources de données (définition, dernières données et état) et les alertes (définition, état
   * remis à « jamais évaluée »), dans une même transaction.
   * Ni les membres, ni le lien ouvert, ni les commentaires, ni l'historique ne suivent.
   */
  async duplicate(sourceId: string, version: number, input: { ownerId: string; title: string; description: string | null; projectId: string | null; sessionId: string | null; sourcePath: string | null }): Promise<SharedPage | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Type et rafraîchissement de la version copiée (ceux de l'artefact quand la version ne les a pas gardés).
      const { rows } = await client.query<Row>(
        `INSERT INTO shared_pages (owner_id, title, description, link_access, project_id, session_id, source_path, kind, refresh_minutes, data_refreshed_at)
         SELECT $2, $3, $4, false, $5, $6, $7, COALESCE(v.kind, p.kind), CASE WHEN v.kind IS NULL THEN p.refresh_minutes ELSE v.refresh_minutes END, p.data_refreshed_at
           FROM shared_pages p JOIN shared_page_versions v ON v.page_id = p.id AND v.version = $8
          WHERE p.id = $1 RETURNING *`,
        [sourceId, input.ownerId, input.title, input.description, input.projectId, input.sessionId, input.sourcePath, version],
      );
      const copy = rows[0];
      if (!copy) {
        await client.query('ROLLBACK');
        return null;
      }
      const { rowCount } = await client.query(
        `INSERT INTO shared_page_versions (page_id, version, html, size, created_by, session_id)
         SELECT $1, 1, html, size, $2, NULL FROM shared_page_versions WHERE page_id = $3 AND version = $4`,
        [copy.id, input.ownerId, sourceId, version],
      );
      if (!rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const snapshot = await client.query<{ sources: VersionSource[] | null; alerts: VersionAlert[] | null }>('SELECT sources, alerts FROM shared_page_versions WHERE page_id = $1 AND version = $2', [sourceId, version]);
      if (copy.kind === 'data' && snapshot.rows[0]?.sources) {
        // Sources de la version copiée ; les données suivent pour celles dont la définition n'a pas changé depuis.
        await client.query(
          `INSERT INTO shared_page_sources (page_id, name, kind, config, position, data, row_count, status, error, duration_ms, refreshed_at, attempted_at)
           SELECT $1, d.def->>'name', d.def->>'kind', d.def->'config', d.ord - 1,
                  s.data, s.row_count, CASE WHEN s.status IS NULL THEN 'pending' WHEN s.status = 'running' THEN (CASE WHEN s.data IS NULL THEN 'pending' ELSE 'ok' END) ELSE s.status END, s.error, s.duration_ms, s.refreshed_at, s.attempted_at
             FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS d(def, ord)
             -- Une source agent en calcul repart sans session : la copie n'est pas « en calcul ».
             LEFT JOIN shared_page_sources s ON s.page_id = $2 AND s.name = d.def->>'name' AND s.kind = d.def->>'kind' AND s.config = d.def->'config'`,
          [copy.id, sourceId, JSON.stringify(snapshot.rows[0].sources)],
        );
      } else if (copy.kind === 'data') {
        await client.query(
          `INSERT INTO shared_page_sources (page_id, name, kind, config, position, data, row_count, status, error, duration_ms, refreshed_at, attempted_at)
           SELECT $1, name, kind, config, position, data, row_count, CASE WHEN status = 'running' THEN (CASE WHEN data IS NULL THEN 'pending' ELSE 'ok' END) ELSE status END, error, duration_ms, refreshed_at, attempted_at FROM shared_page_sources WHERE page_id = $2`,
          [copy.id, sourceId],
        );
      }
      if (copy.kind === 'data') {
        // Alertes de la version copiée (ou actuelles si elle ne les a pas gardées) : définitions seulement, état « jamais
        // évaluée » ; celles dont la source n'existe pas dans la copie sont laissées de côté.
        const defs = snapshot.rows[0]?.alerts ?? null;
        await client.query(
          `INSERT INTO shared_page_alerts (page_id, name, source, config, position)
           SELECT $1, d.name, d.source, d.config, d.position
             FROM (SELECT def->>'name' AS name, def->>'source' AS source, def->'config' AS config, (ord - 1)::int AS position
                     FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS x(def, ord) WHERE $3::jsonb IS NOT NULL
                   UNION ALL
                   SELECT name, source, config, position FROM shared_page_alerts WHERE page_id = $2 AND $3::jsonb IS NULL) d
            WHERE EXISTS (SELECT 1 FROM shared_page_sources s WHERE s.page_id = $1 AND s.name = d.source)`,
          [copy.id, sourceId, defs ? JSON.stringify(defs) : null],
        );
      }
      await client.query(SNAPSHOT_SQL, [copy.id]);
      await client.query('COMMIT');
      return toPage(copy);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async update(id: string, patch: { title?: string; description?: string | null; linkAccess?: boolean; publicAccess?: boolean; projectAccess?: boolean; agentHandoff?: AgentHandoff; historyEnabled?: boolean; refreshMinutes?: number | null }): Promise<SharedPage | null> {
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (patch.title !== undefined) sets.push(`title = $${params.push(patch.title)}`);
    if (patch.description !== undefined) sets.push(`description = $${params.push(patch.description)}`);
    if (patch.linkAccess !== undefined) sets.push(`link_access = $${params.push(patch.linkAccess)}`);
    if (patch.publicAccess !== undefined) sets.push(`public_access = $${params.push(patch.publicAccess)}`);
    if (patch.projectAccess !== undefined) sets.push(`project_access = $${params.push(patch.projectAccess)}`);
    if (patch.agentHandoff !== undefined) sets.push(`agent_handoff = $${params.push(patch.agentHandoff)}`);
    if (patch.historyEnabled !== undefined) sets.push(`history_enabled = $${params.push(patch.historyEnabled)}`);
    if (patch.refreshMinutes !== undefined) sets.push(`refresh_minutes = $${params.push(patch.refreshMinutes)}`);
    const { rows } = await pool.query<Row>(`UPDATE shared_pages SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toPage(rows[0]) : null;
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM shared_pages WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  async content(pageId: string, version: number): Promise<Buffer | null> {
    const { rows } = await pool.query<{ html: Buffer }>('SELECT html FROM shared_page_versions WHERE page_id = $1 AND version = $2', [pageId, version]);
    return rows[0]?.html ?? null;
  },

  async versions(pageId: string): Promise<SharedPageVersion[]> {
    const { rows } = await pool.query<VersionRow>(`SELECT ${VERSION_META} FROM shared_page_versions WHERE page_id = $1 ORDER BY version DESC`, [pageId]);
    return rows.map(toVersion);
  },

  async version(pageId: string, version: number): Promise<SharedPageVersion | null> {
    const { rows } = await pool.query<VersionRow>(`SELECT ${VERSION_META} FROM shared_page_versions WHERE page_id = $1 AND version = $2`, [pageId, version]);
    return rows[0] ? toVersion(rows[0]) : null;
  },

  /** Fige l'état courant de l'artefact (type, rafraîchissement, sources) dans sa dernière version. */
  async snapshotLatest(pageId: string): Promise<void> {
    await pool.query(SNAPSHOT_SQL, [pageId]);
  },

  async members(pageId: string): Promise<SharedPageMember[]> {
    const { rows } = await pool.query<MemberRow>('SELECT * FROM shared_page_members WHERE page_id = $1 ORDER BY created_at', [pageId]);
    return rows.map(toMember);
  },

  /**
   * Pages publiées par chacune des sessions (au moins une version publiée depuis elle : une page republiée par une autre
   * session reste aussi celle de la première) et que `viewerId` peut voir (propriétaire, membre, ou lien ouvert ; un invité
   * des pages ne voit jamais de session). Par session, les plus récemment mises à jour d'abord.
   */
  async listForSessions(sessionIds: string[], viewerId: string): Promise<Map<string, SharedPage[]>> {
    const out = new Map<string, SharedPage[]>();
    if (!sessionIds.length) return out;
    const { rows } = await pool.query<Row & { by_session: string }>(
      `SELECT p.*, s.by_session FROM shared_pages p
         JOIN (SELECT DISTINCT page_id, session_id AS by_session FROM shared_page_versions WHERE session_id = ANY($1::uuid[])) s ON s.page_id = p.id
        WHERE p.owner_id = $2 OR p.link_access OR (p.project_access AND p.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.project_id AND pm.user_id = $2 AND pm.role <> 'guest')) OR EXISTS (SELECT 1 FROM shared_page_members m WHERE m.page_id = p.id AND m.user_id = $2)
        ORDER BY p.updated_at DESC`,
      [sessionIds, viewerId],
    );
    for (const r of rows) {
      const list = out.get(r.by_session) ?? [];
      list.push(toPage(r));
      out.set(r.by_session, list);
    }
    return out;
  },

  /** Note la dernière ouverture (au plus une écriture toutes les 10 minutes), sans toucher `updated_at`. */
  async touchViewed(id: string): Promise<void> {
    await pool.query(`UPDATE shared_pages SET viewed_at = now() WHERE id = $1 AND (viewed_at IS NULL OR viewed_at < now() - interval '10 minutes')`, [id]);
  },

  async markDataRefreshed(id: string): Promise<void> {
    await pool.query('UPDATE shared_pages SET data_refreshed_at = now() WHERE id = $1', [id]);
  },

  /**
   * Artefacts de données à rafraîchir : intervalle réglé, échéance passée (depuis la dernière tentative), et lus ou
   * modifiés depuis moins de `idleDays` jours (sinon le rafraîchissement automatique est en veille jusqu'à la prochaine ouverture).
   */
  async dueForRefresh(limit: number, idleDays: number): Promise<SharedPage[]> {
    const { rows } = await pool.query<Row>(
      `SELECT * FROM shared_pages
        WHERE kind = 'data' AND refresh_minutes IS NOT NULL AND project_id IS NOT NULL
          AND (data_refreshed_at IS NULL OR data_refreshed_at <= now() - refresh_minutes * interval '1 minute')
          AND GREATEST(COALESCE(viewed_at, created_at), updated_at) > now() - $2 * interval '1 day'
        ORDER BY data_refreshed_at NULLS FIRST LIMIT $1`,
      [limit, idleDays],
    );
    return rows.map(toPage);
  },

  async isMember(pageId: string, userId: string): Promise<boolean> {
    const { rowCount } = await pool.query('SELECT 1 FROM shared_page_members WHERE page_id = $1 AND user_id = $2', [pageId, userId]);
    return (rowCount ?? 0) > 0;
  },

  /** Ajoute un membre (ou remplace son message s'il en est donné un) ; false s'il l'était déjà. */
  async addMember(pageId: string, userId: string, addedBy: string, message: string | null = null): Promise<boolean> {
    const { rows } = await pool.query<{ inserted: boolean }>(
      `INSERT INTO shared_page_members (page_id, user_id, added_by, message) VALUES ($1, $2, $3, $4)
       ON CONFLICT (page_id, user_id) DO UPDATE SET message = COALESCE(EXCLUDED.message, shared_page_members.message)
       RETURNING (xmax = 0) AS inserted`,
      [pageId, userId, addedBy, message],
    );
    return Boolean(rows[0]?.inserted);
  },

  async removeMember(pageId: string, userId: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM shared_page_members WHERE page_id = $1 AND user_id = $2', [pageId, userId]);
    return (rowCount ?? 0) > 0;
  },
};
