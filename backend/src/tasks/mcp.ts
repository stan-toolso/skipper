import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { inScope, targetProject, withProjectParam, type ProjectScope } from '../personal/scope.js';
import type { Project } from '../projects/types.js';
import { trackedPullRequestService } from '../pullRequests/service.js';
import { describePullRequest, PR_STAGES, SETTABLE_PR_STATUSES, type PullRequestStage, type TrackedPullRequest, type TrackedPullRequestStatus } from '../pullRequests/types.js';
import { sessionService } from '../sessions/service.js';
import { describeAttachments, imageBlocks, type McpContent } from './attachments.js';
import { describeThread, formatPerson, statusTagText, summarizeReactions, taskService } from './service.js';
import { TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskActor, type TaskAttachment, type TaskComment, type TaskReaction } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/**
 * Outils du serveur `tasks` autorisés d'office (réversibles, sans coût, sans effet hors de la base). `pr_open`
 * n'y est pas : il pousse la branche et ouvre une pull request sur GitHub avec le compte de la personne, donc
 * passe par la demande d'autorisation.
 */
export const TASKS_FREE_TOOLS = ['list', 'get', 'create', 'update', 'claim', 'release', 'comment', 'react', 'people', 'pr_list', 'pr_register', 'pr_update'].map((t) => `mcp__tasks__${t}`);

const line = (t: Task, sessionId: string) =>
  `- ${t.id} · [${t.status}${statusTagText(t)}] [${t.priority}] ${t.title}${t.tags.length ? ` · étiquettes ${t.tags.join(', ')}` : ''}${t.sessionIds.includes(sessionId) ? (t.sessionIds.length > 1 ? ' (assignée à cette session et à d’autres)' : ' (assignée à cette session)') : t.sessionIds.length ? ' (prise par une autre session)' : ''}${t.dueDate ? ` · échéance ${t.dueDate}` : ''}${t.assignee ? ` · responsable ${formatPerson(t.assignee)}` : ''}${t.commentCount ? ` · ${t.commentCount} commentaire${t.commentCount > 1 ? 's' : ''}` : ''}`;


function detail(t: Task, comments: TaskComment[], attachments: TaskAttachment[], pullRequests: TrackedPullRequest[] = [], reactions: TaskReaction[] = [], projectRepo = ''): string {
  const own = attachments.filter((a) => !a.commentId);
  const parts = [t.description || '(pas de description)'];
  if (own.length) parts.push(...describeAttachments(own, 'tool'));
  if (t.assignee) parts.push(`Responsable : ${formatPerson(t.assignee)}`);
  if (t.reporter) parts.push(`Rapporteur : ${formatPerson(t.reporter)}`);
  if (t.branch) parts.push(`Branche : ${t.branch}`);
  if (pullRequests.length) parts.push('Pull requests suivies (pr_update pour les tenir à jour) :', ...pullRequests.map((pr) => describePullRequest(pr, projectRepo)));
  if (t.customFields.length) parts.push('Champs personnalisés :', ...t.customFields.map((f) => `- ${f.key} : ${f.value}`));
  const own_reactions = reactions.filter((r) => !r.commentId);
  if (own_reactions.length) parts.push(`Réactions sur la tâche : ${summarizeReactions(own_reactions)}`);
  if (comments.length) parts.push(...describeThread(comments, attachments, reactions, 'tool'));
  return parts.join('\n');
}

const statusSchema = z.enum(TASK_STATUSES as [string, ...string[]]);
const prioritySchema = z.enum(TASK_PRIORITIES as [string, ...string[]]);
const prStatusSchema = z.enum(SETTABLE_PR_STATUSES as [string, ...string[]]);
const prStageSchema = z.enum(PR_STAGES as [string, ...string[]]);
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
  /** Qui agit sur une PR suivie : cette session. */
  const prActor = { type: 'agent' as const, sessionId };
  /** Dépôt GitHub du projet (« owner/name »), pour ne nommer le dépôt d'une PR que quand il est ailleurs. */
  const projectRepo = trackedPullRequestService.projectRepo(project);
  /** Dossier de travail et personne de la session, pour ouvrir une PR sur GitHub avec son compte. */
  const sessionContext = async () => {
    const s = await sessionService.get(sessionId);
    if (!s) throw new Error('Session introuvable');
    return s;
  };

  return createSdkMcpServer({
    name: 'tasks',
    version: '1.0.0',
    instructions: `Tableau de tâches ${scope ? `de tes projets (par défaut : l'espace personnel "${project.name}" ; paramètre project pour un autre projet)` : `du projet "${project.name}"`}. Statuts : todo, in_progress, done, cancelled ; une étiquette d'état (court libellé libre, ex. « en revue », « bloquée ») dit où en est le travail dans le statut. Les tâches peuvent porter des étiquettes libres. Priorités : low, medium, high, urgent. Prends une tâche avec claim avant de t'en occuper (plusieurs sessions peuvent se partager une tâche, et une session en mener plusieurs ; release la rend), passe-la en done quand elle est terminée, commente-la pour rendre compte, et crée des tâches pour le travail à faire plus tard. Une tâche créée directement en in_progress ou done t'est rattachée (assign_to_me) ; passer en in_progress ou done une tâche que personne n'a prise te la rattache aussi. Le fil d'une tâche est une conversation : comment poste un message (reply_to pour répondre dans le fil d'un message), react pose ou retire un emoji, une mention (« @Nom » ou « @e-mail » d'un membre, « @session:<id> » d'une session d'agent ; people liste qui l'on peut mentionner) prévient la personne ou transmet le message à la session, qui est alors reliée à la tâche. Les pull requests d'une tâche se suivent avec pr_open (ouvre la PR sur GitHub depuis la branche courante, ou depuis un autre dépôt cloné dans un sous-dossier), pr_register (déclare une PR déjà ouverte, dans le dépôt du projet ou un autre), pr_update (statut open/merged/closed, note, déploiement) et pr_list (par étape : pending = en préparation, c'est-à-dire une branche avec des modifications sans PR ouverte, draft, to_merge, to_deploy, deployed, cancelled).`,
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
      tool("get", "Détail d'une tâche : description, personnes, champs personnalisés, fil de discussion (messages avec leur identifiant, réponses, réactions) et fichiers joints (les images sont montrées).", { id: z.string() }, async ({ id }) => {
        // Les images jointes à la tâche ou à ses commentaires suivent le texte, en blocs image, dans l'ordre où elles sont nommées.
        try {
          const t = await own(id, { write: false });
          const [comments, attachments, pullRequests, reactions] = await Promise.all([taskService.comments(id), taskService.attachments(id), trackedPullRequestService.forTask(id), taskService.reactions(id)]);
          const content: McpContent[] = [{ type: 'text', text: `${line(t, sessionId)}\n\n${detail(t, comments, attachments, pullRequests, reactions, projectRepo)}` }, ...(await imageBlocks([...attachments.filter((a) => !a.commentId), ...attachments.filter((a) => a.commentId)]))];
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
          assign_to_me: z.boolean().optional().describe("Cette session prend la charge de la tâche ; défaut : oui si le statut est in_progress ou done (c'est ton travail), non pour une tâche todo (travail pour plus tard)"),
        }, scope),
        async ({ title, description, priority, status, due_date, custom_fields, tags, status_tag, assignee, reporter, assign_to_me, project: ref }) =>
          run(async () => {
            const p = await targetProject(project, scope, ref, { write: true });
            const mine = assign_to_me ?? (status === 'in_progress' || status === 'done');
            const t = await taskService.create(
              p.id,
              { title, description, priority: priority as Task['priority'] | undefined, status: status as Task['status'] | undefined, dueDate: due_date, customFields: custom_fields, tags, statusTag: status_tag, assignee, reporter, sessionId: mine ? sessionId : null },
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
            const current = await own(id);
            // Claim implicite : avancer une tâche que personne n'a prise, c'est la prendre.
            const takes = (status === 'in_progress' || status === 'done') && current.sessionIds.length === 0 && current.projectId === project.id;
            const t = await taskService.update(
              id,
              { status: status as Task['status'] | undefined, statusTag: status_tag, priority: priority as Task['priority'] | undefined, title, description, dueDate: due_date, tags, customFields: custom_fields, assignee, reporter, ...(takes ? { sessionId } : {}) },
              actor,
            );
            return `Tâche mise à jour : ${line(t, sessionId)}`;
          }),
      ),
      tool('claim', "Prend une tâche en charge : l'assigne à cette session (en plus des sessions déjà en charge, s'il y en a) et la passe en in_progress.", { id: z.string() }, async ({ id }) =>
        run(async () => {
          await own(id);
          const t = await taskService.update(id, { status: 'in_progress', sessionId }, actor);
          return `Tâche prise en charge : ${line(t, sessionId)}`;
        }),
      ),
      tool('release', "Cette session cesse d'être en charge d'une tâche (elle reste dans son historique) : passation, ou travail que tu ne poursuis pas. Le statut ne change pas.", { id: z.string() }, async ({ id }) =>
        run(async () => {
          const current = await own(id);
          if (!current.sessionIds.includes(sessionId)) return `Cette session n'est pas en charge de la tâche : ${line(current, sessionId)}`;
          const t = await taskService.update(id, { releaseSessionIds: [sessionId] }, actor);
          return `Tâche rendue : ${line(t, sessionId)}`;
        }),
      ),
      tool(
        'comment',
        "Poste un message dans le fil d'une tâche (Markdown accepté) : compte rendu, question, blocage, réponse. Mentionne quelqu'un avec « @Nom » ou « @e-mail » (membre du projet) ou une session avec « @session:<id> » (people liste les deux) : la personne est notifiée, la session reçoit le message.",
        {
          id: z.string().describe('Tâche'),
          body: z.string(),
          reply_to: z.string().optional().describe("Identifiant du message auquel répondre (donné par get) : la réponse rejoint son fil ; absent : nouveau message de premier niveau"),
        },
        async ({ id, body, reply_to }) =>
          run(async () => {
            await own(id);
            const c = await taskService.addComment(id, body, actor, null, { parentId: reply_to });
            return `Message posté (${c.id})${c.parentId ? ` dans le fil de ${c.parentId}` : ''}${c.mentions.length ? ` ; mentionne ${c.mentions.map((m) => m.label).join(', ')}` : ''}.`;
          }),
      ),
      tool(
        'react',
        "Pose un emoji sur un message du fil (comment_id) ou sur la tâche elle-même (sans comment_id) ; le retire si tu l'avais déjà posé. Accusé de lecture, accord (👍), vote, fait (✅)…",
        { id: z.string().describe('Tâche'), comment_id: z.string().optional().describe('Message visé ; absent : la tâche'), emoji: z.string().describe('Un seul emoji, ex. 👍 ✅ 👀 🎉') },
        async ({ id, comment_id, emoji }) =>
          run(async () => {
            await own(id);
            const { added, reaction } = await taskService.toggleReaction(id, comment_id ?? null, emoji, actor);
            return `Réaction ${reaction.emoji} ${added ? 'posée' : 'retirée'}${comment_id ? ` sur le message ${comment_id}` : ' sur la tâche'}.`;
          }),
      ),
      tool(
        'people',
        "Qui l'on peut mentionner dans le fil des tâches du projet : membres (nom, e-mail) et sessions d'agent non archivées, avec le texte à écrire pour chacun.",
        withProjectParam({}, scope),
        async ({ project: ref }) =>
          run(async () => {
            const p = await targetProject(project, scope, ref);
            const all = await taskService.mentionables(p.id);
            if (!all.length) return 'Personne à mentionner.';
            return all.map((m) => `- ${m.text} → ${m.kind === 'user' ? 'membre' : 'session'} ${m.label}${m.detail ? ` (${m.detail})` : ''}${m.kind === 'session' && m.id === sessionId ? ' (cette session)' : ''}`).join('\n');
          }),
      ),

      // ---- Pull requests suivies ----------------------------------------------------------------------------
      tool(
        'pr_list',
        "Liste les pull requests suivies du projet, ou celles d'une tâche, par étape (pending = en préparation : branche avec des modifications sans PR ouverte ; draft, to_merge, to_deploy, deployed, cancelled ; défaut : toutes).",
        {
          task_id: z.string().optional().describe("Tâche dont on veut les PR ; absent : tout le projet"),
          stage: z.array(prStageSchema).optional().describe('Étapes gardées ; défaut : toutes'),
        },
        async ({ task_id, stage }) =>
          run(async () => {
            if (task_id) await own(task_id, { write: false });
            const prs = await trackedPullRequestService.list({ projectId: project.id, taskId: task_id, stage: stage as PullRequestStage[] | undefined, limit: 200 });
            return prs.length ? prs.map((pr) => describePullRequest(pr, projectRepo)).join('\n') : 'Aucune pull request suivie.';
          }),
      ),
      tool(
        'pr_open',
        "Pousse la branche courante du dossier de travail de cette session et ouvre une pull request sur GitHub (compte GitHub de la personne qui pilote la session), puis la suit au niveau de la tâche. Commite d'abord ; la base est la branche principale du projet. Avec path, la PR est ouverte sur le dépôt d'un autre clone (sous-dossier du dossier de travail), sa base par défaut étant la branche par défaut de ce dépôt.",
        {
          task_id: z.string().describe('Tâche à laquelle rattacher la PR (celle que tu réalises)'),
          title: z.string().describe('Titre de la PR'),
          body: z.string().optional().describe('Description (Markdown) : ce qui change, comment vérifier, lien de la session'),
          base: z.string().optional().describe('Branche de base ; défaut : branche principale du projet'),
          draft: z.boolean().optional().describe('Ouvrir en brouillon'),
          note: z.string().optional().describe('Note de suivi (« attend la CI », « à relire par X »…)'),
          path: z.string().optional().describe("Sous-dossier du dossier de travail contenant un autre dépôt git (clone d'un autre dépôt GitHub) ; absent : le dossier de travail lui-même"),
        },
        async ({ task_id, title, body, base, draft, note, path }) =>
          run(async () => {
            const t = await own(task_id);
            if (t.projectId !== project.id) throw new Error('pr_open ouvre une PR du projet de cette session seulement');
            const s = await sessionContext();
            if (!s.worksessionId) throw new Error("Cette session travaille dans le dossier principal : ouvre une PR depuis une work session (branche dédiée)");
            const pr = await trackedPullRequestService.open({ projectId: project.id, worksessionId: s.worksessionId }, s.ownerId, { title, body, base, draft, path }, { taskId: task_id, note }, prActor);
            return `Pull request ouverte et suivie :\n${describePullRequest(pr, projectRepo)}`;
          }),
      ),
      tool(
        'pr_register',
        "Déclare une pull request déjà ouverte (par curl, gh, ou quelqu'un d'autre), dans le dépôt du projet ou dans n'importe quel autre dépôt GitHub (URL), pour la suivre au niveau de la tâche. Ses détails sont lus sur GitHub ; donne le titre et la branche si GitHub n'est pas joignable.",
        {
          task_id: z.string().optional().describe("Tâche à relier ; absent : la tâche traitée sur la branche de la PR, s'il y en a une"),
          url: z.string().optional().describe('URL de la PR (https://github.com/<owner>/<repo>/pull/<n>), dans le dépôt du projet ou dans un autre'),
          number: z.number().int().min(1).optional().describe("Numéro de la PR dans le dépôt du projet, si l'URL n'est pas donnée"),
          title: z.string().optional().describe("Titre, utilisé seulement si GitHub ne répond pas"),
          head_branch: z.string().optional().describe("Branche de la PR, utilisée seulement si GitHub ne répond pas"),
          note: z.string().optional().describe('Note de suivi'),
        },
        async ({ task_id, url, number, title, head_branch, note }) =>
          run(async () => {
            if (task_id) await own(task_id);
            const s = await sessionContext();
            const pr = await trackedPullRequestService.register(project.id, { url, number }, { taskId: task_id, note, userId: s.ownerId, fallback: { title, headBranch: head_branch } }, prActor);
            return `Pull request suivie :\n${describePullRequest(pr, projectRepo)}`;
          }),
      ),
      tool(
        'pr_update',
        "Met à jour une pull request suivie : statut (open, merged, closed = annulée), note, déploiement (deployed true quand elle est en production, avec deploy_note), tâche reliée. Une PR en préparation (pas encore ouverte) n'accepte que la note et la tâche : ouvre-la avec pr_open.",
        {
          id: z.string().describe("Identifiant de la PR suivie (donné par pr_list ou get), son numéro GitHub dans le dépôt du projet (« 42 », « #42 ») ou son URL"),
          status: prStatusSchema.optional(),
          note: z.string().optional().describe('Remplace la note ; chaîne vide pour la retirer'),
          deployed: z.boolean().optional().describe('true : mise en production (PR fusionnée seulement) ; false : annule'),
          deploy_note: z.string().optional().describe('Où et comment elle a été déployée (version, cellule, heure)'),
          task_id: z.string().optional().describe('Relie la PR à cette tâche'),
        },
        async ({ id, status, note, deployed, deploy_note, task_id }) =>
          run(async () => {
            const current = await trackedPullRequestService.resolve(project.id, id);
            if (task_id) await own(task_id);
            const pr = await trackedPullRequestService.update(current.id, { status: status as TrackedPullRequestStatus | undefined, note, deployed, deployNote: deploy_note, taskId: task_id }, prActor);
            return `Pull request mise à jour :\n${describePullRequest(pr, projectRepo)}`;
          }),
      ),
    ],
  });
}
