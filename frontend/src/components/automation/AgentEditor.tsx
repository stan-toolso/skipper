import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap';
import { AGENT_LLM_KEYS, CREATE_AGENT, LLM_PROVIDER, UPDATE_AGENT, type Agent, type AgentLlmKeys, type AgentOutputFormat, type CreateAgentInput, type InputVariableInput, type LlmAgentConfig, type LlmKeyItem } from '../../graphql/automation';
import { PROJECTS, PROJECT_WORKTREES, PROVIDERS, type Project, type Provider, type Worktree } from '../../graphql/operations';
import { VARIABLE_KEY_PATTERN } from '../../lib/automation';
import { buildConfig, FieldGroup } from '../SessionLauncher';
import PathChips, { insertAtCursor } from './PathChips';

interface VariableRow {
  key: string;
  label: string;
  description: string;
  required: boolean;
  defaultValue: string;
}

interface Props {
  /** Agent à modifier ; absent : création. */
  agent?: Agent | null;
  /** Projet imposé à la création (page d'un projet). */
  projectId?: string | null;
  onClose: () => void;
  onSaved: (agent: Agent) => void;
}

const LLM_BACKENDS: { value: LlmAgentConfig['backend']; label: string; hint: string }[] = [
  { value: 'litellm', label: 'LiteLLM', hint: 'Un proxy LiteLLM du coffre : son adresse et sa clé.' },
  { value: 'openai', label: 'OpenAI', hint: 'Une clé OpenAI du coffre (jeton applicatif).' },
  { value: 'anthropic', label: 'Anthropic', hint: 'Une clé API Anthropic du coffre (jeton applicatif).' },
];

const ownerOf = (i: LlmKeyItem) => (i.ownerProject ? `projet ${i.ownerProject.name}` : i.ownerUser ? i.ownerUser.name : '');

/** Création ou modification d'un agent : fournisseur et ses réglages, prompts, variables, sortie, worktree, délai. */
export default function AgentEditor({ agent, projectId: fixedProjectId, onClose, onSaved }: Props) {
  const editing = Boolean(agent);
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS);
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const { data: keysData } = useQuery<{ agentLlmKeys: AgentLlmKeys }>(AGENT_LLM_KEYS);
  const providers = providersData?.providers ?? [];
  const keys = keysData?.agentLlmKeys;

  const [projectId, setProjectId] = useState(agent?.project.id ?? fixedProjectId ?? '');
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [provider, setProvider] = useState(agent?.provider ?? LLM_PROVIDER);
  const llm = (agent?.provider === LLM_PROVIDER ? (agent.config as Partial<LlmAgentConfig>) : {}) as Partial<LlmAgentConfig>;
  const [backend, setBackend] = useState<LlmAgentConfig['backend']>(llm.backend ?? 'litellm');
  const [keyItemId, setKeyItemId] = useState(llm.keyItemId ?? '');
  const [model, setModel] = useState(llm.model ?? '');
  const [temperature, setTemperature] = useState(llm.temperature != null ? String(llm.temperature) : '');
  const [maxTokens, setMaxTokens] = useState(llm.maxTokens != null ? String(llm.maxTokens) : '');
  const [langfuseItemId, setLangfuseItemId] = useState(llm.langfuseItemId ?? '');
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (agent && agent.provider !== LLM_PROVIDER) for (const [k, v] of Object.entries(agent.config)) out[k] = v === null || v === undefined ? '' : String(v);
    return out;
  });
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [promptTemplate, setPromptTemplate] = useState(agent?.promptTemplate ?? '');
  const [variables, setVariables] = useState<VariableRow[]>(() => (agent?.inputs ?? []).map((v) => ({ key: v.key, label: v.label, description: v.description ?? '', required: v.required, defaultValue: v.defaultValue ?? '' })));
  const [outputFormat, setOutputFormat] = useState<AgentOutputFormat>(agent?.outputFormat ?? 'TEXT');
  const [outputSchema, setOutputSchema] = useState(agent?.outputSchema ?? '');
  const [worktreeId, setWorktreeId] = useState(agent?.worktree?.id ?? '');
  const [timeoutMinutes, setTimeoutMinutes] = useState(agent ? String(agent.timeoutMinutes) : '30');
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const { data: worktreesData } = useQuery<{ project: { worktrees: Worktree[] } | null }>(PROJECT_WORKTREES, { variables: { id: projectId }, skip: !projectId });
  const worktrees = (worktreesData?.project?.worktrees ?? []).filter((w) => !w.archivedAt);
  const sessionProvider = providers.find((p) => p.type === provider);
  const sessionFields = useMemo(() => (sessionProvider?.configFields ?? []).filter((f) => f.key !== 'prompt'), [sessionProvider]);

  // Valeurs par défaut des options du fournisseur de session quand on en choisit un.
  useEffect(() => {
    if (!sessionProvider) return;
    setValues((prev) => {
      const next = { ...prev };
      for (const f of sessionProvider.configFields) if (next[f.key] === undefined && f.defaultValue) next[f.key] = f.defaultValue;
      return next;
    });
  }, [sessionProvider]);

  const keyChoices: LlmKeyItem[] = !keys ? [] : backend === 'litellm' ? keys.litellm : keys.tokens.filter((t) => t.token?.service === backend);
  const [create, { loading: creating }] = useMutation<{ createAgent: Agent }>(CREATE_AGENT, { refetchQueries: ['Agents'] });
  const [update, { loading: updating }] = useMutation<{ updateAgent: Agent }>(UPDATE_AGENT, { refetchQueries: ['Agents', 'Agent'] });
  const saving = creating || updating;

  const updateVariable = (i: number, patch: Partial<VariableRow>) => setVariables((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const inputPaths = variables.filter((v) => v.key.trim()).map((v) => ({ path: `input.${v.key.trim()}`, hint: v.label || v.key }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Donnez un nom à l'agent.");
    if (!editing && !projectId) return setError('Choisissez le projet.');
    const inputs: InputVariableInput[] = [];
    for (const v of variables) {
      const key = v.key.trim();
      if (!key) continue;
      if (!VARIABLE_KEY_PATTERN.test(key)) return setError(`Nom de variable invalide « ${key} » : lettres, chiffres et soulignés, sans commencer par un chiffre.`);
      inputs.push({ key, label: v.label.trim() || key, description: v.description.trim() || null, required: v.required, defaultValue: v.defaultValue === '' ? null : v.defaultValue });
    }
    let config: Record<string, unknown>;
    if (provider === LLM_PROVIDER) {
      if (!keyItemId) return setError(`Choisissez la clé ${LLM_BACKENDS.find((b) => b.value === backend)?.label} dans le coffre.`);
      if (!model.trim()) return setError('Le modèle est obligatoire.');
      config = { backend, keyItemId, model: model.trim(), temperature: temperature.trim() === '' ? null : Number(temperature.replace(',', '.')), maxTokens: maxTokens.trim() === '' ? null : Number(maxTokens), langfuseItemId: langfuseItemId || null };
    } else {
      if (!sessionProvider) return setError('Choisissez le type de session.');
      config = buildConfig(sessionProvider.configFields, values);
    }
    const timeout = Number(timeoutMinutes);
    const input: Omit<CreateAgentInput, 'projectId'> = {
      name: name.trim(),
      description: description.trim(),
      provider,
      config,
      systemPrompt,
      promptTemplate,
      inputs,
      outputFormat,
      outputSchema: outputFormat === 'JSON' ? outputSchema : null,
      worktreeId: worktreeId || null,
      timeoutMinutes: Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout) : null,
    };
    try {
      if (editing && agent) {
        const res = await update({ variables: { id: agent.id, input } });
        if (res.data) onSaved(res.data.updateAgent);
      } else {
        const res = await create({ variables: { input: { ...input, projectId } } });
        if (res.data) onSaved(res.data.createAgent);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal show onHide={onClose} size="lg" centered backdrop="static" scrollable>
      <Form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title className="h5">{editing ? `Modifier « ${agent?.name} »` : 'Nouvel agent'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {!editing && !fixedProjectId && (
            <Form.Group className="mb-3">
              <Form.Label>Projet</Form.Label>
              <Form.Select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
                <option value="">Choisir…</option>
                {(projectsData?.projects ?? []).filter((p) => p.myRole !== 'VIEWER').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          )}
          <Row className="g-3">
            <Col md={5}>
              <Form.Group>
                <Form.Label>Nom</Form.Label>
                <Form.Control value={name} onChange={(e) => setName(e.target.value)} required placeholder="Relecteur de PR" />
              </Form.Group>
            </Col>
            <Col md={7}>
              <Form.Group>
                <Form.Label>Description</Form.Label>
                <Form.Control value={description} onChange={(e) => setDescription(e.target.value)} placeholder="À quoi sert cet agent (optionnel)" />
              </Form.Group>
            </Col>
          </Row>

          <hr />
          <Form.Group className="mb-3">
            <Form.Label>Comment l'agent travaille</Form.Label>
            <Form.Select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value={LLM_PROVIDER}>Appel direct d'un modèle (LiteLLM, OpenAI, Anthropic) — rapide, sans outils</option>
              {providers.map((p) => (
                <option key={p.type} value={p.type}>
                  Session {p.label} — {p.description}
                </option>
              ))}
            </Form.Select>
            <Form.Text>Un appel direct répond en un tour, sans accès au code. Une session dédiée dispose des outils du projet (fichiers, git, coffre) et est terminée après sa réponse.</Form.Text>
          </Form.Group>

          {provider === LLM_PROVIDER ? (
            <Row className="g-3">
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Fournisseur</Form.Label>
                  <Form.Select
                    value={backend}
                    onChange={(e) => {
                      setBackend(e.target.value as LlmAgentConfig['backend']);
                      setKeyItemId('');
                    }}
                  >
                    {LLM_BACKENDS.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </Form.Select>
                  <Form.Text>{LLM_BACKENDS.find((b) => b.value === backend)?.hint}</Form.Text>
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Clé du coffre</Form.Label>
                  <Form.Select value={keyItemId} onChange={(e) => setKeyItemId(e.target.value)} required>
                    <option value="">Choisir…</option>
                    {keyChoices.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                        {i.url ? ` — ${i.url}` : ''} ({ownerOf(i)})
                      </option>
                    ))}
                  </Form.Select>
                  {keys && keyChoices.length === 0 && <Form.Text className="text-warning">Aucun élément utilisable : ajoutez {backend === 'litellm' ? 'un proxy LiteLLM' : `un jeton ${backend === 'openai' ? 'OpenAI' : 'Anthropic'}`} dans votre coffre.</Form.Text>}
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Modèle</Form.Label>
                  <Form.Control value={model} onChange={(e) => setModel(e.target.value)} required placeholder={backend === 'anthropic' ? 'claude-sonnet-5-5' : backend === 'openai' ? 'gpt-5' : 'nom du modèle du proxy'} />
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label>Température</Form.Label>
                  <Form.Control type="number" step="0.1" min={0} max={2} value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="défaut" />
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label>Réponse max (tokens)</Form.Label>
                  <Form.Control type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="défaut" />
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group>
                  <Form.Label>Traçage Langfuse (optionnel)</Form.Label>
                  <Form.Select value={langfuseItemId} onChange={(e) => setLangfuseItemId(e.target.value)}>
                    <option value="">Aucun</option>
                    {(keys?.langfuse ?? []).map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                        {i.url ? ` — ${i.url}` : ''} ({ownerOf(i)})
                      </option>
                    ))}
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>
          ) : (
            sessionProvider && (
              <Row className="g-3">
                {sessionFields.map((f) => (
                  <Col md={6} key={f.key}>
                    <FieldGroup field={f} value={values[f.key] ?? ''} onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))} />
                  </Col>
                ))}
              </Row>
            )
          )}

          <hr />
          <Form.Group className="mb-3">
            <Form.Label>Rôle et consignes (prompt système)</Form.Label>
            <Form.Control as="textarea" rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="Tu es un relecteur de code exigeant…" />
            {provider !== LLM_PROVIDER && <Form.Text>Ajouté au prompt système du projet dans la session.</Form.Text>}
          </Form.Group>

          <div className="mb-3">
            <Form.Label className="mb-1">Variables (entrées)</Form.Label>
            {variables.map((v, i) => (
              <div key={i} className="auto-inputs-row">
                <Form.Control size="sm" value={v.key} onChange={(e) => updateVariable(i, { key: e.target.value })} placeholder="clé (ex. ticket)" />
                <Form.Control size="sm" value={v.label} onChange={(e) => updateVariable(i, { label: e.target.value })} placeholder="Libellé" />
                <Form.Control size="sm" value={v.defaultValue} onChange={(e) => updateVariable(i, { defaultValue: e.target.value })} placeholder="Valeur par défaut" />
                <Form.Check type="checkbox" id={`agent-var-req-${i}`} label="requise" checked={v.required} onChange={(e) => updateVariable(i, { required: e.target.checked })} />
                <button type="button" className="auto-icon-btn" title="Retirer" onClick={() => setVariables((rows) => rows.filter((_, j) => j !== i))}>
                  <i className="bi bi-x-lg" />
                </button>
              </div>
            ))}
            <Button variant="outline-secondary" size="sm" onClick={() => setVariables((rows) => [...rows, { key: '', label: '', description: '', required: true, defaultValue: '' }])}>
              <i className="bi bi-plus-lg me-1" /> Ajouter une variable
            </Button>
            <Form.Text className="d-block">Chaque variable est demandée au lancement et disponible dans l'instruction comme {'{{input.clé}}'}.</Form.Text>
          </div>

          <Form.Group className="mb-3">
            <Form.Label>Instruction envoyée à chaque exécution</Form.Label>
            <Form.Control ref={promptRef} as="textarea" rows={6} value={promptTemplate} onChange={(e) => setPromptTemplate(e.target.value)} placeholder={'Relis le ticket {{input.ticket}} et liste les risques.'} className="font-monospace" />
            <PathChips paths={inputPaths} onPick={(ph) => setPromptTemplate((v) => insertAtCursor(promptRef.current, v, ph))} />
            <Form.Text>
              {'{{input.clé}}'} est remplacé par la valeur ; <code>{'{{input.clé | default: "texte"}}'}</code> rend un repli si elle est vide.
            </Form.Text>
          </Form.Group>

          <Row className="g-3">
            <Col md={4}>
              <Form.Group>
                <Form.Label>Format de sortie</Form.Label>
                <Form.Select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value as AgentOutputFormat)}>
                  <option value="TEXT">Texte libre</option>
                  <option value="JSON">JSON (lu par les workflows)</option>
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group>
                <Form.Label>Worktree des exécutions</Form.Label>
                <Form.Select value={worktreeId} onChange={(e) => setWorktreeId(e.target.value)} disabled={provider === LLM_PROVIDER}>
                  <option value="">Dossier principal</option>
                  {worktrees.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group>
                <Form.Label>Délai maximal (minutes)</Form.Label>
                <Form.Control type="number" min={1} value={timeoutMinutes} onChange={(e) => setTimeoutMinutes(e.target.value)} />
              </Form.Group>
            </Col>
            {outputFormat === 'JSON' && (
              <Col md={12}>
                <Form.Group>
                  <Form.Label>Forme JSON attendue (montrée à l'agent)</Form.Label>
                  <Form.Control as="textarea" rows={4} value={outputSchema} onChange={(e) => setOutputSchema(e.target.value)} className="font-monospace" placeholder={'{ "approved": true, "comments": ["…"] }'} />
                </Form.Group>
              </Col>
            )}
          </Row>
          {error && (
            <Alert variant="danger" className="mt-3 mb-0 py-2">
              {error}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Enregistrement…' : editing ? 'Enregistrer' : 'Créer'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
