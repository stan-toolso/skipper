import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { RUN_WORKFLOW, WORKFLOW_VARIABLES, type InputVariable, type Workflow, type WorkflowRun } from '../../../graphql/automation';
import InputsForm, { inputsFromRecord, inputsPayload, missingInputs } from '../InputsForm';

/** Lancement d'un workflow : déclencheur de départ (s'il y en a plusieurs), valeurs de ses variables, option test. */
export default function RunWorkflowModal({ workflow, onClose, onStarted }: { workflow: Workflow; onClose: () => void; onStarted: (run: WorkflowRun) => void }) {
  const triggers = workflow.definition.nodes.filter((n) => n.type === 'trigger');
  const [triggerKey, setTriggerKey] = useState(() => (triggers.find((t) => (t.event ?? 'manual') === 'manual') ?? triggers[0])?.key ?? '');
  const { data } = useQuery<{ workflow: { variables: InputVariable[] } | null }>(WORKFLOW_VARIABLES, { variables: { id: workflow.id, triggerKey: triggerKey || null }, fetchPolicy: 'cache-and-network' });
  const variables = data?.workflow?.variables ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => inputsFromRecord(workflow.scheduleInputs));
  const [test, setTest] = useState(false);
  const [run, { loading, error }] = useMutation<{ runWorkflow: WorkflowRun }>(RUN_WORKFLOW, { refetchQueries: ['WorkflowRuns', 'Workflow'] });
  const missing = missingInputs(variables, values);
  const errors = workflow.issues.filter((i) => i.severity === 'error');
  return (
    <Modal show onHide={onClose} centered>
      <Form
        onSubmit={async (e) => {
          e.preventDefault();
          if (missing.length || errors.length) return;
          const res = await run({ variables: { id: workflow.id, inputs: inputsPayload(values), test, triggerKey: triggerKey || null } }).catch(() => null);
          if (res?.data) onStarted(res.data.runWorkflow);
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h5">Exécuter « {workflow.name} »</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {errors.length > 0 && (
            <Alert variant="danger" className="py-2">
              Le graphe a {errors.length} erreur{errors.length > 1 ? 's' : ''} : corrigez-les avant de lancer.
            </Alert>
          )}
          {triggers.length > 1 && (
            <Form.Group className="mb-3">
              <Form.Label>Déclencheur de départ</Form.Label>
              <Form.Select value={triggerKey} onChange={(e) => setTriggerKey(e.target.value)}>
                {triggers.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label} ({t.event === 'task.created' ? 'tâche créée' : 'manuel'})
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          )}
          <InputsForm variables={variables} values={values} onChange={setValues} idPrefix="wfrun" />
          {missing.length > 0 && <div className="small text-warning">À renseigner : {missing.join(', ')}.</div>}
          <Form.Check className="mt-3" type="switch" id="run-workflow-test" label="Exécution de test (marquée comme telle dans l'historique)" checked={test} onChange={(e) => setTest(e.target.checked)} />
          {error && (
            <Alert variant="danger" className="mt-3 mb-0 py-2">
              {error.message}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || missing.length > 0 || errors.length > 0}>
            <i className="bi bi-play-fill me-1" /> {loading ? 'Lancement…' : 'Exécuter'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
