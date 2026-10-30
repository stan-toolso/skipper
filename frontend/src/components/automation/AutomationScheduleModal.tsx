import { useLazyQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import type { AutomationSchedule, AutomationScheduleInput, InputVariable } from '../../graphql/automation';
import { SCHEDULE_NEXT_RUNS } from '../../graphql/operations';
import { browserTimeZone, buildCron, cronPresetLabels, detectCronPreset, weekdayLabels, type CronPreset } from '../../lib/cron';
import { fmtDateTime } from '../../lib/automation';
import InputsForm, { inputsFromRecord, inputsPayload, missingInputs } from './InputsForm';

interface Props {
  title: string;
  schedule: AutomationSchedule | null;
  scheduleInputs: Record<string, unknown>;
  /** Variables à renseigner pour les exécutions planifiées. */
  variables: InputVariable[];
  saving: boolean;
  error?: Error | null;
  onSave: (input: AutomationScheduleInput, inputs: Record<string, unknown>) => void;
  onClear: () => void;
  onClose: () => void;
}

/** Planification d'un workflow : fréquence, fuseau, entrées des exécutions, aperçu des échéances. */
export default function AutomationScheduleModal({ title, schedule, scheduleInputs, variables, saving, error, onSave, onClear, onClose }: Props) {
  const detected = useMemo(() => detectCronPreset(schedule?.cron ?? '0 9 * * 1-5'), [schedule?.cron]);
  const [preset, setPreset] = useState<CronPreset>(schedule ? detected.preset : 'weekdays');
  const [time, setTime] = useState(detected.time);
  const [weekday, setWeekday] = useState(detected.weekday);
  const [monthDay, setMonthDay] = useState(detected.monthDay);
  const [custom, setCustom] = useState(schedule?.cron ?? '0 9 * * 1-5');
  const [timezone, setTimezone] = useState(schedule?.timezone ?? browserTimeZone());
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [values, setValues] = useState<Record<string, string>>(() => inputsFromRecord(scheduleInputs));
  const cron = buildCron(preset, time, weekday, monthDay, custom);
  const missing = missingInputs(variables, values);

  const [loadPreview, preview] = useLazyQuery<{ scheduleNextRuns: string[] }>(SCHEDULE_NEXT_RUNS, { fetchPolicy: 'network-only' });
  useEffect(() => {
    if (!cron) return;
    const handle = setTimeout(() => void loadPreview({ variables: { cron, timezone, count: 3 } }), 300);
    return () => clearTimeout(handle);
  }, [cron, timezone, loadPreview]);

  return (
    <Modal show onHide={onClose} centered size="lg" backdrop={saving ? 'static' : true}>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (cron && !missing.length) onSave({ cron, timezone, enabled }, inputsPayload(values));
        }}
      >
        <Modal.Header closeButton={!saving}>
          <Modal.Title className="h5 mb-0">
            <i className="bi bi-alarm me-2" />
            Planifier « {title} »
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="text-secondary small">À chaque échéance, une exécution est lancée avec les entrées ci-dessous, en votre nom (vos identifiants Claude, OpenCode et GitHub).</p>
          <div className="row g-2 mb-3">
            <div className="col-sm-5">
              <Form.Label>Fréquence</Form.Label>
              <Form.Select value={preset} onChange={(e) => setPreset(e.target.value as CronPreset)}>
                {(Object.keys(cronPresetLabels) as CronPreset[]).map((p) => (
                  <option key={p} value={p}>
                    {cronPresetLabels[p]}
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
                {!preview.error && (preview.data?.scheduleNextRuns ?? []).map((d) => <div key={d} className="font-monospace">{new Date(d).toLocaleString()}</div>)}
                {!preview.data && !preview.error && <span className="text-secondary">…</span>}
              </div>
              {preset !== 'custom' && (
                <Form.Text>
                  cron : <code>{cron}</code>
                </Form.Text>
              )}
            </div>
          </div>
          {variables.length > 0 && (
            <div className="mb-3">
              <div className="fw-semibold small mb-1">Entrées des exécutions planifiées</div>
              <InputsForm variables={variables} values={values} onChange={setValues} idPrefix="sched" />
              {missing.length > 0 && <div className="small text-warning">À renseigner : {missing.join(', ')}.</div>}
            </div>
          )}
          <Form.Check type="switch" id="automation-schedule-enabled" label="Planification active" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {schedule?.lastResult && (
            <div className="text-secondary small mt-3">
              Dernière exécution{schedule.lastRunAt ? ` le ${fmtDateTime(schedule.lastRunAt)}` : ''} : {schedule.lastResult}
            </div>
          )}
          {error && (
            <Alert variant="danger" className="mt-3 mb-0 py-2">
              {error.message}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer className="justify-content-between">
          <div>
            {schedule && (
              <Button variant="outline-danger" disabled={saving} onClick={onClear}>
                Retirer la planification
              </Button>
            )}
          </div>
          <div className="d-flex gap-2">
            <Button variant="secondary" disabled={saving} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={saving || !cron || missing.length > 0}>
              {schedule ? 'Enregistrer' : 'Planifier'}
            </Button>
          </div>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
