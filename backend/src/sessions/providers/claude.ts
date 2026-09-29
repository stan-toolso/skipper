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
import { createContextMcpServer } from '../../context/mcp.js';
import { contextService } from '../../context/service.js';
import { materializeSkills } from '../../context/skills.js';
import { AppError } from '../../errors.js';
import { RequestCancelledError } from '../../requests/service.js';
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
        { key: 'model', label: 'Modèle', type: 'string', required: false, description: 'Ex. sonnet, opus, ou un identifiant complet' },
        {
          key: 'permissionMode',
          label: 'Mode de permissions',
          type: 'select',
          required: false,
          options: permissionModes,
          defaultValue: 'default',
          description: 'En mode default, chaque outil non autorisé génère une demande d\'autorisation à traiter dans l\'interface.',
        },
        { key: 'maxTurns', label: 'Nombre max de tours', type: 'number', required: false },
        { key: 'maxBudgetUsd', label: 'Budget max (USD)', type: 'number', required: false },
        { key: 'allowedTools', label: 'Outils autorisés', type: 'string', required: false, description: 'Liste séparée par des virgules, ex. "Read,Edit,Bash(git:*)"' },
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
  }

  async start(ctx: RunContext): Promise<RunningHandle> {
    const cfg = ctx.session.config as ClaudeConfig;
    if (!ctx.initialMessage) throw new AppError('Une session Claude nécessite une première instruction');

    const abortController = new AbortController();
    // Prompt système : celui du projet, puis la description de la bibliothèque de contexte.
    const systemPrompt = [ctx.project.systemPrompt.trim(), await contextService.promptSummary(ctx.project.id)].filter(Boolean).join('\n\n');
    // La bibliothèque de contexte est exposée deux fois : outils MCP (lecture/écriture) et skills (plugin local).
    const pluginDir = await materializeSkills(ctx.project);
    const allowedTools = cfg.allowedTools ? String(cfg.allowedTools).split(',').map((t) => t.trim()).filter(Boolean) : [];
    const options: Options = {
      cwd: ctx.cwd,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      mcpServers: { context: createContextMcpServer(ctx.project, ctx.session.id) },
      plugins: [{ type: 'local', path: pluginDir, skipMcpDiscovery: true }],
      model: cfg.model || undefined,
      permissionMode: cfg.permissionMode || 'default',
      // Garde-fou du SDK : le mode bypassPermissions doit être explicitement assumé.
      allowDangerouslySkipPermissions: cfg.permissionMode === 'bypassPermissions',
      maxTurns: cfg.maxTurns ? Number(cfg.maxTurns) : undefined,
      maxBudgetUsd: cfg.maxBudgetUsd ? Number(cfg.maxBudgetUsd) : undefined,
      // Les outils du contexte sont toujours autorisés : leurs effets restent dans la base et sont versionnés.
      allowedTools: [...allowedTools, 'mcp__context'],
      // Reprise de la conversation Claude si la session a déjà tourné.
      resume: ctx.session.externalId ?? undefined,
      // Par défaut le SDK utilise le binaire Claude Code qu'il embarque.
      pathToClaudeCodeExecutable: config.claudeBin,
      abortController,
      stderr: (data) => void ctx.emit('stderr', { text: data.trimEnd() }),
      // Les demandes de permission (et l'outil AskUserQuestion) deviennent des demandes d'intervention humaine.
      canUseTool: this.canUseTool(ctx),
    };

    await ctx.emit('system', {
      message: `Lancement via Claude Agent SDK${options.resume ? ` (reprise de ${options.resume})` : ''}`,
      options: { cwd: options.cwd, project: ctx.project.slug, systemPromptLength: systemPrompt.length, contextPlugin: pluginDir, model: options.model, permissionMode: options.permissionMode, maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, allowedTools: options.allowedTools },
    });

    const queue = new MessageQueue();
    await ctx.emit('instruction', { text: ctx.initialMessage });
    queue.push(ctx.initialMessage);
    await ctx.setActivity('busy');

    const stream = query({ prompt: queue, options });
    let stopped = false;

    const done: Promise<RunResult> = (async () => {
      let lastResult: SDKResultMessage | undefined;
      try {
        for await (const message of stream) {
          await this.handleMessage(ctx, message);
          if (message.type === 'result') {
            // Fin d'un tour : l'agent attend la prochaine instruction.
            lastResult = message;
            await ctx.setActivity('idle');
          }
        }
      } catch (err) {
        if (stopped || err instanceof AbortError) return { exitCode: null };
        return { exitCode: 1, error: (err as Error).message };
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
          return {
            behavior: 'allow',
            updatedInput: input,
            updatedPermissions: response.always ? options.suggestions : undefined,
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

  private async handleMessage(ctx: RunContext, message: SDKMessage): Promise<void> {
    if ('session_id' in message && typeof message.session_id === 'string' && message.session_id !== ctx.session.externalId) {
      await ctx.setExternalId(message.session_id);
    }
    await ctx.emit(`claude.${message.type}`, message as unknown as Record<string, unknown>);
  }
}
