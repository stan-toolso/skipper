import {
  AbortError,
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { access, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../config.js';
import { createProjectsMcpServer } from '../../personal/mcp.js';
import { isPersonalProject, type Project } from '../../projects/types.js';
import { personalService } from '../../personal/service.js';
import { userService } from '../../users/service.js';
import { createContextMcpServer } from '../../context/mcp.js';
import { contextService } from '../../context/service.js';
import { materializeSkills } from '../../context/skills.js';
import { AppError } from '../../errors.js';
import { liveBrowserService } from '../../browser/live.js';
import { BROWSER_FIELD_READERS, browserPrompt, explainBrowserFailure } from '../../browser/check.js';
import { createGoogleMcpServer } from '../../google/mcp.js';
import { googleAccountService, googleReadTools } from '../../google/service.js';
import { permissionRuleService, suggestedMode, withEditedRules } from '../../permissions/service.js';
import { formatRule, type PermissionRule } from '../../permissions/types.js';
import { activeScheduleRules } from '../../schedules/activeRules.js';
import { scheduleAllows, scheduleAllowsVault } from '../../schedules/permissions.js';
import { createSharedPagesMcpServer, sharedPagesPrompt } from '../../sharedPages/mcp.js';
import { COCKPIT_FREE_TOOLS, cockpitPromptSummary, createCockpitMcpServer } from '../../cockpit/mcp.js';
import { SCHEDULES_FREE_TOOLS, createSchedulesMcpServer, schedulesPromptSummary } from '../../schedules/mcp.js';
import { previewPrompt } from '../../previews/config.js';
import { createPreviewMcpServer, previewMcpPrompt } from '../../previews/mcp.js';
import { CHROME_FREE_TOOLS, chromePromptSummary, createChromeMcpServer } from '../../chrome/mcp.js';
import { chromeBrowserService } from '../../chrome/service.js';
import { previewsEnabled } from '../../previews/hosts.js';
import { createVaultMcpServer, type VaultApproval } from '../../vault/mcp.js';
import type { CreateRequestInput } from '../../requests/types.js';
import { vaultService } from '../../vault/service.js';
import { sessionIdentityPrompt } from '../identity.js';
import { RequestCancelledError } from '../../requests/service.js';
import { runner } from '../../runners/index.js';
import { agentGitEnv } from '../../git/agentEnv.js';
import { gitServer } from '../../gitServer/service.js';
import { sessionMergeApprover } from '../../pullRequests/mergeApproval.js';
import { createTasksMcpServer, TASKS_FREE_TOOLS } from '../../tasks/mcp.js';
import { CONVERSATIONS_FREE_TOOLS, conversationsMcpPrompt, createConversationsMcpServer } from '../../conversations/mcp.js';
import { conversationService, linkedThreadsPrompt } from '../../conversations/service.js';
import { trackedPullRequestService } from '../../pullRequests/service.js';
import { syncAfterTool, toolSyncUser } from '../../pullRequests/toolTrigger.js';
import { taskService } from '../../tasks/service.js';
import { createWorksessionsMcpServer } from '../../worksessions/mcp.js';
import { createEnvMcpServer } from '../../envFiles/mcp.js';
import { envFileService } from '../../envFiles/service.js';
import { archivePromptSummary, createSessionsMcpServer, sessionsPromptSummary } from '../mcp.js';
import { archivesWhenIdle } from '../autoArchive.js';
import { claudeSettings, cliEnv } from '../../settings/claude.js';
import { usageService } from '../../settings/usage.js';
import { sessionBillable } from '../../billing/billable.js';
import { projectBudget } from '../../projects/budget.js';
import { describeRejection, rateLimitService } from '../../settings/rateLimits.js';
import type { PermissionResponse, QuestionResponse } from '../../requests/types.js';
import { attachmentsNote, inlineBlocks, publicAttachment } from '../attachments.js';
import type { Attachment } from '../types.js';
import type { DescribeContext, ProviderDescription, RunContext, RunningHandle, RunResult, SessionProvider } from './provider.js';
import { isNoise } from './claudeNoise.js';
import { BackgroundHold, describeBackgroundTasks } from './backgroundTasks.js';
import { SubagentRecorder, SubagentTracker, backgroundCommands, describeBackgroundCommands, type TaskMessageLike } from './subagents.js';
import { assistantText, selfTurnNotice, wakeTrigger } from './selfTurn.js';
import { conversationJournalPath, missedMessages, readJournal, readSubagentEntries } from './cliJournal.js';
import { isEmptyNotificationResult, isLastResultEcho, resultError } from './claudeResult.js';
import { liveDraftService } from '../live.js';
import { SESSION_ENV } from '../../runners/stats.js';
import { log } from '../../log.js';
import { failedMcpServers, mcpFailureNotice, readMcpLogDetail } from '../mcpFailures.js';
import { REVIEW_ALLOWED_TOOLS, REVIEW_DISALLOWED_TOOLS, REVIEW_SYSTEM_PROMPT, REVIEW_TOOLS, reviewOf } from '../../reviews/types.js';
import { agentService } from '../../agents/service.js';
import { agentIdentityPrompt, agentsPromptSummary, scopedAgentsPromptSummary } from '../../agents/prompt.js';
import { AGENTS_FREE_TOOLS, agentsMcpPrompt, createAgentsMcpServer } from '../../agents/mcp.js';
import { userRepository } from '../../users/repository.js';
import { authorHeader, type InstructionAuthor } from '../instructionAuthor.js';

interface ClaudeConfig {
  model?: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string;
}

/** Liste d'outils pré-autorisés d'une session (« Read,Bash(git:*) »). */
export const splitAllowedTools = (value: unknown): string[] =>
  value ? String(value).split(',').map((t) => t.trim()).filter(Boolean) : [];

/** Numéro de la dernière exécution lancée par session (le rapprochement de fin d'une exécution s'efface devant la suivante). */
const runGenerations = new Map<string, number>();
/** Attente du `cost-state` de sortie : fin ordinaire, puis flux coupé alors que du travail restait (sous-agents orphelins). */
const AFTER_EXIT_MS = 60_000;
const AFTER_EXIT_PENDING_MS = 30 * 60_000;

const permissionModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];

/**
 * Dossier de configuration Claude Code des chats d'un espace personnel, sur le serveur (les chats ne passent pas par
 * un conteneur) : leurs conversations y sont rangées et reprises, à l'écart du compte du serveur (`~/.claude`).
 */
export const chatConfigDir = (project: Pick<Project, 'slug'>): string => path.join(config.workspacesRoot, '.runners', project.slug, 'chat-home');

/**
 * File de messages utilisateur consommée par le SDK en mode "streaming input" :
 * la session reste ouverte tant que la file n'est pas fermée, ce qui permet
 * d'envoyer de nouvelles instructions à tout moment.
 */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(content: SDKUserMessage['message']['content']): void {
    if (this.closed) throw new AppError("La session n'accepte plus d'instructions");
    this.buffer.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    this.waiter?.();
  }

  /** File fermée : plus aucune instruction n'est acceptée. */
  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.buffer.length) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = null;
    }
  }
}

/**
 * Provider Claude Code, basé sur le Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 * `query()` pilote le harnais Claude Code et renvoie un flux de messages typés,
 * chacun étant journalisé comme événement `claude.<type>` de la session.
 */
export class ClaudeProvider implements SessionProvider {
  readonly type = 'claude';

  describe(ctx: DescribeContext = {}): ProviderDescription {
    const user = ctx.claude ?? null;
    const defaultModel = user?.settings.defaultModel ?? null;
    const models = user ? user.selectableModels() : [];
    return {
      type: this.type,
      label: 'Claude Code',
      description: 'Session Claude Code interactive (Agent SDK) : envoyez des instructions à tout moment.',
      interactive: true,
      configFields: [
        {
          key: 'permissionMode',
          label: 'Autorisations',
          type: 'select',
          required: false,
          defaultValue: 'default',
          description: "Ce que l'agent peut faire sans vous demander.",
          options: [
            { value: 'default', label: 'Me demander avant chaque action sensible', description: 'Chaque modification de fichier ou commande vous est soumise (recommandé).' },
            { value: 'acceptEdits', label: 'Modifier les fichiers librement', description: 'Les modifications de fichiers sont autorisées ; les commandes restent soumises.' },
            { value: 'plan', label: 'Réfléchir seulement, sans rien modifier', description: "L'agent analyse et propose un plan, sans toucher aux fichiers." },
            { value: 'dontAsk', label: 'Refuser sans demander', description: "Les actions non autorisées d'avance sont refusées ; aucune demande ne vous sera faite. Pour ne plus être dérangé, préférez « Modifier les fichiers librement » ou « Tout autoriser »." },
            { value: 'bypassPermissions', label: 'Tout autoriser (risqué)', description: "L'agent agit sans aucune confirmation." },
          ],
        },
        {
          key: 'model',
          label: 'Modèle',
          type: 'select',
          required: false,
          advanced: true,
          defaultValue: defaultModel ?? '',
          description: 'Les modèles proposés et votre choix par défaut se règlent dans Paramètres → Claude.',
          options: [
            { value: '', label: defaultModel ? `Mon modèle par défaut (${defaultModel})` : 'Modèle par défaut de Claude Code' },
            ...models.map((m) => ({ value: m.value, label: m.displayName, description: m.description || undefined })),
          ],
        },
        { key: 'maxTurns', label: 'Nombre maximum d\'étapes', type: 'number', required: false, advanced: true, description: "Arrête l'agent au-delà de ce nombre d'échanges avec le modèle." },
        { key: 'maxBudgetUsd', label: 'Budget maximum (USD)', type: 'number', required: false, advanced: true },
        { key: 'allowedTools', label: 'Outils pré-autorisés', type: 'string', required: false, advanced: true, description: 'Liste séparée par des virgules, ex. "Read,Edit,Bash(git:*)"' },
      ],
    };
  }

  validateConfig(raw: Record<string, unknown>): void {
    const cfg = raw as ClaudeConfig;
    if (cfg.maxTurns !== undefined && (!Number.isInteger(Number(cfg.maxTurns)) || Number(cfg.maxTurns) <= 0)) {
      throw new AppError('maxTurns doit être un entier positif');
    }
    if (cfg.maxBudgetUsd !== undefined && (Number.isNaN(Number(cfg.maxBudgetUsd)) || Number(cfg.maxBudgetUsd) <= 0)) {
      throw new AppError('maxBudgetUsd doit être un nombre positif');
    }
    if (cfg.permissionMode !== undefined && !permissionModes.includes(cfg.permissionMode)) {
      throw new AppError(`permissionMode invalide : ${String(cfg.permissionMode)}`);
    }
    // Le modèle est contrôlé au démarrage, contre les réglages du propriétaire de la session.
  }

  async start(ctx: RunContext): Promise<RunningHandle> {
    const cfg = ctx.session.config as ClaudeConfig;
    if (!ctx.initialMessage) throw new AppError('Une session Claude nécessite une première instruction');

    // Réglages du PROPRIÉTAIRE de la session : identifiants (coffre), modèle par défaut, budgets, plafond mensuel. Pour un
    // agent de projet, les comptes qu'une personne lui a prêtés (délégation) remplacent les siens.
    const ownerId = ctx.session.ownerId;
    // Personne qui a pris la main sur la session d'un agent : ses comptes et ses droits (coffre, comptes Google) servent la
    // session à la place de ceux de l'agent ; l'agent reste le propriétaire (identité, coût, bibliothèque).
    const rightsHolderId = ctx.session.takenOverById ?? ownerId;
    const accounts = await agentService.accountsForSession(ctx.session);
    const owner = await claudeSettings.forSession(accounts?.claudeUserId ?? null);
    owner.assertCredentials();
    await owner.assertBudgetAvailable();
    await projectBudget.assertAvailable(ctx.project.id);
    const general = owner.settings;
    // Modèle courant : modifiable en cours de session (updateConfig), d'où la variable.
    let model = cfg.model ? String(cfg.model) : general.defaultModel ?? undefined;
    owner.assertModelAllowed(model);
    // Chat : session légère d'un espace personnel, sans conteneur ni dossier de travail ; le CLI tourne sur le serveur
    // sans outil de fichiers ni de commande, seulement les outils MCP de Skipper.
    const chat = ctx.session.kind === 'chat';
    // Session de relecture (reviews/) : lecture seule. Outils intégrés réduits à Read, Grep et Glob, contexte en lecture,
    // mode dontAsk (tout outil non pré-autorisé est refusé sans demander), ni coffre, ni tâches, ni navigateur, ni
    // réglages ou hooks lus dans le dépôt : elle ne peut modifier aucun fichier.
    const review = !chat && reviewOf(ctx.session) !== null;
    // Session d'un espace personnel : portée sur tous les projets de la personne (outils sessions, tasks, worksessions, projects).
    const scope = personalService.scopeFor(ctx.project, ownerId);
    // Session jouée par un agent de projet (propriétaire agent) : son identité et ses instructions ouvrent le prompt système,
    // ses messages dans les fils de tâches sont signés de son nom. Les autres agents du projet sont présentés à toute session.
    const agent = chat || review ? null : await agentService.forUser(ownerId);
    const requestedBy = agent && ctx.session.requestedById ? await userRepository.findById(ctx.session.requestedById) : null;
    const takenOverBy = agent && ctx.session.takenOverById ? await userRepository.findById(ctx.session.takenOverById) : null;
    const projectAgents = chat || review || isPersonalProject(ctx.project) ? [] : await agentService.listByProject(ctx.project.id);
    // Canaux de conversation d'équipe du projet (serveur MCP `conversations`) ; un espace personnel n'en a pas.
    const channels = chat || review || isPersonalProject(ctx.project) ? [] : await conversationService.list(ctx.project.id);
    // Bibliothèques de contexte : celle du projet (sauf pour un agent qui n'en hérite pas), la bibliothèque propre d'un agent
    // qui joue la session (cible par défaut de ses outils `context`), et celles des autres agents (paramètre `library`).
    const agentLibraries = projectAgents.map((a) => ({ id: a.id, name: a.name }));
    const projectContext = !agent || agent.inheritContext;
    // Chat ou session d'un espace personnel : les agents de tous les projets de la personne, à qui elle peut s'adresser.
    const scopeProjects = scope && !review ? await scope.projects() : [];
    const scopedAgents = scopeProjects.length ? await agentService.listActive(scopeProjects.map((p) => p.id)) : [];
    const actor = { sessionId: ctx.session.id, projectId: ctx.project.id };
    const credentials = await owner.credentialEnv(general.authMode, actor);
    // Les tours de cette exécution comptent-ils dans la consommation (crédits) ? Compte de la cellule ou d'un CTO Skipper
    // seulement, quand la cellule facture en crédits (billing/billable.ts).
    const billable = await sessionBillable(accounts?.claudeUserId ?? null, owner.usesCellAccount(general.authMode)).catch((err) => {
      log.error('[usage] facturation de la session indéterminée, tours comptés', err);
      return true;
    });
    // Un chat reçoit l'environnement du serveur sans ses secrets Anthropic (comme la vérification des identifiants), un dossier
    // de configuration propre à l'espace (conversations reprises) et aucune variable git ; une session, ses seuls identifiants.
    const env: Record<string, string | undefined> = chat
      ? { ...cliEnv(credentials), CLAUDE_CONFIG_DIR: chatConfigDir(ctx.project), [SESSION_ENV]: ctx.session.id }
      : { ...credentials, ...(await agentGitEnv(accounts, ctx.project.gitUrl, actor)), [SESSION_ENV]: ctx.session.id };
    if (chat) await mkdir(chatConfigDir(ctx.project), { recursive: true });
    // Script de relais qui exécute le CLI dans le conteneur du projet (avant le navigateur : rien à nettoyer s'il échoue) ;
    // un chat utilise le CLI du serveur (CLAUDE_BIN, sinon celui du SDK), comme la vérification des identifiants.
    const claudeExecutable = chat ? config.claudeBin : await runner.claudeExecutable(ctx.project, ctx.cwd);

    const abortController = new AbortController();
    // Option « navigateur » du projet : un serveur MCP Playwright (Chromium headless) dans le conteneur du projet.
    const browserEnabled = !chat && !review && Boolean((ctx.project.runnerConfig as { browser?: boolean } | null)?.browser);
    // Portée du coffre pour cette session : éléments du projet, reliés au projet, reliés par le propriétaire pour ses sessions.
    const vaultItems = review ? [] : await vaultService.agentItems(ctx.project.id, rightsHolderId);
    // Le serveur `vault` est toujours offert (hors relecture) : même sans élément, l'agent peut demander des secrets (request_secrets).
    const vaultBrowser = vaultItems.some((i) => i.kind === 'website' || i.kind === 'secret');
    // Comptes Google de la portée (Gmail, Drive) : serveur MCP `google`, lectures libres, écritures soumises à autorisation.
    const googleAccounts = review ? [] : await googleAccountService.accountsFor(ctx.project.id, rightsHolderId);
    // Aperçu en direct de la branche (serveur MCP `preview`) : sessions qui ont un dossier de travail, aperçus activés.
    const previewWorksession = !chat && !review && previewsEnabled() ? ctx.session.worksessionId : null;
    // Navigateur Chrome de la personne qui pilote la session (extension « Skipper pour Chrome ») : proposé dès qu'elle a
    // relié un navigateur ; chaque commande vérifie qu'il est connecté. Pour un agent : la personne qui a pris la main,
    // sinon celle qui l'a convoqué.
    const chromeUserId = review ? null : ctx.session.takenOverById ?? (agent ? ctx.session.requestedById ?? null : ownerId);
    const chromeUser = chromeUserId && (await chromeBrowserService.hasAny(chromeUserId)) ? await userRepository.findById(chromeUserId) : null;
    // Prompt système : celui du projet, l'identité de la session, puis la bibliothèque de contexte, les tâches, le coffre et les comptes Google.
    const systemPrompt = (review
      ? [ctx.project.systemPrompt.trim(), sessionIdentityPrompt(ctx.session, ctx.project), await contextService.promptSummary(ctx.project.id), REVIEW_SYSTEM_PROMPT]
      : [
        ctx.project.systemPrompt.trim(),
        agent ? agentIdentityPrompt(agent, ctx.project, requestedBy, accounts ?? {}, takenOverBy) : '',
        sessionIdentityPrompt(ctx.session, ctx.project),
        projectAgents.length ? [agentsPromptSummary(projectAgents, agent), agentsMcpPrompt()].filter(Boolean).join('\n') : '',
        scope ? await personalService.promptSummary(scope, await userService.get(scope.ownerId)) : '',
        scopedAgents.length ? [scopedAgentsPromptSummary(scopedAgents, scopeProjects), agentsMcpPrompt({ scoped: true })].join('\n') : '',
        agent ? await contextService.promptSummary(ctx.project.id, agent.id, { own: true }) : '',
        projectContext ? await contextService.promptSummary(ctx.project.id) : "Tu n'hérites pas de la bibliothèque de contexte du projet : seule la tienne t'est transmise (la bibliothèque « projet » reste lisible avec l'outil `context`, paramètre `library: \"projet\"`).",
        agentLibraries.filter((l) => l.id !== agent?.id).length ? `Les autres agents du projet ont chacun leur bibliothèque de contexte, lisible et modifiable avec les outils \`context\` (paramètre \`library\` : ${agentLibraries.filter((l) => l.id !== agent?.id).map((l) => `« ${l.name} »`).join(', ')}).` : '',
        await taskService.linkedTaskPrompt(ctx.session.id),
        await taskService.promptSummary(ctx.project.id, ctx.session.id),
        scope ? conversationsMcpPrompt([], { scoped: true }) : channels.length ? [conversationsMcpPrompt(channels), await linkedThreadsPrompt(ctx.session.id)].filter(Boolean).join('\n\n') : '',
        ctx.project.gitUrl && !chat ? trackedPullRequestService.promptSummary() : '',
        chat ? '' : gitServer.promptSummary(ctx.project),
        vaultService.promptSummary(vaultItems, ctx.project),
        chat ? '' : await envFileService.promptSummary(ctx.project.id),
        sessionsPromptSummary(ctx.project, { chat }),
        archivePromptSummary({ agent: Boolean(agent), child: Boolean(ctx.session.parentSessionId), auto: archivesWhenIdle(ctx.session) }),
        googleAccountService.promptSummary(googleAccounts),
        chat ? '' : sharedPagesPrompt(),
        cockpitPromptSummary(),
        scope ? '' : schedulesPromptSummary(),
        ctx.session.worksessionId && !chat ? previewPrompt(previewsEnabled(), ctx.session.worksessionId) : '',
        previewWorksession ? previewMcpPrompt() : '',
        chromeUser ? chromePromptSummary(chromeUser.name) : '',
      ]
    )
      .filter(Boolean)
      .join('\n\n');
    // La bibliothèque de contexte est exposée deux fois : outils MCP (lecture/écriture) et skills (plugin local). Un chat n'a
    // pas l'outil Skill (aucun outil intégré) : il lit le contexte par les outils MCP.
    const pluginDir = chat || review || !projectContext ? null : await materializeSkills(ctx.project);
    const agentPluginDir = chat || review || !agent ? null : await materializeSkills(ctx.project, agent.id);
    const allowedTools = splitAllowedTools(cfg.allowedTools);
    // Outils pré-autorisés ajoutés en cours de session (« Autoriser cet outil pour la session » du transcript) : le CLI
    // ne relit pas allowedTools à chaud, le hook PreToolUse les applique (sa décision passe avant le mode, y compris
    // « Refuser sans demander »). Au prochain lancement, ils rejoignent allowedTools.
    let liveAllowed: string[] = [];
    // Autorisations mémorisées pour le projet (« ne plus demander dans ce projet »).
    const projectRules = await permissionRuleService.list(ctx.project.id);
    const ruleUsage: RuleUsage = { rules: projectRules, asked: new Set(), pending: new Map() };
    // Le navigateur ne reçoit aucun secret à l'avance : le coffre les saisit à la demande (browser_fill).
    let browserServer: Awaited<ReturnType<typeof runner.browserMcpCommand>> | null = null;
    // Navigateur qui ne démarre pas : la session part sans lui, avec la raison dans le transcript et dans le prompt
    // (sinon l'agent passe des tours à tenter d'installer Chromium lui-même).
    let browserUnavailable: string | null = null;
    if (browserEnabled) {
      try {
        browserServer = await runner.browserMcpCommand(ctx.project, ctx.cwd, { sessionId: ctx.session.id });
        // Vue en direct du navigateur dans l'interface (le backend s'y attache par CDP quand quelqu'un regarde).
        liveBrowserService.register(ctx.session.id, ctx.project, browserServer.cdp);
      } catch (err) {
        browserUnavailable = await explainBrowserFailure(ctx.project, (err as Error).message);
        log.warn(`[browser] session ${ctx.session.id} : ${browserUnavailable}`);
        await ctx.emit('system', { notice: true, browser: true, message: `Navigateur headless indisponible pour cette session : ${browserUnavailable}` });
      }
    }
    const fullSystemPrompt = browserEnabled ? [systemPrompt, browserPrompt({ prefix: 'mcp__playwright__', fill: 'browser_fill', unavailable: browserUnavailable })].join('\n\n') : systemPrompt;
    // Approbations mémorisées « pour la session » sur les éléments du coffre (outil|clé).
    const vaultApprovals = new Set<string>();
    const vaultContext = {
      project: ctx.project,
      sessionId: ctx.session.id,
      ownerId: rightsHolderId,
      cwd: ctx.cwd,
      emit: ctx.emit,
      remembered: async (toolName: string, key: string, projectRules: boolean) => {
        if (vaultApprovals.has(`${toolName}|${key.toLowerCase()}`)) return true;
        // Pré-autorisé pour les exécutions de la planification (pendant l'une d'elles seulement).
        const scheduled = await activeScheduleRules(ctx.session.id);
        if (scheduled && scheduleAllowsVault(scheduled, toolName, key)) {
          await this.noteScheduleAllowed(ctx, `${toolName}(${key})`);
          return true;
        }
        return projectRules && ruleUsage.rules.some((r) => r.toolName === toolName && r.ruleContent?.trim().toLowerCase() === key.toLowerCase());
      },
      approve: (approval: VaultApproval) => this.approveVaultUse(ctx, ruleUsage, vaultApprovals, approval),
      // Saisie de secrets par une personne (request_secrets) : une demande ordinaire, réglée par la mutation provideSecrets.
      ask: (input: CreateRequestInput) => ctx.ask(input),
    };
    const disposeAll = async () => {
      if (browserServer) liveBrowserService.unregister(ctx.session.id);
      await browserServer?.dispose().catch((e) => log.error('[browser] arrêt du navigateur de la session', e));
    };
    // Les observations (instantané, capture, console, réseau, attente) sont libres ; les actions passent par les demandes d'autorisation.
    const browserReadTools = ['mcp__playwright__browser_snapshot', 'mcp__playwright__browser_take_screenshot', 'mcp__playwright__browser_console_messages', 'mcp__playwright__browser_network_requests', 'mcp__playwright__browser_wait_for'];
    // Notes discrètes (`notify` : changements des tâches reliées qui ne s'adressent pas à l'agent) en attente d'être
    // remises : avec le résultat du prochain lot d'outils du fil principal (hook PostToolBatch), sinon avec la prochaine
    // instruction. Aucune ne lui ouvre de tour.
    const notes: string[] = [];
    const takeNotes = () => (notes.length ? notes.splice(0).join('\n\n') : null);

    // Exécution courante de la session : le rapprochement de fin d'une exécution précédente s'efface devant elle.
    const generation = (runGenerations.get(ctx.session.id) ?? 0) + 1;
    runGenerations.set(ctx.session.id, generation);
    // Reprise de la conversation Claude si la session a déjà tourné et que le CLI la retrouve encore.
    const resumeId = await this.resumableConversation(ctx);
    // Journal de la conversation (cliJournal.ts) : coût laissé par le processus précédent, puis rapprochement en fin d'exécution.
    const configDir = chat ? chatConfigDir(ctx.project) : runner.claudeConfigHostDir(ctx.project);
    const journal = configDir && resumeId ? conversationJournalPath(configDir, ctx.cwd, resumeId) : null;
    const costStatesAtStart = await this.reconcileAtStart(ctx, journal, Boolean(resumeId), model ?? 'default', billable);
    const options: Options = {
      cwd: ctx.cwd,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: fullSystemPrompt },
      mcpServers: review ? { context: createContextMcpServer(ctx.project, ctx.session.id) } : {
        context: createContextMcpServer(ctx.project, ctx.session.id, { agentLibraries, defaultAgentId: agent?.id ?? null }),
        tasks: createTasksMcpServer(ctx.project, ctx.session.id, agent ? agent.name : ctx.session.name, scope, { approveMerge: sessionMergeApprover(ctx) }),
        ...(scope || channels.length ? { conversations: createConversationsMcpServer(ctx.project, ctx.session.id, agent ? agent.name : ctx.session.name, scope) } : {}),
        ...(projectAgents.length ? { agents: createAgentsMcpServer(ctx.project, ctx.session.id) } : {}),
        ...(scopedAgents.length ? { agents: createAgentsMcpServer(ctx.project, ctx.session.id, scope) } : {}),
        vault: createVaultMcpServer(vaultContext),
        worksessions: createWorksessionsMcpServer(ctx.project, ctx.session.id, scope),
        sessions: createSessionsMcpServer(ctx.project, ctx.session.id, scope),
        // Fichiers d'environnement du projet : un chat n'a pas de dossier de travail où les écrire.
        ...(chat ? {} : { env: createEnvMcpServer({ project: ctx.project, sessionId: ctx.session.id, ownerId: rightsHolderId, worksessionId: ctx.session.worksessionId ?? null }) }),
        // Espace personnel : la liste des projets de la personne (lecture seule).
        ...(scope ? { projects: createProjectsMcpServer(scope) } : {}),
        // Un chat n'a pas de dossier de travail : rien à publier.
        ...(chat ? {} : { pages: createSharedPagesMcpServer({ project: ctx.project, session: ctx.session, cwd: ctx.cwd }) }),
        // Cockpit : agencements des tableaux de bord, au nom du propriétaire de la session (lecture libre, écriture sous autorisation).
        ...(ownerId ? { cockpit: createCockpitMcpServer({ project: ctx.project, sessionId: ctx.session.id, userId: ownerId }) } : {}),
        // Planifications du projet (hors espace personnel) : lecture libre, écritures sous autorisation, droits de la personne qui pilote.
        ...(ownerId && !scope ? { schedules: createSchedulesMcpServer({ project: ctx.project, sessionId: ctx.session.id, ownerId, requestedById: ctx.session.requestedById ?? null, rightsHolderId }) } : {}),
        ...(previewWorksession ? { preview: createPreviewMcpServer({ worksessionId: previewWorksession, ownerId }) } : {}),
        ...(chromeUser ? { chrome: createChromeMcpServer({ userId: chromeUser.id, sessionId: ctx.session.id, sessionName: ctx.session.name }) } : {}),
        ...(googleAccounts.length ? { google: createGoogleMcpServer({ project: ctx.project, accounts: googleAccounts, sessionId: ctx.session.id, cwd: ctx.cwd, emit: ctx.emit }) } : {}),
        // Le serveur hérite de l'environnement du CLI (dans le conteneur). La configuration MCP passe sur la ligne
        // de commande du CLI, visible de tout utilisateur du serveur (ps) : l'environnement du backend n'y figure jamais.
        ...(browserServer ? { playwright: { type: 'stdio' as const, command: browserServer.command, args: browserServer.args, ...(browserServer.env ? { env: browserServer.env } : {}) } } : {}),
      },
      plugins: [...(pluginDir ? [{ type: 'local' as const, path: pluginDir, skipMcpDiscovery: true }] : []), ...(agentPluginDir ? [{ type: 'local' as const, path: agentPluginDir, skipMcpDiscovery: true }] : [])],
      // Chat : aucun outil intégré (ni fichiers, ni commandes, ni web) et aucun réglage lu sur le disque du serveur.
      ...(chat ? { tools: [], settingSources: [] } : {}),
      ...(review ? { tools: REVIEW_TOOLS, settingSources: [] } : {}),
      model,
      // Le CLI refuse un repli identique au modèle principal : le repli est alors simplement omis.
      fallbackModel: general.fallbackModel && general.fallbackModel !== model ? general.fallbackModel : undefined,
      env,
      permissionMode: review ? 'dontAsk' : cfg.permissionMode || 'default',
      // Garde-fou du SDK : le mode bypassPermissions doit être explicitement assumé. Toujours vrai ici, car il rend
      // ce mode *disponible* sans l'activer (drapeau --allow-dangerously-skip-permissions du CLI) : c'est la
      // condition pour pouvoir y passer en cours de session (setPermissionMode), choix explicite de l'humain.
      allowDangerouslySkipPermissions: !review,
      maxTurns: cfg.maxTurns ? Number(cfg.maxTurns) : general.defaultMaxTurns ?? undefined,
      maxBudgetUsd: cfg.maxBudgetUsd ? Number(cfg.maxBudgetUsd) : general.sessionBudgetUsd ?? undefined,
      // Les outils du contexte et des tâches sont toujours autorisés : leurs effets restent dans la base et sont versionnés.
      // Les outils du coffre portent leur propre porte d'approbation (élément « avec approbation » : un humain
      // confirme chaque usage, quel que soit le mode d'autorisation) : le SDK ne redemande pas.
      // Worksessions : lister et créer sont libres (réversible, sans coût) ; supprimer est soumis à autorisation.
      // Sessions : consulter, attendre et terminer ses propres sessions sont libres ; lancer une session ou lui
      // envoyer une instruction consomme du budget et passe par l'autorisation habituelle.
      // Pages partagées : lister est libre ; publier passe par l'autorisation quand la page est exposée à d'autres.
      // Fichiers d'environnement : libres (modèles du projet en base, écriture dans le seul dossier de travail ; une valeur
      // du coffre n'y arrive que si l'élément le permet, choix de qui le gère).
      // Aperçu : libre (le même bouton que l'onglet « Aperçu », dans le conteneur du projet, sans coût ni effet extérieur).
      allowedTools: review ? REVIEW_ALLOWED_TOOLS : [...allowedTools, ...projectRules.map(formatRule), 'mcp__context', ...TASKS_FREE_TOOLS, ...CONVERSATIONS_FREE_TOOLS, 'mcp__vault', 'mcp__worksessions__list', 'mcp__worksessions__create', 'mcp__sessions__list', 'mcp__sessions__get', 'mcp__sessions__wait', 'mcp__sessions__end', 'mcp__sessions__archive', 'mcp__pages__list', 'mcp__pages__comments', 'mcp__pages__reply', 'mcp__pages__resolve', 'mcp__pages__data', 'mcp__pages__refresh', 'mcp__pages__duplicate', 'mcp__pages__set_data', ...COCKPIT_FREE_TOOLS, ...SCHEDULES_FREE_TOOLS, 'mcp__projects', ...AGENTS_FREE_TOOLS, ...(chat ? [] : ['mcp__env']), ...(previewWorksession ? ['mcp__preview'] : []), ...(chromeUser ? CHROME_FREE_TOOLS : []), ...(browserServer ? browserReadTools : []), ...(googleAccounts.length ? googleReadTools(googleAccounts) : [])],
      ...(review ? { disallowedTools: REVIEW_DISALLOWED_TOOLS } : {}),
      // Le coffre saisit des secrets dans le navigateur : les outils qui pourraient relire la valeur sont retirés à l'agent.
      ...(browserServer && vaultBrowser ? { disallowedTools: BROWSER_FIELD_READERS.map((t) => `mcp__playwright__${t}`) } : {}),
      resume: resumeId ?? undefined,
      pathToClaudeCodeExecutable: claudeExecutable,
      // Événements de streaming de l'API (texte au fil de l'eau) : jamais journalisés, ils alimentent le brouillon
      // en direct de la session (liveDraftService) que l'interface affiche en attendant le message complet.
      includePartialMessages: true,
      abortController,
      stderr: (data) => void ctx.emit('stderr', { text: data.trimEnd() }),
      // Les demandes de permission (et l'outil AskUserQuestion) deviennent des demandes d'intervention humaine.
      // Relecture : aucune demande d'autorisation, tout outil hors de la liste est refusé.
      hooks: review
        ? undefined
        : {
            // Outils pré-autorisés de la planification : appliqués aux seuls tours qu'elle lance, y compris en mode
            // « Refuser sans demander » (le SDK n'y appelle pas canUseTool ; la décision d'un hook passe avant le mode).
            PreToolUse: [
              {
                hooks: [
                  async (input) => {
                    const { tool_name: toolName, tool_input: toolInput } = input as { tool_name?: string; tool_input?: Record<string, unknown> };
                    if (!toolName) return {};
                    if (liveAllowed.length && scheduleAllows(liveAllowed, toolName, toolInput ?? {}, ctx.cwd)) {
                      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: 'Autorisé pour la session' } };
                    }
                    const rules = await activeScheduleRules(ctx.session.id);
                    if (!rules || !scheduleAllows(rules, toolName, toolInput ?? {}, ctx.cwd)) return {};
                    await this.noteScheduleAllowed(ctx, toolName);
                    return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: 'Pré-autorisé pour les exécutions de la planification' } };
                  },
                ],
              },
            ],
            PostToolBatch: [
              {
                hooks: [
                  async (input) => {
                    // Outils d'un sous-agent : la note attend le fil principal, qui a le contexte de la tâche.
                    if ((input as { agent_id?: string }).agent_id) return {};
                    const additionalContext = takeNotes();
                    return additionalContext ? { hookSpecificOutput: { hookEventName: 'PostToolBatch' as const, additionalContext } } : {};
                  },
                ],
              },
            ],
          },
      canUseTool: review ? async (toolName, _input, options) => ({ behavior: 'deny', message: `Session de relecture en lecture seule : l'outil ${toolName} n'est pas disponible`, toolUseID: options.toolUseID }) : this.canUseTool(ctx, ruleUsage),
    };

    await ctx.emit('system', {
      message: `Lancement via Claude Agent SDK${options.resume ? ` (reprise de ${options.resume})` : ''}`,
      options: { cwd: options.cwd, project: ctx.project.slug, chat, personalScope: Boolean(scope), systemPromptLength: fullSystemPrompt.length, contextPlugin: pluginDir, browser: browserEnabled, vaultItems: vaultItems.map((i) => i.name), googleAccounts: googleAccounts.map((a) => a.email), model: options.model, fallbackModel: options.fallbackModel, authMode: general.authMode, cellAccount: owner.usesCellAccount(), permissionMode: options.permissionMode, maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, allowedTools: options.allowedTools, owner: ownerId },
    });

    const queue = new MessageQueue();
    queue.push(await this.instruction(ctx, ctx.initialMessage, ctx.initialAttachments, ctx.initialPreamble, null, ctx.initialAuthor));
    // Un tour est en cours entre l'envoi d'une instruction et le message `result` qui le clôt.
    let turnInProgress = true;
    // Messages reçus dans le flux (uuid) et heure du dernier : ce que le journal du CLI contient au-delà a été perdu.
    const streamed = new Set<string>();
    let lastStreamedAt = new Date().toISOString();
    // Conversation du CLI (reprise, ou nouvelle dès son premier message) : nom de son journal.
    let conversationId: string | null = resumeId;
    // Tâche de fond terminée entre deux tours (commande Bash, sous-agent, surveillance) : le CLI va relancer l'agent de
    // lui-même, sans instruction d'une personne. Résumé de la notification, oublié dès qu'une instruction arrive.
    let pendingWake: string | null = null;
    // Tour en cours ouvert par le CLI lui-même (réveil sur une tâche de fond) : ce qui l'a déclenché et le dernier texte
    // de l'agent, pour prévenir la personne à sa fin (selfTurn.ts).
    let selfTurn: { trigger: string; text: string | null } | null = null;
    await ctx.setActivity('busy');
    // Sous-agents en arrière-plan encore vivants (backgroundTasks.ts) : après la fin d'un tour, la session reste « au
    // travail » tant qu'il en reste, puis jusqu'au tour que le CLI ouvre pour traiter leur compte rendu.
    const hold = new BackgroundHold(
      async (notice) => {
        if (turnInProgress || stopped) return;
        if (notice) await ctx.emit('system', { notice: true, message: notice });
        await ctx.setActivity('idle');
      },
      { onError: (err) => log.error("[sessions] fin d'attente des sous-agents", err) },
    );
    // Sous-agents en cours (premier plan comme arrière-plan), enregistrés sur la session pour la sidebar (subagents.ts).
    const subagents = new SubagentTracker();
    const subagentRecorder = new SubagentRecorder(subagents, async (list) => ctx.setSubagents?.(list), {
      onError: (err) => log.error('[sessions] enregistrement des sous-agents', err),
    });
    // Une exécution précédente arrêtée net a pu laisser une liste : elle repart vide.
    void subagentRecorder.flush();

    let stream: ReturnType<typeof query>;
    try {
      stream = query({ prompt: queue, options });
    } catch (err) {
      await disposeAll();
      throw err;
    }
    let stopped = false;
    // Flux fermé par le serveur : `stop()` appelé, ou arrêt du serveur en cours (le CLI a pu recevoir
    // le signal de pm2 avant que `stop()` ne soit appelé, son flux se termine alors tout seul).
    const closedByServer = () => stopped || ctx.isServerStopping();

    const done: Promise<RunResult> = (async () => {
      let lastResult: SDKResultMessage | undefined;
      let previousModelTotals: Record<string, number> = {};
      // Taille du contexte : tokens d'entrée (dont cache) du dernier appel au modèle, relevée sur les messages assistant.
      let contextTokens: number | null = null;
      // Statut de limite d'utilisation rapporté en dernier à cette session : seuls ses changements sont journalisés.
      const run: RunState = { rateLimitStatus: null, mcpReported: new Set(), billable };
      try {
        for await (const message of stream) {
          const uuid = (message as { uuid?: unknown }).uuid;
          if (typeof uuid === 'string') streamed.add(uuid);
          lastStreamedAt = new Date().toISOString();
          const sid = (message as { session_id?: unknown }).session_id;
          if (typeof sid === 'string' && sid) conversationId = sid;
          // Le modèle travaille alors qu'aucun tour n'était en cours : tour lancé par le CLI lui-même (fin d'une
          // commande de fond), ou suite d'une instruction après un résultat qui ne la concernait pas.
          // Seuls les messages de l'agent principal ouvrent un tour : ceux d'un sous-agent en arrière-plan arrivent aussi
          // entre deux tours, et le tour qui suit leur compte rendu peut se clore sur un résultat vide (notification).
          if (!turnInProgress && (message.type === 'stream_event' || message.type === 'assistant') && !message.parent_tool_use_id) {
            turnInProgress = true;
            hold.turnStarted();
            // Réveil sur une tâche de fond : repère dans le transcript (le tour ne commence par aucune instruction).
            if (pendingWake !== null) {
              selfTurn = { trigger: pendingWake, text: null };
              pendingWake = null;
              await ctx.emit('system', { selfTurn: true, trigger: selfTurn.trigger, message: selfTurnNotice(selfTurn.trigger) });
            }
            await ctx.setActivity('busy');
          }
          if (!turnInProgress && message.type === 'system' && message.subtype === 'task_notification') pendingWake = wakeTrigger(message);
          if (message.type === 'system' && message.subtype === 'background_tasks_changed') hold.setTasks(message.tasks);
          if (message.type === 'system') subagentRecorder.changed(subagents.apply(message as TaskMessageLike));
          if (message.type === 'stream_event') {
            liveDraftService.apply(ctx.session.id, message.event, message.parent_tool_use_id);
            continue;
          }
          if (message.type === 'assistant' || message.type === 'result') liveDraftService.clear(ctx.session.id);
          await this.handleMessage(ctx, message, run);
          await this.trackRuleUsage(ctx, message, ruleUsage).catch((e) => log.error('[permissions] suivi des règles', e));
          if (selfTurn && message.type === 'assistant' && !message.parent_tool_use_id) {
            const text = assistantText(message);
            if (text) selfTurn.text = text;
          }
          if (message.type === 'assistant' && !message.parent_tool_use_id) {
            const u = (message.message as { usage?: { input_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } }).usage;
            if (u && typeof u.input_tokens === 'number') contextTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          }
          if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
            // Conversation compactée : la taille annoncée après compaction remplace la mesure précédente.
            const meta = (message as { compact_metadata?: { post_tokens?: number } }).compact_metadata;
            contextTokens = typeof meta?.post_tokens === 'number' ? meta.post_tokens : null;
            await ctx.setContextTokens?.(contextTokens);
          }
          if (message.type === 'result') {
            previousModelTotals = await this.recordUsage(ctx, message, previousModelTotals, model ?? 'default', billable);
            await ctx.setContextTokens?.(contextTokens);
            // Tour vide ouvert par le CLI sur une notification de tâche de fond : l'instruction envoyée reste à traiter.
            if (turnInProgress && isEmptyNotificationResult(message)) continue;
            // Fin d'un tour : l'agent attend la prochaine instruction.
            lastResult = message;
            turnInProgress = false;
            // Tour clos, sous-agents encore au travail : la session n'est pas inactive (pas de garage pendant un drainage,
            // de fin d'exécution planifiée, d'archivage ni de fin pour inactivité).
            const held = hold.turnEnded();
            subagentRecorder.changed(subagents.turnEnded());
            // Fin d'un tour que l'agent a repris de lui-même : personne ne l'attendait, Skipper prévient (selfTurn.ts).
            const woke = selfTurn;
            selfTurn = null;
            if (woke && !message.is_error) void ctx.onSelfTurnEnded?.(woke).catch((err) => log.error('[sessions] notification de reprise autonome', err));
            if (held.hold) {
              if (held.first) await ctx.emit('system', { notice: true, message: `Tour terminé, ${describeBackgroundTasks(hold.live)} : la session reste au travail jusqu'à leur compte rendu.` });
              continue;
            }
            // Tour clos sur des commandes de fond (tests, build lancés avec run_in_background) : la session ne travaille
            // plus, mais l'agent sera réveillé à leur fin ; le dire, sinon rien ne montre qu'elle attend quelque chose.
            const commands = backgroundCommands(subagents.list);
            if (commands.length) {
              await ctx.emit('system', { notice: true, backgroundCommands: commands.length, message: `Tour terminé, ${describeBackgroundCommands(commands)} : l'agent reprendra de lui-même à ${commands.length > 1 ? 'leur' : 'sa'} fin. Vous pouvez aussi lui écrire.` });
            }
            await ctx.setActivity('idle');
          }
        }
      } catch (err) {
        if (closedByServer() || err instanceof AbortError) return { exitCode: null, closedByServer: true };
        // Processus arrêté entre deux tours (fin demandée : prise en main, inactivité…) alors que le dernier tour s'était
        // clos en erreur : le SDK remplace la sortie du CLI par le texte de ce résultat (`isLastResultEcho`). Le tour
        // est déjà jugé par son résultat — un tour interrompu n'est pas une erreur de la session.
        if (lastResult && !turnInProgress && isLastResultEcho(err)) {
          const error = resultError(lastResult, { interruptedIsError: false });
          return error ? { exitCode: 1, error } : { exitCode: 0 };
        }
        return { exitCode: 1, error: (err as Error).message };
      } finally {
        hold.dispose();
        await subagentRecorder.dispose();
        liveDraftService.clear(ctx.session.id);
        await disposeAll();
      }
      if (closedByServer()) return { exitCode: null, closedByServer: true };
      // Le flux s'est terminé de lui-même au milieu d'un tour : le processus Claude Code s'est arrêté
      // (plantage, mémoire épuisée...), ce qui n'a rien à voir avec une fermeture par le serveur.
      if (!lastResult || turnInProgress) return { exitCode: 1, error: "Le processus Claude Code s'est arrêté au milieu d'un tour (flux terminé sans message de résultat)" };
      // Un dernier tour interrompu par l'humain n'est pas une erreur de la session.
      const error = resultError(lastResult, { interruptedIsError: false });
      if (error) return { exitCode: 1, error };
      return { exitCode: 0 };
    })();

    // Fin de l'exécution, quelle qu'en soit la cause : le journal du CLI dit ce que le flux n'a pas apporté (messages des
    // sous-agents et de l'agent après la coupure, coût du travail fait après le dernier tour).
    void done.then(() => {
      const file = configDir && conversationId ? conversationJournalPath(configDir, ctx.cwd, conversationId) : null;
      if (!file) return;
      const pending = hold.live.length > 0 || turnInProgress || stopped;
      return this.reconcileAfterExit(ctx, { file, costStatesAtStart: file === journal ? costStatesAtStart : 0, after: lastStreamedAt, streamed, pending, generation, model: model ?? 'default', billable });
    }).catch((err) => log.error(`[usage] rapprochement de fin de la session ${ctx.session.id}`, err));

    return {
      wait: () => done,
      async stop() {
        // Arrêt (personne, fin de drainage, recréation du conteneur…) avec des sous-agents encore au travail : leur
        // travail en cours et leur compte rendu sont perdus, autant le dire plutôt que de laisser croire à un refus.
        if (hold.live.length) {
          await ctx
            .emit('system', { notice: true, message: `Session arrêtée alors que ${describeBackgroundTasks(hold.live)} travaillai${hold.live.length > 1 ? 'en' : ''}t encore : leur travail en cours et leur compte rendu sont perdus.` })
            .catch(() => undefined);
        }
        stopped = true;
        queue.close();
        abortController.abort();
        stream.close();
        await done;
      },
      acceptsMessages: () => !stopped && !queue.isClosed,
      sendMessage: async (text, attachments = [], author = null) => {
        // Vérifié avant `instruction()`, qui journalise l'instruction : une instruction refusée ne doit pas paraître remise.
        if (stopped || queue.isClosed) throw new AppError("La session n'accepte plus d'instructions");
        await (await claudeSettings.forSession(accounts?.claudeUserId ?? null)).assertBudgetAvailable();
        await projectBudget.assertAvailable(ctx.project.id);
        queue.push(await this.instruction(ctx, text, attachments, null, takeNotes(), author));
        pendingWake = null;
        turnInProgress = true;
        hold.turnStarted();
        await ctx.setActivity('busy');
      },
      async notify(text) {
        notes.push(text);
      },
      async end() {
        queue.close();
      },
      async interrupt() {
        await stream.interrupt();
      },
      // Changements à chaud pris en charge par le SDK : mode d'autorisation et modèle (les autres clés
      // valent pour le prochain lancement).
      async updateConfig(patch) {
        const applied: string[] = [];
        if ('permissionMode' in patch && !review) {
          const mode = (patch.permissionMode || 'default') as PermissionMode;
          if (!permissionModes.includes(mode)) throw new AppError(`permissionMode invalide : ${String(mode)}`);
          await stream.setPermissionMode(mode);
          applied.push('permissionMode');
        }
        if ('allowedTools' in patch && !review) {
          const next = splitAllowedTools(patch.allowedTools);
          liveAllowed = next.filter((rule) => !allowedTools.includes(rule));
          // Un outil retiré de la liste de départ reste autorisé jusqu'au prochain lancement : changement non appliqué.
          if (allowedTools.every((rule) => next.includes(rule))) applied.push('allowedTools');
        }
        if ('model' in patch) {
          const fresh = await claudeSettings.forSession(accounts?.claudeUserId ?? null);
          const next = patch.model ? String(patch.model) : fresh.settings.defaultModel ?? undefined;
          fresh.assertModelAllowed(next);
          await stream.setModel(next);
          model = next;
          applied.push('model');
        }
        return applied;
      },
    };
  }

  /**
   * Transforme les demandes de permission du SDK en demandes d'intervention humaine :
   * - AskUserQuestion -> demande de type 'question', la réponse est réinjectée dans l'outil ;
   * - tout autre outil -> demande de type 'permission' (allow / deny, éventuellement "toujours").
   */
  private canUseTool(ctx: RunContext, ruleUsage: RuleUsage): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      // Appel soumis à canUseTool : aucune règle mémorisée ne l'a autorisé d'office.
      ruleUsage.asked.add(options.toolUseID);
      try {
        // Filet du hook PreToolUse : un outil pré-autorisé par la planification ne fait pas de demande pendant ses exécutions.
        if (toolName !== 'AskUserQuestion') {
          const scheduled = await activeScheduleRules(ctx.session.id);
          if (scheduled && scheduleAllows(scheduled, toolName, input, ctx.cwd)) {
            await this.noteScheduleAllowed(ctx, toolName);
            return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID };
          }
        }
        if (toolName === 'AskUserQuestion') {
          const questions = (input.questions as Array<{ question: string }> | undefined) ?? [];
          const response = (await ctx.ask(
            {
              type: 'question',
              title: questions.length === 1 ? questions[0].question : `${questions.length} questions de l'agent`,
              payload: { toolName, questions },
            },
            options.signal,
          )) as Partial<QuestionResponse>;
          return { behavior: 'allow', updatedInput: { ...input, answers: response.answers ?? {} }, toolUseID: options.toolUseID };
        }

        const response = (await ctx.ask(
          {
            type: 'permission',
            title: options.title ?? `Autoriser l'outil ${toolName}`,
            message: options.decisionReason ?? null,
            payload: { toolName, input, suggestions: options.suggestions ?? [], blockedPath: options.blockedPath ?? null },
          },
          options.signal,
        )) as Partial<PermissionResponse>;

        if (response.decision === 'allow') {
          const remember = response.scope === 'project' || response.scope === 'session' || response.always === true;
          // Règles relues (et souvent généralisées) par l'humain dans le prompt : elles remplacent les suggestions du SDK.
          const suggestions = Array.isArray(response.rules) ? withEditedRules(options.suggestions ?? [], response.rules.map(String)) : (options.suggestions ?? []);
          if (response.scope === 'project') {
            // Mémorisé pour le projet : les prochaines sessions reçoivent la règle dans allowedTools ;
            // la session courante l'applique tout de suite via updatedPermissions.
            const added = await permissionRuleService.addFromSuggestions(ctx.project.id, suggestions, ctx.session.id);
            if (added.length) await ctx.emit('system', { message: `Autorisation mémorisée pour le projet : ${[...new Set(added.map(formatRule))].join(', ')}` });
            ruleUsage.rules = await permissionRuleService.list(ctx.project.id);
          }
          // Pour les modifications de fichiers, le SDK suggère un changement de mode (acceptEdits) plutôt qu'une
          // règle : updatedPermissions l'applique à la session en cours ; on l'enregistre aussi dans la configuration
          // de la session (affichage, prochain lancement).
          const mode = remember ? suggestedMode(suggestions) : null;
          if (mode && permissionModes.includes(mode as PermissionMode) && mode !== ctx.session.config.permissionMode) {
            await ctx.recordConfig({ permissionMode: mode });
          }
          return {
            behavior: 'allow',
            updatedInput: input,
            updatedPermissions: remember ? (suggestions as PermissionUpdate[]) : undefined,
            toolUseID: options.toolUseID,
          };
        }
        return { behavior: 'deny', message: response.message || "Refusé par l'utilisateur", toolUseID: options.toolUseID };
      } catch (err) {
        if (err instanceof RequestCancelledError) {
          return { behavior: 'deny', message: 'Demande annulée (session arrêtée ou demande abandonnée)', interrupt: true, toolUseID: options.toolUseID };
        }
        throw err;
      }
    };
  }

  /** Outils déjà signalés comme pré-autorisés par la planification (une ligne par outil et par session). */
  private readonly scheduleNoted = new Map<string, Set<string>>();

  /** Signale dans le transcript, une fois par outil, qu'un appel passe grâce aux autorisations de la planification. */
  private async noteScheduleAllowed(ctx: RunContext, what: string): Promise<void> {
    const seen = this.scheduleNoted.get(ctx.session.id) ?? new Set<string>();
    this.scheduleNoted.set(ctx.session.id, seen);
    if (seen.has(what)) return;
    seen.add(what);
    if (this.scheduleNoted.size > 500) this.scheduleNoted.delete(this.scheduleNoted.keys().next().value!);
    await ctx.emit('system', { message: `Autorisé par la planification : ${what}` }).catch(() => undefined);
  }

  /**
   * Approbation humaine d'un usage du coffre (élément « avec approbation », saisie d'un secret dans le navigateur) :
   * demande d'autorisation ordinaire, dont la réponse peut être mémorisée pour la session ou, pour un élément du
   * projet, comme règle du projet (`mcp__vault__sql_query(prod)`). Lève si l'humain refuse.
   */
  private async approveVaultUse(ctx: RunContext, ruleUsage: RuleUsage, approvals: Set<string>, approval: VaultApproval): Promise<void> {
    const suggestions = [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: approval.toolName, ruleContent: approval.key }] }];
    const message = [approval.message, approval.projectRules ? null : 'Élément personnel : « ne plus demander dans ce projet » ne vaut que pour cette session.'].filter(Boolean).join('\n');
    let response: Partial<PermissionResponse>;
    try {
      response = (await ctx.ask({ type: 'permission', title: approval.title, message, payload: { toolName: approval.toolName, input: approval.input, suggestions, vault: true } })) as Partial<PermissionResponse>;
    } catch (err) {
      if (err instanceof RequestCancelledError) throw new AppError('Demande annulée (session arrêtée ou demande abandonnée)', 'FORBIDDEN');
      throw err;
    }
    if (response.decision !== 'allow') throw new AppError(response.message || "Refusé par l'utilisateur", 'FORBIDDEN');
    const remember = response.scope === 'project' || response.scope === 'session' || response.always === true;
    if (remember) approvals.add(`${approval.toolName}|${approval.key.toLowerCase()}`);
    if (response.scope === 'project' && approval.projectRules) {
      const added = await permissionRuleService.addFromSuggestions(ctx.project.id, suggestions, ctx.session.id);
      if (added.length) await ctx.emit('system', { message: `Autorisation mémorisée pour le projet : ${[...new Set(added.map(formatRule))].join(', ')}` });
      ruleUsage.rules = await permissionRuleService.list(ctx.project.id);
    }
  }

  /**
   * Relevé de consommation : `total_cost_usd` est cumulé sur la session, `modelUsage` donne le
   * cumul par modèle ; on enregistre le delta depuis le dernier total connu. Renvoie les cumuls par
   * modèle pour le prochain tour. Une erreur de relevé ne doit jamais interrompre la session.
   */
  private async recordUsage(ctx: RunContext, result: SDKResultMessage, previous: Record<string, number>, fallbackModel: string, billable: boolean): Promise<Record<string, number>> {
    const modelTotals: Record<string, number> = {};
    for (const [name, usage] of Object.entries(result.modelUsage ?? {})) modelTotals[name] = usage.costUSD;
    try {
      const delta = await usageService.recordTotal(ctx.session.id, ctx.project.id, ctx.session.ownerId, result.total_cost_usd ?? 0, modelTotals, previous, fallbackModel, billable);
      if (delta > 0) {
        // Tour non compté : l'événement ne porte aucun montant (ni transcript, ni coût d'une exécution planifiée).
        await ctx.emit('usage', billable ? { deltaUsd: Number(delta.toFixed(6)), totalUsd: result.total_cost_usd } : { billable: false });
        void projectBudget.checkAlert(ctx.project.id);
      }
    } catch (err) {
      log.error('[usage] relevé impossible', err);
    }
    return modelTotals;
  }

  /**
   * Journalise l'instruction (événement `instruction`, avec les pièces jointes sans leur contenu) et construit le
   * message utilisateur : le texte, complété par la liste des fichiers joints et leur chemin, puis les images et
   * PDF en blocs de contenu pour que le modèle les voie directement.
   */
  /**
   * Avant de lancer le CLI : aligne le dernier total relevé sur celui dont le CLI va repartir (cliJournal.ts).
   * - Conversation reprise : dernière ligne `cost-state` de son journal. Plus haute que le relevé, l'écart est le travail
   *   fait après le dernier tour du processus précédent (sous-agents finis en orphelin) et il est enregistré ; plus
   *   basse (processus tué sans l'écrire), le relevé y est ramené pour que le premier tour soit compté en entier.
   * - Conversation neuve : le CLI part de 0.
   * Renvoie le nombre de lignes `cost-state` du journal (repère pour le rapprochement de fin).
   */
  private async reconcileAtStart(ctx: RunContext, journal: string | null, resumed: boolean, fallbackModel: string, billable: boolean): Promise<number> {
    try {
      if (!resumed) {
        await usageService.reconcileTotal(ctx.session.id, ctx.project.id, ctx.session.ownerId, 0, {}, fallbackModel, billable, { realign: true });
        return 0;
      }
      const parsed = journal ? await readJournal(journal) : null;
      const last = parsed?.costStates.at(-1);
      if (!parsed || !last) return parsed?.costStates.length ?? 0;
      const delta = await usageService.reconcileTotal(ctx.session.id, ctx.project.id, ctx.session.ownerId, last.totalCostUSD, last.modelCosts, fallbackModel, billable, { realign: true });
      if (delta > 0) await this.noteReconciled(ctx, delta, last.totalCostUSD, billable, 'à la reprise');
      return parsed.costStates.length;
    } catch (err) {
      log.error(`[usage] rapprochement au lancement de la session ${ctx.session.id}`, err);
      return 0;
    }
  }

  /**
   * Après la fin d'une exécution : attend que le CLI écrive son `cost-state` de sortie (aussitôt d'ordinaire ; jusqu'à
   * 30 min quand des sous-agents tournaient encore ou que le flux a été coupé, le CLI lancé par `docker exec` finissant
   * leur travail en orphelin), puis importe dans la session les messages que le flux n'a pas apportés et enregistre le
   * coût du travail fait après le dernier tour. S'efface devant une nouvelle exécution de la session, qui fait le
   * rapprochement elle-même à son lancement.
   */
  private async reconcileAfterExit(
    ctx: RunContext,
    run: { file: string; costStatesAtStart: number; after: string; streamed: ReadonlySet<string>; pending: boolean; generation: number; model: string; billable: boolean },
  ): Promise<void> {
    const deadline = Date.now() + (run.pending ? AFTER_EXIT_PENDING_MS : AFTER_EXIT_MS);
    const current = () => runGenerations.get(ctx.session.id) === run.generation;
    let size = -1;
    for (;;) {
      if (!current()) return;
      // Journal relu seulement quand il a grandi (il peut peser plusieurs Mo).
      const now = await stat(run.file).then((st) => st.size, () => -1);
      if (now === size && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, run.pending ? 15_000 : 5_000));
        continue;
      }
      size = now;
      const parsed = await readJournal(run.file);
      const exited = Boolean(parsed && parsed.costStates.length > run.costStatesAtStart);
      if (exited || Date.now() >= deadline) {
        if (!current()) return;
        const missed = missedMessages(parsed?.entries ?? [], await readSubagentEntries(run.file), run.after, run.streamed);
        for (const m of missed) await ctx.emit(`claude.${String(m.type)}`, m.type === 'user' ? (withoutBinaryData(m as unknown as SDKMessage) as unknown as Record<string, unknown>) : m);
        if (missed.length) {
          await ctx.emit('system', { notice: true, recovered: true, message: `${missed.length} message${missed.length > 1 ? 's' : ''} de l'agent et de ses sous-agents écrit${missed.length > 1 ? 's' : ''} après la coupure du flux, récupéré${missed.length > 1 ? 's' : ''} dans le journal du CLI.` });
        }
        const last = exited ? parsed!.costStates.at(-1)! : null;
        if (last) {
          const delta = await usageService.reconcileTotal(ctx.session.id, ctx.project.id, ctx.session.ownerId, last.totalCostUSD, last.modelCosts, run.model, run.billable, { realign: false });
          if (delta > 0) await this.noteReconciled(ctx, delta, last.totalCostUSD, run.billable, 'après la fin du flux');
        } else if (run.pending) {
          log.warn(`[usage] session ${ctx.session.id} : pas de coût final dans le journal du CLI ${Math.round(AFTER_EXIT_PENDING_MS / 60_000)} min après l'arrêt ; il sera relevé à la prochaine reprise`);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, run.pending ? 15_000 : 5_000));
    }
  }

  /** Coût rattrapé depuis le journal du CLI : événement `usage` (transcript, coût des exécutions planifiées) et alerte de budget. */
  private async noteReconciled(ctx: RunContext, delta: number, total: number, billable: boolean, when: string): Promise<void> {
    log.info(`[usage] session ${ctx.session.id} : ${delta.toFixed(4)} $ rattrapés ${when} depuis le journal du CLI`);
    await ctx.emit('usage', billable ? { deltaUsd: Number(delta.toFixed(6)), totalUsd: total, reconciled: true } : { billable: false, reconciled: true });
    void projectBudget.checkAlert(ctx.project.id);
  }

  /**
   * Identifiant de la conversation Claude Code à reprendre : celui de la session, si son transcript existe encore
   * dans l'environnement du projet (`~/.claude/projects/<cwd encodé>/<id>.jsonl`). Sinon (conteneur recréé avant que
   * ce dossier ne soit persistant, fichier purgé), la session repart d'une conversation neuve, avec un avertissement.
   */
  private async resumableConversation(ctx: RunContext): Promise<string | null> {
    const id = ctx.session.externalId;
    if (!id) return null;
    const chat = ctx.session.kind === 'chat';
    // Un chat tourne sur le serveur, avec son propre dossier de configuration ; une session, dans le conteneur du projet.
    const file = path.posix.join(chat ? chatConfigDir(ctx.project) : path.posix.join(os.homedir(), '.claude'), 'projects', ctx.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
    const exists = chat ? await access(file).then(() => true, () => false) : await runner.pathExists(ctx.project, file).catch(() => true);
    if (exists) return id;
    await ctx.emit('system', { notice: true, message: `La conversation Claude Code précédente (${id}) est introuvable dans l'environnement du projet : la session repart d'une conversation neuve. L'agent ne se souvient pas des échanges affichés ci-dessus ; le fil reste consultable ici.` });
    return null;
  }

  /**
   * `notes` : notes discrètes en attente, remises au modèle avant l'instruction sans paraître dans le transcript (déjà journalisées).
   * `author` : qui écrit, journalisé avec l'instruction et annoncé au modèle juste devant elle (`authorHeader`).
   */
  private async instruction(ctx: RunContext, text: string, attachments: Attachment[], preamble?: string | null, notes?: string | null, author?: InstructionAuthor | null): Promise<SDKUserMessage['message']['content']> {
    await ctx.emit('instruction', { text, ...(attachments.length ? { attachments: attachments.map(publicAttachment) } : {}), ...(preamble ? { preamble: true } : {}), ...(author ? { author } : {}) });
    const body = [preamble, notes, authorHeader(author, text), text].filter(Boolean).join('\n\n');
    if (!attachments.length) return body;
    const note = attachmentsNote(attachments);
    return [{ type: 'text', text: `${body}\n\n${note}` }, ...(await inlineBlocks(attachments))];
  }

  /**
   * Date la dernière utilisation des règles mémorisées : un appel d'outil dont le résultat arrive sans être
   * passé par canUseTool a été autorisé d'office ; il est compté pour les règles du projet qui lui correspondent.
   */
  private async trackRuleUsage(ctx: RunContext, message: SDKMessage, usage: RuleUsage): Promise<void> {
    if (message.type === 'assistant') {
      for (const b of message.message.content) if (b.type === 'tool_use') usage.pending.set(b.id, { name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      return;
    }
    if (message.type !== 'user' || !Array.isArray(message.message.content)) return;
    for (const b of message.message.content as Array<{ type?: string; tool_use_id?: string }>) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      const use = usage.pending.get(b.tool_use_id);
      usage.pending.delete(b.tool_use_id);
      if (!use) continue;
      // Push, `gh pr`, outil tasks.pr_*, édition, commit : les PR suivies du projet sont relues sans attendre la synchronisation de fond.
      if (ctx.project.gitUrl) syncAfterTool(ctx.project.id, toolSyncUser(ctx.session), use.name, use.input);
      if (usage.asked.delete(b.tool_use_id) || !usage.rules.length) continue;
      await permissionRuleService.recordUse(usage.rules, use.name, use.input, ctx.cwd);
    }
  }

  private async handleMessage(ctx: RunContext, message: SDKMessage, run: RunState): Promise<void> {
    if ('session_id' in message && typeof message.session_id === 'string' && message.session_id !== ctx.session.externalId) {
      await ctx.setExternalId(message.session_id);
    }
    // Compteurs et états intermédiaires (réflexion, progression des outils et tâches de fond) : des dizaines
    // de messages par minute, sans contenu pour le transcript. Les journaliser ralentit la lecture du flux
    // (une écriture en base chacun) et gonfle l'historique.
    if (isNoise(message)) return;
    // Limites d'utilisation de l'abonnement : un événement par appel au modèle. Le dernier état est gardé
    // par rateLimitService (Paramètres, tableau de bord, alertes) ; le transcript ne garde que les changements.
    if (message.type === 'rate_limit_event') {
      rateLimitService.record(message.rate_limit_info);
      if (message.rate_limit_info.status === run.rateLimitStatus) return;
      run.rateLimitStatus = message.rate_limit_info.status;
    }
    // Tour refusé pour cause de limite : le message du CLI (« You've reached your … limit ») est peu explicite.
    if (message.type === 'assistant' && message.error === 'rate_limit') {
      await ctx.emit('system', { notice: true, rateLimit: true, message: describeRejection(rateLimitService.current()) });
    }
    // Serveur MCP du navigateur qui n'a pas démarré dans le CLI (playwright-mcp absent, plantage) : explication dans le transcript.
    if (message.type === 'system' && message.subtype === 'init') {
      const playwright = message.mcp_servers.find((m) => m.name === 'playwright');
      if (playwright && playwright.status !== 'connected' && playwright.status !== 'pending') {
        const reason = await explainBrowserFailure(ctx.project, `le serveur MCP playwright est « ${playwright.status} » dans le CLI.`);
        await ctx.emit('system', { notice: true, browser: true, message: `Navigateur headless indisponible : ${reason}` });
      }
      // Autres serveurs MCP (coffre, tâches…) en échec ou sans outil : signalés dans le fil et les logs, cause tirée
      // du journal du CLI dans le conteneur (un chat tourne sur le serveur, sans conteneur : statut seul).
      // Le message d'init peut revenir à chaque tour : chaque serveur n'est signalé qu'une fois par exécution.
      for (const failure of failedMcpServers(message)) {
        if (run.mcpReported.has(failure.name)) continue;
        run.mcpReported.add(failure.name);
        const detail = ctx.session.kind === 'chat' ? null : await readMcpLogDetail(ctx.project, ctx.cwd, failure.name);
        log.warn(`[mcp] session ${ctx.session.id} (${ctx.project.slug}) : serveur ${failure.name} en échec (statut ${failure.status})${detail ? ` : ${detail}` : ''}`);
        await ctx.emit('system', { notice: true, mcpServer: failure.name, message: mcpFailureNotice(failure, detail) });
      }
    }
    // Premier outil du navigateur utilisé par l'agent : la vue en direct est proposée dans la sidebar.
    if (message.type === 'assistant' && message.message.content.some((b) => b.type === 'tool_use' && b.name.startsWith('mcp__playwright__'))) {
      liveBrowserService.markUsed(ctx.session.id);
    }
    const payload = message.type === 'user' ? withoutBinaryData(message) : message.type === 'result' && !run.billable ? { ...message, skipperUnbilled: true } : message;
    await ctx.emit(`claude.${message.type}`, payload as unknown as Record<string, unknown>);
  }
}

/** Suivi de l'utilisation des règles mémorisées pendant une exécution. */
interface RuleUsage {
  rules: PermissionRule[];
  /** Appels d'outils passés par canUseTool (non autorisés d'office). */
  asked: Set<string>;
  /** Appels d'outils annoncés par l'agent, en attente de leur résultat. */
  pending: Map<string, { name: string; input: Record<string, unknown> }>;
}

/** État propre à une exécution du provider (un processus Claude Code). */
interface RunState {
  rateLimitStatus: string | null;
  /** Serveurs MCP déjà signalés en échec. */
  mcpReported: Set<string>;
  /** Tours comptés dans la consommation ; sinon les résultats sont marqués `skipperUnbilled` (aucun coût affiché). */
  billable: boolean;
}

type ContentBlock = { type?: string; source?: { type?: string; data?: string }; content?: unknown };

/** Blocs sans leurs données base64 (image, document), y compris dans le contenu d'un résultat d'outil. */
function stripBinaryBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if ((block.type === 'image' || block.type === 'document') && block.source?.type === 'base64' && typeof block.source.data === 'string') {
      return { ...block, source: { ...block.source, data: `[${block.source.data.length} caractères base64 omis]` } };
    }
    if (block.type === 'tool_result' && Array.isArray(block.content)) return { ...block, content: stripBinaryBlocks(block.content as ContentBlock[]) };
    return block;
  });
}

/**
 * Copie d'un message utilisateur renvoyé par le SDK sans les données base64 des blocs image et document
 * (pièces jointes rejouées, captures d'écran renvoyées par un outil : navigateur, aperçu) : le fichier est déjà sur
 * disque, inutile d'en garder une copie dans chaque événement.
 */
function withoutBinaryData(message: SDKMessage): SDKMessage {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return message;
  return { ...message, message: { ...(message as { message: object }).message, content: stripBinaryBlocks(content as ContentBlock[]) } } as SDKMessage;
}
