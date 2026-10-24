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
import os from 'node:os';
import path from 'node:path';
import { config } from '../../config.js';
import { createContextMcpServer } from '../../context/mcp.js';
import { contextService } from '../../context/service.js';
import { materializeSkills } from '../../context/skills.js';
import { AppError } from '../../errors.js';
import { liveBrowserService } from '../../browser/live.js';
import { createGoogleMcpServer } from '../../google/mcp.js';
import { googleAccountService, googleReadTools } from '../../google/service.js';
import { permissionRuleService, suggestedMode, withEditedRules } from '../../permissions/service.js';
import { formatRule, type PermissionRule } from '../../permissions/types.js';
import { createSharedPagesMcpServer, sharedPagesPrompt } from '../../sharedPages/mcp.js';
import { createVaultMcpServer, type VaultApproval } from '../../vault/mcp.js';
import { vaultService } from '../../vault/service.js';
import { sessionIdentityPrompt } from '../identity.js';
import { RequestCancelledError } from '../../requests/service.js';
import { runner } from '../../runners/index.js';
import { agentGitEnv } from '../../git/agentEnv.js';
import { createTasksMcpServer } from '../../tasks/mcp.js';
import { taskService } from '../../tasks/service.js';
import { createWorktreesMcpServer } from '../../worktrees/mcp.js';
import { createSessionsMcpServer, sessionsPromptSummary } from '../mcp.js';
import { claudeSettings } from '../../settings/claude.js';
import { agentService } from '../../agents/service.js';
import { usageService } from '../../settings/usage.js';
import { describeRejection, rateLimitService } from '../../settings/rateLimits.js';
import type { PermissionResponse, QuestionResponse } from '../../requests/types.js';
import { attachmentsNote, inlineBlocks, publicAttachment } from '../attachments.js';
import type { Attachment } from '../types.js';
import type { DescribeContext, ProviderDescription, RunContext, RunningHandle, RunResult, SessionProvider } from './provider.js';
import { isNoise } from './claudeNoise.js';
import { resultError } from './claudeResult.js';

interface ClaudeConfig {
  model?: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string;
}

const permissionModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];

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
            { value: 'dontAsk', label: 'Ne jamais me demander', description: 'Les actions non autorisées sont refusées automatiquement.' },
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

    // Réglages du PROPRIÉTAIRE de la session : identifiants (coffre), modèle par défaut, budgets, plafond mensuel.
    const ownerId = ctx.session.ownerId;
    const owner = await claudeSettings.forSession(ownerId);
    owner.assertCredentials();
    await owner.assertBudgetAvailable();
    const general = owner.settings;
    // Modèle courant : modifiable en cours de session (updateConfig), d'où la variable.
    let model = cfg.model ? String(cfg.model) : general.defaultModel ?? undefined;
    owner.assertModelAllowed(model);
    const actor = { sessionId: ctx.session.id, projectId: ctx.project.id };
    const env = { ...(await owner.credentialEnv(general.authMode, actor)), ...(await agentGitEnv(ownerId, ctx.project.gitUrl, actor)) };
    // Script de relais qui exécute le CLI dans le conteneur du projet (avant le navigateur : rien à nettoyer s'il échoue).
    const claudeExecutable = await runner.claudeExecutable(ctx.project);

    const abortController = new AbortController();
    // Option « navigateur » du projet : un serveur MCP Playwright (Chromium headless) dans le conteneur du projet.
    const browserEnabled = Boolean((ctx.project.runnerConfig as { browser?: boolean } | null)?.browser);
    // Portée du coffre pour cette session : éléments du projet, reliés au projet, reliés par le propriétaire pour ses sessions.
    const vaultItems = await vaultService.agentItems(ctx.project.id, ownerId);
    const vaultTools = vaultItems.some((i) => i.kind !== 'google');
    const vaultBrowser = vaultItems.some((i) => i.kind === 'website' || i.kind === 'secret');
    // Comptes Google de la portée (Gmail, Drive) : serveur MCP `google`, lectures libres, écritures soumises à autorisation.
    const googleAccounts = await googleAccountService.accountsFor(ctx.project.id, ownerId);
    // Prompt système : celui du projet, l'identité de la session, puis la bibliothèque de contexte, les tâches, le coffre et les comptes Google.
    const systemPrompt = [
      ctx.project.systemPrompt.trim(),
      await agentService.systemPromptFor(ctx.session),
      sessionIdentityPrompt(ctx.session, ctx.project),
      await contextService.promptSummary(ctx.project.id),
      await taskService.linkedTaskPrompt(ctx.session.id),
      await taskService.promptSummary(ctx.project.id, ctx.session.id),
      vaultService.promptSummary(vaultItems, ctx.project),
      sessionsPromptSummary(ctx.project),
      googleAccountService.promptSummary(googleAccounts),
      sharedPagesPrompt(),
      browserEnabled
        ? "Un navigateur headless (Chromium) est disponible via les outils `mcp__playwright__*` : navigue, lis la page (`browser_snapshot`), clique et remplis des formulaires pour tester les interfaces web. Le serveur de développement à tester se lance dans l'environnement du projet ; ses URL en localhost y sont accessibles. Pour te connecter à un site web du coffre, clique le champ du formulaire puis appelle `browser_fill` : Skipper y saisit la valeur, que tu ne vois jamais."
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    // La bibliothèque de contexte est exposée deux fois : outils MCP (lecture/écriture) et skills (plugin local).
    const pluginDir = await materializeSkills(ctx.project);
    const allowedTools = cfg.allowedTools ? String(cfg.allowedTools).split(',').map((t) => t.trim()).filter(Boolean) : [];
    // Autorisations mémorisées pour le projet (« ne plus demander dans ce projet »).
    const projectRules = await permissionRuleService.list(ctx.project.id);
    const ruleUsage: RuleUsage = { rules: projectRules, asked: new Set(), pending: new Map() };
    // Le navigateur ne reçoit aucun secret à l'avance : le coffre les saisit à la demande (browser_fill).
    let browserServer: Awaited<ReturnType<typeof runner.browserMcpCommand>> | null = null;
    if (browserEnabled) {
      browserServer = await runner.browserMcpCommand(ctx.project, ctx.cwd, { sessionId: ctx.session.id });
      // Vue en direct du navigateur dans l'interface (le backend s'y attache par CDP quand quelqu'un regarde).
      liveBrowserService.register(ctx.session.id, ctx.project, browserServer.cdp);
    }
    // Approbations mémorisées « pour la session » sur les éléments du coffre (outil|clé).
    const vaultApprovals = new Set<string>();
    const vaultContext = {
      project: ctx.project,
      sessionId: ctx.session.id,
      ownerId,
      cwd: ctx.cwd,
      emit: ctx.emit,
      remembered: async (toolName: string, key: string, projectRules: boolean) => {
        if (vaultApprovals.has(`${toolName}|${key.toLowerCase()}`)) return true;
        return projectRules && ruleUsage.rules.some((r) => r.toolName === toolName && r.ruleContent?.trim().toLowerCase() === key.toLowerCase());
      },
      approve: (approval: VaultApproval) => this.approveVaultUse(ctx, ruleUsage, vaultApprovals, approval),
    };
    const disposeAll = async () => {
      if (browserServer) liveBrowserService.unregister(ctx.session.id);
      await browserServer?.dispose().catch((e) => console.error('[browser] arrêt du navigateur de la session', e));
    };
    // Les observations (instantané, capture, console, réseau, attente) sont libres ; les actions passent par les demandes d'autorisation.
    const browserReadTools = ['mcp__playwright__browser_snapshot', 'mcp__playwright__browser_take_screenshot', 'mcp__playwright__browser_console_messages', 'mcp__playwright__browser_network_requests', 'mcp__playwright__browser_wait_for'];
    const options: Options = {
      cwd: ctx.cwd,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      mcpServers: {
        context: createContextMcpServer(ctx.project, ctx.session.id),
        tasks: createTasksMcpServer(ctx.project, ctx.session.id, ctx.session.name),
        ...(vaultTools ? { vault: createVaultMcpServer(vaultContext) } : {}),
        worktrees: createWorktreesMcpServer(ctx.project, ctx.session.id),
        sessions: createSessionsMcpServer(ctx.project, ctx.session.id),
        pages: createSharedPagesMcpServer({ project: ctx.project, session: ctx.session, cwd: ctx.cwd }),
        ...(googleAccounts.length ? { google: createGoogleMcpServer({ project: ctx.project, accounts: googleAccounts, sessionId: ctx.session.id, cwd: ctx.cwd, emit: ctx.emit }) } : {}),
        // Le serveur hérite de l'environnement du CLI (dans le conteneur). La configuration MCP passe sur la ligne
        // de commande du CLI, visible de tout utilisateur du serveur (ps) : l'environnement du backend n'y figure jamais.
        ...(browserServer ? { playwright: { type: 'stdio' as const, command: browserServer.command, args: browserServer.args, ...(browserServer.env ? { env: browserServer.env } : {}) } } : {}),
      },
      plugins: [{ type: 'local', path: pluginDir, skipMcpDiscovery: true }],
      model,
      // Le CLI refuse un repli identique au modèle principal : le repli est alors simplement omis.
      fallbackModel: general.fallbackModel && general.fallbackModel !== model ? general.fallbackModel : undefined,
      env,
      permissionMode: cfg.permissionMode || 'default',
      // Garde-fou du SDK : le mode bypassPermissions doit être explicitement assumé. Toujours vrai ici, car il rend
      // ce mode *disponible* sans l'activer (drapeau --allow-dangerously-skip-permissions du CLI) : c'est la
      // condition pour pouvoir y passer en cours de session (setPermissionMode), choix explicite de l'humain.
      allowDangerouslySkipPermissions: true,
      maxTurns: cfg.maxTurns ? Number(cfg.maxTurns) : general.defaultMaxTurns ?? undefined,
      maxBudgetUsd: cfg.maxBudgetUsd ? Number(cfg.maxBudgetUsd) : general.sessionBudgetUsd ?? undefined,
      // Les outils du contexte et des tâches sont toujours autorisés : leurs effets restent dans la base et sont versionnés.
      // Les outils du coffre portent leur propre porte d'approbation (élément « avec approbation » : un humain
      // confirme chaque usage, quel que soit le mode d'autorisation) : le SDK ne redemande pas.
      // Worktrees : lister et créer sont libres (réversible, sans coût) ; supprimer est soumis à autorisation.
      // Sessions : consulter, attendre et terminer ses propres sessions sont libres ; lancer une session ou lui
      // envoyer une instruction consomme du budget et passe par l'autorisation habituelle.
      // Pages partagées : lister est libre ; publier passe par l'autorisation quand la page est exposée à d'autres.
      allowedTools: [...allowedTools, ...projectRules.map(formatRule), 'mcp__context', 'mcp__tasks', 'mcp__vault', 'mcp__worktrees__list', 'mcp__worktrees__create', 'mcp__sessions__list', 'mcp__sessions__get', 'mcp__sessions__wait', 'mcp__sessions__end', 'mcp__pages__list', ...(browserServer ? browserReadTools : []), ...(googleAccounts.length ? googleReadTools(googleAccounts) : [])],
      // Le coffre saisit des secrets dans le navigateur : les outils qui pourraient relire la valeur sont retirés à l'agent.
      ...(browserServer && vaultBrowser ? { disallowedTools: ['mcp__playwright__browser_evaluate', 'mcp__playwright__browser_run_code'] } : {}),
      // Reprise de la conversation Claude si la session a déjà tourné et que le CLI la retrouve encore.
      resume: (await this.resumableConversation(ctx)) ?? undefined,
      pathToClaudeCodeExecutable: claudeExecutable,
      abortController,
      stderr: (data) => void ctx.emit('stderr', { text: data.trimEnd() }),
      // Les demandes de permission (et l'outil AskUserQuestion) deviennent des demandes d'intervention humaine.
      canUseTool: this.canUseTool(ctx, ruleUsage),
    };

    await ctx.emit('system', {
      message: `Lancement via Claude Agent SDK${options.resume ? ` (reprise de ${options.resume})` : ''}`,
      options: { cwd: options.cwd, project: ctx.project.slug, systemPromptLength: systemPrompt.length, contextPlugin: pluginDir, browser: browserEnabled, vaultItems: vaultItems.map((i) => i.name), googleAccounts: googleAccounts.map((a) => a.email), model: options.model, fallbackModel: options.fallbackModel, authMode: general.authMode, permissionMode: options.permissionMode, maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, allowedTools: options.allowedTools, owner: ownerId },
    });

    const queue = new MessageQueue();
    queue.push(await this.instruction(ctx, ctx.initialMessage, ctx.initialAttachments));
    // Un tour est en cours entre l'envoi d'une instruction et le message `result` qui le clôt.
    let turnInProgress = true;
    await ctx.setActivity('busy');

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
      const run: RunState = { rateLimitStatus: null };
      try {
        for await (const message of stream) {
          await this.handleMessage(ctx, message, run);
          await this.trackRuleUsage(ctx, message, ruleUsage).catch((e) => console.error('[permissions] suivi des règles', e));
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
            // Fin d'un tour : l'agent attend la prochaine instruction.
            lastResult = message;
            turnInProgress = false;
            previousModelTotals = await this.recordUsage(ctx, message, previousModelTotals, model ?? 'default');
            await ctx.setContextTokens?.(contextTokens);
            await ctx.setActivity('idle');
          }
        }
      } catch (err) {
        if (closedByServer() || err instanceof AbortError) return { exitCode: null, closedByServer: true };
        return { exitCode: 1, error: (err as Error).message };
      } finally {
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

    return {
      wait: () => done,
      async stop() {
        stopped = true;
        queue.close();
        abortController.abort();
        stream.close();
        await done;
      },
      sendMessage: async (text, attachments = []) => {
        await (await claudeSettings.forSession(ownerId)).assertBudgetAvailable();
        queue.push(await this.instruction(ctx, text, attachments));
        turnInProgress = true;
        await ctx.setActivity('busy');
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
        if ('permissionMode' in patch) {
          const mode = (patch.permissionMode || 'default') as PermissionMode;
          if (!permissionModes.includes(mode)) throw new AppError(`permissionMode invalide : ${String(mode)}`);
          await stream.setPermissionMode(mode);
          applied.push('permissionMode');
        }
        if ('model' in patch) {
          const fresh = await claudeSettings.forSession(ownerId);
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
  private async recordUsage(ctx: RunContext, result: SDKResultMessage, previous: Record<string, number>, fallbackModel: string): Promise<Record<string, number>> {
    const modelTotals: Record<string, number> = {};
    for (const [name, usage] of Object.entries(result.modelUsage ?? {})) modelTotals[name] = usage.costUSD;
    try {
      const delta = await usageService.recordTotal(ctx.session.id, ctx.project.id, ctx.session.ownerId, result.total_cost_usd ?? 0, modelTotals, previous, fallbackModel);
      if (delta > 0) await ctx.emit('usage', { deltaUsd: Number(delta.toFixed(6)), totalUsd: result.total_cost_usd });
    } catch (err) {
      console.error('[usage] relevé impossible', err);
    }
    return modelTotals;
  }

  /**
   * Journalise l'instruction (événement `instruction`, avec les pièces jointes sans leur contenu) et construit le
   * message utilisateur : le texte, complété par la liste des fichiers joints et leur chemin, puis les images et
   * PDF en blocs de contenu pour que le modèle les voie directement.
   */
  /**
   * Identifiant de la conversation Claude Code à reprendre : celui de la session, si son transcript existe encore
   * dans l'environnement du projet (`~/.claude/projects/<cwd encodé>/<id>.jsonl`). Sinon (conteneur recréé avant que
   * ce dossier ne soit persistant, fichier purgé), la session repart d'une conversation neuve, avec un avertissement.
   */
  private async resumableConversation(ctx: RunContext): Promise<string | null> {
    const id = ctx.session.externalId;
    if (!id) return null;
    const file = path.posix.join(os.homedir(), '.claude', 'projects', ctx.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
    if (await runner.pathExists(ctx.project, file).catch(() => true)) return id;
    await ctx.emit('system', { notice: true, message: `La conversation Claude Code précédente (${id}) est introuvable dans l'environnement du projet : la session repart d'une conversation neuve. L'agent ne se souvient pas des échanges affichés ci-dessus ; le fil reste consultable ici.` });
    return null;
  }

  private async instruction(ctx: RunContext, text: string, attachments: Attachment[]): Promise<SDKUserMessage['message']['content']> {
    await ctx.emit('instruction', { text, ...(attachments.length ? { attachments: attachments.map(publicAttachment) } : {}) });
    if (!attachments.length) return text;
    const note = attachmentsNote(attachments);
    return [{ type: 'text', text: `${text}\n\n${note}` }, ...(await inlineBlocks(attachments))];
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
    // Premier outil du navigateur utilisé par l'agent : la vue en direct est proposée dans la sidebar.
    if (message.type === 'assistant' && message.message.content.some((b) => b.type === 'tool_use' && b.name.startsWith('mcp__playwright__'))) {
      liveBrowserService.markUsed(ctx.session.id);
    }
    const payload = message.type === 'user' ? withoutBinaryData(message) : message;
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
}

/**
 * Copie d'un message utilisateur renvoyé par le SDK sans les données base64 des blocs image et document
 * (pièces jointes rejouées) : le fichier est déjà sur disque, inutile d'en garder une copie dans chaque événement.
 */
function withoutBinaryData(message: SDKMessage): SDKMessage {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return message;
  const stripped = content.map((block: { type?: string; source?: { type?: string; data?: string } }) =>
    (block.type === 'image' || block.type === 'document') && block.source?.type === 'base64' && typeof block.source.data === 'string'
      ? { ...block, source: { ...block.source, data: `[${block.source.data.length} caractères base64 omis]` } }
      : block,
  );
  return { ...message, message: { ...(message as { message: object }).message, content: stripped } } as SDKMessage;
}
