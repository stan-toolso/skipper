import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionEvent, SessionLiveDraft } from '../graphql/operations';
import { describeCron } from '../lib/cron';
import { attachmentUrl, formatSize, isImageType, type AttachmentRef } from '../lib/attachments';
import type { LocalAttachment } from '../lib/pendingInstructions';
import { DONT_ASK_DENIAL, clockTime, dayLabel, describeTool, formatCost, formatDuration, permissionModeLabels, ruleForCall } from '../lib/humanize';
import { describeTaskFeed, type TaskFeedSummary } from '../lib/taskFeed';
import Markdown from './Markdown';
import AgentAvatar from './AgentAvatar';
import { Avatar } from './Thread';

/** Auteur journalisé avec une instruction (`author` de l'événement, backend sessions/instructionAuthor.ts). */
export type InstructionAuthor = { type: 'user'; id?: string; name: string; email?: string | null } | { type: 'session'; id?: string; name: string } | { type: 'system'; name: string };

export function readAuthor(value: unknown): InstructionAuthor | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const name = typeof v.name === 'string' ? v.name : '';
  if (!name) return null;
  const id = typeof v.id === 'string' ? v.id : undefined;
  if (v.type === 'user') return { type: 'user', id, name, email: typeof v.email === 'string' ? v.email : null };
  if (v.type === 'session') return { type: 'session', id, name };
  if (v.type === 'system') return { type: 'system', name };
  return null;
}

/** Interlocuteurs d'une session affichée en conversation (sans le détail technique). */
export interface ChatParticipants {
  /**
   * Auteur des instructions qui n'en portent pas (journalisées avant le 03/11/2026) : la personne qui pilote la
   * session, ou la session d'agent qui l'a lancée. Les autres disent qui les a écrites (`author` de l'événement).
   */
  human: { name: string; agent?: boolean };
  /** La personne connectée : auteur des instructions envoyées depuis la page et pas encore journalisées. */
  me?: { name: string } | null;
  /** Qui répond : l'agent de projet qui joue la session, sinon le modèle. */
  agent: { name: string; projectAgent?: { name: string; avatar: { emoji: string | null; color: string | null } } | null };
}

/**
 * Message de conversation, comme dans un canal : avatar, nom, heure, puis le corps. Les réponses de l'agent y
 * rassemblent tout son tour (étapes repliées, messages, questions).
 */
function ChatRow({ who, chat, author, at, pending, children }: { who: 'human' | 'agent'; chat: ChatParticipants; author?: InstructionAuthor | null; at: string | null; pending?: boolean; children: React.ReactNode }) {
  const human = author ?? (pending && chat.me ? { type: 'user' as const, name: chat.me.name } : { type: chat.human.agent ? ('session' as const) : ('user' as const), name: chat.human.name });
  const name = who === 'human' ? human.name : chat.agent.name;
  return (
    <div className={`cc-chat-msg ${who}${pending ? ' pending' : ''}`} title={pending ? 'Envoi en cours…' : undefined}>
      {who === 'agent' ? (
        chat.agent.projectAgent ? <AgentAvatar agent={chat.agent.projectAgent} size={28} className="tt-avatar" /> : <Avatar name={name} agent />
      ) : human.type === 'system' ? (
        <span className="tt-avatar tt-avatar-agent" title="Message de Skipper">
          <i className="bi bi-gear" />
        </span>
      ) : (
        <Avatar name={name} agent={human.type === 'session'} />
      )}
      <div className="cc-chat-main">
        <div className="tt-msg-head">
          {who === 'human' && human.type === 'session' && 'id' in human && human.id ? (
            <Link className="tt-author" to={`/sessions/${human.id}`} title="Session d'agent qui a envoyé ce message">
              {name}
            </Link>
          ) : (
            <span className="tt-author">{name}</span>
          )}
          {at && (
            <time className="tt-time" dateTime={at} title={new Date(at).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' })}>
              {clockTime(at)}
            </time>
          )}
        </div>
        <div className="cc-chat-body">{children}</div>
      </div>
    </div>
  );
}

/** Fichiers joints à une instruction : vignettes pour les images, liens de téléchargement sinon. */
function InstructionAttachments({ sessionId, attachments }: { sessionId: string; attachments: AttachmentRef[] }) {
  return (
    <div className="cc-user-files">
      {attachments.map((a) => {
        const url = attachmentUrl(sessionId, a.id);
        const title = `${a.name} · ${a.mediaType} · ${formatSize(a.size)}`;
        return isImageType(a.mediaType) ? (
          <a key={a.id} href={url} target="_blank" rel="noreferrer" className="cc-user-image" title={title}>
            <img src={url} alt={a.name} crossOrigin="use-credentials" loading="lazy" />
          </a>
        ) : (
          <a key={a.id} href={url} target="_blank" rel="noreferrer" className="cc-chip" title={title}>
            <i className="bi bi-file-earmark" />
            <span className="cc-chip-name">{a.name}</span>
            <span className="cc-chip-size">{formatSize(a.size)}</span>
          </a>
        );
      })}
    </div>
  );
}

/** Fichiers d'une instruction pas encore journalisée par le serveur : aperçus depuis le navigateur. */
function LocalAttachments({ attachments }: { attachments: LocalAttachment[] }) {
  return (
    <div className="cc-user-files">
      {attachments.map((a, i) => {
        const title = `${a.name} · ${a.mediaType} · ${formatSize(a.size)}`;
        return a.previewUrl ? (
          <span key={i} className="cc-user-image" title={title}>
            <img src={a.previewUrl} alt={a.name} />
          </span>
        ) : (
          <span key={i} className="cc-chip" title={title}>
            <i className="bi bi-file-earmark" />
            <span className="cc-chip-name">{a.name}</span>
            <span className="cc-chip-size">{formatSize(a.size)}</span>
          </span>
        );
      })}
    </div>
  );
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ToolResult {
  text: string;
  isError: boolean;
  /** Résultat structuré fourni par le SDK (`tool_use_result`) : patch d'une modification, lignes lues, sorties... */
  data: Record<string, unknown>;
}

/** Portion de diff telle que la fournit Claude Code (`structuredPatch`) ; sans numéros si `oldStart` est absent. */
interface Hunk {
  oldStart?: number;
  newStart?: number;
  lines: string[];
}

type Input = Record<string, unknown>;

/** Lignes de sortie affichées avant « … +N lignes ». */
const OUTPUT_LINES = 3;
/** Lignes d'un fichier créé affichées avant « … +N lignes ». */
const PREVIEW_LINES = 10;
/** Lignes de diff affichées avant « … +N lignes ». */
const DIFF_LINES = 40;

const str = (o: Input, key: string): string | undefined => (typeof o[key] === 'string' ? (o[key] as string) : undefined);
const num = (o: Input, key: string): number | undefined => (typeof o[key] === 'number' ? (o[key] as number) : undefined);
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: ContentBlock) => (b.type === 'text' ? b.text ?? '' : `[${b.type}]`))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content, null, 2);
}

/** Arguments d'un outil sans affichage dédié : `clé: "valeur", clé: 3`. */
function formatArgs(input: Input): string {
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ');
}

/** Entête d'un appel d'outil, comme Claude Code : Bash(commande), Update(fichier), Search(pattern: "x")... */
function toolHeader(name: string, input: Input, rel: (path: string) => string): { name: string; args: string } {
  switch (name) {
    case 'Bash':
      return { name: 'Bash', args: str(input, 'command') ?? '' };
    case 'Read':
      return { name: 'Read', args: rel(str(input, 'file_path') ?? '') };
    case 'Write':
      return { name: 'Write', args: rel(str(input, 'file_path') ?? '') };
    case 'Edit':
    case 'NotebookEdit':
      return { name: 'Update', args: rel(str(input, 'file_path') ?? str(input, 'notebook_path') ?? '') };
    case 'Glob':
    case 'Grep': {
      const { path, ...rest } = input;
      return { name: 'Search', args: formatArgs(typeof path === 'string' ? { ...rest, path: rel(path) } : rest) };
    }
    case 'WebFetch':
      return { name: 'Fetch', args: str(input, 'url') ?? '' };
    case 'WebSearch':
      return { name: 'Web Search', args: JSON.stringify(str(input, 'query') ?? '') };
    case 'Task':
    case 'Agent': {
      const agent = str(input, 'subagent_type');
      return { name: agent && agent !== 'general-purpose' ? agent : 'Task', args: str(input, 'description') ?? '' };
    }
    case 'TodoWrite':
      return { name: 'Update Todos', args: '' };
    case 'Skill':
      return { name: 'Skill', args: str(input, 'skill') ?? '' };
    default: {
      // Outil MCP : « serveur - outil (MCP) », comme dans Claude Code.
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return { name: mcp ? `${mcp[1]} - ${mcp[2]} (MCP)` : name, args: formatArgs(input) };
    }
  }
}

/** Outils du serveur MCP `sessions` (list, get, create, wait, send, end) : leurs arguments et résultats citent des sessions par identifiant. */
const SESSIONS_TOOL = /^mcp__sessions__/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Texte dont chaque identifiant de session (UUID) devient un lien vers la page de cette session. */
export function linkSessionIds(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(UUID)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <Link key={`${start}`} to={`/sessions/${m[0].toLowerCase()}`} className="cc-session-link" title="Ouvrir cette session" onClick={(e) => e.stopPropagation()}>
        {m[0]}
      </Link>,
    );
    last = start + m[0].length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Texte tronqué à `limit` lignes, suivi de « … +N lignes » tant qu'il n'est pas déplié. `links` : identifiants de session cliquables. */
function Output({ text, limit, expanded, links = false }: { text: string; limit: number; expanded: boolean; links?: boolean }) {
  const lines = text.replace(/\n+$/, '').split('\n');
  const shown = expanded ? lines : lines.slice(0, limit);
  const hidden = lines.length - shown.length;
  return (
    <>
      {links ? linkSessionIds(shown.join('\n')) : shown.join('\n')}
      {hidden > 0 && <span className="cc-more">{`\n… +${plural(hidden, 'ligne', 'lignes')} (cliquer pour déplier)`}</span>}
    </>
  );
}

/** Diff d'une modification, comme Claude Code : numéro de ligne, signe, fond vert ou rouge. */
function Patch({ hunks, expanded }: { hunks: Hunk[]; expanded: boolean }) {
  const rows: Array<{ n: number | null; sign: string; text: string }> = [];
  hunks.forEach((hunk, i) => {
    if (i > 0) rows.push({ n: null, sign: '', text: '…' });
    let oldLine = hunk.oldStart ?? NaN;
    let newLine = hunk.newStart ?? NaN;
    for (const line of hunk.lines) {
      const sign = line[0];
      if (sign === '\\') continue; // « \ No newline at end of file »
      if (sign === '-') rows.push({ n: oldLine++, sign, text: line.slice(1) });
      else {
        rows.push({ n: newLine++, sign: sign === '+' ? '+' : ' ', text: line.slice(1) });
        if (sign !== '+') oldLine++;
      }
    }
  });
  const shown = expanded ? rows : rows.slice(0, DIFF_LINES);
  const hidden = rows.length - shown.length;
  const width = String(rows.reduce((max, r) => (r.n && r.n > max ? r.n : max), 0)).length;
  return (
    <div className="cc-diff">
      {shown.map((r, i) => (
        <div key={i} className={`cc-diff-line${r.sign === '+' ? ' add' : r.sign === '-' ? ' del' : ''}`}>
          <span className="cc-diff-num" style={{ width: `${width}ch` }}>
            {r.n || ''}
          </span>
          <span className="cc-diff-sign">{r.sign}</span>
          <span className="cc-diff-text">{r.text}</span>
        </div>
      ))}
      {hidden > 0 && <div className="cc-more">{`… +${plural(hidden, 'ligne', 'lignes')} (cliquer pour déplier)`}</div>}
    </div>
  );
}

function patchSummary(hunks: Hunk[]): string {
  const lines = hunks.flatMap((h) => h.lines);
  const added = lines.filter((l) => l.startsWith('+')).length;
  const removed = lines.filter((l) => l.startsWith('-')).length;
  const parts = [added ? plural(added, 'ligne ajoutée', 'lignes ajoutées') : '', removed ? plural(removed, 'ligne supprimée', 'lignes supprimées') : ''].filter(Boolean);
  return parts.join(', ') || 'Aucun changement';
}

function formatTokens(n: number): string {
  return n < 1000 ? `${n} tokens` : `${(n / 1000).toFixed(1).replace('.', ',')}k tokens`;
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} o` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1).replace('.', ',')} Ko` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

/**
 * Corps d'un appel d'outil (sous le `⎿`), comme Claude Code : résumé pour les lectures et recherches,
 * diff pour les modifications, début de la sortie pour les commandes.
 */
function toolBody({ name, input, result, subCalls, expanded, rel }: { name: string; input: Input; result?: ToolResult; subCalls: number; expanded: boolean; rel: (path: string) => string }): React.ReactNode {
  if (name === 'TodoWrite') {
    const todos = (Array.isArray(input.todos) ? input.todos : []) as Array<{ content?: string; status?: string }>;
    return (
      <>
        {todos.map((t, i) => (
          <div key={i} className={`cc-todo ${t.status ?? ''}`}>
            {t.status === 'completed' ? '☒' : '☐'} {t.content}
          </div>
        ))}
      </>
    );
  }
  if (!result) {
    // Modification pas encore appliquée (autorisation en attente, outil en cours) : le changement proposé.
    if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      const lines = [...input.old_string.split('\n').map((l) => `-${l}`), ...input.new_string.split('\n').map((l) => `+${l}`)];
      return <Patch hunks={[{ lines }]} expanded={expanded} />;
    }
    if (name === 'AskUserQuestion') {
      const questions = (Array.isArray(input.questions) ? input.questions : []) as Array<{ question?: string }>;
      return <>{questions.map((q) => `· ${q.question ?? ''}`).join('\n')}</>;
    }
    if ((name === 'Task' || name === 'Agent') && subCalls > 0) return <>{`+${plural(subCalls, "appel d'outil", "appels d'outils")}`}</>;
    return null;
  }
  const { data } = result;
  const exit = nonZeroExit(name, result);
  if (exit) {
    return (
      <>
        <span className="cc-exit">{`Code de sortie ${exit.code}`}</span>
        {'\n'}
        <Output text={exit.output} limit={OUTPUT_LINES} expanded={expanded} />
      </>
    );
  }
  if (result.isError) {
    const text = result.text.replace(/<\/?tool_use_error>/g, '').trim();
    return <Output text={text || 'Erreur'} limit={OUTPUT_LINES} expanded={expanded} links={SESSIONS_TOOL.test(name)} />;
  }
  const hunks = Array.isArray(data.structuredPatch) ? (data.structuredPatch as Hunk[]) : [];
  switch (name) {
    case 'Edit':
    case 'NotebookEdit':
    case 'Write': {
      if (hunks.length) {
        return (
          <>
            {patchSummary(hunks)}
            <Patch hunks={hunks} expanded={expanded} />
          </>
        );
      }
      const content = str(data, 'content') ?? str(input, 'content');
      if (name === 'Write' && content !== undefined) {
        const lines = content.replace(/\n$/, '').split('\n');
        return (
          <>
            {`${plural(lines.length, 'ligne écrite', 'lignes écrites')} dans ${rel(str(input, 'file_path') ?? '')}`}
            <Patch hunks={[{ newStart: 1, lines: (expanded ? lines : lines.slice(0, PREVIEW_LINES)).map((l) => ` ${l}`) }]} expanded />
            {!expanded && lines.length > PREVIEW_LINES && <div className="cc-more">{`… +${plural(lines.length - PREVIEW_LINES, 'ligne', 'lignes')} (cliquer pour déplier)`}</div>}
          </>
        );
      }
      break;
    }
    case 'Read': {
      const lines = num((data.file ?? {}) as Input, 'numLines');
      if (lines !== undefined) return <>{plural(lines, 'ligne lue', 'lignes lues')}</>;
      break;
    }
    case 'Glob':
    case 'Grep': {
      const files = num(data, 'numFiles');
      const lines = num(data, 'numLines');
      if (str(data, 'mode') === 'content' && lines !== undefined) return <>{plural(lines, 'ligne trouvée', 'lignes trouvées')}</>;
      if (files !== undefined) return <>{plural(files, 'fichier trouvé', 'fichiers trouvés')}</>;
      break;
    }
    case 'Bash': {
      if (str(data, 'backgroundTaskId')) return <>Lancée en arrière-plan</>;
      const output = typeof data.stdout === 'string' ? [data.stdout, str(data, 'stderr')].filter(Boolean).join('\n') : result.text;
      return output.trim() ? <Output text={output} limit={OUTPUT_LINES} expanded={expanded} /> : <>(aucune sortie)</>;
    }
    case 'Task':
    case 'Agent': {
      const calls = num(data, 'totalToolUseCount');
      if (calls !== undefined) {
        const parts = [plural(calls, "appel d'outil", "appels d'outils"), formatTokens(num(data, 'totalTokens') ?? 0), formatDuration(num(data, 'totalDurationMs') ?? 0)];
        return <>{`Terminé (${parts.join(' · ')})`}</>;
      }
      if (data.isAsync) return <>Lancé en arrière-plan</>;
      break;
    }
    case 'WebFetch': {
      const bytes = num(data, 'bytes');
      if (bytes !== undefined) return <>{`${formatBytes(bytes)} reçus (${[data.code, data.codeText].filter(Boolean).join(' ')})`}</>;
      break;
    }
    case 'WebSearch': {
      const seconds = num(data, 'durationSeconds');
      if (seconds !== undefined) return <>{`Recherche effectuée en ${formatDuration(seconds * 1000)}`}</>;
      break;
    }
    case 'Skill':
      return <>Skill chargé</>;
    case 'AskUserQuestion': {
      const answers = Object.entries((data.answers ?? {}) as Record<string, unknown>);
      if (answers.length) return <>{answers.map(([question, answer]) => `· ${question} → ${String(answer)}`).join('\n')}</>;
      break;
    }
  }
  // Outils `sessions` : l'id renvoyé par create (et repris par wait, send, end) ouvre la session lancée.
  return result.text.trim() ? <Output text={result.text} limit={OUTPUT_LINES} expanded={expanded} links={SESSIONS_TOOL.test(name)} /> : <>(aucune sortie)</>;
}

/**
 * Commande shell qui a tourné et s'est terminée avec un code non nul (« Exit code 2 » suivi de sa sortie) :
 * ce n'est pas un échec de l'outil, la sortie est souvent exactement ce que l'agent cherchait (un `ls` qui
 * sonde un dossier, un `grep` sans résultat, la dernière de plusieurs commandes). Elle est présentée comme
 * un avertissement — le code ressort, la sortie garde sa couleur — plutôt qu'en bloc rouge. Un échec sans
 * sortie, ou toute autre erreur d'outil, reste une erreur.
 */
/**
 * Résultat écrit par Claude Code quand une personne a écarté l'appel : question ignorée, demande d'autorisation
 * annulée, tour interrompu pendant l'outil. Le texte brut (« The user doesn't want to proceed… STOP what you are
 * doing… ») est destiné au modèle ; affiché tel quel en rouge, il faisait croire à une panne.
 */
export const USER_DECLINED = /^The user doesn't want to proceed with this tool use/;

export function declinedByUser(result: { text: string; isError: boolean } | undefined): boolean {
  return Boolean(result?.isError && USER_DECLINED.test(result.text.trim()));
}

export function nonZeroExit(name: string, result: { text: string; isError: boolean } | undefined): { code: number; output: string } | null {
  if (!result?.isError || (name !== 'Bash' && name !== 'BashOutput')) return null;
  const match = /^\s*Exit code (\d+)\s*\n([\s\S]*)$/.exec(result.text);
  if (!match) return null;
  const output = match[2].replace(/<\/?tool_use_error>/g, '').trim();
  return output ? { code: Number(match[1]), output } : null;
}

// `declined` : appel écarté par une personne (question ignorée, demande annulée, tour interrompu pendant l'outil) ;
// ce n'est pas une panne, l'agent attend la suite.
type Severity = 'pending' | 'ok' | 'warn' | 'error' | 'declined';

/** Issue d'un appel d'outil : une commande sortie en code non nul est un avertissement, pas un échec (voir nonZeroExit). */
const toolSeverity = (name: string, result?: ToolResult): Severity => (!result ? 'pending' : declinedByUser(result) ? 'declined' : nonZeroExit(name, result) ? 'warn' : result.isError ? 'error' : 'ok');

/**
 * Autoriser depuis le transcript un outil refusé par le mode « Refuser sans demander » : fourni par la page de session
 * (contexte plutôt que prop, pour ne pas reconstruire les nœuds mémorisés du transcript), absent en lecture seule.
 */
export interface ToolPermissionActions {
  /** Outils pré-autorisés de la session (règles au format Claude Code). */
  allowed: string[];
  allow(rule: string): Promise<void>;
}
export const ToolPermissionContext = createContext<ToolPermissionActions | null>(null);

/** Refus par le mode « Refuser sans demander » : dit pourquoi, et propose d'autoriser l'outil pour la session. */
function DontAskDenial({ name, input }: { name: string; input: Input }) {
  const actions = useContext(ToolPermissionContext);
  const [busy, setBusy] = useState(false);
  const rule = ruleForCall(name, input);
  const allowed = actions?.allowed.includes(rule) ?? false;
  return (
    <span className="cc-denied">
      Refusé sans vous demander : la session est en mode « Refuser sans demander », et cet outil n'était pas autorisé d'avance.
      {actions && (
        <>
          {' '}
          {allowed ? (
            <span className="cc-allowed">
              <i className="bi bi-check2" /> {rule} est désormais autorisé pour la session.
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-outline-primary py-0 ms-1"
              disabled={busy}
              title={`Ajoute ${rule} aux outils pré-autorisés de cette session (appliqué tout de suite et aux prochaines exécutions)`}
              onClick={(e) => {
                e.stopPropagation();
                setBusy(true);
                void actions.allow(rule).finally(() => setBusy(false));
              }}
            >
              Autoriser cet outil pour la session
            </button>
          )}
          {!allowed && <span className="cc-desc"> · {rule}</span>}
        </>
      )}
    </span>
  );
}

function ToolCall({ name, input, result, subCalls, rel, subagentHref }: { name: string; input: Input; result?: ToolResult; subCalls: number; rel: (path: string) => string; /** Appel de l'outil Agent : lien vers le fil du sous-agent. */ subagentHref?: string }) {
  const [expanded, setExpanded] = useState(false);
  const header = name === 'AskUserQuestion' ? { name: result && !result.isError ? "Réponses aux questions de l'agent" : "Question de l'agent", args: '' } : toolHeader(name, input, rel);
  // Entête repliée : deux lignes de commande au plus.
  const argLines = header.args.split('\n');
  const long = argLines.length > 2 || header.args.length > 240;
  const args = expanded || !long ? header.args : `${argLines.slice(0, 2).join('\n').slice(0, 240)}…`;
  // Un clic déplie ou replie, sauf s'il termine une sélection de texte (copie d'une sortie).
  const toggle = () => {
    if (!window.getSelection()?.toString()) setExpanded((v) => !v);
  };
  const deniedByMode = Boolean(result?.isError && DONT_ASK_DENIAL.test(result.text));
  const declined = declinedByUser(result);
  const body = deniedByMode ? (
    <DontAskDenial name={name} input={input} />
  ) : declined ? (
    <>{name === 'AskUserQuestion' ? "Question écartée · l'agent attend vos instructions" : "Écarté · l'agent attend vos instructions"}</>
  ) : (
    toolBody({ name, input, result, subCalls, expanded, rel })
  );
  const severity = toolSeverity(name, result);
  return (
    <div className="cc-tool">
      <div className={`cc-call${long ? ' foldable' : ''}`} onClick={long ? toggle : undefined}>
        <span className={`cc-dot ${severity}`}>⏺</span>
        <span>
          <span className="cc-name">{header.name}</span>
          {args && <span className="cc-args">({SESSIONS_TOOL.test(name) ? linkSessionIds(args) : args})</span>}
          {subagentHref && (
            <Link to={subagentHref} className="cc-subagent-link" title="Voir le fil du sous-agent : sa consigne, ses messages et ses appels d'outils" onClick={(e) => e.stopPropagation()}>
              <i className="bi bi-robot" /> voir le fil
            </Link>
          )}
        </span>
      </div>
      {body && (
        <div className={`cc-result${severity === 'error' ? ' error' : ''}`} onClick={toggle} title={expanded ? 'Replier' : 'Déplier'}>
          <span className="cc-elbow">⎿</span>
          <div className="cc-result-body">{body}</div>
        </div>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="cc-thinking" onClick={() => setExpanded((v) => !v)}>
      <div>∴ Réflexion…</div>
      <div className="cc-thinking-text">
        <Output text={text.trim()} limit={OUTPUT_LINES} expanded={expanded} />
      </div>
    </div>
  );
}

const TASK_FEED_ICONS: Record<TaskFeedSummary['kind'], string> = { update: 'bi-pencil-square', comment: 'bi-chat-left-text', reaction: 'bi-emoji-smile' };

/**
 * Changement d'une tâche reliée transmis à l'agent, résumé en une ligne et déplié au clic (texte lu par l'agent).
 * `quiet` : note discrète (événement `task_note`), remise sans ouvrir de tour ; sinon instruction adressée à la
 * session (message du fil qui la concerne, modification par une personne d'une tâche dont elle est en charge).
 */
function TaskFeedLine({ text, feed, quiet, stamp }: { text: string; feed: TaskFeedSummary; quiet: boolean; stamp?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`cc-task-feed${quiet ? ' quiet' : ''}`} title={quiet ? "Transmis à l'agent sans interrompre son travail" : undefined}>
      {stamp}
      <div className="cc-task-feed-head" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen((v) => !v)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen((v) => !v))}>
        <i className={`bi ${TASK_FEED_ICONS[feed.kind]}`} />
        <span className="cc-task-feed-summary">{feed.summary}</span>
        {feed.taskId && (
          <Link to={`/tasks/${feed.taskId}`} className="cc-task-feed-link" onClick={(e) => e.stopPropagation()} title="Ouvrir la tâche">
            <i className="bi bi-box-arrow-up-right" />
          </Link>
        )}
      </div>
      {open && <div className="cc-task-feed-text">{text}</div>}
    </div>
  );
}

const TASK_STATUS_LABELS: Record<string, string> = { todo: 'À faire', in_progress: 'En cours', done: 'Terminée', cancelled: 'Annulée' };
const TASK_PRIORITY_LABELS: Record<string, string> = { urgent: 'Urgente', high: 'Haute', medium: 'Moyenne', low: 'Basse' };
const TASK_STATUS_ICONS: Record<string, string> = { todo: 'bi-circle', in_progress: 'bi-circle-half', done: 'bi-check-circle-fill', cancelled: 'bi-x-circle' };

/**
 * Carte d'une tâche créée, prise en charge ou changée de statut par l'agent (événement `task`, émis par le serveur
 * MCP tasks) : titre, statut, priorité ; elle ouvre la tâche dans le tableau du projet.
 */
export function TaskEventCard({ payload, stamp }: { payload: Record<string, unknown>; stamp?: React.ReactNode }) {
  const status = String(payload.status ?? '');
  const previous = payload.previousStatus ? String(payload.previousStatus) : null;
  const statusLabel = TASK_STATUS_LABELS[status] ?? status;
  const action =
    payload.action === 'created'
      ? 'Tâche créée'
      : payload.action === 'claimed'
        ? 'Tâche prise en charge'
        : previous
          ? `Tâche passée de « ${TASK_STATUS_LABELS[previous] ?? previous} » à « ${statusLabel} »`
          : 'Statut de la tâche modifié';
  const to = payload.projectId ? `/projects/${String(payload.projectId)}/tasks?task=${String(payload.taskId)}` : `/tasks/${String(payload.taskId)}`;
  return (
    <div className="cc-event-card-row">
      {stamp}
      <Link to={to} className="cc-event-card" title="Ouvrir la tâche dans le tableau">
        <span className="cc-event-card-kind">
          <i className="bi bi-kanban" /> {action}
        </span>
        <span className="cc-event-card-title">{String(payload.title ?? '')}</span>
        <span className="cc-event-card-meta">
          <span className={`cc-event-card-status ${status}`}>
            <i className={`bi ${TASK_STATUS_ICONS[status] ?? 'bi-circle'}`} /> {statusLabel}
            {payload.statusTag ? ` · ${String(payload.statusTag)}` : ''}
          </span>
          {payload.priority ? <span className={`cc-event-card-priority ${String(payload.priority)}`}>Priorité {(TASK_PRIORITY_LABELS[String(payload.priority)] ?? String(payload.priority)).toLowerCase()}</span> : null}
        </span>
      </Link>
    </div>
  );
}

/** Carte d'une instruction du contexte écrite par l'agent (événement `context`) : elle ouvre l'instruction dans la page Contexte. */
export function ContextEventCard({ payload, stamp }: { payload: Record<string, unknown>; stamp?: React.ReactNode }) {
  const query = new URLSearchParams({ ...(payload.agentId ? { library: String(payload.agentId) } : {}), instruction: String(payload.instructionId ?? '') });
  const library = payload.library ? `bibliothèque de ${String(payload.library)}` : payload.agentId ? "bibliothèque d'un agent" : 'contexte du projet';
  return (
    <div className="cc-event-card-row">
      {stamp}
      <Link to={`/projects/${String(payload.projectId)}/context?${query.toString()}`} className="cc-event-card" title="Ouvrir l'instruction">
        <span className="cc-event-card-kind">
          <i className="bi bi-journal-text" /> {payload.action === 'created' ? 'Instruction créée' : 'Instruction mise à jour'} · {library}
        </span>
        <span className="cc-event-card-title">{String(payload.path ?? '')}</span>
        {payload.description ? <span className="cc-event-card-desc">{String(payload.description)}</span> : null}
        <span className="cc-event-card-meta">
          <span>v{String(payload.version ?? '')}</span>
          {payload.changeNote ? <span className="cc-event-card-desc">{String(payload.changeNote)}</span> : null}
        </span>
      </Link>
    </div>
  );
}

/** Un élément du travail de l'agent dans un tour : un message, un appel d'outil ou une réflexion. */
interface WorkItem {
  key: string;
  node: React.ReactNode;
  /** Gardé en vue hors du groupe replié : le dernier message d'une suite, les questions de l'agent. */
  pinned: boolean;
  /** Appels d'outils : nom affiché et issue. */
  tool?: { name: string; args: string; severity: Severity };
  text?: boolean;
  /** Note discrète d'une tâche reliée (`task_note`). */
  note?: boolean;
  /** Date de l'événement (en-tête du message de l'agent, en mode conversation). */
  at: string;
}

/** Longueur à partir de laquelle un message de l'agent n'est plus de la simple narration entre deux outils. */
const SUBSTANTIAL_TEXT_CHARS = 240;

/**
 * Message de l'agent qui mérite de rester en vue même au milieu d'un tour : long, ou structuré (plusieurs
 * paragraphes, liste, bloc de code, tableau). Le 09/11/2026, une réponse complète écrite avant un `tasks.comment`
 * disparaissait dans « 1 étape · 1 message », seul le court message de fin restant visible.
 */
export function isSubstantialText(text: string): boolean {
  const t = text.trim();
  if (t.length >= SUBSTANTIAL_TEXT_CHARS) return true;
  return /\n\s*\n|\n\s*([-*+]|\d+[.)])\s|```|\n\s*\|/.test(t);
}

/**
 * Étapes de l'agent repliées en une ligne (sans le détail technique) : `⏺ 12 étapes · Read ×4 · Bash ×5`,
 * dépliée au clic. `live` : le tour continue, son dernier appel d'outil reste nommé (avec `…` tant qu'il
 * tourne) — la ligne change sur place plutôt que de clignoter entre deux appels.
 */
function WorkGroup({ items, live, plain = false }: { items: WorkItem[]; live: boolean; plain?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const tools = items.filter((i) => i.tool).map((i) => i.tool!);
  const messages = items.filter((i) => i.text).length;
  const notes = items.filter((i) => i.note).length;
  const thoughts = items.filter((i) => !i.tool && !i.text && !i.note).length;
  // Dans l'ordre de première utilisation : les noms gardent leur place pendant que les compteurs montent.
  const counts = new Map<string, number>();
  tools.forEach((t) => counts.set(t.name, (counts.get(t.name) ?? 0) + 1));
  const names = [...counts.entries()];
  const errors = tools.filter((t) => t.severity === 'error').length;
  // En conversation, pas de commande en cours sous les yeux : l'indicateur « réfléchit… » suffit.
  const latest = live && !plain ? tools[tools.length - 1] : undefined;
  const parts = [
    tools.length ? plural(tools.length, 'étape', 'étapes') : '',
    messages ? plural(messages, 'message', 'messages') : '',
    ...names.slice(0, 4).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)),
    names.length > 4 ? '…' : '',
    notes ? plural(notes, 'note de tâche', 'notes de tâche') : '',
  ].filter(Boolean);
  if (!parts.length && thoughts) parts.push('Réflexion');
  const severity = live ? 'pending' : errors ? 'warn' : 'ok';
  return (
    <div className="cc-tool cc-group">
      <div className="cc-call foldable" onClick={() => setExpanded((v) => !v)} title={expanded ? 'Replier les étapes' : 'Voir les étapes'}>
        <span className={`cc-dot ${severity}`}>⏺</span>
        <span className="cc-group-summary">
          <span className="cc-group-caret">{expanded ? '▾' : '▸'}</span> {parts.join(' · ')}
          {errors > 0 && <span className="cc-yellow">{` · ${plural(errors, 'erreur', 'erreurs')}`}</span>}
          {latest && (
            <span className="cc-group-running">
              {' · '}
              {latest.name}
              {latest.args ? `(${latest.args.split('\n')[0].slice(0, 80)})` : ''}
              {latest.severity === 'pending' ? '…' : ''}
            </span>
          )}
        </span>
      </div>
      {expanded && <div className="cc-group-body">{items.map((i) => i.node)}</div>}
    </div>
  );
}

function describeResult(p: Record<string, unknown>, technical: boolean): string {
  const parts: string[] = [];
  if (typeof p.duration_ms === 'number') parts.push(formatDuration(p.duration_ms));
  if (typeof p.total_cost_usd === 'number') parts.push(formatCost(p.total_cost_usd));
  if (technical && typeof p.num_turns === 'number') parts.push(`${p.num_turns} échange${p.num_turns > 1 ? 's' : ''} avec le modèle`);
  return parts.join(' · ');
}

/** Marge sous laquelle le transcript est considéré comme « en bas » et suit les nouveaux événements. */
const STICK_MARGIN = 80;

/**
 * Transcript d'une session, calqué sur l'affichage de Claude Code : instructions préfixées par >, réponses ⏺,
 * appels d'outils `⏺ Outil(arguments)` suivis de leur résultat `⎿` (résumé, diff ou début de sortie). Les
 * demandes d'autorisation n'y laissent pas de trace : un refus apparaît comme l'erreur de l'outil.
 * `technical` ajoute les lignes de service (démarrage, autorisations, audit des connexions, erreurs brutes) et
 * montre chaque étape ; sinon les étapes d'un tour sont repliées en une ligne (`WorkGroup`).
 * `draft` : réponse en cours d'écriture (streaming), affichée en bas avec un curseur jusqu'au message complet.
 * `busy` : l'agent travaille (sans attendre de réponse) ; en conversation, une simple ligne « réfléchit… » le dit.
 * `subagentLinks` : les appels de l'outil Agent mènent au fil de leur sous-agent (pages/SubagentPage.tsx).
 */
export default function Transcript({ events, draft = null, autoScroll = true, technical = false, loading = false, participants = null, busy = false, subagentLinks = false }: { events: SessionEvent[]; draft?: SessionLiveDraft | null; autoScroll?: boolean; technical?: boolean; loading?: boolean; participants?: ChatParticipants | null; busy?: boolean; /** Lien « voir le fil » sur les appels de l'outil Agent (pas sur une page publique : la page du sous-agent est dans l'application). */ subagentLinks?: boolean }) {
  // Sans le détail technique et avec ses interlocuteurs, la session se lit comme une conversation (`ChatRow`).
  const chat = !technical && participants ? participants : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Par appel d'outil (tool_use_id) : son résultat (événement claude.user) et, pour un sous-agent, le nombre de
  // ses propres appels. `cwd` : dossier de travail annoncé par Claude Code, pour afficher des chemins relatifs.
  const { results, subCalls, cwd } = useMemo(() => {
    const results = new Map<string, ToolResult>();
    const subCalls = new Map<string, number>();
    let cwd = '';
    for (const e of events) {
      const p = e.payload as { subtype?: string; cwd?: string; parent_tool_use_id?: string | null; tool_use_result?: unknown; message?: { content?: unknown } };
      if (e.type === 'claude.system' && p.subtype === 'init' && typeof p.cwd === 'string') cwd = p.cwd;
      const content = p.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ContentBlock[]) {
        if (e.type === 'claude.user' && block.type === 'tool_result' && block.tool_use_id) {
          const data = p.tool_use_result && typeof p.tool_use_result === 'object' && !Array.isArray(p.tool_use_result) ? (p.tool_use_result as Record<string, unknown>) : {};
          results.set(block.tool_use_id, { text: toolResultText(block.content), isError: Boolean(block.is_error), data });
        } else if (e.type === 'claude.assistant' && block.type === 'tool_use' && p.parent_tool_use_id) {
          subCalls.set(p.parent_tool_use_id, (subCalls.get(p.parent_tool_use_id) ?? 0) + 1);
        }
      }
    }
    return { results, subCalls, cwd };
  }, [events]);
  // Le transcript suit les nouveaux événements tant qu'on est en bas ; remonter pour relire suspend le suivi.
  useEffect(() => {
    const el = containerRef.current;
    if (autoScroll && el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length, draft?.text.length, draft?.thinking, busy, autoScroll]);

  // Les nœuds des événements journalisés ne sont reconstruits qu'à l'arrivée d'événements (ou au changement de
  // mode) : pendant qu'un agent écrit, le brouillon est relevé toutes les 400 ms et seul le bloc « en direct »
  // change. React retrouve les mêmes éléments (même référence) et ne re-rend pas les milliers de nœuds d'une
  // longue session ; l'état local des appels (dépliés) et des groupes est conservé.
  const { nodes, tailAgent } = useMemo(() => {
    const rel = (path: string) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);
    const nodes: React.ReactNode[] = [];
    // Sans le détail technique, le travail de l'agent entre deux événements affichés (un tour, le plus souvent)
    // est replié : son dernier message et ses questions restent en vue, les étapes entre deux sont rassemblées
    // en une ligne chacune (`WorkGroup`), dépliée au clic.
    let work: WorkItem[] = [];
    const flushWork = (live: boolean): React.ReactNode[] => {
      const items = work;
      work = [];
      let lastText = -1;
      items.forEach((item, i) => {
        if (item.text) lastText = i;
      });
      const out: React.ReactNode[] = [];
      let run: WorkItem[] = [];
      const closeRun = (end: boolean) => {
        if (!run.length) return;
        const tail = live && end;
        // Un groupe est identifié par sa première étape qui n'est pas un message : quand un nouveau message arrive,
        // le précédent rejoint le groupe, qui reste le même élément (replié ou non) au lieu d'être remplacé.
        const key = `work-${(run.find((i) => !i.text) ?? run[0]).key}`;
        // Rien à replier dans un message seul — sauf en fin de tour en cours, où l'étape suivante le replierait
        // un instant plus tard.
        // Notes seules (arrivées pendant que l'agent attend) : rien à replier non plus.
        if ((!tail && run.every((i) => i.text || !i.tool) && run.filter((i) => i.text).length <= 1) || run.every((i) => i.note)) out.push(...run.map((i) => i.node));
        else out.push(<WorkGroup key={key} items={run} live={tail} plain={Boolean(chat)} />);
        run = [];
      };
      items.forEach((item, i) => {
        if (item.pinned || i === lastText) {
          closeRun(false);
          out.push(item.node);
        } else run.push(item);
      });
      closeRun(true);
      // En conversation, tout le tour de l'agent forme un seul message, daté de sa première étape.
      if (chat && out.length && items.length)
        return [
          <ChatRow key={`turn-${items[0].key}`} who="agent" chat={chat} at={items[0].at}>
            {out}
          </ChatRow>,
        ];
      return out;
    };
    // Repères de temps, discrets : un séparateur à chaque changement de jour, l'heure sur les instructions,
    // les fins de tour et les changements d'état, et sur les réponses quand la minute a changé.
    let lastDay = '';
    let lastClock = '';
    for (const e of events) {
      const p = e.payload as Record<string, unknown>;
      // Messages internes d'un sous-agent : Claude Code n'en montre que le décompte, sur l'appel qui l'a lancé.
      if (p.parent_tool_use_id && (e.type === 'claude.assistant' || e.type === 'claude.user')) continue;
      const day = new Date(e.createdAt).toDateString();
      if (day !== lastDay) lastClock = '';
      const stamp = (always = false) => {
        const clock = clockTime(e.createdAt);
        if (!always && clock === lastClock) return null;
        lastClock = clock;
        return (
          <time className="cc-time" dateTime={e.createdAt} title={new Date(e.createdAt).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' })}>
            {clock}
          </time>
        );
      };
      const before = nodes.length;
      switch (e.type) {
        case 'instruction': {
          // Changement d'une tâche adressé à la session : une ligne repliée plutôt qu'un long bloc cité.
          const feed = !p.pending ? describeTaskFeed(String(p.text ?? '')) : null;
          if (feed) {
            nodes.push(<TaskFeedLine key={e.id} text={String(p.text)} feed={feed} quiet={false} stamp={stamp(true)} />);
            break;
          }
          const attachments = Array.isArray(p.attachments) ? (p.attachments as AttachmentRef[]) : [];
          // Instruction envoyée depuis la page et pas encore journalisée : affichée aussitôt, fichiers lus en local.
          const local = Array.isArray(p.localAttachments) ? (p.localAttachments as LocalAttachment[]) : [];
          if (chat) {
            nodes.push(
              <ChatRow key={e.id} who="human" chat={chat} author={readAuthor(p.author)} at={p.pending ? null : e.createdAt} pending={Boolean(p.pending)}>
                <div className="cc-chat-text">{String(p.text ?? '')}</div>
                {attachments.length > 0 && <InstructionAttachments sessionId={e.sessionId} attachments={attachments} />}
                {local.length > 0 && <LocalAttachments attachments={local} />}
              </ChatRow>,
            );
            break;
          }
          nodes.push(
            <div key={e.id} className={`cc-user${p.pending ? ' pending' : ''}`} title={p.pending ? 'Envoi en cours…' : undefined}>
              {stamp(true)}
              {readAuthor(p.author) && <span className="cc-time">{readAuthor(p.author)!.name}</span>}
              <span className="cc-user-text">{String(p.text ?? '')}</span>
              {p.preamble === true && <span className="cc-note"> (précédée, pour le modèle, du résumé de la conversation précédente)</span>}
              {attachments.length > 0 && <InstructionAttachments sessionId={e.sessionId} attachments={attachments} />}
              {local.length > 0 && <LocalAttachments attachments={local} />}
            </div>,
          );
          break;
        }
        case 'claude.assistant': {
          const content = ((p.message as { content?: ContentBlock[] } | undefined)?.content ?? []) as ContentBlock[];
          content.forEach((block, i) => {
            const key = `${e.id}-${i}`;
            let item: WorkItem | null = null;
            if (block.type === 'text' && block.text?.trim()) {
              const node = chat ? (
                <Markdown key={key} className="cc-body cc-chat-text" text={block.text} />
              ) : (
                <div key={key} className="cc-assistant">
                  <span className="cc-dot">⏺</span>
                  <Markdown className="cc-body" text={block.text} />
                  {stamp()}
                </div>
              );
              // Une vraie réponse (longue, en paragraphes, en liste…) reste en vue même suivie d'autres étapes ;
              // seule la narration courte (« Je regarde le code. ») rejoint le groupe replié.
              item = { key, node, pinned: isSubstantialText(block.text), text: true, at: e.createdAt };
            } else if (block.type === 'tool_use') {
              const name = block.name ?? 'outil';
              const input = block.input ?? {};
              const result = block.id ? results.get(block.id) : undefined;
              const subagentHref = subagentLinks && block.id && (name === 'Agent' || name === 'Task') ? `/sessions/${e.sessionId}/subagents/${encodeURIComponent(block.id)}` : undefined;
              const node = <ToolCall key={key} name={name} input={input} result={result} subCalls={block.id ? (subCalls.get(block.id) ?? 0) : 0} rel={rel} subagentHref={subagentHref} />;
              item = { key, node, pinned: name === 'AskUserQuestion', tool: { ...toolHeader(name, input, rel), severity: toolSeverity(name, result) }, at: e.createdAt };
            } else if (block.type === 'thinking' && block.thinking?.trim()) {
              item = { key, node: <Thinking key={key} text={block.thinking} />, pinned: false, at: e.createdAt };
            }
            if (!item) return;
            if (technical) nodes.push(item.node);
            else work.push(item);
          });
          break;
        }
        case 'task_note': {
          // Note discrète : rangée avec les étapes de l'agent (repliée avec elles pendant un tour), une ligne pâle sinon.
          const text = String(p.text ?? '');
          const feed = describeTaskFeed(text) ?? { kind: 'update' as const, taskId: null, title: null, summary: text.split('\n')[0] };
          const node = <TaskFeedLine key={e.id} text={text} feed={feed} quiet stamp={stamp()} />;
          if (technical) nodes.push(node);
          else work.push({ key: e.id, node, pinned: false, note: true, at: e.createdAt });
          break;
        }
        case 'claude.user': {
          // Seule l'interruption laisse une trace ; les résultats d'outils sont rattachés à leur appel.
          const content = (p.message as { content?: unknown } | undefined)?.content;
          const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as ContentBlock[]).map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('') : '';
          if (text.startsWith('[Request interrupted by user')) {
            // Interruption demandée par une personne : rien de grave, pas de rouge.
            nodes.push(
              <div key={e.id} className="cc-result">
                <span className="cc-elbow">⎿</span>
                <div className="cc-result-body">Interrompu · que doit faire l'agent à la place ?</div>
              </div>,
            );
          }
          break;
        }
        case 'claude.result': {
          // Tour vide ouvert par le CLI sur une notification de tâche de fond (à la reprise après un redémarrage) :
          // il ne répond à aucune instruction, l'afficher « Terminé » ferait croire que le tour est fini.
          if (!technical && (p.origin as { kind?: unknown } | undefined)?.kind === 'task-notification' && p.num_turns === 0) break;
          // Tour interrompu par l'humain (bouton « Interrompre », Échap) : depuis le CLI 2.1.300, le résultat est marqué
          // en erreur avec un diagnostic interne (`[ede_diagnostic] …`). Ce n'est pas une panne : l'agent attend la suite.
          const interrupted = p.terminal_reason === 'aborted_streaming' || p.terminal_reason === 'aborted_tools';
          const failed = Boolean(p.is_error) && !interrupted;
          // En conversation, un tour qui s'est bien terminé ne laisse pas de ligne : la réponse de l'agent suffit.
          if (chat && !interrupted && !failed) break;
          nodes.push(
            <div key={e.id} className={`cc-note${failed ? ' error' : ''}`}>
              {stamp(true)}
              {interrupted
                ? `⏹ Interrompu${describeResult(p, technical) ? ` · ${describeResult(p, technical)}` : ''}`
                : failed
                  ? `✗ L'agent s'est arrêté sur une erreur${Array.isArray(p.errors) && p.errors.length ? ` : ${p.errors.join(' ; ')}` : technical ? ` (${String(p.subtype)})` : ''}`
                  : `✻ Terminé${describeResult(p, technical) ? ` · ${describeResult(p, technical)}` : ''}`}
            </div>,
          );
          break;
        }
        case 'cleanup': {
          const action = String(p.action ?? '');
          const k = (v: unknown) => (typeof v === 'number' ? `${Math.round(v / 1000)} k tokens` : '?');
          const text =
            action === 'purged'
              ? `Transcript purgé : ${String(p.deleted)} événement(s) de plus de ${String(p.retentionDays)} jours supprimé(s)`
              : action === 'compacting'
                ? `Contexte de ${k(p.before)} au-dessus du seuil (${k(p.threshold)}) : compaction de la conversation`
                : action === 'compacted'
                  ? `Conversation compactée : ${k(p.before)} → ${k(p.after)}`
                  : action === 'reset'
                    ? `${p.reason === 'fresh' ? 'Exécution planifiée' : p.manual ? 'À la demande' : `Contexte de ${k(p.before)} au-dessus du seuil (${k(p.threshold)})`} : la conversation repart de zéro${p.manual ? '' : ' au prochain lancement'}${p.summary ? ', avec un résumé des derniers échanges' : ''}${p.reason === 'fresh' && typeof p.before === 'number' ? ` (${k(p.before)} oubliés)` : ''}`
                    : action === 'skipped'
                      ? `Nettoyage de la conversation reporté : ${String(p.reason ?? '')}`
                      : action === 'failed'
                        ? `Nettoyage en erreur : ${String(p.error ?? '')}`
                        : action === 'nothing'
                          ? 'Nettoyage : rien à faire'
                          : 'Réglages de nettoyage enregistrés';
          if (action === 'set' && !technical) break;
          nodes.push(
            <div key={e.id} className={`cc-note${action === 'failed' ? ' error' : ''}`}>
              🧹 {text}
            </div>,
          );
          break;
        }
        case 'claude.system':
          if (p.subtype === 'compact_boundary') {
            const meta = (p.compact_metadata ?? {}) as { trigger?: string; pre_tokens?: number; post_tokens?: number };
            nodes.push(
              <div key={e.id} className="cc-note">
                🧹 Conversation compactée${meta.trigger === 'auto' ? ' automatiquement' : ''}
                {typeof meta.pre_tokens === 'number' ? ` · ${Math.round(meta.pre_tokens / 1000)} k tokens${typeof meta.post_tokens === 'number' ? ` → ${Math.round(meta.post_tokens / 1000)} k` : ''}` : ''}
              </div>,
            );
          } else if (technical && p.subtype === 'init') {
            nodes.push(
              <div key={e.id} className="cc-note">
                ✻ Claude Code {String(p.claude_code_version ?? '')} · {String(p.model ?? '')} · {String(p.cwd ?? '')}
              </div>,
            );
          } else if (technical && p.subtype === 'task_notification' && p.summary) {
            // Fin d'une commande ou d'un agent lancé en arrière-plan : son résumé est souvent la commande brute,
            // du détail technique.
            nodes.push(
              <div key={e.id} className="cc-note">
                ⏺ {String(p.summary)}
              </div>,
            );
          }
          break;
        case 'config': {
          // Réglage modifié par un humain en cours de session (modèle, autorisations...).
          const changes = (p.changes ?? {}) as Record<string, unknown>;
          const applied = new Set(Array.isArray(p.applied) ? (p.applied as string[]) : []);
          const parts = Object.entries(changes).map(([key, value]) => {
            const label =
              key === 'permissionMode'
                ? `autorisations : ${permissionModeLabels[String(value ?? 'default')] ?? String(value)}`
                : key === 'model'
                  ? `modèle : ${value ? String(value) : 'réglage général'}`
                  : key === 'allowedTools'
                    ? `outils pré-autorisés : ${value ? String(value).split(',').join(', ') : '(aucun)'}`
                    : `${key} : ${value === null ? '(retiré)' : JSON.stringify(value)}`;
            return applied.has(key) ? label : `${label} (au prochain lancement)`;
          });
          nodes.push(
            <div key={e.id} className="cc-note">
              ⚙ Réglages modifiés · {parts.join(' · ')}
            </div>,
          );
          break;
        }
        case 'schedule': {
          const action = String(p.action ?? '');
          const named = p.name ? ` « ${String(p.name)} »` : '';
          const status = String(p.status ?? '');
          const text =
            action === 'run'
              ? `Exécution planifiée${named}${p.manual ? ' (lancée à la main)' : ''}`
              : action === 'done'
                ? `Fin de l'exécution${named} : ${String(p.outcome ?? 'terminée')}${p.message && status !== 'failed' ? ` (${String(p.message)})` : ''}`
                : action === 'skipped'
                  ? `Exécution planifiée${named} ignorée : ${String(p.reason ?? '')}`
                  : action === 'set'
                    ? `Planification${named} enregistrée (${describeCron(String(p.cron ?? ''))}, ${String(p.timezone ?? '')})`
                    : action === 'disabled'
                      ? `Planification${named} mise en pause`
                      : action === 'resumed'
                        ? `Planification${named} reprise`
                        : 'Planification retirée';
          if (action === 'spawned' && p.runSessionId) {
            nodes.push(
              <div key={e.id} className="cc-note">
                {stamp(true)}⏰ Exécution planifiée{named}{p.manual ? ' (lancée à la main)' : ''} dans une nouvelle session :{' '}
                <Link to={`/sessions/${String(p.runSessionId)}`}>ouvrir</Link>
              </div>,
            );
            break;
          }
          const warn = action === 'skipped' || (action === 'done' && (status === 'blocked' || status === 'failed' || status === 'timeout'));
          nodes.push(
            <div key={e.id} className={`cc-note${warn ? ' warn' : ''}`}>
              {stamp(true)}⏰ {text}
            </div>,
          );
          break;
        }
        case 'system':
          // Les avis (`notice`, ex. interruption par un redémarrage du serveur) sont toujours affichés ; le reste en mode technique.
          if (p.selfTurn) {
            // Tour repris par l'agent de lui-même (réveil sur une tâche de fond) : repère en tête du tour, qui ne commence
            // par aucune instruction (providers/selfTurn.ts).
            nodes.push(
              <div key={e.id} className="cc-note cc-self-turn">
                {stamp(true)}⏰ {String(p.message ?? '')}
              </div>,
            );
          } else if (p.notice) {
            nodes.push(
              <div key={e.id} className="cc-note warn">
                {stamp(true)}⚠ {String(p.message ?? '')}
              </div>,
            );
          } else if (technical) {
            nodes.push(
              <div key={e.id} className="cc-note">
                · {String(p.message ?? JSON.stringify(p))}
              </div>,
            );
          }
          break;
        case 'stderr':
          if (technical) {
            nodes.push(
              <div key={e.id} className="cc-note error">
                {String(p.text ?? '')}
              </div>,
            );
          }
          break;
        case 'task':
        case 'context': {
          // Cartes des tâches et des instructions touchées par l'agent : gardées en vue hors des étapes repliées.
          const node = e.type === 'task' ? <TaskEventCard key={e.id} payload={p} stamp={stamp()} /> : <ContextEventCard key={e.id} payload={p} stamp={stamp()} />;
          if (technical) nodes.push(node);
          else work.push({ key: e.id, node, pinned: true, at: e.createdAt });
          break;
        }
        case 'connection': {
          // Audit d'un accès à un système externe (outils MCP `connections` et `google`) : l'appel d'outil est
          // déjà affiché, la ligne d'audit relève du détail technique.
          if (!technical) break;
          const summary = String(p.summary ?? '');
          nodes.push(
            <div key={e.id} className={`cc-note${p.ok ? '' : ' error'}`} title={summary}>
              <i className={`bi ${p.kind === 'ssh' ? 'bi-hdd-network' : p.kind === 'gmail' ? 'bi-envelope' : p.kind === 'drive' ? 'bi-google' : 'bi-database'} me-1`} />
              {String(p.action)} · {String(p.connection)} · {summary.length > 100 ? `${summary.slice(0, 97)}…` : summary}
              {p.ok ? ` — ${p.note ? `${String(p.note)}, ` : ''}${String(p.durationMs)} ms` : ` — échec : ${String(p.error ?? '')}`}
            </div>,
          );
          break;
        }
        case 'stdout':
          nodes.push(
            <div key={e.id} className="cc-line">
              {String(p.text ?? '')}
            </div>,
          );
          break;
        case 'request': {
          // Autorisations et questions : l'appel d'outil concerné porte déjà l'information (résultat, refus, réponses).
          const known = p.type === 'permission' || p.type === 'question';
          if (known && !technical) break;
          const payload = (p.payload ?? {}) as { toolName?: string; input?: Record<string, unknown> };
          const text =
            p.type === 'permission' && payload.toolName
              ? `L'agent a demandé l'autorisation de ${describeTool(payload.toolName, payload.input ?? {}).action}`
              : p.type === 'question'
                ? `L'agent vous a posé une question : ${String(p.title)}`
                : `L'agent vous a demandé : ${String(p.title)}`;
          nodes.push(
            <div key={e.id} className={`cc-note${known ? '' : ' warn'}`}>
              ⏸ {text}
            </div>,
          );
          break;
        }
        case 'request.answered': {
          const known = p.type === 'permission' || p.type === 'question';
          if (known && !technical) break;
          const r = (p.response ?? {}) as Record<string, unknown>;
          const text =
            r.decision === 'allow' ? (r.always ? 'Autorisé pour toute la session' : 'Autorisé') : r.decision === 'deny' ? `Refusé${r.message ? ` : ${String(r.message)}` : ''}` : r.answers ? Object.values(r.answers as Record<string, string>).join(' ; ') : JSON.stringify(r);
          nodes.push(
            <div key={e.id} className="cc-note">
              ▶ Votre réponse : {text}
            </div>,
          );
          break;
        }
        case 'status': {
          const labels: Record<string, string> = { completed: 'Session terminée', failed: 'Session terminée avec une erreur', stopped: 'Session arrêtée', interrupted: 'Session interrompue' };
          nodes.push(
            <div key={e.id} className={`cc-note${p.status === 'failed' ? ' error' : ''}`}>
              {stamp(true)}■ {labels[String(p.status)] ?? `Session ${String(p.status)}`}
              {p.error ? ` — ${String(p.error)}` : ''}
            </div>,
          );
          break;
        }
        default:
          // Événements techniques (rate limit, progression, consommation...) : non affichés.
          break;
      }
      // Le travail de l'agent accumulé jusque-là précède le premier événement affiché après lui.
      if (nodes.length > before && work.length) nodes.splice(before, 0, ...flushWork(false));
      // Séparateur de jour, seulement devant un événement qui s'affiche.
      if (nodes.length > before && day !== lastDay) {
        lastDay = day;
        nodes.splice(
          before,
          0,
          <div key={`day-${e.id}`} className="cc-day">
            <span>{dayLabel(e.createdAt)}</span>
          </div>,
        );
      }
    }
    const tail = flushWork(true);
    nodes.push(...tail);
    return { nodes, tailAgent: Boolean(chat && tail.length) };
  }, [events, technical, chat, results, subCalls, cwd, subagentLinks]);
  // Ce que l'agent écrit en ce moment : le texte grandit à chaque relevé, puis le message journalisé le remplace.
  // En conversation, elle prolonge le message de l'agent du tour en cours, ou en ouvre un.
  // Tant que l'agent travaille sans écrire, la conversation montre seulement qu'il réfléchit.
  const liveBody = draft?.text.trim() ? (
    <Markdown className="cc-body cc-chat-text" text={draft.text} />
  ) : draft?.thinking || busy ? (
    <div className="cc-thinking cc-chat-thinking">
      <div>{chat?.agent.name ?? "L'agent"} réfléchit…</div>
    </div>
  ) : null;
  const live = chat ? (
    liveBody &&
    (tailAgent ? (
      <div className="cc-chat-cont cc-live">{liveBody}</div>
    ) : (
      <div className="cc-live">
        <ChatRow who="agent" chat={chat} at={null}>
          {liveBody}
        </ChatRow>
      </div>
    ))
  ) : draft?.text.trim() ? (
    <div className="cc-assistant cc-live">
      <span className="cc-dot">⏺</span>
      <Markdown className="cc-body" text={draft.text} />
    </div>
  ) : draft?.thinking ? (
    <div className="cc-thinking cc-live">
      <div>∴ Réflexion…</div>
    </div>
  ) : null;

  return (
    <div
      className={`cc-transcript${chat ? ' cc-chat' : ''}`}
      ref={containerRef}
      onScroll={(ev) => {
        const el = ev.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_MARGIN;
      }}
    >
      {nodes.length === 0 && !live && <div className="cc-dimmer">{loading ? 'Chargement du fil…' : 'Aucun échange pour le moment.'}</div>}
      {nodes}
      {live}
    </div>
  );
}
