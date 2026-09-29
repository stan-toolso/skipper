import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Actor } from '../context/types.js';
import type { Project } from '../projects/types.js';
import { taskService } from './service.js';
import { TASK_PRIORITIES, TASK_STATUSES, type Task } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const line = (t: Task, sessionId: string) =>
  `- ${t.id} · [${t.status}] [${t.priority}] ${t.title}${t.sessionId ? (t.sessionId === sessionId ? ' (assignée à cette session)' : ' (prise par une autre session)') : ''}${t.dueDate ? ` · échéance ${t.dueDate}` : ''}`;

const statusSchema = z.enum(TASK_STATUSES as [string, ...string[]]);
const prioritySchema = z.enum(TASK_PRIORITIES as [string, ...string[]]);

/** Serveur MCP in-process : gestion des tâches du projet par une session d'agent. */
export function createTasksMcpServer(project: Project, sessionId: string): McpSdkServerConfigWithInstance {
  const actor: Actor = { type: 'agent', sessionId };
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };

  return createSdkMcpServer({
    name: 'tasks',
    version: '1.0.0',
    instructions: `Tableau de tâches du projet "${project.name}". Statuts : todo, in_progress, done, cancelled. Priorités : low, medium, high, urgent. Prends une tâche avec claim avant de t'en occuper, passe-la en done quand elle est terminée, et crée des tâches pour le travail à faire plus tard.`,
    tools: [
      tool(
        'list',
        'Liste les tâches du projet (par défaut : ouvertes, triées par priorité).',
        { status: z.array(statusSchema).optional().describe('Filtre par statuts ; défaut : todo et in_progress'), priority: prioritySchema.optional() },
        async ({ status, priority }) =>
          run(async () => {
            const tasks = await taskService.list({ projectId: project.id, status: (status as Task['status'][] | undefined) ?? ['todo', 'in_progress'], priority: priority as Task['priority'] | undefined });
            return tasks.length ? tasks.map((t) => line(t, sessionId)).join('\n') : 'Aucune tâche.';
          }),
      ),
      tool('get', "Détail d'une tâche.", { id: z.string() }, async ({ id }) =>
        run(async () => {
          const t = await taskService.get(id);
          if (t.projectId !== project.id) throw new Error('Tâche introuvable dans ce projet');
          return `${line(t, sessionId)}\n\n${t.description || '(pas de description)'}`;
        }),
      ),
      tool(
        'create',
        'Crée une tâche dans le projet.',
        {
          title: z.string().describe('Titre court et actionnable'),
          description: z.string().optional().describe('Contexte, critères de réussite, pistes'),
          priority: prioritySchema.optional().describe('Défaut : medium'),
          status: statusSchema.optional().describe('Défaut : todo'),
          due_date: z.string().optional().describe('Échéance AAAA-MM-JJ'),
        },
        async ({ title, description, priority, status, due_date }) =>
          run(async () => {
            const t = await taskService.create(project.id, { title, description, priority: priority as Task['priority'] | undefined, status: status as Task['status'] | undefined, dueDate: due_date }, actor);
            return `Tâche créée : ${line(t, sessionId)}`;
          }),
      ),
      tool(
        'update',
        "Met à jour une tâche (statut, priorité, titre, description, échéance). Passe-la en done quand elle est terminée.",
        {
          id: z.string(),
          status: statusSchema.optional(),
          priority: prioritySchema.optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          due_date: z.string().optional().describe('AAAA-MM-JJ, ou chaîne vide pour retirer'),
        },
        async ({ id, status, priority, title, description, due_date }) =>
          run(async () => {
            const existing = await taskService.get(id);
            if (existing.projectId !== project.id) throw new Error('Tâche introuvable dans ce projet');
            const t = await taskService.update(id, { status: status as Task['status'] | undefined, priority: priority as Task['priority'] | undefined, title, description, dueDate: due_date });
            return `Tâche mise à jour : ${line(t, sessionId)}`;
          }),
      ),
      tool('claim', "Prend une tâche en charge : l'assigne à cette session et la passe en in_progress.", { id: z.string() }, async ({ id }) =>
        run(async () => {
          const existing = await taskService.get(id);
          if (existing.projectId !== project.id) throw new Error('Tâche introuvable dans ce projet');
          const t = await taskService.update(id, { status: 'in_progress', sessionId });
          return `Tâche prise en charge : ${line(t, sessionId)}`;
        }),
      ),
    ],
  });
}
