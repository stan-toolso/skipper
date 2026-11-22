import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap';
import { useAuth } from '../auth/AuthContext';
import { CREATE_TASK, UPDATE_TASK, type Task, type TaskField, type TaskPerson, type TaskPriority, type TaskRef, type TaskStatus, type TaskStatusDefinition } from '../graphql/operations';
import { PROJECT_TASK_STATUSES, TASK_DEPENDENCY_CHOICES, TASK_PEOPLE, TASK_PROJECT_MEMBERS, TASK_TAGS } from '../graphql/tasks';
import { DEFAULT_TASK_STATUSES, defaultStatusOf } from '../lib/taskStatuses';
import { canAutoFocus } from '../lib/device';
import { taskPriorityLabels } from '../lib/humanize';
import { toAttachmentInputs, usePendingAttachments } from '../lib/attachments';
import AttachmentChips from './AttachmentChips';
import TagsInput from './TagsInput';
import { TaskStatusBadge } from './TaskBadges';
import TaskAttachments from './TaskAttachments';
import DictationButton from './DictationButton';
import TaskThread from './TaskThread';

/** Longueur maximale du résumé (comme le serveur, tasks/service.ts). */
const SUMMARY_MAX = 500;

const priorities: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

interface TaskForm {
  title: string;
  summary: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** Statut du projet (clé) ; vide : le statut par défaut de la catégorie. */
  state: string;
  statusTag: string;
  tags: string[];
  dueDate: string;
  assignee: { name: string; email: string };
  reporter: { name: string; email: string };
  customFields: TaskField[];
  dependsOn: TaskRef[];
  autoStart: boolean;
}

const personForm = (p: TaskPerson | null | undefined) => ({ name: p?.name ?? '', email: p?.email ?? '' });
const personInput = (p: { name: string; email: string }) => (p.name.trim() || p.email.trim() ? { name: p.name.trim() || null, email: p.email.trim() || null } : null);

function PersonFields({ label, value, onChange, people, members }: { label: string; value: { name: string; email: string }; onChange: (v: { name: string; email: string }) => void; people: TaskPerson[]; members: TaskPerson[] }) {
  const { user } = useAuth();
  const isMe = user && value.email.trim().toLowerCase() === user.email;
  const listId = `people-${label}`;
  // Choisir un e-mail connu remplit le nom, et inversement.
  const pickEmail = (email: string) => {
    const known = people.find((p) => p.email === email);
    onChange({ email, name: value.name || known?.name || '' });
  };
  const pickName = (name: string) => {
    const known = people.find((p) => p.name === name);
    onChange({ name, email: value.email || known?.email || '' });
  };
  return (
    <Col sm={6}>
      <Form.Label className="d-flex justify-content-between">
        {label}
        {user && !isMe && (
          <button type="button" className="btn btn-link btn-sm p-0 small" onClick={() => onChange({ name: user.name, email: user.email })}>
            moi
          </button>
        )}
      </Form.Label>
      {members.length > 0 && (
        <Form.Select
          size="sm"
          className="mb-1"
          aria-label={`${label} : membre du projet`}
          value={members.find((m) => m.email && m.email.toLowerCase() === value.email.trim().toLowerCase())?.email ?? ''}
          onChange={(e) => {
            const m = members.find((x) => x.email === e.target.value);
            onChange(m ? personForm(m) : { name: '', email: '' });
          }}
        >
          <option value="">{value.name || value.email ? 'Autre personne (ci-dessous)' : 'Choisir un membre…'}</option>
          {members.map((m) => (
            <option key={m.email} value={m.email!}>
              {m.name ? `${m.name} <${m.email}>` : m.email}
            </option>
          ))}
        </Form.Select>
      )}
      <div className="d-flex gap-1">
        <Form.Control size="sm" placeholder="Nom" value={value.name} list={`${listId}-names`} onChange={(e) => pickName(e.target.value)} />
        <Form.Control size="sm" placeholder="E-mail" type="email" value={value.email} list={`${listId}-emails`} onChange={(e) => pickEmail(e.target.value)} />
      </div>
      <datalist id={`${listId}-names`}>
        {[...new Set(people.map((p) => p.name).filter(Boolean))].map((n) => (
          <option key={n!} value={n!} />
        ))}
      </datalist>
      <datalist id={`${listId}-emails`}>
        {[...new Set(people.map((p) => p.email).filter(Boolean))].map((e) => (
          <option key={e!} value={e!} />
        ))}
      </datalist>
    </Col>
  );
}

/**
 * « Bloquée par » : les tâches du projet dont celle-ci dépend (puces retirables, liste pour en ajouter), et l'option de
 * lancement automatique quand la dernière se termine. Les cycles sont refusés par le serveur (message dans la fenêtre).
 */
function DependencyFields({ projectId, taskId, value, autoStart, onChange, onAutoStart }: { projectId: string; taskId: string | null; value: TaskRef[]; autoStart: boolean; onChange: (v: TaskRef[]) => void; onAutoStart: (v: boolean) => void }) {
  const { data } = useQuery<{ tasks: TaskRef[] }>(TASK_DEPENDENCY_CHOICES, { variables: { projectId }, skip: !projectId });
  const choices = (data?.tasks ?? []).filter((t) => t.id !== taskId && !value.some((v) => v.id === t.id));
  const open = choices.filter((t) => t.status !== 'DONE');
  const done = choices.filter((t) => t.status === 'DONE');
  const waiting = value.some((t) => t.status !== 'DONE');
  return (
    <div className="mb-3">
      <Form.Label htmlFor="task-depends-on">Bloquée par</Form.Label>
      {value.length > 0 && (
        <div className="d-flex flex-wrap gap-1 mb-1">
          {value.map((t) => (
            <span key={t.id} className="task-tag d-inline-flex align-items-center gap-1">
              <TaskStatusBadge status={t.status} />
              {t.title}
              <button type="button" className="btn btn-link btn-sm p-0 text-secondary" title="Retirer cette dépendance" aria-label={`Retirer « ${t.title} »`} onClick={() => onChange(value.filter((x) => x.id !== t.id))}>
                <i className="bi bi-x" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Form.Select
        id="task-depends-on"
        size="sm"
        value=""
        onChange={(e) => {
          const t = choices.find((c) => c.id === e.target.value);
          if (t) onChange([...value, t]);
        }}
      >
        <option value="">{choices.length ? 'Ajouter une tâche dont celle-ci dépend…' : 'Aucune autre tâche dans le projet'}</option>
        {open.length > 0 && (
          <optgroup label="Ouvertes">
            {open.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </optgroup>
        )}
        {done.length > 0 && (
          <optgroup label="Terminées">
            {done.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </optgroup>
        )}
      </Form.Select>
      <Form.Text>Tant qu'une de ces tâches n'est pas terminée, celle-ci ne peut pas être confiée à un agent.</Form.Text>
      <Form.Check
        id="task-auto-start"
        className="mt-1"
        type="switch"
        disabled={!waiting}
        checked={autoStart && waiting}
        onChange={(e) => onAutoStart(e.target.checked)}
        label="Lancer automatiquement quand elle est débloquée"
      />
      <Form.Text>{waiting ? 'Quand la dernière dépendance passe à « terminée », une session est lancée à votre nom avec la configuration par défaut du projet, et vous êtes notifié.' : 'Possible quand au moins une dépendance reste à terminer.'}</Form.Text>
    </div>
  );
}

/** Fenêtre de création / édition d'une tâche : titre, description, priorité, statut, échéance, personnes, champs libres, commentaires. */
/**
 * Création ou modification d'une tâche. À la création, `projects` (ceux où l'on peut écrire) ajoute le choix du
 * projet, `projectId` n'étant alors que celui proposé par défaut (tableau de bord général, liste de tous les projets).
 */
export default function TaskModal({ task, projectId: initialProjectId, projects, onClose }: { task: Task | null; projectId: string; projects?: { id: string; name: string }[]; onClose: () => void }) {
  const { user } = useAuth();
  const [projectId, setProjectId] = useState(initialProjectId);
  const chooseProject = !task && projects && projects.length > 1;
  // Une nouvelle tâche est rapportée par sa créatrice ou son créateur, et lui est assignée, sauf changement.
  const me: TaskPerson | null = user ? { name: user.name, email: user.email } : null;
  const [form, setForm] = useState<TaskForm>({
    title: task?.title ?? '',
    summary: task?.summary ?? '',
    description: task?.description ?? '',
    priority: task?.priority ?? 'MEDIUM',
    status: task?.status ?? 'TODO',
    state: task?.state ?? '',
    statusTag: task?.statusTag ?? '',
    tags: task?.tags ?? [],
    dueDate: task?.dueDate ?? '',
    assignee: personForm(task ? task.assignee : me),
    reporter: personForm(task ? task.reporter : me),
    customFields: task?.customFields.map((f) => ({ key: f.key, value: f.value })) ?? [],
    dependsOn: task?.dependsOn ?? [],
    autoStart: task?.autoStartWhenUnblocked ?? false,
  });
  const { data: statusesData } = useQuery<{ project: { id: string; taskStatuses: TaskStatusDefinition[] } | null }>(PROJECT_TASK_STATUSES, { variables: { id: projectId }, skip: !projectId });
  const statuses = statusesData?.project?.taskStatuses?.length ? statusesData.project.taskStatuses : DEFAULT_TASK_STATUSES;
  const currentState = statuses.find((st) => st.key === form.state && st.category === form.status) ?? defaultStatusOf(statuses, form.status);
  const { data: peopleData } = useQuery<{ taskPeople: TaskPerson[] }>(TASK_PEOPLE, { variables: { projectId }, skip: !projectId });
  const people = peopleData?.taskPeople ?? [];
  const { data: tagsData } = useQuery<{ taskTags: string[] }>(TASK_TAGS, { variables: { projectId }, skip: !projectId });
  const { data: membersData } = useQuery<{ project: { members: { pending: boolean; user: { name: string | null; email: string } }[] } | null }>(TASK_PROJECT_MEMBERS, { variables: { id: projectId }, skip: !projectId });
  const members: TaskPerson[] = (membersData?.project?.members ?? []).filter((m) => !m.pending).map((m) => ({ name: m.user.name, email: m.user.email }));
  const refetch = { refetchQueries: ['Tasks', 'TaskDetail', 'TaskPage', 'Sidebar', 'Dashboard'] };
  const [createTask, { loading: creating, error: createError }] = useMutation(CREATE_TASK, { ...refetch, onCompleted: onClose });
  const [updateTask, { loading: updating, error: updateError }] = useMutation(UPDATE_TASK, { ...refetch, onCompleted: onClose });
  const files = usePendingAttachments();
  const [removedFiles, setRemovedFiles] = useState<string[]>([]);
  const [encoding, setEncoding] = useState(false);
  const error = createError ?? updateError;
  const set = (k: keyof TaskForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setField = (i: number, patch: Partial<TaskField>) => setForm((f) => ({ ...f, customFields: f.customFields.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let attachments = null;
    if (files.items.length) {
      setEncoding(true);
      attachments = await toAttachmentInputs(files.items).finally(() => setEncoding(false));
    }
    const input = {
      title: form.title,
      summary: form.summary.trim() || null,
      description: form.description,
      priority: form.priority,
      status: form.status,
      // Statut du projet choisi (un statut d'un autre projet, après un changement de projet, n'est pas envoyé).
      state: statuses.some((st) => st.key === form.state && st.category === form.status) && !(task && task.state === form.state && task.status === form.status) ? form.state : null,
      statusTag: form.statusTag.trim() || null,
      tags: form.tags,
      dueDate: form.dueDate || null,
      customFields: form.customFields.map((f) => ({ key: f.key, value: f.value })),
      assignee: personInput(form.assignee),
      reporter: personInput(form.reporter),
      attachments,
    };
    // Dépendances et lancement automatique envoyés seulement s'ils changent : réarmer l'option la mettrait au nom de qui enregistre.
    const ids = form.dependsOn.map((t) => t.id);
    const autoStart = form.autoStart && form.dependsOn.some((t) => t.status !== 'DONE');
    if (!task || ids.join() !== task.dependsOn.map((t) => t.id).join()) Object.assign(input, { dependsOnIds: ids });
    if (task ? autoStart !== task.autoStartWhenUnblocked : autoStart) Object.assign(input, { autoStartWhenUnblocked: autoStart });
    if (task) updateTask({ variables: { id: task.id, input: { ...input, removeAttachmentIds: removedFiles.length ? removedFiles : null } } });
    else createTask({ variables: { input: { ...input, projectId } } });
  };

  return (
    <Modal show onHide={onClose} centered size={task ? 'lg' : undefined}>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">{task ? 'Modifier la tâche' : 'Nouvelle tâche'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {chooseProject && (
            <Form.Group className="mb-3">
              <Form.Label htmlFor="task-project">Projet</Form.Label>
              <Form.Select id="task-project" value={projectId} onChange={(e) => {
                setProjectId(e.target.value);
                setForm((f) => ({ ...f, dependsOn: [], autoStart: false }));
              }} required>
                {!projects.some((p) => p.id === projectId) && <option value="">Choisir un projet…</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          )}
          <Form.Group className="mb-3">
            <Form.Label>Titre</Form.Label>
            <Form.Control autoFocus={canAutoFocus()} value={form.title} onChange={set('title')} required placeholder="Ex. Ajouter la page de contact" />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label htmlFor="task-summary">Résumé</Form.Label>
            <Form.Control
              id="task-summary"
              as="textarea"
              rows={2}
              maxLength={SUMMARY_MAX}
              value={form.summary}
              onChange={set('summary')}
              placeholder="L'objet de la tâche en une ou deux phrases : ce qu'il faut obtenir et pourquoi."
            />
            <Form.Text>Affiché avant la description, pour comprendre la tâche d'un coup d'œil.</Form.Text>
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label>Description</Form.Label>
            <div className="dictation-field">
              <Form.Control
                as="textarea"
                rows={5}
                value={form.description}
                onChange={set('description')}
                onPaste={files.onPaste}
                onDrop={files.onDrop}
                onDragOver={files.onDragOver}
                placeholder="Ce qu'il faut faire, comment savoir que c'est réussi, les pistes utiles… Collez une capture d'écran ou déposez des fichiers pour les joindre."
              />
              <DictationButton value={form.description} onChange={(description) => setForm((f) => ({ ...f, description }))} className="dictation-float" />
            </div>
            {task && <TaskAttachments taskId={task.id} attachments={task.attachments} removed={removedFiles} onToggleRemove={(id) => setRemovedFiles((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]))} />}
            <AttachmentChips items={files.items} onAdd={(f) => files.add(f)} onRemove={files.remove} error={files.error} />
            <Form.Text>Les fichiers joints sont transmis à l'agent à qui la tâche est confiée (il voit les images).</Form.Text>
          </Form.Group>
          <Row className="g-2 mb-3">
            <Col sm={4}>
              <Form.Label>Priorité</Form.Label>
              <Form.Select value={form.priority} onChange={set('priority')}>
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {taskPriorityLabels[p].label}
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col sm={4}>
              <Form.Label>Statut</Form.Label>
              <Form.Select
                value={currentState?.key ?? ''}
                title={currentState?.description ?? undefined}
                onChange={(e) => {
                  const st = statuses.find((x) => x.key === e.target.value);
                  if (st) setForm((f) => ({ ...f, state: st.key, status: st.category }));
                }}
              >
                {statuses.map((st) => (
                  <option key={st.key} value={st.key}>
                    {st.label}
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col sm={4}>
              <Form.Label>Échéance</Form.Label>
              <Form.Control type="date" value={form.dueDate} onChange={set('dueDate')} />
            </Col>
          </Row>
          <Row className="g-2 mb-3">
            <Col sm={4}>
              <Form.Label>Étiquette d'état</Form.Label>
              <Form.Control size="sm" maxLength={40} value={form.statusTag} onChange={set('statusTag')} placeholder="ex. en revue, bloquée" />
              <Form.Text>Où en est le travail dans son statut.</Form.Text>
            </Col>
            <Col sm={8}>
              <Form.Label htmlFor="task-tags-input">Étiquettes</Form.Label>
              <TagsInput id="task-tags-input" value={form.tags} onChange={(tags) => setForm((f) => ({ ...f, tags }))} suggestions={tagsData?.taskTags ?? []} />
            </Col>
          </Row>
          <Row className="g-2 mb-3">
            <PersonFields label="Responsable" value={form.assignee} onChange={(assignee) => setForm((f) => ({ ...f, assignee }))} people={people} members={members} />
            <PersonFields label="Rapporteur" value={form.reporter} onChange={(reporter) => setForm((f) => ({ ...f, reporter }))} people={people} members={members} />
          </Row>
          <DependencyFields
            projectId={projectId}
            taskId={task?.id ?? null}
            value={form.dependsOn}
            autoStart={form.autoStart}
            onChange={(dependsOn) => setForm((f) => ({ ...f, dependsOn }))}
            onAutoStart={(autoStart) => setForm((f) => ({ ...f, autoStart }))}
          />
          <div className="mb-2">
            <div className="d-flex justify-content-between align-items-center">
              <Form.Label className="mb-0">Champs personnalisés</Form.Label>
              <Button size="sm" variant="link" className="p-0" onClick={() => setForm((f) => ({ ...f, customFields: [...f.customFields, { key: '', value: '' }] }))}>
                <i className="bi bi-plus-lg" /> Ajouter un champ
              </Button>
            </div>
            <Form.Text>Paires clé / valeur libres : lien du ticket, environnement…</Form.Text>
            {form.customFields.map((f, i) => (
              <div key={i} className="d-flex gap-1 mt-1">
                <Form.Control size="sm" placeholder="Clé" value={f.key} style={{ width: '35%' }} onChange={(e) => setField(i, { key: e.target.value })} />
                <Form.Control size="sm" placeholder="Valeur" value={f.value} onChange={(e) => setField(i, { value: e.target.value })} />
                <Button size="sm" variant="link" className="text-secondary p-0 px-1" title="Retirer" onClick={() => setForm((x) => ({ ...x, customFields: x.customFields.filter((_, j) => j !== i) }))}>
                  <i className="bi bi-x-lg" />
                </Button>
              </div>
            ))}
          </div>
          {task && (
            <div className="mt-3">
              <Form.Label>Fil de discussion</Form.Label>
              <TaskThread taskId={task.id} compact />
            </div>
          )}
          {error && (
            <Alert variant="danger" className="mt-3 mb-0">
              {error.message}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={creating || updating || encoding || !form.title.trim() || !projectId}>
            {task ? 'Enregistrer' : 'Créer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
