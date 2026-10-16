import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap';
import { useAuth } from '../auth/AuthContext';
import { CREATE_TASK, UPDATE_TASK, type Task, type TaskField, type TaskPerson, type TaskPriority, type TaskStatus } from '../graphql/operations';
import { TASK_PEOPLE, TASK_PROJECT_MEMBERS, TASK_TAGS } from '../graphql/tasks';
import { canAutoFocus } from '../lib/device';
import { taskPriorityLabels, taskStatusLabels } from '../lib/humanize';
import { toAttachmentInputs, usePendingAttachments } from '../lib/attachments';
import AttachmentChips from './AttachmentChips';
import TagsInput from './TagsInput';
import TaskAttachments from './TaskAttachments';
import TaskComments from './TaskComments';

const priorities: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

interface TaskForm {
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  statusTag: string;
  tags: string[];
  dueDate: string;
  assignee: { name: string; email: string };
  reporter: { name: string; email: string };
  customFields: TaskField[];
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

/** Fenêtre de création / édition d'une tâche : titre, description, priorité, statut, échéance, personnes, champs libres, commentaires. */
export default function TaskModal({ task, projectId, onClose }: { task: Task | null; projectId: string; onClose: () => void }) {
  const { user } = useAuth();
  // Une nouvelle tâche est rapportée par sa créatrice ou son créateur, et lui est assignée, sauf changement.
  const me: TaskPerson | null = user ? { name: user.name, email: user.email } : null;
  const [form, setForm] = useState<TaskForm>({
    title: task?.title ?? '',
    description: task?.description ?? '',
    priority: task?.priority ?? 'MEDIUM',
    status: task?.status ?? 'TODO',
    statusTag: task?.statusTag ?? '',
    tags: task?.tags ?? [],
    dueDate: task?.dueDate ?? '',
    assignee: personForm(task ? task.assignee : me),
    reporter: personForm(task ? task.reporter : me),
    customFields: task?.customFields.map((f) => ({ key: f.key, value: f.value })) ?? [],
  });
  const { data: peopleData } = useQuery<{ taskPeople: TaskPerson[] }>(TASK_PEOPLE, { variables: { projectId } });
  const people = peopleData?.taskPeople ?? [];
  const { data: tagsData } = useQuery<{ taskTags: string[] }>(TASK_TAGS, { variables: { projectId } });
  const { data: membersData } = useQuery<{ project: { members: { pending: boolean; user: { name: string | null; email: string } }[] } | null }>(TASK_PROJECT_MEMBERS, { variables: { id: projectId }, skip: !projectId });
  const members: TaskPerson[] = (membersData?.project?.members ?? []).filter((m) => !m.pending).map((m) => ({ name: m.user.name, email: m.user.email }));
  const refetch = { refetchQueries: ['Tasks', 'TaskDetail', 'TaskPage', 'Sidebar'] };
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
      description: form.description,
      priority: form.priority,
      status: form.status,
      statusTag: form.statusTag.trim() || null,
      tags: form.tags,
      dueDate: form.dueDate || null,
      customFields: form.customFields.map((f) => ({ key: f.key, value: f.value })),
      assignee: personInput(form.assignee),
      reporter: personInput(form.reporter),
      attachments,
    };
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
          <Form.Group className="mb-3">
            <Form.Label>Titre</Form.Label>
            <Form.Control autoFocus={canAutoFocus()} value={form.title} onChange={set('title')} required placeholder="Ex. Ajouter la page de contact" />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label>Description</Form.Label>
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
              <Form.Select value={form.status} onChange={set('status')}>
                {(Object.keys(taskStatusLabels) as TaskStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {taskStatusLabels[s]}
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
              <Form.Label>Commentaires</Form.Label>
              <TaskComments taskId={task.id} />
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
          <Button type="submit" disabled={creating || updating || encoding || !form.title.trim()}>
            {task ? 'Enregistrer' : 'Créer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
