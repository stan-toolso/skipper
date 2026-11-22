import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { apiKeyService } from '../apiKeys/service.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { serverSettings } from '../settings/server.js';
import { taskService } from './service.js';
import { OPEN_STATUSES, TASK_PRIORITIES, TASK_STATUSES, type ProjectApiKey, type Task, type TaskStatus } from './types.js';
import { log } from '../log.js';

/**
 * API REST des tâches, pour les intégrations : /api/v1/tasks, authentifiée par une clé d'API du projet
 * (`Authorization: Bearer skp_…` ou `X-Api-Key`). La clé fixe le projet : une tâche d'un autre projet
 * répond « introuvable ».
 */

const MAX_BODY = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const statusSchema = z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]]);
const prioritySchema = z.enum(TASK_PRIORITIES as [string, ...string[]]);
const personSchema = z.object({ name: z.string().nullable().optional(), email: z.string().nullable().optional() }).strict().nullable();
const fieldSchema = z.object({ key: z.string(), value: z.string() }).strict();
export const createSchema = z
  .object({
    title: z.string(),
    /** Une ou deux phrases sur l'objet de la tâche, montrées avant la description ; vide ou null : retiré. */
    summary: z.string().nullable().optional(),
    description: z.string().optional(),
    status: statusSchema.optional(),
    /** Statut du projet (clé ou libellé, ex. « triage ») : fixe la catégorie `status`. */
    state: z.string().optional(),
    priority: prioritySchema.optional(),
    dueDate: z.string().nullable().optional(),
    customFields: z.array(fieldSchema).optional(),
    statusTag: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    assignee: personSchema.optional(),
    reporter: personSchema.optional(),
    /** Tâches du même projet dont celle-ci dépend (remplace la liste complète). */
    dependsOn: z.array(z.string()).optional(),
  })
  .strict();
const updateSchema = createSchema.partial().strict();

export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

export function error(res: ServerResponse, status: number, message: string, code: string, extra: Record<string, unknown> = {}): void {
  json(res, status, { error: message, code, ...extra });
}

/** Représentation publique d'une tâche (les identifiants de sessions restent internes). */
function publicTask(t: Task) {
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    summary: t.summary,
    description: t.description,
    status: t.status,
    /** Clé du statut dans le projet ; null : le statut par défaut de la catégorie. */
    state: t.state,
    statusTag: t.statusTag,
    tags: t.tags,
    priority: t.priority,
    dueDate: t.dueDate,
    customFields: t.customFields,
    assignee: t.assignee,
    reporter: t.reporter,
    commentCount: t.commentCount,
    dependsOn: t.dependsOnIds,
    blockedBy: t.blockedByIds,
    branch: t.branch,
    createdByType: t.createdByType,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    startedAt: t.startedAt?.toISOString() ?? null,
    cancelledAt: t.cancelledAt?.toISOString() ?? null,
  };
}

/** Corps brut de la requête (texte UTF-8), 1 Mo au plus. */
export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new AppError('Corps trop volumineux (1 Mo au plus)');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const text = (await readRawBody(req)).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('JSON invalide');
  }
}

export function keyFrom(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-api-key'];
  return typeof header === 'string' ? header.trim() : null;
}

/** Codes HTTP des erreurs métier. */
export function statusOf(err: AppError): number {
  switch (err.code) {
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'UNAUTHENTICATED':
      return 401;
    case 'MAINTENANCE':
      return 503;
    default:
      return 400;
  }
}

export async function handleTasksApiRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  if (!url.pathname.startsWith('/api/v1/')) return false;
  try {
    const secret = keyFrom(req);
    if (!secret) return error(res, 401, "Une clé d'API du projet est requise (Authorization: Bearer skp_… ou X-Api-Key)", 'UNAUTHENTICATED'), true;
    const key = await apiKeyService.authenticate(secret);
    if (!key) return error(res, 401, "Clé d'API invalide", 'UNAUTHENTICATED'), true;
    if (serverSettings.maintenance) return error(res, 503, 'Serveur en maintenance', 'MAINTENANCE'), true;
    const actor = { type: 'human' as const, name: `Clé d'API « ${key.name} »` };
    const scope = req.method === 'GET' ? 'tasks:read' : 'tasks:write';
    if (!key.scopes.includes(scope)) return error(res, 403, `Cette clé n'a pas la portée ${scope}`, 'FORBIDDEN', { requiredScope: scope }), true;
    const parts = url.pathname.split('/').filter(Boolean); // api, v1, tasks, id?
    if (parts[2] !== 'tasks' || parts.length > 4) return error(res, 404, 'Route inconnue', 'NOT_FOUND'), true;
    const id = parts[3];
    if (!id) {
      if (req.method === 'GET') return json(res, 200, { tasks: (await listTasks(key, url.searchParams)).map(publicTask) }), true;
      if (req.method === 'POST') {
        const parsed = createSchema.safeParse(await readBody(req));
        if (!parsed.success) return error(res, 400, 'Données invalides', 'BAD_USER_INPUT', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }), true;
        const input = parsed.data;
        const task = await taskService.create(key.projectId, { ...input, priority: input.priority as Task['priority'] | undefined, dueDate: input.dueDate ?? undefined }, actor);
        return json(res, 201, { task: publicTask(task) }), true;
      }
      return error(res, 405, 'Méthode non autorisée', 'METHOD_NOT_ALLOWED'), true;
    }
    const task = UUID_RE.test(id) ? await taskService.get(id).catch(() => null) : null;
    if (!task || task.projectId !== key.projectId) return error(res, 404, 'Tâche introuvable', 'NOT_FOUND'), true;
    if (req.method === 'GET') return json(res, 200, { task: publicTask(task) }), true;
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const parsed = updateSchema.safeParse(await readBody(req));
      if (!parsed.success) return error(res, 400, 'Données invalides', 'BAD_USER_INPUT', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }), true;
      if (!Object.keys(parsed.data).length) return error(res, 400, 'Rien à mettre à jour', 'BAD_USER_INPUT'), true;
      const input = parsed.data;
      const updated = await taskService.update(task.id, { ...input, priority: input.priority as Task['priority'] | undefined, dueDate: input.dueDate === null ? '' : input.dueDate }, actor);
      return json(res, 200, { task: publicTask(updated) }), true;
    }
    if (req.method === 'DELETE') {
      await taskService.delete(task.id);
      res.writeHead(204).end();
      return true;
    }
    return error(res, 405, 'Méthode non autorisée', 'METHOD_NOT_ALLOWED'), true;
  } catch (err) {
    if (err instanceof AppError) return error(res, statusOf(err), err.message, err.code === 'BAD_REQUEST' ? 'BAD_USER_INPUT' : err.code), true;
    log.error('[api] tâches', err);
    return error(res, 500, 'Erreur interne', 'INTERNAL_SERVER_ERROR'), true;
  }
}

async function listTasks(key: ProjectApiKey, params: URLSearchParams): Promise<Task[]> {
  const statusParam = params.get('status');
  let status: TaskStatus[] | undefined = OPEN_STATUSES;
  if (statusParam === 'all') status = undefined;
  else if (statusParam) {
    status = statusParam.split(',').map((s) => s.trim()) as TaskStatus[];
    for (const s of status) if (!TASK_STATUSES.includes(s)) throw new AppError(`Statut inconnu : ${s}`);
  }
  const priority = params.get('priority');
  if (priority && !TASK_PRIORITIES.includes(priority as Task['priority'])) throw new AppError(`Priorité inconnue : ${priority}`);
  const limitRaw = params.get('limit');
  const limit = limitRaw ? Number(limitRaw) : 200;
  if (!Number.isInteger(limit) || limit < 1) throw new AppError('limit doit être un entier positif');
  return taskService.list({ projectId: key.projectId, status, priority: (priority as Task['priority']) || undefined, assignee: params.get('assignee') || undefined, reporter: params.get('reporter') || undefined, tag: params.get('tag')?.trim() || undefined, limit: Math.min(limit, 1000) });
}
