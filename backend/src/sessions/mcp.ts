import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Actor } from '../context/types.js';
import { inScope, targetProject, withProjectParam, type ProjectScope } from '../personal/scope.js';
import type { Project } from '../projects/types.js';
import { worksessionService } from '../worksessions/service.js';
import { sessionRepository } from './repository.js';
import { sessionService } from './service.js';
import type { Session } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const MAX_WAIT_SECONDS = 600;
const ANSWER_MAX_CHARS = 6000;

/** État lisible d'une session pour un agent : « en cours (travaille) », « en cours (attend des instructions) », « terminée »... */
function stateOf(s: Session): string {
  if (s.status === 'running') return s.activity === 'idle' ? 'en cours, tour terminé : attend des instructions' : 'en cours, travaille';
  const labels: Record<Session['status'], string> = { pending: 'pas encore démarrée', queued: "en file d'attente : démarrera dès qu'une place se libère (limite de sessions simultanées)", running: 'en cours', completed: 'terminée', failed: 'en erreur', stopped: 'arrêtée', interrupted: 'interrompue par un redémarrage' };
  return `${labels[s.status]}${s.error ? ` (${s.error})` : ''}`;
}

/** Dernière réponse de l'agent d'une session (résultat du dernier tour Claude), tronquée. */
async function lastAnswer(sessionId: string): Promise<string | null> {
  const event = await sessionRepository.findLastEvent(sessionId, ['claude.result']);
  const result = event?.payload.result;
  if (typeof result !== 'string' || !result.trim()) return null;
  return result.length > ANSWER_MAX_CHARS ? `${result.slice(0, ANSWER_MAX_CHARS)}\n[… réponse tronquée, ${result.length} caractères au total]` : result;
}

/** Description d'une session sur une ligne, avec sa relation à la session courante (et son projet quand il diffère). */
async function line(s: Session, sessionId: string, project: Project, scope: ProjectScope | undefined): Promise<string> {
  const relation = s.id === sessionId ? ' · cette session' : s.parentSessionId === sessionId ? ' · lancée par cette session' : '';
  const wt = s.worksessionId ? await worksessionService.get(s.worksessionId).then((w) => ` · work session ${w.name} (${w.branch})`, () => '') : '';
  const where = scope && s.projectId !== project.id ? ` · projet ${(await scope.projects()).find((p) => p.id === s.projectId)?.name ?? s.projectId}` : '';
  return `- ${s.id} · ${s.name} · ${stateOf(s)}${wt}${where}${relation}`;
}

/** Paragraphe du prompt système décrivant ces outils aux agents. */
export function sessionsPromptSummary(project: Pick<Project, 'gitUrl'>, opts: { chat?: boolean } = {}): string {
  return [
    opts.chat
      ? "Tu peux déléguer du travail à des sessions d'agent avec les outils du serveur MCP `sessions` : `create` lance une session (consigne complète et autonome ; dans un projet avec le paramètre `project`, où elle travaille dans une nouvelle work session, ou dans une work session existante via `worksession`), `wait` attend la fin de son tour et renvoie sa réponse, `send` lui envoie une nouvelle instruction, `end` la termine quand tu n'en as plus besoin (chaque session ouverte occupe de la mémoire). Une session déléguée ne voit pas cette conversation : donne-lui tout le contexte utile dans sa consigne. Termine les sessions que tu as lancées quand elles ont fini, sauf si la personne veut les garder ouvertes."
      : "Tu travailles dans une work session : un dossier à toi, à côté du checkout principal du projet (où rien ne s'exécute). Tu peux déléguer du travail à d'autres sessions d'agent avec les outils du serveur MCP `sessions` : `create` lance une session (consigne complète et autonome, dans une work session existante — la tienne pour partager tes fichiers —, sur une nouvelle branche via `new_branch`, ou par défaut dans une nouvelle work session), `wait` attend la fin de son tour et renvoie sa réponse, `send` lui envoie une nouvelle instruction, `end` la termine quand tu n'en as plus besoin (chaque session ouverte occupe de la mémoire). Une session déléguée ne voit ni ta conversation ni tes fichiers non validés : donne-lui tout le contexte utile dans sa consigne. Termine toujours les sessions que tu as lancées.",
    project.gitUrl
      ? "Le serveur MCP `worksessions` (list, create, delete) gère les work sessions du projet : chacune est un git worktree sur sa propre branche, pour isoler un chantier ou faire travailler plusieurs agents en parallèle sans se gêner."
      : "Le serveur MCP `worksessions` (list, create, delete) gère les work sessions du projet : chacune est un dossier séparé.",
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Serveur MCP in-process `sessions` : une session d'agent peut lancer d'autres sessions dans son projet,
 * les suivre, leur parler et les terminer. `create` et `send` passent par la demande d'autorisation
 * habituelle (elles consomment du budget) ; les autres outils sont libres. Avec une portée (session d'un
 * espace personnel), chaque outil accepte un paramètre `project` pour agir dans l'un des projets de la personne.
 */
export function createSessionsMcpServer(project: Project, sessionId: string, scope?: ProjectScope): McpSdkServerConfigWithInstance {
  const actor: Actor = { type: 'agent', sessionId };
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  const describe = (s: Session) => line(s, sessionId, project, scope);
  /** Session visible de cette session : dans son projet, ou dans la portée de l'espace personnel. */
  const getInScope = async (id: string): Promise<Session> => {
    const s = await sessionService.get(id);
    if (!s || !(await inScope(project, scope, s.projectId))) throw new Error(scope ? 'Session introuvable dans tes projets' : 'Session introuvable dans ce projet');
    return s;
  };
  const getChild = async (id: string): Promise<Session> => {
    const s = await getInScope(id);
    if (s.parentSessionId !== sessionId) throw new Error("Cette session n'a pas été lancée par toi : tu ne peux agir que sur les sessions que tu as créées");
    return s;
  };
  const report = async (s: Session): Promise<string> => {
    const answer = s.status === 'running' && s.activity !== 'idle' ? null : await lastAnswer(s.id);
    return [await describe(s), answer ? `\nDernière réponse de l'agent :\n${answer}` : ''].join('');
  };
  const where = scope ? ' (par défaut ton espace personnel ; project : un de tes projets)' : '';

  return createSdkMcpServer({
    name: 'sessions',
    version: '1.0.0',
    instructions: scope
      ? `Sessions d'agent de tes projets (par défaut : l'espace personnel "${project.name}" ; paramètre project pour un autre projet). Lance une session (create) avec une consigne complète et autonome, attends sa réponse (wait), précise si besoin (send), puis termine-la (end). Tu ne peux parler qu'aux sessions que tu as lancées.`
      : `Sessions d'agent du projet "${project.name}". Lance une session (create) avec une consigne complète et autonome, attends sa réponse (wait), précise si besoin (send), puis termine-la (end). Tu ne peux parler qu'aux sessions que tu as lancées.`,
    tools: [
      tool(
        'list',
        `Liste les sessions du projet${where} (les plus récentes en premier), avec leur état et leur work session.`,
        withProjectParam({ limit: z.number().int().positive().max(100).optional().describe('Défaut : 20') }, scope),
        async ({ limit, project: ref }) =>
          run(async () => {
            const p = await targetProject(project, scope, ref);
            const sessions = await sessionService.list({ projectId: p.id, limit: limit ?? 20 });
            return sessions.length ? (await Promise.all(sessions.map(describe))).join('\n') : 'Aucune session.';
          }),
      ),
      tool('get', "État d'une session et dernière réponse de son agent.", { id: z.string() }, async ({ id }) => run(async () => report(await getInScope(id)))),
      tool(
        'create',
        `Lance une nouvelle session d'agent${where} et renvoie son id. Elle travaille toujours dans une work session : celle indiquée (worksession), une nouvelle sur new_branch, ou par défaut une nouvelle nommée d'après la consigne. La consigne doit être complète : la session ne connaît pas ta conversation.`,
        withProjectParam(
          {
            prompt: z.string().describe('Consigne complète et autonome : objectif, contexte, critères de réussite, ce qu\'il faut rendre'),
            name: z.string().optional().describe('Nom court de la session (défaut : première ligne de la consigne)'),
            worksession: z.string().optional().describe("Nom (dossier) ou branche d'une work session existante où travailler (la tienne : worksessions.list la signale)"),
            new_branch: z.string().optional().describe('Crée une work session sur cette branche (créée si absente) et y lance la session'),
            base_ref: z.string().optional().describe('Avec new_branch : point de départ de la nouvelle branche (défaut : HEAD du dossier principal)'),
            permission_mode: z.enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']).optional().describe('Autorisations de la session (défaut : celles de ta session)'),
            model: z.string().optional().describe('Modèle (défaut : celui de ta session)'),
          },
          scope,
        ),
        async ({ prompt, name, worksession, new_branch, base_ref, permission_mode, model, project: ref }) =>
          run(async () => {
            const me = await sessionService.get(sessionId);
            if (!me) throw new Error('Session courante introuvable');
            const p = await targetProject(project, scope, ref, { write: true });
            if (worksession && new_branch) throw new Error('Indique soit worksession (existante), soit new_branch (à créer)');
            let worksessionId: string | null = null;
            if (worksession) {
              const w = (await worksessionService.listByProject(p.id)).find((x) => x.name === worksession || x.branch === worksession);
              if (!w) throw new Error(`Work session "${worksession}" introuvable : worksessions.list pour la liste, ou new_branch pour en créer une`);
              worksessionId = w.id;
            }
            // Un chat n'a ni work session ni mode d'autorisation de session : la session lancée reprend le mode par défaut du projet visé.
            const config: Record<string, unknown> = me.kind === 'chat' ? { ...(me.config.model ? { model: me.config.model } : {}) } : { ...me.config };
            if (permission_mode) config.permissionMode = permission_mode;
            if (model) config.model = model;
            const session = await sessionService.create(
              {
                projectId: p.id,
                worksessionId,
                // Sans work session indiquée : une nouvelle, nommée d'après la consigne.
                newWorksession: new_branch ? { branch: new_branch, baseRef: base_ref ?? null } : worksessionId ? null : { baseRef: base_ref ?? null },
                name: (name?.trim() || prompt.trim().split('\n')[0]).slice(0, 80),
                provider: me.kind === 'chat' ? 'claude' : me.provider,
                prompt,
                config,
              },
              actor,
            );
            return `Session lancée :\n${await describe(session)}\nUtilise sessions.wait avec cet id pour obtenir sa réponse.`;
          }),
      ),
      tool(
        'wait',
        "Attend que la session ait terminé son tour (ou se soit arrêtée), au plus timeout_seconds, puis renvoie son état et sa dernière réponse. Si elle travaille encore à l'échéance, rappelle l'outil.",
        { id: z.string(), timeout_seconds: z.number().int().positive().max(MAX_WAIT_SECONDS).optional().describe(`Défaut : 120, maximum ${MAX_WAIT_SECONDS}`) },
        async ({ id, timeout_seconds }) =>
          run(async () => {
            await getInScope(id);
            const s = await sessionService.waitForIdle(id, (timeout_seconds ?? 120) * 1000);
            const stillBusy = s.status === 'running' && s.activity !== 'idle';
            const hint = stillBusy ? "\n\nL'agent travaille encore : rappelle sessions.wait." : s.status === 'queued' ? "\n\nLa session attend une place pour démarrer : rappelle sessions.wait." : '';
            return `${await report(s)}${hint}`;
          }),
      ),
      tool(
        'send',
        "Envoie une instruction à une session que tu as lancée (la relance si elle est terminée). Attends ensuite sa réponse avec wait.",
        { id: z.string(), text: z.string().describe('Instruction pour l\'agent de cette session') },
        async ({ id, text: message }) =>
          run(async () => {
            const child = await getChild(id);
            const s = await sessionService.sendMessage(child.id, message);
            return `Instruction envoyée :\n${await describe(s)}`;
          }),
      ),
      tool('end', "Termine proprement une session que tu as lancée : l'agent finit son tour en cours, puis la session se ferme (libère la mémoire).", { id: z.string() }, async ({ id }) =>
        run(async () => {
          const child = await getChild(id);
          if (!sessionService.isRunning(child.id) && child.status !== 'queued') return `La session est déjà ${stateOf(child)}.`;
          const s = await sessionService.end(child.id);
          return `Fin demandée :\n${await describe(s)}`;
        }),
      ),
    ],
  });
}
