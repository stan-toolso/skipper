import { randomUUID } from 'node:crypto';
import type { Actor } from '../context/types.js';
import { AppError, NotFoundError, isInvalidUuidError } from '../errors.js';
import { log } from '../log.js';
import { projectService } from '../projects/service.js';
import type { TaskStatusDefinition } from '../tasks/statuses.js';
import { slugify } from '../projects/slug.js';
import { isPersonalProject } from '../projects/types.js';
import { scheduleService } from '../schedules/service.js';
import { scheduleRepository } from '../schedules/repository.js';
import { sessionRepository } from '../sessions/repository.js';
import { sessionService } from '../sessions/service.js';
import type { AttachmentInput, Session } from '../sessions/types.js';
import { channelRef, conversationService, describeMessages, threadTitle } from '../conversations/service.js';
import type { Conversation } from '../conversations/types.js';
import { composeTaskPrompt, startTaskSession, taskFiles } from '../tasks/launch.js';
import { fold } from '../tasks/mentions.js';
import { taskService } from '../tasks/service.js';
import type { Task } from '../tasks/types.js';
import { userRepository } from '../users/repository.js';
import { userService } from '../users/service.js';
import { ROLE_RANK, type User } from '../users/types.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { autoArchiveConfig } from '../sessions/autoArchive.js';
import { agentRepository } from './repository.js';
import { AGENT_TEMPLATES, templateFor } from './templates.js';
import { AGENT_KINDS, AGENT_PROVIDERS, type Agent, type AgentAccountKind, type AgentAction, type AgentActionInput, type AgentInput, type AgentManagerRole, type AgentStats, type AgentTemplate, type OwnerAccounts, normalizeAvatar, ownAccounts, normalizeTriggers } from './types.js';
import { sessionAuthor, userAuthor, type InstructionAuthor } from '../sessions/instructionAuthor.js';

/** Auteur du message d'une convocation : la session d'agent qui convoque, sinon la personne qui l'a demandée. */
async function summonAuthor(opts: { requestedById?: string | null }, actor: Actor): Promise<InstructionAuthor | null> {
  if (actor.type === 'agent' && actor.sessionId) return sessionAuthor(actor.sessionId);
  return userAuthor(opts.requestedById);
}

const NAME_MAX = 60;
const DESCRIPTION_MAX = 200;
const INSTRUCTIONS_MAX = 20_000;
const ACTION_MAX = 20;
const ALLOWED_MODELS_MAX = 30;

/** Adresse technique d'un agent : jamais invitable, jamais rapprochée d'un compte Google. */
export const agentEmail = (id: string) => `agent-${id}@agents.skipper`;

/** Ce qu'une convocation transmet à l'agent. */
export interface SummonOptions {
  /** Tâche concernée : la session reliée de l'agent reçoit le message, sinon une session est ouverte sur la tâche. */
  taskId?: string | null;
  /** Fil d'un canal de conversation : la session reliée de l'agent reçoit le message, sinon une session est ouverte sur le fil. */
  thread?: { conversationId: string; rootMessageId: string } | null;
  text: string;
  attachments?: AttachmentInput[] | null;
  /** Personne qui convoque (null : un déclencheur ou une planification). */
  requestedById?: string | null;
  /** Qui agit (pour les sessions créées). */
  actor?: Actor;
  /**
   * Session lancée sans personne pour la piloter (déclencheur, autre session) : une session créée pour l'occasion est
   * archivée d'office à la fin de chaque tour (sessions/autoArchive.ts). Sans effet sur une session existante.
   */
  autoArchive?: boolean;
  /**
   * Session qui convoque (agent qui se convoque lui-même) : jamais choisie comme « session reliée » de l'agent, pour
   * qu'il ouvre bien une autre session au lieu de s'envoyer le message.
   */
  excludeSessionId?: string | null;
}

function actionKey(input: AgentActionInput, taken: Set<string>): string {
  const base = (input.key?.trim() || slugify(input.label) || 'action').slice(0, 40);
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/** Agent de cet identifiant, null s'il n'existe pas ou si l'identifiant n'est pas un UUID (erreur PostgreSQL 22P02). */
async function findAgent(id: string): Promise<Agent | null> {
  try {
    return await agentRepository.findById(id);
  } catch (error) {
    if (isInvalidUuidError(error)) return null;
    throw error;
  }
}

export const agentService = {
  templates: (): AgentTemplate[] => AGENT_TEMPLATES,

  async get(id: string): Promise<Agent> {
    const agent = await findAgent(id);
    if (!agent) throw new NotFoundError('Agent introuvable');
    return agent;
  },

  /** Profil d'un utilisateur s'il est un agent, null pour une personne (ou un identifiant inconnu). */
  forUser: (userId: string | null | undefined): Promise<Agent | null> => (userId ? findAgent(userId) : Promise.resolve(null)),

  listByProject: (projectId: string, opts?: { includeArchived?: boolean }) => agentRepository.listByProject(projectId, opts),
  listActive: (projectIds: string[]) => agentRepository.listActive(projectIds),
  managers: (agentId: string) => agentRepository.listManagers(agentId),
  stats: (agentId: string): Promise<AgentStats> => agentRepository.stats(agentId),

  /** Agent d'un projet désigné par son identifiant ou son nom (sans casse ni accents). */
  async resolve(projectId: string, ref: string): Promise<Agent> {
    const agents = await agentRepository.listByProject(projectId);
    const wanted = fold(ref);
    const found = agents.find((a) => a.id === ref.trim().toLowerCase()) ?? agents.find((a) => fold(a.name) === wanted);
    if (!found) throw new NotFoundError(`Aucun agent « ${ref} » dans ce projet${agents.length ? ` (agents : ${agents.map((a) => a.name).join(', ')})` : ''}`);
    return found;
  },

  /** Peut gérer l'agent : propriétaire ou gestionnaire de l'agent, ou administrateur du projet. */
  async canManage(userId: string, agent: Pick<Agent, 'id' | 'projectId'>): Promise<boolean> {
    if (await agentRepository.isManager(agent.id, userId)) return true;
    return (await userService.roleFor(userId, agent.projectId)) === 'admin';
  },

  async assertCanManage(userId: string, agent: Pick<Agent, 'id' | 'projectId'>): Promise<void> {
    if (!(await this.canManage(userId, agent))) throw new AppError("Seuls les gestionnaires de l'agent et les administrateurs du projet peuvent le modifier", 'FORBIDDEN');
  },

  /** L'utilisateur agent pour le compte duquel une personne règle des comptes (`?actAs=`), si elle le gère. */
  async actAsFor(user: User, agentId: string): Promise<User> {
    const agent = await this.get(agentId);
    await this.assertCanManage(user.id, agent);
    const actAs = await userRepository.findById(agent.id);
    if (!actAs) throw new NotFoundError('Agent introuvable');
    return actAs;
  },

  /** Le nom doit être unique parmi les membres du projet (c'est l'alias de mention). */
  async assertNameFree(projectId: string, name: string, exceptUserId: string | null = null): Promise<void> {
    const wanted = fold(name);
    for (const m of await userService.members(projectId)) {
      if (m.userId === exceptUserId) continue;
      const u = await userRepository.findById(m.userId);
      if (u && fold(u.name) === wanted) throw new AppError(`Un membre du projet s'appelle déjà « ${u.name} » : choisissez un autre nom pour l'agent`);
    }
  },

  /**
   * Crée un agent : utilisateur de genre « agent », membre du projet (rôle membre), profil d'après le modèle de son
   * rôle puis l'entrée, dossier de contexte `agents/<slug>`, créateur propriétaire. Un espace personnel n'a pas d'agent.
   */
  async create(projectId: string, input: AgentInput, creator: User): Promise<Agent> {
    const project = await projectService.get(projectId);
    if (isPersonalProject(project)) throw new AppError("Un espace personnel n'a pas d'agents");
    const kind = input.kind && AGENT_KINDS.includes(input.kind) ? input.kind : 'custom';
    const template = templateFor(kind);
    const name = (input.name ?? template.suggestedName).trim();
    if (!name) throw new AppError("Donnez un nom à l'agent");
    if (name.length > NAME_MAX) throw new AppError(`Le nom dépasse ${NAME_MAX} caractères`);
    if (name.includes('@')) throw new AppError("Le nom d'un agent ne contient pas de « @ »");
    await this.assertNameFree(projectId, name);
    const id = randomUUID();
    const user = await userRepository.create({ id, email: agentEmail(id), name, kind: 'agent' });
    await userRepository.upsertMembership({ projectId, userId: user.id, role: 'member', invitedById: creator.id });
    const actions = this.prepareActions(input.actions ?? template.actions, []);
    const agent = await agentRepository.create({
      userId: user.id,
      projectId,
      kind,
      avatar: normalizeAvatar({ ...template.avatar, ...(input.avatar ?? {}) }),
      description: (input.description ?? template.description).trim().slice(0, DESCRIPTION_MAX),
      instructions: this.validInstructions(input.instructions ?? template.instructions),
      taskFolder: input.taskFolder ?? template.taskFolder,
      ...this.validModels(input.defaults ?? template.defaults, input.allowedModels ?? []),
      inheritContext: input.inheritContext ?? true,
      triggers: normalizeTriggers(input.triggers ?? template.triggers),
      actions,
      createdById: creator.id,
    });
    await agentRepository.setManagers(agent.id, [{ userId: creator.id, role: 'owner' }]);
    await this.syncActionSchedules(agent).catch((err) => log.warn(`[agents] planification des actions de ${agent.name}`, err));
    return this.get(agent.id);
  },

  /**
   * Réglages par défaut et modèles autorisés validés ensemble : type de session (`provider`) connu, liste sans doublon,
   * modèle par défaut parmi les modèles autorisés quand la liste n'est pas vide.
   */
  validModels(defaults: Record<string, unknown>, allowedModels: string[]): { defaults: Record<string, unknown>; allowedModels: string[] } {
    const allowed = [...new Set(allowedModels.map((m) => m.trim()).filter(Boolean))];
    if (allowed.length > ALLOWED_MODELS_MAX) throw new AppError(`Au plus ${ALLOWED_MODELS_MAX} modèles autorisés`);
    const out = { ...defaults };
    for (const key of ['provider', 'model']) {
      const v = out[key];
      if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) delete out[key];
      else if (typeof v !== 'string') throw new AppError(`Réglage par défaut ${key} invalide`);
      else out[key] = v.trim();
    }
    if (out.provider && !AGENT_PROVIDERS.includes(out.provider as string)) throw new AppError(`Type de session inconnu pour un agent : ${String(out.provider)}`);
    if (allowed.length && out.model && !allowed.includes(out.model as string)) throw new AppError(`Le modèle par défaut (${String(out.model)}) doit faire partie des modèles autorisés`);
    return { defaults: out, allowedModels: allowed };
  },

  validInstructions(text: string): string {
    const t = text.replace(/\u0000/g, '').trim();
    if (t.length > INSTRUCTIONS_MAX) throw new AppError(`Les instructions dépassent ${INSTRUCTIONS_MAX} caractères`);
    return t;
  },

  /** Planification d'une action existante (et sa référence d'avant la refonte, résolue à la synchronisation). */
  scheduleRefOf(a: AgentAction | undefined): Pick<AgentAction, 'scheduleId' | 'scheduleSessionId'> {
    return { scheduleId: a?.scheduleId ?? null, ...(a?.scheduleSessionId ? { scheduleSessionId: a.scheduleSessionId } : {}) };
  },

  /** Actions validées, clés uniques, planifications reprises des actions existantes de même clé. */
  prepareActions(inputs: AgentActionInput[], existing: AgentAction[]): AgentAction[] {
    if (inputs.length > ACTION_MAX) throw new AppError(`Au plus ${ACTION_MAX} actions par agent`);
    const taken = new Set<string>();
    return inputs.map((a) => {
      const label = a.label.trim();
      const instruction = a.instruction.replace(/\u0000/g, '').trim();
      if (!label) throw new AppError('Chaque action a un libellé');
      if (!instruction) throw new AppError(`L'action « ${label} » n'a pas d'instruction`);
      const key = actionKey(a, taken);
      return { key, label: label.slice(0, 80), instruction, cron: a.cron?.trim() || null, timezone: a.timezone?.trim() || null, ...this.scheduleRefOf(existing.find((e) => e.key === key)) };
    });
  },

  async update(id: string, input: AgentInput): Promise<Agent> {
    const agent = await this.get(id);
    if (input.name !== undefined && input.name !== null) {
      const name = input.name.trim();
      if (!name) throw new AppError("Donnez un nom à l'agent");
      if (name.length > NAME_MAX) throw new AppError(`Le nom dépasse ${NAME_MAX} caractères`);
      if (name.includes('@')) throw new AppError("Le nom d'un agent ne contient pas de « @ »");
      if (name !== agent.name) {
        await this.assertNameFree(agent.projectId, name, agent.id);
        await userRepository.rename(agent.id, name);
      }
    }
    const updated = await agentRepository.update(id, {
      ...(input.kind && AGENT_KINDS.includes(input.kind) ? { kind: input.kind } : {}),
      ...(input.avatar !== undefined ? { avatar: normalizeAvatar(input.avatar) } : {}),
      ...(input.description !== undefined && input.description !== null ? { description: input.description.trim().slice(0, DESCRIPTION_MAX) } : {}),
      ...(input.instructions !== undefined && input.instructions !== null ? { instructions: this.validInstructions(input.instructions) } : {}),
      ...(input.taskFolder !== undefined && input.taskFolder !== null ? { taskFolder: input.taskFolder } : {}),
      ...(input.defaults != null || input.allowedModels != null ? this.validModels(input.defaults ?? agent.defaults, input.allowedModels ?? agent.allowedModels) : {}),
      ...(input.inheritContext !== undefined && input.inheritContext !== null ? { inheritContext: input.inheritContext } : {}),
      ...(input.triggers !== undefined && input.triggers !== null ? { triggers: normalizeTriggers({ ...agent.triggers, ...input.triggers }) } : {}),
      ...(input.actions !== undefined && input.actions !== null ? { actions: this.prepareActions(input.actions, agent.actions) } : {}),
    });
    if (!updated) throw new NotFoundError('Agent introuvable');
    if (input.actions !== undefined || (input.name && input.name.trim() !== agent.name)) {
      await this.syncActionSchedules(updated, agent.actions).catch((err) => log.warn(`[agents] planification des actions de ${updated.name}`, err));
    }
    return this.get(id);
  },

  async setEnabled(id: string, enabled: boolean): Promise<Agent> {
    const agent = await this.get(id);
    const updated = await agentRepository.update(id, { enabled });
    for (const a of agent.actions) {
      const scheduleId = await this.actionScheduleId(a);
      if (scheduleId) await scheduleService.setEnabled(scheduleId, enabled && Boolean(a.cron)).catch(() => undefined);
    }
    return updated ?? agent;
  },

  /**
   * Retire l'agent du projet : profil archivé, appartenance retirée, planifications de ses actions supprimées.
   * L'utilisateur et ses sessions restent (historique, coûts) ; il ne réagit plus à rien et ne se mentionne plus.
   */
  async remove(id: string): Promise<boolean> {
    const agent = await this.get(id);
    for (const a of agent.actions) await this.dropActionSchedule(await this.actionScheduleId(a));
    await agentRepository.update(id, { archivedAt: new Date(), enabled: false, actions: agent.actions.map(({ scheduleSessionId: _legacy, ...a }) => ({ ...a, scheduleId: null })) });
    await userRepository.removeMembership(agent.projectId, agent.id);
    return true;
  },

  async setManagers(id: string, managers: { userId: string; role: AgentManagerRole }[]): Promise<Agent> {
    const agent = await this.get(id);
    const owners = managers.filter((m) => m.role === 'owner');
    if (owners.length !== 1) throw new AppError("Un agent a exactement un propriétaire");
    const seen = new Set<string>();
    for (const m of managers) {
      if (seen.has(m.userId)) throw new AppError('Une personne ne figure qu’une fois parmi les gestionnaires');
      seen.add(m.userId);
      const user = await userRepository.findById(m.userId);
      if (!user || user.kind !== 'person') throw new AppError('Les gestionnaires sont des personnes');
      const role = await userService.roleFor(m.userId, agent.projectId);
      if (!role || ROLE_RANK[role] < ROLE_RANK.member) throw new AppError(`${user.name} doit être membre du projet pour gérer l'agent`);
    }
    await agentRepository.setManagers(id, managers);
    return agent;
  },

  // ---- Comptes et délégation ---------------------------------------------------------------------

  /** Les comptes qui font tourner les sessions d'un agent : les siens, ou ceux qu'une personne lui a prêtés. */
  accounts(agent: Agent): OwnerAccounts {
    return {
      claudeUserId: agent.claudeDelegateId ?? agent.id,
      githubUserId: agent.githubDelegateId ?? agent.id,
      githubReadOnly: Boolean(agent.githubDelegateId && agent.githubDelegateReadOnly),
      githubPullRequests: !(agent.githubDelegateId && agent.githubDelegateReadOnly) || agent.githubDelegatePullRequests,
      githubMerge: Boolean(agent.githubDelegateId && !agent.githubDelegateReadOnly && agent.githubDelegateMerge),
      gitlabUserId: agent.gitlabDelegateId ?? agent.id,
      gitlabReadOnly: Boolean(agent.gitlabDelegateId && agent.gitlabDelegateReadOnly),
      gitlabPullRequests: !(agent.gitlabDelegateId && agent.gitlabDelegateReadOnly) || agent.gitlabDelegatePullRequests,
      gitlabMerge: Boolean(agent.gitlabDelegateId && !agent.gitlabDelegateReadOnly && agent.gitlabDelegateMerge),
      forgeUserId: agent.id,
    };
  },

  /** Comptes d'un propriétaire de session quel qu'il soit : une personne (les siens), ou un agent (délégation éventuelle). */
  async accountsForOwner(ownerId: string | null | undefined): Promise<OwnerAccounts | null> {
    if (!ownerId) return null;
    const agent = await agentRepository.findById(ownerId);
    return agent ? this.accounts(agent) : ownAccounts(ownerId);
  },

  /**
   * Comptes qui servent une session : ceux de la personne qui a pris la main (les siens, en écriture), sinon ceux de son
   * propriétaire (`accountsForOwner`). Tout code qui agit « avec les comptes de la session » passe par là.
   */
  async accountsForSession(session: Pick<Session, 'ownerId' | 'takenOverById'>): Promise<OwnerAccounts | null> {
    return session.takenOverById ? ownAccounts(session.takenOverById) : this.accountsForOwner(session.ownerId);
  },

  /**
   * Peut prendre la main sur la session d'un agent : membre du projet (au moins rôle membre) qui a demandé la session,
   * ou gestionnaire de l'agent, ou administrateur du projet. Une session de personne ne se prend pas.
   */
  async canTakeOver(userId: string, session: Pick<Session, 'ownerId' | 'projectId' | 'requestedById'>): Promise<boolean> {
    const agent = await this.forUser(session.ownerId);
    if (!agent) return false;
    const role = await userService.roleFor(userId, session.projectId);
    if (!role || ROLE_RANK[role] < ROLE_RANK.member) return false;
    return session.requestedById === userId || this.canManage(userId, agent);
  },

  /**
   * Une personne prend la main sur la session d'un agent : la session continue (même conversation, même dossier, toujours
   * au nom de l'agent), mais avec les comptes et les droits de la personne — elle peut alors pousser, ouvrir une PR,
   * utiliser ses éléments du coffre — jusqu'à ce qu'elle la rende (`handBack`).
   */
  async takeOver(sessionId: string, user: Pick<User, 'id' | 'name'>): Promise<Session> {
    const session = await sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundError('Session introuvable');
    if (!(await this.canTakeOver(user.id, session))) {
      throw new AppError("Seuls la personne qui a demandé la session, les gestionnaires de l'agent et les administrateurs du projet peuvent prendre la main", 'FORBIDDEN');
    }
    if (session.takenOverById === user.id) return session;
    const agent = await this.get(session.ownerId!);
    return sessionService.setTakenOver(sessionId, user.id, `${user.name} a pris la main : la session tourne désormais avec ses comptes et ses droits, plus ceux de ${agent.name}${session.status === 'running' ? ' (appliqué à la prochaine instruction, après la fin du tour en cours)' : ''}`);
  },

  /** Rend la session à l'agent : elle reprend ses comptes. La personne qui a la main, ou quiconque peut la prendre. */
  async handBack(sessionId: string, user: Pick<User, 'id' | 'name'>): Promise<Session> {
    const session = await sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundError('Session introuvable');
    if (!session.takenOverById) return session;
    if (session.takenOverById !== user.id && !(await this.canTakeOver(user.id, session))) {
      throw new AppError("Seuls la personne qui a la main, les gestionnaires de l'agent et les administrateurs du projet peuvent la rendre", 'FORBIDDEN');
    }
    const agent = await this.get(session.ownerId!);
    return sessionService.setTakenOver(sessionId, null, `${user.name} a rendu la main à ${agent.name} : la session reprend les comptes de l'agent`);
  },

  /**
   * Prête (ou reprend) un compte à l'agent : `delegateId` est la personne qui prête — elle ne peut prêter que son propre
   * compte, et doit être membre du projet ; null retire la délégation. Les comptes GitHub et GitLab se prêtent chacun à
   * part, en lecture seule par défaut ; `pullRequests` permet, en lecture seule, d'ouvrir des pull requests (merge
   * requests) par `tasks.pr_open` ; `merge` permet, en écriture, de fusionner les pull requests avec ce compte par
   * `tasks.pr_merge` sans demander l'accord d'une personne (sans effet, et remis à faux, en lecture seule). Une option
   * absente garde sa valeur tant que le prêt reste à la même personne.
   */
  async setDelegation(agentId: string, account: AgentAccountKind, delegateId: string | null, opts: { readOnly?: boolean | null; pullRequests?: boolean | null; merge?: boolean | null } = {}): Promise<Agent> {
    const agent = await this.get(agentId);
    if (delegateId) {
      const user = await userRepository.findById(delegateId);
      if (!user || user.kind !== 'person') throw new AppError('Seule une personne peut prêter son compte');
      const role = await userService.roleFor(delegateId, agent.projectId);
      if (!role || ROLE_RANK[role] < ROLE_RANK.member) throw new AppError(`${user.name} doit être membre du projet pour prêter son compte à l'agent`);
    }
    const current =
      account === 'github'
        ? { id: agent.githubDelegateId, readOnly: agent.githubDelegateReadOnly, pullRequests: agent.githubDelegatePullRequests, merge: agent.githubDelegateMerge }
        : { id: agent.gitlabDelegateId, readOnly: agent.gitlabDelegateReadOnly, pullRequests: agent.gitlabDelegatePullRequests, merge: agent.gitlabDelegateMerge };
    const same = delegateId != null && delegateId === current.id;
    const readOnly = delegateId ? (opts.readOnly ?? (same ? current.readOnly : true)) : true;
    const pullRequests = delegateId ? (opts.pullRequests ?? (same ? current.pullRequests : false)) : false;
    const merge = delegateId && !readOnly ? (opts.merge ?? (same ? current.merge : false)) : false;
    const patch =
      account === 'claude'
        ? { claudeDelegateId: delegateId }
        : account === 'github'
          ? { githubDelegateId: delegateId, githubDelegateReadOnly: readOnly, githubDelegatePullRequests: pullRequests, githubDelegateMerge: merge }
          : { gitlabDelegateId: delegateId, gitlabDelegateReadOnly: readOnly, gitlabDelegatePullRequests: pullRequests, gitlabDelegateMerge: merge };
    const updated = await agentRepository.update(agentId, patch);
    if (!updated) throw new NotFoundError('Agent introuvable');
    return updated;
  },

  /** Bibliothèques propres des agents actifs d'un projet (outils `context`, paramètre `library`). */
  async libraries(projectId: string): Promise<{ id: string; name: string }[]> {
    return (await agentRepository.listByProject(projectId)).map((a) => ({ id: a.id, name: a.name }));
  },

  // ---- Convocation ------------------------------------------------------------------------------

  /** Session non archivée de l'agent reliée à la tâche, la plus récente, pourvu que son dossier existe encore. */
  async sessionOnTask(agent: Agent, taskId: string, excludeSessionId?: string | null): Promise<Session | null> {
    for (const id of await agentRepository.sessionIdsOnTask(agent.id, taskId)) {
      if (id === excludeSessionId) continue;
      const s = await sessionRepository.findById(id);
      if (!s || s.archivedAt) continue;
      if (!s.worksessionId) continue;
      return s;
    }
    return null;
  },

  /**
   * Configuration d'une session de l'agent : ses réglages par défaut, puis ceux demandés. Un modèle demandé hors des
   * modèles autorisés est refusé ; sans modèle demandé, celui de l'agent (ou le premier autorisé) s'applique.
   */
  sessionConfig(agent: Agent, config: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const { provider: _provider, ...defaults } = agent.defaults as Record<string, unknown> & { provider?: string };
    const merged = { ...defaults, ...(config ?? {}) };
    this.assertModelAllowed(agent, merged.model);
    return this.constrainModel(agent, merged) ?? merged;
  },

  /** Refuse un modèle explicite que l'agent n'a pas le droit d'utiliser. */
  assertModelAllowed(agent: Agent, model: unknown): void {
    const m = typeof model === 'string' ? model.trim() : '';
    if (m && agent.allowedModels.length && !agent.allowedModels.includes(m)) {
      throw new AppError(`${agent.name} n'utilise que les modèles autorisés dans sa fiche : ${agent.allowedModels.join(', ')}`);
    }
  },

  /**
   * Configuration ramenée aux modèles autorisés de l'agent (null : rien à changer) : sans modèle ou avec un modèle
   * qui n'est plus autorisé, le modèle par défaut de l'agent s'il est autorisé, sinon le premier de la liste.
   */
  constrainModel(agent: Agent, config: Record<string, unknown>): Record<string, unknown> | null {
    const allowed = agent.allowedModels;
    if (!allowed.length) return null;
    const model = typeof config.model === 'string' ? config.model.trim() : '';
    if (model && allowed.includes(model)) return null;
    const fallback = typeof agent.defaults.model === 'string' && allowed.includes(agent.defaults.model) ? agent.defaults.model : allowed[0];
    return { ...config, model: fallback };
  },

  /** Type de session par défaut de l'agent (`defaults.provider`), Claude Code sinon. */
  providerOf(agent: Agent): string {
    const p = agent.defaults.provider;
    return typeof p === 'string' && p.trim() ? p.trim() : 'claude';
  },

  /**
   * Convoque l'agent : avec une tâche, sa session reliée à la tâche reçoit le message (relancée si elle était
   * terminée), sinon une session est ouverte sur la tâche — dans le dossier de la tâche pour un agent qui y travaille
   * (comme « Confier à un agent »), dans un dossier à part sinon (session seulement reliée à la tâche, dont elle
   * suit le fil). Sans tâche, une nouvelle session dans son propre dossier, nommée d'après le message.
   */
  async summon(agentId: string, opts: SummonOptions): Promise<Session> {
    const agent = await this.get(agentId);
    if (agent.archivedAt) throw new AppError(`L'agent ${agent.name} a été retiré du projet`);
    if (!agent.enabled) throw new AppError(`L'agent ${agent.name} est en pause`);
    const text = opts.text.replace(/\u0000/g, '').trim();
    if (!text && !opts.attachments?.length) throw new AppError('Le message est vide');
    const project = await projectService.get(agent.projectId);
    const actor = opts.actor ?? { type: 'human' };
    if (opts.taskId) {
      const task = await taskService.get(opts.taskId);
      if (task.projectId !== agent.projectId) throw new AppError(`La tâche n'appartient pas au projet de ${agent.name}`);
      const existing = await this.sessionOnTask(agent, task.id, opts.excludeSessionId);
      if (existing && existing.status !== 'queued') {
        return sessionService.sendMessage(existing.id, text, opts.attachments ?? null, { author: await summonAuthor(opts, actor) });
      }
      if (agent.taskFolder) {
        return startTaskSession(task.id, {
          ownerId: agent.id,
          requestedById: opts.requestedById ?? null,
          provider: this.providerOf(agent),
          config: this.sessionConfig(agent, opts.autoArchive ? autoArchiveConfig() : null),
          instructions: text,
        });
      }
      return this.sessionBesideTask(agent, task, text, opts, actor, project);
    }
    if (opts.thread) {
      const conversation = await conversationService.get(opts.thread.conversationId);
      if (conversation.projectId !== agent.projectId) throw new AppError(`Le canal n'appartient pas au projet de ${agent.name}`);
      const existing = (await this.sessionOnThread(agent, opts.thread.rootMessageId, opts.excludeSessionId)) ?? (await this.restoreOnThread(agent, opts.thread.rootMessageId));
      if (existing && existing.status !== 'queued' && existing.id !== opts.excludeSessionId) {
        return sessionService.sendMessage(existing.id, text, opts.attachments ?? null, { author: await summonAuthor(opts, actor) });
      }
      return this.sessionOnChannelThread(agent, conversation, opts.thread.rootMessageId, text, opts, actor);
    }
    return sessionService.create(
      {
        projectId: agent.projectId,
        newWorksession: {},
        name: `${agent.name} · ${(text.split('\n').find((l) => l.trim()) ?? 'Conversation').trim()}`.slice(0, 80),
        provider: this.providerOf(agent),
        prompt: text,
        attachments: opts.attachments ?? null,
        config: this.sessionConfig(agent, opts.autoArchive ? autoArchiveConfig() : null),
        ownerId: agent.id,
        requestedById: opts.requestedById ?? null,
      },
      actor,
    );
  },

  /** Session non archivée de l'agent reliée à un fil de canal, la plus récente, pourvu que son dossier existe encore. */
  async sessionOnThread(agent: Agent, rootMessageId: string, excludeSessionId?: string | null): Promise<Session | null> {
    for (const id of await conversationService.agentSessionIdsOnThread(agent.id, rootMessageId)) {
      if (id === excludeSessionId) continue;
      const s = await sessionRepository.findById(id);
      if (!s || s.archivedAt || !s.worksessionId) continue;
      return s;
    }
    return null;
  },

  /**
   * Restaure la dernière session archivée de l'agent sur un fil de canal (et son dossier) : l'agent range sa session
   * sitôt sa réponse postée, le message suivant du fil la reprend avec son contexte plutôt que d'en ouvrir une autre.
   * Renvoie null si elle ne peut pas l'être (dossier supprimé, autre session active dans le dossier…) : une nouvelle
   * session est alors ouverte sur le fil.
   */
  async restoreOnThread(agent: Agent, rootMessageId: string): Promise<Session | null> {
    const [id] = await conversationService.agentSessionIdsOnThread(agent.id, rootMessageId, { archived: true });
    if (!id) return null;
    const s = await sessionRepository.findById(id);
    if (!s?.worksessionId || !(await worksessionRepository.findById(s.worksessionId))) return null;
    try {
      const restored = await sessionService.unarchive(id);
      log.info(`[agents] session ${id} de ${agent.name} restaurée sur le fil ${rootMessageId}`);
      return restored;
    } catch (err) {
      log.warn(`[agents] session ${id} de ${agent.name} non restaurée : ${(err as Error).message}`);
      return null;
    }
  },

  /**
   * Session de l'agent sur un fil de canal : nouveau dossier à elle, le fil complet en contexte, reliée au fil (elle en
   * reçoit les messages suivants). La réponse de l'agent se fait dans le fil, par `conversations.post`.
   */
  async sessionOnChannelThread(agent: Agent, conversation: Conversation, rootMessageId: string, text: string, opts: SummonOptions, actor: Actor): Promise<Session> {
    const thread = await conversationService.thread(rootMessageId);
    const title = thread[0] ? threadTitle(thread[0], 60) : 'conversation';
    const prompt = [
      `Tu es convoqué dans le canal ${channelRef(conversation)} du projet, dans le fil « ${title} » (fil ${rootMessageId}, canal « ${conversation.slug} »). Le fil complet :`,
      '',
      ...describeMessages(thread, await conversationService.reactions(thread.map((m) => m.id)), { attachments: await conversationService.attachments(thread.map((m) => m.id)) }),
      '',
      text,
      '',
      `Réponds dans ce fil avec \`conversations.post\` (channel « ${conversation.slug} », reply_to ${rootMessageId}) : c'est là que l'équipe te lit. Tu recevras les messages suivants du fil ; \`conversations.read\` avec \`thread\` le relit en entier. Une fois ta réponse postée, si tu n'as plus rien à faire ici (rien en cours, rien à commiter), archive cette session (\`sessions.archive\`) même si tu attends une réponse : le prochain message du fil la restaurera.`,
    ].join('\n');
    const name = `${agent.name} · ${channelRef(conversation)} · ${title}`;
    const session = await sessionService.create(
      {
        projectId: agent.projectId,
        newWorksession: { label: name.slice(0, 100) },
        name: name.slice(0, 80),
        provider: this.providerOf(agent),
        prompt,
        attachments: opts.attachments ?? null,
        config: this.sessionConfig(agent, opts.autoArchive ? autoArchiveConfig() : null),
        ownerId: agent.id,
        requestedById: opts.requestedById ?? null,
        autoStart: false,
      },
      actor,
    );
    await conversationService.linkSession(rootMessageId, session.id).catch((err) => log.warn('[agents] session non reliée au fil', err));
    return sessionService.start(session.id);
  },

  /** Session de l'agent sur une tâche sans en prendre le dossier : nouveau dossier à elle, reliée à la tâche (fil suivi). */
  async sessionBesideTask(agent: Agent, task: Task, text: string, opts: SummonOptions, actor: Actor, project: { taskInstructions: string; taskStatuses: TaskStatusDefinition[] }): Promise<Session> {
    const files = await taskFiles(task.id);
    const prompt = composeTaskPrompt(task, await taskService.comments(task.id), files, project.taskStatuses, project.taskInstructions, text);
    const session = await sessionService.create(
      {
        projectId: agent.projectId,
        newWorksession: { label: `${agent.name} · ${task.title}`.slice(0, 100) },
        name: `${agent.name} · ${task.title}`.slice(0, 80),
        provider: this.providerOf(agent),
        prompt,
        attachments: opts.attachments ?? null,
        config: this.sessionConfig(agent, opts.autoArchive ? autoArchiveConfig() : null),
        ownerId: agent.id,
        requestedById: opts.requestedById ?? null,
        autoStart: false,
      },
      actor,
    );
    await taskService.linkSession(task.id, session.id).catch((err) => log.warn('[agents] session non reliée à la tâche', err));
    return sessionService.start(session.id);
  },

  /** Joue une action nommée de l'agent (à la demande). */
  async runAction(agentId: string, key: string, opts: { taskId?: string | null; requestedById?: string | null; actor?: Actor } = {}): Promise<Session> {
    const agent = await this.get(agentId);
    const action = agent.actions.find((a) => a.key === key);
    if (!action) throw new NotFoundError(`Action « ${key} » inconnue pour ${agent.name}`);
    return this.summon(agentId, { taskId: opts.taskId ?? null, text: action.instruction, requestedById: opts.requestedById ?? null, actor: opts.actor });
  },

  // ---- Actions planifiées ----------------------------------------------------------------------

  /** Planification d'une action : la sienne, ou celle que portait sa session d'avant la refonte des planifications. */
  async actionScheduleId(a: AgentAction): Promise<string | null> {
    if (a.scheduleId) return a.scheduleId;
    if (!a.scheduleSessionId) return null;
    return (await scheduleRepository.findByLegacySession(a.scheduleSessionId))?.id ?? null;
  },

  /** Une planification par action à `cron` (créée, mise à jour, supprimée) ; l'agent est le propriétaire de ses exécutions. */
  async syncActionSchedules(agent: Agent, previous: AgentAction[] = agent.actions): Promise<void> {
    const actions: AgentAction[] = [];
    let changed = false;
    for (const prev of previous) {
      if (!agent.actions.some((a) => a.key === prev.key)) await this.dropActionSchedule(await this.actionScheduleId(prev));
    }
    for (const current of agent.actions) {
      const { scheduleSessionId: legacy, ...action } = current;
      const known = await this.actionScheduleId(current);
      if (legacy || known !== action.scheduleId) changed = true;
      action.scheduleId = known;
      const name = `${agent.name} · ${action.label}`.slice(0, 120);
      if (action.cron) {
        try {
          if (action.scheduleId && (await scheduleService.get(action.scheduleId))) {
            await scheduleService.update(action.scheduleId, { name, cron: action.cron, timezone: action.timezone, prompt: action.instruction, enabled: agent.enabled });
          } else {
            const schedule = await scheduleService.create(
              { projectId: agent.projectId, name, cron: action.cron, timezone: action.timezone, prompt: action.instruction, enabled: agent.enabled, provider: this.providerOf(agent), config: this.sessionConfig(agent, null) },
              { ownerId: agent.id },
            );
            action.scheduleId = schedule.id;
            changed = true;
          }
        } catch (err) {
          throw new AppError(`Action « ${action.label} » : ${(err as Error).message}`);
        }
      } else if (action.scheduleId) {
        await this.dropActionSchedule(action.scheduleId);
        action.scheduleId = null;
        changed = true;
      }
      actions.push(action);
    }
    if (changed) await agentRepository.update(agent.id, { actions });
  },

  async dropActionSchedule(scheduleId: string | null): Promise<void> {
    if (scheduleId) await scheduleService.remove(scheduleId).catch(() => undefined);
  },

  // ---- Activité ---------------------------------------------------------------------------------

  sessions: (agentId: string, limit = 50) => sessionService.list({ ownerId: agentId, archived: 'all', kind: 'all', limit }),
  async tasks(agentId: string, limit = 50): Promise<Task[]> {
    const ids = await agentRepository.taskIdsTouched(agentId, limit);
    if (!ids.length) return [];
    const tasks = await Promise.all(ids.map((id) => taskService.get(id).catch(() => null)));
    return tasks.filter((t): t is Task => Boolean(t));
  },
};
