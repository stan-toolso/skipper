import { auditService } from '../audit/service.js';
import { approvalService } from '../approvals/service.js';
import { agentService } from '../agents/service.js';
import { gitAccountFor } from '../git/agentEnv.js';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { inScope, targetProject, withProjectParam, type ProjectScope } from '../personal/scope.js';
import type { Project } from '../projects/types.js';
import { deliveryService } from '../deliveries/service.js';
import { deliveryQualityService } from '../deliveries/qualityService.js';
import type { Delivery } from '../deliveries/types.js';
import type { DeliveryTaskLink } from '../deliveries/qualityRepository.js';
import { describeCi, pullRequestService, type MergeMethod } from '../git/pullRequests.js';
import type { MergeApproval } from '../pullRequests/mergeApproval.js';
import { localCheck, localCheckRefusal } from '../pullRequests/localCheck.js';
import { foreignRepoOf, trackedPullRequestService } from '../pullRequests/service.js';
import { describePullRequest, pullRequestRef, PR_STAGES, SETTABLE_PR_STATUSES, type PullRequestStage, type TrackedPullRequest, type TrackedPullRequestStatus } from '../pullRequests/types.js';
import { traceSessionEvent } from '../sessions/events.js';
import { sessionService } from '../sessions/service.js';
import { worksessionPath, worksessionService } from '../worksessions/service.js';
import { describeAttachments, imageBlocks, type McpContent } from './attachments.js';
import { assertUnblocked, dependencyText, describeThread, formatPerson, formatWakeAt, statusTagText, summarizeReactions, taskService } from './service.js';
import { describeStatusesForAgents, effectiveStatus, findStatus, type TaskStatusDefinition } from './statuses.js';
import { projectService } from '../projects/service.js';
import { TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskActor, type TaskAttachment, type TaskComment, type TaskReaction } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/**
 * Outils du serveur `tasks` autorisés d'office (réversibles, sans coût, sans effet hors de la base). `pr_open`
 * n'y est pas : il pousse la branche et ouvre une pull request sur GitHub avec le compte de la personne, donc
 * passe par la demande d'autorisation. `pr_merge` y est parce qu'il pose lui-même sa demande (`approveMerge`) :
 * la personne qui l'accepte fusionne avec son compte, même en mode « refuser sans demander » ; en mode « Tout autoriser », la
 * personne qui pilote la session (au moins membre) l'accepte implicitement (`implicitMergeApprover`).
 * `request_approval` y est aussi : il ne fait que poser une demande d'accord à un administrateur (ou constater l'accord
 * implicite de la personne qui a demandé le travail), sans rien exécuter. `ci_status` ne fait que lire l'état de la CI.
 * `deploy_record` ne fait qu'enregistrer un déploiement déjà fait (et prévenir les agents qui suivent les déploiements).
 */
export const TASKS_FREE_TOOLS = ['list', 'get', 'create', 'update', 'claim', 'release', 'comment', 'react', 'people', 'request_approval', 'pr_list', 'pr_register', 'pr_update', 'pr_merge', 'ci_status', 'deploy_record'].map((t) => `mcp__tasks__${t}`);

/** Ce que le provider de la session fournit au serveur `tasks`. */
export interface TasksMcpOptions {
  /** Pose la demande de fusion d'une PR à une personne et renvoie l'identifiant de celle qui l'accepte (lève sinon). */
  approveMerge?: (approval: MergeApproval) => Promise<string>;
}

/** « in_progress/review » : la catégorie, suivie du statut du projet quand il n'a pas la même clé. */
const stateTag = (t: Task, statuses: TaskStatusDefinition[] | null) => {
  const key = statuses ? effectiveStatus(statuses, t).key : null;
  return key && key !== t.status ? `${t.status}/${key}` : t.status;
};

const line = (t: Task, sessionId: string, statuses: TaskStatusDefinition[] | null = null) =>
  `- ${t.id} · [${stateTag(t, statuses)}${statusTagText(t)}] [${t.priority}] ${t.title}${t.tags.length ? ` · étiquettes ${t.tags.join(', ')}` : ''}${t.sessionIds.includes(sessionId) ? (t.sessionIds.length > 1 ? ' (assignée à cette session et à d’autres)' : ' (assignée à cette session)') : t.sessionIds.length ? ' (prise par une autre session)' : ''}${t.dueDate ? ` · échéance ${t.dueDate}` : ''}${t.assignee ? ` · responsable ${formatPerson(t.assignee)}` : ''}${t.commentCount ? ` · ${t.commentCount} commentaire${t.commentCount > 1 ? 's' : ''}` : ''}${dependencyText(t)}${wakeText(t)}`;


/** « · en attente, réveil le … » quand la tâche a une date de réveil. */
const wakeText = (t: Task) => (t.wakeAt && t.status === 'in_progress' ? ` · ${t.wakeAt > new Date() ? 'en attente, réveil' : 'réveil passé'} ${formatWakeAt(t.wakeAt)}${t.wakeNote ? ` (à vérifier : ${t.wakeNote.slice(0, 200)})` : ''}` : '');

/** Dépendances d'une tâche, et tâches qui dépendent d'elle, avec leur titre et leur statut. */
function dependencyLines(t: Task, related: Task[]): string[] {
  const describe = (id: string) => {
    const r = related.find((x) => x.id === id);
    return r ? `- ${r.id} · [${r.status}] ${r.title}` : `- ${id}`;
  };
  const parts: string[] = [];
  if (t.dependsOnIds.length) {
    parts.push(
      t.blockedByIds.length
        ? `Bloquée par (dépendances non terminées : elle ne peut pas être prise ni confiée à un agent avant)${t.autoStartWhenUnblocked ? ' ; lancée automatiquement une fois débloquée' : ''} :`
        : 'Dépendances (toutes terminées) :',
      ...t.dependsOnIds.map(describe),
    );
  }
  if (t.dependentIds.length) parts.push('Tâches qui en dépendent :', ...t.dependentIds.map(describe));
  return parts;
}

/** Rattachement d'une tâche qualité à une livraison (mesure des régressions), en une ligne. */
export function qualityLinkLine(link: DeliveryTaskLink | null, delivery: Delivery | null): string | null {
  if (!link) return null;
  const how = link.source === 'manual' ? 'corrigé à la main' : 'calculé';
  if (!delivery) return `Tâche qualité rattachée à aucune livraison (${how}).`;
  const what = delivery.kind === 'deploy' ? 'déploiement' : 'livraison';
  const at = (delivery.finishedAt ?? delivery.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  return `Tâche qualité rattachée au ${what} ${delivery.sha ? `${delivery.sha.slice(0, 7)} ` : ''}du ${at} UTC (livraison ${delivery.id}, ${how}).`;
}

function detail(t: Task, comments: TaskComment[], attachments: TaskAttachment[], pullRequests: TrackedPullRequest[] = [], reactions: TaskReaction[] = [], projectRepo = '', related: Task[] = [], quality: string | null = null): string {
  const own = attachments.filter((a) => !a.commentId);
  const parts = [...(t.summary ? [`Résumé : ${t.summary}`, ''] : []), t.description || '(pas de description)'];
  parts.push(...dependencyLines(t, related));
  if (own.length) parts.push(...describeAttachments(own, 'tool'));
  if (t.assignee) parts.push(`Responsable : ${formatPerson(t.assignee)}`);
  if (t.reporter) parts.push(`Rapporteur : ${formatPerson(t.reporter)}`);
  if (t.branch) parts.push(`Branche : ${t.branch}`);
  if (quality) parts.push(quality);
  if (pullRequests.length) parts.push('Pull requests suivies (pr_update pour les tenir à jour) :', ...pullRequests.map((pr) => describePullRequest(pr, projectRepo)));
  if (t.customFields.length) parts.push('Champs personnalisés :', ...t.customFields.map((f) => `- ${f.key} : ${f.value}`));
  const own_reactions = reactions.filter((r) => !r.commentId);
  if (own_reactions.length) parts.push(`Réactions sur la tâche : ${summarizeReactions(own_reactions)}`);
  if (comments.length) parts.push(...describeThread(comments, attachments, reactions, 'tool'));
  return parts.join('\n');
}

/** Refus de `pr_open` à une session de Product Manager (sauf prise en main par une personne). */
export const PM_NO_PULL_REQUEST =
  "Tu es Product Manager : tu n'ouvres pas de pull request et tu ne livres pas de code. Crée une tâche pour ce changement (`tasks.create` : contexte, ce qui doit changer, critères d'acceptation, et le diagnostic ou le correctif que tu as trouvé), passe-la à « prête », puis confie-la à l'agent développeur du projet (« @Nom » dans son fil, ou `agents.summon`). Si une tâche attend ce changement, déclare la dépendance (`depends_on`). Abandonne tes modifications locales.";

const statusSchema = z.enum(TASK_STATUSES as [string, ...string[]]);
const stateSchema = z.string().optional();
const prioritySchema = z.enum(TASK_PRIORITIES as [string, ...string[]]);
const prStatusSchema = z.enum(SETTABLE_PR_STATUSES as [string, ...string[]]);
const prStageSchema = z.enum(PR_STAGES as [string, ...string[]]);
const fieldSchema = z.object({ key: z.string(), value: z.string() });
const tagsSchema = z.array(z.string()).optional();
const personSchema = z.object({ name: z.string().optional(), email: z.string().optional() }).nullable();
const dependsOnSchema = z.array(z.string()).optional();
const autoStartSchema = z.boolean().optional();

/**
 * Serveur MCP in-process : gestion des tâches du projet par une session d'agent. Avec une portée (session d'un
 * espace personnel), `list` et `create` acceptent un paramètre `project`, et les autres outils atteignent les
 * tâches de tous les projets de la personne.
 */
export function createTasksMcpServer(project: Project, sessionId: string, sessionName?: string, scope?: ProjectScope, options: TasksMcpOptions = {}): McpSdkServerConfigWithInstance {
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
  /**
   * Carte de la tâche dans le transcript de la session (événement `task`) : création, prise en charge ou changement
   * de statut par l'agent. Les autres modifications (étiquette d'état, description…) n'en laissent pas.
   */
  const trace = (action: 'created' | 'claimed' | 'status', t: Task, previousStatus?: Task['status']) =>
    traceSessionEvent(sessionId, 'task', { action, taskId: t.id, projectId: t.projectId, title: t.title, status: t.status, priority: t.priority, statusTag: t.statusTag ?? null, ...(previousStatus ? { previousStatus } : {}) });
  /** Statuts du projet de la tâche (ceux de la session, relus à chaque appel : ils peuvent changer en cours de route). */
  const statusesOf = async (projectId: string) => (await projectService.get(projectId).catch(() => null))?.taskStatuses ?? null;
  /** Catégorie visée par une entrée (statut du projet ou catégorie). */
  const targetCategory = (statuses: TaskStatusDefinition[] | null, status?: string, state?: string) =>
    (state?.trim() && statuses ? findStatus(statuses, state)?.category : undefined) ?? (status as Task['status'] | undefined);
  const where = scope ? ' (par défaut ton espace personnel ; project : un de tes projets)' : '';
  /** Qui agit sur une PR suivie : cette session. */
  const prActor = { type: 'agent' as const, sessionId };
  /** Dépôt GitHub du projet (« owner/name »), pour ne nommer le dépôt d'une PR que quand il est ailleurs. */
  const projectRepo = trackedPullRequestService.projectRepo(project);
  /** Au nom de qui une tâche débloquée sera lancée quand l'agent arme l'option : la personne qui pilote la session (ou l'agent de projet propriétaire). */
  const autoStartOwner = async () => (await sessionContext()).ownerId ?? null;
  /** Dossier de travail et personne de la session, pour ouvrir une PR sur GitHub avec son compte. */
  const sessionContext = async () => {
    const s = await sessionService.get(sessionId);
    if (!s) throw new Error('Session introuvable');
    return s;
  };

  return createSdkMcpServer({
    name: 'tasks',
    version: '1.0.0',
    instructions: `Tableau de tâches ${scope ? `de tes projets (par défaut : l'espace personnel "${project.name}" ; paramètre project pour un autre projet)` : `du projet "${project.name}"`}. Catégories de statut : todo, in_progress, done, cancelled (paramètre status) ; chaque projet a ses statuts, rangés dans ces catégories (paramètre state, clé ou libellé ; il fixe la catégorie)${scope ? '' : ` : ${describeStatusesForAgents(project.taskStatuses)}`}. Une étiquette d'état (court libellé libre, ex. « en revue », « bloquée ») dit où en est le travail dans le statut. Les tâches peuvent porter des étiquettes libres. Priorités : low, medium, high, urgent. Prends une tâche avec claim avant de t'en occuper (plusieurs sessions peuvent se partager une tâche, et une session en mener plusieurs ; release la rend), passe-la en done quand elle est terminée (travail fini, poussé, PR prête : pas avant), repasse-la en in_progress si tu la reprends ensuite (nouvelle instruction, corrections), commente-la pour rendre compte, et crée des tâches pour le travail à faire plus tard. Une tâche peut dépendre d'autres tâches du projet (depends_on de create et update, pas de cycle) : tant qu'une dépendance n'est pas terminée, elle est bloquée (claim et le lancement d'un agent sont refusés) ; auto_start la confie à une session dès que sa dernière dépendance passe à done. Une tâche créée directement en in_progress ou done t'est rattachée (assign_to_me) ; passer en in_progress ou done une tâche que personne n'a prise te la rattache aussi. Le fil d'une tâche est une conversation : comment poste un message (reply_to pour répondre dans le fil d'un message), react pose ou retire un emoji, request_approval demande officiellement l'accord d'un administrateur avant une action sensible (jamais un simple message), une mention (« @Nom » ou « @e-mail » d'un membre, « @session:<id> » d'une session d'agent ; people liste qui l'on peut mentionner) prévient la personne ou transmet le message à la session, qui est alors reliée à la tâche. Les pull requests d'une tâche se suivent avec pr_open (ouvre la PR sur GitHub, ou la merge request sur GitLab, depuis la branche courante, ou depuis un autre dépôt cloné dans un sous-dossier ; après le contrôle local du dépôt s'il en déclare un), pr_register (déclare une PR déjà ouverte, dans le dépôt du projet ou un autre), pr_merge (fusionne une PR quand une personne te le demande : elle accepte la demande et la fusion est faite avec son compte), pr_update (statut open/merged/closed, note, tâche) et pr_list (par étape : pending = en préparation, c'est-à-dire une branche avec des modifications sans PR ouverte, draft, to_merge, merged, cancelled).`,
    tools: [
      tool(
        'list',
        `Liste les tâches du projet${where} (par défaut : ouvertes, triées par priorité).`,
        withProjectParam(
          {
            status: z.array(statusSchema).optional().describe('Filtre par catégories de statut ; défaut : todo et in_progress'),
            state: z.array(z.string()).optional().describe('Filtre par statuts du projet (clés ou libellés, ex. review)'),
            priority: prioritySchema.optional(),
            assignee: z.string().optional().describe("Texte contenu dans le nom ou l'e-mail du responsable"),
            tag: z.string().optional().describe('Tâches portant cette étiquette'),
          },
          scope,
        ),
        async ({ status, state, priority, assignee, tag, project: ref }) =>
          run(async () => {
            const p = await targetProject(project, scope, ref);
            const statuses = p.taskStatuses;
            const defs = state?.length
              ? state.map((s) => {
                  const def = findStatus(statuses, s);
                  if (!def) throw new Error(`Statut inconnu : « ${s} » (statuts du projet : ${statuses.map((x) => x.key).join(', ')})`);
                  return def;
                })
              : null;
            const categories = defs ? [...new Set(defs.map((d) => d.category))] : ((status as Task['status'][] | undefined) ?? ['todo', 'in_progress']);
            let tasks = await taskService.list({ projectId: p.id, status: categories, priority: priority as Task['priority'] | undefined, assignee, tag: tag?.trim() || undefined });
            if (defs) tasks = tasks.filter((t) => defs.some((d) => d.key === effectiveStatus(statuses, t).key));
            return tasks.length ? tasks.map((t) => line(t, sessionId, statuses)).join('\n') : 'Aucune tâche.';
          }),
      ),
      tool("get", "Détail d'une tâche : description, personnes, champs personnalisés, fil de discussion (messages avec leur identifiant, réponses, réactions) et fichiers joints (les images sont montrées).", { id: z.string() }, async ({ id }) => {
        // Les images jointes à la tâche ou à ses commentaires suivent le texte, en blocs image, dans l'ordre où elles sont nommées.
        try {
          const t = await own(id, { write: false });
          const statuses = await statusesOf(t.projectId);
          const [comments, attachments, pullRequests, reactions, related] = await Promise.all([
            taskService.comments(id),
            taskService.attachments(id),
            trackedPullRequestService.forTask(id),
            taskService.reactions(id),
            taskService.findByIds([...t.dependsOnIds, ...t.dependentIds]),
          ]);
          const link = await deliveryQualityService.linkOf(id).catch(() => null);
          const quality = qualityLinkLine(link, link?.deliveryId ? await deliveryService.get(link.deliveryId).catch(() => null) : null);
          const content: McpContent[] = [{ type: 'text', text: `${line(t, sessionId, statuses)}\n\n${detail(t, comments, attachments, pullRequests, reactions, projectRepo, related, quality)}` }, ...(await imageBlocks([...attachments.filter((a) => !a.commentId), ...attachments.filter((a) => a.commentId)]))];
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
          summary: z.string().optional().describe("Résumé de l'objet de la tâche en une ou deux phrases (500 caractères au plus), affiché avant la description pour être lu et compris d'un coup d'œil : ce qu'il faut obtenir et pourquoi, sans le détail"),
          description: z.string().optional().describe('Contexte, critères de réussite, pistes'),
          priority: prioritySchema.optional().describe('Défaut : medium'),
          status: statusSchema.optional().describe('Catégorie ; défaut : todo'),
          state: stateSchema.describe('Statut du projet (clé ou libellé), qui fixe la catégorie ; défaut : le statut par défaut de la catégorie'),
          due_date: z.string().optional().describe('Échéance AAAA-MM-JJ'),
          custom_fields: z.array(fieldSchema).optional().describe('Champs libres clé/valeur (lien du ticket, environnement...)'),
          tags: tagsSchema.describe('Étiquettes libres (domaine, type de travail…) : réutilise celles déjà employées dans le projet'),
          status_tag: z.string().optional().describe('Court libellé de l\'avancement dans le statut (« bloquée », « en revue »…)'),
          assignee: personSchema.optional().describe('Responsable : nom et/ou e-mail'),
          reporter: personSchema.optional().describe('Rapporteur : nom et/ou e-mail'),
          assign_to_me: z.boolean().optional().describe("Cette session prend la charge de la tâche ; défaut : oui si le statut est in_progress ou done (c'est ton travail), non pour une tâche todo (travail pour plus tard)"),
          depends_on: dependsOnSchema.describe('Identifiants des tâches du même projet dont celle-ci dépend (« bloquée par ») : elle ne pourra être confiée à un agent qu’une fois toutes terminées'),
          auto_start: autoStartSchema.describe('Confier automatiquement la tâche à une session (configuration par défaut du projet, au nom de la personne qui pilote cette session) quand sa dernière dépendance passe à done'),
        }, scope),
        async ({ title, summary, description, priority, status, state, due_date, custom_fields, tags, status_tag, assignee, reporter, assign_to_me, depends_on, auto_start, project: ref }) =>
          run(async () => {
            const p = await targetProject(project, scope, ref, { write: true });
            const category = targetCategory(p.taskStatuses, status, state);
            const mine = assign_to_me ?? (category === 'in_progress' || category === 'done');
            const t = await taskService.create(
              p.id,
              {
                title,
                summary,
                description,
                priority: priority as Task['priority'] | undefined,
                status: status as Task['status'] | undefined,
                state,
                dueDate: due_date,
                customFields: custom_fields,
                tags,
                statusTag: status_tag,
                assignee,
                reporter,
                sessionId: mine ? sessionId : null,
                dependsOn: depends_on,
                ...(auto_start != null ? { autoStartWhenUnblocked: auto_start, autoStartById: await autoStartOwner() } : {}),
              },
              actor,
            );
            await trace('created', t);
            return `Tâche créée : ${line(t, sessionId, p.taskStatuses)}`;
          }),
      ),
      tool(
        'update',
        "Met à jour une tâche (statut, étiquette d'état, priorité, titre, résumé, description, échéance, étiquettes, champs, personnes). Passe-la en done quand elle est terminée ; tiens son étiquette d'état à jour pendant que tu y travailles. custom_fields et tags remplacent la liste complète : lis-la d'abord avec get.",
        {
          id: z.string(),
          status: statusSchema.optional().describe('Catégorie (prend son statut par défaut)'),
          state: stateSchema.describe('Statut du projet (clé ou libellé, ex. review), qui fixe la catégorie'),
          status_tag: z
            .string()
            .optional()
            .describe("Court libellé (un mot ou deux, 40 caractères au plus) de l'avancement, affiché à côté du statut : « analyse », « implémentation », « tests », « en revue », « bloquée »… ; une chaîne vide la retire. N'y recopie pas l'état d'une pull request (« PR #12 à fusionner ») : l'étape de la PR suivie s'affiche d'elle-même et reste à jour"),
          priority: prioritySchema.optional(),
          title: z.string().optional(),
          summary: z.string().optional().describe("Résumé de l'objet de la tâche en une ou deux phrases (500 caractères au plus) ; chaîne vide pour le retirer"),
          description: z.string().optional(),
          due_date: z.string().optional().describe('AAAA-MM-JJ, ou chaîne vide pour retirer'),
          custom_fields: z.array(fieldSchema).optional().describe('Liste complète des champs (remplace les précédents)'),
          tags: tagsSchema.describe('Remplace TOUTES les étiquettes : envoie la liste complète (lis-la d\'abord avec get)'),
          assignee: personSchema.optional().describe('null pour retirer'),
          reporter: personSchema.optional().describe('null pour retirer'),
          depends_on: dependsOnSchema.describe('Remplace TOUTES les dépendances (tâches du même projet dont celle-ci dépend) : envoie la liste complète, [] pour les retirer'),
          auto_start: autoStartSchema.describe('Arme (true) ou désarme (false) le lancement automatique quand la dernière dépendance passe à done'),
          wake_at: z
            .string()
            .optional()
            .describe(
              "Date de réveil (ISO 8601 avec fuseau, ex. 2026-11-14T08:00:00+01:00 ; chaîne vide pour retirer) d'une tâche en cours ou « à valider » (statut qui attend une personne) parce que tu attends quelque chose de daté (job de nuit, relevé du lendemain, réponse) : elle est « en attente » (pas « agent arrêté ») jusque-là, puis l'agent qui la tenait est reconvoqué sur la tâche (pour une session pilotée par une personne, elle revient dans « À traiter »). 90 jours au plus",
            ),
          wake_note: z.string().optional().describe('Ce qu\'il faudra vérifier au réveil, assez précis pour une session qui repart de zéro (transmis à l\'agent réveillé) ; chaîne vide pour retirer'),
        },
        async ({ id, status, state, status_tag, priority, title, summary, description, due_date, tags, custom_fields, assignee, reporter, depends_on, auto_start, wake_at, wake_note }) =>
          run(async () => {
            const current = await own(id);
            const statuses = await statusesOf(current.projectId);
            const category = targetCategory(statuses, status, state);
            // Claim implicite : avancer une tâche que personne n'a prise, c'est la prendre (pas une tâche bloquée).
            const takes = (category === 'in_progress' || category === 'done') && current.sessionIds.length === 0 && current.projectId === project.id && !current.blockedByIds.length;
            const t = await taskService.update(
              id,
              {
                status: status as Task['status'] | undefined,
                state,
                statusTag: status_tag,
                priority: priority as Task['priority'] | undefined,
                title,
                summary,
                description,
                dueDate: due_date,
                tags,
                customFields: custom_fields,
                assignee,
                reporter,
                dependsOn: depends_on,
                wakeAt: wake_at,
                wakeNote: wake_note,
                ...(auto_start != null ? { autoStartWhenUnblocked: auto_start, autoStartById: auto_start ? await autoStartOwner() : null } : {}),
                ...(takes ? { sessionId } : {}),
              },
              actor,
            );
            if (t.status !== current.status || t.state !== current.state) await trace('status', t, current.status);
            return `Tâche mise à jour : ${line(t, sessionId, statuses)}`;
          }),
      ),
      tool('claim', "Prend une tâche en charge : l'assigne à cette session (en plus des sessions déjà en charge, s'il y en a) et la passe en in_progress. Refusé tant que la tâche est bloquée par des dépendances non terminées.", { id: z.string() }, async ({ id }) =>
        run(async () => {
          const current = await own(id);
          await assertUnblocked(current);
          const t = await taskService.update(id, { status: 'in_progress', sessionId }, actor);
          await trace('claimed', t, current.status !== t.status ? current.status : undefined);
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

      tool(
        'request_approval',
        "Demande officiellement l'accord d'un administrateur du projet avant une action sensible (mise en production, modification d'un serveur, action irréversible) à propos d'une tâche. N'utilise jamais un simple message du fil pour demander un accord : cet outil pose une vraie demande (zone des demandes, notification aux administrateurs, session signalée « en attente ») et trace la demande dans le fil. Si la personne qui t'a demandé ce travail est administrateur du projet, son accord est déjà donné : l'outil le constate (accord implicite) et tu poursuis sans attendre. Sinon la demande est posée et tu termines ton tour sans faire l'action : la décision (accordée, refusée, écartée) t'arrivera en message dans le fil de la tâche.",
        {
          id: z.string().describe('Tâche concernée (ex. la tâche de release)'),
          action: z.string().describe("Ce que tu feras une fois l'accord donné, en une phrase (ex. « Mettre en production main (48a9d04) sur skipper-1 »)"),
          details: z.string().optional().describe('Ce qui change, risques, retour arrière (Markdown), montré dans la demande et le fil'),
        },
        async ({ id, action, details }) =>
          run(async () => {
            const t = await own(id);
            const outcome = await approvalService.request({ projectId: t.projectId, sessionId, taskId: t.id, action, details, actor });
            if (outcome.implicit) return `Accord implicite : ${outcome.approver.name || outcome.approver.email}, administrateur du projet, t'a demandé ce travail. Aucune demande n'est posée ; tu peux faire l'action (c'est tracé dans le fil de la tâche).`;
            return `Demande d'accord posée (${outcome.request.id}) aux administrateurs du projet et annoncée dans le fil de la tâche. Ne fais pas l'action maintenant : termine ton tour. La décision t'arrivera en message dans le fil de la tâche ; un accord donné en réponse dans le fil par un administrateur vaut aussi.`;
          }),
      ),

      // ---- CI -----------------------------------------------------------------------------------------------
      tool(
        'ci_status',
        "État de la CI (checks GitHub Actions et statuts externes) d'une branche ou d'un commit du dépôt du projet : verte, rouge, en cours ou sans check, avec le détail des checks. Sans ref : la branche de ton dossier de travail. Lecture seule ; ne boucle pas dessus (pas de sleep) : relis-la plus tard, ou laisse « Livrer » attendre la CI.",
        { ref: z.string().optional().describe('Branche (« main », « task/… ») ou SHA de commit ; défaut : la branche de ton dossier de travail, sinon la branche principale') },
        async ({ ref }) =>
          run(async () => {
            const s = await sessionContext();
            let target = ref?.trim();
            if (!target && s.worksessionId) target = (await worksessionService.get(s.worksessionId)).branch;
            target ||= project.gitBranch || 'main';
            const accounts = await agentService.accountsForSession(s);
            const account = accounts ? await gitAccountFor(accounts, project.gitUrl) : null;
            const ci = await pullRequestService.ciStatus(project.id, account?.userId ?? s.ownerId, target);
            const lines = ci.checks.map((c) => `- ${c.name} : ${c.state}${c.url ? ` (${c.url})` : ''}`);
            return [`${target} @ ${ci.sha.slice(0, 7)} : ${describeCi(ci)}`, ...lines].join('\n');
          }),
      ),

      tool(
        'deploy_record',
        "Déclare un déploiement en production que tu viens de faire hors du bouton « Livrer » de Skipper (script de déploiement lancé par SSH, CI, etc.), une fois qu'il a réussi : Skipper l'inscrit dans les livraisons du projet, retrouve les pull requests fusionnées que ce commit met en production pour la première fois et prévient les agents qui suivent les déploiements (le Product Manager met alors à jour les tâches concernées). N'enregistre rien d'autre : n'appelle pas cet outil pour un déploiement raté ou seulement prévu.",
        {
          sha: z.string().describe('Commit déployé (SHA complet ou abrégé) ; une branche est acceptée (son dernier commit sur origin), mais le SHA réellement déployé est préférable'),
          branch: z.string().optional().describe('Branche déployée ; défaut : celle du déploiement configuré, sinon la branche principale du projet'),
          note: z.string().optional().describe('Précision courte (« front seulement », serveur visé…)'),
        },
        async ({ sha, branch, note }) =>
          run(async () => {
            const s = await sessionContext();
            const accounts = await agentService.accountsForSession(s);
            const account = accounts ? await gitAccountFor(accounts, project.gitUrl) : null;
            const { delivery, event } = await deliveryService.recordDeploy({ projectId: project.id, rev: sha, branch, note, userId: s.requestedById ?? s.ownerId ?? null, sessionId, gitUserId: account?.userId ?? s.ownerId });
            const prs = event.pullRequests.map((pr) => `- ${pr.number != null ? `#${pr.number}` : 'PR'} ${pr.title}${pr.taskId ? ` (tâche ${pr.taskId})` : ''}`);
            return [
              `Déploiement de ${delivery.sha!.slice(0, 7)} (${delivery.branch}) enregistré (livraison ${delivery.id}).`,
              prs.length ? `Pull requests mises en production pour la première fois :\n${prs.join('\n')}` : 'Aucune pull request suivie nouvellement mise en production.',
            ].join('\n');
          }),
      ),

      // ---- Pull requests suivies ----------------------------------------------------------------------------
      tool(
        'pr_list',
        "Liste les pull requests suivies du projet, ou celles d'une tâche, par étape (pending = en préparation : branche avec des modifications sans PR ouverte ; draft, to_merge, merged, cancelled ; défaut : toutes).",
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
        "Pousse la branche courante du dossier de travail de cette session et ouvre une pull request sur GitHub (compte GitHub de la personne qui pilote la session ; une merge request avec son compte GitLab quand le dépôt du projet est sur GitLab), puis la suit au niveau de la tâche. Commite d'abord ; la base est la branche principale du projet. Avec path, la PR est ouverte sur le dépôt d'un autre clone (sous-dossier du dossier de travail), sa base par défaut étant la branche par défaut de ce dépôt. Si le dépôt déclare un contrôle local (.skipper/ci.json, ex. `npm run ci`), Skipper le lance d'abord dans ton dossier de travail et n'ouvre pas la PR s'il échoue : corrige puis rappelle. `force: true` saute ce contrôle, seulement si une personne te le demande explicitement.",
        {
          task_id: z.string().describe('Tâche à laquelle rattacher la PR (celle que tu réalises)'),
          title: z.string().describe('Titre de la PR'),
          body: z.string().optional().describe('Description (Markdown) : ce qui change, comment vérifier, lien de la session'),
          base: z.string().optional().describe('Branche de base ; défaut : branche principale du projet'),
          draft: z.boolean().optional().describe('Ouvrir en brouillon'),
          note: z.string().optional().describe('Note de suivi (« attend la CI », « à relire par X »…)'),
          path: z.string().optional().describe("Sous-dossier du dossier de travail contenant un autre dépôt git (clone d'un autre dépôt GitHub) ; absent : le dossier de travail lui-même"),
          force: z.boolean().optional().describe("Ouvre la PR sans le contrôle local (.skipper/ci.json) ou malgré son échec. Seulement si une personne l'a demandé explicitement ; jamais de ta propre initiative"),
        },
        async ({ task_id, title, body, base, draft, note, path, force }) =>
          run(async () => {
            const t = await own(task_id);
            if (t.projectId !== project.id) throw new Error('pr_open ouvre une PR du projet de cette session seulement');
            const s = await sessionContext();
            if (!s.worksessionId) throw new Error("Cette session travaille dans le dossier principal : ouvre une PR depuis une work session (branche dédiée)");
            // Agent de projet : le compte prêté pour l'hébergeur du dépôt (GitHub, GitLab) sert la PR ; prêté en lecture seule, pas de push ni de PR,
            // sauf si le prêt permet les pull requests : Skipper pousse alors la branche de travail (jamais la base) et ouvre la PR.
            // Un Product Manager ne livre pas de code : le changement passe par une tâche confiée à l'agent développeur. Une
            // personne qui a pris la main sur sa session l'ouvre avec ses propres droits.
            const owner = s.takenOverById ? null : await agentService.forUser(s.ownerId);
            if (owner?.kind === 'product_manager') throw new Error(PM_NO_PULL_REQUEST);
            const accounts = await agentService.accountsForSession(s);
            const account = accounts ? await gitAccountFor(accounts, path?.trim() ? null : project.gitUrl) : null;
            if (account?.readOnly && !account.pullRequests) throw new Error(`Ton compte ${account.host === 'gitlab' ? 'GitLab' : 'GitHub'} est prêté en lecture seule : tu ne peux ni pousser ni ouvrir de pull request. Si le changement relève du développement, crée une tâche et confie-la à l'agent développeur du projet ; sinon demande dans le fil de la tâche à une personne de prendre la main sur cette session (bouton « Prendre la main ») ou de pousser elle-même.`);
            // Contrôle local (typecheck, build, tests) avant de pousser : l'agent corrige avant que quelqu'un attende la CI. Un autre dépôt
            // (path) n'est pas celui du projet : le contrôle du projet ne s'y applique pas.
            if (!force && !path?.trim()) {
              const ws = await worksessionService.get(s.worksessionId);
              const refusal = localCheckRefusal(await localCheck.run(project, worksessionPath(project, ws)));
              if (refusal) throw new Error(refusal);
            }
            const pr = await trackedPullRequestService.open({ projectId: project.id, worksessionId: s.worksessionId }, account?.userId ?? s.ownerId, { title, body, base, draft, path }, { taskId: task_id, note }, prActor);
            await auditService.record({ projectId: project.id, actor: { sessionId }, action: 'pull_request.open', targetType: 'pull_request', targetId: pr.number != null ? String(pr.number) : pr.id, targetLabel: `#${pr.number ?? '?'} ${pr.title}`, details: { taskId: task_id, url: pr.url, draft } });
            return `Pull request ouverte et suivie :\n${describePullRequest(pr, projectRepo)}`;
          }),
      ),
      tool(
        'pr_register',
        "Déclare une pull request déjà ouverte (par curl, gh, ou quelqu'un d'autre), dans le dépôt du projet (merge request GitLab comprise) ou dans n'importe quel autre dépôt GitHub (URL), pour la suivre au niveau de la tâche. Ses détails sont lus sur la forge ; donne le titre et la branche si elle n'est pas joignable.",
        {
          task_id: z.string().optional().describe("Tâche à relier ; absent : la tâche traitée sur la branche de la PR, s'il y en a une"),
          url: z.string().optional().describe('URL de la PR (https://github.com/<owner>/<repo>/pull/<n>, ou https://<instance GitLab>/<groupe>/<projet>/-/merge_requests/<n>), dans le dépôt du projet ou dans un autre dépôt GitHub'),
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
        'pr_merge',
        "Fusionne une pull request suivie du projet, seulement quand une personne te l'a demandé (ou que tes instructions le prévoient, si ton compte prêté permet la fusion). Quand le compte GitHub ou GitLab prêté à cette session l'est en écriture avec fusion permise, la fusion est faite directement avec ce compte, sans demande. Sinon, pose une demande d'autorisation : la personne qui l'accepte fusionne avec son propre compte (GitHub, GitLab ou Forgejo), à son nom (en mode « Tout autoriser », la personne qui pilote la session l'accepte d'office). Supprime ensuite la branche distante et passe à « terminée » les tâches de la branche ; le dossier de travail est gardé.",
        {
          id: z.string().describe('Identifiant de la PR suivie (donné par pr_list ou get), son numéro dans le dépôt du projet (« 42 », « #42 ») ou son URL'),
          method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Méthode de fusion ; défaut : merge'),
        },
        async ({ id, method }) =>
          run(async () => {
            const s = await sessionContext();
            const accounts = await agentService.accountsForSession(s);
            // Compte prêté en écriture avec fusion permise : la session fusionne elle-même, sans demande.
            const lent = accounts ? await gitAccountFor(accounts, project.gitUrl) : null;
            const direct = lent?.merge ? lent : null;
            if (!direct && !options.approveMerge) throw new Error("Cette session ne peut pas fusionner de pull request : demande à une personne de la fusionner depuis l'onglet Pull requests du projet");
            const pr = await trackedPullRequestService.resolve(project.id, id);
            if (pr.number == null) throw new Error("Cette PR est en préparation (pas encore ouverte) : ouvre-la d'abord avec pr_open");
            if (pr.status !== 'open') throw new Error(`La PR ${pullRequestRef(pr, projectRepo)} n'est pas ouverte (statut : ${pr.status})`);
            const m = (method ?? 'merge').toUpperCase() as MergeMethod;
            const ref = pullRequestRef(pr, projectRepo);
            const userId = direct ? direct.userId : await options.approveMerge!({ projectId: project.id, ref, title: pr.title, url: pr.url, method: m, input: { id, method: m.toLowerCase(), pr: ref, title: pr.title, url: pr.url } });
            const result = await pullRequestService.merge(project.id, userId, pr.number, m, { deleteRemoteBranch: true, deleteWorksession: false, completeTasks: true }, foreignRepoOf(pr, projectRepo));
            const merged = await trackedPullRequestService.markMerged(project.id, result.pullRequest, result.sha, direct ? prActor : { type: 'human', userId });
            if (direct) {
              await auditService.record({ projectId: project.id, actor: { sessionId }, action: 'pull_request.merge', targetType: 'pull_request', targetId: String(pr.number), targetLabel: `#${pr.number} ${pr.title}`, details: { url: pr.url, method: m, lentAccountOf: direct.userId } });
            }
            return [`Pull request fusionnée${result.sha ? ` (${result.sha.slice(0, 7)})` : ''} :`, describePullRequest(merged, projectRepo), ...result.warnings.map((w) => `Attention : ${w}`)].join('\n');
          }),
      ),
      tool(
        'pr_close',
        "Ferme (annule) une pull request suivie sans la fusionner, sur la forge (GitHub, GitLab ou Forgejo), seulement quand une personne te l'a demandé ; soumis à son autorisation. La branche et le dossier de travail sont gardés, la PR reste réouvrable depuis la forge. comment : un commentaire posté sur la PR avant de la fermer (la raison).",
        {
          id: z.string().describe('Identifiant de la PR suivie (donné par pr_list ou get), son numéro dans le dépôt du projet (« 42 », « #42 ») ou son URL'),
          comment: z.string().optional().describe('Commentaire posté sur la PR avant la fermeture (la raison)'),
        },
        async ({ id, comment }) =>
          run(async () => {
            const pr = await trackedPullRequestService.resolve(project.id, id);
            if (pr.number == null) throw new Error("Cette PR est en préparation (pas encore ouverte) : il n'y a rien à fermer sur la forge");
            if (pr.status !== 'open') throw new Error(`La PR ${pullRequestRef(pr, projectRepo)} n'est pas ouverte (statut : ${pr.status})`);
            const s = await sessionContext();
            const accounts = await agentService.accountsForSession(s);
            const account = accounts ? await gitAccountFor(accounts, project.gitUrl) : null;
            if (account?.readOnly && !account.pullRequests) throw new Error(`Ton compte ${account.host === 'gitlab' ? 'GitLab' : 'GitHub'} est prêté en lecture seule : demande à une personne de fermer la PR depuis l'onglet Pull requests du projet`);
            const userId = account?.userId ?? s.ownerId;
            const repo = foreignRepoOf(pr, projectRepo);
            const warnings: string[] = [];
            if (comment?.trim()) await pullRequestService.comment(project.id, userId, pr.number, comment.trim(), repo).catch((err) => warnings.push(`Commentaire non posté : ${(err as Error).message}`));
            await pullRequestService.close(project.id, userId, pr.number, repo);
            const closed = await trackedPullRequestService.update(pr.id, { status: 'closed' });
            await auditService.record({ projectId: project.id, actor: { sessionId }, action: 'pull_request.close', targetType: 'pull_request', targetId: String(pr.number), targetLabel: `#${pr.number} ${pr.title}`, details: { url: pr.url } });
            return [`Pull request fermée sans fusion :`, describePullRequest(closed, projectRepo), ...warnings.map((w) => `Attention : ${w}`)].join('\n');
          }),
      ),
      tool(
        'pr_update',
        "Met à jour une pull request suivie : statut (open, merged, closed = annulée), note, tâche reliée. Le statut suit aussi la forge (GitHub, GitLab, Forgejo) tout seul. Une PR en préparation (pas encore ouverte) n'accepte que la note et la tâche : ouvre-la avec pr_open.",
        {
          id: z.string().describe("Identifiant de la PR suivie (donné par pr_list ou get), son numéro GitHub dans le dépôt du projet (« 42 », « #42 ») ou son URL"),
          status: prStatusSchema.optional(),
          note: z.string().optional().describe('Remplace la note ; chaîne vide pour la retirer'),
          task_id: z.string().optional().describe('Relie la PR à cette tâche'),
        },
        async ({ id, status, note, task_id }) =>
          run(async () => {
            const current = await trackedPullRequestService.resolve(project.id, id);
            if (task_id) await own(task_id);
            const pr = await trackedPullRequestService.update(current.id, { status: status as TrackedPullRequestStatus | undefined, note, taskId: task_id });
            return `Pull request mise à jour :\n${describePullRequest(pr, projectRepo)}`;
          }),
      ),
    ],
  });
}
