import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, ButtonGroup, Col, Form, Nav, Row, Spinner, Table } from 'react-bootstrap';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTabTitle } from '../workbench/TabsContext';
import {
  CONTEXT_INSTRUCTION,
  CREATE_CONTEXT_FOLDER,
  CREATE_CONTEXT_INSTRUCTION,
  DELETE_CONTEXT_FOLDER,
  DELETE_CONTEXT_INSTRUCTION,
  PROJECT_CONTEXT,
  RENAME_CONTEXT_FOLDER,
  RESTORE_CONTEXT_INSTRUCTION_VERSION,
  UPDATE_CONTEXT_INSTRUCTION,
  type ContextChange,
  type ContextFolder,
  type ContextInstruction,
} from '../graphql/operations';

interface ProjectContext {
  id: string;
  name: string;
  contextFolders: ContextFolder[];
  contextInstructions: ContextInstruction[];
  contextChanges: ContextChange[];
}

const changeLabels: Record<string, string> = {
  'folder.create': 'Dossier créé',
  'folder.rename': 'Dossier renommé',
  'folder.move': 'Dossier déplacé',
  'folder.delete': 'Dossier supprimé',
  'instruction.create': 'Instruction créée',
  'instruction.update': 'Instruction modifiée',
  'instruction.move': 'Instruction déplacée',
  'instruction.delete': 'Instruction supprimée',
  'instruction.restore': 'Version restaurée',
};

function Author({ type, session }: { type: 'human' | 'agent'; session: { id: string; name: string } | null }) {
  if (type === 'agent') {
    return (
      <Badge bg="primary" title="Modifié par un agent">
        {session ? <Link to={`/sessions/${session.id}`} className="text-reset text-decoration-none">agent · {session.name}</Link> : 'agent'}
      </Badge>
    );
  }
  return <Badge bg="secondary">humain</Badge>;
}

/** Arbre dossiers / instructions avec sélection et actions rapides. */
function Tree({
  folders,
  instructions,
  selectedId,
  onSelect,
  onNewFolder,
  onNewInstruction,
  onRenameFolder,
  onDeleteFolder,
}: {
  folders: ContextFolder[];
  instructions: ContextInstruction[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewFolder: (parentId: string | null) => void;
  onNewInstruction: (folderId: string | null) => void;
  onRenameFolder: (folder: ContextFolder) => void;
  onDeleteFolder: (folder: ContextFolder) => void;
}) {
  const render = (parentId: string | null, depth: number): React.ReactNode => (
    <>
      {folders
        .filter((f) => f.parentId === parentId)
        .map((f) => (
          <div key={f.id}>
            <div className="d-flex align-items-center justify-content-between tree-row" style={{ paddingLeft: depth * 14 }}>
              <span className="text-secondary">
                <i className="bi bi-folder2 me-1" />
                {f.name}
              </span>
              <ButtonGroup size="sm" className="tree-actions">
                <Button variant="link" className="p-0 px-1 text-secondary" title="Nouvelle instruction ici" onClick={() => onNewInstruction(f.id)}>
                  +📄
                </Button>
                <Button variant="link" className="p-0 px-1 text-secondary" title="Nouveau sous-dossier" onClick={() => onNewFolder(f.id)}>
                  +📁
                </Button>
                <Button variant="link" className="p-0 px-1 text-secondary" title="Renommer" onClick={() => onRenameFolder(f)}>
                  ✎
                </Button>
                <Button variant="link" className="p-0 px-1 text-danger" title="Supprimer le dossier et son contenu" onClick={() => onDeleteFolder(f)}>
                  ✕
                </Button>
              </ButtonGroup>
            </div>
            {render(f.id, depth + 1)}
          </div>
        ))}
      {instructions
        .filter((i) => i.folderId === parentId)
        .map((i) => (
          <div
            key={i.id}
            className={`tree-row${i.id === selectedId ? ' selected' : ''}`}
            style={{ paddingLeft: depth * 14, cursor: 'pointer' }}
            onClick={() => onSelect(i.id)}
            title={i.description}
          >
            <i className="bi bi-file-text me-1" />
            {i.name} <span className="text-secondary small">v{i.version}</span>
          </div>
        ))}
    </>
  );
  return (
    <div className="context-tree">
      <style>{`
        .tree-row { padding: 2px 6px; border-radius: 4px; }
        .tree-row:hover { background: var(--cc-bg-hover); }
        .tree-row.selected { background: var(--cc-bg-hover); color: var(--cc-accent); }
        .tree-actions { visibility: hidden; }
        .tree-row:hover .tree-actions { visibility: visible; }
      `}</style>
      {render(null, 0)}
      {folders.length === 0 && instructions.length === 0 && <div className="text-secondary small">Rien pour l'instant. Les agents y rangeront ce qu'ils apprennent, et vous pouvez commencer à y écrire.</div>}
    </div>
  );
}

/** Éditeur d'une instruction : contenu, description, déplacement, versions. */
function InstructionEditor({ id, folders, onDeleted }: { id: string; folders: ContextFolder[]; onDeleted: () => void }) {
  const { data, loading, error, refetch } = useQuery<{ contextInstruction: ContextInstruction | null }>(CONTEXT_INSTRUCTION, { variables: { id } });
  const [update, { loading: saving, error: saveError }] = useMutation(UPDATE_CONTEXT_INSTRUCTION, { refetchQueries: ['ProjectContext', 'ContextInstruction'] });
  const [restore, { loading: restoring }] = useMutation(RESTORE_CONTEXT_INSTRUCTION_VERSION, { refetchQueries: ['ProjectContext', 'ContextInstruction'] });
  const [remove] = useMutation(DELETE_CONTEXT_INSTRUCTION, { refetchQueries: ['ProjectContext'], onCompleted: onDeleted });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [folderId, setFolderId] = useState<string>('');
  const [changeNote, setChangeNote] = useState('');
  const [viewVersion, setViewVersion] = useState<number | null>(null);

  const instruction = data?.contextInstruction;
  useEffect(() => {
    if (!instruction) return;
    setName(instruction.name);
    setDescription(instruction.description);
    setContent(instruction.content);
    setFolderId(instruction.folderId ?? '');
    setChangeNote('');
    setViewVersion(null);
  }, [instruction?.id, instruction?.version]);

  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">{error.message}</Alert>;
  if (!instruction) return <Alert variant="warning">Instruction introuvable.</Alert>;

  const dirty = name !== instruction.name || description !== instruction.description || content !== instruction.content || (folderId || null) !== instruction.folderId;
  const shown = viewVersion !== null ? instruction.versions?.find((v) => v.version === viewVersion) : null;

  const save = () =>
    update({ variables: { id, input: { name, description, content, folderId: folderId || null, changeNote: changeNote || null } } }).then(() => refetch());

  return (
    <>
      <div className="d-flex justify-content-between align-items-start mb-2">
        <div>
          <code className="text-secondary">{instruction.path}</code> <Badge bg="secondary">v{instruction.version}</Badge>
        </div>
        <Button
          size="sm"
          variant="outline-danger"
          onClick={() => {
            if (window.confirm(`Supprimer l'instruction « ${instruction.name} » ?`)) remove({ variables: { id } });
          }}
        >
          Supprimer
        </Button>
      </div>

      {shown ? (
        <Alert variant="warning" className="d-flex justify-content-between align-items-center">
          <span>
            Version {shown.version} du {new Date(shown.createdAt).toLocaleString()} <Author type={shown.authorType} session={shown.authorSession} />
            {shown.changeNote && <span className="ms-2 text-secondary">{shown.changeNote}</span>}
          </span>
          <span>
            <Button size="sm" variant="outline-primary" className="me-2" disabled={restoring} onClick={() => restore({ variables: { id, version: shown.version } })}>
              Restaurer cette version
            </Button>
            <Button size="sm" variant="outline-secondary" onClick={() => setViewVersion(null)}>
              Revenir à la version courante
            </Button>
          </span>
        </Alert>
      ) : null}

      <Row className="g-2 mb-2">
        <Col md={5}>
          <Form.Control size="sm" value={shown ? shown.name : name} disabled={Boolean(shown)} onChange={(e) => setName(e.target.value)} placeholder="Nom" />
        </Col>
        <Col md={7}>
          <Form.Control size="sm" value={shown ? shown.description : description} disabled={Boolean(shown)} onChange={(e) => setDescription(e.target.value)} placeholder="Description (une phrase, sert de description de skill)" />
        </Col>
      </Row>
      <Form.Control
        as="textarea"
        rows={16}
        className="font-monospace small mb-2"
        value={shown ? shown.content : content}
        disabled={Boolean(shown)}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Contenu Markdown de l'instruction"
      />
      {!shown && (
        <Row className="g-2 align-items-center mb-3">
          <Col md={4}>
            <Form.Select size="sm" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">(racine)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}/
                </option>
              ))}
            </Form.Select>
          </Col>
          <Col md={5}>
            <Form.Control size="sm" value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="Note de version (optionnelle)" />
          </Col>
          <Col md={3} className="text-end">
            <Button size="sm" disabled={!dirty || saving} onClick={save}>
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </Col>
        </Row>
      )}
      {saveError && <Alert variant="danger">{saveError.message}</Alert>}

      <h3 className="h6 mt-3">Versions</h3>
      <Table size="sm" hover className="small">
        <tbody>
          {(instruction.versions ?? []).map((v) => (
            <tr key={v.id} className={v.version === viewVersion ? 'table-active' : undefined} style={{ cursor: 'pointer' }} onClick={() => setViewVersion(v.version === instruction.version ? null : v.version)}>
              <td className="text-nowrap">
                v{v.version}
                {v.version === instruction.version && <span className="text-secondary"> (courante)</span>}
              </td>
              <td className="text-secondary text-nowrap">{new Date(v.createdAt).toLocaleString()}</td>
              <td>
                <Author type={v.authorType} session={v.authorSession} />
              </td>
              <td className="text-secondary">{v.changeNote ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

/** Page « Contexte » d'un projet : arbre, éditeur versionné et journal des modifications. */
export default function ContextPage() {
  const { id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('instruction');
  const [tab, setTab] = useState<'library' | 'changes'>('library');

  const { data, loading, error } = useQuery<{ project: ProjectContext | null }>(PROJECT_CONTEXT, { variables: { id }, pollInterval: 5000 });
  const [createFolder, { error: folderError }] = useMutation(CREATE_CONTEXT_FOLDER, { refetchQueries: ['ProjectContext'] });
  const [renameFolder] = useMutation(RENAME_CONTEXT_FOLDER, { refetchQueries: ['ProjectContext'] });
  const [deleteFolder] = useMutation(DELETE_CONTEXT_FOLDER, { refetchQueries: ['ProjectContext'] });
  const [createInstruction, { error: instructionError }] = useMutation<{ createContextInstruction: ContextInstruction }>(CREATE_CONTEXT_INSTRUCTION, {
    refetchQueries: ['ProjectContext'],
    onCompleted: (res) => setSearchParams({ instruction: res.createContextInstruction.id }),
  });

  const project = data?.project;
  useTabTitle(project ? `Contexte · ${project.name}` : null);
  const folders = useMemo(() => project?.contextFolders ?? [], [project]);
  const instructions = useMemo(() => project?.contextInstructions ?? [], [project]);

  const newFolder = (parentId: string | null) => {
    const name = window.prompt('Nom du dossier');
    if (name?.trim()) createFolder({ variables: { projectId: id, parentId, name: name.trim() } });
  };
  const newInstruction = (folderId: string | null) => {
    const name = window.prompt("Nom de l'instruction");
    if (name?.trim()) createInstruction({ variables: { input: { projectId: id, folderId, name: name.trim(), content: '' } } });
  };

  if (loading && !data) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const mutationError = folderError ?? instructionError;

  return (
    <>
      <Link to={`/projects/${id}`} className="small">
        ← {project.name}
      </Link>
      <div className="d-flex align-items-center justify-content-between mb-2">
        <h1 className="h3 mb-0">Contexte</h1>
        <ButtonGroup size="sm">
          <Button variant="outline-primary" onClick={() => newInstruction(null)}>
            Nouvelle instruction
          </Button>
          <Button variant="outline-secondary" onClick={() => newFolder(null)}>
            Nouveau dossier
          </Button>
        </ButtonGroup>
      </div>
      <p className="text-secondary small" style={{ maxWidth: 760 }}>
        La mémoire du projet : les règles, décisions et connaissances que les agents consultent avant d'agir et complètent au fil de leur travail. Chaque
        modification est conservée, vous pouvez revenir à une version précédente à tout moment.
      </p>
      {mutationError && <Alert variant="danger">{mutationError.message}</Alert>}

      <Nav variant="tabs" activeKey={tab} onSelect={(k) => setTab((k as 'library' | 'changes') ?? 'library')} className="mb-3">
        <Nav.Item>
          <Nav.Link eventKey="library">Bibliothèque</Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="changes">Journal ({project.contextChanges.length})</Nav.Link>
        </Nav.Item>
      </Nav>

      {tab === 'library' && (
        <Row className="g-3">
          <Col md={4} lg={3}>
            <Tree
              folders={folders}
              instructions={instructions}
              selectedId={selectedId}
              onSelect={(iid) => setSearchParams({ instruction: iid })}
              onNewFolder={newFolder}
              onNewInstruction={newInstruction}
              onRenameFolder={(f) => {
                const name = window.prompt('Nouveau nom du dossier', f.name);
                if (name?.trim() && name.trim() !== f.name) renameFolder({ variables: { id: f.id, name: name.trim() } });
              }}
              onDeleteFolder={(f) => {
                if (window.confirm(`Supprimer le dossier « ${f.path} » et tout son contenu ?`)) deleteFolder({ variables: { id: f.id } });
              }}
            />
          </Col>
          <Col md={8} lg={9}>
            {selectedId ? (
              <InstructionEditor id={selectedId} folders={folders} onDeleted={() => setSearchParams({})} />
            ) : (
              <div className="text-secondary">Sélectionnez une instruction dans l'arbre, ou créez-en une.</div>
            )}
          </Col>
        </Row>
      )}

      {tab === 'changes' && (
        <Table hover responsive size="sm" className="align-middle small">
          <thead>
            <tr>
              <th>Date</th>
              <th>Opération</th>
              <th>Chemin</th>
              <th>Auteur</th>
              <th>Détails</th>
            </tr>
          </thead>
          <tbody>
            {project.contextChanges.length === 0 && (
              <tr>
                <td colSpan={5} className="text-secondary">
                  Aucune modification.
                </td>
              </tr>
            )}
            {project.contextChanges.map((c) => (
              <tr key={c.id}>
                <td className="text-secondary text-nowrap">{new Date(c.createdAt).toLocaleString()}</td>
                <td>{changeLabels[c.kind] ?? c.kind}</td>
                <td>
                  <code>{c.path}</code>
                  {typeof c.details.from === 'string' && <span className="text-secondary"> ← {String(c.details.from)}</span>}
                </td>
                <td>
                  <Author type={c.authorType} session={c.authorSession} />
                </td>
                <td className="text-secondary">
                  {typeof c.details.version === 'number' && `v${c.details.version} `}
                  {typeof c.details.changeNote === 'string' && c.details.changeNote}
                  {typeof c.details.restoredVersion === 'number' && `depuis v${c.details.restoredVersion}`}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
