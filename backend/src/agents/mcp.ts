import { auditService } from '../audit/service.js';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { withProjectParam, type ProjectScope } from '../personal/scope.js';
import type { Project } from '../projects/types.js';
import { sessionRepository } from '../sessions/repository.js';
import { fold } from '../tasks/mentions.js';
import { agentService } from './service.js';
import { AGENT_KIND_LABELS, type Agent } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** Outils libres du serveur `agents` ; `summon` lance ou relance une session (budget) et passe par l'autorisation. */
export const AGENTS_FREE_TOOLS = ['mcp__agents__list'];

const line = (a: Agent, me: Agent | null, projectName?: string) =>
  `- ${a.id} · ${a.name} · ${AGENT_KIND_LABELS[a.kind]}${projectName ? ` · projet ${projectName}` : ''}${a.description ? ` · ${a.description}` : ''}${a.enabled ? '' : ' · en pause'}${a.id === me?.id ? ' · toi' : ''}`;

/**
 * Agent désigné par identifiant ou nom parmi les agents actifs des projets d'un espace personnel. Un nom porté par
 * des agents de plusieurs projets est refusé : le paramètre `project` lève l'ambiguïté.
 */
export async function resolveScopedAgent(scope: ProjectScope, raw: string): Promise<Agent> {
  // « @Chris » tel que la personne l'a écrit.
  const ref = raw.trim().replace(/^@/, '');
  const projects = await scope.projects();
  const agents = await agentService.listActive(projects.map((p) => p.id));
  const wanted = fold(ref);
  const byId = agents.find((a) => a.id === ref.trim().toLowerCase());
  if (byId) return byId;
  const named = agents.filter((a) => fold(a.name) === wanted);
  if (named.length === 1) return named[0];
  const nameOf = (a: Agent) => projects.find((p) => p.id === a.projectId)?.name ?? a.projectId;
  if (named.length > 1) throw new Error(`Plusieurs agents s'appellent « ${ref} » (${named.map(nameOf).join(', ')}) : précise le projet`);
  throw new Error(`Aucun agent « ${ref} » dans tes projets${agents.length ? ` (agents : ${agents.map((a) => `${a.name} · ${nameOf(a)}`).join(', ')})` : ''}`);
}

/**
 * Serveur MCP in-process `agents` : les agents du projet et leur convocation. Convoquer un agent revient à lui
 * envoyer un message (dans sa session reliée à la tâche, ou dans une nouvelle session) : il en est le propriétaire,
 * la session de l'appelant n'en est pas la parente (ce sont des collègues, pas des sous-agents).
 * Avec une portée (chat ou session d'un espace personnel), il couvre les agents de tous les projets de la personne :
 * `list` sans `project` les liste tous, `summon` cherche l'agent dans tous ses projets (rôle membre exigé).
 */
export function createAgentsMcpServer(project: Project, sessionId: string, scope?: ProjectScope): McpSdkServerConfigWithInstance {
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  const me = async () => {
    const session = await sessionRepository.findById(sessionId);
    return { session, agent: await agentService.forUser(session?.ownerId) };
  };

  return createSdkMcpServer({
    name: 'agents',
    version: '1.0.0',
    instructions: scope
      ? "Agents de tes projets : membres des projets qui ne sont pas des personnes (Product Manager, Developer…). list les décrit (tous tes projets, ou un seul avec project) ; summon convoque l'un d'eux avec un message (et une tâche éventuelle de son projet) : il le reçoit dans sa session reliée à la tâche ou dans une nouvelle session, dans son projet ; sessions.wait sur la session renvoyée donne sa réponse. Convoque un agent quand la personne le demande (par exemple en l'interpellant « @Nom »)."
      : `Agents du projet "${project.name}" : membres du projet qui ne sont pas des personnes (Product Manager, Developer…). list les décrit ; summon convoque l'un d'eux avec un message (et une tâche éventuelle) : il le reçoit dans sa session reliée à la tâche ou dans une nouvelle session. Convoque un agent seulement quand une personne l'a décidé ou que tes instructions le prévoient.`,
    tools: [
      tool(
        'list',
        scope ? 'Les agents de tes projets (ou du projet donné) : identifiant, nom, rôle, projet, description.' : 'Les agents du projet : identifiant, nom, rôle, description, état.',
        withProjectParam({}, scope),
        async ({ project: ref }) =>
          run(async () => {
            const { agent } = await me();
            if (!scope) {
              const agents = await agentService.listByProject(project.id);
              return agents.length ? agents.map((a) => line(a, agent)).join('\n') : 'Aucun agent dans ce projet.';
            }
            const projects = ref?.trim() ? [await scope.resolve(ref)] : await scope.projects();
            const agents = await agentService.listActive(projects.map((p) => p.id));
            const nameOf = (a: Agent) => projects.find((p) => p.id === a.projectId)?.name;
            return agents.length ? agents.map((a) => line(a, agent, nameOf(a))).join('\n') : ref?.trim() ? 'Aucun agent dans ce projet.' : 'Aucun agent dans tes projets.';
          }),
      ),
      tool(
        'summon',
        scope
          ? "Convoque un agent d'un de tes projets : lui transmet le message dans sa session reliée à la tâche (relancée au besoin), sinon ouvre une session pour lui dans son projet, sur la tâche ou libre. Un agent peut se convoquer lui-même : nouvelle session à son nom (jamais la session appelante). Renvoie la session : sessions.wait avec son id donne sa réponse. Le message doit être complet : l'agent ne connaît pas ta conversation."
          : "Convoque un agent du projet : lui transmet le message dans sa session reliée à la tâche (relancée au besoin), sinon ouvre une session pour lui sur la tâche (ou une session libre sans tâche). Un agent peut se convoquer lui-même pour lancer une nouvelle session à son nom, par exemple une par tâche (jamais la session appelante). Renvoie la session. Le message doit être complet : l'agent ne connaît pas ta conversation.",
        withProjectParam(
          {
            agent: z.string().describe("Identifiant ou nom de l'agent"),
            text: z.string().describe('Message complet et autonome : ce qui est décidé, ce qu\'il doit faire, où trouver le contexte'),
            task_id: z.string().optional().describe(scope ? "Tâche concernée, du projet de l'agent : il travaille dessus et suit son fil" : 'Tâche concernée : il travaille dessus et suit son fil'),
          },
          scope,
        ),
        async ({ agent: ref, text: body, task_id, project: projectRef }) =>
          run(async () => {
            const { session, agent: caller } = await me();
            let target: Agent;
            if (scope) {
              target = projectRef?.trim() ? await agentService.resolve((await scope.resolve(projectRef)).id, ref) : await resolveScopedAgent(scope, ref);
              await scope.assertWritable(target.projectId);
            } else {
              target = await agentService.resolve(project.id, ref);
            }
            const created = await agentService.summon(target.id, {
              taskId: task_id ?? null,
              text: body,
              // La personne qui a demandé la session de l'appelant reste celle qui demande ; un agent qui agit seul ne demande pour personne.
              requestedById: session?.requestedById ?? (caller ? null : (session?.ownerId ?? null)),
              actor: { type: 'human' },
              // Convoqué par une session, pas par une personne : sa session se range seule à la fin de son tour.
              autoArchive: true,
              // Un agent qui se convoque lui-même ouvre une autre session : jamais la session appelante.
              excludeSessionId: sessionId,
            });
            await auditService.record({ projectId: target.projectId, actor: { sessionId }, action: 'agent.summon', targetType: 'agent', targetId: target.id, targetLabel: target.name, details: { taskId: task_id, sessionId: created.id } });
            const follow = scope ? 'Utilise sessions.wait avec cet id pour obtenir sa réponse.' : "Il répondra dans le fil de la tâche s'il y en a une ; sinon consulte la session.";
            if (target.id === caller?.id) return `Nouvelle session à ton nom${task_id ? ` sur la tâche ${task_id}` : ''} : ${created.id} (« ${created.name} »). Elle travaille seule ; sessions.get avec cet id donne son état.`;
            return `${target.name} convoqué${task_id ? ` sur la tâche ${task_id}` : ''} : session ${created.id} (« ${created.name} »). ${follow}`;
          }),
      ),
    ],
  });
}

/** Paragraphe du prompt système : les agents sont décrits par `agentsPromptSummary` (agents/prompt.ts) ; ce serveur est son mode d'emploi. */
export const agentsMcpPrompt = (opts: { scoped?: boolean } = {}) =>
  opts.scoped
    ? "Serveur MCP `agents` : `list` (les agents de tes projets ; `project` pour un seul), `summon` (convoquer un agent avec un message complet et une tâche éventuelle de son projet ; soumis à autorisation), puis `sessions.wait` sur la session renvoyée pour obtenir sa réponse et la rapporter."
    : 'Serveur MCP `agents` : `list` (les agents du projet), `summon` (convoquer un agent avec un message et une tâche éventuelle ; soumis à autorisation).';
