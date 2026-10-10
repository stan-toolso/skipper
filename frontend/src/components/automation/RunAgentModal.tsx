import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { RUN_AGENT, type Agent, type AgentRun } from '../../graphql/automation';
import InputsForm, { inputsFromRecord, inputsPayload, missingInputs } from './InputsForm';

/** Lancement d'un agent : une valeur par variable, option « test » (l'exécution est marquée comme telle). */
export default function RunAgentModal({ agent, onClose, onStarted }: { agent: Agent; onClose: () => void; onStarted: (run: AgentRun) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => inputsFromRecord(agent.scheduleInputs));
  const [test, setTest] = useState(false);
  const [run, { loading, error }] = useMutation<{ runAgent: AgentRun }>(RUN_AGENT, { refetchQueries: ['AgentRuns', 'Agent'] });
  const missing = missingInputs(agent.inputs, values);
  return (
    <Modal show onHide={onClose} centered>
      <Form
        onSubmit={async (e) => {
          e.preventDefault();
          if (missing.length) return;
          const res = await run({ variables: { id: agent.id, inputs: inputsPayload(values), test } }).catch(() => null);
          if (res?.data) onStarted(res.data.runAgent);
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h5">Exécuter « {agent.name} »</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <InputsForm variables={agent.inputs} values={values} onChange={setValues} idPrefix="run" />
          {missing.length > 0 && <div className="small text-warning">À renseigner : {missing.join(', ')}.</div>}
          <Form.Check className="mt-3" type="switch" id="run-agent-test" label="Exécution de test (marquée comme telle dans l'historique)" checked={test} onChange={(e) => setTest(e.target.checked)} />
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
          <Button type="submit" disabled={loading || missing.length > 0}>
            <i className="bi bi-play-fill me-1" /> {loading ? 'Lancement…' : 'Exécuter'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
