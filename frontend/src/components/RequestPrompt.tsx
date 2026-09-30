import { useMutation } from '@apollo/client';
import { useEffect, useState } from 'react';
import { ANSWER_REQUEST, CANCEL_REQUEST, type HumanRequest } from '../graphql/operations';
import { describeTool, editableRules, parseRuleLines, suggestedModes } from '../lib/humanize';
import { canAutoFocus } from '../lib/device';
import Markdown from './Markdown';

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

function OptionList({ options, onPick, disabled }: { options: Option[]; onPick: (o: Option) => void; disabled: boolean }) {
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    // Raccourcis clavier façon Claude Code : chiffres, flèches, Entrée. Ils valent aussi quand le focus est dans la
    // zone de saisie principale (textarea) tant qu'elle est vide : sinon un « 1 » suivi d'Entrée partirait comme
    // instruction à l'agent. Les champs texte du prompt lui-même (input) gardent leurs touches.
    const handler = (ev: KeyboardEvent) => {
      if (disabled || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const target = ev.target as HTMLElement | null;
      if (target?.tagName === 'INPUT') return;
      if (target?.tagName === 'TEXTAREA' && (target as HTMLTextAreaElement).value !== '') return;
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
  }, [options, cursor, onPick, disabled]);

  return (
    <>
      {options.map((o, i) => (
        <button key={o.label} type="button" className={`cc-option${i === cursor ? ' selected' : ''}`} disabled={disabled} onMouseEnter={() => setCursor(i)} onClick={() => onPick(o)}>
          <span className="cc-cursor">{i === cursor ? '❯' : ''}</span>
          {i + 1}. {o.label}
          {o.description && <span className="cc-desc"> — {o.description}</span>}
        </button>
      ))}
    </>
  );
}

/** Prompt d'autorisation d'outil, présenté comme dans Claude Code. */
function PermissionPrompt({ request, answer, busy }: { request: HumanRequest; answer: (r: Record<string, unknown>) => void; busy: boolean }) {
  const p = request.payload as { toolName?: string; input?: Record<string, unknown>; suggestions?: unknown[] };
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState('');
  // Règles à mémoriser : suggestions du SDK généralisées par préfixe, modifiables avant de répondre.
  const proposed = editableRules(p.suggestions);
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
      {request.message && <Markdown className="cc-prompt-body" text={request.message} />}
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
export default function RequestPrompt({ request }: { request: HumanRequest }) {
  const [answerRequest, { loading: answering, error }] = useMutation(ANSWER_REQUEST);
  const [cancelRequest, { loading: cancelling }] = useMutation(CANCEL_REQUEST);
  const busy = answering || cancelling;
  const answer = (response: Record<string, unknown>) => void answerRequest({ variables: { id: request.id, response } });

  return (
    <div>
      {request.type === 'permission' ? (
        <PermissionPrompt request={request} answer={answer} busy={busy} />
      ) : request.type === 'question' ? (
        <QuestionPrompt request={request} answer={answer} busy={busy} />
      ) : (
        <InputPrompt request={request} answer={answer} busy={busy} />
      )}
      <div className="cc-hint">
        <span>{error ? <span className="cc-red">{error.message}</span> : 'Cliquez sur une réponse, ou tapez son numéro'}</span>
        <button type="button" className="cc-btn" disabled={busy} onClick={() => cancelRequest({ variables: { id: request.id } })}>
          Ignorer cette demande
        </button>
      </div>
    </div>
  );
}
