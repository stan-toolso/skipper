import { useMutation, useQuery } from '@apollo/client';
import { usePollingQuery } from '../lib/usePollingQuery';
import { ProjectPageLoading } from '../components/PageLoading';
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTabTitle } from '../workbench/TabsContext';
import { useGitTarget } from '../workbench/GitTargetContext';
import ProjectHeader from '../components/ProjectHeader';

import { CREATE_PROJECT_API_KEY, DELETE_PROJECT_API_KEY, PROJECT_API_KEYS, type ProjectApiKey } from '../graphql/tasks';
import { apiBaseUrl } from '../apollo';
import StatusBadge from '../components/StatusBadge';
import { useDialogs } from '../components/Dialogs';
import { formatDuration as formatSeconds, formatMb, Gauge } from '../components/ServerHealthCard';

/** Activité d'une session vue depuis son processus Claude. */
function processActivity(p: ContainerProcess): { label: string; className: string } {
  const s = p.session;
  if (!s) return p.sessionId ? { label: 'session supprimée', className: 'text-danger' } : { label: 'hors session (terminal)', className: 'text-secondary' };
  if (s.status !== 'RUNNING') return { label: 'session terminée : processus orphelin', className: 'text-danger' };
  if (s.activity === 'BUSY') return { label: 'au travail', className: 'text-success' };
  return { label: `inactive depuis ${timeAgo(s.updatedAt).replace(/^il y a /, '')}`, className: 'text-secondary' };
}

/** Pression CPU (part du temps d'attente du processeur sur 60 s) à partir de laquelle la carte avertit. */
const CPU_PRESSURE_WARN_PERCENT = 25;

const plural = (n: number, word: string) => `${n.toLocaleString('fr-FR')} ${word}${n > 1 ? 's' : ''}`;

/** Mémoire, CPU et processus Claude du conteneur en marche, relevés toutes les 10 secondes. */
function ContainerUsage({ projectId }: { projectId: string }) {
  const { data, error } = usePollingQuery<{ project: { id: string; containerStats: ContainerStats | null } | null }>(PROJECT_CONTAINER_STATS, {
    variables: { id: projectId },
    pollInterval: 10_000,
    fetchPolicy: 'cache-and-network',
  });
  const c = data?.project?.containerStats;
  if (error) return <Alert variant="warning" className="py-2">Mesure du conteneur impossible : {error.message}</Alert>;
  if (!c) return null;
  const sessionsMb = c.claudeProcesses.reduce((sum, p) => sum + p.rssMb + p.childrenRssMb, 0);
  const cpuCapacity = c.cpuLimit ? `plafond de ${plural(c.cpuLimit, 'cœur')}` : `${plural(c.hostCpus, 'cœur')} du serveur, sans plafond`;
  return (
    <div className="mb-3">
      {c.cpuPressurePercent !== null && c.cpuPressurePercent >= CPU_PRESSURE_WARN_PERCENT && (
        <Alert variant="warning" className="py-2">
          <i className="bi bi-speedometer2 me-1" /> Processeur saturé : au cours de la dernière minute, les processus du conteneur ont attendu le CPU{' '}
          {c.cpuPressurePercent.toLocaleString('fr-FR')} % du temps ({cpuCapacity} · {c.claudeProcesses.length} processus Claude). Les commandes des
          agents (installations, builds, tests) en sont ralenties : attendez la fin des commandes en cours, lancez moins de sessions en parallèle
          {c.cpuLimit ? ' ou relevez le plafond CPU' : ''}.
        </Alert>
      )}
      {c.memoryHighSince && (
        <Alert variant="danger" className="py-2">
          <i className="bi bi-exclamation-triangle me-1" /> Mémoire au-delà de 90 % de la limite depuis {timeAgo(c.memoryHighSince).replace(/^il y a /, '')} : au-delà de la limite, le noyau
          tue des processus (sessions en erreur, commandes interrompues). Terminez les sessions inutiles ou relevez la limite.
        </Alert>
      )}
      {c.memoryLimitMb ? (
        <Gauge label="Mémoire" used={c.memoryUsedMb} total={c.memoryLimitMb} detail={`${formatMb(c.memoryUsedMb)} / ${formatMb(c.memoryLimitMb)}${c.swapUsedMb ? ` · swap ${formatMb(c.swapUsedMb)}` : ''}`} />
      ) : (
        <div className="mb-2">Mémoire : {formatMb(c.memoryUsedMb)} (sans limite)</div>
      )}
      {c.cpuPercent !== null && (
        <Gauge
          label="CPU"
          used={c.cpuPercent}
          total={(c.cpuLimit ?? c.hostCpus) * 100}
          detail={`${c.cpuPercent} % (${cpuCapacity})${c.cpuPressurePercent !== null ? ` · attente CPU ${c.cpuPressurePercent.toLocaleString('fr-FR')} %` : ''}`}
        />
      )}
      {c.oomKills > 0 && (
        <div className="text-warning mb-2" title="Compteur oom_kill du cgroup du conteneur, remis à zéro quand le conteneur est recréé">
          <i className="bi bi-exclamation-octagon me-1" />
          {c.oomKills} processus tué{c.oomKills > 1 ? 's' : ''} faute de mémoire depuis la création du conteneur
        </div>
      )}
      {c.claudeProcesses.length > 0 && (
        <>
          <div className="text-secondary mb-1">
            {c.claudeProcesses.length} processus Claude · {formatMb(sessionsMb)} avec les commandes qu'ils ont lancées
          </div>
          <Table size="sm" className="mb-0 align-middle">
            <thead>
              <tr>
                <th>Session</th>
                <th>Activité</th>
                <th className="text-end" title="Mémoire résidente du CLI Claude Code">Claude</th>
                <th className="text-end" title="Mémoire des commandes lancées par l'agent (tsc, npm, vite…)">Commandes</th>
                <th className="text-end">Depuis</th>
              </tr>
            </thead>
            <tbody>
              {c.claudeProcesses.map((p) => {
                const activity = processActivity(p);
                return (
                  <tr key={p.pid}>
                    <td>{p.session ? <Link to={`/sessions/${p.session.id}`}>{p.session.name}</Link> : <span className="text-secondary">pid {p.pid}</span>}</td>
                    <td className={activity.className}>{activity.label}</td>
                    <td className="text-end">{formatMb(p.rssMb)}</td>
                    <td className="text-end">{p.childrenRssMb ? formatMb(p.childrenRssMb) : '—'}</td>
                    <td className="text-end text-secondary">{formatSeconds(p.elapsedSeconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}

/** Limites mémoire et CPU du conteneur (runnerConfig), appliquées à chaud au conteneur existant. */
function RunnerLimitsForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const [memory, setMemory] = useState(project.runnerConfig?.memory ?? '');
  const [cpus, setCpus] = useState(project.runnerConfig?.cpus ?? '');
  const [save, { loading, error }] = useMutation(UPDATE_PROJECT, { refetchQueries: ['Project', 'ProjectContainerStats'] });
  return (
    <Form
      className="mb-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const runnerConfig: Record<string, unknown> = { ...project.runnerConfig, memory: memory.trim() || undefined, cpus: cpus.trim() || undefined };
        try {
          await save({ variables: { id: project.id, input: { runnerConfig: Object.fromEntries(Object.entries(runnerConfig).filter(([, v]) => v !== undefined)) } } });
          onDone();
        } catch {
          // Erreur affichée sous le formulaire.
        }
      }}
    >
      <Row className="g-2 align-items-end">
        <Col xs={4}>
          <Form.Label className="small mb-1">Mémoire</Form.Label>
          <Form.Control size="sm" value={memory} placeholder={project.runnerStatus.memory ?? '768m'} onChange={(e) => setMemory(e.target.value)} />
        </Col>
        <Col xs={3}>
          <Form.Label className="small mb-1">CPU</Form.Label>
          <Form.Control size="sm" value={cpus} placeholder={project.runnerStatus.cpus ?? 'sans plafond'} onChange={(e) => setCpus(e.target.value)} />
        </Col>
        <Col xs="auto">
          <Button size="sm" type="submit" disabled={loading}>
            {loading ? 'Application…' : 'Appliquer'}
          </Button>{' '}
          <Button size="sm" variant="link" onClick={onDone}>
            Annuler
          </Button>
        </Col>
      </Row>
      <Form.Text>
        Appliquées tout de suite au conteneur, sans couper les sessions. Compter ≈ 250 Mo par session Claude ouverte, plus ≈ 900 Mo pour un build Vite. CPU vide : aucun
        plafond, les cœurs du serveur sont partagés équitablement entre conteneurs ; un nombre de cœurs (1, 0.5…) fixe un plafond dur, que toutes les sessions du projet se partagent.
      </Form.Text>
      {error && <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert>}
    </Form>
  );
}

/** Conteneur Docker du projet : son état et ses commandes. */
function RunnerCard({ project }: { project: Project }) {
  const [start, { loading: starting, error: startError }] = useMutation(START_PROJECT_RUNNER, { refetchQueries: ['Project'] });
  const [stop, { loading: stopping, error: stopError }] = useMutation(STOP_PROJECT_RUNNER, { refetchQueries: ['Project'] });
  const { confirm } = useDialogs();
  const [reset, { loading: resetting, error: resetError }] = useMutation(RESET_PROJECT_RUNNER, { refetchQueries: ['Project'] });
  const s = project.runnerStatus;
  const [editingLimits, setEditingLimits] = useState(false);
  const isAdmin = project.myRole === 'ADMIN';
  const error = startError ?? stopError ?? resetError;
  const busy = starting || stopping || resetting;
  const stateLabels: Record<string, string> = { running: 'en marche', exited: 'arrêté', stopped: 'arrêté', created: 'créé', absent: 'pas encore créé', unavailable: 'indisponible', paused: 'en pause', restarting: 'redémarrage' };
  return (
    <Card className="mt-3">
      <Card.Header>Environnement d'exécution</Card.Header>
      <Card.Body className="small">
        <dl className="row mb-2">
          <dt className="col-3">Conteneur</dt>
          <dd className="col-9">
            <code>{s.containerName}</code>{' '}
            <span className={s.ready ? 'text-success' : s.state === 'unavailable' ? 'text-danger' : 'text-warning'}>· {stateLabels[s.state] ?? s.state}</span>
            {s.startedAt && (
              <span className="text-secondary" title={`Démarré le ${new Date(s.startedAt).toLocaleString()}`}>
                {' '}
                depuis {formatSeconds((Date.now() - new Date(s.startedAt).getTime()) / 1000)}
              </span>
            )}
            {s.outdated && (
              <Badge bg="warning" text="dark" className="ms-2" title={s.outdatedReasons.join(' ; ')}>
                à recréer
              </Badge>
            )}
          </dd>
          <dt className="col-3">Image</dt>
          <dd className="col-9">
            <code>{s.image}</code>
          </dd>
          <dt className="col-3">Limites</dt>
          <dd className="col-9">
            mémoire {s.memory} · CPU {s.cpus ?? 'sans plafond'}
            {isAdmin && !editingLimits && (
              <Button size="sm" variant="link" className="p-0 ms-2 align-baseline" onClick={() => setEditingLimits(true)}>
                Modifier
              </Button>
            )}
          </dd>
          {s.zombies !== null && (
            <>
              <dt className="col-3">Processus</dt>
              <dd className="col-9">
                {s.zombies === 0 ? (
                  <span className="text-secondary">aucun zombie</span>
                ) : (
                  <span className="text-warning" title="Processus terminés mais jamais récoltés : le conteneur a été créé sans processus init (--init). Recréez-le.">
                    {s.zombies} processus zombie{s.zombies > 1 ? 's' : ''}
                  </span>
                )}
              </dd>
            </>
          )}
        </dl>
        {editingLimits && <RunnerLimitsForm project={project} onDone={() => setEditingLimits(false)} />}
        {s.ready && <ContainerUsage projectId={project.id} />}
        {s.error && <Alert variant="danger" className="py-2">{s.error}</Alert>}
        {s.outdated && (
          <Alert variant="warning" className="py-2">
            <div>Le conteneur ne correspond plus à la configuration actuelle :</div>
            <ul className="mb-1">
              {s.outdatedReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <div className="text-secondary">Il sera recréé de lui-même dès qu'aucune session ni terminal du projet ne tournera, ou tout de suite avec « Recréer ».</div>
          </Alert>
        )}
        <div className="d-flex gap-2">
          {!s.ready && s.state !== 'unavailable' && (
            <Button size="sm" disabled={busy} onClick={() => start({ variables: { id: project.id } })}>
              {starting ? 'Démarrage…' : 'Démarrer'}
            </Button>
          )}
          {s.ready && (
            <Button size="sm" variant="outline-warning" disabled={busy} title="Les sessions en cours sont interrompues (bouton « Reprendre » sur leur page) et les terminaux fermés" onClick={() => stop({ variables: { id: project.id } })}>
              {stopping ? 'Arrêt…' : 'Arrêter'}
            </Button>
          )}
          {s.state !== 'absent' && s.state !== 'unavailable' && (
            <Button
              size="sm"
              variant={s.outdated ? 'warning' : 'outline-secondary'}
              disabled={busy}
              title="Supprime le conteneur et le recrée avec l'image et les limites actuelles ; les sessions en cours sont interrompues puis reprises, les fichiers du projet sont conservés"
              onClick={async () => {
                if (await confirm({ title: 'Recréer le conteneur', message: 'Recréer le conteneur ? Les sessions en cours dans ce projet seront interrompues le temps de la recréation, puis reprises automatiquement. Les terminaux ouverts seront fermés. Les fichiers sont conservés.', confirmLabel: 'Recréer', danger: true })) reset({ variables: { id: project.id } });
              }}
            >
              {resetting ? 'Recréation…' : 'Recréer'}
            </Button>
          )}
        </div>
        <div className="text-secondary mt-2">Le conteneur démarre automatiquement à la première session ou au premier terminal.</div>
        {error && <Alert variant="danger" className="mt-2 mb-0 py-2">{error.message}</Alert>}
      </Card.Body>
    </Card>
  );
}
import { useState } from 'react';
import {
  DELETE_PROJECT,
  INVITE_PROJECT_MEMBER,
  PREPARE_PROJECT_WORKSPACE,
  PROJECT,
  PROJECTS,
  PROJECT_MEMBERS,
  PROJECT_CONTAINER_STATS,
  UPDATE_PROJECT,
  type ContainerProcess,
  type ContainerStats,
  REMOVE_PROJECT_MEMBER,
  RESET_PROJECT_RUNNER,
  START_PROJECT_RUNNER,
  STOP_PROJECT_RUNNER,
  UPDATE_PROJECT_MEMBER_ROLE,
  type Project,
  type ProjectMember,
  type ProjectRole,
  type Session,
} from '../graphql/operations';
import { projectRoleLabels, timeAgo } from '../lib/humanize';
import { useAuth } from '../auth/AuthContext';
import { ADD_PROJECT_PERMISSION_RULE, DELETE_PROJECT_PERMISSION_RULE, DELETE_PROJECT_PERMISSION_RULES, PROJECT_PERMISSION_RULES, UPDATE_PROJECT_PERMISSION_RULE, type PermissionRule } from '../graphql/operations';

/** Utilisation d'une règle : nombre d'appels autorisés et dernière utilisation, ou absence d'utilisation depuis le début du suivi. */
function ruleUsage(r: PermissionRule): string {
  if (!r.useCount || !r.lastUsedAt) return `jamais utilisée depuis le ${new Date(r.usageTrackedSince).toLocaleDateString()}`;
  return `utilisée ${r.useCount} fois, dernière fois ${timeAgo(r.lastUsedAt)}`;
}

/** Autorisations d'outils mémorisées pour le projet (réponse « ne plus demander dans ce projet »), avec ajout et retrait. */
function PermissionRulesCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { data } = usePollingQuery<{ project: { permissionRules: PermissionRule[] } | null }>(PROJECT_PERMISSION_RULES, { variables: { id: projectId }, pollInterval: 10000 });
  const refetch = { refetchQueries: ['ProjectPermissionRules'] };
  const [addRule, { loading: adding, error: addError }] = useMutation(ADD_PROJECT_PERMISSION_RULE, refetch);
  const [deleteRule, { error: deleteError }] = useMutation(DELETE_PROJECT_PERMISSION_RULE, refetch);
  const [deleteRules, { loading: deletingMany, error: deleteManyError }] = useMutation(DELETE_PROJECT_PERMISSION_RULES, refetch);
  const [updateRule, { loading: updating, error: updateError }] = useMutation(UPDATE_PROJECT_PERMISSION_RULE, refetch);
  const { confirm } = useDialogs();
  const [toolName, setToolName] = useState('');
  const [ruleContent, setRuleContent] = useState('');
  // Règle en cours de modification : identifiant et texte complet (Outil ou Outil(motif)).
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const rules = data?.project?.permissionRules ?? [];
  const unused = rules.filter((r) => !r.useCount);
  const error = addError ?? deleteError ?? deleteManyError ?? updateError;
  const saveEdit = () => {
    if (!editing?.text.trim()) return;
    updateRule({ variables: { id: editing.id, rule: editing.text.trim() } })
      .then(() => setEditing(null))
      .catch(() => undefined);
  };
  const removeUnused = async () => {
    const ok = await confirm({
      title: 'Retirer les règles jamais utilisées',
      message: (
        <>
          <p>Ces règles n'ont autorisé aucun appel d'outil depuis le début du suivi : les prochaines sessions redemanderont.</p>
          <ul className="small mb-0">
            {unused.map((r) => (
              <li key={r.id}>
                <code>{r.rule}</code> <span className="text-secondary">— {ruleUsage(r)}</span>
              </li>
            ))}
          </ul>
        </>
      ),
      confirmLabel: `Retirer ${unused.length} règle${unused.length > 1 ? 's' : ''}`,
      danger: true,
    });
    if (ok) deleteRules({ variables: { projectId, ids: unused.map((r) => r.id) } }).catch(() => undefined);
  };
  return (
    <Card className="mt-3">
      <Card.Header>Autorisations mémorisées</Card.Header>
      <Card.Body className="small">
        <p className="text-secondary">
          Quand un agent demande une autorisation, « ne plus demander dans ce projet » enregistre la règle ici : toutes les sessions du projet l'appliquent sans redemander. Modifier ou retirer une
          règle ne concerne que les prochaines sessions. Une règle Bash en <code>préfixe *</code> (ex. <code>git checkout *</code>) couvre toutes les commandes qui commencent ainsi.
        </p>
        <Table size="sm" className="mb-3 align-middle table-stack">
          <tbody>
            {rules.length === 0 && (
              <tr>
                <td className="text-secondary">Aucune autorisation mémorisée.</td>
              </tr>
            )}
            {rules.map((r) => (
              <tr key={r.id}>
                <td>
                  {editing?.id === r.id ? (
                    <Form
                      className="d-flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveEdit();
                      }}
                    >
                      <Form.Control size="sm" className="font-monospace" autoFocus value={editing.text} onChange={(e) => setEditing({ id: r.id, text: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
                      <Button type="submit" size="sm" variant="outline-primary" disabled={updating || !editing.text.trim()}>
                        Enregistrer
                      </Button>
                      <Button size="sm" variant="link" className="text-secondary" onClick={() => setEditing(null)}>
                        Annuler
                      </Button>
                    </Form>
                  ) : (
                    <code role={canManage ? 'button' : undefined} title={canManage ? 'Cliquer pour modifier' : undefined} onClick={() => canManage && setEditing({ id: r.id, text: r.rule })}>
                      {r.rule}
                    </code>
                  )}
                  <div className="text-secondary">
                    {ruleUsage(r)} · créée le {new Date(r.createdAt).toLocaleDateString()}
                    {r.createdBySession && (
                      <>
                        {' '}
                        · session <Link to={`/sessions/${r.createdBySession.id}`}>{r.createdBySession.name}</Link>
                      </>
                    )}
                  </div>
                </td>
                {canManage && (
                  <td className="text-end text-nowrap" style={{ width: 170 }}>
                    {editing?.id !== r.id && (
                      <Button size="sm" variant="outline-secondary" className="me-2" onClick={() => setEditing({ id: r.id, text: r.rule })}>
                        Modifier
                      </Button>
                    )}
                    <Button size="sm" variant="outline-danger" onClick={() => deleteRule({ variables: { id: r.id } })}>
                      Retirer
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
        {canManage && unused.length > 0 && (
          <Button size="sm" variant="outline-danger" className="mb-3" disabled={deletingMany} onClick={() => void removeUnused()}>
            Retirer les règles jamais utilisées ({unused.length})
          </Button>
        )}
        {canManage && (
          <Form
            className="d-flex gap-2 align-items-end flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              if (!toolName.trim()) return;
              addRule({ variables: { projectId, toolName: toolName.trim(), ruleContent: ruleContent.trim() || null } }).then(() => {
                setToolName('');
                setRuleContent('');
              });
            }}
          >
            <Form.Group>
              <Form.Label className="mb-1">Outil</Form.Label>
              <Form.Control size="sm" value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder="ex. Bash, Read, WebFetch" style={{ width: 180 }} />
            </Form.Group>
            <Form.Group>
              <Form.Label className="mb-1">Motif (optionnel)</Form.Label>
              <Form.Control size="sm" value={ruleContent} onChange={(e) => setRuleContent(e.target.value)} placeholder="ex. git status * ou npm test *" style={{ width: 260 }} />
            </Form.Group>
            <Button type="submit" size="sm" variant="outline-primary" disabled={adding || !toolName.trim()}>
              {adding ? 'Ajout…' : 'Ajouter'}
            </Button>
          </Form>
        )}
        {error && (
          <Alert variant="danger" className="mt-2 mb-0">
            {error.message}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}

const ROLES: ProjectRole[] = ['ADMIN', 'MEMBER', 'VIEWER'];

/** Membres du projet : liste avec rôle, invitation par e-mail et retrait (administrateurs du projet). */
function MembersCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { user: me } = useAuth();
  const { data } = usePollingQuery<{ project: { members: ProjectMember[] } | null }>(PROJECT_MEMBERS, { variables: { id: projectId }, pollInterval: 10000 });
  const refetch = { refetchQueries: ['ProjectMembers'] };
  const [invite, { loading: inviting, error: inviteError }] = useMutation(INVITE_PROJECT_MEMBER, refetch);
  const [setRole, { error: roleError }] = useMutation(UPDATE_PROJECT_MEMBER_ROLE, refetch);
  const { confirm } = useDialogs();
  const [remove, { error: removeError }] = useMutation(REMOVE_PROJECT_MEMBER, refetch);
  const [email, setEmail] = useState('');
  const [role, setRoleInput] = useState<ProjectRole>('MEMBER');
  const members = data?.project?.members ?? [];
  const error = inviteError ?? roleError ?? removeError;
  return (
    <Card className="mt-3">
      <Card.Header>Membres</Card.Header>
      <Card.Body className="small">
        <Table size="sm" className="mb-3 align-middle table-stack">
          <tbody>
            {members.map((m) => (
              <tr key={m.user.id}>
                <td>
                  <strong>{m.user.name}</strong>
                  {m.user.id === me?.id && <span className="text-secondary"> (vous)</span>}
                  {m.pending && (
                    <span className="badge text-bg-secondary ms-2" title="Invité, ne s'est pas encore connecté">
                      en attente
                    </span>
                  )}
                  <div className="text-secondary">{m.user.email}</div>
                </td>
                <td style={{ width: 180 }}>
                  {canManage ? (
                    <Form.Select size="sm" value={m.role} title={projectRoleLabels[m.role]?.hint} onChange={(e) => setRole({ variables: { projectId, userId: m.user.id, role: e.target.value } })}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {projectRoleLabels[r].label}
                        </option>
                      ))}
                    </Form.Select>
                  ) : (
                    <span title={projectRoleLabels[m.role]?.hint}>{projectRoleLabels[m.role]?.label ?? m.role}</span>
                  )}
                </td>
                {canManage && (
                  <td className="text-end" style={{ width: 90 }}>
                    <Button
                      size="sm"
                      variant="outline-danger"
                      onClick={async () => {
                        if (await confirm({ title: 'Retirer le membre', message: `Retirer ${m.user.name} du projet ? Cette personne n'y aura plus accès.`, confirmLabel: 'Retirer', danger: true })) remove({ variables: { projectId, userId: m.user.id } });
                      }}
                    >
                      Retirer
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
        {canManage && (
          <Form
            className="d-flex gap-2 align-items-end flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              if (!email.trim()) return;
              invite({ variables: { projectId, email: email.trim(), role } }).then(() => setEmail(''));
            }}
          >
            <Form.Group>
              <Form.Label className="mb-1">Inviter par e-mail (compte Google)</Form.Label>
              <Form.Control size="sm" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prenom@exemple.com" style={{ width: 260 }} />
            </Form.Group>
            <Form.Group>
              <Form.Label className="mb-1">Rôle</Form.Label>
              <Form.Select size="sm" value={role} onChange={(e) => setRoleInput(e.target.value as ProjectRole)} style={{ width: 160 }}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {projectRoleLabels[r].label}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
            <Button type="submit" size="sm" disabled={inviting || !email.trim()}>
              {inviting ? 'Invitation…' : 'Inviter'}
            </Button>
            <div className="text-secondary w-100">{projectRoleLabels[role].hint} La personne pourra se connecter avec ce compte Google.</div>
          </Form>
        )}
        {error && (
          <Alert variant="danger" className="mt-2 mb-0">
            {error.message}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}

/** Clés d'API du projet : accès REST aux tâches (`/api/v1/tasks`) pour les outils externes. */
function ApiKeysCard({ projectId }: { projectId: string }) {
  const { data } = useQuery<{ project: { id: string; apiKeys: ProjectApiKey[] } | null }>(PROJECT_API_KEYS, { variables: { id: projectId } });
  const { confirm, prompt, showError } = useDialogs();
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [create] = useMutation<{ createProjectApiKey: { secret: string; key: ProjectApiKey } }>(CREATE_PROJECT_API_KEY, { refetchQueries: ['ProjectApiKeys'], onError: (e) => void showError(e) });
  const [remove] = useMutation(DELETE_PROJECT_API_KEY, { refetchQueries: ['ProjectApiKeys'], onError: (e) => void showError(e) });
  const keys = data?.project?.apiKeys ?? [];
  const base = apiBaseUrl || window.location.origin;
  return (
    <Card className="mt-3">
      <Card.Header>Clés d'API (tâches)</Card.Header>
      <Card.Body className="small">
        <p className="text-secondary">
          Une clé d'API permet à un outil externe (formulaire, CRM, script) de lister et créer les tâches de ce projet par REST, sans compte Skipper. Le secret n'est montré qu'à la création.
        </p>
        {created && (
          <Alert variant="success" className="py-2" onClose={() => setCreated(null)} dismissible>
            <div>
              Clé « {created.name} » créée. Copiez le secret maintenant, il ne sera plus affiché :
            </div>
            <code className="user-select-all d-block my-1">{created.secret}</code>
            <pre className="mb-0 mt-2 pre-dark p-2" style={{ whiteSpace: 'pre-wrap' }}>{`curl -X POST ${base}/api/v1/tasks \\\n  -H "Authorization: Bearer ${created.secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title": "Nouvelle tâche", "description": "…", "priority": "MEDIUM"}'`}</pre>
          </Alert>
        )}
        {keys.length > 0 && (
          <Table size="sm" className="mb-2 table-stack">
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>
                    <strong>{k.name}</strong> <code className="text-secondary">{k.prefix}…</code>
                  </td>
                  <td className="text-secondary">
                    créée {new Date(k.createdAt).toLocaleDateString()}
                    {k.createdBy && ` par ${k.createdBy.name}`} · {k.lastUsedAt ? `utilisée le ${new Date(k.lastUsedAt).toLocaleString()}` : 'jamais utilisée'}
                  </td>
                  <td className="text-end">
                    <Button
                      size="sm"
                      variant="link"
                      className="p-0 text-danger"
                      onClick={async () => {
                        if (await confirm({ title: 'Révoquer la clé', message: `Révoquer la clé « ${k.name} » ? Les outils qui l'utilisent n'auront plus accès.`, confirmLabel: 'Révoquer', danger: true })) remove({ variables: { id: k.id } });
                      }}
                    >
                      Révoquer
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Button
          size="sm"
          variant="outline-secondary"
          onClick={async () => {
            const name = await prompt({ title: "Nouvelle clé d'API", message: 'Nom de la clé, pour la reconnaître (ex. le nom de l’outil qui l’utilisera).', placeholder: 'Formulaire site web', confirmLabel: 'Créer' });
            if (!name) return;
            const res = await create({ variables: { projectId, name } });
            if (res.data) setCreated({ name, secret: res.data.createProjectApiKey.secret });
          }}
        >
          <i className="bi bi-key me-1" /> Nouvelle clé
        </Button>
      </Card.Body>
    </Card>
  );
}

type ProjectWithSessions = Project & { sessions: Session[] };

export default function ProjectDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, loading, error } = usePollingQuery<{ project: ProjectWithSessions | null }>(PROJECT, { variables: { id }, pollInterval: 3000 });
  useTabTitle(data?.project?.name);
  useGitTarget(data?.project?.gitUrl ? { projectId: data.project.id, worksessionId: null, label: data.project.name } : null);
  const [prepareWorkspace, { loading: preparing, error: prepareError }] = useMutation(PREPARE_PROJECT_WORKSPACE);
  const { confirm } = useDialogs();
  const [deleteProject, { error: deleteError }] = useMutation(DELETE_PROJECT, {
    refetchQueries: [{ query: PROJECTS }],
    onCompleted: () => navigate('/projects'),
  });

  if (loading && !data) return <ProjectPageLoading id={id} />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const project = data?.project;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const actionError = prepareError ?? deleteError;
  const isAdmin = project.myRole === 'ADMIN';
  const canWrite = isAdmin || project.myRole === 'MEMBER';
  // Espace personnel : ni membres, ni clés d'API, ni suppression (il n'appartient qu'à la personne).
  const personal = project.isPersonal;

  return (
    <>
      <ProjectHeader
        project={project}
        active="overview"
        actions={
          isAdmin && !personal && (
            <Button
              size="sm"
              variant="outline-danger"
              onClick={async () => {
                if (await confirm({ title: 'Supprimer le projet', message: `Supprimer le projet « ${project.name} » ? Ses sessions (arrêtées), terminaux, work sessions, son conteneur et son dossier de travail seront supprimés. Irréversible.`, confirmLabel: 'Supprimer définitivement', danger: true })) {
                  deleteProject({ variables: { id } });
                }
              }}
            >
              Supprimer
            </Button>
          )
        }
      />

      {actionError && <Alert variant="danger">{actionError.message}</Alert>}

      <Row className="g-3 mb-4">
        <Col md={5}>
          <Card className="h-100">
            <Card.Header>Dossier de travail</Card.Header>
            <Card.Body className="small">
              <dl className="row mb-0">
                <dt className="col-4">Identifiant</dt>
                <dd className="col-8">
                  <code>{project.slug}</code>
                </dd>
                <dt className="col-4">Emplacement</dt>
                <dd className="col-8 text-break">
                  <code>{project.workspacePath}</code>
                </dd>
                <dt className="col-4">État</dt>
                <dd className="col-8">
                  {project.workspaceExists && project.gitUrl && !project.git ? (
                    <>
                      <span className="text-warning">dépôt non récupéré</span>{' '}
                      <Button size="sm" variant="outline-primary" className="ms-2" disabled={preparing} onClick={() => prepareWorkspace({ variables: { id } })}>
                        {preparing ? 'Récupération…' : 'Récupérer le dépôt'}
                      </Button>
                      <div className="text-secondary mt-1">Le dossier existe mais ne contient pas le dépôt. S'il est vide, la récupération le clone.</div>
                    </>
                  ) : project.workspaceExists ? (
                    <span className="text-success">prêt</span>
                  ) : (
                    <>
                      <span className="text-warning">absent</span>{' '}
                      {isAdmin && (
                        <Button size="sm" variant="outline-primary" className="ms-2" disabled={preparing} onClick={() => prepareWorkspace({ variables: { id } })}>
                          {preparing ? 'Création…' : 'Créer le dossier'}
                        </Button>
                      )}
                    </>
                  )}
                </dd>
                <dt className="col-4">Dépôt git</dt>
                <dd className="col-8 text-break">{project.gitUrl ?? 'aucun'}</dd>
                <dt className="col-4">Branche</dt>
                <dd className="col-8">
                  {project.git ? (
                    <>
                      {project.git.branch} <span className="text-secondary">@ {project.git.commit}</span>
                    </>
                  ) : (
                    project.gitBranch ?? '—'
                  )}
                </dd>
              </dl>
            </Card.Body>
          </Card>
        </Col>
        <Col md={7}>
          <Card className="h-100">
            <Card.Header>Instructions permanentes pour les agents</Card.Header>
            <Card.Body>
              <div className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: '30vh', overflow: 'auto' }}>
                {project.systemPrompt || <span className="text-secondary">Aucune instruction permanente. Ajoutez-en via « Modifier » : conventions, contexte métier, ce qu'il ne faut pas faire…</span>}
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {!personal && <MembersCard projectId={project.id} canManage={isAdmin} />}
      <PermissionRulesCard projectId={project.id} canManage={canWrite} />
      <RunnerCard project={project} />
      {isAdmin && !personal && <ApiKeysCard projectId={project.id} />}

      <h2 className="h5 mt-4">Sessions</h2>
      <Table hover responsive size="sm" className="align-middle">
        <thead>
          <tr>
            <th>Nom</th>
            <th className="d-none d-md-table-cell">Type</th>
            <th>Statut</th>
            <th className="d-none d-md-table-cell">Branche</th>
            <th>Créée</th>
          </tr>
        </thead>
        <tbody>
          {project.sessions.length === 0 && (
            <tr>
              <td colSpan={5} className="text-secondary">
                Aucune session pour ce projet.
              </td>
            </tr>
          )}
          {project.sessions.map((s) => (
            <tr key={s.id}>
              <td>
                <Link to={`/sessions/${s.id}`}>{s.name}</Link>
              </td>
              <td className="d-none d-md-table-cell">
                <code>{s.provider}</code>
              </td>
              <td>
                <StatusBadge status={s.status} pendingRequests={s.pendingRequestCount} />
              </td>
              <td className="text-secondary small d-none d-md-table-cell font-monospace">{s.worksession ? s.worksession.branch : '—'}</td>
              <td className="text-secondary small">{new Date(s.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
