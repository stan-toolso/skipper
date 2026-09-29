import { useMutation, useQuery } from '@apollo/client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Collapse, Form, Modal } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { CREATE_SESSION, CREATE_WORKTREE, PROJECTS, PROJECT_WORKTREES, PROVIDERS, type ConfigField, type Project, type Provider, type Session, type Worktree } from '../graphql/operations';
import { canAutoFocus } from '../lib/device';

/** Ouverture de la modale : « Nouvelle session » (worktree existant ou nouveau au choix) ou « Nouveau worktree » (avec une session par défaut). */
export type LaunchMode = 'session' | 'worktree';
export interface LaunchOptions {
  projectId?: string | null;
  worktreeId?: string | null;
}

interface LauncherState {
  openNewSession: (options?: LaunchOptions) => void;
  openNewWorktree: (options: { projectId: string }) => void;
}

const LauncherContext = createContext<LauncherState | null>(null);

export function useSessionLauncher(): LauncherState {
  const ctx = useContext(LauncherContext);
  if (!ctx) throw new Error('useSessionLauncher doit être utilisé dans un SessionLauncherProvider');
  return ctx;
}

/** Valeur spéciale du sélecteur de branche : créer un worktree. */
const NEW_WORKTREE = '__new__';

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
    <Form.Group className="mb-3">
      <Form.Label className="mb-1">
        {field.label}
        {field.required && ' *'}
      </Form.Label>
      <ConfigInput field={field} value={value} onChange={onChange} />
      {field.description && field.type !== 'select' && <Form.Text>{field.description}</Form.Text>}
    </Form.Group>
  );
}

interface LaunchModalProps {
  mode: LaunchMode;
  initial: LaunchOptions;
  onClose: () => void;
}

/**
 * Formulaire de lancement. Mode « session » : projet, branche de travail (dossier principal, worktree
 * existant ou nouveau worktree), consigne et options de l'agent. Mode « worktree » : branche à créer,
 * puis, par défaut, une session lancée dans ce worktree avec les mêmes options.
 */
function LaunchModal({ mode, initial, onClose }: LaunchModalProps) {
  const navigate = useNavigate();
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS);
  const providers = providersData?.providers ?? [];
  const projects = useMemo(() => (projectsData?.projects ?? []).filter((p) => mode === 'session' || p.gitUrl), [projectsData, mode]);

  const [projectId, setProjectId] = useState(initial.projectId ?? '');
  const [worktreeChoice, setWorktreeChoice] = useState(initial.worktreeId ?? (mode === 'worktree' ? NEW_WORKTREE : ''));
  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [withSession, setWithSession] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [providerType, setProviderType] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [autoStart, setAutoStart] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const project = projects.find((p) => p.id === projectId);
  const { data: worktreesData } = useQuery<{ project: { worktrees: Worktree[]; git: { branch: string } | null } | null }>(PROJECT_WORKTREES, { variables: { id: projectId }, skip: !projectId });
  const worktrees = worktreesData?.project?.worktrees ?? [];
  const mainBranch = worktreesData?.project?.git?.branch;
  const provider = providers.find((p) => p.type === providerType);

  const [createSession, { loading: creatingSession }] = useMutation<{ createSession: Session }>(CREATE_SESSION, { refetchQueries: ['Sidebar', 'ProjectWorktrees', 'Sessions'] });
  const [createWorktree, { loading: creatingWorktree }] = useMutation<{ createWorktree: { id: string } }>(CREATE_WORKTREE, { refetchQueries: ['Sidebar', 'ProjectWorktrees'] });

  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
    else if (projectId && projects.length && !projects.some((p) => p.id === projectId)) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    // Le worktree choisi doit appartenir au projet sélectionné ; un projet sans git n'a que son dossier principal.
    if (worktreeChoice && worktreeChoice !== NEW_WORKTREE && worktreesData?.project && !worktrees.some((w) => w.id === worktreeChoice)) setWorktreeChoice('');
    if (worktreeChoice === NEW_WORKTREE && project && !project.gitUrl) setWorktreeChoice('');
  }, [worktreesData, worktrees, worktreeChoice, project]);

  useEffect(() => {
    if (!providerType && providers.length) setProviderType(providers[0].type);
  }, [providers, providerType]);

  useEffect(() => {
    // Réinitialise la config avec les valeurs par défaut du provider sélectionné.
    const defaults: Record<string, string> = {};
    for (const f of provider?.configFields ?? []) if (f.defaultValue) defaults[f.key] = f.defaultValue;
    setValues(defaults);
  }, [provider]);

  const creatingNewWorktree = worktreeChoice === NEW_WORKTREE;
  const sessionWanted = mode === 'session' || withSession;
  const busy = creatingSession || creatingWorktree;
  const canSubmit = Boolean(project) && !busy && (!creatingNewWorktree || branch.trim()) && (!sessionWanted || (provider && prompt.trim()));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !canSubmit) return;
    setError(null);
    try {
      if (!sessionWanted) {
        await createWorktree({ variables: { projectId: project.id, branch: branch.trim(), baseRef: baseRef.trim() || null } });
        onClose();
        return;
      }
      const res = await createSession({
        variables: {
          input: {
            projectId: project.id,
            worktreeId: creatingNewWorktree || !worktreeChoice ? null : worktreeChoice,
            newWorktree: creatingNewWorktree ? { branch: branch.trim(), baseRef: baseRef.trim() || null } : null,
            name: name.trim() || prompt.trim().split('\n')[0].slice(0, 60) || 'Session',
            provider: provider!.type,
            prompt: prompt || null,
            config: buildConfig(provider!.configFields, values),
            autoStart,
          },
        },
      });
      onClose();
      if (res.data) navigate(`/sessions/${res.data.createSession.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const mainFields = (provider?.configFields ?? []).filter((f) => !f.advanced);
  const advancedFields = (provider?.configFields ?? []).filter((f) => f.advanced);
  const setValue = (key: string) => (v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  const worktreeFields = (
    <div className="ps-3 border-start mb-3">
      <Form.Group className="mb-2">
        <Form.Label className="mb-1">Branche</Form.Label>
        <Form.Control value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="ex. feature/contact (créée si elle n'existe pas)" autoFocus={mode === 'worktree' && canAutoFocus()} />
      </Form.Group>
      <Form.Group className="mb-2">
        <Form.Label className="mb-1">À partir de</Form.Label>
        <Form.Control value={baseRef} onChange={(e) => setBaseRef(e.target.value)} placeholder={`HEAD du dossier principal${mainBranch ? ` (${mainBranch})` : ''} par défaut`} />
        <Form.Text>Ignoré si la branche existe déjà, localement ou sur origin.</Form.Text>
      </Form.Group>
    </div>
  );

  return (
    <Modal show onHide={onClose} centered size="lg" backdrop={busy ? 'static' : true}>
      <Form onSubmit={submit}>
        <Modal.Header closeButton={!busy}>
          <Modal.Title className="h6">{mode === 'worktree' ? 'Nouveau worktree' : 'Nouvelle session'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {projects.length === 0 ? (
            <Alert variant="warning" className="mb-0">
              {mode === 'worktree' ? 'Aucun projet relié à un dépôt git : les worktrees exigent un dépôt.' : "Commencez par créer un projet : c'est le dossier de travail dans lequel l'agent interviendra."}
            </Alert>
          ) : (
            <>
              <Form.Group className="mb-3">
                <Form.Label className="mb-1">Projet</Form.Label>
                <Form.Select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={projects.length === 1}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>

              {mode === 'session' && project?.gitUrl && (
                <Form.Group className="mb-3">
                  <Form.Label className="mb-1">Branche de travail</Form.Label>
                  <Form.Select value={worktreeChoice} onChange={(e) => setWorktreeChoice(e.target.value)}>
                    <option value="">Dossier principal{mainBranch ? ` (${mainBranch})` : ''}</option>
                    {worktrees.map((w) => (
                      <option key={w.id} value={w.id} disabled={!w.exists}>
                        Worktree {w.branch}
                        {!w.exists ? ' (absent du disque)' : ''}
                      </option>
                    ))}
                    <option value={NEW_WORKTREE}>Nouveau worktree…</option>
                  </Form.Select>
                  {!creatingNewWorktree && <Form.Text>Un worktree isole le travail de l'agent sur sa propre branche, sans toucher au dossier principal.</Form.Text>}
                </Form.Group>
              )}
              {mode === 'session' && creatingNewWorktree && worktreeFields}

              {mode === 'worktree' && (
                <>
                  <p className="text-secondary small">
                    Un worktree extrait une branche dans son propre dossier, à côté du dossier principal{mainBranch ? ` (${mainBranch})` : ''} : les agents y travaillent sans le gêner.
                  </p>
                  {worktreeFields}
                  <Form.Check className="mb-3" type="switch" id="launch-with-session" label="Lancer une session d'agent dans ce worktree" checked={withSession} onChange={(e) => setWithSession(e.target.checked)} />
                </>
              )}

              {sessionWanted && (
                <>
                  <Form.Group className="mb-3">
                    <Form.Label className="mb-1">Que doit faire l'agent ?</Form.Label>
                    <Form.Control
                      as="textarea"
                      rows={5}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      autoFocus={mode === 'session' && canAutoFocus()}
                      placeholder="Décrivez la tâche comme à un collègue. Ex. : « Ajoute une page de contact au site, avec un formulaire qui envoie un e-mail. »"
                    />
                    <Form.Text>Vous pourrez préciser, corriger ou relancer l'agent à tout moment pendant la session.</Form.Text>
                  </Form.Group>

                  <Form.Group className="mb-3">
                    <Form.Label className="mb-1">Nom de la session</Form.Label>
                    <Form.Control value={name} onChange={(e) => setName(e.target.value)} placeholder="Facultatif, déduit de la consigne sinon" />
                  </Form.Group>

                  {providers.length > 1 && (
                    <Form.Group className="mb-3">
                      <Form.Label className="mb-1">Agent</Form.Label>
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

                  <Form.Check className="mb-3" type="switch" id="launch-autostart" label="Démarrer tout de suite" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />

                  {advancedFields.length > 0 && (
                    <div className="mb-2">
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
                </>
              )}

              {error && (
                <Alert variant="danger" className="mb-0">
                  {error}
                </Alert>
              )}
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" size="sm" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit}>
            {busy ? (creatingNewWorktree ? 'Création du worktree…' : 'Lancement…') : !sessionWanted ? 'Créer le worktree' : autoStart ? 'Lancer la session' : 'Créer la session'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/** Fournit `openNewSession` / `openNewWorktree` à toute l'application et affiche la modale correspondante. */
export function SessionLauncherProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ mode: LaunchMode; initial: LaunchOptions; key: number } | null>(null);
  const openNewSession = useCallback((options: LaunchOptions = {}) => setState((s) => ({ mode: 'session', initial: options, key: (s?.key ?? 0) + 1 })), []);
  const openNewWorktree = useCallback((options: { projectId: string }) => setState((s) => ({ mode: 'worktree', initial: { projectId: options.projectId }, key: (s?.key ?? 0) + 1 })), []);
  const value = useMemo(() => ({ openNewSession, openNewWorktree }), [openNewSession, openNewWorktree]);
  return (
    <LauncherContext.Provider value={value}>
      {children}
      {state && <LaunchModal key={state.key} mode={state.mode} initial={state.initial} onClose={() => setState(null)} />}
    </LauncherContext.Provider>
  );
}
