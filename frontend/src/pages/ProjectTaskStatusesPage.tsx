import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, Form, Table } from 'react-bootstrap';
import ProjectHeader, { type ProjectHeaderProject } from '../components/ProjectHeader';
import PageLoading from '../components/PageLoading';
import { useDialogs } from '../components/Dialogs';
import type { TaskStatus, TaskStatusDefinition } from '../graphql/operations';
import { PROJECT_TASK_STATUSES, UPDATE_PROJECT_TASK_STATUSES } from '../graphql/tasks';
import { TASK_CATEGORIES } from '../lib/taskStatuses';
import { useTabTitle } from '../workbench/TabsContext';

type Project = ProjectHeaderProject & { taskStatuses: TaskStatusDefinition[]; taskStatusesCustomized: boolean };
/** Ligne du formulaire : `key` vide pour un statut ajouté (le serveur la dérive du libellé). */
type Row = Omit<TaskStatusDefinition, 'description'> & { description: string; uid: number };

let nextUid = 1;
const toRows = (list: TaskStatusDefinition[]): Row[] => list.map((s) => ({ ...s, description: s.description ?? '', uid: nextUid++ }));

/**
 * Configuration › Statuts des tâches : les statuts du projet (nombre, libellés, ordre), chacun rangé dans une catégorie
 * (À faire, En cours, Terminée, Annulée) qui dit à Skipper ce qu'il signifie. L'ordre est celui des colonnes du kanban.
 */
export default function ProjectTaskStatusesPage() {
  const { id = '' } = useParams();
  const dialogs = useDialogs();
  const { data, loading, error } = useQuery<{ project: Project | null }>(PROJECT_TASK_STATUSES, { variables: { id } });
  const [save, { loading: saving }] = useMutation<{ updateProject: Pick<Project, 'id' | 'taskStatuses' | 'taskStatusesCustomized'> }>(UPDATE_PROJECT_TASK_STATUSES);
  const project = data?.project;
  useTabTitle(project ? `Statuts des tâches · ${project.name}` : 'Statuts des tâches');
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (project) setRows(toRows(project.taskStatuses));
  }, [project]);

  const canManage = project?.myRole === 'ADMIN';
  const initial = useMemo(() => JSON.stringify(toPayload(toRows(project?.taskStatuses ?? []))), [project]);
  const dirty = JSON.stringify(toPayload(rows)) !== initial;
  const missing = TASK_CATEGORIES.filter((c) => !rows.some((r) => r.category === c.value));

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;

  const update = (uid: number, patch: Partial<Row>) => {
    setSaved(false);
    setRows((list) =>
      list.map((r) => {
        if (r.uid === uid) return { ...r, ...patch };
        // Un seul statut par défaut par catégorie.
        const target = list.find((x) => x.uid === uid)!;
        if (patch.isDefault && r.category === (patch.category ?? target.category)) return { ...r, isDefault: false };
        return r;
      }),
    );
  };
  const move = (index: number, delta: number) => {
    setSaved(false);
    setRows((list) => {
      const next = [...list];
      const [r] = next.splice(index, 1);
      next.splice(index + delta, 0, r);
      return next;
    });
  };
  const remove = (uid: number) => {
    setSaved(false);
    setRows((list) => list.filter((r) => r.uid !== uid));
  };
  const add = () => {
    setSaved(false);
    setRows((list) => [...list, { key: '', label: '', category: 'IN_PROGRESS', description: '', attention: false, isDefault: false, uid: nextUid++ }]);
  };
  const submit = async (statuses: Row[] | null) => {
    try {
      await save({ variables: { id, statuses: statuses ? toPayload(statuses) : null } });
      setSaved(true);
    } catch (err) {
      void dialogs.showError(err);
    }
  };
  const reset = async () => {
    const ok = await dialogs.confirm({
      title: 'Revenir aux statuts par défaut',
      message: 'Le projet reprend les statuts par défaut de Skipper (À trier, À faire, En cours, À valider, Terminée, Annulée). Les tâches d’un statut qui disparaît prennent le statut par défaut de leur catégorie.',
      confirmLabel: 'Revenir aux statuts par défaut',
    });
    if (ok) await submit(null);
  };
  const removedInUse = project.taskStatuses.filter((s) => !rows.some((r) => r.key === s.key && r.category === s.category));

  return (
    <>
      <ProjectHeader project={project} active="taskStatuses" />
      <Card className="mb-3">
        <Card.Body>
          <p className="small text-secondary mb-2">
            Les statuts que prennent les tâches du projet, dans l’ordre des colonnes du kanban. Chacun appartient à une <strong>catégorie</strong>, qui dit à Skipper ce qu’il
            signifie : une tâche « À faire » ou « En cours » est ouverte et bloque celles qui en dépendent, « Terminée » les débloque, « Annulée » la range. Il faut au moins un statut par catégorie ; le statut
            <em> par défaut</em> d’une catégorie est celui que prend une tâche qui y entre sans précision (création, prise par un agent, fin du travail).
          </p>
          <p className="small text-secondary mb-0">
            <strong>Attend une personne</strong> : la tâche est rangée dans « À traiter » (une décision ou une vérification de votre part), et une tâche en cours dans ce statut n’est jamais signalée « agent
            arrêté ». Les agents connaissent ces statuts et y rangent les tâches (outil <code>tasks.update</code>, paramètre <code>state</code>).
            {project.taskStatusesCustomized ? '' : ' Ce projet utilise les statuts par défaut de Skipper.'}
          </p>
        </Card.Body>
      </Card>

      <Table responsive size="sm" className="align-middle task-statuses-table">
        <thead>
          <tr>
            <th style={{ width: 64 }} />
            <th>Libellé</th>
            <th>Catégorie</th>
            <th>Description</th>
            <th className="text-center" title="Rangée dans « À traiter » : une personne doit agir (trier, valider)">
              Attend une personne
            </th>
            <th className="text-center" title="Statut que prend une tâche qui entre dans la catégorie sans précision">
              Par défaut
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.uid}>
              <td className="text-nowrap">
                <Button size="sm" variant="link" className="p-0 me-1" disabled={!canManage || i === 0} onClick={() => move(i, -1)} aria-label="Monter">
                  <i className="bi bi-arrow-up" />
                </Button>
                <Button size="sm" variant="link" className="p-0" disabled={!canManage || i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Descendre">
                  <i className="bi bi-arrow-down" />
                </Button>
              </td>
              <td>
                <Form.Control size="sm" value={r.label} maxLength={40} disabled={!canManage} placeholder="Libellé" style={{ minWidth: 140 }} onChange={(e) => update(r.uid, { label: e.target.value })} aria-label="Libellé" />
                {r.key && <div className="small font-monospace text-secondary mt-1">{r.key}</div>}
              </td>
              <td>
                <Form.Select size="sm" value={r.category} disabled={!canManage} onChange={(e) => update(r.uid, { category: e.target.value as TaskStatus, isDefault: false })} aria-label="Catégorie" style={{ minWidth: 130 }}>
                  {TASK_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Form.Select>
              </td>
              <td>
                <Form.Control size="sm" value={r.description} maxLength={300} disabled={!canManage} placeholder="Ce que veut dire ce statut (facultatif)" style={{ minWidth: 220 }} onChange={(e) => update(r.uid, { description: e.target.value })} aria-label="Description" />
              </td>
              <td className="text-center">
                <Form.Check type="switch" className="d-inline-block" checked={r.attention} disabled={!canManage} onChange={(e) => update(r.uid, { attention: e.target.checked })} aria-label="Attend une personne" />
              </td>
              <td className="text-center">
                <Form.Check type="radio" name={`default-${r.category}`} className="d-inline-block" checked={r.isDefault} disabled={!canManage} onChange={() => update(r.uid, { isDefault: true })} aria-label="Statut par défaut de la catégorie" />
              </td>
              <td className="text-end">
                <Button size="sm" variant="link" className="text-danger p-0" disabled={!canManage} onClick={() => remove(r.uid)} aria-label="Retirer ce statut">
                  <i className="bi bi-trash" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      {missing.length > 0 && (
        <Alert variant="warning" className="small py-2">
          Il manque un statut dans {missing.length > 1 ? 'les catégories' : 'la catégorie'} {missing.map((m) => `« ${m.label} »`).join(', ')}.
        </Alert>
      )}
      {dirty && removedInUse.length > 0 && (
        <Alert variant="info" className="small py-2">
          Les tâches {removedInUse.map((s) => `« ${s.label} »`).join(', ')} prendront le statut par défaut de leur catégorie.
        </Alert>
      )}
      {canManage ? (
        <div className="d-flex gap-2 flex-wrap align-items-center">
          <Button size="sm" variant="outline-secondary" onClick={add} disabled={rows.length >= 20}>
            <i className="bi bi-plus-lg me-1" /> Ajouter un statut
          </Button>
          <Button size="sm" disabled={!dirty || saving || missing.length > 0 || rows.some((r) => !r.label.trim())} onClick={() => void submit(rows)}>
            Enregistrer
          </Button>
          {dirty && (
            <Button size="sm" variant="link" onClick={() => setRows(toRows(project.taskStatuses))}>
              Annuler les modifications
            </Button>
          )}
          {project.taskStatusesCustomized && (
            <Button size="sm" variant="outline-danger" className="ms-auto" disabled={saving} onClick={() => void reset()}>
              Revenir aux statuts par défaut
            </Button>
          )}
          {saved && !dirty && <Badge bg="success">Enregistré</Badge>}
        </div>
      ) : (
        <p className="small text-secondary">Seuls les administrateurs du projet modifient ses statuts.</p>
      )}
    </>
  );
}

function toPayload(rows: Row[]) {
  return rows.map((r) => ({ key: r.key || null, label: r.label.trim(), category: r.category, description: r.description.trim() || null, attention: r.attention, isDefault: r.isDefault }));
}
