import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Project } from '../projects/types.js';
import { runner } from '../runners/index.js';
import { sessionTag, type BrowserMcpServer } from '../runners/types.js';
import { log } from '../log.js';

/**
 * Contrôle du navigateur headless d'un projet (bouton « Tester » de la page Réglages) et diagnostic
 * lisible quand il ne démarre pas au lancement d'une session.
 *
 * Le contrôle refait exactement le chemin d'une session : la commande du navigateur (runner.browserMcpCommand :
 * relais qui lance `playwright-mcp`, puis Chromium au premier outil), à qui l'on demande d'ouvrir une page
 * locale et d'en faire une capture, par le protocole MCP comme le ferait l'agent.
 */

/**
 * Outils de playwright-mcp qui pourraient relire la valeur d'un champ saisi par le coffre : retirés à l'agent
 * quand le projet a des sites web ou secrets. `browser_run_code` a été renommé `browser_run_code_unsafe`.
 */
export const BROWSER_FIELD_READERS = ['browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe'];

/** Mémoire libre (conteneur) en deçà de laquelle Chromium risque d'être tué : 300 à 500 Mo par session. */
export const BROWSER_MIN_FREE_MB = 400;

/** Ce que le conteneur dit de son navigateur (script BROWSER_PROBE). */
export interface BrowserProbe {
  arch: string | null;
  /** Binaire « headless shell » trouvé dans /opt/ms-playwright ; null : absent de l'image. */
  chromiumPath: string | null;
  chromiumVersion: string | null;
  /** Entrées de /opt/ms-playwright (chromium-1247, chromium_headless_shell-1247…). */
  browsers: string[];
  mcpPath: string | null;
  mcpVersion: string | null;
  /** Limite mémoire du conteneur (cgroup) ; null : sans limite ou illisible. */
  memoryLimitMb: number | null;
  memoryUsedMb: number | null;
  /** Mémoire encore disponible : limite moins utilisée, bornée par la mémoire libre de l'hôte. */
  memoryAvailableMb: number | null;
}

export interface BrowserProblem {
  /** `error` : le navigateur ne peut pas marcher ; `warning` : il peut marcher, mais mal. */
  level: 'error' | 'warning';
  code: 'mcp_missing' | 'chromium_missing' | 'low_memory';
  message: string;
}

export interface BrowserCheckStep {
  label: string;
  ok: boolean;
  detail: string | null;
  durationMs: number;
}

export interface BrowserCheckResult {
  ok: boolean;
  enabled: boolean;
  image: string | null;
  probe: BrowserProbe | null;
  problems: BrowserProblem[];
  steps: BrowserCheckStep[];
  /** Capture de la page de test (data URL PNG). */
  screenshot: string | null;
  durationMs: number;
}

/**
 * Relevé du navigateur dans le conteneur : une ligne `clé=valeur` par information. Les commandes
 * `--version` sont bornées (timeout) : un binaire cassé ne doit pas bloquer le diagnostic.
 */
export const BROWSER_PROBE = `bin=$(ls -d /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | sort -V | tail -n 1)
echo "arch=$(uname -m)"
echo "chromium=$bin"
if [ -n "$bin" ]; then echo "chromiumVersion=$(timeout 10 "$bin" --version 2>/dev/null | head -n 1)"; fi
echo "browsers=$(ls /opt/ms-playwright 2>/dev/null | tr '\\n' ' ')"
mcp=$(command -v playwright-mcp 2>/dev/null)
echo "mcp=$mcp"
if [ -n "$mcp" ]; then echo "mcpVersion=$(timeout 15 playwright-mcp --version 2>/dev/null | head -n 1)"; fi
echo "memMax=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"
echo "memCurrent=$(cat /sys/fs/cgroup/memory.current 2>/dev/null)"
echo "memAvailableKb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null)"`;

const MB = 1024 * 1024;

/** Lecture de la sortie de BROWSER_PROBE. */
export function parseProbe(stdout: string): BrowserProbe {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) values.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const text = (key: string) => values.get(key) || null;
  const bytes = (key: string) => {
    const v = values.get(key);
    return v && /^\d+$/.test(v) ? Number(v) : null;
  };
  const limit = bytes('memMax');
  const used = bytes('memCurrent');
  const hostKb = bytes('memAvailableKb');
  const memoryLimitMb = limit !== null ? Math.round(limit / MB) : null;
  const memoryUsedMb = used !== null ? Math.round(used / MB) : null;
  const hostFreeMb = hostKb !== null ? Math.round(hostKb / 1024) : null;
  const inLimit = memoryLimitMb !== null && memoryUsedMb !== null ? Math.max(0, memoryLimitMb - memoryUsedMb) : null;
  const candidates = [inLimit, hostFreeMb].filter((v): v is number => v !== null);
  return {
    arch: text('arch'),
    chromiumPath: text('chromium'),
    chromiumVersion: text('chromiumVersion'),
    browsers: (values.get('browsers') ?? '').split(/\s+/).filter(Boolean),
    mcpPath: text('mcp'),
    mcpVersion: text('mcpVersion'),
    memoryLimitMb,
    memoryUsedMb,
    memoryAvailableMb: candidates.length ? Math.min(...candidates) : null,
  };
}

/** Problèmes repérés dans le relevé, avec ce qu'il faut faire. */
export function probeProblems(probe: BrowserProbe, image: string | null): BrowserProblem[] {
  const problems: BrowserProblem[] = [];
  const rebuild = `reconstruire l'image ${image ?? 'skipper-runner'} (deploy/runner/Dockerfile, voir DEPLOY.md) puis « Recréer » le conteneur dans les réglages du projet`;
  if (!probe.mcpPath) problems.push({ level: 'error', code: 'mcp_missing', message: `playwright-mcp est absent de l'image : ${rebuild}.` });
  if (!probe.chromiumPath) {
    const found = probe.browsers.length ? ` (/opt/ms-playwright contient : ${probe.browsers.join(', ')})` : ' (/opt/ms-playwright est vide ou absent)';
    problems.push({ level: 'error', code: 'chromium_missing', message: `Chromium « headless shell » introuvable${found} : ${rebuild}.` });
  }
  if (probe.memoryAvailableMb !== null && probe.memoryAvailableMb < BROWSER_MIN_FREE_MB) {
    const limit = probe.memoryLimitMb !== null ? ` sur une limite de ${probe.memoryLimitMb} Mo` : '';
    problems.push({
      level: 'warning',
      code: 'low_memory',
      message: `Mémoire insuffisante : ${probe.memoryAvailableMb} Mo disponibles${limit}, il en faut 300 à 500 par navigateur. Terminez des sessions du projet ou relevez la limite mémoire du conteneur (1,5 Go conseillé).`,
    });
  }
  return problems;
}

/** Relevé du navigateur dans le conteneur du projet (qui doit tourner). */
export async function probeBrowser(project: Project): Promise<BrowserProbe> {
  const { stdout } = await runner.exec(project, ['sh', '-c', BROWSER_PROBE]);
  return parseProbe(stdout);
}

/**
 * Explication d'un échec du navigateur au lancement d'une session, pour le transcript et le prompt :
 * l'erreur, puis ce que le relevé du conteneur en dit (image à reconstruire, mémoire…).
 */
export async function explainBrowserFailure(project: Project, error: string | null): Promise<string> {
  let problems: BrowserProblem[] = [];
  try {
    const status = await runner.status(project);
    problems = probeProblems(await probeBrowser(project), status.image);
  } catch (err) {
    log.warn('[browser] diagnostic impossible', (err as Error).message);
  }
  const parts = [error, ...problems.map((p) => p.message)].filter(Boolean);
  if (!problems.length) parts.push('Utilisez « Tester » (carte « Navigateur headless » des réglages du projet) pour le diagnostiquer.');
  return parts.join(' ');
}

/**
 * Texte du prompt système sur le navigateur. `prefix` : préfixe des outils du serveur MCP (`mcp__playwright__`
 * pour Claude, `playwright_` pour OpenCode) ; `fill` : nom de l'outil du coffre qui saisit un secret ;
 * `unavailable` : le navigateur n'a pas pu démarrer (raison).
 */
export function browserPrompt(opts: { prefix: string; fill: string; unavailable?: string | null }): string {
  const noInstall =
    "Chromium et Playwright sont déjà installés dans l'image du projet et lancés par Skipper : n'essaie jamais de les installer ou de lancer un autre navigateur toi-même (`npx playwright install`, `apt-get`, script qui cherche un binaire de Chromium) ; ce serait du temps perdu, sans effet sur le serveur MCP.";
  if (opts.unavailable) {
    return `Le navigateur headless de ce projet (serveur MCP \`playwright\`) n'a pas pu démarrer pour cette session : ${opts.unavailable}\n${noInstall} Si la tâche demande un navigateur, dis-le dans son fil (ou à la personne qui t'a sollicité) avec la raison ci-dessus, et arrête-toi là.`;
  }
  return [
    `Un navigateur headless (Chromium) est fourni par le serveur MCP \`playwright\`, outils \`${opts.prefix}*\` : navigue (\`${opts.prefix}browser_navigate\`), lis la page (\`${opts.prefix}browser_snapshot\`), clique et remplis des formulaires pour tester les interfaces web. Le serveur de développement à tester se lance dans l'environnement du projet ; ses URL en localhost y sont accessibles. Pour te connecter à un site web du coffre, ouvre la page de connexion, clique le champ du formulaire puis appelle \`${opts.fill}\` : Skipper y saisit la valeur, que tu ne vois jamais.`,
    `${noInstall} Si ses outils manquent ou échouent, signale-le avec le message d'erreur et arrête-toi : une personne peut le diagnostiquer avec « Tester » (réglages du projet).`,
  ].join('\n');
}

const STEP_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, label: string, ms = STEP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} : pas de réponse après ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]);
}

/** Texte d'un résultat d'outil MCP (erreurs comprises). */
function toolText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n')
    .trim();
}

/** Page de test ouverte par le contrôle : locale, sans réseau. */
const TEST_PAGE = `data:text/html,${encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Skipper</title><body style="font:20px sans-serif;padding:2em"><h1>Navigateur opérationnel</h1><p>Page de test de Skipper.</p></body>')}`;

/**
 * Contrôle complet du navigateur du projet : relevé du conteneur, lancement de Chromium, `playwright-mcp`
 * attaché par CDP, ouverture d'une page locale et capture. Chaque étape est chronométrée ; le premier
 * échec arrête la suite. Tout ce qui a été lancé est arrêté à la fin.
 */
export async function checkBrowser(project: Project): Promise<BrowserCheckResult> {
  const started = Date.now();
  const enabled = Boolean((project.runnerConfig as { browser?: boolean } | null)?.browser);
  const steps: BrowserCheckStep[] = [];
  let probe: BrowserProbe | null = null;
  let problems: BrowserProblem[] = [];
  let image: string | null = null;
  let screenshot: string | null = null;
  const step = async <T>(label: string, fn: () => Promise<{ value: T; detail?: string | null }>): Promise<T | undefined> => {
    const t0 = Date.now();
    try {
      const { value, detail } = await fn();
      steps.push({ label, ok: true, detail: detail ?? null, durationMs: Date.now() - t0 });
      return value;
    } catch (err) {
      steps.push({ label, ok: false, detail: (err as Error).message, durationMs: Date.now() - t0 });
      return undefined;
    }
  };
  const done = (): BrowserCheckResult => ({ ok: steps.every((s) => s.ok), enabled, image, probe, problems, steps, screenshot, durationMs: Date.now() - started });

  const ready = await step('Conteneur du projet', async () => {
    const status = await runner.ensureReady(project);
    image = status.image;
    return { value: true, detail: status.image ? `image ${status.image}` : null };
  });
  if (!ready) return done();

  await step('Navigateur dans l’image', async () => {
    probe = await probeBrowser(project);
    problems = probeProblems(probe, image);
    const blocking = problems.filter((p) => p.level === 'error');
    if (blocking.length) throw new Error(blocking.map((p) => p.message).join(' '));
    return { value: true, detail: [probe.chromiumVersion, probe.mcpVersion ? `playwright-mcp ${probe.mcpVersion}` : null, probe.arch].filter(Boolean).join(' · ') };
  });
  if (!steps[steps.length - 1].ok) return done();

  // Dossier jetable du contrôle (profil de Chromium, sorties de playwright-mcp), supprimé par dispose.
  const tag = randomBytes(4).toString('hex');
  let server: BrowserMcpServer | undefined;
  let client: Client | undefined;
  try {
    server = await step('Préparation du navigateur', async () => {
      const s = await runner.browserMcpCommand(project, `/tmp/${sessionTag(tag)}-browser`, { sessionId: tag });
      return { value: s, detail: 'Chromium lancé au premier outil du navigateur' };
    });
    if (!server) return done();
    const browserServer = server;

    client = await step('Démarrage de playwright-mcp', async () => {
      // Même commande que celle donnée au CLI de la session, lancée ici par `docker exec -i` dans le conteneur.
      const script = `exec ${browserServer.command} ${browserServer.args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`;
      const spec = await runner.shellCommand(project, '/tmp', 'sh', script);
      const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) }, stderr: 'pipe' });
      let stderr = '';
      transport.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf8')).slice(-2000)));
      const c = new Client({ name: 'skipper-browser-check', version: '1.0.0' });
      try {
        await withTimeout(c.connect(transport), 'playwright-mcp');
        const tools = await withTimeout(c.listTools(), 'liste des outils');
        const names = tools.tools.map((t) => t.name);
        for (const needed of ['browser_navigate', 'browser_take_screenshot']) if (!names.includes(needed)) throw new Error(`outil ${needed} absent (${names.length} outils)`);
        const version = c.getServerVersion();
        return { value: c, detail: `${version?.name ?? 'serveur'} ${version?.version ?? ''} · ${names.length} outils`.trim() };
      } catch (err) {
        await c.close().catch(() => undefined);
        const tail = stderr.trim().split('\n').slice(-3).join(' ');
        throw new Error(`${(err as Error).message}${tail ? ` — ${tail}` : ''}`);
      }
    });
    if (!client) return done();
    const mcp = client;

    const opened = await step('Ouverture d’une page locale', async () => {
      const result = await withTimeout(mcp.callTool({ name: 'browser_navigate', arguments: { url: TEST_PAGE } }), 'browser_navigate');
      if (result.isError) throw new Error(toolText(result) || 'erreur sans message');
      return { value: true, detail: 'data:text/html (page de test, sans réseau)' };
    });
    if (!opened) return done();

    await step('Capture de la page', async () => {
      const result = await withTimeout(mcp.callTool({ name: 'browser_take_screenshot', arguments: {} }), 'browser_take_screenshot');
      if (result.isError) throw new Error(toolText(result) || 'erreur sans message');
      const img = ((result.content ?? []) as { type: string; data?: string; mimeType?: string }[]).find((c) => c.type === 'image' && c.data);
      if (!img?.data) throw new Error('aucune image renvoyée');
      screenshot = `data:${img.mimeType ?? 'image/png'};base64,${img.data}`;
      return { value: true, detail: `${Math.round((img.data.length * 3) / 4 / 1024)} Ko` };
    });
    return done();
  } finally {
    await client?.close().catch(() => undefined);
    await server?.dispose().catch((e) => log.warn('[browser] arrêt du navigateur de contrôle', (e as Error).message));
  }
}
