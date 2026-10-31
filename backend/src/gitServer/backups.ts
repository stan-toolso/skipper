import { pool } from '../db/pool.js';

/** Sauvegarde d'un dépôt hébergé : un bundle git complet, décrit sans son contenu. */
export interface GitBackup {
  id: string;
  projectId: string;
  takenAt: Date;
  /** Taille du bundle en octets. */
  size: number;
  /** Nombre de références (branches et tags) contenues. */
  refCount: number;
  /** Branche de HEAD au moment de la prise. */
  head: string;
}

interface Row {
  id: string;
  project_id: string;
  taken_at: Date;
  size: string;
  head: string;
  refs: string;
}

/** Sauvegardes conservées par dépôt : la plus récente et les deux précédentes. */
export const BACKUPS_KEPT = 3;
const COLUMNS = 'id, project_id, taken_at, size, head, refs';
const toBackup = (r: Row): GitBackup => ({ id: r.id, projectId: r.project_id, takenAt: r.taken_at, size: Number(r.size), refCount: r.refs ? r.refs.split('\n').filter(Boolean).length : 0, head: r.head });

export const gitBackupRepository = {
  async list(projectId: string): Promise<GitBackup[]> {
    const { rows } = await pool.query<Row>(`SELECT ${COLUMNS} FROM git_repository_backups WHERE project_id = $1 ORDER BY taken_at DESC`, [projectId]);
    return rows.map(toBackup);
  },

  /** La plus récente, avec la signature des références qu'elle contient (pour savoir si le dépôt a changé depuis). */
  async latest(projectId: string): Promise<(GitBackup & { refs: string }) | null> {
    const { rows } = await pool.query<Row>(`SELECT ${COLUMNS} FROM git_repository_backups WHERE project_id = $1 ORDER BY taken_at DESC LIMIT 1`, [projectId]);
    return rows[0] ? { ...toBackup(rows[0]), refs: rows[0].refs } : null;
  },

  /** Enregistre une prise et ne garde que les BACKUPS_KEPT plus récentes. */
  async save(projectId: string, input: { refs: string; head: string; bundle: Buffer }): Promise<GitBackup> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Row>(
        `INSERT INTO git_repository_backups (project_id, refs, head, bundle, size) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [projectId, input.refs, input.head, input.bundle, input.bundle.length],
      );
      await client.query(
        `DELETE FROM git_repository_backups WHERE project_id = $1 AND id NOT IN (SELECT id FROM git_repository_backups WHERE project_id = $1 ORDER BY taken_at DESC LIMIT ${BACKUPS_KEPT})`,
        [projectId],
      );
      await client.query('COMMIT');
      return toBackup(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  },

  /** Contenu d'une sauvegarde (le bundle), avec son projet pour le contrôle d'accès. */
  async content(id: string): Promise<{ projectId: string; takenAt: Date; head: string; bundle: Buffer } | null> {
    const { rows } = await pool.query<{ project_id: string; taken_at: Date; head: string; bundle: Buffer }>('SELECT project_id, taken_at, head, bundle FROM git_repository_backups WHERE id = $1', [id]);
    return rows[0] ? { projectId: rows[0].project_id, takenAt: rows[0].taken_at, head: rows[0].head, bundle: rows[0].bundle } : null;
  },
};
