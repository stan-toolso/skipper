import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { sessionService } from '../sessions/service.js';
import type { Attachment } from '../sessions/types.js';
import { terminalService } from '../terminals/service.js';
import { INSTANCE_TOKEN_HEADER, INTERNAL_PREFIX } from './client.js';
import { instanceRegistry } from './registry.js';

const MAX_BODY = 1_000_000;

/** Actions qu'une autre instance du backend peut demander à celle-ci (sur ce qu'elle tient). */
const actions: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  'session.message': (b) => sessionService.sendMessage(String(b.id), String(b.text), null, { attachments: (b.attachments as Attachment[]) ?? [] }),
  'session.start': (b) => sessionService.start(String(b.id), typeof b.message === 'string' ? b.message : undefined, (b.attachments as Attachment[]) ?? []),
  'session.interrupt': (b) => sessionService.interrupt(String(b.id)),
  'session.end': (b) => sessionService.end(String(b.id)),
  'session.stop': (b) => sessionService.stop(String(b.id)),
  'session.config': (b) => sessionService.updateConfig(String(b.id), (b.patch as Record<string, unknown>) ?? {}),
  'terminal.close': (b) => terminalService.close(String(b.id)),
};

const isLocal = (req: IncomingMessage) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

function tokenMatches(given: string | string[] | undefined): boolean {
  const a = Buffer.from(typeof given === 'string' ? given : '');
  const b = Buffer.from(instanceRegistry.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new AppError('Requête trop volumineuse');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/**
 * Routes internes `/internal/instance/<action>` : une autre instance du backend transmet à celle-ci une action sur
 * une session ou un terminal dont elle tient le processus (déploiement bleu/vert). Réservées à la machine (adresse
 * locale) et authentifiées par le jeton de l'instance, publié dans `backend_instances`. nginx ne les proxifie pas.
 */
export async function handleInternalRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '';
  if (!url.startsWith(INTERNAL_PREFIX)) return false;
  if (req.method !== 'POST' || !isLocal(req) || !tokenMatches(req.headers[INSTANCE_TOKEN_HEADER]) || req.headers['x-forwarded-for']) {
    reply(res, 403, { error: 'Forbidden' });
    return true;
  }
  const action = actions[url.slice(INTERNAL_PREFIX.length).split('?')[0]];
  if (!action) {
    reply(res, 404, { error: 'Action inconnue' });
    return true;
  }
  try {
    const result = await action(await readJson(req));
    reply(res, 200, { result: result && typeof result === 'object' && 'id' in result ? { id: (result as { id: string }).id } : null });
  } catch (err) {
    if (err instanceof AppError) return reply(res, 400, { error: err.message, code: err.code }), true;
    log.error('[instances] action interne', err);
    reply(res, 500, { error: (err as Error).message });
  }
  return true;
}
