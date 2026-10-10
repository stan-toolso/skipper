import { useState } from 'react';
import { Form } from 'react-bootstrap';
import type { WorkflowRunLog } from '../../../graphql/automation';
import { prettyJson } from '../../../lib/automation';
import { clockTime } from '../../../lib/humanize';

const LEVELS: WorkflowRunLog['level'][] = ['debug', 'info', 'warn', 'error'];

/** Journal d'une exécution de workflow : filtre par niveau et par nœud. */
export default function RunLogs({ logs, nodeKey, onPickNode }: { logs: WorkflowRunLog[]; nodeKey?: string | null; onPickNode?: (key: string | null) => void }) {
  const [minLevel, setMinLevel] = useState<WorkflowRunLog['level']>('info');
  const shown = logs.filter((l) => LEVELS.indexOf(l.level) >= LEVELS.indexOf(minLevel) && (!nodeKey || l.nodeKey === nodeKey));
  return (
    <div>
      <div className="d-flex gap-2 align-items-center mb-2 small">
        <Form.Select size="sm" style={{ width: 'auto' }} value={minLevel} onChange={(e) => setMinLevel(e.target.value as WorkflowRunLog['level'])}>
          <option value="debug">Tout (debug)</option>
          <option value="info">Info et plus</option>
          <option value="warn">Avertissements et erreurs</option>
          <option value="error">Erreurs</option>
        </Form.Select>
        {nodeKey && onPickNode && (
          <span>
            nœud <code>{nodeKey}</code>{' '}
            <button type="button" className="btn btn-link btn-sm p-0" onClick={() => onPickNode(null)}>
              tout voir
            </button>
          </span>
        )}
        <span className="text-secondary ms-auto">
          {shown.length} / {logs.length}
        </span>
      </div>
      <div className="wf-logs">
        {shown.length === 0 && <div className="p-2 text-secondary">Rien à afficher.</div>}
        {shown.map((l) => (
          <div key={l.id} className={`wf-log ${l.level}`}>
            <span className="time">{clockTime(l.createdAt)}</span>
            <span className="node" role={l.nodeKey && onPickNode ? 'button' : undefined} onClick={() => l.nodeKey && onPickNode?.(l.nodeKey)} title={l.nodeKey ?? ''}>
              {l.nodeKey ?? '—'}
            </span>
            <span className="msg">
              {l.message}
              {l.data !== null && l.data !== undefined && (
                <details>
                  <summary className="text-secondary">détails</summary>
                  <pre>{prettyJson(l.data)}</pre>
                </details>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
