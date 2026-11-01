import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { PROVIDERS, type Provider, type Session } from '../graphql/operations';
import { CREATE_CHAT } from '../graphql/sessions';
import { toAttachmentInputs, usePendingAttachments } from '../lib/attachments';
import { canAutoFocus } from '../lib/device';
import { permissionModeLabels, permissionModeShortLabels } from '../lib/humanize';
import AttachmentChips from './AttachmentChips';
import DictationButton from './DictationButton';
import Logo from './Logo';
import './terminal.css';
import './chat.css';

const MODE_KEY = 'skipper.chat.permissionMode';
const MODEL_KEY = 'skipper.chat.model';

/** Modes d'autorisation qui ont un sens pour un chat (pas d'outil de fichiers ni de commande). */
const CHAT_MODES = ['default', 'bypassPermissions'];

const read = (key: string, fallback = '') => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
};

/**
 * Suggestions de départ : le chat sert d'abord à créer et lancer des tâches. Chacune remplit la zone de saisie
 * (la personne complète les « … » ou envoie telle quelle).
 */
const SUGGESTIONS: { label: string; prompt: string }[] = [
  { label: 'Créer une tâche', prompt: 'Crée une tâche dans le projet « … » : …' },
  { label: 'Créer et lancer une tâche', prompt: "Crée une tâche dans le projet « … » et lance une session d'agent pour la réaliser : …" },
  { label: 'Découper en tâches', prompt: 'Découpe ce chantier en tâches dans le projet « … », avec une priorité pour chacune : …' },
  { label: 'Lancer mes tâches à faire', prompt: "Liste mes tâches à faire dans le projet « … » et propose celles qu'un agent peut lancer dès maintenant." },
  { label: 'Où en sont mes tâches', prompt: "Où en sont mes tâches en cours, projet par projet ? Signale celles qui attendent quelque chose de moi et celles dont l'agent s'est arrêté." },
];

function greeting(name: string | undefined): string {
  const hour = new Date().getHours();
  const hello = hour < 5 || hour >= 18 ? 'Bonsoir' : 'Bonjour';
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${hello}, ${first}` : hello;
}

/**
 * Zone de départ d'un chat : une question, le mode d'autorisation et le modèle, puis le chat s'ouvre sur sa page
 * (`/chats/:id`). Sur le tableau de bord avec un salut (`greeting`), ou en tête de la liste des chats.
 */
export default function ChatComposer({ withGreeting = false, autoFocus = false }: { withGreeting?: boolean; autoFocus?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const [createChat, { loading, error }] = useMutation<{ createChat: Session }>(CREATE_CHAT, { refetchQueries: ['Chats'] });
  const [text, setText] = useState('');
  const [mode, setMode] = useState(() => (CHAT_MODES.includes(read(MODE_KEY)) ? read(MODE_KEY) : 'default'));
  const [model, setModel] = useState(() => read(MODEL_KEY));
  const [encoding, setEncoding] = useState(false);
  const attachments = usePendingAttachments();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const claude = providersData?.providers.find((p) => p.type === 'claude');
  const modelField = claude?.configFields.find((f) => f.key === 'model' && f.type === 'select');
  const modelOptions = modelField?.options ?? [];
  const permissionField = claude?.configFields.find((f) => f.key === 'permissionMode' && f.type === 'select');
  const modeOptions = (permissionField?.options ?? []).filter((o) => CHAT_MODES.includes(o.value));

  useEffect(() => {
    if (autoFocus && canAutoFocus()) inputRef.current?.focus();
  }, [autoFocus]);
  // Un modèle mémorisé qui n'est plus proposé (réglages Claude changés) revient au modèle par défaut.
  useEffect(() => {
    if (model && modelOptions.length && !modelOptions.some((o) => o.value === model)) setModel('');
  }, [model, modelOptions]);

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };
  const canSend = Boolean(text.trim() || attachments.items.length) && !loading && !encoding;
  const submit = async () => {
    if (!canSend) return;
    setEncoding(true);
    try {
      const files = attachments.items.length ? await toAttachmentInputs(attachments.items) : null;
      const res = await createChat({ variables: { text: text.trim(), attachments: files, config: { permissionMode: mode, ...(model ? { model } : {}) } } });
      const id = res.data?.createChat.id;
      if (id) {
        setText('');
        attachments.reset();
        if (inputRef.current) inputRef.current.style.height = 'auto';
        navigate(`/chats/${id}`);
      }
    } catch {
      /* l'erreur est affichée sous la zone */
    } finally {
      setEncoding(false);
    }
  };
  const suggest = (prompt: string) => {
    setText(prompt);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      resize(el);
      el.focus();
      const dots = prompt.indexOf('…');
      el.setSelectionRange(dots >= 0 ? dots : prompt.length, dots >= 0 ? dots + 1 : prompt.length);
    });
  };

  return (
    <section className={`chat-composer${withGreeting ? ' with-greeting' : ''}`} aria-label="Nouveau chat">
      <div className="chat-composer-head">
        {withGreeting && (
          <h2 className="chat-composer-greeting">
            <Logo size={26} /> {greeting(user?.name)}
          </h2>
        )}
        <Link to="/chats" className="chat-composer-all" title="Vos chats précédents">
          <i className="bi bi-chat-left-text" /> Tous les chats
        </Link>
      </div>
      <div
        className="cc-input chat-composer-box"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('select, button, label, a')) inputRef.current?.focus();
        }}
        onDrop={attachments.onDrop}
        onDragOver={attachments.onDragOver}
      >
        <AttachmentChips items={attachments.items} onAdd={(files) => attachments.add(files)} onRemove={attachments.remove} disabled={loading || encoding} showButton={false} error={attachments.error} />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder="Que voulez-vous faire ?"
          disabled={loading || encoding}
          onChange={(e) => {
            setText(e.target.value);
            resize(e.target);
          }}
          onPaste={attachments.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="cc-input-tools">
          <label className="cc-attach" title="Joindre des fichiers (ou collez une image, ou déposez des fichiers ici)" aria-label="Joindre des fichiers">
            <i className="bi bi-paperclip" />
            <input
              type="file"
              multiple
              hidden
              disabled={loading || encoding}
              onChange={(e) => {
                attachments.add(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <DictationButton
            value={text}
            disabled={loading || encoding}
            onChange={(t) => {
              setText(t);
              if (inputRef.current) resize(inputRef.current);
            }}
          />
          <span className="chat-composer-spacer" />
          <span className={`cc-pill cc-pill-mode${mode === 'bypassPermissions' ? ' warn' : ''}`} title={`Autorisations du chat : ${permissionModeLabels[mode] ?? mode}. Lancer une session ou lui parler consomme du budget : en mode « demander », le chat vous le soumet d'abord.`}>
            <i className={`bi ${mode === 'bypassPermissions' ? 'bi-exclamation-triangle' : 'bi-shield-check'}`} />
            <span className="cc-pill-label">{permissionModeShortLabels[mode] ?? mode}</span>
            <i className="bi bi-chevron-down" />
            <select
              className="cc-select"
              aria-label="Autorisations"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                write(MODE_KEY, e.target.value);
              }}
            >
              {(modeOptions.length ? modeOptions : CHAT_MODES.map((value) => ({ value, label: value, description: undefined }))).map((o) => (
                <option key={o.value} value={o.value} title={o.description ?? undefined}>
                  {permissionModeShortLabels[o.value] ?? o.label}
                </option>
              ))}
            </select>
          </span>
          {modelOptions.length > 0 && (
            <span className="cc-pill cc-pill-model" title="Modèle du chat (Paramètres → Claude pour les modèles proposés)">
              <span className="cc-pill-label">{modelOptions.find((o) => o.value === model)?.label ?? modelOptions[0]?.label ?? 'Modèle'}</span>
              <i className="bi bi-chevron-down" />
              <select
                className="cc-select"
                aria-label="Modèle"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  write(MODEL_KEY, e.target.value);
                }}
              >
                {modelOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </span>
          )}
          <button type="button" className="cc-send" title="Envoyer (Entrée)" aria-label="Envoyer" disabled={!canSend} onClick={() => void submit()}>
            <i className="bi bi-arrow-up" />
          </button>
        </div>
      </div>
      {error && <div className="chat-composer-error">{error.message}</div>}
      <div className="chat-composer-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.label} type="button" className="chat-composer-chip" onClick={() => suggest(s.prompt)} title={s.prompt}>
            {s.label}
          </button>
        ))}
      </div>
    </section>
  );
}
