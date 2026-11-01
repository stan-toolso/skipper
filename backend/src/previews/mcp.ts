import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { PREVIEW_CONFIG_FILE } from './config.js';
import { CAPTURE_SIZES, previewService, type CaptureSize, type PreviewInfo } from './service.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const STATUS_LABELS: Record<string, string> = {
  IDLE: 'jamais lancé',
  STARTING: 'en cours de démarrage',
  RUNNING: 'prêt (le serveur répond)',
  FAILED: 'échec',
  STOPPED: 'arrêté',
};

/** Paragraphe du prompt système décrivant l'outil aux agents (en plus de la configuration, `previewPrompt`). */
export function previewMcpPrompt(): string {
  return [
    "Boucle « je modifie, tu vois » : après une modification visible de l'application, lance l'aperçu de ta branche avec `preview.start` (il attend que le serveur réponde et renvoie la fin du journal en cas d'échec), corrige s'il ne démarre pas (`preview.log`), puis vérifie la page avec `preview.screenshot` (capture PNG faite dans l'environnement du projet, format `desktop` ou `mobile`) ou avec le navigateur headless sur l'adresse interne donnée par `preview.status`.",
    "Donne ensuite dans ta réponse le lien public de l'aperçu (il s'ouvre pour tout membre du projet connecté à Skipper, ordinateur ou téléphone) ; le serveur de développement recharge tout seul les modifications suivantes, inutile de le relancer sauf changement de dépendances ou de configuration.",
  ].join(' ');
}

function describe(info: PreviewInfo, internal: string | null): string {
  const lines = [`État : ${STATUS_LABELS[info.status] ?? info.status}${info.error ? ` — ${info.error}` : ''}`];
  if (info.configError) lines.push(`Configuration invalide : ${info.configError}`);
  else if (!info.configured) lines.push(`Aucune commande d'aperçu : crée ${PREVIEW_CONFIG_FILE} (commande qui écoute sur 0.0.0.0 et $PORT), puis relance.`);
  else lines.push(`Commande : ${info.command} (${info.configSource})`);
  if (info.url) lines.push(`Lien public (membres du projet connectés à Skipper) : ${info.url}`);
  if (internal) lines.push(`Adresse interne (navigateur headless, curl, dans l'environnement du projet) : ${internal}`);
  if (info.readyMs !== null && info.status === 'RUNNING') lines.push(`Prêt en ${(info.readyMs / 1000).toFixed(1)} s${info.installCommand ? ` (installation : ${info.installCommand})` : ''}`);
  return lines.join('\n');
}

export interface PreviewMcpContext {
  /** Work session de la session : l'agent ne pilote que l'aperçu de son propre dossier de travail. */
  worksessionId: string;
  ownerId: string | null;
}

/** Serveur MCP in-process `preview` : aperçu en direct de la branche de la session (lancer, état, journal, capture). */
export function createPreviewMcpServer(ctx: PreviewMcpContext): McpSdkServerConfigWithInstance {
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  const status = async (info?: PreviewInfo) => describe(info ?? (await previewService.get(ctx.worksessionId)), await previewService.internalUrl(ctx.worksessionId));

  return createSdkMcpServer({
    name: 'preview',
    version: '1.0.0',
    instructions: "Aperçu en direct de la branche de la session (serveur de développement dans l'environnement du projet) : lance-le, lis son état et son journal, capture une page.",
    tools: [
      tool('status', "État de l'aperçu de ta branche : prêt ou non, commande, lien public, adresse interne, erreur.", {}, async () => run(() => status())),
      tool(
        'start',
        "Lance (ou relance) l'aperçu de ta branche : installation des dépendances si besoin, puis serveur de développement. Attend qu'il réponde (wait_seconds) et renvoie l'état, avec la fin du journal en cas d'échec.",
        { wait_seconds: z.number().int().min(0).max(300).optional().describe('Attente maximale du démarrage, en secondes (défaut 90 ; 0 : ne pas attendre)') },
        async ({ wait_seconds }) =>
          run(async () => {
            await previewService.start(ctx.worksessionId, ctx.ownerId);
            const info = await previewService.waitSettled(ctx.worksessionId, (wait_seconds ?? 90) * 1000);
            const out = [await status(info)];
            if (info.status === 'STARTING') out.push('Toujours en démarrage : rappelle `preview.status` dans un moment (ou lis `preview.log`).');
            if (info.status === 'FAILED' || info.status === 'STOPPED') out.push('', 'Fin du journal :', await previewService.logTail(ctx.worksessionId, 40));
            return out.join('\n');
          }),
      ),
      tool('stop', "Arrête le serveur de développement de l'aperçu de ta branche.", {}, async () => run(async () => status(await previewService.stop(ctx.worksessionId)))),
      tool(
        'log',
        "Fin du journal du dernier lancement de l'aperçu (installation puis serveur de développement).",
        { lines: z.number().int().min(1).max(400).optional().describe('Nombre de lignes, depuis la fin (défaut 80)') },
        async ({ lines }) => run(async () => (await previewService.logTail(ctx.worksessionId, lines ?? 80)) || 'Journal vide : aperçu jamais lancé.'),
      ),
      tool(
        'screenshot',
        "Capture d'écran PNG d'une page de l'aperçu en marche, faite dans l'environnement du projet ; renvoie l'image et le chemin du fichier (hors du dépôt).",
        {
          path: z.string().optional().describe("Chemin de la page dans l'application, ex. /tasks (défaut /)"),
          size: z.enum(Object.keys(CAPTURE_SIZES) as [CaptureSize, ...CaptureSize[]]).optional().describe('desktop (1280×800, défaut) ou mobile (390×844)'),
        },
        async ({ path: pagePath, size }) => {
          try {
            const shot = await previewService.screenshot(ctx.worksessionId, pagePath ?? '/', size ?? 'desktop');
            return {
              content: [
                { type: 'image' as const, data: shot.png.toString('base64'), mimeType: 'image/png' },
                { type: 'text' as const, text: `Capture de ${shot.url} (${size ?? 'desktop'}) : ${shot.file}` },
              ],
            };
          } catch (err) {
            return failure(`Erreur : ${(err as Error).message}`);
          }
        },
      ),
    ],
  });
}
