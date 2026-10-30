import { useMutation, useQuery } from '@apollo/client';
import { usePollingQuery } from '../lib/usePollingQuery';
import PageLoading, { ProjectPageLoading } from '../components/PageLoading';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Form, Nav, Table } from 'react-bootstrap';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTabTitle } from '../workbench/TabsContext';
import ProjectHeader from '../components/ProjectHeader';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useDialogs } from '../components/Dialogs';
import Markdown from '../components/Markdown';
import MarkdownEditor from '../components/MarkdownEditor';
import './context.css';

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
  type ContextInstructionVersion,
} from '../graphql/operations';

interface ProjectContext {
  id: string;
  name: string;
  description: string | null;
  myRole: 'ADMIN' | 'MEMBER' | 'VIEWER';
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

const fmtDate = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Auteur d'une version ou d'une modification : « humain », ou « agent · nom de la session » (lien vers la session). */
function Author({ type, session }: { type: 'human' | 'agent'; session: { id: string; name: string } | null }) {
  if (type === 'agent') {
    return (
      <span className="ctx-author" title="Modifié par un agent">
        <i className="bi bi-robot me-1" />
        {session ? <Link to={`/sessions/${session.id}`}>{session.name}</Link> : 'agent'}
      </span>
    );
  }
  return (
    <span className="ctx-author">
      <i className="bi bi-person me-1" />
      humain
    </span>
  );
}

const normalize = (s: string) => s.toLocaleLowerCase('fr-FR').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Arbre dossiers / instructions : dossiers repliables, filtre par texte, actions au survol. */
function Tree({
  folders,
  instructions,
  selectedId,
  filter,
  onSelect,
  onNewFolder,
  onNewInstruction,
  onRenameFolder,
  onDeleteFolder,
}: {
  folders: ContextFolder[];
  instructions: ContextInstruction[];
  selectedId: string | null;
  filter: string;
  onSelect: (id: string) => void;
  onNewFolder: (parentId: string | null) => void;
  onNewInstruction: (folderId: string | null) => void;
  onRenameFolder: (folder: ContextFolder) => void;
  onDeleteFolder: (folder: ContextFolder) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Filtre : instructions dont le nom, le chemin ou la description contient le texte ; les dossiers ne restent que s'ils en contiennent.
  const q = normalize(filter.trim());
  const { visibleInstructions, visibleFolders } = useMemo(() => {
    if (!q) return { visibleInstructions: instructions, visibleFolders: folders };
    const kept = instructions.filter((i) => normalize(`${i.path} ${i.description}`).includes(q));
    const folderById = new Map(folders.map((f) => [f.id, f]));
    const keptFolders = new Set<string>();
    for (const i of kept) {
      let fid = i.folderId;
      while (fid && !keptFolders.has(fid)) {
        keptFolders.add(fid);
        fid = folderById.get(fid)?.parentId ?? null;
      }
    }
    return { visibleInstructions: kept, visibleFolders: folders.filter((f) => keptFolders.has(f.id)) };
  }, [q, folders, instructions]);

  const render = (parentId: string | null, depth: number): React.ReactNode => (
    <>
      {visibleFolders
        .filter((f) => f.parentId === parentId)
        .map((f) => {
          const open = q ? true : !collapsed.has(f.id);
          return (
            <div key={f.id}>
              <div className="ctx-row ctx-folder" style={{ paddingLeft: 6 + depth * 16 }} onClick={() => toggle(f.id)} title={f.path}>
                <i className={`bi bi-chevron-${open ? 'down' : 'right'} ctx-row-chevron`} />
                <i className={`bi ${open ? 'bi-folder2-open' : 'bi-folder2'} ctx-row-icon`} />
                <span className="ctx-row-name">{f.name}</span>
                <span className="ctx-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="ctx-icon-btn" title="Nouvelle instruction dans ce dossier" onClick={() => onNewInstruction(f.id)}>
                    <i className="bi bi-file-earmark-plus" />
                  </button>
                  <button type="button" className="ctx-icon-btn" title="Nouveau sous-dossier" onClick={() => onNewFolder(f.id)}>
                    <i className="bi bi-folder-plus" />
                  </button>
                  <button type="button" className="ctx-icon-btn" title="Renommer le dossier" onClick={() => onRenameFolder(f)}>
                    <i className="bi bi-pencil" />
                  </button>
                  <button type="button" className="ctx-icon-btn danger" title="Supprimer le dossier et son contenu" onClick={() => onDeleteFolder(f)}>
                    <i className="bi bi-trash" />
                  </button>
                </span>
              </div>
              {open && render(f.id, depth + 1)}
            </div>
          );
        })}
      {visibleInstructions
        .filter((i) => i.folderId === parentId)
        .map((i) => (
          <div key={i.id} className={`ctx-row${i.id === selectedId ? ' active' : ''}`} style={{ paddingLeft: 6 + depth * 16 }} onClick={() => onSelect(i.id)} title={i.description || i.path}>
            <span className="ctx-row-chevron" />
            <i className="bi bi-file-text ctx-row-icon" />
            <span className="ctx-row-name">{i.name}</span>
            <span className="ctx-row-version">v{i.version}</span>
          </div>
        ))}
    </>
  );

  if (folders.length === 0 && instructions.length === 0) {
    return <div className="ctx-tree-empty">Rien pour l'instant. Les agents y rangeront ce qu'ils apprennent, et vous pouvez commencer à y écrire.</div>;
  }
  if (q && visibleInstructions.length === 0) return <div className="ctx-tree-empty">Aucune instruction ne correspond à « {filter.trim()} ».</div>;
  return <div className="ctx-tree">{render(null, 0)}</div>;
}

/** Liste des versions d'une instruction (la plus récente en premier) ; un clic affiche une version. */
function Versions({ versions, current, viewed, onView }: { versions: ContextInstructionVersion[]; current: number; viewed: number | null; onView: (v: number | null) => void }) {
  return (
    <div className="ctx-versions">
      <div className="ctx-versions-head">
        <i className="bi bi-clock-history" />
        Historique des versions
        <span className="ms-auto fw-normal">{versions.length}</span>
      </div>
      <div className="ctx-versions-list">
        {versions.map((v) => {
          const isCurrent = v.version === current;
          const isViewed = viewed === null ? isCurrent : v.version === viewed;
          return (
            <div key={v.id} className={`ctx-version${isCurrent ? ' current' : ''}${isViewed ? ' active' : ''}`} onClick={() => onView(isCurrent ? null : v.version)} title={isCurrent ? 'Version courante' : 'Afficher cette version'}>
              <span className="ctx-version-num">
                v{v.version}
                {isCurrent && <span className="text-secondary"> · courante</span>}
              </span>
              <span className="ctx-version-date">{fmtDate(v.createdAt)}</span>
              <span className="ctx-version-info">
                <Author type={v.authorType} session={v.authorSession} />
                {v.changeNote && <span className="ctx-version-note">{v.changeNote}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Document d'une instruction : lecture rendue, édition Markdown (nom, description, dossier, note), versions, suppression. */
function InstructionDoc({ id, folders, canWrite, onDirty, onDeleted, onBack }: { id: string; folders: ContextFolder[]; canWrite: boolean; onDirty: (dirty: boolean) => void; onDeleted: () => void; onBack: () => void }) {
  const { data, loading, error, refetch } = useQuery<{ contextInstruction: ContextInstruction | null }>(CONTEXT_INSTRUCTION, { variables: { id } });
  const [update, { loading: saving, error: saveError }] = useMutation(UPDATE_CONTEXT_INSTRUCTION, { refetchQueries: ['ProjectContext', 'ContextInstruction'] });
  const [restore, { loading: restoring }] = useMutation(RESTORE_CONTEXT_INSTRUCTION_VERSION, { refetchQueries: ['ProjectContext', 'ContextInstruction'] });
  const { confirm } = useDialogs();
  const [remove] = useMutation(DELETE_CONTEXT_INSTRUCTION, { refetchQueries: ['ProjectContext'], onCompleted: onDeleted });

  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [folderId, setFolderId] = useState<string>('');
  const [changeNote, setChangeNote] = useState('');
  const [viewVersion, setViewVersion] = useState<number | null>(null);

  const instruction = data?.contextInstruction;
  const resetForm = useCallback(() => {
    if (!instruction) return;
    setName(instruction.name);
    setDescription(instruction.description);
    setContent(instruction.content);
    setFolderId(instruction.folderId ?? '');
    setChangeNote('');
  }, [instruction]);
  useEffect(() => {
    resetForm();
    setViewVersion(null);
    setEditing(false);
    setPreview(false);
    // Une instruction tout juste créée (contenu vide) s'ouvre directement en édition.
    if (instruction && instruction.content === '' && instruction.version === 1 && canWrite) setEditing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instruction?.id, instruction?.version]);

  const dirty = Boolean(instruction) && editing && (name !== instruction!.name || description !== instruction!.description || content !== instruction!.content || (folderId || null) !== instruction!.folderId);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const save = useCallback(() => {
    if (!dirty || saving) return;
    void update({ variables: { id, input: { name, description, content, folderId: folderId || null, changeNote: changeNote || null } } }).then(() => {
      setEditing(false);
      return refetch();
    });
  }, [dirty, saving, update, id, name, description, content, folderId, changeNote, refetch]);

  const cancelEdit = async () => {
    if (dirty && !(await confirm({ title: 'Abandonner les modifications', message: 'Les modifications non enregistrées de cette instruction seront perdues.', confirmLabel: 'Abandonner', danger: true }))) return;
    resetForm();
    setEditing(false);
  };

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">{error.message}</Alert>;
  if (!instruction) return <Alert variant="warning">Instruction introuvable.</Alert>;

  const versions = instruction.versions ?? [];
  const shown = viewVersion !== null ? versions.find((v) => v.version === viewVersion) ?? null : null;
  const latest = versions.find((v) => v.version === instruction.version) ?? null;
  const folderPath = instruction.path.includes('/') ? instruction.path.slice(0, instruction.path.lastIndexOf('/')) : null;
  const docName = shown ? shown.name : instruction.name;
  const docDescription = shown ? shown.description : instruction.description;
  const docContent = shown ? shown.content : instruction.content;

  return (
    <>
      <div className="ctx-doc-head">
        <Button variant="link" size="sm" className="ctx-back p-0 me-1" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" />
          Bibliothèque
        </Button>
        <div className="ctx-doc-path" title={instruction.path}>
          {folderPath && (
            <>
              <span className="ctx-crumb">{folderPath}</span>
              <span className="ctx-crumb-sep">/</span>
            </>
          )}
          <span className="ctx-crumb-name">{instruction.slug}</span>
          <Badge bg="secondary">v{instruction.version}</Badge>
        </div>
        <div className="ctx-doc-actions">
          {editing ? (
            <>
              <Button size="sm" variant="outline-secondary" onClick={cancelEdit} disabled={saving}>
                Annuler
              </Button>
              <Button size="sm" onClick={save} disabled={!dirty || saving} title="Enregistrer (Ctrl/Cmd + S)">
                {saving ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant={showVersions ? 'secondary' : 'outline-secondary'} onClick={() => setShowVersions((v) => !v)} title="Historique des versions">
                <i className="bi bi-clock-history me-1" />
                {versions.length} {versions.length > 1 ? 'versions' : 'version'}
              </Button>
              {canWrite && (
                <Button size="sm" variant="outline-primary" disabled={Boolean(shown)} onClick={() => setEditing(true)} title={shown ? "Revenez à la version courante pour l'éditer" : 'Modifier le contenu'}>
                  <i className="bi bi-pencil me-1" />
                  Modifier
                </Button>
              )}
              {canWrite && (
                <button
                  type="button"
                  className="ctx-icon-btn danger"
                  title="Supprimer l'instruction"
                  onClick={async () => {
                    if (await confirm({ title: "Supprimer l'instruction", message: `Supprimer l'instruction « ${instruction.name} » et son historique de versions ?`, confirmLabel: 'Supprimer', danger: true })) remove({ variables: { id } });
                  }}
                >
                  <i className="bi bi-trash" />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {showVersions && !editing && <Versions versions={versions} current={instruction.version} viewed={viewVersion} onView={setViewVersion} />}

      {shown && (
        <div className="ctx-version-banner">
          <span>
            Version {shown.version} du {fmtDate(shown.createdAt)} · <Author type={shown.authorType} session={shown.authorSession} />
            {shown.changeNote && <span className="text-secondary"> · {shown.changeNote}</span>}
          </span>
          <span className="d-flex gap-2">
            {canWrite && (
              <Button size="sm" variant="outline-primary" disabled={restoring} onClick={() => restore({ variables: { id, version: shown.version } })}>
                Restaurer cette version
              </Button>
            )}
            <Button size="sm" variant="outline-secondary" onClick={() => setViewVersion(null)}>
              Version courante
            </Button>
          </span>
        </div>
      )}

      {saveError && <Alert variant="danger">{saveError.message}</Alert>}

      {editing ? (
        <div className="ctx-edit">
          <Form.Control className="ctx-title-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de l'instruction" />
          <Form.Control value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description en une phrase : ce que l'instruction contient et quand la consulter (sert de description de skill)" />
          <div className="ctx-edit-toolbar">
            <div className="ctx-edit-tabs">
              <button type="button" className={`ctx-edit-tab${!preview ? ' active' : ''}`} onClick={() => setPreview(false)}>
                <i className="bi bi-pencil me-1" />
                Écrire
              </button>
              <button type="button" className={`ctx-edit-tab${preview ? ' active' : ''}`} onClick={() => setPreview(true)}>
                <i className="bi bi-eye me-1" />
                Aperçu
              </button>
            </div>
            <span className="ctx-edit-hint">
              <i className="bi bi-markdown me-1" />
              Markdown · Ctrl/Cmd + S pour enregistrer
            </span>
          </div>
          {preview ? (
            <div className="ctx-preview">{content.trim() ? <Markdown base="ctx-md" text={content} /> : <span className="ctx-doc-blank">Rien à afficher.</span>}</div>
          ) : (
            <MarkdownEditor value={content} onChange={setContent} onSave={save} placeholder="Contenu de l'instruction : règles, décisions, procédures… en Markdown." minHeight="380px" autoFocus />
          )}
          <div className="ctx-edit-footer">
            <Form.Select size="sm" value={folderId} onChange={(e) => setFolderId(e.target.value)} title="Dossier">
              <option value="">(racine)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}/
                </option>
              ))}
            </Form.Select>
            <Form.Control size="sm" className="ctx-note" value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="Note de version : ce qui change et pourquoi (facultatif)" />
            <div className="ctx-edit-buttons">
              <Button size="sm" variant="outline-secondary" onClick={cancelEdit} disabled={saving}>
                Annuler
              </Button>
              <Button size="sm" onClick={save} disabled={!dirty || saving}>
                {saving ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <h2 className="ctx-doc-title">{docName}</h2>
          {docDescription && <p className="ctx-doc-desc">{docDescription}</p>}
          {!shown && latest && (
            <div className="ctx-doc-meta">
              <span>
                Version {instruction.version} du {fmtDate(latest.createdAt)}
              </span>
              <Author type={latest.authorType} session={latest.authorSession} />
              {latest.changeNote && <span>{latest.changeNote}</span>}
            </div>
          )}
          <div className="ctx-doc-body">
            {docContent.trim() ? (
              <Markdown base="ctx-md" text={docContent} />
            ) : (
              <p className="ctx-doc-blank">
                Cette instruction est vide.
                {canWrite && !shown && (
                  <>
                    {' '}
                    <Button variant="link" size="sm" className="p-0 align-baseline" onClick={() => setEditing(true)}>
                      Écrire son contenu
                    </Button>
                  </>
                )}
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** Page « Contexte » d'un projet : arbre, document versionné et journal des modifications. */
export default function ContextPage() {
  const { id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('instruction');
  const [tab, setTab] = useState<'library' | 'changes'>('library');
  const [filter, setFilter] = useState('');
  const dirtyRef = useRef(false);
  const onDirty = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);

  const { data, loading, error } = usePollingQuery<{ project: ProjectContext | null }>(PROJECT_CONTEXT, { variables: { id }, pollInterval: 5000 });
  const [createFolder, { error: folderError }] = useMutation(CREATE_CONTEXT_FOLDER, { refetchQueries: ['ProjectContext'] });
  const [renameFolder] = useMutation(RENAME_CONTEXT_FOLDER, { refetchQueries: ['ProjectContext'] });
  const { confirm, prompt } = useDialogs();
  const [deleteFolder] = useMutation(DELETE_CONTEXT_FOLDER, { refetchQueries: ['ProjectContext'] });
  const [createInstruction, { error: instructionError }] = useMutation<{ createContextInstruction: ContextInstruction }>(CREATE_CONTEXT_INSTRUCTION, {
    refetchQueries: ['ProjectContext'],
    onCompleted: (res) => setSearchParams({ instruction: res.createContextInstruction.id }),
  });

  const project = data?.project;
  useTabTitle(project ? `Contexte · ${project.name}` : null);
  useGitTarget(project ? { projectId: project.id, worksessionId: null, label: project.name } : null);
  const folders = useMemo(() => project?.contextFolders ?? [], [project]);
  const instructions = useMemo(() => project?.contextInstructions ?? [], [project]);
  const canWrite = project?.myRole === 'ADMIN' || project?.myRole === 'MEMBER';

  /** Changement d'instruction affichée : demande confirmation si l'édition en cours n'est pas enregistrée. */
  const select = async (iid: string | null) => {
    if (iid === selectedId) return;
    if (dirtyRef.current && !(await confirm({ title: 'Modifications non enregistrées', message: "Changer d'instruction sans enregistrer ? Les modifications en cours seront perdues.", confirmLabel: 'Changer', danger: true }))) return;
    setSearchParams(iid ? { instruction: iid } : {});
  };
  const newFolder = async (parentId: string | null) => {
    const name = await prompt({ title: 'Nouveau dossier', message: 'Nom du dossier', confirmLabel: 'Créer' });
    if (name) createFolder({ variables: { projectId: id, parentId, name } });
  };
  const newInstruction = async (folderId: string | null) => {
    if (dirtyRef.current && !(await confirm({ title: 'Modifications non enregistrées', message: 'Créer une autre instruction sans enregistrer ? Les modifications en cours seront perdues.', confirmLabel: 'Créer', danger: true }))) return;
    const name = await prompt({ title: 'Nouvelle instruction', message: "Nom de l'instruction", confirmLabel: 'Créer' });
    if (name) createInstruction({ variables: { input: { projectId: id, folderId, name, content: '' } } });
  };

  if (loading && !data) return <ProjectPageLoading id={id} />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const mutationError = folderError ?? instructionError;

  return (
    <>
      <ProjectHeader project={project} active="context" />
      <p className="text-secondary small" style={{ maxWidth: 760 }}>
        La mémoire du projet : les règles, décisions et connaissances que les agents consultent avant d'agir et complètent au fil de leur travail. Chaque
        modification est conservée, vous pouvez revenir à une version précédente à tout moment.
      </p>
      {mutationError && <Alert variant="danger">{mutationError.message}</Alert>}

      <Nav variant="underline" activeKey={tab} onSelect={(k) => setTab((k as 'library' | 'changes') ?? 'library')} className="mb-3 small">
        <Nav.Item>
          <Nav.Link eventKey="library">Bibliothèque</Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="changes">Journal ({project.contextChanges.length})</Nav.Link>
        </Nav.Item>
      </Nav>

      {tab === 'library' && (
        <div className={`ctx-split${selectedId ? ' has-selection' : ''}`}>
          <aside className="ctx-side">
            <div className="ctx-side-bar">
              <label className="ctx-filter">
                <i className="bi bi-search" />
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer…" aria-label="Filtrer les instructions" />
                {filter && (
                  <button type="button" className="ctx-icon-btn" title="Effacer le filtre" onClick={() => setFilter('')}>
                    <i className="bi bi-x" />
                  </button>
                )}
              </label>
              {canWrite && (
                <>
                  <button type="button" className="ctx-icon-btn" title="Nouvelle instruction" onClick={() => newInstruction(null)}>
                    <i className="bi bi-file-earmark-plus" />
                  </button>
                  <button type="button" className="ctx-icon-btn" title="Nouveau dossier" onClick={() => newFolder(null)}>
                    <i className="bi bi-folder-plus" />
                  </button>
                </>
              )}
            </div>
            <Tree
              folders={folders}
              instructions={instructions}
              selectedId={selectedId}
              filter={filter}
              onSelect={(iid) => void select(iid)}
              onNewFolder={newFolder}
              onNewInstruction={newInstruction}
              onRenameFolder={async (f) => {
                const name = await prompt({ title: 'Renommer le dossier', message: 'Nouveau nom du dossier', defaultValue: f.name, confirmLabel: 'Renommer' });
                if (name && name !== f.name) renameFolder({ variables: { id: f.id, name } });
              }}
              onDeleteFolder={async (f) => {
                if (await confirm({ title: 'Supprimer le dossier', message: `Supprimer le dossier « ${f.path} » et tout son contenu ?`, confirmLabel: 'Supprimer', danger: true })) deleteFolder({ variables: { id: f.id } });
              }}
            />
          </aside>
          <section className="ctx-main">
            {selectedId ? (
              <InstructionDoc key={selectedId} id={selectedId} folders={folders} canWrite={canWrite} onDirty={onDirty} onDeleted={() => setSearchParams({})} onBack={() => void select(null)} />
            ) : (
              <div className="ctx-empty">
                <i className="bi bi-journal-text" />
                <div>Sélectionnez une instruction dans la bibliothèque{canWrite ? ', ou créez-en une.' : '.'}</div>
                {canWrite && (
                  <Button size="sm" variant="outline-primary" onClick={() => newInstruction(null)}>
                    <i className="bi bi-file-earmark-plus me-1" />
                    Nouvelle instruction
                  </Button>
                )}
              </div>
            )}
          </section>
        </div>
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
                <td className="text-secondary text-nowrap">{fmtDate(c.createdAt)}</td>
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
