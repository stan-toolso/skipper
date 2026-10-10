import { Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type Connection, type Edge, type EdgeChange, type NodeChange, type OnConnect } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useRef } from 'react';
import type { EdgeHandle, WorkflowDefinition, WorkflowIssue, WorkflowNodeType } from '../../../graphql/automation';
import { edgeId, edgeLabel, newNode, nodeSummary } from '../../../lib/workflowGraph';
import { nodeTypes, type WfNode } from './nodes';

interface Props {
  definition: WorkflowDefinition;
  /** Lecture seule (page d'une exécution) : ni déplacement ni connexion. */
  readonly?: boolean;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onChange?: (def: WorkflowDefinition) => void;
  issues?: WorkflowIssue[];
  /** Statut de chaque nœud (exécution). */
  statuses?: Record<string, string>;
  agents?: { id: string; name: string }[];
}

const MIME = 'application/skipper-workflow-node';

function CanvasInner({ definition, readonly = false, selectedKey, onSelect, onChange, issues = [], statuses = {}, agents = [] }: Props) {
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  const nodes = useMemo<WfNode[]>(
    () =>
      definition.nodes.map((n) => {
        const mine = issues.filter((i) => i.nodeKey === n.key);
        return {
          id: n.key,
          type: 'wf',
          position: n.position,
          selected: n.key === selectedKey,
          draggable: !readonly,
          connectable: !readonly,
          data: { node: n, summary: nodeSummary(n, agents), status: statuses[n.key] ?? null, issue: mine.some((i) => i.severity === 'error') ? 'error' : mine.length ? 'warning' : null },
        };
      }),
    [definition.nodes, selectedKey, readonly, issues, statuses, agents],
  );
  const edges = useMemo<Edge[]>(
    () =>
      definition.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? 'default',
        label: edgeLabel(e),
        markerEnd: { type: MarkerType.ArrowClosed },
        deletable: !readonly,
        animated: statuses[e.source] === 'running',
        style: issues.some((i) => i.edgeId === e.id) ? { stroke: 'var(--cc-red)' } : undefined,
      })),
    [definition.edges, readonly, statuses, issues],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<WfNode>[]) => {
      if (!onChange) return;
      let def = definition;
      let touched = false;
      for (const c of changes) {
        if (c.type === 'position' && c.position && !Number.isNaN(c.position.x)) {
          def = { ...def, nodes: def.nodes.map((n) => (n.key === c.id ? { ...n, position: { x: Math.round(c.position!.x), y: Math.round(c.position!.y) } } : n)) };
          touched = true;
        } else if (c.type === 'remove') {
          def = { ...def, nodes: def.nodes.filter((n) => n.key !== c.id), edges: def.edges.filter((e) => e.source !== c.id && e.target !== c.id) };
          touched = true;
          if (selectedKey === c.id) onSelect(null);
        } else if (c.type === 'select') {
          if (c.selected) onSelect(c.id);
          else if (selectedKey === c.id) onSelect(null);
        }
      }
      if (touched) onChange(def);
    },
    [definition, onChange, onSelect, selectedKey],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      if (!onChange) return;
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id));
      if (removed.size) onChange({ ...definition, edges: definition.edges.filter((e) => !removed.has(e.id)) });
    },
    [definition, onChange],
  );
  const onConnect = useCallback<OnConnect>(
    (c: Connection) => {
      if (!onChange || !c.source || !c.target || c.source === c.target) return;
      const handle = (c.sourceHandle ?? 'default') as EdgeHandle;
      const id = edgeId(c.source, c.target, handle);
      if (definition.edges.some((e) => e.id === id)) return;
      onChange({ ...definition, edges: [...definition.edges, { id, source: c.source, target: c.target, sourceHandle: handle }] });
    },
    [definition, onChange],
  );

  // Dépôt d'un type de nœud depuis la palette.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData(MIME) as WorkflowNodeType;
      if (!type || !onChange) return;
      const position = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const node = newNode(definition, type, { x: Math.round(position.x - 110), y: Math.round(position.y - 30) });
      onChange({ ...definition, nodes: [...definition.nodes, node] });
      onSelect(node.key);
    },
    [definition, flow, onChange, onSelect],
  );

  return (
    <div className="wf-canvas h-100" ref={wrapper} onDrop={onDrop} onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'move'))}>
      <ReactFlow<WfNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={!readonly}
        nodesConnectable={!readonly}
        elementsSelectable
        deleteKeyCode={readonly ? null : ['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        colorMode="system"
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false} />
        {definition.nodes.length > 6 && <MiniMap pannable zoomable />}
      </ReactFlow>
    </div>
  );
}

/** Canevas du graphe d'un workflow (édition ou lecture seule). */
export default function WorkflowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

/** Attache le type de nœud à un glisser-déposer depuis la palette. */
export function dragNodeType(e: React.DragEvent, type: WorkflowNodeType): void {
  e.dataTransfer.setData(MIME, type);
  e.dataTransfer.effectAllowed = 'move';
}
