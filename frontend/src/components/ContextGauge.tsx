import { useMutation } from '@apollo/client';
import { useEffect, useState } from 'react';
import { COMPACT_SESSION_CONTEXT, RESET_SESSION_CONTEXT, type Session } from '../graphql/operations';
import { formatCost, formatTokens } from '../lib/humanize';
import { useDialogs } from './Dialogs';

/** Un bandeau ignoré réapparaît quand le contexte a encore grossi d'autant depuis. */
const DISMISS_GROWTH_TOKENS = 50_000;
const dismissKey = (id: string) => `skipper.session.contextDismissed.${id}`;
const readDismissed = (id: string): number | null => {
  try {
    const v = localStorage.getItem(dismissKey(id));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
};

/** Couleur de la jauge : neutre, puis jaune au-delà du seuil serveur, rouge quand la fenêtre du modèle se remplit. */
export function gaugeLevel(ctx: Session['context']): '' | 'warn' | 'danger' {
  if (ctx.share !== null && ctx.share >= 0.75) return 'danger';
  return ctx.overThreshold ? 'warn' : '';
}

/** Libellé court du modèle (ex. « opus 4.1 » pour claude-opus-4-1-20250805). */
const shortModel = (model: string | null) =>
  model
    ? model
        .replace(/^claude-/, '')
        .replace(/-\d{8}$/, '')
        .replace(/-(\d)-(\d)$/, ' $1.$2')
        .replace(/-(\d)$/, ' $1')
    : null;

/**
 * Jauge de contexte de l'en-tête d'une session : tokens du dernier tour, part de la fenêtre du modèle, coût
 * approximatif d'un tour « à froid » (contexte relu sans cache). Cliquer ouvre les réglages.
 */
export function ContextGauge({ context, onClick }: { context: Session['context']; onClick: () => void }) {
  if (context.tokens === null) return null;
  const level = gaugeLevel(context);
  const pct = Math.round((context.share ?? 0) * 100);
  const model = shortModel(context.model);
  const title = [
    `Contexte de l'agent : ${formatTokens(context.tokens)} tokens au dernier tour`,
    `${pct} % de la fenêtre${model ? ` de ${model}` : ''} (${formatTokens(context.windowTokens)})`,
    context.coldTurnUsd !== null ? `≈ ${formatCost(context.coldTurnUsd)} pour relire ce contexte à froid au prochain tour (cache expiré après une heure d'inactivité)` : null,
    level && context.warnTokens !== null ? `Au-delà de ${formatTokens(context.warnTokens)} : pensez à compacter ou à repartir d'une conversation neuve` : null,
    'Cliquer : réglages de nettoyage',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <button type="button" className={`cc-link cc-gauge${level ? ` ${level}` : ''}`} title={title} onClick={onClick}>
      <i className="bi bi-speedometer2" /> {formatTokens(context.tokens)}
      <span className="cc-gauge-bar" aria-hidden>
        <span style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </span>
      {pct} %{context.coldTurnUsd !== null && context.coldTurnUsd >= 0.01 && <span className="cc-gauge-cost"> · ≈ {formatCost(context.coldTurnUsd)}/tour</span>}
    </button>
  );
}

/**
 * Bandeau au-delà du seuil serveur : propose de compacter, de repartir d'une conversation neuve (avec ou sans
 * résumé) ou d'ignorer. Rien n'est fait sans l'accord de l'utilisateur.
 */
export function ContextBanner({ session, busy }: { session: Session; busy: boolean }) {
  const ctx = session.context;
  const tokens = ctx.tokens ?? 0;
  const [dismissedAt, setDismissedAt] = useState<number | null>(() => readDismissed(session.id));
  useEffect(() => setDismissedAt(readDismissed(session.id)), [session.id]);
  const { confirm, showError } = useDialogs();
  const [compact, { loading: compacting }] = useMutation(COMPACT_SESSION_CONTEXT);
  const [reset, { loading: resetting }] = useMutation(RESET_SESSION_CONTEXT);
  if (!ctx.overThreshold || session.archivedAt) return null;
  if (dismissedAt !== null && tokens < dismissedAt + DISMISS_GROWTH_TOKENS) return null;
  const working = compacting || resetting;
  const canCompact = session.provider === 'claude' || session.provider === 'opencode';
  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(session.id), String(tokens));
    } catch {
      /* ignore */
    }
    setDismissedAt(tokens);
  };
  const onReset = async () => {
    const res = await confirm({
      title: "Repartir d'une conversation neuve",
      message: (
        <>
          L'agent oubliera la conversation en cours ({formatTokens(tokens)} tokens) ; le transcript affiché est conservé.
          {session.status === 'RUNNING' && ' La session, qui attend des instructions, sera d\'abord terminée.'} La prochaine instruction ouvrira une conversation vide.
        </>
      ),
      confirmLabel: 'Repartir de zéro',
      checkbox: { label: 'Garder un résumé : les derniers échanges accompagneront la prochaine instruction', defaultChecked: true },
    });
    if (!res) return;
    await reset({ variables: { id: session.id, keepSummary: res.checked } }).catch(showError);
  };
  return (
    <div className={`cc-context-banner${gaugeLevel(ctx) === 'danger' ? ' danger' : ''}`}>
      <i className="bi bi-speedometer2 me-2" />
      <span className="cc-context-banner-text">
        Le contexte de l'agent atteint <strong>{formatTokens(tokens)} tokens</strong> ({Math.round((ctx.share ?? 0) * 100)} % de la fenêtre du modèle
        {ctx.coldTurnUsd !== null ? <>, ≈ {formatCost(ctx.coldTurnUsd)} par tour à froid</> : null}). Chaque tour relit tout cet historique : compacter ou repartir d'une conversation
        neuve le rendra plus rapide et moins coûteux.
      </span>
      <span className="cc-context-banner-actions">
        {canCompact && (
          <button type="button" className="cc-btn accent" disabled={working || busy} title={busy ? "Attendez la fin du tour de l'agent" : "Envoie /compact : l'agent résume la conversation et repart de ce résumé"} onClick={() => void compact({ variables: { id: session.id } }).catch(showError)}>
            {compacting ? 'Compaction…' : 'Compacter'}
          </button>
        )}
        <button type="button" className="cc-btn" disabled={working || busy} title={busy ? "Attendez la fin du tour de l'agent" : "Oublie la conversation du modèle, avec ou sans résumé ; le transcript reste consultable"} onClick={() => void onReset()}>
          {resetting ? 'Remise à zéro…' : "Repartir d'une conversation neuve"}
        </button>
        <button type="button" className="cc-btn" disabled={working} title={`Masque ce bandeau jusqu'à ${formatTokens(tokens + DISMISS_GROWTH_TOKENS)} tokens`} onClick={dismiss}>
          Ignorer
        </button>
      </span>
    </div>
  );
}
