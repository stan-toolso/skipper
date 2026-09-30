import {
  AbortError,
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../config.js';
import { createConnectionsMcpServer } from '../../connections/mcp.js';
import { prepareDirectAccess, type DirectAccess } from '../../connections/runtime.js';
import { connectionService } from '../../connections/service.js';
import { createContextMcpServer } from '../../context/mcp.js';
import { contextService } from '../../context/service.js';
import { materializeSkills } from '../../context/skills.js';
import { AppError } from '../../errors.js';
import { createGoogleMcpServer } from '../../google/mcp.js';
import { googleAccountService, googleReadTools } from '../../google/service.js';
import { permissionRuleService, suggestedMode } from '../../permissions/service.js';
import { formatRule } from '../../permissions/types.js';
import { RequestCancelledError } from '../../requests/service.js';
import { runner } from '../../runners/index.js';
import { agentGitEnv } from '../../git/agentEnv.js';
import { createTasksMcpServer } from '../../tasks/mcp.js';
import { taskService } from '../../tasks/service.js';
import { settingsService } from '../../settings/service.js';
import { usageService } from '../../settings/usage.js';
import type { PermissionResponse, QuestionResponse } from '../../requests/types.js';
import type { ProviderDescription, RunContext, RunningHandle, RunResult, SessionProvider } from './provider.js';

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

  push(text: string): void {
    if (this.closed) throw new AppError("La session n'accepte plus d'instructions");
    this.buffer.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
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

  describe(): ProviderDescription {
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
          defaultValue: settingsService.claude.defaultModel ?? '',
          description: 'Les modèles proposés et le choix par défaut se règlent dans Paramètres.',
          options: [
            { value: '', label: settingsService.claude.defaultModel ? `Réglage général (${settingsService.claude.defaultModel})` : 'Modèle par défaut de Claude Code' },
            ...settingsService.selectableModels().map((m) => ({ value: m.value, label: m.displayName, description: m.description || undefined })),
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
    settingsService.assertModelAllowed(cfg.model ? String(cfg.model) : null);
  }

  async start(ctx: RunContext): Promise<RunningHandle> {
    const cfg = ctx.session.config as ClaudeConfig;
    if (!ctx.initialMessage) throw new AppError('Une session Claude nécessite une première instruction');

    // Réglages généraux : authentification, modèle par défaut, budgets, plafond mensuel.
    const general = settingsService.claude;
    await settingsService.assertBudgetAvailable();
    // Modèle courant : modifiable en cours de session (updateConfig), d'où la variable.
    let model = cfg.model ? String(cfg.model) : general.defaultModel ?? undefined;
    settingsService.assertModelAllowed(model);
    const env = { ...settingsService.authEnv(), ...(await agentGitEnv()) };
    // Connexions en accès direct (ssh, psql depuis le shell) : agent SSH, tunnels et fichiers éphémères.
    let direct: DirectAccess | null = null;
    try {
      direct = await prepareDirectAccess(ctx.project, ctx.session.id, env);
    } catch (err) {
      await ctx.emit('system', { message: `Accès direct aux connexions indisponible : ${(err as Error).message}` });
    }
    Object.assign(env, direct?.env ?? {});

    const abortController = new AbortController();
    // Option « navigateur » du projet : un serveur MCP Playwright (Chromium headless) dans le conteneur du projet.
    const browserEnabled = Boolean((ctx.project.runnerConfig as { browser?: boolean } | null)?.browser);
    // Compte Google du projet (Gmail, Drive) : serveur MCP `google`, lectures libres, écritures soumises à autorisation.
    const googleAccount = await googleAccountService.find(ctx.project.id);
    // Prompt système : celui du projet, puis la description de la bibliothèque de contexte, des tâches, des connexions et du compte Google.
    const systemPrompt = [
      ctx.project.systemPrompt.trim(),
      await contextService.promptSummary(ctx.project.id),
      await taskService.promptSummary(ctx.project.id, ctx.session.id),
      await connectionService.promptSummary(ctx.project),
      await googleAccountService.promptSummary(ctx.project),
      browserEnabled
        ? "Un navigateur headless (Chromium) est disponible via les outils `mcp__playwright__*` : navigue, lis la page (`browser_snapshot`), clique et remplis des formulaires pour tester les interfaces web. Le serveur de développement à tester se lance dans l'environnement du projet ; ses URL en localhost y sont accessibles. Pour te connecter à un site web du projet (connexions de type « site web »), tape le nom de variable d'un secret tel quel dans le champ du formulaire : le navigateur le remplace par la valeur."
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    // La bibliothèque de contexte est exposée deux fois : outils MCP (lecture/écriture) et skills (plugin local).
    const pluginDir = await materializeSkills(ctx.project);
    const allowedTools = cfg.allowedTools ? String(cfg.allowedTools).split(',').map((t) => t.trim()).filter(Boolean) : [];
    // Autorisations mémorisées pour le projet (« ne plus demander dans ce projet »).
    const projectRules = await permissionRuleService.allowedToolsFor(ctx.project.id);
    // Les secrets des sites web (connexions « site web » en mode outils) sont fournis au navigateur, jamais à l'agent.
    let browserServer: Awaited<ReturnType<typeof runner.browserMcpCommand>> | null = null;
    if (browserEnabled) {
      try {
        browserServer = await runner.browserMcpCommand(ctx.project, ctx.cwd, { sessionId: ctx.session.id, secrets: await connectionService.browserSecrets(ctx.project.id) });
      } catch (err) {
        await direct?.dispose().catch(() => undefined);
        throw err;
      }
    }
    const disposeAll = async () => {
      await direct?.dispose().catch((e) => console.error('[connections] nettoyage de l\'accès direct', e));
      await browserServer?.dispose().catch((e) => console.error('[browser] nettoyage des secrets du navigateur', e));
    };
    // Les observations (instantané, capture, console, réseau, attente) sont libres ; les actions passent par les demandes d'autorisation.
    const browserReadTools = ['mcp__playwright__browser_snapshot', 'mcp__playwright__browser_take_screenshot', 'mcp__playwright__browser_console_messages', 'mcp__playwright__browser_network_requests', 'mcp__playwright__browser_wait_for'];
    const options: Options = {
      cwd: ctx.cwd,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      mcpServers: {
        context: createContextMcpServer(ctx.project, ctx.session.id),
        tasks: createTasksMcpServer(ctx.project, ctx.session.id),
        connections: createConnectionsMcpServer({ project: ctx.project, sessionId: ctx.session.id, cwd: ctx.cwd, emit: ctx.emit }),
        ...(googleAccount ? { google: createGoogleMcpServer({ project: ctx.project, account: googleAccount, sessionId: ctx.session.id, cwd: ctx.cwd, emit: ctx.emit }) } : {}),
        // Le serveur hérite de l'environnement du CLI (dans le conteneur). La configuration MCP passe sur la ligne
        // de commande du CLI, visible de tout utilisateur du serveur (ps) : l'environnement du backend n'y figure jamais.
        ...(browserServer ? { playwright: { type: 'stdio' as const, command: browserServer.command, args: browserServer.args, ...(browserServer.env ? { env: browserServer.env } : {}) } } : {}),
      },
      plugins: [{ type: 'local', path: pluginDir, skipMcpDiscovery: true }],
      model,
      fallbackModel: general.fallbackModel ?? undefined,
      env,
      permissionMode: cfg.permissionMode || 'default',
      // Garde-fou du SDK : le mode bypassPermissions doit être explicitement assumé. Toujours vrai ici, car il rend
      // ce mode *disponible* sans l'activer (drapeau --allow-dangerously-skip-permissions du CLI) : c'est la
      // condition pour pouvoir y passer en cours de session (setPermissionMode), choix explicite de l'humain.
      allowDangerouslySkipPermissions: true,
      maxTurns: cfg.maxTurns ? Number(cfg.maxTurns) : general.defaultMaxTurns ?? undefined,
      maxBudgetUsd: cfg.maxBudgetUsd ? Number(cfg.maxBudgetUsd) : general.sessionBudgetUsd ?? undefined,
      // Les outils du contexte et des tâches sont toujours autorisés : leurs effets restent dans la base et sont versionnés.
      // Les outils des connexions passent par canUseTool, qui applique la politique de chaque connexion.
      allowedTools: [...allowedTools, ...projectRules, 'mcp__context', 'mcp__tasks', ...(browserServer ? browserReadTools : []), ...(googleAccount ? googleReadTools(googleAccount) : [])],
      // Reprise de la conversation Claude si la session a déjà tourné.
      resume: ctx.session.externalId ?? undefined,
      // Script de relais qui exécute le CLI dans le conteneur du projet.
      pathToClaudeCodeExecutable: await runner.claudeExecutable(ctx.project),
      abortController,
      stderr: (data) => void ctx.emit('stderr', { text: data.trimEnd() }),
      // Les demandes de permission (et l'outil AskUserQuestion) deviennent des demandes d'intervention humaine.
      canUseTool: this.canUseTool(ctx),
    };

    await ctx.emit('system', {
      message: `Lancement via Claude Agent SDK${options.resume ? ` (reprise de ${options.resume})` : ''}`,
      options: { cwd: options.cwd, project: ctx.project.slug, systemPromptLength: systemPrompt.length, contextPlugin: pluginDir, browser: browserEnabled, browserSecrets: browserServer?.args.includes('--secrets') ?? false, googleAccount: googleAccount?.email ?? null, model: options.model, fallbackModel: options.fallbackModel, authMode: general.authMode, permissionMode: options.permissionMode, maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, allowedTools: options.allowedTools, directConnections: direct?.summary ?? [] },
    });

    const queue = new MessageQueue();
    await ctx.emit('instruction', { text: ctx.initialMessage });
    queue.push(ctx.initialMessage);
    await ctx.setActivity('busy');

    let stream: ReturnType<typeof query>;
    try {
      stream = query({ prompt: queue, options });
    } catch (err) {
      await disposeAll();
      throw err;
    }
    let stopped = false;

    const done: Promise<RunResult> = (async () => {
      let lastResult: SDKResultMessage | undefined;
      let previousModelTotals: Record<string, number> = {};
      try {
        for await (const message of stream) {
          await this.handleMessage(ctx, message);
          if (message.type === 'result') {
            // Fin d'un tour : l'agent attend la prochaine instruction.
            lastResult = message;
            previousModelTotals = await this.recordUsage(ctx, message, previousModelTotals, model ?? 'default');
            await ctx.setActivity('idle');
          }
        }
      } catch (err) {
        if (stopped || err instanceof AbortError) return { exitCode: null };
        return { exitCode: 1, error: (err as Error).message };
      } finally {
        await disposeAll();
      }
      if (stopped) return { exitCode: null };
      if (!lastResult) return { exitCode: 1, error: 'Flux terminé sans message de résultat' };
      if (lastResult.is_error) {
        const detail = lastResult.subtype === 'success' ? lastResult.result : lastResult.errors.join('\n');
        return { exitCode: 1, error: `${lastResult.subtype}${detail ? ` : ${detail}` : ''}` };
      }
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
      async sendMessage(text) {
        await settingsService.assertBudgetAvailable();
        await ctx.emit('instruction', { text });
        queue.push(text);
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
          const next = patch.model ? String(patch.model) : settingsService.claude.defaultModel ?? undefined;
          settingsService.assertModelAllowed(next);
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
  private canUseTool(ctx: RunContext): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
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

        // Outils des connexions : la politique de la connexion décide s'il faut demander.
        if (toolName.startsWith('mcp__connections__')) {
          const decision = await this.connectionPolicy(ctx, toolName, input);
          if (decision === 'allow') return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID };
          if (decision !== 'ask') return { behavior: 'deny', message: decision.message, toolUseID: options.toolUseID };
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
          if (response.scope === 'project') {
            // Mémorisé pour le projet : les prochaines sessions reçoivent la règle dans allowedTools ;
            // la session courante l'applique tout de suite via updatedPermissions.
            const added = await permissionRuleService.addFromSuggestions(ctx.project.id, options.suggestions ?? [], ctx.session.id);
            if (added.length) await ctx.emit('system', { message: `Autorisation mémorisée pour le projet : ${added.map(formatRule).join(', ')}` });
          }
          // Pour les modifications de fichiers, le SDK suggère un changement de mode (acceptEdits) plutôt qu'une
          // règle : updatedPermissions l'applique à la session en cours ; on l'enregistre aussi dans la configuration
          // de la session (affichage, prochain lancement).
          const mode = remember ? suggestedMode(options.suggestions ?? []) : null;
          if (mode && permissionModes.includes(mode as PermissionMode) && mode !== ctx.session.config.permissionMode) {
            await ctx.recordConfig({ permissionMode: mode });
          }
          return {
            behavior: 'allow',
            updatedInput: input,
            updatedPermissions: remember ? options.suggestions : undefined,
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
   * Politique d'une connexion pour un appel d'outil `mcp__connections__*` : `list` est libre ; les
   * autres outils sont autorisés d'office si la connexion n'exige pas d'approbation, sinon soumis à l'humain.
   */
  private async connectionPolicy(ctx: RunContext, toolName: string, input: Record<string, unknown>): Promise<'allow' | 'ask' | { message: string }> {
    const op = toolName.slice('mcp__connections__'.length);
    if (op === 'list') return 'allow';
    const name = typeof input.connection === 'string' ? input.connection : '';
    try {
      const connection = await connectionService.getByName(ctx.project.id, name);
      if (op === 'ssh_run' && typeof input.command === 'string') connectionService.assertCommandAllowed(connection, input.command);
      return connection.requireApproval ? 'ask' : 'allow';
    } catch (err) {
      // Connexion inconnue ou commande hors politique : inutile de déranger l'humain, l'outil renverra l'erreur.
      return { message: (err as Error).message };
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
      const delta = await usageService.recordTotal(ctx.session.id, ctx.project.id, result.total_cost_usd ?? 0, modelTotals, previous, fallbackModel);
      if (delta > 0) await ctx.emit('usage', { deltaUsd: Number(delta.toFixed(6)), totalUsd: result.total_cost_usd });
    } catch (err) {
      console.error('[usage] relevé impossible', err);
    }
    return modelTotals;
  }

  private async handleMessage(ctx: RunContext, message: SDKMessage): Promise<void> {
    if ('session_id' in message && typeof message.session_id === 'string' && message.session_id !== ctx.session.externalId) {
      await ctx.setExternalId(message.session_id);
    }
    await ctx.emit(`claude.${message.type}`, message as unknown as Record<string, unknown>);
  }
}
