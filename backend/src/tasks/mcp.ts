import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { inScope, targetProject, withProjectParam, type ProjectScope } from '../personal/scope.js';
import type { Project } from '../projects/types.js';
import { describeAttachments, imageBlocks, type McpContent } from './attachments.js';
import { describeComment, formatPerson, statusTagText, taskService } from './service.js';
import { TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskActor, type TaskAttachment, type TaskComment } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const line = (t: Task, sessionId: string) =>
  `- ${t.id} · [${t.status}${statusTagText(t)}] [${t.priority}] ${t.title}${t.tags.length ? ` · étiquettes ${t.tags.join(', ')}` : ''}${t.sessionId ? (t.sessionId === sessionId ? ' (assignée à cette session)' : ' (prise par une autre session)') : ''}${t.dueDate ? ` · échéance ${t.dueDate}` : ''}${t.assignee ? ` · responsable ${formatPerson(t.assignee)}` : ''}${t.commentCount ? ` · ${t.commentCount} commentaire${t.commentCount > 1 ? 's' : ''}` : ''}`;


function detail(t: Task, comments: TaskComment[], attachments: TaskAttachment[]): string {
  const own = attachments.filter((a) => !a.commentId);
  const parts = [t.description || '(pas de description)'];
  if (own.length) parts.push(...describeAttachments(own, 'tool'));
  if (t.assignee) parts.push(`Responsable : ${formatPerson(t.assignee)}`);
  if (t.reporter) parts.push(`Rapporteur : ${formatPerson(t.reporter)}`);
  if (t.customFields.length) parts.push('Champs personnalisés :', ...t.customFields.map((f) => `- ${f.key} : ${f.value}`));
  if (comments.length) {
    parts.push('Commentaires (du plus ancien au plus récent) :');
    for (const c of comments) parts.push(...describeComment(c, attachments.filter((a) => a.commentId === c.id), 'tool'));
  }
  return parts.join('\n');
}

const statusSchema = z.enum(TASK_STATUSES as [string, ...string[]]);
const prioritySchema = z.enum(TASK_PRIORITIES as [string, ...string[]]);
const fieldSchema = z.object({ key: z.string(), value: z.string() });
const tagsSchema = z.array(z.string()).optional();
const personSchema = z.object({ name: z.string().optional(), email: z.string().optional() }).nullable();

/**
 * Serveur MCP in-process : gestion des tâches du projet par une session d'agent. Avec une portée (session d'un
 * espace personnel), `list` et `create` acceptent un paramètre `project`, et les autres outils atteignent les
 * tâches de tous les projets de la personne.
 */
export function createTasksMcpServer(project: Project, sessionId: string, sessionName?: string, scope?: ProjectScope): McpSdkServerConfigWithInstance {
  const actor: TaskActor = { type: 'agent', sessionId, name: sessionName ?? null };
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  /** Tâche atteignable : dans le projet de la session, ou dans l'un des projets de la portée (écriture : rôle membre). */
  const own = async (id: string, opts: { write?: boolean } = { write: true }) => {
    const t = await taskService.get(id).catch(() => null);
    if (!t || !(await inScope(project, scope, t.projectId, opts))) throw new Error(scope ? 'Tâche introuvable dans tes projets' : 'Tâche introuvable dans ce projet');
    return t;
  };
  const where = scope ? ' (par défaut ton espace personnel ; project : un de tes projets)' : '';

  return createSdkMcpServer({
    name: 'tasks',
    version: '1.0.0',
    instructions: `Tableau de tâches ${scope ? `de tes projets (par défaut : l'espace personnel "${project.name}" ; paramètre project pour un autre projet)` : `du projet "${project.name}"`}. Statuts : todo, in_progress, done, cancelled ; une étiquette d'état (court libellé libre, ex. « en revue », « bloquée ») dit où en est le travail dans le statut. Les tâches peuvent porter des étiquettes libres. Priorités : low, medium, high, urgent. Prends une tâche avec claim avant de t'en occuper, passe-la en done quand elle est terminée, commente-la pour rendre compte, et crée des tâches pour le travail à faire plus tard.`,
    tools: [
      tool(
        'list',
        `Liste les tâches du projet${where} (par défaut : ouvertes, triées par priorité).`,
        withProjectParam(
          {
            status: z.array(statusSchema).optional().describe('Filtre par statuts ; défaut : todo et in_progress'),
            priority: prioritySchema.optional(),
            assignee: z.string().optional().describe("Texte contenu dans le nom ou l'e-mail du responsable"),
            tag: z.string().optional().describe('Tâches portant cette étiquette'),
          },
          scope,
        ),
        async ({ status, priority, assignee, tag, project: ref }) =>
          run(async () => {
            const p = await targetProject(project, scope, ref);
            const tasks = await taskService.list({ projectId: p.id, status: (status as Task['status'][] | undefined) ?? ['todo', 'in_progress'], priority: priority as Task['priority'] | undefined, assignee, tag: tag?.trim() || undefined });
            return tasks.length ? tasks.map((t) => line(t, sessionId)).join('\n') : 'Aucune tâche.';
          }),
      ),
      tool("get", "Détail d'une tâche : description, personnes, champs personnalisés, commentaires et fichiers joints (les images sont montrées).", { id: z.string() }, async ({ id }) => {
        // Les images jointes à la tâche ou à ses commentaires suivent le texte, en blocs image, dans l'ordre où elles sont nommées.
        try {
          const t = await own(id, { write: false });
          const [comments, attachments] = await Promise.all([taskService.comments(id), taskService.attachments(id)]);
          const content: McpContent[] = [{ type: 'text', text: `${line(t, sessionId)}\n\n${detail(t, comments, attachments)}` }, ...(await imageBlocks([...attachments.filter((a) => !a.commentId), ...attachments.filter((a) => a.commentId)]))];
          return { content };
        } catch (err) {
          return failure(`Erreur : ${(err as Error).message}`);
        }
      }),
      tool(
        'create',
        `Crée une tâche dans le projet${where}.`,
        withProjectParam({
          title: z.string().describe('Titre court et actionnable'),
          description: z.string().optional().describe('Contexte, critères de réussite, pistes'),
          priority: prioritySchema.optional().describe('Défaut : medium'),
          status: statusSchema.optional().describe('Défaut : todo'),
          due_date: z.string().optional().describe('Échéance AAAA-MM-JJ'),
          custom_fields: z.array(fieldSchema).optional().describe('Champs libres clé/valeur (lien du ticket, environnement...)'),
          tags: tagsSchema.describe('Étiquettes libres (domaine, type de travail…) : réutilise celles déjà employées dans le projet'),
          status_tag: z.string().optional().describe('Court libellé de l\'avancement dans le statut (« bloquée », « en revue »…)'),
          assignee: personSchema.optional().describe('Responsable : nom et/ou e-mail'),
          reporter: personSchema.optional().describe('Rapporteur : nom et/ou e-mail'),
        }, scope),
        async ({ title, description, priority, status, due_date, custom_fields, tags, status_tag, assignee, reporter, project: ref }) =>
          run(async () => {
            const p = await targetProject(project, scope, ref, { write: true });
            const t = await taskService.create(
              p.id,
              { title, description, priority: priority as Task['priority'] | undefined, status: status as Task['status'] | undefined, dueDate: due_date, customFields: custom_fields, tags, statusTag: status_tag, assignee, reporter },
              actor,
            );
            return `Tâche créée : ${line(t, sessionId)}`;
          }),
      ),
      tool(
        'update',
        "Met à jour une tâche (statut, étiquette d'état, priorité, titre, description, échéance, étiquettes, champs, personnes). Passe-la en done quand elle est terminée ; tiens son étiquette d'état à jour pendant que tu y travailles. custom_fields et tags remplacent la liste complète : lis-la d'abord avec get.",
        {
          id: z.string(),
          status: statusSchema.optional(),
          status_tag: z
            .string()
            .optional()
            .describe("Court libellé (un mot ou deux, 40 caractères au plus) de l'avancement, affiché à côté du statut : « analyse », « implémentation », « tests », « en revue », « bloquée »… ; une chaîne vide la retire"),
          priority: prioritySchema.optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          due_date: z.string().optional().describe('AAAA-MM-JJ, ou chaîne vide pour retirer'),
          custom_fields: z.array(fieldSchema).optional().describe('Liste complète des champs (remplace les précédents)'),
          tags: tagsSchema.describe('Remplace TOUTES les étiquettes : envoie la liste complète (lis-la d\'abord avec get)'),
          assignee: personSchema.optional().describe('null pour retirer'),
          reporter: personSchema.optional().describe('null pour retirer'),
        },
        async ({ id, status, status_tag, priority, title, description, due_date, tags, custom_fields, assignee, reporter }) =>
          run(async () => {
            await own(id);
            const t = await taskService.update(
              id,
              { status: status as Task['status'] | undefined, statusTag: status_tag, priority: priority as Task['priority'] | undefined, title, description, dueDate: due_date, tags, customFields: custom_fields, assignee, reporter },
              actor,
            );
            return `Tâche mise à jour : ${line(t, sessionId)}`;
          }),
      ),
      tool('claim', "Prend une tâche en charge : l'assigne à cette session et la passe en in_progress.", { id: z.string() }, async ({ id }) =>
        run(async () => {
          await own(id);
          const t = await taskService.update(id, { status: 'in_progress', sessionId }, actor);
          return `Tâche prise en charge : ${line(t, sessionId)}`;
        }),
      ),
      tool('comment', 'Ajoute un commentaire à une tâche (Markdown accepté) : compte rendu, question, blocage.', { id: z.string(), body: z.string() }, async ({ id, body }) =>
        run(async () => {
          await own(id);
          await taskService.addComment(id, body, actor);
          return 'Commentaire ajouté.';
        }),
      ),
    ],
  });
}
