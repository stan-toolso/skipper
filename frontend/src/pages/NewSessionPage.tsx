import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Collapse, Form, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CREATE_SESSION, PROJECTS, PROJECT_WORKTREES, PROVIDERS, type ConfigField, type Project, type Provider, type Session, type Worktree } from '../graphql/operations';
import { useTabTitle } from '../workbench/TabsContext';

function ConfigInput({ field, value, onChange }: { field: ConfigField; value: string; onChange: (v: string) => void }) {
  if (field.type === 'boolean') {
    return <Form.Check type="switch" checked={value === 'true'} onChange={(e) => onChange(String(e.target.checked))} />;
  }
  if (field.type === 'select') {
    const selected = (field.options ?? []).find((o) => o.value === value);
    return (
      <>
        <Form.Select value={value} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Form.Select>
        {selected?.description && <Form.Text>{selected.description}</Form.Text>}
      </>
    );
  }
  return <Form.Control type={field.type === 'number' ? 'number' : 'text'} value={value} onChange={(e) => onChange(e.target.value)} />;
}

/** Convertit les valeurs textuelles du formulaire vers les types attendus par le provider. */
function buildConfig(fields: ConfigField[], values: Record<string, string>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === '') continue;
    config[field.key] = field.type === 'number' ? Number(raw) : field.type === 'boolean' ? raw === 'true' : raw;
  }
  return config;
}

function FieldGroup({ field, value, onChange }: { field: ConfigField; value: string; onChange: (v: string) => void }) {
  return (
    <Form.Group className="mb-3" key={field.key}>
      <Form.Label className="mb-1">
        {field.label}
        {field.required && ' *'}
      </Form.Label>
      <ConfigInput field={field} value={value} onChange={onChange} />
      {field.description && field.type !== 'select' && <Form.Text>{field.description}</Form.Text>}
    </Form.Group>
  );
}

export default function NewSessionPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data, loading, error } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const { data: projectsData, loading: loadingProjects } = useQuery<{ projects: Project[] }>(PROJECTS);
  const [createSession, { loading: creating, error: createError }] = useMutation<{ createSession: Session }>(CREATE_SESSION, {
    refetchQueries: ['Sidebar'],
    onCompleted: (res) => navigate(`/sessions/${res.createSession.id}`),
  });

  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState(searchParams.get('projectId') ?? '');
  const [worktreeId, setWorktreeId] = useState(searchParams.get('worktreeId') ?? '');
  const { data: worktreesData } = useQuery<{ project: { worktrees: Worktree[]; git: { branch: string } | null } | null }>(PROJECT_WORKTREES, { variables: { id: projectId }, skip: !projectId });
  const worktrees = worktreesData?.project?.worktrees ?? [];
  const mainBranch = worktreesData?.project?.git?.branch;
  const [providerType, setProviderType] = useState('');
  const [prompt, setPrompt] = useState('');
  const [autoStart, setAutoStart] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  const providers = data?.providers ?? [];
  const provider = providers.find((p) => p.type === providerType);
  const projects = projectsData?.projects ?? [];
  const project = projects.find((p) => p.id === projectId);
  useTabTitle(project ? `Nouvelle session · ${project.name}` : 'Nouvelle session');

  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    // Le worktree choisi doit appartenir au projet sélectionné.
    if (worktreeId && worktreesData?.project && !worktrees.some((w) => w.id === worktreeId)) setWorktreeId('');
  }, [worktreesData, worktrees, worktreeId]);

  useEffect(() => {
    if (!providerType && providers.length) setProviderType(providers[0].type);
  }, [providers, providerType]);

  useEffect(() => {
    // Réinitialise la config avec les valeurs par défaut du provider sélectionné.
    const defaults: Record<string, string> = {};
    for (const f of provider?.configFields ?? []) if (f.defaultValue) defaults[f.key] = f.defaultValue;
    setValues(defaults);
  }, [provider]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider || !project) return;
    createSession({
      variables: {
        input: {
          projectId: project.id,
          worktreeId: worktreeId || null,
          name: name.trim() || prompt.trim().split('\n')[0].slice(0, 60) || 'Session',
          provider: provider.type,
          prompt: prompt || null,
          config: buildConfig(provider.configFields, values),
          autoStart,
        },
      },
    });
  };

  if (loading || loadingProjects) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (projects.length === 0) {
    return (
      <Alert variant="warning">
        Commencez par créer un projet : c'est le dossier de travail dans lequel l'agent interviendra. <Link to="/projects/new">Créer un projet</Link>.
      </Alert>
    );
  }

  const mainFields = (provider?.configFields ?? []).filter((f) => !f.advanced);
  const advancedFields = (provider?.configFields ?? []).filter((f) => f.advanced);
  const setValue = (key: string) => (v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  return (
    <>
      <h1 className="h3 mb-3">Nouvelle session</h1>
      <Card style={{ maxWidth: 820 }}>
        <Card.Body>
          <Form onSubmit={submit}>
            <Form.Group className="mb-3">
              <Form.Label>Projet</Form.Label>
              <Form.Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Form.Select>
              {project && <Form.Text>L'agent travaillera dans le dossier de ce projet{project.systemPrompt ? ', avec ses instructions permanentes.' : '.'}</Form.Text>}
            </Form.Group>

            {worktrees.length > 0 && (
              <Form.Group className="mb-3">
                <Form.Label>Branche de travail</Form.Label>
                <Form.Select value={worktreeId} onChange={(e) => setWorktreeId(e.target.value)}>
                  <option value="">Dossier principal{mainBranch ? ` (${mainBranch})` : ''}</option>
                  {worktrees.map((w) => (
                    <option key={w.id} value={w.id} disabled={!w.exists}>
                      Worktree {w.branch}
                      {!w.exists ? ' (absent du disque)' : ''}
                    </option>
                  ))}
                </Form.Select>
                <Form.Text>Un worktree isole le travail de l'agent sur sa propre branche, sans toucher au dossier principal.</Form.Text>
              </Form.Group>
            )}

            <Form.Group className="mb-3">
              <Form.Label>Que doit faire l'agent ?</Form.Label>
              <Form.Control
                as="textarea"
                rows={6}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Décrivez la tâche comme à un collègue. Ex. : « Ajoute une page de contact au site, avec un formulaire qui envoie un e-mail. »"
              />
              <Form.Text>Vous pourrez préciser, corriger ou relancer l'agent à tout moment pendant la session.</Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Nom de la session</Form.Label>
              <Form.Control value={name} onChange={(e) => setName(e.target.value)} placeholder="Pour la retrouver dans la liste (facultatif, déduit de la tâche sinon)" />
            </Form.Group>

            {providers.length > 1 && (
              <Form.Group className="mb-3">
                <Form.Label>Agent</Form.Label>
                <Form.Select value={providerType} onChange={(e) => setProviderType(e.target.value)}>
                  {providers.map((p) => (
                    <option key={p.type} value={p.type}>
                      {p.label}
                    </option>
                  ))}
                </Form.Select>
                {provider && <Form.Text>{provider.description}</Form.Text>}
              </Form.Group>
            )}

            {mainFields.map((field) => (
              <FieldGroup key={field.key} field={field} value={values[field.key] ?? ''} onChange={setValue(field.key)} />
            ))}

            <Form.Check className="mb-3" type="switch" id="autoStart" label="Démarrer tout de suite" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />

            {advancedFields.length > 0 && (
              <div className="mb-3">
                <Button variant="link" size="sm" className="p-0 text-secondary" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}>
                  <i className={`bi bi-chevron-${showAdvanced ? 'down' : 'right'} me-1`} />
                  Options avancées
                </Button>
                <Collapse in={showAdvanced}>
                  <div className="pt-2 ps-3 border-start">
                    {advancedFields.map((field) => (
                      <FieldGroup key={field.key} field={field} value={values[field.key] ?? ''} onChange={setValue(field.key)} />
                    ))}
                  </div>
                </Collapse>
              </div>
            )}

            {createError && <Alert variant="danger">{createError.message}</Alert>}

            <Button type="submit" disabled={creating || !provider || !project || !prompt.trim()}>
              {creating ? 'Lancement…' : autoStart ? 'Lancer la session' : 'Créer la session'}
            </Button>
          </Form>
        </Card.Body>
      </Card>
    </>
  );
}
