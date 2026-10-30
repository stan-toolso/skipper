import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { WorkflowNode } from '../../../graphql/automation';
import { nodeStatusLabels, nodeTypeInfo } from '../../../lib/automation';
import { FALLIBLE_TYPES } from '../../../lib/workflowGraph';

/** Données d'un nœud du canevas : le nœud du workflow, son résumé, son état d'exécution et ses problèmes. */
export interface WfNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  summary: string;
  status?: string | null;
  /** Gravité la plus forte des problèmes du nœud. */
  issue?: 'error' | 'warning' | null;
}

export type WfNode = Node<WfNodeData, 'wf'>;

/** Rendu d'un nœud : bande de type, libellé, résumé, poignées d'entrée et de sortie selon le type. */
export function WfNodeView({ data, selected }: NodeProps<WfNode>) {
  const { node, summary, status, issue } = data;
  const info = nodeTypeInfo[node.type] ?? { label: node.type, icon: 'bi-question-circle', hint: '' };
  const classes = ['wf-node', `type-${node.type}`, selected ? 'selected' : '', status ? `status-${status}` : '', issue === 'error' ? 'has-error' : issue === 'warning' ? 'has-issue' : ''].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      {node.type !== 'trigger' && <Handle type="target" position={Position.Left} className="wf-handle" />}
      <div className="wf-node-head">
        <i className={`bi ${info.icon}`} />
        <span className="text-truncate">{node.label}</span>
        <span className="wf-node-type">{info.label}</span>
        {issue && <i className={`bi ${issue === 'error' ? 'bi-exclamation-circle-fill text-danger' : 'bi-exclamation-triangle-fill text-warning'}`} title={issue === 'error' ? 'Erreur' : 'Avertissement'} />}
      </div>
      <div className="wf-node-body" title={summary}>
        {summary}
      </div>
      {status && <div className={`wf-node-status ${status}`}>{nodeStatusLabels[status] ?? status}</div>}
      {node.type === 'condition' ? (
        <>
          <Handle type="source" id="true" position={Position.Right} className="wf-handle true" style={{ top: '35%' }} />
          <span className="wf-handle-label" style={{ top: 'calc(35% - 7px)' }}>
            oui
          </span>
          <Handle type="source" id="false" position={Position.Right} className="wf-handle false" style={{ top: '70%' }} />
          <span className="wf-handle-label" style={{ top: 'calc(70% - 7px)' }}>
            non
          </span>
        </>
      ) : node.type !== 'end' ? (
        <>
          <Handle type="source" id="default" position={Position.Right} className="wf-handle" style={FALLIBLE_TYPES.includes(node.type) ? { top: '40%' } : undefined} />
          {FALLIBLE_TYPES.includes(node.type) && (
            <>
              <Handle type="source" id="error" position={Position.Bottom} className="wf-handle error" />
              <span className="wf-handle-label" style={{ bottom: -14, right: 'auto', left: 'calc(50% + 8px)', transform: 'none' }}>
                erreur
              </span>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

export const nodeTypes = { wf: WfNodeView };
