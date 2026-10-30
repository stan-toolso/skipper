import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../config.js';
import type { Project } from '../projects/types.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { taskService } from '../tasks/service.js';
import { userService } from '../users/service.js';
import { worksessionService } from '../worksessions/service.js';
import type { ProjectScope } from './scope.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const roleLabels: Record<string, string> = { admin: 'administrateur', member: 'membre', viewer: 'lecteur' };

const stateOf = (s: Session) => (s.status === 'running' ? (s.activity === 'idle' ? 'attend des instructions' : 'travaille') : s.status);

/**
 * Serveur MCP in-process `projects`, réservé aux sessions d'un espace personnel : la liste des projets de la
 * personne et un aperçu de chacun (tâches ouvertes, sessions en cours, work sessions). Lecture seule, libre.
 */
export function createProjectsMcpServer(scope: ProjectScope): McpSdkServerConfigWithInstance {
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  const line = async (p: Project): Promise<string> => {
    const [role, tasks, running] = await Promise.all([
      p.id === scope.home.id ? Promise.resolve('admin') : userService.memberRoleFor(scope.ownerId, p.id),
      taskService.list({ projectId: p.id, status: ['todo', 'in_progress'], limit: 500 }),
      sessionService.list({ projectId: p.id, status: 'running', limit: 50 }),
    ]);
    const home = p.id === scope.home.id ? ' · ton espace personnel (projet par défaut des outils)' : '';
    return `- ${p.name} · dossier ${p.slug} · id ${p.id} · rôle ${roleLabels[role ?? 'viewer']}${p.gitUrl ? ` · dépôt ${p.gitUrl}` : ''} · ${tasks.length} tâche(s) ouverte(s) · ${running.length} session(s) en cours${home}`;
  };

  return createSdkMcpServer({
    name: 'projects',
    version: '1.0.0',
    instructions: "Projets de la personne qui pilote cet espace personnel. `list` les énumère (nom, dossier, identifiant, rôle, activité) ; `get` détaille l'un d'eux. Le nom, le dossier ou l'identifiant d'un projet se passe ensuite au paramètre `project` des outils sessions, tasks et worksessions.",
    tools: [
      tool('list', 'Liste les projets de la personne, avec son rôle et leur activité (tâches ouvertes, sessions en cours).', {}, async () =>
        run(async () => {
          const projects = await scope.projects();
          return projects.length ? (await Promise.all(projects.map(line))).join('\n') : 'Aucun projet.';
        }),
      ),
      tool(
        'get',
        "Détail d'un projet : description, dépôt, instructions permanentes, work sessions, sessions récentes et tâches ouvertes.",
        { project: z.string().describe('Nom, identifiant ou dossier du projet') },
        async ({ project }) =>
          run(async () => {
            const p = await scope.resolve(project);
            const [worksessions, sessions, tasks] = await Promise.all([worksessionService.listByProject(p.id), sessionService.list({ projectId: p.id, limit: 10 }), taskService.list({ projectId: p.id, status: ['todo', 'in_progress'], limit: 50 })]);
            const parts = [
              await line(p),
              `Lien : ${config.appUrl}/projects/${p.id}`,
              p.description ? `Description : ${p.description}` : '',
              p.gitUrl ? `Dépôt : ${p.gitUrl}${p.gitBranch ? ` (branche ${p.gitBranch})` : ''}` : 'Sans dépôt git.',
              p.systemPrompt.trim() ? `Instructions permanentes du projet :\n${p.systemPrompt.trim().slice(0, 2000)}${p.systemPrompt.length > 2000 ? '\n[…]' : ''}` : '',
              `Work sessions (${worksessions.length}) :${worksessions.length ? `\n${worksessions.map((w) => `- ${w.name}${w.label ? ` · « ${w.label} »` : ''}${p.gitUrl ? ` · branche ${w.branch}` : ''}`).join('\n')}` : ' aucune'}`,
              `Sessions récentes (${sessions.length}) :${sessions.length ? `\n${sessions.map((s) => `- ${s.id} · ${s.name} · ${stateOf(s)}`).join('\n')}` : ' aucune'}`,
              `Tâches ouvertes (${tasks.length}) :${tasks.length ? `\n${tasks.map((t) => `- ${t.id} · [${t.status}] [${t.priority}] ${t.title}`).join('\n')}` : ' aucune'}`,
            ];
            return parts.filter(Boolean).join('\n');
          }),
      ),
    ],
  });
}
