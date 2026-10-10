import type { SessionActivity, SessionStatus, TerminalStatus } from '../graphql/operations';

/**
 * Dossiers de travail : le checkout principal d'un projet (« primary ») ou l'un de ses worktrees. Tout ce qui
 * s'ouvre *dans* un dossier (fichiers, sessions, navigateur d'une session, terminaux) vit dans un seul onglet
 * du workbench, celui du dossier, avec une sous-barre qui liste ce qui y est ouvert.
 */

export interface SidebarSession {
  id: string;
  name: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  pendingRequestCount: number;
  browserActive: boolean;
  owner: { id: string; name: string; avatarUrl: string | null } | null;
  worktree?: { id: string } | null;
}

export interface SidebarTerminal {
  id: string;
  name: string;
  status: TerminalStatus;
  worktree?: { id: string } | null;
}

export interface SidebarWorktree {
  id: string;
  name: string;
  branch: string;
  label: string;
  customLabel: string | null;
  exists: boolean;
  task: { id: string; title: string; status: string } | null;
  sessions: SidebarSession[];
  terminals: SidebarTerminal[];
}

export interface SidebarProject {
  id: string;
  name: string;
  slug: string;
  gitUrl: string | null;
  gitBranch: string | null;
  isMember: boolean;
  sessions: SidebarSession[];
  terminals: SidebarTerminal[];
  worktrees: SidebarWorktree[];
}

export interface Workspace {
  /** Clé de l'onglet : /projects/:id/files (primary) ou /worktrees/:wid/files. */
  key: string;
  projectId: string;
  projectName: string;
  worktreeId: string | null;
  /** Worktree : libellé (choisi, sinon branche) ; primary : branche du projet. */
  name: string;
  branch: string;
  worktree: SidebarWorktree | null;
  primary: boolean;
  task: { id: string; title: string; status: string } | null;
  exists: boolean;
  sessions: SidebarSession[];
  terminals: SidebarTerminal[];
}

export type WorkspaceState = 'ask' | 'busy' | 'idle' | null;

/** Clé de l'onglet du dossier principal d'un projet ou d'un worktree. */
export const primaryKey = (projectId: string) => `/projects/${projectId}/files`;
export const worktreeKey = (worktreeId: string) => `/worktrees/${worktreeId}/files`;

/** Titre de l'onglet d'un dossier : « main · Projet ». */
export const workspaceTitle = (ws: Pick<Workspace, 'name' | 'projectName'>) => `${ws.name} · ${ws.projectName}`;

/** État résumé d'un dossier d'après ses sessions : une demande en attente, un agent au travail, une session ouverte. */
export function workspaceState(sessions: Pick<SidebarSession, 'status' | 'activity' | 'pendingRequestCount'>[]): WorkspaceState {
  if (sessions.some((s) => s.pendingRequestCount > 0)) return 'ask';
  if (sessions.some((s) => s.status === 'RUNNING' && s.activity === 'BUSY')) return 'busy';
  if (sessions.some((s) => s.status === 'RUNNING' || s.status === 'QUEUED')) return 'idle';
  return null;
}

/** Sessions de la personne d'abord (propriétaire ou sans propriétaire), puis les autres, chaque groupe dans son ordre. */
export function mineFirst<T extends { owner: { id: string } | null }>(sessions: T[], userId: string | null): T[] {
  const mine = sessions.filter((s) => !s.owner || s.owner.id === userId);
  return [...mine, ...sessions.filter((s) => !mine.includes(s))];
}

export const participates = (s: { owner: { id: string } | null }, userId: string | null) => !s.owner || s.owner.id === userId;

/** Index des dossiers de travail construit à partir de la requête Sidebar. */
export class WorkspaceIndex {
  private readonly byKey = new Map<string, Workspace>();
  private readonly byProject = new Map<string, Workspace[]>();
  /** Clé du dossier qui contient chaque session / terminal. */
  private readonly owners = new Map<string, string>();

  constructor(projects: SidebarProject[]) {
    for (const p of projects) {
      const list: Workspace[] = [];
      const worktreeIds = new Set(p.worktrees.map((w) => w.id));
      const primary: Workspace = {
        key: primaryKey(p.id),
        projectId: p.id,
        projectName: p.name,
        worktreeId: null,
        name: p.gitUrl ? p.gitBranch || 'main' : 'workspace',
        branch: p.gitUrl ? p.gitBranch || 'main' : 'workspace',
        worktree: null,
        primary: true,
        task: null,
        exists: true,
        sessions: p.sessions.filter((s) => !s.worktree || !worktreeIds.has(s.worktree.id)),
        terminals: p.terminals.filter((t) => !t.worktree || !worktreeIds.has(t.worktree.id)),
      };
      list.push(primary);
      for (const w of p.worktrees) {
        // Une session listée par le projet pour ce worktree mais absente de la liste du worktree (listes plafonnées) y est rangée quand même.
        const extra = p.sessions.filter((s) => s.worktree?.id === w.id && !w.sessions.some((x) => x.id === s.id));
        list.push({
          key: worktreeKey(w.id),
          projectId: p.id,
          projectName: p.name,
          worktreeId: w.id,
          name: w.label,
          branch: w.branch,
          worktree: w,
          primary: false,
          task: w.task,
          exists: w.exists,
          sessions: [...w.sessions, ...extra],
          terminals: [...w.terminals, ...p.terminals.filter((t) => t.worktree?.id === w.id && !w.terminals.some((x) => x.id === t.id))],
        });
      }
      this.byProject.set(p.id, list);
      for (const ws of list) {
        this.byKey.set(ws.key, ws);
        for (const s of ws.sessions) this.owners.set(`/sessions/${s.id}`, ws.key);
        for (const t of ws.terminals) this.owners.set(`/terminals/${t.id}`, ws.key);
      }
    }
  }

  get(key: string): Workspace | undefined {
    return this.byKey.get(key);
  }

  ofProject(projectId: string): Workspace[] {
    return this.byProject.get(projectId) ?? [];
  }

  all(): Workspace[] {
    return [...this.byKey.values()];
  }

  /** Clé du dossier auquel appartient un chemin (fichiers, session, navigateur, terminal), ou null. */
  keyOf(pathname: string): string | null {
    const files = pathname.match(/^(\/(?:projects|worktrees)\/[^/]+\/files)(?:\/|$)/);
    if (files) return this.byKey.has(files[1]) ? files[1] : null;
    const session = pathname.match(/^(\/sessions\/[^/]+)(?:\/browser)?$/);
    if (session) return this.owners.get(session[1]) ?? null;
    const terminal = pathname.match(/^(\/terminals\/[^/]+)$/);
    if (terminal) return this.owners.get(terminal[1]) ?? null;
    return null;
  }
}

export const EMPTY_INDEX = new WorkspaceIndex([]);

/** Identifiants (UUID) présents dans des chemins d'onglets, par type, pour la sidebar d'un super administrateur. */
export function openItemsOf(paths: string[]): { projectIds: string[]; worktreeIds: string[]; sessionIds: string[]; terminalIds: string[]; taskIds: string[] } {
  const pick = (re: RegExp) => [...new Set(paths.flatMap((p) => [...p.matchAll(re)].map((m) => m[1].toLowerCase())))].filter((id) => /^[0-9a-f-]{36}$/.test(id)).sort();
  return {
    projectIds: pick(/\/projects\/([0-9a-fA-F-]{36})/g),
    worktreeIds: pick(/\/worktrees\/([0-9a-fA-F-]{36})/g),
    sessionIds: pick(/\/sessions\/([0-9a-fA-F-]{36})/g),
    terminalIds: pick(/\/terminals\/([0-9a-fA-F-]{36})/g),
    taskIds: pick(/\/tasks\/([0-9a-fA-F-]{36})/g),
  };
}
