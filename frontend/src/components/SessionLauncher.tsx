import { useMutation, useQuery } from '@apollo/client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Collapse, Form, Modal } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { CREATE_SESSION, PROJECTS, PROJECT_LAUNCH_INFO, PROVIDERS, type ConfigField, type Project, type Provider, type Session } from '../graphql/operations';
import { canAutoFocus } from '../lib/device';
import { branchFromName, namesFromText, suggestWorksessionName } from '../lib/worksessions';
import { bypassConnectionsWarning } from '../lib/humanize';
import { toAttachmentInputs, usePendingAttachments } from '../lib/attachments';
import AttachmentChips from './AttachmentChips';
import DictationButton from './DictationButton';

export interface LaunchOptions {
  projectId?: string | null;
  /** Consigne pré-remplie. */
  prompt?: string | null;
}

interface LauncherState {
  openNewSession: (options?: LaunchOptions) => void;
}

const LauncherContext = createContext<LauncherState | null>(null);

export function useSessionLauncher(): LauncherState {
  const ctx = useContext(LauncherContext);
  if (!ctx) throw new Error('useSessionLauncher doit être utilisé dans un SessionLauncherProvider');
  return ctx;
}

/** Dernier mode d'autorisation choisi dans ce formulaire, par projet (prioritaire sur le réglage du projet). */
const permissionModeKey = (projectId: string) => `skipper.launcher.permissionMode.${projectId}`;

export function lastPermissionMode(projectId: string): string | null {
  try {
    return localStorage.getItem(permissionModeKey(projectId));
  } catch {
    return null;
  }
}

export function rememberPermissionMode(projectId: string, mode: string): void {
  try {
    localStorage.setItem(permissionModeKey(projectId), mode);
  } catch {
    /* stockage indisponible (navigation privée) : rien à mémoriser */
  }
}

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
export function buildConfig(fields: ConfigField[], values: Record<string, string>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === '') continue;
    config[field.key] = field.type === 'number' ? Number(raw) : field.type === 'boolean' ? raw === 'true' : raw;
  }
  return config;
}

export function FieldGroup({ field, value, onChange }: { field: ConfigField; value: string; onChange: (v: string) => void }) {
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
  initial: LaunchOptions;
  onClose: () => void;
}

/**
 * Formulaire de lancement : une seule question, « que voulez-vous faire ? ». Chaque session a son propre dossier
 * de travail (sa work session, que l'interface ne nomme pas) : pour un projet git, une branche nommée d'après la
 * consigne, modifiable avec son point de départ. Type d'agent, modèle et autorisations restent des options
 * discrètes. Sans consigne ni fichier joint, la session est créée sans démarrer.
 */
function LaunchModal({ initial, onClose }: LaunchModalProps) {
  const navigate = useNavigate();
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  // L'espace personnel est proposé avec les projets : on y lance aussi des sessions.
  const { data: projectsData, loading: projectsLoading } = useQuery<{ projects: Project[] }>(PROJECTS, { variables: { includePersonal: true } });
  const providers = providersData?.providers ?? [];
  const projects = projectsData?.projects ?? [];

  const [projectId, setProjectId] = useState(initial.projectId ?? '');
  const [prompt, setPrompt] = useState(initial.prompt ?? '');
  const [editBranch, setEditBranch] = useState(false);
  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [fallbackName] = useState(suggestWorksessionName);
  const [providerType, setProviderType] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [showOptions, setShowOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = usePendingAttachments();

  const project = projects.find((p) => p.id === projectId);
  const { data: infoData } = useQuery<{ project: { id: string; gitUrl: string | null; git: { branch: string } | null; defaultPermissionMode: string; approvalConnections: string[] } | null }>(PROJECT_LAUNCH_INFO, { variables: { id: projectId }, skip: !projectId });
  const info = infoData?.project?.id === projectId ? infoData.project : null;
  const mainBranch = info?.git?.branch;
  const provider = providers.find((p) => p.type === providerType);

  const [createSession, { loading: busy }] = useMutation<{ createSession: Session }>(CREATE_SESSION, { refetchQueries: ['Sidebar', 'Sessions'] });

  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
    else if (projectId && projects.length && !projects.some((p) => p.id === projectId)) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    if (!providerType && providers.length) setProviderType(providers[0].type);
  }, [providers, providerType]);

  useEffect(() => {
    // Réinitialise la config avec les valeurs par défaut du provider sélectionné.
    const defaults: Record<string, string> = {};
    for (const f of provider?.configFields ?? []) if (f.defaultValue) defaults[f.key] = f.defaultValue;
    setValues(defaults);
  }, [provider]);

  // Mode d'autorisation : le dernier choisi dans ce formulaire pour le projet, sinon celui du projet.
  const projectDefaultMode = info?.defaultPermissionMode;
  useEffect(() => {
    const field = provider?.configFields.find((f) => f.key === 'permissionMode');
    if (!field || !projectId || !projectDefaultMode) return;
    const saved = lastPermissionMode(projectId);
    const mode = saved && (field.options ?? []).some((o) => o.value === saved) ? saved : projectDefaultMode;
    setValues((prev) => ({ ...prev, permissionMode: mode }));
  }, [provider, projectId, projectDefaultMode]);

  // Nom du dossier et branche dérivés de la consigne, sauf si la branche est choisie.
  const derived = namesFromText(prompt);
  const hasText = Boolean(prompt.trim());
  const suggestedName = hasText ? derived.name : fallbackName;
  const effectiveBranch = branch.trim() ? branchFromName(branch) : suggestedName;
  const isGit = Boolean(project?.gitUrl);

  const hasInstruction = Boolean(prompt.trim() || attachments.items.length);
  const canSubmit = Boolean(project) && !busy && Boolean(provider) && Boolean(effectiveBranch);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !canSubmit) return;
    setError(null);
    // Dossier nommé d'après la branche (projet git) ou la consigne ; libellé : première ligne de la consigne.
    const newWorksession = isGit ? { branch: effectiveBranch, name: null, label: hasText ? derived.label : null, baseRef: baseRef.trim() || null } : { branch: null, name: suggestedName, label: hasText ? derived.label : null, baseRef: null };
    try {
      const chosenMode = values.permissionMode;
      if (chosenMode && provider!.configFields.some((f) => f.key === 'permissionMode')) rememberPermissionMode(project.id, chosenMode);
      const res = await createSession({
        variables: {
          input: {
            projectId: project.id,
            newWorksession,
            name: prompt.trim().split('\n')[0].slice(0, 60) || attachments.items[0]?.name.slice(0, 60) || 'Session',
            provider: provider!.type,
            prompt: prompt || null,
            attachments: attachments.items.length ? await toAttachmentInputs(attachments.items) : null,
            config: buildConfig(provider!.configFields, values),
            autoStart: hasInstruction,
          },
        },
      });
      onClose();
      if (res.data) navigate(`/sessions/${res.data.createSession.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const configFields = provider?.configFields ?? [];
  const setValue = (key: string) => (v: string) => setValues((prev) => ({ ...prev, [key]: v }));
  const bypassWarning = values.permissionMode === 'bypassPermissions' ? bypassConnectionsWarning(info?.approvalConnections ?? []) : null;
  const optionSummary = [provider && providers.length > 1 ? provider.label : null, ...configFields.filter((f) => !f.advanced && values[f.key]).map((f) => f.options?.find((o) => o.value === values[f.key])?.label ?? values[f.key])].filter(Boolean).join(' · ');
  const submitLabel = busy ? 'Création…' : hasInstruction ? 'Lancer' : 'Créer la session';

  return (
    <Modal show onHide={onClose} centered size="lg" backdrop={busy ? 'static' : true}>
      <Form onSubmit={submit}>
        <Modal.Header closeButton={!busy}>
          <Modal.Title className="h6">Nouvelle session</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {projects.length === 0 ? (
            <Alert variant={projectsLoading ? 'light' : 'warning'} className="mb-0">
              {projectsLoading ? 'Chargement des projets…' : "Commencez par créer un projet : c'est le dossier de travail dans lequel l'agent interviendra."}
            </Alert>
          ) : (
            <>
              {projects.length > 1 && (
                <div className="d-flex gap-2 mb-3 flex-wrap">
                  <Form.Select size="sm" className="w-auto flex-grow-1" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Projet">
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.isPersonal ? 'Mon espace personnel' : p.name}
                      </option>
                    ))}
                  </Form.Select>
                </div>
              )}

              <Form.Group className="mb-2">
                <div className="dictation-field">
                  <Form.Control
                    as="textarea"
                    rows={6}
                    className="fs-6"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    autoFocus={canAutoFocus()}
                    placeholder="Que voulez-vous faire ? Décrivez la tâche comme à un collègue."
                    onPaste={attachments.onPaste}
                    onDrop={attachments.onDrop}
                    onDragOver={attachments.onDragOver}
                  />
                  <DictationButton value={prompt} onChange={setPrompt} disabled={busy} className="dictation-float" />
                </div>
                <AttachmentChips items={attachments.items} onAdd={(files) => attachments.add(files)} onRemove={attachments.remove} disabled={busy} error={attachments.error} />
              </Form.Group>

              {isGit && (
                <div className="small text-secondary mb-3">
                  {!editBranch ? (
                    <>
                      <i className="bi bi-git me-1" />
                      Branche <code>{effectiveBranch}</code>
                      {baseRef.trim() && (
                        <>
                          {' '}
                          · à partir de <code>{baseRef.trim()}</code>
                        </>
                      )}
                      <Button variant="link" size="sm" className="p-0 ms-2 text-secondary align-baseline" onClick={() => setEditBranch(true)} title="Choisir la branche et son point de départ">
                        <i className="bi bi-pencil-square" />
                      </Button>
                    </>
                  ) : (
                    <div className="ps-3 border-start">
                      <Form.Group className="mb-2">
                        <Form.Label className="mb-1">Branche</Form.Label>
                        <Form.Control size="sm" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={`${suggestedName} (extraite si elle existe, créée sinon)`} />
                      </Form.Group>
                      <Form.Group className="mb-2">
                        <Form.Label className="mb-1">À partir de</Form.Label>
                        <Form.Control size="sm" value={baseRef} onChange={(e) => setBaseRef(e.target.value)} placeholder={`${mainBranch ? `origin/${mainBranch}` : 'Branche principale sur origin'} par défaut`} />
                        <Form.Text>Ignoré si la branche existe déjà, localement ou sur origin.</Form.Text>
                      </Form.Group>
                    </div>
                  )}
                </div>
              )}

              <div className="mb-2">
                <Button variant="link" size="sm" className="p-0 text-secondary text-decoration-none" onClick={() => setShowOptions((v) => !v)} aria-expanded={showOptions}>
                  <i className={`bi bi-chevron-${showOptions ? 'down' : 'right'} me-1`} />
                  Options de l'agent{optionSummary && !showOptions ? <span className="ms-1">· {optionSummary}</span> : null}
                </Button>
                <Collapse in={showOptions}>
                  <div className="pt-2 ps-3 border-start">
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
                    {configFields.map((field) => (
                      <FieldGroup key={field.key} field={field} value={values[field.key] ?? ''} onChange={setValue(field.key)} />
                    ))}
                  </div>
                </Collapse>
              </div>
              {bypassWarning && (
                <Alert variant="warning" className="py-2 small">
                  <i className="bi bi-exclamation-triangle me-1" />
                  {bypassWarning}
                </Alert>
              )}
              {!hasInstruction && <Form.Text className="d-block mb-2">Sans consigne, la session est créée sans démarrer : vous écrirez la première instruction depuis sa page.</Form.Text>}

              {error && (
                <Alert variant="danger" className="mb-0 mt-2">
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
            {submitLabel}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/** Fournit `openNewSession` à toute l'application et affiche la modale de lancement. */
export function SessionLauncherProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ initial: LaunchOptions; key: number } | null>(null);
  const openNewSession = useCallback((options: LaunchOptions = {}) => setState((s) => ({ initial: options, key: (s?.key ?? 0) + 1 })), []);
  const value = useMemo(() => ({ openNewSession }), [openNewSession]);
  return (
    <LauncherContext.Provider value={value}>
      {children}
      {state && <LaunchModal key={state.key} initial={state.initial} onClose={() => setState(null)} />}
    </LauncherContext.Provider>
  );
}
