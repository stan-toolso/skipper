import { useLazyQuery, useMutation } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { CLEAR_SESSION_SCHEDULE, SCHEDULE_NEXT_RUNS, SET_SESSION_SCHEDULE, type Session } from '../graphql/operations';
import { browserTimeZone, buildCron, cronPresetLabels as presetLabels, detectCronPreset as detectPreset, weekdayLabels, type CronPreset as Preset } from '../lib/cron';
import { formatTokens } from '../lib/humanize';

/** Conversation de l'agent entre deux exécutions : neuve à chaque fois (défaut), compactée ou oubliée au-delà d'un seuil, ou laissée telle quelle. */
type ContextMode = 'fresh' | 'compact' | 'reset' | '';
const withThreshold = (m: ContextMode) => m === 'compact' || m === 'reset';
/** Seuil de compaction proposé (k tokens), aligné sur DEFAULT_SCHEDULE_CONTEXT_MAX_TOKENS du serveur. */
const DEFAULT_COMPACT_K = 100;

/** Modale de planification d'une session : fréquence, instruction envoyée à chaque exécution, aperçu des prochaines échéances. */
export default function ScheduleModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const existing = session.schedule;
  const detected = useMemo(() => detectPreset(existing?.cron ?? '0 9 * * 1-5'), [existing?.cron]);
  const [preset, setPreset] = useState<Preset>(existing ? detected.preset : 'weekdays');
  const [time, setTime] = useState(detected.time);
  const [weekday, setWeekday] = useState(detected.weekday);
  const [monthDay, setMonthDay] = useState(detected.monthDay);
  const [custom, setCustom] = useState(existing?.cron ?? '0 9 * * 1-5');
  const [timezone, setTimezone] = useState(existing?.timezone ?? browserTimeZone());
  const [prompt, setPrompt] = useState(existing?.prompt ?? session.prompt ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [endAfterRun, setEndAfterRun] = useState(existing?.endAfterRun ?? true);
  // Nouvelle planification : nettoyage actif d'office (conversation neuve à chaque exécution). Planification existante : son réglage actuel.
  const [contextMode, setContextMode] = useState<ContextMode>(existing ? (session.cleanup.contextAction ?? '') : 'fresh');
  const [contextMaxK, setContextMaxK] = useState(String(Math.round((session.cleanup.contextMaxTokens ?? DEFAULT_COMPACT_K * 1000) / 1000)));
  const contextValid = !withThreshold(contextMode) || Number(contextMaxK) >= 10;
  // Planification existante sans nettoyage : le contexte grossit à chaque exécution ; on propose d'activer le réglage par défaut.
  const missingCleanup = Boolean(existing) && !session.cleanup.contextAction && contextMode === '';

  const cron = buildCron(preset, time, weekday, monthDay, custom);
  const [loadPreview, preview] = useLazyQuery<{ scheduleNextRuns: string[] }>(SCHEDULE_NEXT_RUNS, { fetchPolicy: 'network-only' });
  useEffect(() => {
    if (!cron) return;
    const handle = setTimeout(() => void loadPreview({ variables: { cron, timezone, count: 3 } }), 300);
    return () => clearTimeout(handle);
  }, [cron, timezone, loadPreview]);

  const [save, { loading: saving, error: saveError }] = useMutation(SET_SESSION_SCHEDULE, { onCompleted: onClose });
  const [clear, { loading: clearing, error: clearError }] = useMutation(CLEAR_SESSION_SCHEDULE, { onCompleted: onClose });
  const busy = saving || clearing;
  const error = saveError ?? clearError;

  const submit = () => {
    if (!cron || !prompt.trim() || !contextValid) return;
    // Le nettoyage remplace l'objet entier : la purge du transcript est reportée telle quelle.
    const cleanup = {
      retentionDays: session.cleanup.retentionDays,
      contextAction: contextMode || null,
      contextMaxTokens: withThreshold(contextMode) ? Number(contextMaxK) * 1000 : null,
    };
    void save({ variables: { id: session.id, input: { cron, timezone, prompt: prompt.trim(), enabled, endAfterRun, cleanup } } });
  };

  return (
    <Modal show onHide={onClose} centered size="lg" backdrop={busy ? 'static' : true}>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Modal.Header closeButton={!busy}>
          <Modal.Title className="h5 mb-0">
            <i className="bi bi-alarm me-2" />
            Planifier « {session.name} »
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="text-secondary small">
            À chaque échéance, l'instruction ci-dessous est envoyée à cette session : si elle est terminée, elle est relancée en reprenant la conversation ; si l'agent
            travaille encore, l'échéance est ignorée.
          </p>
          <div className="row g-2 mb-3">
            <div className="col-sm-5">
              <Form.Label>Fréquence</Form.Label>
              <Form.Select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
                {(Object.keys(presetLabels) as Preset[]).map((p) => (
                  <option key={p} value={p}>
                    {presetLabels[p]}
                  </option>
                ))}
              </Form.Select>
            </div>
            {preset === 'weekly' && (
              <div className="col-sm-3">
                <Form.Label>Jour</Form.Label>
                <Form.Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <option key={d} value={d}>
                      {weekdayLabels[d]}
                    </option>
                  ))}
                </Form.Select>
              </div>
            )}
            {preset === 'monthly' && (
              <div className="col-sm-3">
                <Form.Label>Jour du mois</Form.Label>
                <Form.Control type="number" min={1} max={31} value={monthDay} onChange={(e) => setMonthDay(Math.min(31, Math.max(1, Number(e.target.value) || 1)))} />
              </div>
            )}
            {preset !== 'custom' && (
              <div className="col-sm-3">
                <Form.Label>{preset === 'hourly' ? 'Minute' : 'Heure'}</Form.Label>
                {preset === 'hourly' ? (
                  <Form.Control type="number" min={0} max={59} value={Number(time.split(':')[1] ?? 0)} onChange={(e) => setTime(`00:${String(Math.min(59, Math.max(0, Number(e.target.value) || 0))).padStart(2, '0')}`)} />
                ) : (
                  <Form.Control type="time" value={time} onChange={(e) => setTime(e.target.value || '09:00')} />
                )}
              </div>
            )}
            {preset === 'custom' && (
              <div className="col-sm-7">
                <Form.Label>Expression cron</Form.Label>
                <Form.Control value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="minute heure jour mois jour-de-semaine" className="font-monospace" />
                <Form.Text>Cinq champs, ou un alias : @hourly, @daily, @weekly, @monthly.</Form.Text>
              </div>
            )}
          </div>
          <div className="row g-2 mb-3">
            <div className="col-sm-5">
              <Form.Label>Fuseau horaire</Form.Label>
              <Form.Control value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/Paris" />
            </div>
            <div className="col-sm-7">
              <Form.Label>Prochaines échéances</Form.Label>
              <div className="small">
                {preview.error && <span className="text-danger">{preview.error.message}</span>}
                {!preview.error && preview.data?.scheduleNextRuns.length === 0 && <span className="text-secondary">Aucune échéance à venir.</span>}
                {!preview.error &&
                  (preview.data?.scheduleNextRuns ?? []).map((d) => (
                    <div key={d} className="font-monospace">
                      {new Date(d).toLocaleString()}
                    </div>
                  ))}
                {!preview.data && !preview.error && <span className="text-secondary">…</span>}
              </div>
              {preset !== 'custom' && (
                <Form.Text>
                  cron : <code>{cron}</code>
                </Form.Text>
              )}
            </div>
          </div>
          <Form.Group className="mb-3">
            <Form.Label>Instruction envoyée à chaque exécution</Form.Label>
            <Form.Control as="textarea" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ce que l'agent doit faire à chaque échéance…" />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label className="mb-1">Conversation de l'agent entre deux exécutions</Form.Label>
            <Form.Select value={contextMode} onChange={(e) => setContextMode(e.target.value as ContextMode)}>
              <option value="fresh">Nouvelle conversation à chaque exécution (recommandé)</option>
              <option value="compact">Compacter quand le contexte dépasse un seuil</option>
              <option value="reset">Repartir d'une conversation neuve quand le contexte dépasse un seuil</option>
              <option value="">Ne rien faire (le contexte grossit à chaque exécution)</option>
            </Form.Select>
          </Form.Group>
          {withThreshold(contextMode) && (
            <div className="d-flex align-items-center gap-2 mb-2 ms-4">
              <span>Seuil :</span>
              <Form.Control type="number" min={10} step={10} value={contextMaxK} onChange={(e) => setContextMaxK(e.target.value)} style={{ width: '6rem' }} />
              <span>k tokens</span>
            </div>
          )}
          <Form.Text className="d-block mb-3">
            {contextMode === 'fresh' && "Avant chaque exécution, l'agent repart d'une conversation vide : le contexte reste stable d'une fois sur l'autre. Le transcript affiché est conservé."}
            {contextMode === 'compact' && "Avant une exécution, si le contexte dépasse le seuil, /compact est envoyé à l'agent : il résume la conversation et repart de ce résumé."}
            {contextMode === 'reset' && "Avant une exécution, si le contexte dépasse le seuil, l'agent repart d'une conversation vide ; le transcript affiché est conservé."}
            {contextMode === '' && "Chaque exécution relit toutes les précédentes : le contexte, et le coût de chaque tour, grossissent sans fin."}
            {session.contextTokens !== null && <> Contexte actuel : {formatTokens(session.contextTokens)} tokens.</>}
          </Form.Text>
          {missingCleanup && (
            <Alert variant="warning" className="d-flex align-items-center justify-content-between gap-2 py-2">
              <span>
                Cette planification n'a pas de nettoyage{session.contextTokens !== null ? <> : le contexte atteint déjà {formatTokens(session.contextTokens)} tokens</> : null}.
              </span>
              <Button size="sm" variant="outline-secondary" className="flex-shrink-0" onClick={() => setContextMode('fresh')}>
                Activer le nettoyage par défaut
              </Button>
            </Alert>
          )}
          <Form.Check
            type="switch"
            id="schedule-end-after-run"
            className="mb-2"
            label="Terminer la session à la fin de chaque exécution (elle est relancée à l'échéance suivante)"
            checked={endAfterRun}
            onChange={(e) => setEndAfterRun(e.target.checked)}
          />
          <Form.Check type="switch" id="schedule-enabled" label="Planification active" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {existing?.lastResult && (
            <div className="text-secondary small mt-3">
              Dernière exécution{existing.lastRunAt ? ` le ${new Date(existing.lastRunAt).toLocaleString()}` : ''} : {existing.lastResult}
            </div>
          )}
          {error && (
            <Alert variant="danger" className="mt-3 mb-0">
              {error.message}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer className="justify-content-between">
          <div>
            {existing && (
              <Button variant="outline-danger" disabled={busy} onClick={() => void clear({ variables: { id: session.id } })}>
                Retirer la planification
              </Button>
            )}
          </div>
          <div className="d-flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy || !cron || !prompt.trim() || !contextValid}>
              {existing ? 'Enregistrer' : 'Planifier'}
            </Button>
          </div>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
