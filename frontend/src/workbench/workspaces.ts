import type { ProjectRole, SessionActivity, SessionStatus, TerminalStatus } from '../graphql/operations';

/**
 * Dossiers de travail : chaque session a le sien (sa work session — un git worktree sur sa propre branche, notion
 * technique que l'interface ne nomme jamais), et le checkout principal d'un projet (« primary ») n'en garde un que pour
 * les sessions et terminaux d'avant les work sessions. Tout ce qui s'ouvre *dans* le dossier d'une session (la
 * session, son navigateur, ses fichiers, ses terminaux) vit dans un seul onglet du workbench, celui de la session,
 * avec une sous-barre qui liste ce qui y est ouvert.
 */

export interface SidebarTask {
  id: string;
  title: string;
  status: string;
  statusTag?: string | null;
}

/** Dossier de travail d'une session (sa work session) : branche, présence sur le disque, tâche. */
export interface SidebarWorksession {
  id: string;
  name: string;
  branch: string;
  exists: boolean;
  task: SidebarTask | null;
}

/** Page partagée publiée depuis une session : onglet dans la sous-barre de son dossier. */
export interface SidebarPage {
  id: string;
  title: string;
  /** Commentaires non traités. */
  openComments: number;
}

/** Chemin d'une page partagée ouverte dans le dossier de la session qui l'a publiée ; `/shared/<id>` reste son lien à part entière. */
export const sessionPagePath = (sessionId: string, pageId: string) => `/sessions/${sessionId}/pages/${pageId}`;

export interface SidebarSession {
  id: string;
  name: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  pendingRequestCount: number;
  browserActive: boolean;
  /** Pages partagées publiées depuis la session et visibles de la personne (absent : pas encore chargé). */
  pages?: SidebarPage[];
  /** Coût cumulé de la session (unité d'affichage), montré dans l'infobulle de sa ligne. */
  costUsd?: number;
  /** Modèle de la session (sa configuration, sinon le défaut de son propriétaire) ; absent ou null : inconnu. */
  model?: string | null;
  /** Contexte de l'agent : au-delà du seuil serveur, une pastille invite à le nettoyer. */
  context: { tokens: number | null; overThreshold: boolean };
  owner: { id: string; name: string; avatarUrl: string | null; kind?: 'PERSON' | 'AGENT' } | null;
  /** Personne qui a demandé la session quand son propriétaire est un agent de projet. */
  requestedBy?: { id: string } | null;
  /** Agent de projet qui joue la session (pastille à la place des initiales du propriétaire). */
  agent?: { id: string; name: string; avatar: { emoji: string | null; color: string | null } } | null;
  /** Session d'agent qui a lancé celle-ci (outil MCP sessions.create) ; null pour une session lancée par un humain. */
  parentSession: { id: string } | null;
  /** Planification qui a lancé la session (session d'une exécution) : la sidebar la range sous la ligne de sa planification. */
  schedule?: { id: string; name: string; enabled: boolean } | null;
  /** Dossier de travail ; null pour une session d'avant les work sessions (checkout principal) ou dont le dossier a été supprimé. */
  worksession?: SidebarWorksession | null;
}

export interface SidebarTerminal {
  id: string;
  name: string;
  status: TerminalStatus;
  worksession?: { id: string } | null;
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
}

export interface Workspace {
  /** Clé de l'onglet : /sessions/:id (dossier d'une session) ou /projects/:id/files (checkout principal). */
  key: string;
  projectId: string;
  projectName: string;
  /** Identifiant technique du dossier (work session), pour les requêtes git et fichiers ; null : checkout principal. */
  worksessionId: string | null;
  /** Session : son nom ; primary : branche du projet. */
  name: string;
  branch: string;
  /** La session dont c'est le dossier ; null pour le checkout principal. */
  session: SidebarSession | null;
  primary: boolean;
  task: SidebarTask | null;
  exists: boolean;
  /** Sessions du dossier : la session elle-même (plusieurs seulement pour des données d'avant la règle « une session par dossier ») ; primary : sessions d'avant les work sessions. */
  sessions: SidebarSession[];
  terminals: SidebarTerminal[];
}

export type WorkspaceState = 'ask' | 'busy' | 'idle' | null;

/** Clé de l'onglet du dossier principal d'un projet, ou du dossier d'une session (sa page). */
export const primaryKey = (projectId: string) => `/projects/${projectId}/files`;
export const sessionKey = (sessionId: string) => `/sessions/${sessionId}`;
/** Explorateur de fichiers d'un dossier. */
export const filesKey = (ws: Pick<Workspace, 'key' | 'primary'>) => (ws.primary ? ws.key : `${ws.key}/files`);

/** Titre de l'onglet d'un dossier : « Nom de la session · Projet » (ou « main · Projet » pour le checkout principal). */
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

export const participates = (s: { owner: { id: string } | null; requestedBy?: { id: string } | null }, userId: string | null) => !s.owner || s.owner.id === userId || (Boolean(userId) && s.requestedBy?.id === userId);

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
 * dans l'ordre de la liste. Une session dont la parente n'est pas dans la liste (autre dossier, archivée,
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
 * (toutes les sessions du projet) : un sous-agent, qui a son propre dossier, se range ainsi sous sa parente, et une
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

/** Session racine d'un sous-agent : sa parente, ou l'aïeule la plus haute, présente dans `pool` (la session elle-même sinon). */
export function rootOf<T extends { id: string; parentSession: { id: string } | null }>(s: T, pool: Map<string, T>): T {
  const seen = new Set<string>([s.id]);
  let current = s;
  while (current.parentSession && pool.has(current.parentSession.id) && !seen.has(current.parentSession.id)) {
    seen.add(current.parentSession.id);
    current = pool.get(current.parentSession.id)!;
  }
  return current;
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

/** Index des dossiers de travail construit à partir de la requête Sidebar : un dossier par session, plus le checkout principal. */
export class WorkspaceIndex {
  private readonly byKey = new Map<string, Workspace>();
  private readonly byProject = new Map<string, Workspace[]>();
  /** Clé du dossier qui contient chaque session / terminal. */
  private readonly owners = new Map<string, string>();

  constructor(projects: SidebarProject[]) {
    for (const p of projects) {
      const list: Workspace[] = [];
      // Les terminaux d'un dossier vont avec la session qui l'occupe (la première, pour des données d'avant la règle « une session par dossier »).
      const terminalsOf = new Map<string, SidebarTerminal[]>();
      for (const t of p.terminals) if (t.worksession) terminalsOf.set(t.worksession.id, [...(terminalsOf.get(t.worksession.id) ?? []), t]);
      const seen = new Set<string>();
      const primarySessions: SidebarSession[] = [];
      for (const s of p.sessions) {
        const w = s.worksession;
        if (!w) {
          primarySessions.push(s);
          continue;
        }
        const first = !seen.has(w.id);
        seen.add(w.id);
        list.push({
          key: sessionKey(s.id),
          projectId: p.id,
          projectName: p.name,
          worksessionId: w.id,
          name: s.name,
          branch: w.branch,
          session: s,
          primary: false,
          task: w.task,
          exists: w.exists,
          sessions: [s],
          terminals: first ? (terminalsOf.get(w.id) ?? []) : [],
        });
      }
      const primary: Workspace = {
        key: primaryKey(p.id),
        projectId: p.id,
        projectName: p.name,
        worksessionId: null,
        name: p.gitUrl ? p.gitBranch || 'main' : 'workspace',
        branch: p.gitUrl ? p.gitBranch || 'main' : 'workspace',
        session: null,
        primary: true,
        task: null,
        exists: true,
        sessions: primarySessions,
        // Terminaux sans dossier, ou dont le dossier n'a plus de session listée.
        terminals: p.terminals.filter((t) => !t.worksession || !seen.has(t.worksession.id)),
      };
      list.unshift(primary);
      this.byProject.set(p.id, list);
      for (const ws of list) {
        this.byKey.set(ws.key, ws);
        for (const s of ws.sessions) this.owners.set(`/sessions/${s.id}`, ws.key);
        for (const t of ws.terminals) this.owners.set(`/terminals/${t.id}`, ws.key);
      }
      // Un sous-agent (session lancée par l'agent d'une autre session) s'ouvre dans l'onglet de sa session racine, où la
      // sous-barre le montre sous elle, plutôt que dans un onglet à part pour son propre dossier : ses pages (fichiers,
      // navigateur, pages publiées, terminaux) suivent.
      const byId = new Map(p.sessions.map((s) => [s.id, s]));
      const redirect = new Map<string, string>();
      for (const s of p.sessions) {
        const root = rootOf(s, byId);
        if (root === s) continue;
        const from = this.owners.get(`/sessions/${s.id}`);
        const to = this.owners.get(`/sessions/${root.id}`);
        if (from && to && from !== to) redirect.set(from, to);
      }
      if (redirect.size) for (const [path, key] of this.owners) if (redirect.has(key)) this.owners.set(path, redirect.get(key)!);
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

  /** Clé du dossier auquel appartient un chemin (fichiers, session, navigateur, page publiée, terminal), ou null. */
  keyOf(pathname: string): string | null {
    const files = pathname.match(/^(\/projects\/[^/]+\/files)(?:\/|$)/);
    if (files) return this.byKey.has(files[1]) ? files[1] : null;
    const session = pathname.match(/^(\/sessions\/[^/]+)(?:\/browser|\/pages\/[^/]+|\/files(?:\/.*)?)?$/);
    if (session) return this.owners.get(session[1]) ?? null;
    const terminal = pathname.match(/^(\/terminals\/[^/]+)$/);
    if (terminal) return this.owners.get(terminal[1]) ?? null;
    return null;
  }
}

export const EMPTY_INDEX = new WorkspaceIndex([]);

/** Identifiants (UUID) présents dans des chemins d'onglets, par type, pour la sidebar d'un super administrateur. */
export function openItemsOf(paths: string[]): { projectIds: string[]; sessionIds: string[]; terminalIds: string[]; taskIds: string[] } {
  const pick = (re: RegExp) => [...new Set(paths.flatMap((p) => [...p.matchAll(re)].map((m) => m[1].toLowerCase())))].filter((id) => /^[0-9a-f-]{36}$/.test(id)).sort();
  return {
    projectIds: pick(/\/projects\/([0-9a-fA-F-]{36})/g),
    sessionIds: pick(/\/sessions\/([0-9a-fA-F-]{36})/g),
    terminalIds: pick(/\/terminals\/([0-9a-fA-F-]{36})/g),
    taskIds: pick(/\/tasks\/([0-9a-fA-F-]{36})/g),
  };
}

/** Sessions d'une personne ou d'un agent, rangées sous une ligne repliable de la sidebar. */
export interface OwnerGroup<T> {
  /** Identifiant du propriétaire (personne ou agent) : clé de l'état déplié. */
  key: string;
  owner: NonNullable<SidebarSession['owner']>;
  agent: SidebarSession['agent'] | null;
  items: T[];
}

/**
 * Sépare les dossiers d'un projet : ceux auxquels la personne participe (et le checkout principal) restent à plat,
 * ceux des autres sont rangés par propriétaire, une personne ou un agent par groupe (les sessions d'un agent toujours,
 * même demandées par la personne), pour ne pas noyer les siens sous
 * le travail des autres. Les groupes qui attendent une réponse ou travaillent passent devant, puis par nom.
 */
export function ownerGroups<T extends { session: Pick<SidebarSession, 'owner' | 'requestedBy' | 'agent' | 'status' | 'activity' | 'pendingRequestCount'> | null }>(
  items: T[],
  userId: string | null,
): { mine: T[]; groups: OwnerGroup<T>[] } {
  const mine: T[] = [];
  const byOwner = new Map<string, OwnerGroup<T>>();
  for (const item of items) {
    const s = item.session;
    // Les sessions d'un agent se rangent toujours sous lui, même lancées à la demande de la personne : sinon le travail
    // d'un agent très sollicité noierait les dossiers de la personne (comme les exécutions d'une planification).
    if (!s || !s.owner || (!s.agent && participates(s, userId))) {
      mine.push(item);
      continue;
    }
    const group = byOwner.get(s.owner.id) ?? { key: s.owner.id, owner: s.owner, agent: s.agent ?? null, items: [] };
    group.items.push(item);
    byOwner.set(s.owner.id, group);
  }
  const RANK: Record<NonNullable<WorkspaceState>, number> = { ask: 0, busy: 1, idle: 2 };
  const rank = (g: OwnerGroup<T>) => {
    const state = workspaceState(g.items.map((i) => i.session!));
    return state ? RANK[state] : 3;
  };
  const groups = [...byOwner.values()].sort((a, b) => rank(a) - rank(b) || (a.agent?.name ?? a.owner.name).localeCompare(b.agent?.name ?? b.owner.name, 'fr'));
  return { mine, groups };
}

/** Planification et les dossiers des sessions qu'elle a lancées (une ligne dans la sidebar, ses exécutions dessous). */
export interface ScheduleGroup<T> {
  key: string;
  schedule: { id: string; name: string; enabled: boolean };
  items: T[];
}

/**
 * Range sous leur planification les dossiers des sessions qu'elle a lancées (sessions d'exécution) : une seule ligne
 * par planification, ses exécutions dessous, la plus récente d'abord (ordre de la liste reçue). Le reste est rendu tel quel.
 */
export function scheduleGroups<T extends { session: Pick<SidebarSession, 'schedule'> | null }>(items: T[]): { rest: T[]; groups: ScheduleGroup<T>[] } {
  const rest: T[] = [];
  const byId = new Map<string, ScheduleGroup<T>>();
  for (const item of items) {
    const schedule = item.session?.schedule;
    if (!schedule) {
      rest.push(item);
      continue;
    }
    const group = byId.get(schedule.id) ?? { key: schedule.id, schedule, items: [] };
    group.items.push(item);
    byId.set(schedule.id, group);
  }
  return { rest, groups: [...byId.values()] };
}

/** Nom d'une session d'exécution sous la ligne de sa planification : « Revue · 07/11 12:35 » devient « 07/11 12:35 ». */
export function runLabel(sessionName: string, scheduleName: string): string {
  const prefix = `${scheduleName} · `;
  return sessionName.startsWith(prefix) && sessionName.length > prefix.length ? sessionName.slice(prefix.length) : sessionName;
}
