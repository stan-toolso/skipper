import { ApolloProvider, useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Nav, Row, Table } from 'react-bootstrap';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { createActAsClient } from '../apollo';
import AgentAvatar from '../components/AgentAvatar';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import { AGENT, AGENT_ACTIVITY, DELETE_AGENT, SET_AGENT_DELEGATION, SET_AGENT_ENABLED, SET_AGENT_MANAGERS, UPDATE_AGENT, agentKindLabels, type Agent, type AgentActionInput, type AgentActivityData, type AgentKind, type AgentManagerRole } from '../graphql/agents';
import { useAuth } from '../auth/AuthContext';
import CockpitBoard, { CustomizeButton } from '../cockpit/CockpitBoard';
import type { CockpitContext } from '../cockpit/registry';
import { useCockpit } from '../cockpit/useCockpit';
import { PROJECT_MEMBERS, PROVIDERS, type ProjectMember, type Provider } from '../graphql/operations';
import { formatCost, sessionStatusLabels, taskStatusLabels, timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import { AgentActionsMenu, SummonAgentModal } from './ProjectAgentsPage';
import { AgentAccountSettings } from './SettingsPage';

type Section = 'profile' | 'accounts' | 'activity';

const KINDS: AgentKind[] = ['PRODUCT_MANAGER', 'DEVELOPER', 'CUSTOM'];

/** Types de session qu'un agent peut jouer (le terminal n'en est pas un). */
const AGENT_PROVIDERS = ['claude', 'opencode'];

interface ActionDraft extends AgentActionInput {
  key: string;
}

/** Formulaire du profil : identité, instructions, dossier de travail, réglages par défaut, déclencheurs, actions. */
function ProfileForm({ agent }: { agent: Agent }) {
  const { showError } = useDialogs();
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const providers = (providersData?.providers ?? []).filter((p) => AGENT_PROVIDERS.includes(p.type));
  const [providerType, setProviderType] = useState(String(agent.defaults.provider ?? '') || 'claude');
  const provider = providers.find((p) => p.type === providerType) ?? providers.find((p) => p.type === 'claude');
  const modeOptions = provider?.configFields.find((f) => f.key === 'permissionMode')?.options ?? [];
  const [name, setName] = useState(agent.name);
  const [kind, setKind] = useState<AgentKind>(agent.kind);
  const [emoji, setEmoji] = useState(agent.avatar.emoji ?? '');
  const [color, setColor] = useState(agent.avatar.color ?? '');
  const [description, setDescription] = useState(agent.description);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [taskFolder, setTaskFolder] = useState(agent.taskFolder);
  const [inheritContext, setInheritContext] = useState(agent.inheritContext);
  const [permissionMode, setPermissionMode] = useState(String(agent.defaults.permissionMode ?? ''));
  const [model, setModel] = useState(String(agent.defaults.model ?? ''));
  const [allowedTools, setAllowedTools] = useState(String(agent.defaults.allowedTools ?? ''));
  const [allowedModels, setAllowedModels] = useState<string[]>(agent.allowedModels);
  const [otherModel, setOtherModel] = useState('');
  // Modèles proposés par le type de session choisi (ceux de vos réglages), plus ceux déjà retenus pour l'agent.
  const modelOptions = useMemo(() => {
    const listed = (provider?.configFields.find((f) => f.key === 'model')?.options ?? []).filter((o) => o.value);
    const extra = [...allowedModels, model].filter((v) => v && !listed.some((o) => o.value === v)).map((v) => ({ value: v, label: v }));
    return [...listed, ...extra.filter((o, i) => extra.findIndex((x) => x.value === o.value) === i)];
  }, [provider, allowedModels, model]);
  const toggleAllowed = (value: string, on: boolean) => {
    setAllowedModels((list) => (on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value)));
    if (!on && model === value) setModel('');
  };
  const addOtherModel = () => {
    const v = otherModel.trim();
    if (v) toggleAllowed(v, true);
    setOtherModel('');
  };
  const defaultModelChoices = allowedModels.length ? modelOptions.filter((o) => allowedModels.includes(o.value)) : modelOptions;
  const [triggers, setTriggers] = useState(agent.triggers);
  const [actions, setActions] = useState<ActionDraft[]>(agent.actions.map((a) => ({ key: a.key, label: a.label, instruction: a.instruction, cron: a.cron, timezone: a.timezone })));
  const [saved, setSaved] = useState(false);
  const [update, { loading, error }] = useMutation(UPDATE_AGENT, { refetchQueries: ['Agent', 'ProjectAgents', 'Sidebar'] });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const defaults: Record<string, unknown> = { ...agent.defaults };
    for (const [k, v] of Object.entries({ provider: providerType, permissionMode, model, allowedTools })) {
      if (v.trim()) defaults[k] = v.trim();
      else delete defaults[k];
    }
    try {
      await update({
        variables: {
          id: agent.id,
          input: {
            name,
            kind,
            avatar: { emoji: emoji || null, color: color || null },
            description,
            instructions,
            taskFolder,
            inheritContext,
            defaults,
            allowedModels,
            triggers: { taskCreated: triggers.taskCreated, taskCreatedTag: triggers.taskCreatedTag, threadFollowed: triggers.threadFollowed, prMerged: triggers.prMerged, deployed: triggers.deployed, taskReady: triggers.taskReady, taskReadyTag: triggers.taskReadyTag },
            actions: actions.map((a) => ({ key: a.key || null, label: a.label, instruction: a.instruction, cron: a.cron || null, timezone: a.timezone || null })),
          },
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      void showError(err);
    }
  };
  const setTrigger = <K extends keyof Agent['triggers']>(k: K, v: Agent['triggers'][K]) => setTriggers((t) => ({ ...t, [k]: v }));
  const setAction = (i: number, patch: Partial<ActionDraft>) => setActions((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  return (
    <Form onSubmit={submit}>
      <Row className="g-3">
        <Col lg={6}>
          <Card className="mb-3">
            <Card.Header>Identité</Card.Header>
            <Card.Body>
              <Row className="g-2">
                <Col sm={7}>
                  <Form.Group>
                    <Form.Label>Nom</Form.Label>
                    <Form.Control value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
                    <Form.Text>Alias de mention (@{name.trim() || 'Nom'}) ; unique parmi les membres du projet.</Form.Text>
                  </Form.Group>
                </Col>
                <Col sm={5}>
                  <Form.Group>
                    <Form.Label>Rôle</Form.Label>
                    <Form.Select value={kind} onChange={(e) => setKind(e.target.value as AgentKind)}>
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {agentKindLabels[k]}
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                </Col>
                <Col sm={4}>
                  <Form.Group>
                    <Form.Label>Emoji</Form.Label>
                    <Form.Control value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🧭" maxLength={8} />
                  </Form.Group>
                </Col>
                <Col sm={4}>
                  <Form.Group>
                    <Form.Label>Couleur</Form.Label>
                    <Form.Control type="color" value={color || '#6f42c1'} onChange={(e) => setColor(e.target.value)} title="Couleur de l'avatar" />
                  </Form.Group>
                </Col>
                <Col sm={4} className="d-flex align-items-end justify-content-center">
                  <AgentAvatar agent={{ name: name || agent.name, avatar: { emoji: emoji || null, color: color || null } }} size={38} />
                </Col>
                <Col xs={12}>
                  <Form.Group>
                    <Form.Label>Description</Form.Label>
                    <Form.Control value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="Une ligne : ce qu'il fait dans le projet." />
                  </Form.Group>
                </Col>
              </Row>
            </Card.Body>
          </Card>
          <Card className="mb-3">
            <Card.Header>Sessions</Card.Header>
            <Card.Body>
              <Form.Check
                type="switch"
                id="agent-task-folder"
                className="mb-2"
                checked={taskFolder}
                onChange={(e) => setTaskFolder(e.target.checked)}
                label="Travaille dans le dossier de la tâche (branche task/…), comme « Confier à un agent »"
              />
              <Form.Text className="d-block mb-3">Décoché : chaque session a son propre dossier à côté, reliée à la tâche sans en prendre la branche (un Product Manager, par exemple).</Form.Text>
              <Row className="g-2">
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label>Type de session par défaut</Form.Label>
                    <Form.Select value={providerType} onChange={(e) => setProviderType(e.target.value)}>
                      {(providers.length ? providers : [{ type: 'claude', label: 'Claude Code' }]).map((p) => (
                        <option key={p.type} value={p.type}>
                          {p.label}
                        </option>
                      ))}
                    </Form.Select>
                    <Form.Text>Celui de ses sessions lancées par une mention, un déclencheur ou une action ; proposé quand on lance une session en son nom.</Form.Text>
                  </Form.Group>
                </Col>
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label>Autorisations par défaut</Form.Label>
                    <Form.Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
                      <option value="">Celles du projet</option>
                      {modeOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                </Col>
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label>Modèle par défaut</Form.Label>
                    {defaultModelChoices.length ? (
                      <Form.Select value={model} onChange={(e) => setModel(e.target.value)}>
                        <option value="">{allowedModels.length ? `Le premier autorisé (${allowedModels[0]})` : `Celui de ses réglages ${provider?.label ?? 'Claude'}`}</option>
                        {defaultModelChoices.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Form.Select>
                    ) : (
                      <Form.Control value={model} onChange={(e) => setModel(e.target.value)} placeholder="Celui de ses réglages" />
                    )}
                  </Form.Group>
                </Col>
                <Col xs={12}>
                  <Form.Group>
                    <Form.Label>Modèles autorisés</Form.Label>
                    <div className="d-flex flex-wrap gap-3">
                      {modelOptions.map((o) => (
                        <Form.Check key={o.value} id={`agent-model-${o.value}`} checked={allowedModels.includes(o.value)} onChange={(e) => toggleAllowed(o.value, e.target.checked)} label={o.label} />
                      ))}
                    </div>
                    <div className="d-flex gap-2 mt-2" style={{ maxWidth: 420 }}>
                      <Form.Control
                        size="sm"
                        value={otherModel}
                        onChange={(e) => setOtherModel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addOtherModel();
                          }
                        }}
                        placeholder={providerType === 'opencode' ? 'Autre modèle (fournisseur/modèle)' : 'Autre modèle (identifiant)'}
                      />
                      <Button size="sm" variant="outline-secondary" onClick={addOtherModel} disabled={!otherModel.trim()}>
                        Ajouter
                      </Button>
                    </div>
                    <Form.Text>
                      {allowedModels.length
                        ? `Ses sessions n'utilisent que ${allowedModels.length > 1 ? 'ces modèles' : 'ce modèle'} : un autre est refusé au lancement, et une session dont le modèle n'est plus autorisé reprend le modèle par défaut.`
                        : 'Aucun coché : tous les modèles sont permis.'}
                    </Form.Text>
                  </Form.Group>
                </Col>
                <Col xs={12}>
                  <Form.Group>
                    <Form.Label>Outils pré-autorisés</Form.Label>
                    <Form.Control value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="Read,Edit,Bash(git:*),mcp__agents" />
                    <Form.Text>
                      Liste séparée par des virgules. <code>mcp__agents</code> lui permet de convoquer un autre agent sans demander.
                    </Form.Text>
                  </Form.Group>
                </Col>
              </Row>
            </Card.Body>
          </Card>
          <Card className="mb-3">
            <Card.Header>Déclencheurs</Card.Header>
            <Card.Body>
              <Form.Check type="switch" id="trg-created" checked={triggers.taskCreated} onChange={(e) => setTrigger('taskCreated', e.target.checked)} label="Intervient sur toute tâche créée par une personne (ou par l'API)" />
              {triggers.taskCreated && (
                <Form.Control size="sm" className="mt-1 mb-2 ms-4" style={{ maxWidth: 320 }} value={triggers.taskCreatedTag ?? ''} onChange={(e) => setTrigger('taskCreatedTag', e.target.value || null)} placeholder="Seulement avec l'étiquette… (vide : toutes)" />
              )}
              <Form.Check type="switch" id="trg-thread" className="mt-2" checked={triggers.threadFollowed} onChange={(e) => setTrigger('threadFollowed', e.target.checked)} label="Suit les fils où il est intervenu : une réponse humaine lui revient comme instruction" />
              <Form.Check type="switch" id="trg-merged" className="mt-2" checked={triggers.prMerged} onChange={(e) => setTrigger('prMerged', e.target.checked)} label="Est prévenu quand la pull request d'une tâche est fusionnée" />
              <Form.Check type="switch" id="trg-deployed" className="mt-2" checked={triggers.deployed} onChange={(e) => setTrigger('deployed', e.target.checked)} label="Est prévenu quand un déploiement met des tâches en production" />
              <Form.Check type="switch" id="trg-ready" className="mt-2" checked={triggers.taskReady} onChange={(e) => setTrigger('taskReady', e.target.checked)} label="Démarre sur une tâche qu'une personne passe à l'étiquette d'état…" />
              {triggers.taskReady && <Form.Control size="sm" className="mt-1 ms-4" style={{ maxWidth: 320 }} value={triggers.taskReadyTag ?? ''} onChange={(e) => setTrigger('taskReadyTag', e.target.value || null)} placeholder="prête" />}
            </Card.Body>
          </Card>
        </Col>
        <Col lg={6}>
          <Card className="mb-3">
            <Card.Header>Instructions</Card.Header>
            <Card.Body>
              <Form.Control as="textarea" rows={22} className="font-monospace small" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Qui il est, ce qu'il fait, comment il travaille, ce qu'il ne fait jamais…" />
              <Form.Text>Markdown, ajouté au prompt système de ses sessions après le prompt du projet.</Form.Text>
            </Card.Body>
          </Card>
          <Card className="mb-3">
            <Card.Header className="d-flex justify-content-between align-items-center">
              Contexte
              <Link to={`/projects/${agent.project.id}/context?library=${agent.id}`} className="small">
                <i className="bi bi-journal-text me-1" /> Ouvrir sa bibliothèque
              </Link>
            </Card.Header>
            <Card.Body>
              <p className="small text-secondary mb-2">
                {agent.name} a sa propre bibliothèque de contexte, distincte de celle du projet : sa mémoire durable (décisions, conventions, glossaire). Ses sessions y lisent et y écrivent par défaut ; toute session du projet peut la consulter et la modifier (outils <code>context</code>, paramètre <code>library</code>).
              </p>
              <Form.Check type="switch" id="agent-inherit-context" checked={inheritContext} onChange={(e) => setInheritContext(e.target.checked)} label="Hérite aussi de la bibliothèque de contexte du projet" />
              <Form.Text>Décoché : ses sessions ne reçoivent que sa bibliothèque (celle du projet reste lisible à la demande).</Form.Text>
            </Card.Body>
          </Card>
          <Card className="mb-3">
            <Card.Header className="d-flex justify-content-between align-items-center">
              Actions
              <Button size="sm" variant="outline-secondary" onClick={() => setActions((l) => [...l, { key: '', label: '', instruction: '', cron: null, timezone: null }])}>
                <i className="bi bi-plus-lg me-1" /> Ajouter
              </Button>
            </Card.Header>
            <Card.Body>
              {actions.length === 0 && <div className="small text-secondary">Instructions nommées, jouées à la demande (menu « Actions ») ou à heures fixes (cron : une session planifiée dédiée, à son nom).</div>}
              {actions.map((a, i) => (
                <div key={i} className="agent-action-row">
                  <Row className="g-2">
                    <Col sm={8}>
                      <Form.Control size="sm" value={a.label} onChange={(e) => setAction(i, { label: e.target.value })} placeholder="Libellé (Préparer une release)" required />
                    </Col>
                    <Col sm={4} className="text-end">
                      <Button size="sm" variant="outline-danger" onClick={() => setActions((l) => l.filter((_, j) => j !== i))}>
                        Retirer
                      </Button>
                    </Col>
                    <Col xs={12}>
                      <Form.Control size="sm" as="textarea" rows={3} value={a.instruction} onChange={(e) => setAction(i, { instruction: e.target.value })} placeholder="Instruction complète" required />
                    </Col>
                    <Col sm={6}>
                      <Form.Control size="sm" value={a.cron ?? ''} onChange={(e) => setAction(i, { cron: e.target.value })} placeholder="cron (0 9 * * 5) — vide : à la demande" />
                    </Col>
                    <Col sm={6}>
                      <Form.Control size="sm" value={a.timezone ?? ''} onChange={(e) => setAction(i, { timezone: e.target.value })} placeholder="Fuseau (Europe/Paris)" />
                    </Col>
                  </Row>
                  {agent.actions.find((x) => x.key === a.key)?.schedule && (
                    <div className="small text-secondary mt-1">
                      <i className="bi bi-alarm me-1" />
                      Planifiée : <Link to={`/projects/${agent.actions.find((x) => x.key === a.key)!.schedule!.project.id}/schedules?edit=${agent.actions.find((x) => x.key === a.key)!.schedule!.id}`}>{agent.actions.find((x) => x.key === a.key)!.schedule!.name}</Link>
                    </div>
                  )}
                </div>
              ))}
            </Card.Body>
          </Card>
        </Col>
      </Row>
      {error && <Alert variant="danger" className="py-2">{error.message}</Alert>}
      <div className="d-flex gap-2 align-items-center mb-4">
        <Button type="submit" disabled={loading || !name.trim()}>
          {loading ? 'Enregistrement…' : 'Enregistrer'}
        </Button>
        {saved && <span className="text-success small">Enregistré.</span>}
      </div>
    </Form>
  );
}

/** Niveaux d'accès d'un compte git prêté, du plus restreint au plus large. */
type GitAccess = 'read' | 'read_prs' | 'write' | 'write_merge';
const gitAccessOf = (readOnly: boolean, pullRequests: boolean, merge: boolean): GitAccess => (readOnly ? (pullRequests ? 'read_prs' : 'read') : merge ? 'write_merge' : 'write');
const GIT_ACCESS_OPTIONS: Record<GitAccess, { readOnly: boolean; pullRequests: boolean; merge: boolean }> = {
  read: { readOnly: true, pullRequests: false, merge: false },
  read_prs: { readOnly: true, pullRequests: true, merge: false },
  write: { readOnly: false, pullRequests: true, merge: false },
  write_merge: { readOnly: false, pullRequests: true, merge: true },
};
function gitAccessLabels(pr: string): Record<GitAccess, { label: string; hint: string }> {
  return {
    read: { label: 'Lecture seule', hint: `ni push, ni ${pr}` },
    read_prs: { label: `Lecture seule, ${pr}s permises`, hint: `Skipper pousse la branche de travail de l'agent et ouvre la ${pr} ; pas d'autre push` },
    write: { label: `Écriture (push et ${pr}s)`, hint: `l'agent pousse et ouvre des ${pr}s ; une fusion reste soumise à l'accord d'une personne` },
    write_merge: { label: `Écriture, fusion permise`, hint: `l'agent pousse, ouvre et fusionne les ${pr}s avec ce compte, sans demander d'accord` },
  };
}

/**
 * Délégation de comptes : la personne connectée peut prêter son propre compte Claude, son compte GitHub et/ou son compte
 * GitLab à l'agent, chacun séparément ; GitHub et GitLab avec un niveau d'accès : lecture seule (avec ou sans pull
 * requests), écriture, ou écriture avec fusion des pull requests sans accord. Un gestionnaire peut retirer une délégation.
 */
function DelegationCard({ agent }: { agent: Agent }) {
  const { user } = useAuth();
  const { showError } = useDialogs();
  const [setDelegation, { loading }] = useMutation(SET_AGENT_DELEGATION, { refetchQueries: ['Agent'] });
  const run = (account: 'CLAUDE' | 'GITHUB' | 'GITLAB', delegate: boolean, opts: { readOnly?: boolean; pullRequests?: boolean; merge?: boolean } = {}) =>
    void setDelegation({ variables: { id: agent.id, account, delegate, readOnly: opts.readOnly ?? null, pullRequests: opts.pullRequests ?? null, merge: opts.merge ?? null } }).catch(showError);
  const d = agent.delegations;
  const mine = (u: { id: string } | null) => Boolean(u && user && u.id === user.id);
  const prLabel = (account: 'GITHUB' | 'GITLAB') => (account === 'GITLAB' ? 'merge request' : 'pull request');
  const gitRow = (account: 'GITHUB' | 'GITLAB', label: string, lent: { id: string; name: string } | null, readOnly: boolean, pullRequests: boolean, merge: boolean) => {
    const labels = gitAccessLabels(prLabel(account));
    const access = gitAccessOf(readOnly, pullRequests, merge);
    return (
      <tr>
        <td>
          <strong>{label}</strong>
        </td>
        <td>
          {lent ? (
            <>
              Compte de <b>{lent.name}</b>
              {mine(lent) ? ' (vous)' : ''}, {labels[access].label.toLowerCase()} ({labels[access].hint})
              {mine(lent) && (
                <Form.Select
                  size="sm"
                  className="mt-1"
                  style={{ maxWidth: 360 }}
                  aria-label={`Accès du compte ${label} prêté`}
                  value={access}
                  disabled={loading}
                  onChange={(e) => run(account, true, GIT_ACCESS_OPTIONS[e.target.value as GitAccess])}
                >
                  {(Object.keys(GIT_ACCESS_OPTIONS) as GitAccess[]).map((k) => (
                    <option key={k} value={k}>
                      {labels[k].label}
                    </option>
                  ))}
                </Form.Select>
              )}
            </>
          ) : (
            <span className="text-secondary">
              Les comptes {label} propres de {agent.name} (ci-dessous)
            </span>
          )}
        </td>
        <td className="text-end">
          {lent ? (
            <Button size="sm" variant="outline-secondary" disabled={loading} onClick={() => run(account, false)}>
              Retirer
            </Button>
          ) : (
            <Button size="sm" variant="outline-primary" disabled={loading} title="En lecture seule d'abord : vous choisissez ensuite le niveau d'accès (écriture, fusion…)" onClick={() => run(account, true, GIT_ACCESS_OPTIONS.read)}>
              Prêter mon compte {label}
            </Button>
          )}
        </td>
      </tr>
    );
  };
  return (
    <Card className="mb-3">
      <Card.Header>Comptes prêtés</Card.Header>
      <Card.Body className="small">
        <p className="text-secondary">
          Plutôt que de régler des comptes propres à {agent.name}, vous pouvez lui prêter les vôtres, chacun séparément : ses sessions tournent alors avec votre compte Claude, votre compte GitHub et/ou votre compte GitLab (ces deux-là avec le niveau d'accès de votre choix : lecture seule, avec ou sans pull requests, écriture, ou écriture avec fusion des pull requests sans vous demander). Un dépôt hébergé par Skipper utilise toujours le compte de l'agent.
        </p>
        <Table size="sm" className="align-middle mb-0 table-stack">
          <tbody>
            <tr>
              <td style={{ width: 120 }}>
                <strong>Claude</strong>
              </td>
              <td>{d.claude ? <>Compte de <b>{d.claude.name}</b>{mine(d.claude) ? ' (vous)' : ''}</> : <span className="text-secondary">Les réglages Claude propres de {agent.name} (ci-dessous)</span>}</td>
              <td className="text-end" style={{ width: 240 }}>
                {d.claude ? (
                  <Button size="sm" variant="outline-secondary" disabled={loading} onClick={() => run('CLAUDE', false)}>
                    Retirer
                  </Button>
                ) : (
                  <Button size="sm" variant="outline-primary" disabled={loading} onClick={() => run('CLAUDE', true)}>
                    Prêter mon compte Claude
                  </Button>
                )}
              </td>
            </tr>
            {gitRow('GITHUB', 'GitHub', d.github, d.githubReadOnly, d.githubPullRequests, d.githubMerge)}
            {gitRow('GITLAB', 'GitLab', d.gitlab, d.gitlabReadOnly, d.gitlabPullRequests, d.gitlabMerge)}
          </tbody>
        </Table>
      </Card.Body>
    </Card>
  );
}

/** Propriétaire et gestionnaires : les personnes membres du projet qui règlent l'agent et répondent à ses demandes. */
function ManagersCard({ agent }: { agent: Agent }) {
  const { showError } = useDialogs();
  const { data } = useQuery<{ project: { members: (ProjectMember & { user: { kind?: 'PERSON' | 'AGENT' } })[] } | null }>(PROJECT_MEMBERS, { variables: { id: agent.project.id } });
  const members = (data?.project?.members ?? []).filter((m) => m.user.kind !== 'AGENT' && m.role !== 'VIEWER');
  const [roles, setRoles] = useState<Record<string, AgentManagerRole | ''>>({});
  useEffect(() => {
    const r: Record<string, AgentManagerRole | ''> = {};
    for (const m of agent.managers) r[m.user.id] = m.role;
    setRoles(r);
  }, [agent.managers]);
  const [save, { loading }] = useMutation(SET_AGENT_MANAGERS, { refetchQueries: ['Agent'] });
  const dirty = useMemo(() => members.some((m) => (roles[m.user.id] || '') !== (agent.managers.find((x) => x.user.id === m.user.id)?.role ?? '')), [members, roles, agent.managers]);
  const submit = () =>
    void save({ variables: { id: agent.id, managers: Object.entries(roles).filter(([, r]) => r).map(([userId, role]) => ({ userId, role })) } }).catch(showError);
  return (
    <Card className="mb-3">
      <Card.Header>Gestionnaires</Card.Header>
      <Card.Body className="small">
        <p className="text-secondary">Le propriétaire (une seule personne) crée l'agent, règle ses comptes et peut le retirer ; les gestionnaires le modifient et répondent à ses demandes. Les administrateurs du projet peuvent toujours le gérer.</p>
        <Table size="sm" className="align-middle mb-2">
          <tbody>
            {members.map((m) => (
              <tr key={m.user.id}>
                <td>
                  <strong>{m.user.name}</strong> <span className="text-secondary">{m.user.email}</span>
                </td>
                <td style={{ width: 180 }}>
                  {agent.canManage ? (
                    <Form.Select size="sm" value={roles[m.user.id] ?? ''} onChange={(e) => setRoles((r) => ({ ...r, [m.user.id]: e.target.value as AgentManagerRole | '' }))}>
                      <option value="">—</option>
                      <option value="OWNER">Propriétaire</option>
                      <option value="MANAGER">Gestionnaire</option>
                    </Form.Select>
                  ) : (
                    (roles[m.user.id] === 'OWNER' && 'Propriétaire') || (roles[m.user.id] === 'MANAGER' && 'Gestionnaire') || '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        {agent.canManage && (
          <Button size="sm" disabled={!dirty || loading} onClick={submit}>
            {loading ? 'Enregistrement…' : 'Enregistrer les gestionnaires'}
          </Button>
        )}
      </Card.Body>
    </Card>
  );
}

/** Onglet Activité : l'agencement `agent:<id>` (tuiles, sessions, tâches), composable par ses gestionnaires et l'agent lui-même. */
function ActivitySection({ agent }: { agent: Agent }) {
  const { data, loading } = usePollingQuery<AgentActivityData>(AGENT_ACTIVITY, { variables: { id: agent.id, limit: 50 }, pollInterval: 10_000 });
  const { user, costUnit } = useAuth();
  const cockpit = useCockpit(`agent:${agent.id}`);
  const ctx: CockpitContext = {
    kind: 'agent',
    viewer: user,
    showCostTile: costUnit === 'CREDIT' || Boolean(user?.isSuperAdmin),
    home: null,
    project: null,
    agent: { agent, sessions: data?.agent?.sessions ?? [], tasks: data?.agent?.tasks ?? [], loading },
    refetch: ['AgentActivity', 'Agent'],
  };
  return (
    <>
      {!cockpit.editing && (
        <div className="d-flex justify-content-end mb-2">
          <CustomizeButton cockpit={cockpit} />
        </div>
      )}
      {cockpit.layout ? <CockpitBoard cockpit={cockpit} ctx={ctx} scopeLabel={`la fiche de ${agent.name}`} /> : <div className="small text-secondary">Chargement…</div>}
    </>
  );
}

/** Fiche d'un agent : profil (modifiable par ses gestionnaires), ses comptes (Claude, OpenCode, GitHub, GitLab), son activité. */
export default function AgentPage() {
  const { id: projectId, agentId } = useParams<{ id: string; agentId: string }>();
  const navigate = useNavigate();
  const { confirm, showError } = useDialogs();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = (searchParams.get('section') as Section | null) ?? 'profile';
  const { data, loading, error } = usePollingQuery<{ agent: Agent | null }>(AGENT, { variables: { id: agentId }, pollInterval: 15_000 });
  const agent = data?.agent ?? null;
  const [talking, setTalking] = useState(false);
  const [setEnabled] = useMutation(SET_AGENT_ENABLED, { refetchQueries: ['Agent', 'ProjectAgents'] });
  const [remove] = useMutation(DELETE_AGENT, { refetchQueries: ['ProjectAgents', 'ProjectMembers', 'MyAgents', 'Sidebar'] });
  // Les comptes de l'agent se règlent avec un client GraphQL qui agit pour son compte (?actAs=) et son propre cache.
  const actAsClient = useMemo(() => (agentId ? createActAsClient(agentId) : null), [agentId]);
  useTabTitle(agent ? `${agent.name} · agent` : 'Agent');
  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!agent) return <Alert variant="warning">Agent introuvable.</Alert>;
  const canWrite = agent.project.myRole === 'ADMIN' || agent.project.myRole === 'MEMBER';
  const owner = agent.managers.find((m) => m.role === 'OWNER')?.user;
  return (
    <>
      <Link to={`/projects/${projectId}/agents`} className="small">
        ← Agents · {agent.project.name}
      </Link>
      <div className="agent-page-head mt-1">
        <AgentAvatar agent={agent} size={52} />
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <h1 className="h3 d-flex align-items-center gap-2 flex-wrap">
            {agent.name}
            <Badge bg="secondary" className="fw-normal">
              {agentKindLabels[agent.kind]}
            </Badge>
            {!agent.enabled && <Badge bg="warning" text="dark">en pause</Badge>}
            {agent.archivedAt && <Badge bg="danger">retiré</Badge>}
          </h1>
          <div className="text-secondary">
            {agent.description || 'Pas de description.'}
            {owner && <> · propriétaire : {owner.name}</>}
          </div>
        </div>
        <div className="d-flex gap-2 flex-wrap">
          {canWrite && (
            <Button size="sm" onClick={() => setTalking(true)} disabled={!agent.enabled || Boolean(agent.archivedAt)}>
              <i className="bi bi-chat-left-text me-1" /> Parler à {agent.name}
            </Button>
          )}
          {canWrite && <AgentActionsMenu agent={agent} />}
          {agent.canManage && !agent.archivedAt && (
            <Button size="sm" variant="outline-secondary" onClick={() => void setEnabled({ variables: { id: agent.id, enabled: !agent.enabled } }).catch(showError)}>
              <i className={`bi ${agent.enabled ? 'bi-pause-circle' : 'bi-play-circle'} me-1`} /> {agent.enabled ? 'Mettre en pause' : 'Reprendre'}
            </Button>
          )}
          {agent.canManage && !agent.archivedAt && (
            <Button
              size="sm"
              variant="outline-danger"
              onClick={async () => {
                if (await confirm({ title: "Retirer l'agent", message: `Retirer ${agent.name} du projet ? Il ne réagira plus à rien et ne pourra plus être mentionné ; ses sessions et son historique restent consultables.`, confirmLabel: 'Retirer', danger: true })) {
                  await remove({ variables: { id: agent.id } }).catch(showError);
                  navigate(`/projects/${projectId}/agents`);
                }
              }}
            >
              Retirer
            </Button>
          )}
        </div>
      </div>
      <Nav variant="tabs" activeKey={section} onSelect={(k) => setSearchParams({ section: k ?? 'profile' })} className="mb-3">
        <Nav.Item>
          <Nav.Link eventKey="profile">
            <i className="bi bi-person-badge me-1" /> Profil
          </Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="accounts">
            <i className="bi bi-key me-1" /> Comptes
          </Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="activity">
            <i className="bi bi-activity me-1" /> Activité
          </Nav.Link>
        </Nav.Item>
      </Nav>
      {section === 'profile' &&
        (agent.canManage ? (
          <>
            <ProfileForm key={agent.updatedAt} agent={agent} />
            <ManagersCard agent={agent} />
          </>
        ) : (
          <>
            <Card className="mb-3">
              <Card.Header>Instructions</Card.Header>
              <Card.Body>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  {agent.instructions || <span className="text-secondary">Aucune instruction.</span>}
                </div>
              </Card.Body>
            </Card>
            <ManagersCard agent={agent} />
          </>
        ))}
      {section === 'accounts' &&
        (agent.canManage && actAsClient ? (
          <>
            <DelegationCard agent={agent} />
            <ApolloProvider client={actAsClient}>
              <Alert variant="light" className="border small">
                Comptes propres de <b>{agent.name}</b>{agent.delegations.claude || agent.delegations.github || agent.delegations.gitlab ? ' (utilisés là où aucun compte n’est prêté)' : ''} : ses sessions tournent avec, sa consommation lui est imputée, ses commits et pull requests sont signés de lui. Ils se règlent comme les vôtres dans Paramètres ; les éléments de coffre créés ici lui appartiennent.
              </Alert>
              <AgentAccountSettings agentName={agent.name} />
            </ApolloProvider>
          </>
        ) : (
          <Alert variant="light" className="border small">
            Seuls les gestionnaires de l'agent et les administrateurs du projet voient et règlent ses comptes.
          </Alert>
        ))}
      {section === 'activity' && <ActivitySection agent={agent} />}
      {talking && <SummonAgentModal agent={agent} onClose={() => setTalking(false)} />}
    </>
  );
}
