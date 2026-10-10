import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap';
import { useAuth } from '../auth/AuthContext';
import { CREATE_TASK, UPDATE_TASK, type Task, type TaskField, type TaskPerson, type TaskPriority, type TaskStatus } from '../graphql/operations';
import { TASK_PEOPLE } from '../graphql/tasks';
import { canAutoFocus } from '../lib/device';
import { taskPriorityLabels, taskStatusLabels } from '../lib/humanize';
import TaskComments from './TaskComments';

const priorities: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

interface TaskForm {
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string;
  assignee: { name: string; email: string };
  reporter: { name: string; email: string };
  customFields: TaskField[];
}

const personForm = (p: TaskPerson | null | undefined) => ({ name: p?.name ?? '', email: p?.email ?? '' });
const personInput = (p: { name: string; email: string }) => (p.name.trim() || p.email.trim() ? { name: p.name.trim() || null, email: p.email.trim() || null } : null);

function PersonFields({ label, value, onChange, people }: { label: string; value: { name: string; email: string }; onChange: (v: { name: string; email: string }) => void; people: TaskPerson[] }) {
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
  const [form, setForm] = useState<TaskForm>({
    title: task?.title ?? '',
    description: task?.description ?? '',
    priority: task?.priority ?? 'MEDIUM',
    status: task?.status ?? 'TODO',
    dueDate: task?.dueDate ?? '',
    assignee: personForm(task?.assignee),
    reporter: personForm(task?.reporter),
    customFields: task?.customFields.map((f) => ({ key: f.key, value: f.value })) ?? [],
  });
  const { data: peopleData } = useQuery<{ taskPeople: TaskPerson[] }>(TASK_PEOPLE, { variables: { projectId } });
  const people = peopleData?.taskPeople ?? [];
  const refetch = { refetchQueries: ['Tasks', 'TaskDetail', 'TaskPage', 'Sidebar'] };
  const [createTask, { loading: creating, error: createError }] = useMutation(CREATE_TASK, { ...refetch, onCompleted: onClose });
  const [updateTask, { loading: updating, error: updateError }] = useMutation(UPDATE_TASK, { ...refetch, onCompleted: onClose });
  const error = createError ?? updateError;
  const set = (k: keyof TaskForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setField = (i: number, patch: Partial<TaskField>) => setForm((f) => ({ ...f, customFields: f.customFields.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const input = {
      title: form.title,
      description: form.description,
      priority: form.priority,
      status: form.status,
      dueDate: form.dueDate || null,
      customFields: form.customFields.map((f) => ({ key: f.key, value: f.value })),
      assignee: personInput(form.assignee),
      reporter: personInput(form.reporter),
    };
    if (task) updateTask({ variables: { id: task.id, input } });
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
            <Form.Control as="textarea" rows={5} value={form.description} onChange={set('description')} placeholder="Ce qu'il faut faire, comment savoir que c'est réussi, les pistes utiles…" />
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
            <PersonFields label="Responsable" value={form.assignee} onChange={(assignee) => setForm((f) => ({ ...f, assignee }))} people={people} />
            <PersonFields label="Rapporteur" value={form.reporter} onChange={(reporter) => setForm((f) => ({ ...f, reporter }))} people={people} />
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
          <Button type="submit" disabled={creating || updating || !form.title.trim()}>
            {task ? 'Enregistrer' : 'Créer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
