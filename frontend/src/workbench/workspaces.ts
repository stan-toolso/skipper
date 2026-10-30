import type { ProjectRole, SessionActivity, SessionStatus, TerminalStatus } from '../graphql/operations';

/**
 * Dossiers de travail : le checkout principal d'un projet (« primary ») ou l'un de ses work sessions. Tout ce qui
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
  /** Contexte de l'agent : au-delà du seuil serveur, une pastille invite à le nettoyer. */
  context: { tokens: number | null; overThreshold: boolean };
  owner: { id: string; name: string; avatarUrl: string | null } | null;
  /** Session d'agent qui a lancé celle-ci (outil MCP sessions.create) ; null pour une session lancée par un humain. */
  parentSession: { id: string } | null;
  worksession?: { id: string } | null;
}

export interface SidebarTerminal {
  id: string;
  name: string;
  status: TerminalStatus;
  worksession?: { id: string } | null;
}

export interface SidebarWorksession {
  id: string;
  name: string;
  branch: string;
  label: string;
  customLabel: string | null;
  exists: boolean;
  task: { id: string; title: string; status: string; statusTag?: string | null } | null;
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
  /** Espace personnel de la personne connectée : affiché en tête, à part des projets. */
  isPersonal: boolean;
  /** Rôle de la personne : ADMIN peut modifier et supprimer le projet. */
  myRole: ProjectRole;
  sessions: SidebarSession[];
  terminals: SidebarTerminal[];
  worksessions: SidebarWorksession[];
}

export interface Workspace {
  /** Clé de l'onglet : /projects/:id/files (primary) ou /worksessions/:wid/files. */
  key: string;
  projectId: string;
  projectName: string;
  worksessionId: string | null;
  /** Worksession : libellé (choisi, sinon branche) ; primary : branche du projet. */
  name: string;
  branch: string;
  worksession: SidebarWorksession | null;
  primary: boolean;
  task: { id: string; title: string; status: string; statusTag?: string | null } | null;
  exists: boolean;
  sessions: SidebarSession[];
  terminals: SidebarTerminal[];
}

export type WorkspaceState = 'ask' | 'busy' | 'idle' | null;

/** Clé de l'onglet du dossier principal d'un projet ou d'une work session. */
export const primaryKey = (projectId: string) => `/projects/${projectId}/files`;
export const worksessionKey = (worksessionId: string) => `/worksessions/${worksessionId}/files`;

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

/** Une session dans l'arborescence d'un dossier : sa profondeur sous sa session parente, et le nom de celle-ci si elle est dans la même liste. */
export interface SessionNode<T> {
  session: T;
  /** 0 : session de premier niveau ; 1, 2… : lancée par la session qui la précède dans la liste. */
  depth: number;
  /** Lancée par un agent (parentSession non null), que la parente soit listée ici ou non. */
  byAgent: boolean;
  /** Nom de la session parente quand elle est dans la liste. */
  parentName: string | null;
}

/**
 * Sessions d'un dossier rangées en arbre : chaque session lancée par un agent suit sa session parente, indentée,
 * dans l'ordre de la liste. Une session dont la parente n'est pas dans la liste (autre work session, archivée,
 * masquée par le filtre) reste au premier niveau, marquée « lancée par un agent ». Les cycles ne sont pas
 * possibles en base ; si une parente manque, on ne boucle pas.
 */
export function sessionTree<T extends { id: string; name: string; parentSession: { id: string } | null }>(sessions: T[]): SessionNode<T>[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of sessions) {
    const parentId = s.parentSession?.id;
    if (parentId && parentId !== s.id && byId.has(parentId)) children.set(parentId, [...(children.get(parentId) ?? []), s]);
    else roots.push(s);
  }
  const out: SessionNode<T>[] = [];
  const seen = new Set<string>();
  const visit = (s: T, depth: number, parentName: string | null) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ session: s, depth, byAgent: Boolean(s.parentSession), parentName });
    for (const c of children.get(s.id) ?? []) visit(c, depth + 1, s.name);
  };
  for (const r of roots) visit(r, 0, null);
  return out;
}

/** Une session de premier niveau et, à plat, tous ses sous-agents (sessions lancées par son agent, et par les leurs). */
export interface SessionGroup<T> {
  root: SessionNode<T>;
  children: SessionNode<T>[];
}

/**
 * Sessions de premier niveau d'une liste (celles d'un dossier), chacune avec ses descendants cherchés dans `pool`
 * (toutes les sessions du projet) : un sous-agent lancé dans un autre work session se range ainsi sous sa parente, et une
 * session dont la parente est dans un autre dossier reste de premier niveau ici, avec le nom de sa parente.
 */
export function sessionGroups<T extends { id: string; name: string; parentSession: { id: string } | null }>(sessions: T[], pool: T[] = sessions): SessionGroup<T>[] {
  const poolNodes = sessionTree(pool);
  const index = new Map(poolNodes.map((n, i) => [n.session.id, i]));
  const groups: SessionGroup<T>[] = [];
  for (const node of sessionTree(sessions)) {
    if (node.depth > 0) continue; // ses descendants sont ceux du pool, rangés sous leur parente
    const i = index.get(node.session.id);
    const self = i === undefined ? node : poolNodes[i];
    const children: SessionNode<T>[] = [];
    if (i !== undefined) for (let j = i + 1; j < poolNodes.length && poolNodes[j].depth > self.depth; j++) children.push({ ...poolNodes[j], depth: poolNodes[j].depth - self.depth });
    groups.push({ root: { ...node, parentName: node.parentName ?? self.parentName }, children });
  }
  return groups;
}

/**
 * Vrai pour un sous-agent dont la parente (ou une aïeule) est dans un autre dossier du projet : il n'est listé que
 * sous elle, pas comme session à part dans le dossier où il travaille. `here` : identifiants des sessions du dossier ;
 * `pool` : toutes les sessions du projet par identifiant.
 */
export function attachedElsewhere(s: { parentSession: { id: string } | null }, here: Set<string>, pool: Map<string, { parentSession: { id: string } | null }>): boolean {
  const seen = new Set<string>();
  let current = s;
  while (current.parentSession && pool.has(current.parentSession.id) && !seen.has(current.parentSession.id)) {
    if (!here.has(current.parentSession.id)) return true;
    seen.add(current.parentSession.id);
    current = pool.get(current.parentSession.id)!;
  }
  return false;
}

/** Résumé d'un lot de sous-agents pour une ligne repliée : « 2 sous-agents », état dominant, demandes en attente. */
export function subagentsSummary(children: Pick<SidebarSession, 'status' | 'activity' | 'pendingRequestCount'>[]): { label: string; state: WorkspaceState; pending: number; hint: string | null } {
  const pending = children.reduce((n, s) => n + s.pendingRequestCount, 0);
  const working = children.filter((s) => s.status === 'RUNNING' && s.activity === 'BUSY').length;
  const idle = children.filter((s) => s.status === 'RUNNING' && s.activity !== 'BUSY').length;
  const queued = children.filter((s) => s.status === 'QUEUED').length;
  const one = children.length === 1;
  const label = `${children.length} sous-agent${one ? '' : 's'}`;
  const hint = pending
    ? null
    : working
      ? one ? 'travaille' : `${working} au travail`
      : idle
        ? one ? 'attend des instructions' : `${idle} en attente`
        : queued
          ? one ? "en file d'attente" : `${queued} en file`
          : one ? 'terminé' : 'terminés';
  return { label, state: workspaceState(children), pending, hint };
}

/** Index des dossiers de travail construit à partir de la requête Sidebar. */
export class WorkspaceIndex {
  private readonly byKey = new Map<string, Workspace>();
  private readonly byProject = new Map<string, Workspace[]>();
  /** Clé du dossier qui contient chaque session / terminal. */
  private readonly owners = new Map<string, string>();

  constructor(projects: SidebarProject[]) {
    for (const p of projects) {
      const list: Workspace[] = [];
      const worksessionIds = new Set(p.worksessions.map((w) => w.id));
      const primary: Workspace = {
        key: primaryKey(p.id),
        projectId: p.id,
        projectName: p.name,
        worksessionId: null,
        name: p.gitUrl ? p.gitBranch || 'main' : 'workspace',
        branch: p.gitUrl ? p.gitBranch || 'main' : 'workspace',
        worksession: null,
        primary: true,
        task: null,
        exists: true,
        sessions: p.sessions.filter((s) => !s.worksession || !worksessionIds.has(s.worksession.id)),
        terminals: p.terminals.filter((t) => !t.worksession || !worksessionIds.has(t.worksession.id)),
      };
      list.push(primary);
      for (const w of p.worksessions) {
        // Une session listée par le projet pour cette work session mais absente de la liste de la work session (listes plafonnées) y est rangée quand même.
        const extra = p.sessions.filter((s) => s.worksession?.id === w.id && !w.sessions.some((x) => x.id === s.id));
        list.push({
          key: worksessionKey(w.id),
          projectId: p.id,
          projectName: p.name,
          worksessionId: w.id,
          name: w.label,
          branch: w.branch,
          worksession: w,
          primary: false,
          task: w.task,
          exists: w.exists,
          sessions: [...w.sessions, ...extra],
          terminals: [...w.terminals, ...p.terminals.filter((t) => t.worksession?.id === w.id && !w.terminals.some((x) => x.id === t.id))],
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
    const files = pathname.match(/^(\/(?:projects|worksessions)\/[^/]+\/files)(?:\/|$)/);
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
export function openItemsOf(paths: string[]): { projectIds: string[]; worksessionIds: string[]; sessionIds: string[]; terminalIds: string[]; taskIds: string[] } {
  const pick = (re: RegExp) => [...new Set(paths.flatMap((p) => [...p.matchAll(re)].map((m) => m[1].toLowerCase())))].filter((id) => /^[0-9a-f-]{36}$/.test(id)).sort();
  return {
    projectIds: pick(/\/projects\/([0-9a-fA-F-]{36})/g),
    worksessionIds: pick(/\/worksessions\/([0-9a-fA-F-]{36})/g),
    sessionIds: pick(/\/sessions\/([0-9a-fA-F-]{36})/g),
    terminalIds: pick(/\/terminals\/([0-9a-fA-F-]{36})/g),
    taskIds: pick(/\/tasks\/([0-9a-fA-F-]{36})/g),
  };
}
