import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Collapse, Form, Modal } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { PROVIDERS, START_TASK_SESSION, type ConfigField, type Provider, type Task } from '../graphql/operations';
import { TASK_LAUNCH_INFO, TASK_PROMPT } from '../graphql/tasks';
import { bypassConnectionsWarning } from '../lib/humanize';
import { buildConfig, FieldGroup, lastPermissionMode, rememberPermissionMode } from './SessionLauncher';

export interface LaunchTarget {
  id: string;
  gitUrl: string | null;
  defaultPermissionMode: string;
  approvalConnections?: string[];
}

/**
 * « Confier à un agent » : consigne relue, type d'agent et ses options. L'agent travaille dans le dossier de la
 * tâche (sa branche task/… pour un projet git), créé à la première session et repris ensuite ; la session
 * précédente de la tâche, s'il y en a une d'active, est archivée.
 */
export default function TaskLaunchModal({ task, target, onClose }: { task: Task; target: LaunchTarget | undefined; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: promptData, loading: promptLoading } = useQuery<{ taskPrompt: string }>(TASK_PROMPT, { variables: { id: task.id }, fetchPolicy: 'network-only' });
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const providers = providersData?.providers ?? [];
  const [providerType, setProviderType] = useState('');
  const provider = providers.find((p) => p.type === (providerType || providers[0]?.type));
  const [prompt, setPrompt] = useState<string | null>(null);
  const { data: infoData } = useQuery<{ task: { id: string; branch: string | null; session: { id: string; name: string; archivedAt: string | null } | null; worksession: { id: string; name: string; branch: string; label: string; archivedAt: string | null } | null } | null }>(TASK_LAUNCH_INFO, { variables: { id: task.id }, fetchPolicy: 'cache-and-network' });
  const own = infoData?.task?.worksession ?? null;
  const branch = own?.branch ?? infoData?.task?.branch ?? null;
  // Session active déjà en charge de la tâche : elle sera archivée au profit de la nouvelle.
  const previous = infoData?.task?.session && !infoData.task.session.archivedAt ? infoData.task.session : null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const original = promptData?.taskPrompt ?? '';
  const text = prompt ?? original;
  const edited = prompt !== null && prompt !== original;

  useEffect(() => {
    if (!provider) return;
    const defaults: Record<string, string> = {};
    for (const f of provider.configFields) if (f.defaultValue) defaults[f.key] = f.defaultValue;
    const remembered = lastPermissionMode(task.project.id);
    const modeField = provider.configFields.find((f) => f.key === 'permissionMode');
    if (modeField) {
      const valid = (v: string | null) => v && modeField.options?.some((o) => o.value === v);
      defaults.permissionMode = (valid(remembered) ? remembered : valid(target?.defaultPermissionMode ?? null) ? target!.defaultPermissionMode : defaults.permissionMode) ?? '';
    }
    setValues(defaults);
  }, [provider?.type]); // eslint-disable-line react-hooks/exhaustive-deps

  const [start, { loading, error }] = useMutation<{ startTaskSession: { id: string } }>(START_TASK_SESSION, {
    refetchQueries: ['Tasks', 'TaskPage', 'TaskDetail', 'Sidebar'],
    onCompleted: (res) => {
      if (values.permissionMode) rememberPermissionMode(task.project.id, values.permissionMode);
      onClose();
      navigate(`/sessions/${res.startTaskSession.id}`);
    },
  });
  const fields = useMemo(() => provider?.configFields ?? [], [provider]);
  const basic = fields.filter((f) => !f.advanced);
  const extra = fields.filter((f) => f.advanced);
  const warning = values.permissionMode === 'bypassPermissions' ? bypassConnectionsWarning(target?.approvalConnections ?? []) : null;
  const set = (f: ConfigField) => (v: string) => setValues((prev) => ({ ...prev, [f.key]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider || !text.trim()) return;
    start({
      variables: {
        id: task.id,
        provider: provider.type,
        config: buildConfig(fields, values),
        prompt: edited ? text : null,
      },
    });
  };

  return (
    <Modal show onHide={onClose} size="lg" centered backdrop={loading ? 'static' : true}>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h6">Confier à un agent · {task.title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label className="d-flex justify-content-between">
              Consigne
              {edited && (
                <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setPrompt(null)}>
                  Revenir au texte de la tâche
                </button>
              )}
            </Form.Label>
            <Form.Control as="textarea" rows={10} className="font-monospace small" value={promptLoading ? 'Chargement…' : text} disabled={promptLoading} onChange={(e) => setPrompt(e.target.value)} />
            <Form.Text>Construite à partir de la tâche (description, champs, commentaires). Modifiez-la librement : l'agent reçoit ce texte comme première instruction.</Form.Text>
          </Form.Group>
          <div className="small text-secondary mb-3">
            <i className="bi bi-git me-1" />
            {own
              ? `L'agent reprend le dossier de travail de la tâche${target?.gitUrl && branch ? ` (branche ${branch})` : ''} : les fichiers${target?.gitUrl ? ' et la branche' : ''} des sessions précédentes.`
              : `L'agent travaille dans un dossier${target?.gitUrl ? ' sur une branche task/…' : ''} créé pour la tâche et repris par ses sessions suivantes.`}
            {previous && (
              <>
                {' '}
                La session « {previous.name} », en charge de la tâche, est archivée (arrêtée si elle tourne) : une seule session à la fois dans ce dossier.
              </>
            )}
          </div>
          {providers.length > 1 && (
            <Form.Group className="mb-3">
              <Form.Label>Agent</Form.Label>
              <Form.Select value={provider?.type ?? ''} onChange={(e) => setProviderType(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.type} value={p.type}>
                    {p.label}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          )}
          {basic.map((f) => (
            <FieldGroup key={f.key} field={f} value={values[f.key] ?? ''} onChange={set(f)} />
          ))}
          {warning && <Alert variant="warning" className="py-2 small">{warning}</Alert>}
          {extra.length > 0 && (
            <>
              <button type="button" className="btn btn-link btn-sm p-0 mb-2" onClick={() => setAdvanced((v) => !v)}>
                <i className={`bi bi-chevron-${advanced ? 'down' : 'right'} me-1`} /> Options avancées
              </button>
              <Collapse in={advanced}>
                <div>
                  {extra.map((f) => (
                    <FieldGroup key={f.key} field={f} value={values[f.key] ?? ''} onChange={set(f)} />
                  ))}
                </div>
              </Collapse>
            </>
          )}
          {error && <Alert variant="danger" className="mb-0 py-2">{error.message}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose} disabled={loading}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || !provider || promptLoading || !text.trim()}>
            {loading ? 'Lancement…' : 'Lancer la session'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
