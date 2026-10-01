import { useMutation, useQuery } from '@apollo/client';
import PageLoading from '../components/PageLoading';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Spinner } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { WORKSPACE_FILE, WRITE_WORKSPACE_FILE, type FileContent } from '../graphql/operations';
import { fileIcon, filesUrl, formatSize, useWorkspaceFromRoute } from '../lib/files';
import { useTabTitle } from '../workbench/TabsContext';
import { useGitTarget } from '../workbench/GitTargetContext';


/** Accorde CodeMirror au thème sombre de l'application. */
const appTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#141414', fontSize: '13px', height: '100%' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', lineHeight: '1.5' },
    '.cm-gutters': { backgroundColor: '#141414', borderRight: '1px solid #262626' },
    '.cm-activeLineGutter': { backgroundColor: '#1a1a1a' },
    '.cm-activeLine': { backgroundColor: '#1a1a1a' },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#d97757' },
    '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(217, 119, 87, 0.3)' },
  },
  { dark: true },
);

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Éditeur de code d'un fichier du workspace, dans son propre onglet. */
export default function FileEditorPage() {
  const { info, loading: wsLoading, error: wsError, filePath } = useWorkspaceFromRoute();
  useGitTarget(info ? { projectId: info.projectId, worktreeId: info.worktreeId, label: info.label } : null);
  const wsRef = info ? { projectId: info.projectId, worktreeId: info.worktreeId } : null;
  const { data, loading, error, refetch } = useQuery<{ workspaceFile: FileContent }>(WORKSPACE_FILE, {
    variables: { ...wsRef, path: filePath },
    skip: !wsRef,
    fetchPolicy: 'network-only',
  });
  const file = data?.workspaceFile;
  const name = filePath.split('/').pop() ?? filePath;

  const [doc, setDoc] = useState('');
  const [saved, setSaved] = useState('');
  const [modifiedAt, setModifiedAt] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [language, setLanguage] = useState<Extension | null>(null);
  const dirty = doc !== saved;
  useTabTitle(`${dirty ? '● ' : ''}${name}`);

  // Chargement (et rechargement) : le contenu du serveur devient la référence.
  useEffect(() => {
    if (!file || file.binary || file.content === null) return;
    setDoc(file.content);
    setSaved(file.content);
    setModifiedAt(file.modifiedAt);
    setSize(file.size);
    setConflict(false);
  }, [file]);

  // Coloration syntaxique selon l'extension, chargée à la demande.
  useEffect(() => {
    let cancelled = false;
    const desc = LanguageDescription.matchFilename(languages, name);
    if (!desc) {
      setLanguage(null);
      return;
    }
    desc.load().then((support) => {
      if (!cancelled) setLanguage(support);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const [write, { loading: saving }] = useMutation<{ writeWorkspaceFile: FileContent }>(WRITE_WORKSPACE_FILE);
  const docRef = useRef(doc);
  docRef.current = doc;
  const save = useCallback(
    async (force = false) => {
      if (!wsRef || saving) return;
      setSaveError(null);
      const content = docRef.current;
      try {
        const res = await write({ variables: { ...wsRef, path: filePath, content, expectedModifiedAt: force ? null : modifiedAt } });
        const written = res.data?.writeWorkspaceFile;
        if (written) {
          setSaved(content);
          setModifiedAt(written.modifiedAt);
          setSize(written.size);
          setConflict(false);
          setSavedFlash(true);
          setTimeout(() => setSavedFlash(false), 1500);
        }
      } catch (err) {
        const e = err as { graphQLErrors?: { extensions?: { code?: string } }[]; message: string };
        if (e.graphQLErrors?.some((g) => g.extensions?.code === 'FILE_CONFLICT')) setConflict(true);
        else setSaveError(e.message);
      }
    },
    [wsRef, saving, write, filePath, modifiedAt],
  );

  const extensions = useMemo<Extension[]>(() => {
    const list: Extension[] = [
      appTheme,
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void save();
              return true;
            },
          },
        ]),
      ),
    ];
    if (language) list.push(language);
    return list;
  }, [language, save]);

  // Avertit avant de quitter la page du navigateur avec des modifications non enregistrées.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  if ((wsLoading || loading) && !file) return <PageLoading className="p-3" />;
  if (wsError) return <Alert variant="danger" className="m-3">Erreur : {wsError.message}</Alert>;
  if (!info || !wsRef) return <Alert variant="warning" className="m-3">Projet ou worktree introuvable.</Alert>;
  if (error) {
    return (
      <div className="p-3">
        <Alert variant="danger">{error.message}</Alert>
        <Link to={filesUrl(wsRef)}>← Explorateur</Link>
      </div>
    );
  }
  if (!file) return null;

  return (
    <div className="fe-page">
      <div className="fe-header">
        <div className="fe-path" title={`${info.path ?? ''}/${file.path}`}>
          <Link to={filesUrl(wsRef)} className="fe-crumb" title="Explorateur">
            <i className="bi bi-folder2-open" /> {info.label}
          </Link>
          <span className="fe-sep">/</span>
          <i className={`bi ${fileIcon(file.name, 'file')} me-1`} />
          <span className="fe-name">{file.path}</span>
          {dirty && <span className="fe-dirty" title="Modifications non enregistrées">●</span>}
        </div>
        <div className="fe-meta">
          <span className="fx-muted">{formatSize(size ?? file.size)}{modifiedAt ? ` · ${fmtDate(modifiedAt)}` : ''}</span>
          {savedFlash && <span className="text-success"><i className="bi bi-check2 me-1" />Enregistré</span>}
          <Button size="sm" variant="outline-secondary" onClick={() => refetch()} disabled={loading} title="Recharger depuis le serveur">
            <i className="bi bi-arrow-clockwise" />
          </Button>
          <Button size="sm" onClick={() => save()} disabled={!dirty || saving || file.binary} title="Enregistrer (Ctrl/Cmd + S)">
            {saving ? <Spinner size="sm" /> : <><i className="bi bi-save me-1" /> Enregistrer</>}
          </Button>
        </div>
      </div>
      {conflict && (
        <Alert variant="warning" className="fe-alert">
          Le fichier a été modifié sur le serveur depuis son ouverture (par un agent ou un autre onglet).{' '}
          <Button size="sm" variant="outline-secondary" className="ms-2" onClick={() => refetch()}>Recharger (perdre mes modifications)</Button>{' '}
          <Button size="sm" variant="warning" className="ms-1" onClick={() => save(true)}>Écraser avec ma version</Button>
        </Alert>
      )}
      {saveError && (
        <Alert variant="danger" className="fe-alert" dismissible onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}
      {file.binary ? (
        <div className="p-3 fx-muted">Fichier binaire ({formatSize(file.size)}) : pas d'aperçu.</div>
      ) : (
        <div className="fe-editor">
          <CodeMirror
            value={doc}
            height="100%"
            theme={oneDark}
            extensions={extensions}
            onChange={(value) => setDoc(value)}
            basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, bracketMatching: true, autocompletion: false, tabSize: 2 }}
          />
        </div>
      )}
    </div>
  );
}
