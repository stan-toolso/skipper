import { useLazyQuery, useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { PROJECT_AGENT_REFS, agentKindLabels, type AgentRef } from '../graphql/agents';
import {
  CREATE_SCHEDULE,
  DELETE_SCHEDULE,
  RUN_SCHEDULE_NOW,
  SCHEDULE_NEXT_RUNS,
  SESSION_SCHEDULE,
  UPDATE_SCHEDULE,
  PROVIDERS,
  type Provider,
  type ScheduleArchivePolicy,
  type ScheduleListItem,
  type SessionSchedule,
} from '../graphql/operations';
import { browserTimeZone, buildCron, cronPresetLabels as presetLabels, describeCron, detectCronPreset as detectPreset, weekdayLabels, type CronPreset as Preset } from '../lib/cron';
import { costUnitLabel, formatCost, permissionModeShortLabels } from '../lib/humanize';
import { modelOptions } from '../lib/models';
import AgentAvatar from './AgentAvatar';
import { useDialogs } from './Dialogs';
import { RunHistory } from './ScheduleRuns';
import ScheduleTools from './ScheduleTools';

/** Archivage automatique des sessions d'exécution : libellés et explications. */
const ARCHIVE_POLICIES: { value: ScheduleArchivePolicy; label: string; hint: string }[] = [
  { value: 'PREVIOUS_ON_RUN', label: "Archiver l'ancienne à chaque nouvelle exécution", hint: 'La session de la dernière exécution reste dans la sidebar jusqu’à la suivante, qui la range.' },
  { value: 'ON_FINISH', label: 'Archiver dès la fin de l’exécution', hint: 'La session est rangée dès que l’agent a fini (sauf si une demande attend votre réponse) ; elle reste consultable depuis l’historique ci-dessous.' },
  { value: 'AFTER_DELAY', label: 'Archiver après un délai', hint: 'La session est rangée ce délai après la fin de l’exécution.' },
  { value: 'NEVER', label: 'Ne jamais archiver', hint: 'Chaque exécution laisse sa session active : pensez à les ranger vous-même.' },
];
type DelayUnit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 };
/** Délai en minutes vers la plus grande unité exacte (24 h → 1 jour). */
function splitDelay(minutes: number | null | undefined): { amount: string; unit: DelayUnit } {
  const m = minutes && minutes > 0 ? minutes : 1440;
  if (m % 1440 === 0) return { amount: String(m / 1440), unit: 'days' };
  if (m % 60 === 0) return { amount: String(m / 60), unit: 'hours' };
  return { amount: String(m), unit: 'minutes' };
}
/** Montant saisi (virgule acceptée) : null si vide ou 0, NaN si illisible. */
function parseAmount(text: string): number | null {
  const t = text.replace(',', '.').replace(/\s/g, '');
  if (!t) return null;
  const v = Number(t);
  return v === 0 ? null : v;
}
const amountValid = (v: number | null) => v === null || (Number.isFinite(v) && v > 0);

const PERMISSION_MODES = ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions'] as const;

/** Ce que le mode d'autorisation implique pour une exécution sans personne devant l'écran. */
function permissionHint(mode: string): string {
  if (mode === 'bypassPermissions') return 'Tout est autorisé : rien ne bloque une exécution, y compris les accès du coffre qui exigent votre approbation.';
  if (mode === 'dontAsk') return 'Tout outil qui n’est pas autorisé d’avance (règles du projet, outils pré-autorisés ci-dessous) est refusé sans demande : l’exécution est alors notée « Bloquée » et vous êtes prévenu. Pour ne plus être sollicité, préférez « Tout autoriser » ou pré-autorisez les outils nécessaires.';
  if (mode === 'plan') return 'L’agent ne fait que réfléchir, sans rien modifier ni exécuter.';
  return 'Une demande d’autorisation attend votre réponse : sans réponse après 10 minutes, l’exécution est notée « Bloquée » et vous êtes prévenu.';
}

export interface ScheduleModalProject {
  id: string;
  name: string;
  defaultPermissionMode?: string;
  /** Modèle des nouvelles sessions du projet (appliqué à une nouvelle planification sans modèle choisi). */
  defaultModel?: string | null;
}

/** Réglages repris d'une session pour en faire une planification (bouton « Planifier » de la session). */
export interface ScheduleDefaults {
  projectId: string;
  provider?: string;
  config?: Record<string, unknown>;
  prompt?: string;
  name?: string;
}

const configString = (config: Record<string, unknown> | undefined, key: string) => (typeof config?.[key] === 'string' ? (config[key] as string) : '');

/**
 * Modale d'une planification. Avec `schedule` : la modifier (avec son historique). Sans : nouvelle planification,
 * dans l'un des `projects`, éventuellement préremplie (`defaults`) depuis une session. Une planification est un objet
 * du projet : elle ne crée aucune session avant sa première exécution, et chaque exécution lance la sienne.
 */
export default function ScheduleModal({ schedule, projects = [], defaults, onClose, onCreated }: { schedule?: SessionSchedule | null; projects?: ScheduleModalProject[]; defaults?: ScheduleDefaults; onClose: () => void; onCreated?: (schedule: SessionSchedule) => void }) {
  const { showError, confirm } = useDialogs();
  const navigate = useNavigate();
  const existing = schedule ?? null;
  const detected = useMemo(() => detectPreset(existing?.cron ?? '0 9 * * 1-5'), [existing?.cron]);
  const [name, setName] = useState(existing?.customName ?? defaults?.name ?? '');
  const [projectId, setProjectId] = useState(defaults?.projectId ?? projects[0]?.id ?? '');
  const project = projects.find((p) => p.id === projectId);
  const [preset, setPreset] = useState<Preset>(existing ? detected.preset : 'weekdays');
  const [time, setTime] = useState(detected.time);
  const [weekday, setWeekday] = useState(detected.weekday);
  const [monthDay, setMonthDay] = useState(detected.monthDay);
  const [custom, setCustom] = useState(existing?.cron ?? '0 9 * * 1-5');
  const [timezone, setTimezone] = useState(existing?.timezone ?? browserTimeZone());
  const [prompt, setPrompt] = useState(existing?.prompt ?? defaults?.prompt ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [endAfterRun, setEndAfterRun] = useState(existing?.endAfterRun ?? true);
  const [archivePolicy, setArchivePolicy] = useState<ScheduleArchivePolicy>(existing?.archivePolicy ?? 'PREVIOUS_ON_RUN');
  const initialDelay = splitDelay(existing?.archiveAfterMinutes);
  const [delayAmount, setDelayAmount] = useState(initialDelay.amount);
  const [delayUnit, setDelayUnit] = useState<DelayUnit>(initialDelay.unit);
  const archiveAfterMinutes = Math.round(Number(delayAmount) * UNIT_MINUTES[delayUnit]);
  const archiveValid = archivePolicy !== 'AFTER_DELAY' || (Number.isFinite(archiveAfterMinutes) && archiveAfterMinutes >= 1 && archiveAfterMinutes <= 90 * 1440);
  const [allowedTools, setAllowedTools] = useState<string[]>(existing?.allowedTools ?? []);
  const [maxRunText, setMaxRunText] = useState(existing?.maxRunUsd ? String(existing.maxRunUsd) : '');
  const [monthlyText, setMonthlyText] = useState(existing?.monthlyBudgetUsd ? String(existing.monthlyBudgetUsd) : '');
  const maxRunUsd = parseAmount(maxRunText);
  const monthlyBudgetUsd = parseAmount(monthlyText);
  const budgetValid = amountValid(maxRunUsd) && amountValid(monthlyBudgetUsd);
  const creating = !existing;
  // Réglages des exécutions : ceux de la planification, sinon ceux de la session d'origine, sinon le défaut du projet.
  const sourceConfig = existing?.config ?? defaults?.config;
  const initialMode = configString(sourceConfig, 'permissionMode') || (existing ? 'default' : (project?.defaultPermissionMode ?? 'default'));
  const [permissionMode, setPermissionMode] = useState(initialMode);
  useEffect(() => {
    if (creating && !configString(defaults?.config, 'permissionMode')) setPermissionMode(project?.defaultPermissionMode ?? 'default');
  }, [creating, defaults?.config, project?.defaultPermissionMode]);
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const provider = existing?.provider ?? defaults?.provider ?? 'claude';
  const models = modelOptions(providersData?.providers.find((p) => p.type === provider)?.configFields);
  const initialModel = configString(sourceConfig, 'model');
  const [model, setModel] = useState(initialModel);
  const targetProjectId = existing?.project.id ?? projectId;
  // « Au nom de » : les exécutions peuvent tourner au nom d'un agent du projet (ses comptes, son budget, ses règles).
  const { user } = useAuth();
  const { data: agentsData } = useQuery<{ project: { id: string; agents: (AgentRef & { enabled: boolean })[] } | null }>(PROJECT_AGENT_REFS, { variables: { id: targetProjectId }, skip: !targetProjectId });
  const agents = agentsData?.project?.id === targetProjectId ? agentsData.project.agents.filter((a) => a.enabled || a.id === existing?.agent?.id) : [];
  const initialOwner = existing?.agent?.id ?? '';
  const [ownerChoice, setOwnerChoice] = useState(initialOwner);
  useEffect(() => {
    if (creating) setOwnerChoice('');
  }, [creating, targetProjectId]);
  const asAgent = agents.find((a) => a.id === ownerChoice) ?? null;
  // Propriétaire actuel quand c'est une autre personne : gardé tant qu'on ne choisit pas un agent.
  const otherPerson = existing && !existing.agent && existing.owner && existing.owner.id !== user?.id ? existing.owner : null;

  const cron = buildCron(preset, time, weekday, monthDay, custom);
  const [loadPreview, preview] = useLazyQuery<{ scheduleNextRuns: string[] }>(SCHEDULE_NEXT_RUNS, { fetchPolicy: 'network-only' });
  useEffect(() => {
    if (!cron) return;
    const handle = setTimeout(() => void loadPreview({ variables: { cron, timezone, count: 3 } }), 300);
    return () => clearTimeout(handle);
  }, [cron, timezone, loadPreview]);

  const runs = useQuery<{ sessionSchedule: ScheduleListItem | null }>(SESSION_SCHEDULE, {
    variables: { id: existing?.id ?? '', limit: 10 },
    skip: !existing,
    fetchPolicy: 'cache-and-network',
  });

  const refetchQueries = ['SessionSchedules', 'SessionSchedule', 'Sidebar'];
  const [save, { loading: saving, error: saveError }] = useMutation(UPDATE_SCHEDULE, { refetchQueries });
  const [create, { loading: creatingSchedule, error: createError }] = useMutation<{ createSchedule: SessionSchedule }>(CREATE_SCHEDULE, { refetchQueries });
  const [remove, { loading: removing, error: removeError }] = useMutation(DELETE_SCHEDULE, { onCompleted: onClose, refetchQueries });
  const [runNow, { loading: launching }] = useMutation<{ runScheduleNow: { id: string } | null }>(RUN_SCHEDULE_NOW, { refetchQueries });
  const busy = saving || removing || creatingSchedule;
  const error = saveError ?? removeError ?? createError;
  const canSubmit = Boolean(cron && prompt.trim() && archiveValid && budgetValid && (!creating || (name.trim() && projectId)));

  const submit = async () => {
    if (!canSubmit) return;
    // Chaque exécution a sa propre session, neuve : plus de nettoyage de conversation à régler ici.
    const input = {
      name: name.trim() || null,
      cron,
      timezone,
      prompt: prompt.trim(),
      enabled,
      endAfterRun,
      archivePolicy,
      archiveAfterMinutes: archivePolicy === 'AFTER_DELAY' ? archiveAfterMinutes : null,
      allowedTools,
      maxRunUsd,
      monthlyBudgetUsd,
      // Valeur vide : réglage retiré (défaut du projet ou du propriétaire).
      config: { permissionMode, model },
    };
    if (creating) {
      const res = await create({ variables: { input: { ...input, name: name.trim(), projectId, provider, agentId: ownerChoice || null, config: { permissionMode, ...(model ? { model } : {}) } } } }).catch(() => null);
      if (res?.data) {
        onCreated?.(res.data.createSchedule);
        onClose();
      }
      return;
    }
    // Propriétaire envoyé seulement s'il change (vide : la personne connectée).
    const res = await save({ variables: { id: existing.id, input: ownerChoice !== initialOwner ? { ...input, agentId: ownerChoice } : input } }).catch(() => null);
    if (res?.data) onClose();
  };

  const launch = async () => {
    if (!existing) return;
    const res = await runNow({ variables: { id: existing.id } }).catch((err: Error) => (showError(err), null));
    const sessionId = res?.data?.runScheduleNow?.id;
    if (sessionId) {
      onClose();
      navigate(`/sessions/${sessionId}`);
    }
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
            {creating ? 'Nouvelle planification' : `Planification « ${existing.name} »`}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="text-secondary small">
            À chaque échéance, la planification lance une nouvelle session, dans son propre dossier de travail, avec les réglages ci-dessous (modèle, autorisations), et lui envoie l'instruction. Aucune session n'existe avant la première exécution ; si l'exécution précédente n'est pas finie, l'échéance est ignorée.
          </p>
          {existing && (existing.agent || existing.owner) && (
            <p className="small mb-3 d-flex align-items-center gap-2">
              {existing.agent ? (
                <>
                  <AgentAvatar agent={existing.agent} size={20} />
                  <span>
                    Exécutions lancées <b>au nom de l'agent {existing.agent.name}</b>
                    {existing.requestedBy ? ` (planification mise par ${existing.requestedBy.name})` : ''}.
                  </span>
                </>
              ) : (
                <>
                  <i className="bi bi-person-circle text-secondary" />
                  <span>
                    Exécutions lancées au nom de <b>{existing.owner!.name}</b>.
                  </span>
                </>
              )}
            </p>
          )}
          <div className="row g-2 mb-3">
            <div className={creating && projects.length > 1 ? 'col-sm-7' : 'col-12'}>
              <Form.Label>Nom</Form.Label>
              <Form.Control
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required={creating}
                autoFocus={creating}
                placeholder="Revue quotidienne des utilisateurs"
              />
              <Form.Text>Les sessions des exécutions s'appellent « {name.trim() || 'Nom'} · jj/mm hh:mm » et se rangent sous ce nom dans la sidebar.</Form.Text>
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
          {agents.length > 0 && (
            <Form.Group className="mb-3">
              <Form.Label className="mb-1">Lancer les exécutions au nom de</Form.Label>
              <div className="d-flex align-items-center gap-2">
                {asAgent ? <AgentAvatar agent={asAgent} size={26} /> : <i className="bi bi-person-circle text-secondary" style={{ fontSize: 22 }} />}
                <Form.Select value={ownerChoice} onChange={(e) => setOwnerChoice(e.target.value)} aria-label="Lancer les exécutions au nom de">
                  <option value="">{otherPerson ? `${otherPerson.name} (propriétaire actuel)` : 'Moi (mes comptes, mon budget)'}</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {agentKindLabels[a.kind]} (agent)
                    </option>
                  ))}
                </Form.Select>
              </div>
              <Form.Text>
                {asAgent
                  ? `Chaque exécution est une session de ${asAgent.name} : ses instructions et ses règles, ses comptes (ou ceux qu'on lui prête), ses modèles autorisés ; la consommation lui est imputée. Vous êtes indiqué comme personne demandeuse.`
                  : otherPerson
                    ? `Les exécutions tournent avec les comptes et le budget de ${otherPerson.name}. Choisissez un agent pour les lancer à son nom.`
                    : 'Les exécutions tournent avec vos comptes et votre budget. Choisissez un agent du projet pour les lancer à son nom.'}
              </Form.Text>
            </Form.Group>
          )}
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
          {provider === 'claude' && models.length > 0 && (
            <Form.Group className="mb-3">
              <Form.Label className="mb-1">Modèle des exécutions</Form.Label>
              <Form.Select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">{(project?.defaultModel ?? existing?.project.defaultModel) ? `Modèle du projet (${project?.defaultModel ?? existing?.project.defaultModel})` : 'Modèle par défaut du propriétaire'}</option>
                {[...models, ...(model && !models.some((m) => m.value === model) ? [{ value: model, label: model }] : [])].map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Form.Select>
              <Form.Text>Une revue récurrente en lecture tourne très bien sur un modèle plus économique (Sonnet) ; les modèles proposés se règlent dans Paramètres → Claude.</Form.Text>
            </Form.Group>
          )}
          <Form.Group className="mb-3">
            <Form.Label className="mb-1">Autorisations pendant les exécutions</Form.Label>
            <Form.Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
              {[...new Set([...PERMISSION_MODES, permissionMode])].map((m) => (
                <option key={m} value={m}>
                  {permissionModeShortLabels[m] ?? m}
                </option>
              ))}
            </Form.Select>
            <Form.Text>{permissionHint(permissionMode)}</Form.Text>
            {permissionMode === 'dontAsk' && (
              <Alert variant="warning" className="mt-2 mb-0 py-2 small">
                <i className="bi bi-exclamation-triangle me-1" />
                En mode « Refuser sans demander », l’agent n’aura accès qu’à ce qui est autorisé d’avance ; tout le reste sera refusé pendant les exécutions.
              </Alert>
            )}
          </Form.Group>
          <ScheduleTools value={allowedTools} onChange={setAllowedTools} projectId={targetProjectId} scheduleId={existing?.id ?? null} prompt={prompt} permissionMode={permissionMode} />
          <Form.Group className="mb-3">
            <Form.Label className="mb-1">Budget ({costUnitLabel()})</Form.Label>
            <div className="d-flex flex-wrap gap-2">
              <div style={{ flex: '1 1 10rem' }}>
                <Form.Control inputMode="decimal" value={maxRunText} onChange={(e) => setMaxRunText(e.target.value)} placeholder="Par exécution" aria-label="Plafond par exécution" isInvalid={!amountValid(maxRunUsd)} />
              </div>
              <div style={{ flex: '1 1 10rem' }}>
                <Form.Control inputMode="decimal" value={monthlyText} onChange={(e) => setMonthlyText(e.target.value)} placeholder="Par mois" aria-label="Budget mensuel" isInvalid={!amountValid(monthlyBudgetUsd)} />
              </div>
            </div>
            <Form.Text>
              Plafond par exécution : atteint, la session de l’exécution est arrêtée (en cours de tour pour Claude). Budget mensuel : atteint, les échéances sont ignorées jusqu’au mois suivant. Vous êtes prévenu dans les deux cas. Vide : aucun plafond (le budget du projet et celui du propriétaire s’appliquent toujours).
              {existing && typeof existing.monthUsd === 'number' && <> Ce mois-ci : {formatCost(existing.monthUsd)}{existing.monthlyBudgetUsd ? ` sur ${formatCost(existing.monthlyBudgetUsd)}` : ''}.</>}
            </Form.Text>
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label className="mb-1">Archivage des sessions d'exécution</Form.Label>
            <div className="d-flex flex-wrap gap-2 align-items-center">
              <Form.Select value={archivePolicy} onChange={(e) => setArchivePolicy(e.target.value as ScheduleArchivePolicy)} style={{ flex: '1 1 16rem' }}>
                {ARCHIVE_POLICIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Form.Select>
              {archivePolicy === 'AFTER_DELAY' && (
                <div className="d-flex gap-2 align-items-center">
                  <Form.Control type="number" min={1} value={delayAmount} onChange={(e) => setDelayAmount(e.target.value)} style={{ width: '5.5rem' }} aria-label="Délai" isInvalid={!archiveValid} />
                  <Form.Select value={delayUnit} onChange={(e) => setDelayUnit(e.target.value as DelayUnit)} style={{ width: '8rem' }} aria-label="Unité du délai">
                    <option value="minutes">minutes</option>
                    <option value="hours">heures</option>
                    <option value="days">jours</option>
                  </Form.Select>
                </div>
              )}
            </div>
            <Form.Text>
              {ARCHIVE_POLICIES.find((p) => p.value === archivePolicy)?.hint}
              {archivePolicy === 'AFTER_DELAY' && !archiveValid && ' Le délai va d’une minute à 90 jours.'}
              {' '}Une session dont la PR est encore ouverte n'est jamais archivée d'office.
            </Form.Text>
          </Form.Group>
          <Form.Check
            type="switch"
            id="schedule-end-after-run"
            className="mb-2"
            label="Terminer la session de chaque exécution à la fin de son tour (sinon elle reste ouverte à vos instructions)"
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
                  title="Lance une exécution maintenant, dans une nouvelle session (la prochaine échéance est inchangée)"
                  onClick={() => void launch()}
                >
                  <i className="bi bi-play-fill me-1" />
                  Exécuter maintenant
                </Button>
              </div>
              <RunHistory runs={runs.data?.sessionSchedule?.runs ?? []} empty={existing.lastResult ? `Avant l'historique : ${existing.lastResult}` : 'Aucune exécution pour l’instant.'} />
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
                  if (await confirm({ title: 'Supprimer la planification', message: `Plus aucune exécution de « ${existing.name} », et son historique est effacé. Les sessions des exécutions passées et leurs transcripts sont conservés.`, confirmLabel: 'Supprimer', danger: true })) void remove({ variables: { id: existing.id } });
                }}>
                Supprimer la planification
              </Button>
            )}
          </div>
          <div className="d-flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy || !canSubmit}>
              {creating ? 'Créer la planification' : 'Enregistrer'}
            </Button>
          </div>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
