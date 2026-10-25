import { useQuery } from '@apollo/client';
import { useRef, useState } from 'react';
import { Button, Col, Form, Row } from 'react-bootstrap';
import { LLM_KEYS, type ConditionGroup, type InputVariable, type LlmBackend, type LlmKeyItem, type LlmKeys, type LlmNodeConfig, type LlmOutputFormat, type NewTaskTemplate, type TaskWorktreeMode, type TriggerEvent, type WorkflowDefinition, type WorkflowIssue, type WorkflowNode } from '../../../graphql/automation';
import type { Provider, Worktree } from '../../../graphql/operations';
import { nodeTypeInfo, VARIABLE_KEY_PATTERN } from '../../../lib/automation';
import { availablePaths } from '../../../lib/workflowGraph';
import { buildConfig, FieldGroup } from '../../SessionLauncher';
import PathChips, { insertAtCursor } from '../PathChips';
import RuleGroupEditor from './RuleGroupEditor';
import TaskFilterEditor from './TaskFilterEditor';

interface Props {
  node: WorkflowNode;
  definition: WorkflowDefinition;
  onChange: (node: WorkflowNode) => void;
  onDelete: () => void;
  providers: Provider[];
  worktrees: Worktree[];
  issues: WorkflowIssue[];
}

/** Champ texte de modèle ({{…}}) avec les chemins insérables. */
function TemplateField({ label, value, onChange, paths, rows = 1, placeholder, hint }: { label: string; value: string; onChange: (v: string) => void; paths: { path: string; hint: string }[]; rows?: number; placeholder?: string; hint?: string }) {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  return (
    <Form.Group className="mb-2">
      <Form.Label>{label}</Form.Label>
      {rows > 1 ? (
        <Form.Control ref={ref as React.RefObject<HTMLTextAreaElement>} as="textarea" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="font-monospace" />
      ) : (
        <Form.Control ref={ref as React.RefObject<HTMLInputElement>} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="font-monospace" />
      )}
      <PathChips paths={paths} onPick={(ph) => onChange(insertAtCursor(ref.current, value, ph))} />
      {hint && <Form.Text>{hint}</Form.Text>}
    </Form.Group>
  );
}

/** Variables d'un déclencheur. */
function VariablesEditor({ variables, onChange }: { variables: InputVariable[]; onChange: (v: InputVariable[]) => void }) {
  const update = (i: number, patch: Partial<InputVariable>) => onChange(variables.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="mb-2">
      <Form.Label>Variables demandées au lancement</Form.Label>
      {variables.map((v, i) => (
        <div key={i} className="d-flex gap-1 align-items-center mb-1">
          <Form.Control size="sm" value={v.key} isInvalid={Boolean(v.key) && !VARIABLE_KEY_PATTERN.test(v.key)} onChange={(e) => update(i, { key: e.target.value })} placeholder="clé" />
          <Form.Control size="sm" value={v.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Libellé" />
          <Form.Control size="sm" value={v.defaultValue ?? ''} onChange={(e) => update(i, { defaultValue: e.target.value === '' ? null : e.target.value })} placeholder="Défaut" />
          <Form.Check type="checkbox" id={`wf-var-req-${i}`} title="Obligatoire" checked={v.required} onChange={(e) => update(i, { required: e.target.checked })} />
          <button type="button" className="auto-icon-btn" title="Retirer" onClick={() => onChange(variables.filter((_, j) => j !== i))}>
            <i className="bi bi-x-lg" />
          </button>
        </div>
      ))}
      <Button size="sm" variant="outline-secondary" onClick={() => onChange([...variables, { key: '', label: '', description: null, required: true, defaultValue: null }])}>
        <i className="bi bi-plus-lg me-1" /> Variable
      </Button>
    </div>
  );
}

const LLM_BACKENDS: { value: LlmBackend; label: string; hint: string }[] = [
  { value: 'litellm', label: 'LiteLLM', hint: 'Un proxy LiteLLM du coffre : son adresse et sa clé.' },
  { value: 'openai', label: 'OpenAI', hint: 'Une clé OpenAI du coffre (jeton applicatif).' },
  { value: 'anthropic', label: 'Anthropic', hint: 'Une clé API Anthropic du coffre (jeton applicatif).' },
];
const EMPTY_LLM: LlmNodeConfig = { backend: 'litellm', keyItemId: '', model: '', temperature: null, maxTokens: null, langfuseItemId: null };
const ownerOf = (i: LlmKeyItem) => (i.ownerProject ? `projet ${i.ownerProject.name}` : i.ownerUser ? i.ownerUser.name : '');

/** Comment joindre le modèle d'un nœud « appel de modèle » : fournisseur, clé du coffre, modèle, réglages, trace Langfuse. */
function LlmConfigFields({ llm, onChange }: { llm: LlmNodeConfig; onChange: (llm: LlmNodeConfig) => void }) {
  const { data } = useQuery<{ llmKeys: LlmKeys }>(LLM_KEYS);
  const keys = data?.llmKeys;
  const set = (p: Partial<LlmNodeConfig>) => onChange({ ...llm, ...p });
  const keyChoices: LlmKeyItem[] = !keys ? [] : llm.backend === 'litellm' ? keys.litellm : keys.tokens.filter((t) => t.token?.service === llm.backend);
  const number = (v: string, integer: boolean) => (v.trim() === '' ? null : integer ? Math.round(Number(v)) : Number(v.replace(',', '.')));
  return (
    <>
      <Form.Group className="mb-2">
        <Form.Label>Fournisseur</Form.Label>
        <Form.Select value={llm.backend} onChange={(e) => set({ backend: e.target.value as LlmBackend, keyItemId: '' })}>
          {LLM_BACKENDS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </Form.Select>
        <Form.Text>{LLM_BACKENDS.find((b) => b.value === llm.backend)?.hint}</Form.Text>
      </Form.Group>
      <Form.Group className="mb-2">
        <Form.Label>Clé du coffre *</Form.Label>
        <Form.Select value={llm.keyItemId} onChange={(e) => set({ keyItemId: e.target.value })}>
          <option value="">Choisir…</option>
          {keyChoices.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
              {i.url ? ` — ${i.url}` : ''} ({ownerOf(i)})
            </option>
          ))}
        </Form.Select>
        {keys && keyChoices.length === 0 && <Form.Text className="text-warning">Aucun élément utilisable : ajoutez {llm.backend === 'litellm' ? 'un proxy LiteLLM' : `un jeton ${llm.backend === 'openai' ? 'OpenAI' : 'Anthropic'}`} dans votre coffre.</Form.Text>}
      </Form.Group>
      <Form.Group className="mb-2">
        <Form.Label>Modèle *</Form.Label>
        <Form.Control value={llm.model} onChange={(e) => set({ model: e.target.value })} placeholder={llm.backend === 'anthropic' ? 'claude-sonnet-5-5' : llm.backend === 'openai' ? 'gpt-5' : 'nom du modèle du proxy'} className="font-monospace" />
      </Form.Group>
      <Row className="g-2 mb-2">
        <Col xs={6}>
          <Form.Group>
            <Form.Label>Température</Form.Label>
            <Form.Control type="number" step="0.1" min={0} max={2} value={llm.temperature ?? ''} onChange={(e) => set({ temperature: number(e.target.value, false) })} placeholder="défaut" />
          </Form.Group>
        </Col>
        <Col xs={6}>
          <Form.Group>
            <Form.Label>Réponse max (jetons)</Form.Label>
            <Form.Control type="number" min={1} value={llm.maxTokens ?? ''} onChange={(e) => set({ maxTokens: number(e.target.value, true) })} placeholder="défaut" />
          </Form.Group>
        </Col>
      </Row>
      <Form.Group className="mb-2">
        <Form.Label>Traçage Langfuse (optionnel)</Form.Label>
        <Form.Select value={llm.langfuseItemId ?? ''} onChange={(e) => set({ langfuseItemId: e.target.value || null })}>
          <option value="">Aucun</option>
          {(keys?.langfuse ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
              {i.url ? ` — ${i.url}` : ''} ({ownerOf(i)})
            </option>
          ))}
        </Form.Select>
      </Form.Group>
    </>
  );
}

/** Type de session et ses options (nœuds tâche et session). */
function SessionConfig({ node, providers, onChange }: { node: WorkflowNode; providers: Provider[]; onChange: (patch: Partial<WorkflowNode>) => void }) {
  const provider = providers.find((p) => p.type === node.provider);
  const fields = (provider?.configFields ?? []).filter((f) => f.key !== 'prompt');
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.config ?? {})) values[k] = v === null || v === undefined ? '' : String(v);
  const setValue = (key: string, v: string) => {
    if (!provider) return;
    onChange({ config: buildConfig(provider.configFields, { ...values, [key]: v }) });
  };
  return (
    <>
      <Form.Group className="mb-2">
        <Form.Label>Type de session</Form.Label>
        <Form.Select value={node.provider ?? ''} onChange={(e) => onChange({ provider: e.target.value, config: {} })}>
          {providers.map((p) => (
            <option key={p.type} value={p.type}>
              {p.label}
            </option>
          ))}
        </Form.Select>
      </Form.Group>
      {fields.map((f) => (
        <FieldGroup key={f.key} field={f} value={values[f.key] ?? f.defaultValue ?? ''} onChange={(v) => setValue(f.key, v)} />
      ))}
    </>
  );
}

function WorktreeChoice({ node, worktrees, onChange, modes }: { node: WorkflowNode; worktrees: Worktree[]; onChange: (patch: Partial<WorkflowNode>) => void; modes: { value: TaskWorktreeMode; label: string }[] }) {
  return (
    <>
      <Form.Group className="mb-2">
        <Form.Label>Où travailler</Form.Label>
        <Form.Select value={node.worktreeMode ?? modes[0].value} onChange={(e) => onChange({ worktreeMode: e.target.value as TaskWorktreeMode })}>
          {modes.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Form.Select>
      </Form.Group>
      {node.worktreeMode === 'existing' && (
        <Form.Group className="mb-2">
          <Form.Label>Worktree</Form.Label>
          <Form.Select value={node.worktreeId ?? ''} onChange={(e) => onChange({ worktreeId: e.target.value || null })}>
            <option value="">Choisir…</option>
            {worktrees.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
      )}
    </>
  );
}

const EXPRESSION_HELP = 'Opérateurs : == != > >= < <= contains matches startsWith endsWith in, and / or / not, « is empty », parenthèses. Ex. : nodes.review.json.approved and input.env == "prod"';

/** Panneau de droite de l'éditeur : les réglages du nœud sélectionné, selon son type. */
export default function NodeInspector({ node, definition, onChange, onDelete, providers, worktrees, issues }: Props) {
  const paths = availablePaths(definition, node.key);
  const patch = (p: Partial<WorkflowNode>) => onChange({ ...node, ...p });
  const info = nodeTypeInfo[node.type];
  const [conditionMode, setConditionMode] = useState<'visual' | 'expression'>(node.type === 'condition' && !node.condition && node.expression ? 'expression' : 'visual');
  const newTask: NewTaskTemplate = node.newTask ?? { title: '', description: '', priority: '', status: '', dueDate: '', assignee: '', reporter: '', fields: [] };
  const setTask = (p: Partial<NewTaskTemplate>) => patch({ newTask: { ...newTask, ...p } });

  return (
    <div>
      <div className="d-flex align-items-center gap-2 mb-2">
        <i className={`bi ${info.icon} text-secondary`} />
        <span className="fw-semibold">{info.label}</span>
        <code className="small text-secondary">{node.key}</code>
        <button type="button" className="auto-icon-btn ms-auto" title="Supprimer le nœud" onClick={onDelete}>
          <i className="bi bi-trash" />
        </button>
      </div>
      <Form.Group className="mb-2">
        <Form.Label>Libellé</Form.Label>
        <Form.Control value={node.label} onChange={(e) => patch({ label: e.target.value })} />
      </Form.Group>
      {issues.length > 0 && (
        <div className="small mb-2">
          {issues.map((i, idx) => (
            <div key={idx} className={i.severity === 'error' ? 'text-danger' : 'text-warning'}>
              <i className={`bi ${i.severity === 'error' ? 'bi-exclamation-circle' : 'bi-exclamation-triangle'} me-1`} />
              {i.message}
            </div>
          ))}
        </div>
      )}

      {node.type === 'trigger' && (
        <>
          <Form.Group className="mb-2">
            <Form.Label>Événement</Form.Label>
            <Form.Select value={node.event ?? 'manual'} onChange={(e) => patch({ event: e.target.value as TriggerEvent, taskFilter: e.target.value === 'task.created' ? (node.taskFilter ?? null) : null })}>
              <option value="manual">Lancement manuel ou planifié</option>
              <option value="task.created">Une tâche est créée dans le projet</option>
            </Form.Select>
            {node.event === 'task.created' && <Form.Text>La tâche est disponible comme {'{{input.task.title}}'}, {'{{input.task.id}}'}… et les sessions tournent au nom de la dernière personne à avoir enregistré ce déclencheur.</Form.Text>}
          </Form.Group>
          {node.event === 'task.created' && (
            <div className="mb-2">
              <Form.Check
                type="switch"
                id="wf-task-filter"
                label="Seulement les tâches qui remplissent des règles"
                checked={Boolean(node.taskFilter)}
                onChange={(e) => patch({ taskFilter: e.target.checked ? { kind: 'group', match: 'all', items: [{ kind: 'rule', field: 'title', operator: 'contains', value: '' }] } : null })}
              />
              {node.taskFilter && <TaskFilterEditor group={node.taskFilter} onChange={(g) => patch({ taskFilter: g })} />}
            </div>
          )}
          <VariablesEditor variables={node.variables ?? []} onChange={(variables) => patch({ variables })} />
        </>
      )}

      {node.type === 'callLlm' && (
        <>
          <LlmConfigFields llm={node.llm ?? EMPTY_LLM} onChange={(llm) => patch({ llm })} />
          <TemplateField label="Instructions (prompt système)" value={node.systemPrompt ?? ''} onChange={(systemPrompt) => patch({ systemPrompt })} paths={paths} rows={3} placeholder="Tu es un relecteur de code exigeant…" hint="Rôle et consignes permanentes du modèle." />
          <TemplateField label="Prompt *" value={node.prompt ?? ''} onChange={(prompt) => patch({ prompt })} paths={paths} rows={5} placeholder="Relis le ticket {{input.ticket}} et liste les risques." hint="Le message envoyé au modèle, rempli à l'exécution. Sa réponse est {{nodes.clé.output}}." />
          <Form.Group className="mb-2">
            <Form.Label>Format de la réponse</Form.Label>
            <Form.Select value={node.outputFormat ?? 'text'} onChange={(e) => patch({ outputFormat: e.target.value as LlmOutputFormat })}>
              <option value="text">Texte libre</option>
              <option value="json">JSON (lisible par les conditions : nodes.clé.json)</option>
            </Form.Select>
          </Form.Group>
          {node.outputFormat === 'json' && (
            <Form.Group className="mb-2">
              <Form.Label>Forme JSON attendue (montrée au modèle)</Form.Label>
              <Form.Control as="textarea" rows={3} value={node.outputSchema ?? ''} onChange={(e) => patch({ outputSchema: e.target.value })} className="font-monospace" placeholder={'{ "approved": true, "comments": ["…"] }'} />
            </Form.Group>
          )}
          <Form.Group className="mb-2">
            <Form.Label>Délai maximal (minutes)</Form.Label>
            <Form.Control type="number" min={1} value={node.timeoutMinutes ?? ''} onChange={(e) => patch({ timeoutMinutes: e.target.value ? Number(e.target.value) : null })} placeholder="10" />
          </Form.Group>
        </>
      )}

      {node.type === 'task' && (
        <>
          <TemplateField label="Tâche à traiter *" value={node.taskId ?? ''} onChange={(taskId) => patch({ taskId })} paths={paths} placeholder="{{input.task.id}}" hint="Identifiant de la tâche (celui de l'événement, ou une variable)." />
          <SessionConfig node={node} providers={providers} onChange={patch} />
          <TemplateField label="Instruction" value={node.prompt ?? ''} onChange={(prompt) => patch({ prompt })} paths={paths} rows={4} placeholder="Consignes supplémentaires…" />
          <Form.Check type="switch" id="wf-include-task" className="mb-2" label="Inclure le texte de la tâche dans l'instruction" checked={node.includeTask ?? true} onChange={(e) => patch({ includeTask: e.target.checked })} />
          <WorktreeChoice
            node={node}
            worktrees={worktrees}
            onChange={patch}
            modes={[
              { value: 'new', label: 'Un nouveau worktree pour la tâche' },
              { value: 'existing', label: 'Un worktree existant' },
              { value: 'main', label: 'Le dossier principal' },
            ]}
          />
          <Form.Check type="switch" id="wf-task-wait" className="mb-2" label="Attendre la fin du tour avant de continuer" checked={node.wait ?? true} onChange={(e) => patch({ wait: e.target.checked })} />
          <Form.Group className="mb-2">
            <Form.Label>Délai maximal (minutes)</Form.Label>
            <Form.Control type="number" min={1} value={node.timeoutMinutes ?? ''} onChange={(e) => patch({ timeoutMinutes: e.target.value ? Number(e.target.value) : null })} placeholder="60" />
          </Form.Group>
          <TemplateField label="Propriétaire de la session (optionnel)" value={node.sessionOwner ?? ''} onChange={(sessionOwner) => patch({ sessionOwner })} paths={paths} placeholder="e-mail d'un membre, ou {{input.task.assignee.email}}" hint="Vide : la personne qui a lancé l'exécution." />
        </>
      )}

      {node.type === 'session' && (
        <>
          <TemplateField label="Nom de la session" value={node.sessionName ?? ''} onChange={(sessionName) => patch({ sessionName })} paths={paths} placeholder="Revue de {{input.ticket}}" />
          <SessionConfig node={node} providers={providers} onChange={patch} />
          <TemplateField label="Instruction *" value={node.prompt ?? ''} onChange={(prompt) => patch({ prompt })} paths={paths} rows={5} />
          <WorktreeChoice
            node={node}
            worktrees={worktrees}
            onChange={patch}
            modes={[
              { value: 'main', label: 'Le dossier principal' },
              { value: 'existing', label: 'Un worktree existant' },
              { value: 'new', label: 'Un nouveau worktree' },
            ]}
          />
          {node.worktreeMode === 'new' && <TemplateField label="Branche du nouveau worktree" value={node.branch ?? ''} onChange={(branch) => patch({ branch })} paths={paths} placeholder="feat/{{input.ticket}}" />}
          <Form.Check type="switch" id="wf-session-wait" className="mb-2" label="Attendre la fin du tour avant de continuer" checked={node.wait ?? true} onChange={(e) => patch({ wait: e.target.checked })} />
          <Form.Check type="switch" id="wf-session-end" className="mb-2" label="Terminer la session après son tour" checked={node.endAfterTurn ?? false} onChange={(e) => patch({ endAfterTurn: e.target.checked })} />
          <Form.Group className="mb-2">
            <Form.Label>Délai maximal (minutes)</Form.Label>
            <Form.Control type="number" min={1} value={node.timeoutMinutes ?? ''} onChange={(e) => patch({ timeoutMinutes: e.target.value ? Number(e.target.value) : null })} placeholder="60" />
          </Form.Group>
          <TemplateField label="Propriétaire de la session (optionnel)" value={node.sessionOwner ?? ''} onChange={(sessionOwner) => patch({ sessionOwner })} paths={paths} placeholder="e-mail d'un membre" hint="Vide : la personne qui a lancé l'exécution." />
        </>
      )}

      {node.type === 'createTask' && (
        <>
          <TemplateField label="Titre *" value={newTask.title} onChange={(title) => setTask({ title })} paths={paths} />
          <TemplateField label="Description" value={newTask.description} onChange={(description) => setTask({ description })} paths={paths} rows={4} />
          <TemplateField label="Priorité" value={newTask.priority} onChange={(priority) => setTask({ priority })} paths={paths} placeholder="low, medium, high, urgent" />
          <TemplateField label="Statut" value={newTask.status} onChange={(status) => setTask({ status })} paths={paths} placeholder="todo (défaut), in_progress…" />
          <TemplateField label="Échéance" value={newTask.dueDate} onChange={(dueDate) => setTask({ dueDate })} paths={paths} placeholder="AAAA-MM-JJ" />
          <TemplateField label="Responsable" value={newTask.assignee} onChange={(assignee) => setTask({ assignee })} paths={paths} placeholder="Nom <email> ou e-mail" />
          <TemplateField label="Rapporteur" value={newTask.reporter} onChange={(reporter) => setTask({ reporter })} paths={paths} />
          <Form.Label>Champs personnalisés</Form.Label>
          {newTask.fields.map((f, i) => (
            <div key={i} className="d-flex gap-1 mb-1">
              <Form.Control size="sm" value={f.key} onChange={(e) => setTask({ fields: newTask.fields.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} placeholder="clé" />
              <Form.Control size="sm" value={f.value} onChange={(e) => setTask({ fields: newTask.fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} placeholder="valeur ou {{…}}" />
              <button type="button" className="auto-icon-btn" onClick={() => setTask({ fields: newTask.fields.filter((_, j) => j !== i) })}>
                <i className="bi bi-x-lg" />
              </button>
            </div>
          ))}
          <Button size="sm" variant="outline-secondary" onClick={() => setTask({ fields: [...newTask.fields, { key: '', value: '' }] })}>
            <i className="bi bi-plus-lg me-1" /> Champ
          </Button>
        </>
      )}

      {node.type === 'condition' && (
        <>
          <div className="d-flex gap-3 mb-2">
            <Form.Check type="radio" inline id="wf-cond-visual" name="wf-cond-mode" label="Règles" checked={conditionMode === 'visual'} onChange={() => setConditionMode('visual')} />
            <Form.Check type="radio" inline id="wf-cond-expr" name="wf-cond-mode" label="Formule" checked={conditionMode === 'expression'} onChange={() => setConditionMode('expression')} />
          </div>
          {conditionMode === 'visual' ? (
            <RuleGroupEditor group={node.condition ?? { kind: 'group', match: 'all', items: [] }} onChange={(condition: ConditionGroup) => patch({ condition, expression: '' })} paths={paths.map((p) => p.path)} />
          ) : (
            <Form.Group className="mb-2">
              <Form.Label>Formule</Form.Label>
              <Form.Control as="textarea" rows={3} value={node.expression ?? ''} onChange={(e) => patch({ expression: e.target.value, condition: null })} className="font-monospace" placeholder='nodes.review.json.approved == true' />
              <PathChips paths={paths} onPick={(ph) => patch({ expression: `${node.expression ?? ''}${ph.slice(2, -2)}`, condition: null })} />
              <Form.Text>{EXPRESSION_HELP}</Form.Text>
            </Form.Group>
          )}
        </>
      )}

      {node.type === 'end' && <TemplateField label="Sortie de l'exécution" value={node.message ?? ''} onChange={(message) => patch({ message })} paths={paths} rows={4} placeholder="{{nodes.review.output}}" hint="Rendue à la fin ; visible sur la page de l'exécution et dans la notification." />}
    </div>
  );
}
