import { useMutation, useQuery } from '@apollo/client';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Form } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import ProjectHeader, { type ProjectHeaderProject } from '../components/ProjectHeader';
import { KINDS } from '../components/vault/kinds';
import { DELETE_ENV_FILE, ENV_FILES, SAVE_ENV_FILE, type EnvFile, type EnvVaultChoice } from '../graphql/envFiles';
import { useTabTitle } from '../workbench/TabsContext';
import './context.css';

const MarkdownEditor = lazy(() => import('../components/MarkdownEditor'));

interface Draft {
  path: string;
  content: string;
  applyOnCreate: boolean;
}

const EMPTY_DRAFT: Draft = { path: '.env', content: '# Valeurs du coffre : CLÉ={{vault:élément.champ}}\n', applyOnCreate: true };
const isDotenvPath = (p: string) => {
  const base = p.split('/').pop() ?? '';
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
};
/** Coloration de l'éditeur d'après l'extension : dotenv et inconnus en « properties ». */
function languageOf(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'toml') return 'toml';
  return 'properties';
}

/** Éléments du coffre que les fichiers peuvent référencer : un clic copie la référence d'un champ. */
function VaultChoices({ choices, projectId }: { choices: EnvVaultChoice[]; projectId: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (ref: string) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(ref).then(() => {
      setCopied(ref);
      window.setTimeout(() => setCopied((c) => (c === ref ? null : c)), 1500);
    });
  };
  if (!choices.length) {
    return (
      <div className="text-secondary small">
        Aucun élément du <Link to={`/projects/${projectId}/vault`}>coffre</Link> ne peut servir ici (secrets, bases, API, serveurs SSH, comptes AWS ou Scaleway).
      </div>
    );
  }
  return (
    <div className="d-flex flex-column gap-2">
      {choices.map((c) => (
        <div key={c.itemId} className="small">
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <code>{c.name}</code>
            <span className="text-secondary">{KINDS[c.kind]?.label ?? c.kind}</span>
            {!c.envExport && (
              <Badge bg="secondary" title="Option à cocher sur l'élément, dans le coffre, par qui le gère">
                non autorisé{c.canManage ? ' — à cocher dans le coffre' : ''}
              </Badge>
            )}
          </div>
          {c.envExport && (
            <div className="d-flex flex-wrap gap-1 mt-1">
              {c.fields.map((f) => {
                const ref = `{{vault:${c.name}.${f}}}`;
                return (
                  <Button key={f} size="sm" variant="outline-secondary" className="py-0 px-1" title={`Copier ${ref}`} onClick={() => copy(ref)}>
                    {copied === ref ? <i className="bi bi-check2" /> : f}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Page « Environnement » d'un projet : fichiers (.env ou autres) écrits dans chaque nouveau dossier de travail, avec des
 * valeurs du coffre (`{{vault:élément.champ}}`). Liste à gauche, éditeur à droite ; les agents les lisent et les
 * complètent par les outils MCP `env`.
 */
export default function ProjectEnvPage() {
  const { id: projectId = '' } = useParams();
  const { confirm, showError } = useDialogs();
  const { data, loading, error, refetch } = useQuery<{ project: ProjectHeaderProject | null; envFiles: EnvFile[]; envVaultChoices: EnvVaultChoice[] }>(ENV_FILES, {
    variables: { projectId },
    // Relu à chaque ouverture (un agent a pu ajouter des clés), sans refaire la requête à chaque écriture du cache.
    fetchPolicy: 'cache-and-network',
    nextFetchPolicy: 'cache-first',
  });
  const [save, { loading: saving }] = useMutation<{ saveEnvFile: EnvFile }>(SAVE_ENV_FILE);
  const [remove] = useMutation(DELETE_ENV_FILE);
  const project = data?.project ?? null;
  useTabTitle(project ? `Environnement · ${project.name}` : null);
  const files = useMemo(() => data?.envFiles ?? [], [data]);
  const canWrite = project?.myRole === 'ADMIN' || project?.myRole === 'MEMBER';

  // Sélection : un fichier existant, « new » (brouillon), ou rien.
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const current = files.find((f) => f.id === selected) ?? null;

  useEffect(() => {
    if (selected === null && files.length) setSelected(files[0].id);
  }, [files, selected]);
  // Le brouillon suit le fichier choisi tant qu'il n'est pas modifié (rechargement après une écriture d'agent).
  useEffect(() => {
    if (current && !dirty) setDraft({ path: current.path, content: current.content, applyOnCreate: current.applyOnCreate });
  }, [current, dirty]);

  const choose = async (id: string | null) => {
    if (dirty && !(await confirm({ message: 'Abandonner les modifications non enregistrées ?', danger: true }))) return;
    setDirty(false);
    setSelected(id);
    if (id === 'new') setDraft(EMPTY_DRAFT);
  };

  const onSave = useCallback(async () => {
    if (!canWrite) return;
    try {
      const { data: saved } = await save({
        variables: { projectId, id: current?.id ?? null, path: draft.path, content: draft.content, applyOnCreate: draft.applyOnCreate, expectedUpdatedAt: current?.updatedAt ?? null },
      });
      setDirty(false);
      await refetch();
      if (saved) setSelected(saved.saveEnvFile.id);
    } catch (err) {
      showError(err);
    }
  }, [canWrite, current, draft, projectId, refetch, save, showError]);

  const onDelete = async () => {
    if (!current) return;
    if (!(await confirm({ message: `Supprimer « ${current.path} » ? Il ne sera plus écrit dans les nouvelles sessions (les dossiers existants gardent leur copie).`, danger: true }))) return;
    try {
      await remove({ variables: { id: current.id } });
      setDirty(false);
      setSelected(null);
      await refetch();
    } catch (err) {
      showError(err);
    }
  };

  if (loading && !data) return <PageLoading className="p-3" />;
  if (error) return <Alert variant="danger">{error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;

  const editing = selected === 'new' || current !== null;
  const dotenv = isDotenvPath(draft.path.trim());
  return (
    <>
      <ProjectHeader project={project} active="env" />
      <p className="text-secondary small mb-3" style={{ maxWidth: '90ch' }}>
        Fichiers écrits dans le dossier de travail de chaque nouvelle session (sans remplacer un fichier déjà présent), puis exclus de git. Une
        valeur du coffre s'écrit <code>{'{{vault:élément.champ}}'}</code> ; l'élément doit l'autoriser (option du coffre), car la valeur devient lisible
        par l'agent. Les agents consultent les clés et en ajoutent avec les outils <code>env</code>.
      </p>
      <div className="ctx-split">
        <aside className="ctx-side">
          <div className="ctx-side-bar">
            <span className="ctx-filter">Fichiers</span>
            {canWrite && (
              <button type="button" className="ctx-icon-btn" title="Nouveau fichier" onClick={() => void choose('new')}>
                <i className="bi bi-plus-lg" />
              </button>
            )}
          </div>
          <div className="ctx-tree">
            {files.length === 0 && selected !== 'new' && <div className="ctx-tree-empty">Aucun fichier. {canWrite ? '« + » pour en créer un, par exemple .env.' : ''}</div>}
            {files.map((f) => (
              <div key={f.id} className={`ctx-row${f.id === selected ? ' active' : ''}`} onClick={() => void choose(f.id)} style={{ paddingLeft: 8 }}>
                <i className="bi bi-file-earmark-lock ctx-row-icon" />
                <span className="ctx-row-name">{f.path}</span>
                {f.problems.length > 0 && <i className="bi bi-exclamation-triangle text-warning" title={`${f.problems.length} référence(s) non résolue(s)`} />}
                {!f.applyOnCreate && <i className="bi bi-pause-circle text-secondary" title="Non importé à la création des sessions" />}
              </div>
            ))}
            {selected === 'new' && (
              <div className="ctx-row active" style={{ paddingLeft: 8 }}>
                <i className="bi bi-file-earmark-plus ctx-row-icon" />
                <span className="ctx-row-name">{draft.path || 'nouveau fichier'}</span>
              </div>
            )}
          </div>
        </aside>
        <main className="ctx-main">
          {!editing ? (
            <div className="ctx-empty">
              <i className="bi bi-file-earmark-lock" />
              <div>Choisissez un fichier, ou créez-en un.</div>
            </div>
          ) : (
            <>
              <div className="ctx-doc-head">
                <Form.Control
                  size="sm"
                  className="font-monospace"
                  style={{ flex: '1 1 240px', width: 'auto', maxWidth: 420 }}
                  value={draft.path}
                  disabled={!canWrite}
                  placeholder=".env, backend/.env, config/local.json…"
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, path: e.target.value }));
                    setDirty(true);
                  }}
                />
                <div className="ctx-doc-actions">
                  {dirty && <span className="text-warning small">Non enregistré</span>}
                  {canWrite && (
                    <Button size="sm" onClick={() => void onSave()} disabled={saving || (!dirty && selected !== 'new')}>
                      Enregistrer
                    </Button>
                  )}
                  {canWrite && current && (
                    <Button size="sm" variant="outline-danger" onClick={() => void onDelete()}>
                      Supprimer
                    </Button>
                  )}
                </div>
              </div>
              <div className="ctx-doc-meta">
                <Form.Check
                  type="switch"
                  id="env-apply-on-create"
                  label="Écrit à la création de chaque session"
                  checked={draft.applyOnCreate}
                  disabled={!canWrite}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, applyOnCreate: e.target.checked }));
                    setDirty(true);
                  }}
                />
                {current && (
                  <span>
                    Modifié le {new Date(current.updatedAt).toLocaleString('fr-FR')}
                    {current.updatedBySession ? (
                      <>
                        {' '}
                        par la session <Link to={`/sessions/${current.updatedBySession.id}`}>{current.updatedBySession.name}</Link>
                      </>
                    ) : current.updatedBy ? (
                      ` par ${current.updatedBy.name}`
                    ) : null}
                  </span>
                )}
                {current?.dotenv && <span>{current.keys.length} clé(s)</span>}
              </div>
              {current && current.problems.length > 0 && (
                <Alert variant="warning" className="py-2 small">
                  Références qui seront écrites vides pour vous :
                  <ul className="mb-0">
                    {current.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Alert>
              )}
              <Suspense fallback={<PageLoading className="p-3" />}>
                <MarkdownEditor
                  value={draft.content}
                  language={languageOf(draft.path)}
                  minHeight="360px"
                  onChange={(v) => {
                    if (!canWrite) return;
                    setDraft((d) => ({ ...d, content: v }));
                    setDirty(true);
                  }}
                  onSave={() => void onSave()}
                />
              </Suspense>
              {!dotenv && <div className="text-secondary small mt-2">Fichier libre : les agents le lisent en entier ; seuls les fichiers dotenv (.env, .env.*, *.env) se modifient clé par clé.</div>}
              <h2 className="h6 mt-4">Valeurs du coffre</h2>
              <VaultChoices choices={data?.envVaultChoices ?? []} projectId={projectId} />
            </>
          )}
        </main>
      </div>
    </>
  );
}
