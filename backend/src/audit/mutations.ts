import type { AuthContext } from '../auth/access.js';
import { lookupTarget, type TargetInfo, type TargetKind } from './lookups.js';
import { auditService } from './service.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Args = Record<string, any>;
type Result = any;

/**
 * Comment une mutation GraphQL laisse sa trace au journal d'audit.
 *
 * Le projet et le libellé de la cible sont lus **avant** la mutation (`lookup`) : après une suppression, il n'y a plus
 * rien à lire. Le projet vient, dans l'ordre : `app` (aucun), l'argument `project`, le résultat (`projectFromResult`),
 * la cible lue, puis `result.projectId`. Sans projet (élément du coffre personnel, page sans projet), rien n'est inscrit.
 *
 * `details` ne doit jamais recopier un secret (valeurs du coffre, contenu des fichiers d'environnement) : seulement ce
 * qui dit quoi a changé.
 */
export interface MutationAudit {
  action: string;
  /** Type de cible ; défaut : ce qui précède le point dans `action`. */
  target?: string;
  /** Cible lue avant la mutation : son type et l'argument qui porte son identifiant (`input.x` accepté). */
  lookup?: [TargetKind, string];
  /** Argument qui porte le projet (`input.projectId` accepté). */
  project?: string;
  /** Le résultat est le projet lui-même (création). */
  projectFromResult?: boolean;
  /** Action de l'application, hors de tout projet (utilisateurs, réglages du serveur). */
  app?: boolean;
  /** Projet supprimé par l'action : l'entrée est gardée hors projet (sinon elle partirait avec lui). */
  detachProject?: boolean;
  targetId?: (args: Args, result: Result) => string | null | undefined;
  label?: (args: Args, result: Result) => string | null | undefined;
  details?: (args: Args, result: Result) => Record<string, unknown> | undefined;
}

const arg = (args: Args, path: string): any => path.split('.').reduce<any>((v, k) => (v == null ? undefined : v[k]), args);
const keysOf = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o as object).filter((k) => (o as Args)[k] !== undefined) : []);

/** Réponse à une demande : la décision et ce qui a été autorisé, pas plus. */
export function requestAnswerDetails(response: Args | null | undefined): Record<string, unknown> {
  if (!response || typeof response !== 'object') return {};
  if ('decision' in response) {
    const { decision, always, scope, rules, message } = response;
    return { decision, always, scope, rules, message };
  }
  if ('answers' in response) return { answers: response.answers };
  return { response };
}

const git = (action: string, details?: MutationAudit['details']): MutationAudit => ({
  action,
  project: 'projectId',
  lookup: ['worksession', 'worksessionId'],
  details,
});
const session = (action: string, details?: MutationAudit['details']): MutationAudit => ({ action, lookup: ['session', 'id'], details });
const vault = (action: string, details?: MutationAudit['details']): MutationAudit => ({ action, lookup: ['vault_item', 'id'], details });

/** Mutations inscrites au journal par l'enveloppe GraphQL. */
export const AUDITED: Record<string, MutationAudit> = {
  // Sessions : lancement, arrêt, interruption, archivage, configuration.
  createSession: {
    action: 'session.create',
    project: 'input.projectId',
    label: (a) => a.input?.name,
    details: (a, r) => ({ provider: a.input?.provider, agentId: a.input?.agentId, worksessionId: r?.worksessionId, config: a.input?.config }),
  },
  startSession: session('session.start'),
  stopSession: session('session.stop'),
  endSession: session('session.end'),
  interruptSession: session('session.interrupt'),
  resumeSession: session('session.resume'),
  restartSession: session('session.restart'),
  archiveSession: session('session.archive'),
  unarchiveSession: session('session.unarchive'),
  deleteSession: session('session.delete', (a) => ({ deleteBranch: a.deleteBranch })),
  relaunchSession: session('session.relaunch', (a, r) => ({ newSessionId: r?.id, input: a.input })),
  updateSessionConfig: session('session.config', (a) => ({ config: a.config })),
  updateSession: session('session.update', (a) => ({ input: a.input })),
  // Liens publics de lecture : la cible est la session (jamais le jeton du lien dans les détails).
  createSessionShare: { action: 'session.share', lookup: ['session', 'sessionId'], details: (a, r) => ({ shareId: r?.id, expiresInDays: a.expiresInDays }) },
  revokeSessionShare: { action: 'session.unshare', target: 'session', lookup: ['session_share', 'id'], details: (a) => ({ shareId: a.id }) },
  applySessionCleanup: session('session.cleanup'),
  compactSessionContext: session('session.compact'),
  resetSessionContext: session('session.context_reset', (a) => ({ keepSummary: a.keepSummary })),
  discardSessionFile: { action: 'session.discard_file', lookup: ['session', 'sessionId'], details: (a) => ({ path: a.path }) },
  takeOverSession: session('session.take_over'),
  handBackSession: session('session.hand_back'),
  // Planifications.
  createSchedule: {
    action: 'schedule.create',
    project: 'input.projectId',
    label: (a) => a.input?.name,
    details: (a) => ({ cron: a.input?.cron, timezone: a.input?.timezone, enabled: a.input?.enabled, agentId: a.input?.agentId }),
  },
  updateSchedule: { action: 'schedule.set', lookup: ['schedule', 'id'], details: (a) => ({ input: a.input }) },
  deleteSchedule: { action: 'schedule.clear', lookup: ['schedule', 'id'] },
  setScheduleEnabled: { action: 'schedule.enable', lookup: ['schedule', 'id'], details: (a) => ({ enabled: a.enabled }) },
  runScheduleNow: { action: 'schedule.run', lookup: ['schedule', 'id'] },
  // Demandes : qui a autorisé quoi.
  answerRequest: { action: 'request.answer', lookup: ['request', 'id'], details: (a, r) => ({ type: r?.type, sessionId: r?.sessionId, ...requestAnswerDetails(a.response) }) },
  cancelRequest: { action: 'request.cancel', lookup: ['request', 'id'], details: (_a, r) => ({ type: r?.type, sessionId: r?.sessionId }) },
  // Tâches (création et changement de statut sont inscrits par le service des tâches, qui sert aussi les agents).
  deleteTask: { action: 'task.delete', lookup: ['task', 'id'] },
  moveTask: { action: 'task.move', lookup: ['task', 'id'], details: (a) => ({ toProjectId: a.projectId }) },
  startTaskSession: { action: 'task.start_session', lookup: ['task', 'id'], details: (a, r) => ({ sessionId: r?.id, agentId: a.agentId, provider: a.provider }) },
  resumeTaskSession: { action: 'task.resume_session', lookup: ['task', 'id'], details: (_a, r) => ({ sessionId: r?.id }) },
  // Projet.
  createProject: { action: 'project.create', projectFromResult: true, label: (_a, r) => r?.name },
  // Montant tel que saisi, dans l'unité d'affichage (crédits dans une cellule facturée : jamais d'USD).
  setProjectBudget: { action: 'project.budget', lookup: ['project', 'projectId'], details: (a) => ({ monthlyBudget: a.monthlyBudgetUsd ?? null }) },
  updateProject: { action: 'project.update', lookup: ['project', 'id'], details: (a) => ({ fields: keysOf(a.input) }) },
  deleteProject: { action: 'project.delete', lookup: ['project', 'id'], detachProject: true, details: (a) => ({ deleteHostedRepo: a.deleteHostedRepo }) },
  importProjectArchive: { action: 'project.import', lookup: ['project', 'projectId'], details: (a) => ({ context: a.context, tasks: a.tasks, settings: a.settings }) },
  startProjectRunner: { action: 'project.runner_start', lookup: ['project', 'id'] },
  stopProjectRunner: { action: 'project.runner_stop', lookup: ['project', 'id'] },
  resetProjectRunner: { action: 'project.runner_reset', lookup: ['project', 'id'] },
  // Membres.
  inviteProjectMember: { action: 'member.invite', project: 'projectId', targetId: (_a, r) => r?.userId, label: (a) => a.email, details: (a) => ({ role: a.role }) },
  updateProjectMemberRole: { action: 'member.role', project: 'projectId', lookup: ['user', 'userId'], details: (a) => ({ role: a.role }) },
  removeProjectMember: { action: 'member.remove', project: 'projectId', lookup: ['user', 'userId'] },
  // Autorisations mémorisées et clés d'API.
  addProjectPermissionRule: { action: 'permission.add', project: 'projectId', label: (a) => (a.ruleContent ? `${a.toolName}(${a.ruleContent})` : a.toolName) },
  updateProjectPermissionRule: { action: 'permission.update', lookup: ['permission_rule', 'id'], details: (a) => ({ rule: a.rule }) },
  deleteProjectPermissionRule: { action: 'permission.delete', lookup: ['permission_rule', 'id'] },
  deleteProjectPermissionRules: { action: 'permission.delete', project: 'projectId', targetId: () => null, details: (a, r) => ({ ids: r ?? a.ids }) },
  createProjectApiKey: { action: 'api_key.create', project: 'projectId', targetId: (_a, r) => r?.key?.id ?? r?.id, label: (a) => a.name, details: (a) => ({ scopes: a.scopes ?? undefined, signed: a.signed ?? undefined }) },
  updateProjectApiKey: { action: 'api_key.update', lookup: ['api_key', 'id'], details: (a) => ({ name: a.name ?? undefined, scopes: a.scopes ?? undefined, triageAgentId: a.triageAgentId ?? undefined }) },
  setProjectApiKeySigning: { action: 'api_key.signing', lookup: ['api_key', 'id'], details: (a) => ({ enabled: a.enabled }) },
  deleteProjectApiKey: { action: 'api_key.delete', lookup: ['api_key', 'id'] },
  // Canaux de notification d'un projet (Slack, Discord, e-mail) ; un canal personnel n'a pas de projet : rien n'est inscrit.
  createNotificationChannel: { action: 'notification_channel.create', project: 'input.projectId', targetId: (_a, r) => r?.id, label: (_a, r) => (r ? `${r.kind} ${r.targetHint}` : null), details: (a) => ({ kind: a.input?.kind, categories: a.input?.categories }) },
  updateNotificationChannel: { action: 'notification_channel.update', lookup: ['notification_channel', 'id'], details: (a) => ({ fields: keysOf(a.patch), categories: a.patch?.categories, enabled: a.patch?.enabled }) },
  deleteNotificationChannel: { action: 'notification_channel.delete', lookup: ['notification_channel', 'id'] },
  // Panneau git.
  gitCommit: git('git.commit', (a) => ({ message: a.message, stageAll: a.stageAll })),
  gitPush: git('git.push'),
  gitPull: git('git.pull'),
  gitDiscard: git('git.discard', (a) => ({ paths: a.paths })),
  gitCheckout: git('git.checkout', (a) => ({ branch: a.branch, create: a.create })),
  gitMergeBase: git('git.merge_base'),
  gitAbortOperation: git('git.abort'),
  resolveGitConflicts: git('git.resolve_conflicts', (_a, r) => ({ sessionId: r?.id })),
  // Pull requests.
  createPullRequest: { ...git('pull_request.open', (a) => ({ title: a.title, base: a.base, draft: a.draft })), target: 'pull_request', targetId: (_a, r) => (r?.number != null ? String(r.number) : null), label: (a, r) => `#${r?.number ?? '?'} ${a.title}` },
  mergePullRequest: { action: 'pull_request.merge', project: 'projectId', targetId: (a) => String(a.number), label: (a) => `#${a.number}`, details: (a) => ({ method: a.method, cleanup: a.cleanup, repo: a.repo }) },
  registerPullRequest: { action: 'pull_request.register', project: 'projectId', label: (a, r) => (r?.number != null ? `#${r.number} ${r.title ?? ''}`.trim() : (a.url ?? `#${a.number}`)), details: (a) => ({ url: a.url, taskId: a.taskId }) },
  updatePullRequest: { action: 'pull_request.update', lookup: ['pull_request', 'id'], details: (a) => ({ input: a.input }) },
  deletePullRequest: { action: 'pull_request.untrack', lookup: ['pull_request', 'id'] },
  resolvePullRequestConflicts: { action: 'pull_request.resolve_conflicts', lookup: ['pull_request', 'id'], details: (_a, r) => ({ sessionId: r?.id }) },
  requestCodeReview: { action: 'pull_request.review', project: 'projectId', lookup: ['pull_request', 'pullRequestId'], details: (a, r) => ({ worksessionId: a.worksessionId, sessionId: r?.id }) },
  // Dossiers de travail et fichiers.
  createWorksession: { action: 'worksession.create', project: 'projectId', label: (_a, r) => (r ? `${r.label || r.name} (${r.branch})` : null), details: (a) => ({ branch: a.branch, baseRef: a.baseRef }) },
  renameWorksession: { action: 'worksession.rename', lookup: ['worksession', 'id'], details: (a) => ({ label: a.label, name: a.name }) },
  archiveWorksession: { action: 'worksession.archive', lookup: ['worksession', 'id'] },
  restoreWorksession: { action: 'worksession.restore', lookup: ['worksession', 'id'] },
  deleteWorksession: { action: 'worksession.delete', lookup: ['worksession', 'id'], details: (a) => ({ deleteBranch: a.deleteBranch, deleteSessions: a.deleteSessions }) },
  cleanMergedWorksessions: { action: 'worksession.clean', project: 'projectId', targetId: () => null, details: (a, r) => ({ names: a.names, result: r }) },
  importOrphanWorksession: { action: 'worksession.import', project: 'projectId', label: (a) => a.name },
  deleteOrphanWorksession: { action: 'worksession.delete_orphan', project: 'projectId', targetId: () => null, label: (a) => a.name },
  renameWorkspaceEntry: { action: 'file.rename', project: 'projectId', targetId: (a) => a.path, label: (a) => a.path, details: (a) => ({ worksessionId: a.worksessionId, newPath: a.newPath }) },
  deleteWorkspaceEntry: { action: 'file.delete', project: 'projectId', targetId: (a) => a.path, label: (a) => a.path, details: (a) => ({ worksessionId: a.worksessionId }) },
  createTerminal: { action: 'terminal.open', project: 'projectId', label: (_a, r) => r?.name, details: (a) => ({ worksessionId: a.worksessionId }) },
  // Fichiers d'environnement (jamais leur contenu).
  saveEnvFile: { action: 'env_file.save', project: 'projectId', lookup: ['env_file', 'id'], label: (a) => a.path, details: (a) => ({ path: a.path, applyOnCreate: a.applyOnCreate }) },
  deleteEnvFile: { action: 'env_file.delete', lookup: ['env_file', 'id'] },
  applyEnvFiles: { action: 'env_file.apply', lookup: ['worksession', 'worksessionId'], details: (a) => ({ paths: a.paths }) },
  // Connexions : coffre du projet (jamais les valeurs).
  createVaultItem: { action: 'vault.create', project: 'projectId', label: (a) => a.input?.name, details: (a) => ({ kind: a.input?.kind }) },
  updateVaultItem: vault('vault.update', (a) => ({ fields: keysOf(a.input) })),
  deleteVaultItem: vault('vault.delete'),
  duplicateVaultItem: vault('vault.duplicate', (_a, r) => ({ copyId: r?.id, copyName: r?.name })),
  regenerateVaultKey: vault('vault.regenerate_key'),
  forgetVaultHostKey: vault('vault.forget_host_key'),
  revealVaultSecret: vault('vault.reveal', (a) => ({ field: a.field })),
  shareVaultItem: vault('vault.share', (a) => ({ email: a.email, permission: a.permission })),
  unshareVaultItem: vault('vault.unshare', (a) => ({ userId: a.userId })),
  linkVaultItem: { action: 'vault.link', project: 'projectId', lookup: ['vault_item', 'id'], details: (a) => ({ scope: a.scope }) },
  unlinkVaultItem: { action: 'vault.unlink', lookup: ['vault_link', 'linkId'] },
  copyVaultItem: { action: 'vault.copy', project: 'projectId', lookup: ['vault_item', 'id'], targetId: (_a, r) => r?.id, details: (a) => ({ sourceId: a.id, name: a.name }) },
  // Agents de projet.
  createAgent: { action: 'agent.create', project: 'projectId', label: (a, r) => r?.name ?? a.input?.name },
  updateAgent: { action: 'agent.update', lookup: ['agent', 'id'], details: (a) => ({ fields: keysOf(a.input) }) },
  setAgentEnabled: { action: 'agent.enable', lookup: ['agent', 'id'], details: (a) => ({ enabled: a.enabled }) },
  deleteAgent: { action: 'agent.delete', lookup: ['agent', 'id'] },
  setAgentManagers: { action: 'agent.managers', lookup: ['agent', 'id'], details: (a) => ({ managers: a.managers }) },
  setAgentDelegation: { action: 'agent.delegation', lookup: ['agent', 'id'], details: (a) => ({ account: a.account, delegate: a.delegate, readOnly: a.readOnly, pullRequests: a.pullRequests, merge: a.merge }) },
  summonAgent: { action: 'agent.summon', lookup: ['agent', 'id'], details: (a, r) => ({ taskId: a.taskId, sessionId: r?.id }) },
  runAgentAction: { action: 'agent.action', lookup: ['agent', 'id'], details: (a, r) => ({ key: a.key, taskId: a.taskId, sessionId: r?.id }) },
  // Workflows.
  createWorkflow: { action: 'workflow.create', project: 'input.projectId', label: (a) => a.input?.name },
  updateWorkflow: { action: 'workflow.update', lookup: ['workflow', 'id'], details: (a) => ({ fields: keysOf(a.input) }) },
  deleteWorkflow: { action: 'workflow.delete', lookup: ['workflow', 'id'] },
  runWorkflow: { action: 'workflow.run', lookup: ['workflow', 'id'], details: (a, r) => ({ runId: r?.id, test: a.test, triggerKey: a.triggerKey }) },
  cancelWorkflowRun: { action: 'workflow.cancel_run', lookup: ['workflow_run', 'id'] },
  setWorkflowSchedule: { action: 'workflow.schedule', lookup: ['workflow', 'id'], details: (a) => ({ input: a.input }) },
  clearWorkflowSchedule: { action: 'workflow.unschedule', lookup: ['workflow', 'id'] },
  // Contexte : les personnes ici ; les agents dans contextRepository.addChange (outils context).
  createContextFolder: { action: 'context.folder_create', project: 'projectId', label: (a) => a.name, details: (a) => ({ agentId: a.agentId }) },
  renameContextFolder: { action: 'context.folder_rename', lookup: ['context_folder', 'id'], details: (a) => ({ name: a.name }) },
  moveContextFolder: { action: 'context.folder_move', lookup: ['context_folder', 'id'], details: (a) => ({ parentId: a.parentId }) },
  deleteContextFolder: { action: 'context.folder_delete', lookup: ['context_folder', 'id'] },
  createContextInstruction: { action: 'context.instruction_create', project: 'input.projectId', label: (a) => a.input?.name, details: (a) => ({ agentId: a.input?.agentId }) },
  updateContextInstruction: { action: 'context.instruction_update', lookup: ['context_instruction', 'id'], details: (a, r) => ({ version: r?.version, changeNote: a.input?.changeNote }) },
  deleteContextInstruction: { action: 'context.instruction_delete', lookup: ['context_instruction', 'id'] },
  restoreContextInstructionVersion: { action: 'context.instruction_restore', lookup: ['context_instruction', 'id'], details: (a) => ({ version: a.version }) },
  // Canaux de conversation (les messages restent dans leur fil).
  createConversation: { action: 'conversation.create', project: 'projectId', label: (a) => a.name },
  updateConversation: { action: 'conversation.update', lookup: ['conversation', 'id'], details: (a) => ({ name: a.name, topic: a.topic }) },
  setConversationArchived: { action: 'conversation.archive', lookup: ['conversation', 'id'], details: (a) => ({ archived: a.archived }) },
  // Pages partagées : publication et ouverture à d'autres.
  // Cockpit : agencements des tableaux de bord (le projet vient de result.projectId ; l'accueil d'une personne n'est pas inscrit).
  updateCockpitLayout: { action: 'cockpit.update', target: 'cockpit', targetId: (a) => a.scope, label: (a) => a.scope, details: (a, r) => ({ note: a.note ?? null, version: r?.version, blocks: Array.isArray(a.layout?.blocks) ? a.layout.blocks.length : null }) },
  resetCockpitLayout: { action: 'cockpit.reset', target: 'cockpit', targetId: (a) => a.scope, label: (a) => a.scope, details: (_a, r) => ({ version: r?.version }) },
  pinArtifactToCockpit: { action: 'cockpit.pin', target: 'cockpit', targetId: (a) => a.scope, label: (a) => a.scope, details: (a, r) => ({ artifactId: a.artifactId, region: a.region ?? null, version: r?.version }) },
  createProjectPage: { action: 'project_page.create', project: 'projectId', label: (a) => a.title, details: (a, r) => ({ slug: r?.slug, icon: a.icon ?? null }) },
  updateProjectPage: { action: 'project_page.update', lookup: ['project_page', 'id'], details: (a) => ({ title: a.title ?? null, icon: a.icon ?? null, position: a.position ?? null }) },
  deleteProjectPage: { action: 'project_page.delete', lookup: ['project_page', 'id'] },
  updateProjectTabs: { action: 'project.tabs', project: 'projectId', lookup: ['project', 'projectId'], details: (a) => ({ tabs: a.tabs }) },
  restoreCockpitLayout: { action: 'cockpit.restore', target: 'cockpit', targetId: (a) => a.scope, label: (a) => a.scope, details: (a, r) => ({ restored: a.version, version: r?.version }) },
  publishSharedPage: { action: 'page.publish', project: 'projectId', label: (a) => a.title, details: (a) => ({ path: a.path, pageId: a.pageId }) },
  updateSharedPage: { action: 'page.update', lookup: ['shared_page', 'id'], details: (a) => ({ input: a.input }) },
  addSharedPageMember: { action: 'page.share', lookup: ['shared_page', 'id'], details: (a) => ({ email: a.email, ...(a.invite ? { invite: true } : {}), ...(a.message ? { message: true } : {}), ...(a.notify === false ? { notify: false } : {}) }) },
  removeSharedPageMember: { action: 'page.unshare', lookup: ['shared_page', 'id'], details: (a) => ({ userId: a.userId }) },
  deleteSharedPage: { action: 'page.delete', lookup: ['shared_page', 'id'] },
  setSharedPageHistory: { action: 'page.history', lookup: ['shared_page', 'id'], details: (a) => ({ enabled: a.enabled }) },
  deleteAllSharedPageComments: { action: 'page.comments_purge', lookup: ['shared_page', 'id'] },
  refreshSharedPageData: { action: 'page.refresh', lookup: ['shared_page', 'id'] },
  duplicateSharedPage: { action: 'page.duplicate', lookup: ['shared_page', 'id'], details: (a, r) => ({ copyId: r?.id, title: r?.title, version: a.version ?? null }) },
  // Livraisons : la configuration du déploiement (livrer, déployer et annuler sont inscrits par deliveries/service.ts).
  setDeliveryPolicy: { action: 'delivery.policy', project: 'projectId', targetId: () => null, details: (a) => ({ rules: a.rules ?? [] }) },
  setDeployConfig: { action: 'delivery.config', project: 'projectId', targetId: () => null, details: (a) => ({ vaultItem: a.input?.vaultItem ?? null, command: a.input?.command ?? null, branch: a.input?.branch ?? null }) },
  setDeliveryQualitySettings: { action: 'delivery.quality_settings', project: 'projectId', targetId: () => null, details: (a) => ({ tags: a.tags ?? null, windowHours: a.windowHours ?? null, reset: Boolean(a.reset) }) },
  setTaskDelivery: { action: 'delivery.task_link', lookup: ['task', 'taskId'], details: (a) => ({ deliveryId: a.deliveryId ?? null, reset: Boolean(a.reset) }) },
  // Application (hors projet).
  inviteUser: { action: 'user.invite', app: true, targetId: (_a, r) => r?.id, label: (a) => a.email, details: (a) => ({ isAdmin: a.isAdmin }) },
  setUserAdmin: { action: 'user.admin', app: true, lookup: ['user', 'userId'], details: (a) => ({ isAdmin: a.isAdmin }) },
  setUserSuperAdmin: { action: 'user.super_admin', app: true, lookup: ['user', 'userId'], details: (a) => ({ isSuperAdmin: a.isSuperAdmin }) },
  setUserCto: { action: 'user.cto', app: true, lookup: ['user', 'userId'], details: (a) => ({ isCto: a.isCto }) },
  deleteUser: { action: 'user.delete', app: true, lookup: ['user', 'userId'] },
  // Jamais le lien lui-même (il ouvre le compte).
  createPasswordLink: { action: 'user.password_link', app: true, lookup: ['user', 'userId'], details: (a, r) => ({ emailed: Boolean(r?.emailed) }) },
  setMaintenanceMode: { action: 'app.maintenance', app: true, targetId: () => null, details: (a) => ({ enabled: a.enabled, message: a.message }) },
  updateServerSettings: { action: 'app.settings', app: true, targetId: () => null, details: (a) => a },
  setCellClaudeAccount: { action: 'app.claude_cell', app: true, targetId: () => null, details: (a) => ({ itemId: a.itemId ?? null }) },
  // Jamais le mot de passe dans les détails.
  updateMailSettings: { action: 'app.mail', app: true, targetId: () => null, details: (a) => ({ from: a.input?.from, apiKey: a.input?.apiKey ? 'modifiée' : 'inchangée' }) },
  clearMailSettings: { action: 'app.mail', app: true, targetId: () => null, details: () => ({ cleared: true }) },
  updateBillingSettings: { action: 'app.billing', app: true, targetId: () => null, details: (a) => ({ fields: keysOf(a.input) }) },
  addCtoTimeEntry: { action: 'app.cto_time_add', app: true, details: (a) => ({ input: a.input }) },
  deleteCtoTimeEntry: { action: 'app.cto_time_delete', app: true },
};

/** Mutations sensibles inscrites par leur service (les agents passent par les mêmes chemins) : voir tasks/service.ts. */
export const AUDITED_BY_SERVICE = new Set(['createTask', 'updateTask', 'deliver', 'requestDeploy', 'cancelDelivery']);

/**
 * Mutations sans trace, et pourquoi : réglages et comptes personnels, lectures déguisées (synchronisations, liens),
 * conversation (messages, commentaires, réactions : déjà nominatifs dans leur fil), préparation git sans effet
 * durable, terminaux et aperçus, édition de fichiers, notifications.
 */
export const NOT_AUDITED = new Set([
  // Fichiers : l'édition elle-même (le dépôt garde l'historique) ; renommage et suppression sont tracés.
  'writeWorkspaceFile', 'createWorkspaceEntry',
  // Contrôle sans effet : lance le navigateur headless du conteneur et rend son état.
  'testProjectBrowser',
  // Réglages et comptes personnels.
  'updateOnboarding',
  'connectChromeBrowser', 'removeChromeBrowser',
  'updateClaudeSettings', 'setClaudeApiKeyItem', 'setClaudeOauthItem', 'clearClaudeOauthToken', 'startClaudeLogin', 'completeClaudeLogin', 'cancelClaudeLogin', 'verifyClaudeAuth',
  'updateOpencodeSettings', 'setOpencodeKeyItem', 'refreshOpencodeModels',
  'startGithubDeviceLogin', 'pollGithubDeviceLogin', 'connectGithubFromVault', 'setDefaultGithubAccount', 'disconnectGithub',
  'startGitlabDeviceLogin', 'pollGitlabDeviceLogin', 'connectGitlabFromVault', 'setDefaultGitlabAccount', 'disconnectGitlab',
  'startAwsLogin', 'pollAwsLogin', 'testVaultItem',
  // Modes de connexion de la personne elle-même (journal du serveur).
  'setMyPassword', 'removeMyPassword', 'unlinkMyLoginIdentity',
  // Contrôle du navigateur headless d'un projet : lecture d'état, rien n'est modifié.
  'testProjectBrowser',
  'subscribePush', 'unsubscribePush', 'sendTestPush', 'setPushPreference', 'markNotificationRead', 'markAllNotificationsRead',
  // Envois de test, sans effet durable.
  'testNotificationChannel', 'sendTestEmail',
  // Espace personnel et instructions aux sessions (le transcript les garde).
  'createChat', 'sendSessionMessage',
  // Fils de discussion : nominatifs par nature.
  'addTaskComment', 'toggleTaskReaction', 'updateTaskComment', 'deleteTaskComment',
  // Commentaires des pages partagées : micro-conversations nominatives, comme les fils.
  'addSharedPageComment', 'replySharedPageComment', 'updateSharedPageComment', 'resolveSharedPageComment', 'deleteSharedPageComment',
  // Instruction à la session qui a publié une page (le transcript la garde, comme sendSessionMessage).
  'requestSharedPageUpdate',
  // Favoris : préférence personnelle d'affichage (sidebar).
  'setSharedPageFavorite',
  'postMessage', 'updateMessage', 'deleteMessage', 'toggleMessageReaction', 'markConversationRead',
  // Git sans effet durable, synchronisations et lectures.
  'gitStage', 'gitUnstage', 'gitFetch', 'backupHostedGit', 'syncPullRequests', 'watchPullRequests', 'backfillDeliveryQualityTasks',
  'prepareProjectWorkspace', 'shareWorksessionDeps',
  // Terminaux et aperçus.
  'closeTerminal', 'deleteTerminal', 'startPreview', 'stopPreview', 'previewAccessUrl',
]);

const actorOf = (ctx: AuthContext) => (ctx.user ? { userId: ctx.user.id, label: ctx.user.name || ctx.user.email } : null);

/** Projet, cible et libellé d'une mutation réussie ; null : rien à inscrire (hors projet). */
export function entryFor(spec: MutationAudit, args: Args, result: Result, before: TargetInfo | null): { projectId: string | null; targetId: string | null; targetLabel: string | null } | null {
  let projectId: string | null = null;
  if (!spec.app) {
    projectId = (spec.project ? arg(args, spec.project) : null) ?? (spec.projectFromResult ? result?.id : null) ?? before?.projectId ?? (result && typeof result === 'object' ? result.projectId : null) ?? null;
    if (!projectId) return null;
  }
  const lookupId = spec.lookup ? arg(args, spec.lookup[1]) : undefined;
  const resultId = result && typeof result === 'object' && typeof result.id === 'string' ? result.id : undefined;
  const targetId = spec.targetId ? spec.targetId(args, result) : (lookupId ?? resultId ?? args.id);
  const targetLabel = spec.label?.(args, result) ?? before?.label ?? (result && typeof result === 'object' ? (result.name ?? result.title) : null) ?? null;
  return { projectId: spec.detachProject ? null : projectId, targetId: targetId == null ? null : String(targetId), targetLabel: typeof targetLabel === 'string' ? targetLabel : null };
}

type Resolver = (parent: any, args: any, ctx: any, info?: any) => unknown;

/** Enveloppe les résolveurs de mutation inscrits dans AUDITED : une mutation réussie laisse une entrée au journal. */
export function withAudit<T extends Record<string, Resolver>>(mutations: T): T {
  const wrapped: Record<string, Resolver> = {};
  for (const [name, resolve] of Object.entries(mutations)) {
    const spec = AUDITED[name];
    if (!spec) {
      wrapped[name] = resolve;
      continue;
    }
    wrapped[name] = async (parent, args, ctx, info) => {
      const before = spec.lookup ? await lookupTarget(spec.lookup[0], arg(args, spec.lookup[1])).catch(() => null) : null;
      const result = await resolve(parent, args, ctx, info);
      const entry = entryFor(spec, args ?? {}, result, before);
      if (entry) {
        const details = spec.details?.(args ?? {}, result);
        await auditService.record({
          ...entry,
          actor: actorOf(ctx),
          action: spec.action,
          targetType: spec.target ?? spec.action.split('.')[0],
          details: spec.detachProject ? { ...details, projectId: before?.projectId ?? arg(args, 'id') } : details,
        });
      }
      return result;
    };
  }
  return wrapped as T;
}
