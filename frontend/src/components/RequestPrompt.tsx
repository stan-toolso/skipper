import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { HumanRequest } from '../graphql/operations';
import { describeTool, editableRules, parseRuleLines, requestNote, suggestedModes } from '../lib/humanize';
import { canAutoFocus } from '../lib/device';
import { promptTakesKey, useRequestAnswer } from '../lib/requestAnswer';
import Markdown from './Markdown';
import { SecretsButton, secretsPayload } from './SecretsRequest';

interface Option {
  label: string;
  description?: string;
  value: () => Record<string, unknown> | 'deny-with-message';
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** Le prompt a-t-il la main sur le clavier (premier prompt affiché de la page) ? */
const KeyboardTurn = createContext(true);

function OptionList({ options, onPick, disabled }: { options: Option[]; onPick: (o: Option) => void; disabled: boolean }) {
  const [cursor, setCursor] = useState(0);
  const first = useContext(KeyboardTurn);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Raccourcis clavier façon Claude Code : chiffres, flèches, Entrée. Ils valent aussi quand le focus est dans la
    // zone de saisie principale (textarea) tant qu'elle est vide. Une seule réponse part (useRequestAnswer) ; la
    // touche est en plus ignorée si elle est maintenue, si le prompt est masqué (page du workbench en arrière-plan)
    // ou s'il n'est pas le premier de la page (lib/requestAnswer.ts, promptTakesKey).
    const handler = (ev: KeyboardEvent) => {
      const target = ev.target instanceof HTMLElement ? ev.target : null;
      const box = ref.current?.closest('.cc-prompt') ?? ref.current;
      const take = promptTakesKey({
        locked: disabled,
        repeat: ev.repeat,
        modifier: ev.altKey || ev.ctrlKey || ev.metaKey,
        targetTag: target?.tagName ?? null,
        targetValue: target instanceof HTMLTextAreaElement ? target.value : '',
        targetInPrompt: Boolean(target && box?.contains(target)),
        visible: document.visibilityState !== 'hidden' && Boolean(ref.current && ref.current.getClientRects().length > 0),
        first,
      });
      if (!take) return;
      const n = Number(ev.key);
      if (n >= 1 && n <= options.length) onPick(options[n - 1]);
      else if (ev.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, options.length - 1));
      else if (ev.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
      else if (ev.key === 'Enter' && !ev.shiftKey) onPick(options[cursor]);
      else return;
      ev.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [options, cursor, onPick, disabled, first]);

  return (
    <div ref={ref} className="cc-options">
      {options.map((o, i) => (
        <button key={o.label} type="button" className={`cc-option${i === cursor ? ' selected' : ''}`} disabled={disabled} onMouseEnter={() => setCursor(i)} onClick={() => onPick(o)}>
          <span className="cc-cursor">{i === cursor ? '❯' : ''}</span>
          {i + 1}. {o.label}
          {o.description && <span className="cc-desc"> — {o.description}</span>}
        </button>
      ))}
    </div>
  );
}

/** Prompt d'autorisation d'outil, présenté comme dans Claude Code. */
function PermissionPrompt({ request, answer, busy }: { request: HumanRequest; answer: (r: Record<string, unknown>) => void; busy: boolean }) {
  const p = request.payload as { toolName?: string; input?: Record<string, unknown>; suggestions?: unknown[] };
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState('');
  // Règles à mémoriser : suggestions du SDK généralisées par préfixe, modifiables avant de répondre.
  const proposed = editableRules(p.suggestions, p.toolName, p.input);
  const [ruleText, setRuleText] = useState(proposed.join('\n'));
  const rules = parseRuleLines(ruleText);
  const modes = suggestedModes(p.suggestions);
  const canAlways = proposed.length > 0 || modes.length > 0;
  const ruleHint = [...modes, ...(proposed.length ? [rules.length ? `règle${rules.length > 1 ? 's' : ''} ci-dessus` : 'aucune règle'] : [])].join(', ');
  const remember = (scope: 'session' | 'project') => ({ decision: 'allow', scope, ...(proposed.length ? { rules } : {}) });
  const input = p.input ?? {};
  const desc = describeTool(p.toolName ?? 'outil', input);
  const detail = desc.detail ?? (typeof input.content === 'string' ? undefined : JSON.stringify(input, null, 2));
  const content = typeof input.content === 'string' ? input.content : typeof input.new_string === 'string' ? input.new_string : undefined;
  // Les outils du coffre passent la commande en message : ne pas la répéter sous le détail (deux blocs identiques
  // qui doublent la hauteur de la demande) ; seule une éventuelle remarque à la suite est gardée.
  const note = requestNote(request.message, detail, content);

  const options: Option[] = [
    { label: 'Oui, autoriser', value: () => ({ decision: 'allow' }) },
    ...(canAlways
      ? [
          { label: 'Oui, et ne plus demander pour cette session', description: ruleHint, value: () => remember('session') } as Option,
          { label: 'Oui, et ne plus demander dans ce projet', description: `${ruleHint} (mémorisé pour toutes les sessions du projet)`, value: () => remember('project') } as Option,
        ]
      : []),
    { label: "Non, et expliquer ce qu'il faut faire à la place", value: () => 'deny-with-message' as const },
  ];

  return (
    <div className="cc-prompt">
      <div className="cc-prompt-title">L'agent souhaite {desc.action}</div>
      {detail && <div className="cc-prompt-body">{detail}</div>}
      {content && <div className="cc-prompt-body">{content.length > 1500 ? `${content.slice(0, 1500)}\n…` : content}</div>}
      {note && <Markdown className="cc-prompt-body" text={note} />}
      {proposed.length > 0 && !denying && (
        <label className="cc-rule-edit">
          <span className="cc-desc">Règle à retenir si vous ne voulez plus être sollicité (modifiable, une par ligne) :</span>
          <textarea rows={Math.min(Math.max(rules.length, 1), 6)} spellCheck={false} disabled={busy} value={ruleText} onChange={(e) => setRuleText(e.target.value)} />
        </label>
      )}
      <div>Êtes-vous d'accord ?</div>
      {!denying ? (
        <OptionList
          options={options}
          disabled={busy}
          onPick={(o) => {
            const v = o.value();
            if (v === 'deny-with-message') setDenying(true);
            else answer(v);
          }}
        />
      ) : (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            answer({ decision: 'deny', message: message || undefined });
          }}
        >
          <input autoFocus={canAutoFocus()} placeholder="Que doit faire l'agent à la place ? (Entrée pour envoyer, vide = simple refus)" value={message} onChange={(e) => setMessage(e.target.value)} />
        </form>
      )}
    </div>
  );
}

/** Questions à choix (AskUserQuestion) : une liste numérotée par question, plus réponse libre. */
function QuestionPrompt({ request, answer, busy }: { request: HumanRequest; answer: (r: Record<string, unknown>) => void; busy: boolean }) {
  const questions = ((request.payload as { questions?: Question[] }).questions ?? []) as Question[];
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [free, setFree] = useState('');
  const q = questions[index];
  if (!q) return null;

  const commit = (value: string) => {
    const next = { ...answers, [q.question]: value };
    if (index + 1 < questions.length) {
      setAnswers(next);
      setIndex(index + 1);
      setFree('');
    } else {
      answer({ answers: next });
    }
  };

  const options: Option[] = q.options.map((o) => ({ label: o.label, description: o.description, value: () => ({ label: o.label }) }));

  return (
    <div className="cc-prompt">
      <div className="cc-prompt-title">
        {q.header ?? 'Question'}
        {questions.length > 1 && <span className="cc-desc"> ({index + 1}/{questions.length})</span>}
      </div>
      <Markdown className="cc-question" text={q.question} />
      <OptionList options={options} disabled={busy} onPick={(o) => commit(o.label)} />
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (free.trim()) commit(free.trim());
        }}
      >
        <input placeholder="Autre réponse (texte libre, Entrée pour valider)" value={free} onChange={(e) => setFree(e.target.value)} />
      </form>
    </div>
  );
}

/** Demande d'accord officielle (tasks.request_approval) : accorder, ou refuser avec un motif. Réservée aux administrateurs. */
function ApprovalPrompt({ request, answer, busy }: { request: HumanRequest; answer: (r: Record<string, unknown>) => void; busy: boolean }) {
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState('');
  const p = request.payload as { taskId?: string; taskTitle?: string };
  const options: Option[] = [
    { label: 'Oui, accorder', description: 'la décision est postée dans le fil de la tâche', value: () => ({ decision: 'approve' }) },
    { label: 'Non, refuser et expliquer pourquoi', value: () => 'deny-with-message' as const },
  ];
  return (
    <div className="cc-prompt">
      <div className="cc-prompt-title">L'agent demande l'accord d'un administrateur du projet</div>
      <div className="cc-prompt-body">{request.title}</div>
      {p.taskTitle && <div className="cc-desc">Tâche : {p.taskTitle}</div>}
      {request.message && <Markdown className="cc-prompt-body" text={request.message} />}
      <div>Donnez-vous votre accord ?</div>
      {!denying ? (
        <OptionList
          options={options}
          disabled={busy}
          onPick={(o) => {
            const v = o.value();
            if (v === 'deny-with-message') setDenying(true);
            else answer(v);
          }}
        />
      ) : (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            answer({ decision: 'deny', message: message || undefined });
          }}
        >
          <input autoFocus={canAutoFocus()} placeholder="Motif du refus (Entrée pour envoyer, vide = simple refus)" value={message} onChange={(e) => setMessage(e.target.value)} />
        </form>
      )}
    </div>
  );
}

/** Demande de secrets (vault.request_secrets) : la saisie se fait dans une modale, ouverte d'office la première fois. */
function SecretsPrompt({ request, busy }: { request: HumanRequest; busy: boolean }) {
  const first = useContext(KeyboardTurn);
  const p = secretsPayload(request);
  return (
    <div className="cc-prompt">
      <div className="cc-prompt-title">L'agent vous demande {p.fields.length > 1 ? 'des secrets' : 'un secret'}</div>
      <div className="cc-prompt-body">
        {p.fields.map((f) => f.label).join(', ')} · « {p.item} »{p.ephemeral ? ' · pour cette session' : p.itemId ? ' · mise à jour du coffre' : ''}
      </div>
      {request.message && <Markdown className="cc-prompt-body" text={request.message} />}
      <div className="cc-desc">Les valeurs ne passent pas par l'agent, qui ne les voit jamais. Ne les collez pas dans la conversation.</div>
      <div className="mt-2">
        <SecretsButton request={request} autoOpen={first} disabled={busy} />
      </div>
    </div>
  );
}

function InputPrompt({ request, answer, busy }: { request: HumanRequest; answer: (r: Record<string, unknown>) => void; busy: boolean }) {
  const [text, setText] = useState('');
  return (
    <div className="cc-prompt">
      <div className="cc-prompt-title">{request.title}</div>
      {request.message && <Markdown className="cc-prompt-body" text={request.message} />}
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (text.trim()) answer({ text: text.trim() });
        }}
      >
        <input autoFocus={canAutoFocus()} disabled={busy} placeholder="Votre réponse (Entrée pour envoyer)" value={text} onChange={(e) => setText(e.target.value)} />
      </form>
    </div>
  );
}

/** Demande en attente affichée dans le terminal de session, à la manière des prompts de Claude Code. */
export default function RequestPrompt({ request, keyboard = true }: { request: HumanRequest; keyboard?: boolean }) {
  // Une seule réponse part, même sur un double clic ou un Entrée répété ; « déjà traitée ailleurs » est tu.
  const { answer, cancel, busy, error } = useRequestAnswer(request.id);

  return (
    <KeyboardTurn.Provider value={keyboard}>
      {request.type === 'permission' ? (
        <PermissionPrompt request={request} answer={answer} busy={busy} />
      ) : request.type === 'question' ? (
        <QuestionPrompt request={request} answer={answer} busy={busy} />
      ) : request.type === 'approval' ? (
        <ApprovalPrompt request={request} answer={answer} busy={busy} />
      ) : request.type === 'secrets' ? (
        <SecretsPrompt request={request} busy={busy} />
      ) : (
        <InputPrompt request={request} answer={answer} busy={busy} />
      )}
      <div className="cc-hint">
        {error ? <span className="cc-red">{error}</span> : request.type === 'secrets' ? <span className="cc-hint-text">Ignorer : l'agent apprend que vous n'avez pas fourni les secrets</span> : <span className="cc-hint-text">Cliquez sur une réponse, ou tapez son numéro</span>}
        <button type="button" className="cc-btn" disabled={busy} onClick={cancel}>
          Ignorer cette demande
        </button>
      </div>
    </KeyboardTurn.Provider>
  );
}

/** Une ligne qui résume une demande (zone réduite). */
export function requestSummary(request: HumanRequest): string {
  if (request.type === 'permission') {
    const p = request.payload as { toolName?: string; input?: Record<string, unknown> };
    return `L'agent souhaite ${describeTool(p.toolName ?? 'outil', p.input ?? {}).action}`;
  }
  if (request.type === 'question') {
    const q = ((request.payload as { questions?: Question[] }).questions ?? [])[0];
    return q ? (q.header ? `${q.header} : ${q.question}` : q.question) : request.title;
  }
  if (request.type === 'approval') return `Accord demandé : ${request.title}`;
  if (request.type === 'secrets') return "L'agent vous demande des secrets";
  return request.title;
}

/**
 * Zone des demandes en attente de la page de session, réductible : une demande haute (question, autorisation avec
 * une longue commande) cache la conversation au-dessus, qu'il faut parfois relire avant de répondre. Réduite, il
 * reste une ligne qui résume la demande ; les prompts restent montés (saisie en cours gardée) mais masqués, donc
 * ils ne prennent plus les raccourcis clavier. Une nouvelle demande rouvre la zone.
 */
export function RequestPrompts({ requests }: { requests: HumanRequest[] }) {
  const ids = requests.map((r) => r.id).join(',');
  const [collapsedFor, setCollapsedFor] = useState<string | null>(null);
  const collapsed = collapsedFor === ids;
  const count = requests.length;
  const label = count > 1 ? `${count} demandes en attente` : 'Demande en attente';
  return (
    <div className={`cc-prompts${collapsed ? ' collapsed' : ''}`}>
      <button
        type="button"
        className="cc-prompts-bar"
        aria-expanded={!collapsed}
        title={collapsed ? 'Afficher la demande pour y répondre' : 'Réduire la demande pour lire la conversation au-dessus'}
        onClick={() => setCollapsedFor(collapsed ? null : ids)}
      >
        <i className="bi bi-exclamation-circle cc-prompts-bar-icon" />
        <span className="cc-prompts-bar-label">{label}</span>
        {collapsed && <span className="cc-prompts-bar-summary">{requestSummary(requests[0])}</span>}
        <span className="cc-prompts-bar-action">
          {collapsed ? 'Afficher' : 'Réduire'}
          <i className={`bi bi-chevron-${collapsed ? 'up' : 'down'}`} />
        </span>
      </button>
      <div className="cc-prompts-list" hidden={collapsed}>
        {requests.map((r, i) => (
          <RequestPrompt key={r.id} request={r} keyboard={i === 0} />
        ))}
      </div>
    </div>
  );
}
