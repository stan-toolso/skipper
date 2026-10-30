import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { createOpencodeClient, type Event as OpencodeEvent, type OpencodeClient, type Part, type PermissionRequest, type QuestionRequest } from '@opencode-ai/sdk/v2';
import { liveBrowserService } from '../../browser/live.js';
import { createContextMcpServer } from '../../context/mcp.js';
import { contextService } from '../../context/service.js';
import { materializeSkills } from '../../context/skills.js';
import { AppError } from '../../errors.js';
import { agentGitEnv } from '../../git/agentEnv.js';
import { createGoogleMcpServer } from '../../google/mcp.js';
import { googleAccountService, googleReadTools } from '../../google/service.js';
import { permissionRuleService, suggestedMode, withEditedRules } from '../../permissions/service.js';
import { formatRule, type PermissionRule } from '../../permissions/types.js';
import type { Project } from '../../projects/types.js';
import { RequestCancelledError } from '../../requests/service.js';
import type { PermissionResponse, QuestionResponse } from '../../requests/types.js';
import { runner } from '../../runners/index.js';
import { sessionTag, type BrowserMcpServer } from '../../runners/types.js';
import { claudeSettings } from '../../settings/claude.js';
import { opencodeSettings, splitModel } from '../../settings/opencode.js';
import { usageService } from '../../settings/usage.js';
import { createSharedPagesMcpServer, sharedPagesPrompt } from '../../sharedPages/mcp.js';
import { createTasksMcpServer } from '../../tasks/mcp.js';
import { taskService } from '../../tasks/service.js';
import { createVaultMcpServer, type VaultApproval } from '../../vault/mcp.js';
import { vaultService } from '../../vault/service.js';
import { createWorksessionsMcpServer } from '../../worksessions/mcp.js';
import { attachmentsNote, publicAttachment } from '../attachments.js';
import { sessionIdentityPrompt } from '../identity.js';
import { createSessionsMcpServer, sessionsPromptSummary } from '../mcp.js';
import type { Attachment } from '../types.js';
import { startMcpBridges, type McpBridges, type McpFactory } from './opencodeBridge.js';
import { allowedByRules, claudeQuestions, claudeTool, mcpToolOf, OPENCODE_EDIT_TOOLS, opencodeAnswers, permissionSuggestions, permissionTitle, permissionTool, toolResultData, type OpencodePermissionRequest, type ToolCall } from './opencodeEvents.js';
import { opencodeStateRepository } from './opencodeState.js';
import type { DescribeContext, ProviderDescription, RunContext, RunningHandle, RunResult, SessionProvider } from './provider.js';

/** Modes d'autorisation d'une session OpenCode (les mêmes que ceux de Claude : l'exécuteur les applique aux demandes d'OpenCode). */
const permissionModes = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const;
type OpencodePermissionMode = (typeof permissionModes)[number];

interface OpencodeConfig {
  /** `fournisseur/modèle` ; vide = le modèle par défaut du propriétaire. */
  model?: string;
  permissionMode?: OpencodePermissionMode;
  maxBudgetUsd?: number;
  allowedTools?: string;
}

type Input = Record<string, unknown>;

/** Modèles proposés par le formulaire (tout autre `fournisseur/modèle` se règle comme modèle par défaut dans Paramètres). */
const SUGGESTED_MODELS: { value: string; label: string; description?: string }[] = [
  { value: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (Anthropic)' },
  { value: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5 (Anthropic)' },
  { value: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol (OpenAI)' },
  { value: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash (Google)' },
  { value: 'openrouter/anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 (OpenRouter)' },
  { value: 'opencode/big-pickle', label: 'Big Pickle (OpenCode Zen, gratuit)', description: 'Modèle gratuit d’OpenCode Zen : utilisable sans clé.' },
];

/** Outils du navigateur en lecture, libres ; les actions passent par les demandes d'autorisation. */
const BROWSER_READ_TOOLS = ['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests', 'browser_wait_for'];
/** Retirés quand le coffre saisit des valeurs dans le navigateur : ils reliraient une valeur tapée. */
const BROWSER_FIELD_READERS = ['browser_evaluate', 'browser_run_code'];

/** Outils des serveurs MCP de Skipper autorisés d'office (mêmes règles que pour une session Claude). */
const SKIPPER_FREE_TOOLS = ['mcp__context', 'mcp__tasks', 'mcp__vault', 'mcp__worksessions__list', 'mcp__worksessions__create', 'mcp__sessions__list', 'mcp__sessions__get', 'mcp__sessions__wait', 'mcp__sessions__end', 'mcp__pages__list'];

/** Autorisations d'OpenCode lui-même : lectures et recherches libres, tout le reste demande — à cet exécuteur, qui applique le mode et les règles de la session puis interroge l'humain. */
const BASE_PERMISSION: Record<string, string> = { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', lsp: 'allow', todowrite: 'allow', todoread: 'allow', question: 'allow', skill: 'allow', task: 'allow' };

/** Dossier de configuration partagé par les sessions OpenCode d'un conteneur : le plugin qui cache les secrets du serveur aux commandes de l'agent. */
const CONFIG_DIR = '/tmp/skipper-opencode-config';
const PLUGIN = `// Généré par Skipper : les commandes de l'agent n'héritent pas des secrets du serveur OpenCode.
const HIDDEN = ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'];
export const SkipperPlugin = async () => ({
  'shell.env': async (_input, output) => {
    for (const name of HIDDEN) output.env[name] = '';
  },
});
`;
const SERVER_ENV_KEYS = ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_SHARE', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_ENABLE_QUESTION_TOOL', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'HOME'];
const START_TIMEOUT_MS = 60_000;
const INTERRUPTED_TEXT = '[Request interrupted by user]';

/**
 * Sessions OpenCode : `opencode serve` tourne dans le conteneur du projet (un serveur par session, mot de
 * passe aléatoire, les clés du PROPRIÉTAIRE de la session lues dans son coffre), joint par le SDK OpenCode à
 * travers un relais TCP. Les événements du serveur deviennent les événements du transcript de Skipper (mêmes
 * formes que Claude, noms d'outils compris) ; les demandes d'autorisation et les questions passent par les
 * demandes d'intervention humaine ; les serveurs MCP de Skipper (contexte, tâches, coffre...) sont pontés ;
 * la conversation est reflétée en base après chaque tour, pour reprendre après une recréation du conteneur.
 */
export class OpencodeProvider implements SessionProvider {
  readonly type = 'opencode';

  describe(ctx: DescribeContext = {}): ProviderDescription {
    const user = ctx.opencode ?? null;
    const defaultModel = user?.settings.defaultModel ?? null;
    const known = new Set(SUGGESTED_MODELS.map((m) => m.value));
    const listed = (user?.modelList?.models ?? []).filter((m) => !known.has(m)).map((m) => ({ value: m, label: m }));
    return {
      type: this.type,
      label: 'OpenCode',
      description: 'Session OpenCode interactive (SDK OpenCode), avec le modèle de votre choix : envoyez des instructions à tout moment.',
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
            { value: 'plan', label: 'Réfléchir seulement, sans rien modifier', description: "L'agent « plan » d'OpenCode analyse et propose un plan, sans toucher aux fichiers." },
            { value: 'dontAsk', label: 'Ne jamais me demander', description: 'Les actions non autorisées sont refusées automatiquement.' },
            { value: 'bypassPermissions', label: 'Tout autoriser (risqué)', description: "L'agent agit sans aucune confirmation." },
          ],
        },
        {
          key: 'model',
          label: 'Modèle',
          type: 'select',
          required: false,
          defaultValue: '',
          description: 'Format fournisseur/modèle. Votre modèle par défaut et vos clés se règlent dans Paramètres → OpenCode.',
          options: [{ value: '', label: defaultModel ? `Mon modèle par défaut (${defaultModel})` : 'Mon modèle par défaut (Paramètres → OpenCode)' }, ...SUGGESTED_MODELS, ...listed],
        },
        { key: 'maxBudgetUsd', label: 'Budget maximum (USD)', type: 'number', required: false, advanced: true, description: "L'agent est interrompu au-delà." },
        { key: 'allowedTools', label: 'Outils pré-autorisés', type: 'string', required: false, advanced: true, description: 'Règles au format Claude Code, séparées par des virgules, ex. "Edit,Bash(git *)"' },
      ],
    };
  }

  validateConfig(raw: Record<string, unknown>): void {
    const cfg = raw as OpencodeConfig;
    if (cfg.maxBudgetUsd !== undefined && cfg.maxBudgetUsd !== null && (Number.isNaN(Number(cfg.maxBudgetUsd)) || Number(cfg.maxBudgetUsd) <= 0)) throw new AppError('maxBudgetUsd doit être un nombre positif');
    if (cfg.permissionMode !== undefined && !permissionModes.includes(cfg.permissionMode)) throw new AppError(`permissionMode invalide : ${String(cfg.permissionMode)}`);
    if (cfg.model) splitModel(String(cfg.model));
    // La clé du fournisseur du modèle est vérifiée au démarrage (le propriétaire n'est pas connu ici).
  }

  start(ctx: RunContext): Promise<RunningHandle> {
    return new OpencodeRun(ctx).start();
  }
}

/** Relais TCP du serveur : un port local de Skipper → le port du serveur OpenCode dans le conteneur (`docker exec` par connexion). */
async function startTunnel(project: Project, port: number): Promise<{ port: number; close(): Promise<void> }> {
  const spec = runner.cdpTunnelCommand(project, port);
  const children = new Set<ChildProcess>();
  const server = net.createServer((socket) => {
    const child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(child);
    socket.pipe(child.stdin!);
    child.stdout!.pipe(socket);
    const end = () => {
      children.delete(child);
      socket.destroy();
      if (child.exitCode === null) child.kill();
    };
    child.on('close', end);
    child.on('error', end);
    socket.on('close', end);
    socket.on('error', end);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new AppError('Relais vers le serveur OpenCode impossible');
  return {
    port: address.port,
    async close() {
      for (const c of children) c.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface ToolState {
  tool: string;
  input: Input;
  announced: boolean;
  done: boolean;
}

interface RuleUsage {
  rules: PermissionRule[];
  /** Règles mémorisées « pour la session » (format Claude Code). */
  session: string[];
}

class OpencodeRun {
  private readonly cfg: OpencodeConfig;
  private readonly ownerId: string | null;
  private mode: OpencodePermissionMode;
  private model = '';
  private maxBudgetUsd: number | null = null;
  private systemPrompt = '';
  private mcpServerNames: string[] = [];
  private client!: OpencodeClient;
  private server: ChildProcess | null = null;
  private serverExited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private tunnel: Awaited<ReturnType<typeof startTunnel>> | null = null;
  private bridges: McpBridges | null = null;
  private browserServer: BrowserMcpServer | null = null;
  private browserUsed = false;
  private sessionId = '';
  private readonly dir: string;
  private readonly ruleUsage: RuleUsage = { rules: [], session: [] };
  private readonly allowedTools: string[];
  private readonly vaultApprovals = new Set<string>();

  /** Sessions de cette exécution : la principale et les sous-agents qu'elle a lancés (id enfant → appel `task` qui l'a lancé). */
  private readonly children = new Map<string, string>();
  private readonly tools = new Map<string, ToolState>();
  private readonly emittedParts = new Set<string>();
  private readonly roles = new Map<string, 'user' | 'assistant'>();
  /** Messages d'assistant qui résument la conversation (compaction) : pas des réponses de l'agent. */
  private readonly summaries = new Set<string>();
  /** Coût de chaque message d'assistant (toutes sessions de l'exécution), par modèle. */
  private readonly costs = new Map<string, { cost: number; model: string }>();
  private previousModelTotals: Record<string, number> = {};
  /** Demandes humaines en cours (id de la demande OpenCode → abandon de la demande Skipper). */
  private readonly asking = new Map<string, AbortController>();

  private busy = false;
  private turnStartedAt = Date.now();
  private turnSteps = 0;
  private lastText = '';
  private turnError: string | null = null;
  private interrupted = false;
  private contextTokens: number | null = null;
  private endRequested = false;
  private stopped = false;
  private finished = false;
  private resolveDone!: (r: RunResult) => void;
  private readonly done = new Promise<RunResult>((resolve) => (this.resolveDone = resolve));
  private resolveConnected!: () => void;
  private readonly connected = new Promise<void>((resolve) => (this.resolveConnected = resolve));

  constructor(private readonly ctx: RunContext) {
    this.cfg = ctx.session.config as OpencodeConfig;
    this.ownerId = ctx.session.ownerId;
    this.mode = this.cfg.permissionMode && permissionModes.includes(this.cfg.permissionMode) ? this.cfg.permissionMode : 'default';
    this.allowedTools = this.cfg.allowedTools ? String(this.cfg.allowedTools).split(',').map((t) => t.trim()).filter(Boolean) : [];
    this.dir = `/tmp/${sessionTag(ctx.session.id)}-opencode`;
  }

  async start(): Promise<RunningHandle> {
    const { ctx } = this;
    if (!ctx.initialMessage) throw new AppError('Une session OpenCode nécessite une première instruction');
    try {
      await this.boot();
    } catch (err) {
      await this.dispose();
      throw err;
    }
    void this.consume();
    void this.serverExited!.then(({ code, signal }) => {
      if (this.stopped || ctx.isServerStopping()) return this.finish({ exitCode: null, closedByServer: true });
      return this.finish({ exitCode: 1, error: `Le serveur OpenCode s'est arrêté (${signal ? `signal ${signal}` : `code ${code}`}) ; conteneur à court de mémoire ?` });
    });
    await Promise.race([this.connected, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    await this.prompt(ctx.initialMessage, ctx.initialAttachments, ctx.initialPreamble);
    return this.handle();
  }

  // ---- Démarrage -------------------------------------------------------------------------------

  private async boot(): Promise<void> {
    const { ctx } = this;
    // Réglages du propriétaire : clés (coffre), modèle, budget par session, plafond mensuel.
    const owner = await opencodeSettings.forSession(this.ownerId);
    await (await claudeSettings.forSession(this.ownerId)).assertBudgetAvailable();
    this.model = owner.resolveModel(this.cfg.model);
    this.maxBudgetUsd = this.cfg.maxBudgetUsd ? Number(this.cfg.maxBudgetUsd) : (owner.settings.sessionBudgetUsd ?? null);
    const actor = { sessionId: ctx.session.id, projectId: ctx.project.id };
    const auth = await owner.authContent(actor, splitModel(this.model).providerID);

    // Même portée qu'une session Claude : coffre, comptes Google, contexte, tâches, prompt système.
    const browserEnabled = Boolean((ctx.project.runnerConfig as { browser?: boolean } | null)?.browser);
    const vaultItems = await vaultService.agentItems(ctx.project.id, this.ownerId);
    const vaultTools = vaultItems.some((i) => i.kind !== 'google');
    const vaultBrowser = vaultItems.some((i) => i.kind === 'website' || i.kind === 'secret');
    const googleAccounts = await googleAccountService.accountsFor(ctx.project.id, this.ownerId);
    this.systemPrompt = [
      ctx.project.systemPrompt.trim(),
      sessionIdentityPrompt(ctx.session, ctx.project),
      await contextService.promptSummary(ctx.project.id),
      await taskService.linkedTaskPrompt(ctx.session.id),
      await taskService.promptSummary(ctx.project.id, ctx.session.id),
      vaultService.promptSummary(vaultItems, ctx.project),
      sessionsPromptSummary(ctx.project),
      googleAccountService.promptSummary(googleAccounts),
      sharedPagesPrompt(),
      browserEnabled
        ? "Un navigateur headless (Chromium) est disponible via les outils `playwright_*` : navigue, lis la page (`playwright_browser_snapshot`), clique et remplis des formulaires pour tester les interfaces web. Le serveur de développement à tester se lance dans l'environnement du projet ; ses URL en localhost y sont accessibles. Pour te connecter à un site web du coffre, clique le champ du formulaire puis appelle `vault_browser_fill` : Skipper y saisit la valeur, que tu ne vois jamais."
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const pluginDir = await materializeSkills(ctx.project);
    this.ruleUsage.rules = await permissionRuleService.list(ctx.project.id);

    const vaultContext = {
      project: ctx.project,
      sessionId: ctx.session.id,
      ownerId: this.ownerId,
      cwd: ctx.cwd,
      emit: ctx.emit,
      remembered: async (toolName: string, key: string, projectRules: boolean) => {
        if (this.vaultApprovals.has(`${toolName}|${key.toLowerCase()}`)) return true;
        return projectRules && this.ruleUsage.rules.some((r) => r.toolName === toolName && r.ruleContent?.trim().toLowerCase() === key.toLowerCase());
      },
      approve: (approval: VaultApproval) => this.approveVaultUse(approval),
    };
    const factories: Record<string, McpFactory> = {
      context: () => createContextMcpServer(ctx.project, ctx.session.id),
      tasks: () => createTasksMcpServer(ctx.project, ctx.session.id, ctx.session.name),
      ...(vaultTools ? { vault: () => createVaultMcpServer(vaultContext) } : {}),
      worksessions: () => createWorksessionsMcpServer(ctx.project, ctx.session.id),
      sessions: () => createSessionsMcpServer(ctx.project, ctx.session.id),
      pages: () => createSharedPagesMcpServer({ project: ctx.project, session: ctx.session, cwd: ctx.cwd }),
      ...(googleAccounts.length ? { google: () => createGoogleMcpServer({ project: ctx.project, accounts: googleAccounts, sessionId: ctx.session.id, cwd: ctx.cwd, emit: ctx.emit }) } : {}),
    };
    // Le navigateur ne reçoit aucun secret à l'avance : le coffre les saisit à la demande (browser_fill).
    if (browserEnabled) {
      this.browserServer = await runner.browserMcpCommand(ctx.project, ctx.cwd, { sessionId: ctx.session.id });
      liveBrowserService.register(ctx.session.id, ctx.project, this.browserServer.cdp);
    }
    this.bridges = await startMcpBridges(await runner.hostAddress(ctx.project), factories, (server, err) => void ctx.emit('stderr', { text: `[mcp ${server}] ${err.message}` }));
    this.mcpServerNames = [...Object.keys(factories), ...(this.browserServer ? ['playwright'] : [])];
    const googleFree = googleAccounts.length ? googleReadTools(googleAccounts) : [];
    this.ruleUsage.session.push(...googleFree);

    const permission: Record<string, string> = { ...BASE_PERMISSION };
    if (this.browserServer) for (const t of BROWSER_READ_TOOLS) permission[`playwright_${t}`] = 'allow';
    if (this.browserServer && vaultBrowser) for (const t of BROWSER_FIELD_READERS) permission[`playwright_${t}`] = 'deny';
    const config = {
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      model: this.model,
      permission,
      mcp: {
        ...this.bridges.config,
        ...(this.browserServer ? { playwright: { type: 'local', command: [this.browserServer.command, ...this.browserServer.args], enabled: true, ...(this.browserServer.env ? { environment: this.browserServer.env } : {}) } } : {}),
      },
      skills: { paths: [`${pluginDir}/skills`] },
    };
    await runner.putFile(ctx.project, `${CONFIG_DIR}/plugin/skipper.js`, PLUGIN);
    const password = randomBytes(24).toString('base64url');
    const env: Record<string, string> = {
      HOME: `${this.dir}/home`,
      XDG_DATA_HOME: `${this.dir}/data`,
      XDG_CONFIG_HOME: `${this.dir}/config`,
      XDG_STATE_HOME: `${this.dir}/state`,
      XDG_CACHE_HOME: '/tmp/skipper-opencode-cache',
      OPENCODE_CONFIG_DIR: CONFIG_DIR,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_AUTH_CONTENT: JSON.stringify(auth),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_SHARE: '1',
      // Le opencode.json du dépôt pourrait tout autoriser : les autorisations sont celles de la session.
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_ENABLE_QUESTION_TOOL: '1',
      OPENCODE_SERVER_PASSWORD: password,
      ...(await agentGitEnv(this.ownerId, ctx.project.gitUrl, actor)),
    };

    // Session connue de Skipper mais absente de ce conteneur (recréé) : sa conversation est réimportée d'abord.
    const resumeId = ctx.session.externalId;
    const marker = `${this.dir}/.skipper`;
    const present = await runner.getFile(ctx.project, marker).then(() => true, () => false);
    if (resumeId && !present) await this.importState(resumeId, env);
    await runner.putFile(ctx.project, marker, ctx.session.id);

    await this.startServer(env, password);
    const health = await this.client.global.health().catch(() => null);
    const version = (health?.data as { version?: string } | undefined)?.version ?? '';

    let resumed = false;
    if (resumeId) {
      const existing = await this.client.session.get({ sessionID: resumeId });
      if (existing.data) {
        this.sessionId = resumeId;
        resumed = true;
        await this.loadCosts();
      } else await ctx.emit('system', { notice: true, message: "La conversation OpenCode précédente n'a pas pu être reprise : la session repart d'une conversation neuve." });
    }
    if (!this.sessionId) {
      const created = await this.client.session.create({ title: ctx.session.name.slice(0, 100) });
      if (!created.data) throw new AppError(`OpenCode n'a pas créé la session : ${describeError(created.error)}`);
      this.sessionId = created.data.id;
    }
    if (this.sessionId !== ctx.session.externalId) {
      ctx.session.externalId = this.sessionId;
      await ctx.setExternalId(this.sessionId);
    }

    await ctx.emit('system', {
      message: `Lancement via le SDK OpenCode${resumed ? ` (reprise de ${this.sessionId})` : ''}`,
      options: { cwd: ctx.cwd, project: ctx.project.slug, systemPromptLength: this.systemPrompt.length, contextPlugin: pluginDir, mcpServers: this.mcpServerNames, browser: browserEnabled, vaultItems: vaultItems.map((i) => i.name), googleAccounts: googleAccounts.map((a) => a.email), model: this.model, providers: Object.keys(auth), permissionMode: this.mode, maxBudgetUsd: this.maxBudgetUsd, allowedTools: [...this.allowedTools, ...this.ruleUsage.rules.map(formatRule)], owner: this.ownerId },
    });
    await ctx.emit('claude.system', { subtype: 'init', opencode_version: version, model: this.model, cwd: ctx.cwd, session_id: this.sessionId, tools: [], mcp_servers: this.mcpServerNames.map((name) => ({ name, status: 'connected' })) });
  }

  /** Lance `opencode serve` dans le conteneur et ouvre le relais ; `client` vise le relais. */
  private async startServer(env: Record<string, string>, password: string): Promise<void> {
    const { ctx } = this;
    const spec = await runner.opencodeCommand(ctx.project, ctx.cwd, SERVER_ENV_KEYS.concat(Object.keys(env).filter((k) => k.startsWith('GIT') || k.startsWith('GH_'))));
    const child = spawn(spec.command, [...spec.args, 'serve', '--hostname=127.0.0.1', '--port=0'], { cwd: ctx.cwd, env: { ...process.env, ...spec.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.server = child;
    this.serverExited = new Promise((resolve) => {
      child.on('error', () => resolve({ code: null, signal: null }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    const output: string[] = [];
    createInterface({ input: child.stderr! }).on('line', (line) => {
      output.push(line);
      if (output.length > 20) output.shift();
      void ctx.emit('stderr', { text: line }).catch(() => undefined);
    });
    let port: number;
    try {
      port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`pas de réponse après ${START_TIMEOUT_MS / 1000} s`)), START_TIMEOUT_MS);
        createInterface({ input: child.stdout! }).on('line', (line) => {
          const m = /opencode server listening on https?:\/\/[^\s:]+:(\d+)/.exec(line);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          } else if (line.trim()) output.push(line);
        });
        void this.serverExited!.then(({ code }) => {
          clearTimeout(timer);
          reject(new Error(`processus terminé (code ${code})${output.length ? ` : ${output.slice(-5).join(' ')}` : ''}`));
        });
      });
    } catch (err) {
      throw new AppError(`Le serveur OpenCode n'a pas démarré : ${(err as Error).message}. OpenCode est-il installé dans l'image des environnements ?`);
    }
    this.tunnel = await startTunnel(ctx.project, port);
    this.client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${this.tunnel.port}`, directory: ctx.cwd, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  }

  /** Reconstruit la session depuis le miroir de Skipper (`opencode import`) ; un échec repart d'une conversation neuve. */
  private async importState(opencodeId: string, env: Record<string, string>): Promise<void> {
    const { ctx } = this;
    try {
      const state = await opencodeStateRepository.load(ctx.session.id, opencodeId);
      if (!state) return;
      const file = `${this.dir}/import.json`;
      await runner.putFile(ctx.project, file, JSON.stringify(state));
      const spec = await runner.opencodeCommand(ctx.project, ctx.cwd, SERVER_ENV_KEYS);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(spec.command, [...spec.args, 'import', file], { env: { ...process.env, ...spec.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`opencode import a échoué (code ${code}) : ${out.trim().split('\n').slice(-3).join(' ')}`))));
      });
      await runner.removePath(ctx.project, file);
    } catch (err) {
      console.warn(`[opencode] import de la session ${ctx.session.id} impossible : ${(err as Error).message}`);
    }
  }

  /** Coûts déjà dépensés par une session reprise : le relevé compare des totaux cumulés. */
  private async loadCosts(): Promise<void> {
    const res = await this.client.session.messages({ sessionID: this.sessionId }).catch(() => null);
    for (const m of res?.data ?? []) {
      if (m.info.role === 'assistant') this.costs.set(m.info.id, { cost: m.info.cost ?? 0, model: `${m.info.providerID}/${m.info.modelID}` });
    }
    this.previousModelTotals = this.modelTotals();
  }

  // ---- Instructions ------------------------------------------------------------------------------

  /** Journalise l'instruction et l'envoie : texte, note des pièces jointes, images et PDF en parties fichier. */
  private async prompt(text: string, attachments: Attachment[], preamble?: string | null): Promise<void> {
    const { ctx } = this;
    this.beginTurn();
    await ctx.emit('instruction', { text, ...(attachments.length ? { attachments: attachments.map(publicAttachment) } : {}), ...(preamble ? { preamble: true } : {}) });
    await ctx.setActivity('busy');
    // Le nettoyage du contexte demande une compaction : OpenCode résume la conversation.
    if (text.trim() === '/compact' && !attachments.length) {
      const res = await this.client.session.summarize({ sessionID: this.sessionId, ...splitModel(this.model) });
      if (res.error) throw new AppError(`Compaction OpenCode impossible : ${describeError(res.error)}`);
      return;
    }
    const body = preamble ? `${preamble}\n\n${text}` : text;
    const parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; filename: string; url: string }> = [{ type: 'text', text: attachments.length ? `${body}\n\n${attachmentsNote(attachments)}` : body }];
    for (const a of attachments) {
      if (a.mediaType.startsWith('image/') || a.mediaType === 'application/pdf') parts.push({ type: 'file', mime: a.mediaType, filename: a.name, url: `file://${a.path}` });
    }
    const res = await this.client.session.promptAsync({ sessionID: this.sessionId, model: splitModel(this.model), agent: this.mode === 'plan' ? 'plan' : 'build', system: this.systemPrompt || undefined, parts });
    if (res.error) throw new AppError(`OpenCode a refusé l'instruction : ${describeError(res.error)}`);
  }

  private beginTurn(): void {
    if (this.busy) return;
    this.busy = true;
    this.turnStartedAt = Date.now();
    this.turnSteps = 0;
    this.lastText = '';
    this.turnError = null;
    this.interrupted = false;
  }

  private handle(): RunningHandle {
    return {
      wait: () => this.done,
      stop: async () => {
        this.stopped = true;
        if (this.busy) await this.client.session.abort({ sessionID: this.sessionId }).catch(() => undefined);
        await this.finish({ exitCode: null, closedByServer: true });
      },
      sendMessage: async (text, attachments = []) => {
        if (this.finished || this.endRequested) throw new AppError("La session n'accepte plus d'instructions");
        await (await claudeSettings.forSession(this.ownerId)).assertBudgetAvailable();
        await this.prompt(text, attachments);
      },
      end: async () => {
        this.endRequested = true;
        if (!this.busy) await this.finish({ exitCode: 0 });
      },
      interrupt: async () => {
        this.interrupted = true;
        await this.client.session.abort({ sessionID: this.sessionId });
      },
      // Changements à chaud : appliqués à la prochaine demande ou instruction.
      updateConfig: async (patch) => {
        const applied: string[] = [];
        if ('permissionMode' in patch) {
          const mode = (patch.permissionMode || 'default') as OpencodePermissionMode;
          if (!permissionModes.includes(mode)) throw new AppError(`permissionMode invalide : ${String(mode)}`);
          this.mode = mode;
          applied.push('permissionMode');
        }
        if ('model' in patch) {
          const owner = await opencodeSettings.forSession(this.ownerId);
          this.model = owner.resolveModel(patch.model ? String(patch.model) : null);
          applied.push('model');
        }
        return applied;
      },
    };
  }

  // ---- Flux d'événements -------------------------------------------------------------------------

  private async consume(): Promise<void> {
    let connections = 0;
    try {
      const sse = await this.client.event.subscribe(undefined, { sseMaxRetryAttempts: 5 } as never);
      for await (const event of sse.stream as AsyncIterable<OpencodeEvent>) {
        if (this.finished) break;
        if ((event.type as string) === 'server.connected') {
          this.resolveConnected();
          if (++connections > 1) void this.resync();
        }
        try {
          await this.onEvent(event);
        } catch (err) {
          console.error(`[opencode] événement ${event.type} de la session ${this.ctx.session.id}`, err);
        }
      }
    } catch (err) {
      if (!this.finished) console.warn(`[opencode] flux d'événements perdu pour la session ${this.ctx.session.id} : ${(err as Error).message}`);
    }
    // Le flux se termine avec le serveur : sa fin termine l'exécution (voir start()).
  }

  /** Après une reconnexion du flux : les demandes ouvertes entre-temps sont reprises. */
  private async resync(): Promise<void> {
    const [permissions, questions] = await Promise.all([this.client.permission.list().catch(() => null), this.client.question.list().catch(() => null)]);
    for (const p of permissions?.data ?? []) if (this.ours(p.sessionID) && !this.asking.has(p.id)) void this.onPermission(p);
    for (const q of questions?.data ?? []) if (this.ours(q.sessionID) && !this.asking.has(q.id)) void this.onQuestion(q);
  }

  private ours(sessionId: string | undefined): boolean {
    return Boolean(sessionId) && (sessionId === this.sessionId || this.children.has(sessionId!));
  }

  /** L'appel `task` qui a lancé un sous-agent (null pour la session principale). */
  private parentCall(sessionId: string): string | null {
    return sessionId === this.sessionId ? null : this.children.get(sessionId) || null;
  }

  private async onEvent(event: OpencodeEvent): Promise<void> {
    const { ctx } = this;
    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        const info = event.properties.info;
        if (info.parentID && this.ours(info.parentID) && !this.children.has(info.id)) this.children.set(info.id, this.children.get(info.id) ?? '');
        return;
      }
      case 'message.updated': {
        const info = event.properties.info;
        if (!this.ours(info.sessionID)) return;
        this.roles.set(info.id, info.role);
        if (info.role === 'assistant') {
          if (info.summary) this.summaries.add(info.id);
          this.costs.set(info.id, { cost: info.cost ?? 0, model: `${info.providerID}/${info.modelID}` });
          if (info.error && info.sessionID === this.sessionId) this.onError(info.error);
          await this.checkBudget();
        }
        return;
      }
      case 'message.part.updated':
        if (this.ours(event.properties.part.sessionID)) await this.onPart(event.properties.part);
        return;
      case 'permission.asked':
        if (this.ours(event.properties.sessionID)) void this.onPermission(event.properties as PermissionRequest);
        return;
      case 'permission.replied':
        this.asking.get(event.properties.requestID)?.abort();
        return;
      case 'question.asked':
        if (this.ours(event.properties.sessionID)) void this.onQuestion(event.properties as QuestionRequest);
        return;
      case 'question.replied':
      case 'question.rejected':
        this.asking.get(event.properties.requestID)?.abort();
        return;
      case 'session.status': {
        if (event.properties.sessionID !== this.sessionId) return;
        const status = event.properties.status;
        if (status.type === 'busy' && !this.busy) {
          this.beginTurn();
          await ctx.setActivity('busy');
        } else if (status.type === 'retry') await ctx.emit('system', { message: `Nouvelle tentative n° ${status.attempt} : ${status.message}` });
        return;
      }
      case 'session.error':
        if (event.properties.sessionID === this.sessionId && event.properties.error) this.onError(event.properties.error);
        return;
      case 'session.idle':
        if (event.properties.sessionID === this.sessionId && this.busy) await this.endTurn();
        return;
      default:
        return;
    }
  }

  private onError(error: { name: string; data?: { message?: unknown } }): void {
    if (error.name === 'MessageAbortedError') {
      this.interrupted = true;
      return;
    }
    this.turnError = typeof error.data?.message === 'string' && error.data.message ? `${error.name} : ${error.data.message}` : error.name;
  }

  private async onPart(part: Part): Promise<void> {
    const { ctx } = this;
    const parent = this.parentCall(part.sessionID);
    const main = part.sessionID === this.sessionId;
    switch (part.type) {
      case 'text': {
        // Texte de l'agent, une fois complet (les parties texte du prompt appartiennent aux messages de l'humain).
        if (!main || part.synthetic || part.ignored || !part.time?.end || this.roles.get(part.messageID) === 'user' || this.summaries.has(part.messageID) || this.emittedParts.has(part.id) || !part.text.trim()) return;
        this.emittedParts.add(part.id);
        this.lastText = part.text;
        await ctx.emit('claude.assistant', { message: { role: 'assistant', content: [{ type: 'text', text: part.text }] }, parent_tool_use_id: null, session_id: this.sessionId });
        return;
      }
      case 'reasoning': {
        if (!main || !part.time?.end || this.summaries.has(part.messageID) || this.emittedParts.has(part.id) || !part.text.trim()) return;
        this.emittedParts.add(part.id);
        await ctx.emit('claude.assistant', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: part.text }] }, parent_tool_use_id: null, session_id: this.sessionId });
        return;
      }
      case 'tool':
        await this.onToolPart(part, parent);
        return;
      case 'step-finish':
        if (!main) return;
        this.turnSteps += 1;
        this.contextTokens = part.tokens.input + part.tokens.cache.read + part.tokens.cache.write;
        return;
      case 'compaction':
        if (main && !this.emittedParts.has(part.id)) {
          this.emittedParts.add(part.id);
          await ctx.emit('claude.system', { subtype: 'compact_boundary', compact_metadata: { trigger: part.auto ? 'auto' : 'manual', pre_tokens: this.contextTokens ?? undefined } });
        }
        return;
      case 'retry':
        if (main && !this.emittedParts.has(part.id)) {
          this.emittedParts.add(part.id);
          await ctx.emit('system', { message: `Nouvelle tentative n° ${part.attempt} après une erreur du fournisseur : ${part.error.data.message}` });
        }
        return;
      default:
        return;
    }
  }

  /** Un appel d'outil : annoncé (`tool_use`) dès que son entrée est connue, puis son résultat (`tool_result`). */
  private async onToolPart(part: Extract<Part, { type: 'tool' }>, parent: string | null): Promise<void> {
    const { ctx } = this;
    const state = part.state;
    let call = this.tools.get(part.callID);
    if (!call) {
      call = { tool: part.tool, input: {}, announced: false, done: false };
      this.tools.set(part.callID, call);
    }
    if (state.input && Object.keys(state.input).length) call.input = state.input;
    // Session d'un sous-agent : ses appels sont rattachés à l'appel `task` qui l'a lancé.
    if (part.tool === 'task') {
      const child = (state as { metadata?: { sessionId?: unknown } }).metadata?.sessionId;
      if (typeof child === 'string') this.children.set(child, part.callID);
    }
    if (state.status === 'pending' || call.done) return;
    const mapped = claudeTool(part.tool, call.input, this.mcpServerNames);
    if (!call.announced) {
      call.announced = true;
      await ctx.emit('claude.assistant', { message: { role: 'assistant', content: [{ type: 'tool_use', id: part.callID, name: mapped.name, input: mapped.input }] }, parent_tool_use_id: parent, session_id: this.sessionId });
      if (!this.browserUsed && part.tool.startsWith('playwright_')) {
        this.browserUsed = true;
        liveBrowserService.markUsed(ctx.session.id);
      }
      // Un outil autorisé d'office par une règle du projet compte pour cette règle.
      if (this.ruleUsage.rules.length) await permissionRuleService.recordUse(this.ruleUsage.rules, mapped.name, mapped.input, ctx.cwd).catch(() => undefined);
    }
    if (state.status !== 'completed' && state.status !== 'error') return;
    call.done = true;
    const isError = state.status === 'error';
    const output = isError ? state.error : state.output;
    const data = isError ? {} : toolResultData(part.tool, call.input, state.output, state.metadata ?? {});
    await ctx.emit('claude.user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: part.callID, content: output, is_error: isError }] }, tool_use_result: data, parent_tool_use_id: parent, session_id: this.sessionId });
  }

  // ---- Tours -------------------------------------------------------------------------------------

  private modelTotals(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const { cost, model } of this.costs.values()) totals[model] = (totals[model] ?? 0) + cost;
    return totals;
  }

  private totalCost(): number {
    let total = 0;
    for (const { cost } of this.costs.values()) total += cost;
    return total;
  }

  /** Budget de la session : l'agent est interrompu, et l'exécution se termine en erreur, au-delà. */
  private async checkBudget(): Promise<void> {
    if (!this.maxBudgetUsd || this.turnError?.startsWith('Budget') || this.totalCost() < this.maxBudgetUsd) return;
    this.turnError = `Budget de la session atteint (${this.totalCost().toFixed(2)} $ sur ${this.maxBudgetUsd.toFixed(2)} $)`;
    this.endRequested = true;
    await this.client.session.abort({ sessionID: this.sessionId }).catch(() => undefined);
  }

  private async endTurn(): Promise<void> {
    const { ctx } = this;
    this.busy = false;
    // Le tour suivant peut commencer pendant les attentes ci-dessous : l'état de celui-ci est lu maintenant.
    const turn = { error: this.turnError, interrupted: this.interrupted, text: this.lastText, startedAt: this.turnStartedAt, steps: this.turnSteps };
    // Appels coupés par une interruption : fermés, pour que le transcript ne les montre pas en cours.
    const cut = [...this.tools].filter(([, call]) => call.announced && !call.done);
    for (const [, call] of cut) call.done = true;
    for (const [callID] of cut) {
      await ctx.emit('claude.user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callID, content: 'Interrompu', is_error: true }] }, tool_use_result: {}, parent_tool_use_id: null, session_id: this.sessionId });
    }
    const total = this.totalCost();
    if (turn.interrupted && !turn.error) {
      await ctx.emit('claude.user', { message: { role: 'user', content: [{ type: 'text', text: INTERRUPTED_TEXT }] }, parent_tool_use_id: null, session_id: this.sessionId });
    } else {
      await ctx.emit('claude.result', {
        subtype: turn.error ? 'error_during_execution' : 'success',
        is_error: Boolean(turn.error),
        ...(turn.error ? { errors: [turn.error] } : { result: turn.text }),
        duration_ms: Date.now() - turn.startedAt,
        num_turns: turn.steps,
        total_cost_usd: total,
        session_id: this.sessionId,
      });
    }
    const modelTotals = this.modelTotals();
    try {
      const delta = await usageService.recordTotal(ctx.session.id, ctx.project.id, this.ownerId, total, modelTotals, this.previousModelTotals, this.model);
      if (delta > 0) await ctx.emit('usage', { deltaUsd: Number(delta.toFixed(6)), totalUsd: total });
    } catch (err) {
      console.error('[usage] relevé impossible', err);
    }
    this.previousModelTotals = modelTotals;
    if (this.contextTokens !== null) await ctx.setContextTokens?.(this.contextTokens).catch(() => undefined);
    const failed = turn.error?.startsWith('Budget') ? turn.error : null;
    if (failed) return this.finish({ exitCode: 1, error: failed });
    if (this.endRequested) return this.finish({ exitCode: 0 });
    // Une instruction envoyée entre-temps a déjà commencé le tour suivant.
    if (!this.busy) await ctx.setActivity('idle');
    await this.saveState();
  }

  /** Reflète la session en base (conversation complète) ; ne casse jamais la session. */
  private async saveState(): Promise<void> {
    if (!this.server || this.finished) return;
    try {
      const [info, messages] = await Promise.all([this.client.session.get({ sessionID: this.sessionId }), this.client.session.messages({ sessionID: this.sessionId })]);
      if (info.data && messages.data) await opencodeStateRepository.save(this.ctx.session.id, this.sessionId, { info: info.data as unknown as Record<string, unknown>, messages: messages.data as unknown as { info: Record<string, unknown>; parts: unknown[] }[] });
    } catch (err) {
      console.warn(`[opencode] miroir de la session ${this.ctx.session.id} impossible : ${(err as Error).message}`);
    }
  }

  // ---- Demandes humaines -------------------------------------------------------------------------

  /** Une demande d'autorisation d'OpenCode : mode de la session, règles, puis l'humain. */
  private async onPermission(req: PermissionRequest): Promise<void> {
    const request = req as unknown as OpencodePermissionRequest;
    const known = request.tool ? this.tools.get(request.tool.callID) : undefined;
    const reply = (decision: 'once' | 'reject', message?: string) => this.client.permission.reply({ requestID: req.id, reply: decision, ...(message ? { message } : {}) }).catch((err) => console.warn(`[opencode] réponse impossible : ${(err as Error).message}`));
    const tool = permissionTool(request, known ? { tool: known.tool, input: known.input } : null, this.mcpServerNames);
    const abort = new AbortController();
    this.asking.set(req.id, abort);
    try {
      const decision = await this.decide(tool, { isEdit: request.permission === 'edit' || OPENCODE_EDIT_TOOLS.has(known?.tool ?? ''), useRules: request.permission !== 'doom_loop', suggestions: permissionSuggestions(request, tool), title: permissionTitle(request), blockedPath: request.permission === 'external_directory' ? (request.patterns[0] ?? null) : null }, abort.signal);
      await (decision === true ? reply('once') : reply('reject', decision));
    } catch (err) {
      if (err instanceof RequestCancelledError) {
        // Déjà réglée côté OpenCode (session interrompue) : rien à ajouter.
        if (!abort.signal.aborted) await reply('reject', 'Demande annulée (session arrêtée ou demande abandonnée)');
        return;
      }
      console.error(`[opencode] demande d'autorisation de la session ${this.ctx.session.id}`, err);
      await reply('reject', "Erreur de Skipper pendant la demande d'autorisation");
    } finally {
      this.asking.delete(req.id);
    }
  }

  /**
   * Décision sur un appel d'outil, comme `canUseTool` pour Claude : mode de la session, règles (outils
   * pré-autorisés, règles du projet, réponses « pour la session », outils libres des serveurs de Skipper),
   * puis l'humain. Renvoie true si autorisé, sinon le motif du refus.
   */
  private async decide(tool: ToolCall, opts: { isEdit: boolean; useRules: boolean; suggestions: unknown[]; title: string | null; blockedPath: string | null }, signal: AbortSignal): Promise<true | string> {
    const { ctx } = this;
    if (this.mode === 'bypassPermissions') return true;
    if (this.mode === 'acceptEdits' && opts.isEdit) return true;
    if (opts.useRules && allowedByRules([...this.allowedTools, ...this.ruleUsage.rules.map(formatRule), ...this.ruleUsage.session, ...SKIPPER_FREE_TOOLS], tool, ctx.cwd)) return true;
    if (this.mode === 'dontAsk') return "Action non autorisée à l'avance : la session ne pose pas de question (mode « ne jamais demander »).";

    const response = (await ctx.ask({ type: 'permission', title: opts.title ?? `Autoriser l'outil ${tool.name}`, message: null, payload: { toolName: tool.name, input: tool.input, suggestions: opts.suggestions, blockedPath: opts.blockedPath } }, signal)) as Partial<PermissionResponse>;
    if (response.decision !== 'allow') return response.message || "Refusé par l'utilisateur";

    const remember = response.scope === 'project' || response.scope === 'session' || response.always === true;
    if (remember) {
      const edited = Array.isArray(response.rules) ? withEditedRules(opts.suggestions, response.rules.map(String)) : opts.suggestions;
      if (response.scope === 'project') {
        const added = await permissionRuleService.addFromSuggestions(ctx.project.id, edited, ctx.session.id);
        if (added.length) await ctx.emit('system', { message: `Autorisation mémorisée pour le projet : ${[...new Set(added.map(formatRule))].join(', ')}` });
        this.ruleUsage.rules = await permissionRuleService.list(ctx.project.id);
      } else {
        for (const s of edited as Array<{ type?: string; rules?: Array<{ toolName?: string; ruleContent?: string | null }> }>) {
          if (s.type === 'addRules') for (const r of s.rules ?? []) if (r.toolName) this.ruleUsage.session.push(formatRule({ toolName: r.toolName, ruleContent: r.ruleContent }));
        }
      }
      const mode = suggestedMode(edited);
      if (mode && permissionModes.includes(mode as OpencodePermissionMode) && mode !== this.mode) {
        this.mode = mode as OpencodePermissionMode;
        await ctx.recordConfig({ permissionMode: mode });
      }
    }
    return true;
  }

  /** Approbation humaine d'un usage du coffre (élément « avec approbation », saisie d'un secret dans le navigateur). */
  private async approveVaultUse(approval: VaultApproval): Promise<void> {
    const { ctx } = this;
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
    if (remember) this.vaultApprovals.add(`${approval.toolName}|${approval.key.toLowerCase()}`);
    if (response.scope === 'project' && approval.projectRules) {
      const added = await permissionRuleService.addFromSuggestions(ctx.project.id, suggestions, ctx.session.id);
      if (added.length) await ctx.emit('system', { message: `Autorisation mémorisée pour le projet : ${[...new Set(added.map(formatRule))].join(', ')}` });
      this.ruleUsage.rules = await permissionRuleService.list(ctx.project.id);
    }
  }

  /** Une question de l'agent (outil question) → demande de question ; les réponses reviennent à OpenCode. */
  private async onQuestion(req: QuestionRequest): Promise<void> {
    const { ctx } = this;
    const abort = new AbortController();
    this.asking.set(req.id, abort);
    try {
      const questions = claudeQuestions(req.questions);
      const response = (await ctx.ask({ type: 'question', title: questions.length === 1 ? questions[0].question : `${questions.length} questions de l'agent`, payload: { toolName: 'AskUserQuestion', questions } }, abort.signal)) as Partial<QuestionResponse>;
      await this.client.question.reply({ requestID: req.id, answers: opencodeAnswers(req.questions, (response.answers ?? {}) as Input) });
    } catch (err) {
      if (!(err instanceof RequestCancelledError)) console.error(`[opencode] question de la session ${ctx.session.id}`, err);
      if (!abort.signal.aborted) await this.client.question.reject({ requestID: req.id }).catch(() => undefined);
    } finally {
      this.asking.delete(req.id);
    }
  }

  // ---- Fin ---------------------------------------------------------------------------------------

  private async finish(result: RunResult): Promise<void> {
    if (this.finished) return;
    for (const a of this.asking.values()) a.abort();
    await this.saveState();
    this.finished = true;
    await this.dispose();
    this.resolveDone(result);
  }

  private async dispose(): Promise<void> {
    const child = this.server;
    if (child && child.exitCode === null) {
      child.stdin?.end();
      const timer = setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5_000);
      await this.serverExited;
      clearTimeout(timer);
    }
    await this.tunnel?.close().catch(() => undefined);
    await this.bridges?.close().catch(() => undefined);
    if (this.browserServer) {
      liveBrowserService.unregister(this.ctx.session.id);
      await this.browserServer.dispose().catch((e) => console.error('[browser] arrêt du navigateur de la session', e));
    }
  }
}

function describeError(error: unknown): string {
  if (!error) return 'erreur inconnue';
  if (typeof error === 'string') return error;
  const e = error as { data?: { message?: string }; message?: string; name?: string };
  return e.data?.message ?? e.message ?? e.name ?? JSON.stringify(error);
}

export { mcpToolOf };
