import { useLazyQuery, useMutation } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { CLEAR_SESSION_SCHEDULE, SCHEDULE_NEXT_RUNS, SET_SESSION_SCHEDULE, type Session } from '../graphql/operations';

/** Fréquences proposées ; « custom » laisse saisir l'expression cron. */
type Preset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

const presetLabels: Record<Preset, string> = {
  hourly: 'Toutes les heures',
  daily: 'Tous les jours',
  weekdays: 'Du lundi au vendredi',
  weekly: 'Toutes les semaines',
  monthly: 'Tous les mois',
  custom: 'Expression cron…',
};

const weekdayLabels = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

function buildCron(preset: Preset, time: string, weekday: number, monthDay: number, custom: string): string {
  const [h, m] = time.split(':').map((v) => Number(v));
  const hour = Number.isFinite(h) ? h : 9;
  const minute = Number.isFinite(m) ? m : 0;
  switch (preset) {
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekday}`;
    case 'monthly':
      return `${minute} ${hour} ${monthDay} * *`;
    default:
      return custom.trim();
  }
}

/** Retrouve, si possible, la fréquence simple correspondant à une expression enregistrée. */
function detectPreset(cron: string): { preset: Preset; time: string; weekday: number; monthDay: number } {
  const pad = (n: string) => n.padStart(2, '0');
  const f = cron.trim().split(/\s+/);
  const fallback = { preset: 'custom' as Preset, time: '09:00', weekday: 1, monthDay: 1 };
  if (f.length !== 5 || !/^\d+$/.test(f[0])) return fallback;
  if (f[1] === '*' && f[2] === '*' && f[3] === '*' && f[4] === '*') return { ...fallback, preset: 'hourly', time: `00:${pad(f[0])}` };
  if (!/^\d+$/.test(f[1])) return fallback;
  const time = `${pad(f[1])}:${pad(f[0])}`;
  if (f[2] === '*' && f[3] === '*' && f[4] === '*') return { ...fallback, preset: 'daily', time };
  if (f[2] === '*' && f[3] === '*' && f[4] === '1-5') return { ...fallback, preset: 'weekdays', time };
  if (f[2] === '*' && f[3] === '*' && /^[0-7]$/.test(f[4])) return { ...fallback, preset: 'weekly', time, weekday: Number(f[4]) % 7 };
  if (/^\d+$/.test(f[2]) && f[3] === '*' && f[4] === '*') return { ...fallback, preset: 'monthly', time, monthDay: Number(f[2]) };
  return fallback;
}

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

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
    if (!cron || !prompt.trim()) return;
    void save({ variables: { id: session.id, input: { cron, timezone, prompt: prompt.trim(), enabled, endAfterRun } } });
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
            <Button type="submit" disabled={busy || !cron || !prompt.trim()}>
              {existing ? 'Enregistrer' : 'Planifier'}
            </Button>
          </div>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
