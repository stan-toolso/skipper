import { pool } from '../db/pool.js';
import type { ProjectMember, ProjectRole, User } from './types.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  google_sub: string | null;
  is_admin: boolean;
  created_at: Date;
  last_login_at: Date | null;
}

interface MemberRow {
  project_id: string;
  user_id: string;
  role: ProjectRole;
  invited_by: string | null;
  created_at: Date;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  avatarUrl: r.avatar_url,
  googleSub: r.google_sub,
  isAdmin: r.is_admin,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
});

const toMember = (r: MemberRow): ProjectMember => ({
  projectId: r.project_id,
  userId: r.user_id,
  role: r.role,
  invitedById: r.invited_by,
  createdAt: r.created_at,
});

export const userRepository = {
  async findById(id: string): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  async findByGoogleSub(sub: string): Promise<User | null> {
    const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE google_sub = $1', [sub]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  /** Crée un utilisateur « invité » (pas encore connecté). */
  async create(input: { email: string; name: string }): Promise<User> {
    const { rows } = await pool.query<UserRow>('INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *', [input.email.toLowerCase(), input.name]);
    return toUser(rows[0]);
  },

  /** À chaque connexion : relie le compte Google et rafraîchit nom et avatar. */
  async recordLogin(id: string, input: { googleSub: string; name?: string | null; avatarUrl?: string | null }): Promise<User> {
    const { rows } = await pool.query<UserRow>(
      `UPDATE users SET google_sub = $2, name = COALESCE($3, name), avatar_url = COALESCE($4, avatar_url), last_login_at = now()
       WHERE id = $1 RETURNING *`,
      [id, input.googleSub, input.name || null, input.avatarUrl || null],
    );
    return toUser(rows[0]);
  },

  async list(): Promise<User[]> {
    const { rows } = await pool.query<UserRow>('SELECT * FROM users ORDER BY name ASC, email ASC');
    return rows.map(toUser);
  },

  // ---- Appartenance aux projets ------------------------------------------------------------

  async findMembership(projectId: string, userId: string): Promise<ProjectMember | null> {
    const { rows } = await pool.query<MemberRow>('SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    return rows[0] ? toMember(rows[0]) : null;
  },

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const { rows } = await pool.query<MemberRow>(
      `SELECT m.* FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY m.role ASC, u.name ASC`,
      [projectId],
    );
    return rows.map(toMember);
  },

  /** Identifiants des projets auxquels l'utilisateur appartient. */
  async projectIdsForUser(userId: string): Promise<string[]> {
    const { rows } = await pool.query<{ project_id: string }>('SELECT project_id FROM project_members WHERE user_id = $1', [userId]);
    return rows.map((r) => r.project_id);
  },

  async upsertMembership(input: { projectId: string; userId: string; role: ProjectRole; invitedById?: string | null }): Promise<ProjectMember> {
    const { rows } = await pool.query<MemberRow>(
      `INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role RETURNING *`,
      [input.projectId, input.userId, input.role, input.invitedById ?? null],
    );
    return toMember(rows[0]);
  },

  async removeMembership(projectId: string, userId: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    return (rowCount ?? 0) > 0;
  },

  async countAdmins(projectId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM project_members WHERE project_id = $1 AND role = 'admin'`, [projectId]);
    return Number(rows[0].n);
  },

  // ---- Sessions de connexion -----------------------------------------------------------------

  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await pool.query('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, expiresAt]);
  },

  /** Renvoie l'utilisateur d'une session valide (non expirée), ou null. */
  async findSessionUser(tokenHash: string): Promise<{ user: User; lastSeenAt: Date } | null> {
    const { rows } = await pool.query<UserRow & { last_seen_at: Date }>(
      `SELECT u.*, s.last_seen_at FROM user_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    return rows[0] ? { user: toUser(rows[0]), lastSeenAt: rows[0].last_seen_at } : null;
  },

  async touchSession(tokenHash: string, expiresAt: Date): Promise<void> {
    await pool.query('UPDATE user_sessions SET last_seen_at = now(), expires_at = $2 WHERE token_hash = $1', [tokenHash, expiresAt]);
  },

  async deleteSession(tokenHash: string): Promise<void> {
    await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash]);
  },

  async deleteExpiredSessions(): Promise<number> {
    const { rowCount } = await pool.query('DELETE FROM user_sessions WHERE expires_at <= now()');
    return rowCount ?? 0;
  },
};
