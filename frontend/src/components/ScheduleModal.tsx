import { useLazyQuery, useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import {
  CLEAR_SESSION_SCHEDULE,
  CREATE_SCHEDULED_SESSION,
  RUN_SESSION_SCHEDULE_NOW,
  SCHEDULE_NEXT_RUNS,
  SESSION_SCHEDULE_RUNS,
  SET_SESSION_SCHEDULE,
  UPDATE_SESSION_CONFIG,
  type ScheduleRun,
  type Session,
} from '../graphql/operations';
import { browserTimeZone, buildCron, cronPresetLabels as presetLabels, describeCron, detectCronPreset as detectPreset, weekdayLabels, type CronPreset as Preset } from '../lib/cron';
import { formatTokens, permissionModeShortLabels } from '../lib/humanize';
import { useDialogs } from './Dialogs';
import { RunHistory } from './ScheduleRuns';

/** Conversation de l'agent entre deux exécutions : neuve à chaque fois (défaut), compactée ou oubliée au-delà d'un seuil, ou laissée telle quelle. */
type ContextMode = 'fresh' | 'compact' | 'reset' | '';
const withThreshold = (m: ContextMode) => m === 'compact' || m === 'reset';
/** Seuil de compaction proposé (k tokens), aligné sur DEFAULT_SCHEDULE_CONTEXT_MAX_TOKENS du serveur. */
const DEFAULT_COMPACT_K = 100;
const PERMISSION_MODES = ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions'] as const;

/** Ce que le mode d'autorisation implique pour une exécution sans personne devant l'écran. */
function permissionHint(mode: string): string {
  if (mode === 'bypassPermissions') return 'Tout est autorisé : rien ne bloque une exécution, y compris les accès du coffre qui exigent votre approbation.';
  if (mode === 'dontAsk') return 'Les outils soumis à autorisation sont refusés sans demande : l’exécution est alors notée « Bloquée » et vous êtes prévenu.';
  if (mode === 'plan') return 'L’agent ne fait que réfléchir, sans rien modifier ni exécuter.';
  return 'Une demande d’autorisation attend votre réponse : sans réponse après 10 minutes, l’exécution est notée « Bloquée » et vous êtes prévenu.';
}

export interface ScheduleModalProject {
  id: string;
  name: string;
  defaultPermissionMode?: string;
}

/**
 * Modale d'une planification. Avec `session` : planifier cette session, ou modifier sa planification (avec son
 * historique). Sans session : nouvelle planification, portée par une session créée pour elle dans le projet choisi.
 */
export default function ScheduleModal({ session, projects = [], onClose, onCreated }: { session?: Session; projects?: ScheduleModalProject[]; onClose: () => void; onCreated?: (session: Session) => void }) {
  const { showError, confirm } = useDialogs();
  const existing = session?.schedule ?? null;
  const detected = useMemo(() => detectPreset(existing?.cron ?? '0 9 * * 1-5'), [existing?.cron]);
  const [name, setName] = useState(existing?.customName ?? '');
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const project = projects.find((p) => p.id === projectId);
  const [preset, setPreset] = useState<Preset>(existing ? detected.preset : 'weekdays');
  const [time, setTime] = useState(detected.time);
  const [weekday, setWeekday] = useState(detected.weekday);
  const [monthDay, setMonthDay] = useState(detected.monthDay);
  const [custom, setCustom] = useState(existing?.cron ?? '0 9 * * 1-5');
  const [timezone, setTimezone] = useState(existing?.timezone ?? browserTimeZone());
  const [prompt, setPrompt] = useState(existing?.prompt ?? session?.prompt ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [endAfterRun, setEndAfterRun] = useState(existing?.endAfterRun ?? true);
  const currentMode = String(session?.config.permissionMode ?? project?.defaultPermissionMode ?? 'default');
  const [permissionMode, setPermissionMode] = useState(currentMode);
  useEffect(() => {
    if (!session) setPermissionMode(project?.defaultPermissionMode ?? 'default');
  }, [session, project?.defaultPermissionMode]);
  const cleanupNow = session?.cleanup ?? { retentionDays: null, contextAction: null, contextMaxTokens: null };
  // Nouvelle planification : nettoyage actif d'office (conversation neuve à chaque exécution). Planification existante : son réglage actuel.
  const [contextMode, setContextMode] = useState<ContextMode>(existing ? ((cleanupNow.contextAction as ContextMode) ?? '') : 'fresh');
  const [contextMaxK, setContextMaxK] = useState(String(Math.round((cleanupNow.contextMaxTokens ?? DEFAULT_COMPACT_K * 1000) / 1000)));
  const contextValid = !withThreshold(contextMode) || Number(contextMaxK) >= 10;
  // Planification existante sans nettoyage : le contexte grossit à chaque exécution ; on propose d'activer le réglage par défaut.
  const missingCleanup = Boolean(existing) && !cleanupNow.contextAction && contextMode === '';
  const creating = !session;

  const cron = buildCron(preset, time, weekday, monthDay, custom);
  const [loadPreview, preview] = useLazyQuery<{ scheduleNextRuns: string[] }>(SCHEDULE_NEXT_RUNS, { fetchPolicy: 'network-only' });
  useEffect(() => {
    if (!cron) return;
    const handle = setTimeout(() => void loadPreview({ variables: { cron, timezone, count: 3 } }), 300);
    return () => clearTimeout(handle);
  }, [cron, timezone, loadPreview]);

  const runs = useQuery<{ session: { id: string; schedule: { sessionId: string; runs: ScheduleRun[] } | null } | null }>(SESSION_SCHEDULE_RUNS, {
    variables: { id: session?.id ?? '', limit: 10 },
    skip: !existing,
    fetchPolicy: 'cache-and-network',
  });

  const [save, { loading: saving, error: saveError }] = useMutation(SET_SESSION_SCHEDULE);
  const [create, { loading: creatingSession, error: createError }] = useMutation<{ createScheduledSession: Session }>(CREATE_SCHEDULED_SESSION, { refetchQueries: ['SessionSchedules'] });
  const [updateConfig, { loading: configuring }] = useMutation(UPDATE_SESSION_CONFIG);
  const [clear, { loading: clearing, error: clearError }] = useMutation(CLEAR_SESSION_SCHEDULE, { onCompleted: onClose, refetchQueries: ['SessionSchedules'] });
  const [runNow, { loading: launching }] = useMutation(RUN_SESSION_SCHEDULE_NOW, { refetchQueries: ['SessionScheduleRuns', 'SessionSchedules'] });
  const busy = saving || clearing || creatingSession || configuring;
  const error = saveError ?? clearError ?? createError;
  const canSubmit = Boolean(cron && prompt.trim() && contextValid && (!creating || (name.trim() && projectId)));

  const submit = async () => {
    if (!canSubmit) return;
    // Le nettoyage remplace l'objet entier : la purge du transcript est reportée telle quelle.
    const cleanup = {
      retentionDays: cleanupNow.retentionDays,
      contextAction: contextMode || null,
      contextMaxTokens: withThreshold(contextMode) ? Number(contextMaxK) * 1000 : null,
    };
    const input = { name: name.trim() || null, cron, timezone, prompt: prompt.trim(), enabled, endAfterRun, cleanup };
    if (creating) {
      const res = await create({ variables: { input: { ...input, name: name.trim(), projectId, config: { permissionMode } } } }).catch(() => null);
      if (res?.data) {
        onCreated?.(res.data.createScheduledSession);
        onClose();
      }
      return;
    }
    if (permissionMode !== currentMode) {
      const ok = await updateConfig({ variables: { id: session.id, config: { permissionMode } } }).catch((err: Error) => (showError(err), null));
      if (!ok) return;
    }
    const res = await save({ variables: { id: session.id, input }, refetchQueries: ['SessionSchedules'] }).catch(() => null);
    if (res?.data) onClose();
  };

  return (
    <Modal show onHide={onClose} centered size="lg" backdrop={busy ? 'static' : true}>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Modal.Header closeButton={!busy}>
          <Modal.Title className="h5 mb-0">
            <i className="bi bi-alarm me-2" />
            {creating ? 'Nouvelle planification' : existing ? `Planification « ${existing.name} »` : `Planifier « ${session.name} »`}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="text-secondary small">
            {creating
              ? "Une session est créée pour cette planification, dans son propre dossier de travail. À chaque échéance, l'instruction lui est envoyée ; l'historique de ses exécutions reste consultable."
              : "À chaque échéance, l'instruction ci-dessous est envoyée à cette session : si elle est terminée, elle est relancée ; si l'agent travaille encore, l'échéance est ignorée."}
          </p>
          <div className="row g-2 mb-3">
            <div className={creating && projects.length > 1 ? 'col-sm-7' : 'col-12'}>
              <Form.Label>Nom</Form.Label>
              <Form.Control
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required={creating}
                autoFocus={creating}
                placeholder={creating ? 'Revue quotidienne des utilisateurs' : session.name}
              />
              {!creating && <Form.Text>C'est aussi le nom de la session : celui de la sidebar, des onglets et des notifications.</Form.Text>}
            </div>
            {creating && projects.length > 1 && (
              <div className="col-sm-5">
                <Form.Label>Projet</Form.Label>
                <Form.Select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Form.Select>
              </div>
            )}
          </div>
          <Form.Group className="mb-3">
            <Form.Label>Instruction envoyée à chaque exécution</Form.Label>
            <Form.Control as="textarea" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ce que l'agent doit faire à chaque échéance…" />
          </Form.Group>
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
              {cron && (
                <Form.Text>
                  {describeCron(cron)}
                  {preset !== 'custom' && (
                    <>
                      {' '}
                      · cron <code>{cron}</code>
                    </>
                  )}
                </Form.Text>
              )}
            </div>
          </div>
          <Form.Group className="mb-3">
            <Form.Label className="mb-1">Autorisations pendant les exécutions</Form.Label>
            <Form.Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
              {[...new Set([...PERMISSION_MODES, permissionMode])].map((m) => (
                <option key={m} value={m}>
                  {permissionModeShortLabels[m] ?? m}
                </option>
              ))}
            </Form.Select>
            <Form.Text>
              {permissionHint(permissionMode)}
              {!creating && ' Réglage de la session, aussi appliqué quand vous lui écrivez.'}
            </Form.Text>
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
            {session && session.contextTokens !== null && <> Contexte actuel : {formatTokens(session.contextTokens)} tokens.</>}
          </Form.Text>
          {missingCleanup && (
            <Alert variant="warning" className="d-flex align-items-center justify-content-between gap-2 py-2">
              <span>
                Cette planification n'a pas de nettoyage{session?.contextTokens != null ? <> : le contexte atteint déjà {formatTokens(session.contextTokens)} tokens</> : null}.
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
          {existing && (
            <div className="mt-3">
              <div className="d-flex align-items-center justify-content-between mb-1">
                <Form.Label className="mb-0">Dernières exécutions</Form.Label>
                <Button
                  size="sm"
                  variant="outline-secondary"
                  disabled={launching || busy}
                  title="Exécute la planification maintenant, sans attendre l'échéance (la prochaine échéance est inchangée)"
                  onClick={() => void runNow({ variables: { id: session!.id } }).catch(showError)}
                >
                  <i className="bi bi-play-fill me-1" />
                  Exécuter maintenant
                </Button>
              </div>
              <RunHistory runs={runs.data?.session?.schedule?.runs ?? []} empty={existing.lastResult ? `Avant l'historique : ${existing.lastResult}` : 'Aucune exécution pour l’instant.'} />
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
              <Button variant="outline-danger" disabled={busy} onClick={async () => {
                  if (await confirm({ title: 'Retirer la planification', message: `Plus aucune exécution de « ${existing.name} », et son historique est effacé. La session et son transcript sont conservés.`, confirmLabel: 'Retirer', danger: true })) void clear({ variables: { id: session!.id } });
                }}>
                Retirer la planification
              </Button>
            )}
          </div>
          <div className="d-flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy || !canSubmit}>
              {creating ? 'Créer la planification' : existing ? 'Enregistrer' : 'Planifier'}
            </Button>
          </div>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
