import { AppError } from '../errors.js';
import { googleAccountService } from './service.js';

/** Client Gmail minimal (API REST v1) au nom du compte relié à un projet. */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_CHARS = 60_000;

interface Header {
  name: string;
  value: string;
}
interface Part {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: Part[];
}
interface Message {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  labels: string[];
  unread: boolean;
}

export interface MessageContent extends MessageSummary {
  cc: string;
  messageId: string;
  body: string;
  bodyTruncated: boolean;
  attachments: Array<{ filename: string; mimeType: string; size: number }>;
}

const header = (headers: Header[] | undefined, name: string): string => headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const decodeBody = (data?: string): string => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

/** Entités HTML nommées les plus fréquentes dans les mails (les autres passent par les formes numériques). */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", euro: '€', copy: '©', reg: '®', trade: '™', hellip: '…', ndash: '–', mdash: '—',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', deg: '°', middot: '·', bull: '•',
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', Agrave: 'À', Acirc: 'Â', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', Egrave: 'È', Eacute: 'É',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ograve: 'ò', oacute: 'ó', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', oelig: 'œ', OElig: 'Œ', aelig: 'æ', szlig: 'ß',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code] ?? m;
  });
}

/** Texte lisible d'un HTML : balises retirées, entités décodées, espaces resserrés. */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/h[1-6]>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(stripped)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parcourt les parties MIME : texte brut de préférence, sinon HTML converti ; pièces jointes listées. */
function extract(payload: Part | undefined): { text: string; html: string; attachments: MessageContent['attachments'] } {
  const out = { text: '', html: '', attachments: [] as MessageContent['attachments'] };
  const walk = (p: Part | undefined) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      out.attachments.push({ filename: p.filename, mimeType: p.mimeType ?? 'application/octet-stream', size: p.body.size ?? 0 });
    } else if (p.mimeType === 'text/plain' && p.body?.data) {
      out.text += decodeBody(p.body.data);
    } else if (p.mimeType === 'text/html' && p.body?.data) {
      out.html += decodeBody(p.body.data);
    }
    p.parts?.forEach(walk);
  };
  walk(payload);
  return out;
}

function toSummary(m: Message): MessageSummary {
  const h = m.payload?.headers;
  return {
    id: m.id,
    threadId: m.threadId,
    date: header(h, 'Date') || (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : ''),
    from: header(h, 'From'),
    to: header(h, 'To'),
    subject: header(h, 'Subject'),
    snippet: m.snippet ?? '',
    labels: m.labelIds ?? [],
    unread: (m.labelIds ?? []).includes('UNREAD'),
  };
}

export async function search(projectId: string, query: string, maxResults: number): Promise<{ messages: MessageSummary[]; estimate: number }> {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const list = await googleAccountService.json<{ messages?: Array<{ id: string }>; resultSizeEstimate?: number }>(projectId, `${BASE}/messages?${params}`);
  const ids = list.messages ?? [];
  const messages = await Promise.all(
    ids.map((m) =>
      googleAccountService.json<Message>(projectId, `${BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`),
    ),
  );
  return { messages: messages.map(toSummary), estimate: list.resultSizeEstimate ?? ids.length };
}

export async function read(projectId: string, messageId: string): Promise<MessageContent> {
  const m = await googleAccountService.json<Message>(projectId, `${BASE}/messages/${encodeURIComponent(messageId)}?format=full`);
  const { text, html, attachments } = extract(m.payload);
  const full = (text.trim() || htmlToText(html)).trim();
  return {
    ...toSummary(m),
    cc: header(m.payload?.headers, 'Cc'),
    messageId: header(m.payload?.headers, 'Message-ID'),
    body: full.slice(0, MAX_BODY_CHARS),
    bodyTruncated: full.length > MAX_BODY_CHARS,
    attachments,
  };
}

export interface SendInput {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** Répondre à ce message : même fil, en-têtes In-Reply-To / References, destinataire et sujet déduits si absents. */
  replyToMessageId?: string;
}

/** Encodage RFC 2047 d'un en-tête non ASCII. */
const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);

export async function send(projectId: string, input: SendInput): Promise<{ id: string; threadId: string; to: string; subject: string }> {
  let to = input.to.trim();
  let subject = input.subject.trim();
  let threadId: string | undefined;
  const extraHeaders: string[] = [];
  if (input.replyToMessageId) {
    const original = await googleAccountService.json<Message>(
      projectId,
      `${BASE}/messages/${encodeURIComponent(input.replyToMessageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`,
    );
    const h = original.payload?.headers;
    threadId = original.threadId;
    if (!to) to = header(h, 'Reply-To') || header(h, 'From');
    if (!subject) {
      const s = header(h, 'Subject');
      subject = /^re\s*:/i.test(s) ? s : `Re: ${s}`;
    }
    const msgId = header(h, 'Message-ID');
    if (msgId) {
      extraHeaders.push(`In-Reply-To: ${msgId}`);
      extraHeaders.push(`References: ${[header(h, 'References'), msgId].filter(Boolean).join(' ')}`);
    }
  }
  if (!to) throw new AppError('Destinataire obligatoire');
  if (!subject) throw new AppError('Sujet obligatoire');
  const headers = [
    `To: ${to}`,
    input.cc?.trim() ? `Cc: ${input.cc.trim()}` : '',
    input.bcc?.trim() ? `Bcc: ${input.bcc.trim()}` : '',
    `Subject: ${encodeHeader(subject)}`,
    ...extraHeaders,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  const mime = `${headers.join('\r\n')}\r\n\r\n${Buffer.from(input.body, 'utf8').toString('base64')}`;
  const raw = Buffer.from(mime, 'utf8').toString('base64url');
  const sent = await googleAccountService.json<{ id: string; threadId: string }>(projectId, `${BASE}/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
  return { id: sent.id, threadId: sent.threadId, to, subject };
}

export function renderSummaries(result: { messages: MessageSummary[]; estimate: number }): string {
  if (result.messages.length === 0) return 'Aucun message ne correspond.';
  const lines = result.messages.map((m) => `- [${m.id}] ${m.date} · de ${m.from || '?'} · ${m.subject || '(sans sujet)'}${m.unread ? ' · non lu' : ''}\n  ${m.snippet}`);
  return [`${result.messages.length} message(s) affiché(s)${result.estimate > result.messages.length ? ` sur environ ${result.estimate}` : ''} :`, ...lines].join('\n');
}

export function renderMessage(m: MessageContent): string {
  const head = [
    `Id : ${m.id} (fil ${m.threadId})`,
    `Date : ${m.date}`,
    `De : ${m.from}`,
    `À : ${m.to}`,
    m.cc ? `Cc : ${m.cc}` : '',
    `Sujet : ${m.subject}`,
    m.labels.length ? `Libellés : ${m.labels.join(', ')}` : '',
    m.attachments.length ? `Pièces jointes : ${m.attachments.map((a) => `${a.filename} (${a.mimeType}, ${a.size} octets)`).join(' ; ')}` : '',
  ].filter(Boolean);
  return `${head.join('\n')}\n\n${m.body || '(corps vide)'}${m.bodyTruncated ? '\n\n[corps tronqué]' : ''}`;
}
