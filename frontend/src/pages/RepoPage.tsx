import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Form, Modal, Nav, Spinner, Table } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import DiffView from '../components/DiffView';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import ProjectHeader from '../components/ProjectHeader';
import { UPDATE_PROJECT } from '../graphql/operations';
import {
  BACKUP_HOSTED_GIT,
  CREATE_GIT_TOKEN,
  MY_GIT_TOKENS,
  REPO_COMMIT,
  REPO_FILE,
  REPO_LOG,
  REPO_PROJECT,
  REPO_REFS,
  REPO_TREE,
  REVOKE_GIT_TOKEN,
  ROTATE_AGENT_GIT_TOKEN,
  type GitAccessToken,
  type HostedGit,
  type RepoCommit,
  type RepoCommitDetail,
  type RepoEntry,
  type RepoFile,
  type RepoProject,
  type RepoRef,
} from '../graphql/repo';
import { formatSize } from '../lib/files';
import { dayLabel, timeAgo } from '../lib/humanize';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useTabTitle } from '../workbench/TabsContext';
import './repo.css';

const PAGE = 50;

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="repo-copy">
      <code className="text-break">{value}</code>
      <Button
        size="sm"
        variant="outline-secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        title="Copier"
      >
        <i className={`bi ${copied ? 'bi-check2' : 'bi-clipboard'}`} />
      </Button>
    </div>
  );
}

/** Jetons d'accès git personnels : mot de passe HTTP pour cloner et pousser les dépôts hébergés depuis son poste. */
function GitTokens() {
  const { data, refetch } = useQuery<{ myGitTokens: GitAccessToken[] }>(MY_GIT_TOKENS);
  const [create, { loading: creating }] = useMutation<{ createGitToken: { token: GitAccessToken; secret: string } }>(CREATE_GIT_TOKEN);
  const [revoke] = useMutation(REVOKE_GIT_TOKEN);
  const [rotate] = useMutation(ROTATE_AGENT_GIT_TOKEN);
  const { prompt, confirm, showError, alert } = useDialogs();
  const [secret, setSecret] = useState<string | null>(null);
  const tokens = data?.myGitTokens ?? [];
  return (
    <div>
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <strong className="small">Vos jetons d'accès</strong>
        <span className="small text-secondary">valables pour tous les projets hébergés dont vous êtes membre, avec votre rôle (lecteur : lecture seule)</span>
        <Button
          size="sm"
          variant="outline-primary"
          className="ms-auto"
          disabled={creating}
          onClick={async () => {
            const label = await prompt({ title: "Nouveau jeton d'accès git", message: 'Un nom pour le reconnaître (poste, outil…). Il est valable un an.', placeholder: 'Portable', confirmLabel: 'Créer' });
            if (!label) return;
            try {
              const res = await create({ variables: { label, expiresInDays: 365 } });
              setSecret(res.data?.createGitToken.secret ?? null);
              await refetch();
            } catch (err) {
              void showError(err);
            }
          }}
        >
          <i className="bi bi-key me-1" /> Nouveau jeton
        </Button>
      </div>
      {secret && (
        <Alert variant="success" dismissible onClose={() => setSecret(null)} className="small">
          Copiez ce jeton maintenant, il ne sera plus affiché. Utilisez-le comme mot de passe (nom d'utilisateur libre) :
          <CopyField value={secret} />
        </Alert>
      )}
      {tokens.length > 0 && (
        <Table size="sm" className="small mb-2 table-stack">
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td className="font-monospace text-secondary">{t.prefix}…</td>
                <td className="text-secondary">{t.lastUsedAt ? `utilisé ${timeAgo(t.lastUsedAt)}` : 'jamais utilisé'}</td>
                <td className="text-secondary">{t.expiresAt ? `expire le ${new Date(t.expiresAt).toLocaleDateString('fr-FR')}` : 'sans expiration'}</td>
                <td className="text-end">
                  <Button
                    size="sm"
                    variant="link"
                    className="text-danger p-0"
                    onClick={async () => {
                      if (!(await confirm({ message: `Révoquer le jeton « ${t.label} » ? Les clones qui l'utilisent ne pourront plus se synchroniser.`, danger: true, confirmLabel: 'Révoquer' }))) return;
                      await revoke({ variables: { id: t.id } }).catch(showError);
                      await refetch();
                    }}
                  >
                    Révoquer
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Button
        size="sm"
        variant="link"
        className="p-0 small"
        onClick={async () => {
          if (!(await confirm({ message: 'Renouveler le jeton que Skipper donne à vos sessions et terminaux ? Les sessions en cours garderont l’ancien, qui ne sera plus accepté, jusqu’à leur prochain lancement.', confirmLabel: 'Renouveler' }))) return;
          await rotate().then(() => alert('Jeton des sessions renouvelé.'), showError);
        }}
      >
        Renouveler le jeton de mes sessions
      </Button>
    </div>
  );
}

/** Dépôt hébergé : adresse de clone, état, sauvegardes en base. */
function HostedCard({ project, hosted }: { project: RepoProject; hosted: HostedGit }) {
  const [backup, { loading: backingUp }] = useMutation(BACKUP_HOSTED_GIT, { refetchQueries: ['RepoProject'] });
  const { showError } = useDialogs();
  const canWrite = project.myRole === 'ADMIN' || project.myRole === 'MEMBER';
  const last = hosted.lastBackup;
  return (
    <Card className="mb-3">
      <Card.Header className="d-flex align-items-center gap-2">
        <i className="bi bi-hdd-network" /> Dépôt hébergé par Skipper
        {!hosted.exists && (
          <Badge bg="warning" text="dark">
            absent du disque : restauré à la prochaine utilisation
          </Badge>
        )}
      </Card.Header>
      <Card.Body className="small">
        <div className="mb-2">
          <div className="text-secondary mb-1">Cloner (mot de passe : un de vos jetons d'accès ci-dessous)</div>
          <CopyField value={`git clone ${hosted.url}`} />
        </div>
        <div className="d-flex flex-wrap gap-3 mb-3 text-secondary">
          <span>
            Branche principale <code>{hosted.defaultBranch}</code>
          </span>
          {hosted.diskSize != null && <span>{formatSize(hosted.diskSize)} sur disque</span>}
        </div>
        <div className="d-flex align-items-center gap-2 mb-1 flex-wrap">
          <strong>Sauvegardes en base</strong>
          <span className="text-secondary">{last ? `dernière ${timeAgo(last.takenAt)} (${formatSize(last.size)}, ${last.refCount} référence${last.refCount > 1 ? 's' : ''})` : 'aucune pour le moment'}</span>
          {canWrite && (
            <Button size="sm" variant="outline-secondary" className="ms-auto" disabled={backingUp} onClick={() => backup({ variables: { projectId: project.id } }).catch(showError)}>
              {backingUp ? <Spinner size="sm" /> : <i className="bi bi-cloud-arrow-up me-1" />} Sauvegarder maintenant
            </Button>
          )}
        </div>
        <div className="text-secondary mb-2">Le dépôt complet (toutes les branches et tags) est enregistré dans la base PostgreSQL après chaque push et vérifié toutes les 10 minutes ; les trois dernières prises sont conservées. Un bundle se relit par <code>git clone fichier.bundle</code>.</div>
        {hosted.backups.length > 0 && (
          <ul className="list-unstyled mb-3">
            {hosted.backups.map((b) => (
              <li key={b.id}>
                <a href={b.downloadUrl}>
                  <i className="bi bi-download me-1" />
                  {new Date(b.takenAt).toLocaleString('fr-FR')}
                </a>{' '}
                <span className="text-secondary">
                  · {formatSize(b.size)} · {b.refCount} référence{b.refCount > 1 ? 's' : ''} · HEAD {b.head}
                </span>
              </li>
            ))}
          </ul>
        )}
        <GitTokens />
      </Card.Body>
    </Card>
  );
}

/** Projet sans dépôt : proposer de l'héberger. */
function NoRepoCard({ project }: { project: RepoProject }) {
  const [update, { loading }] = useMutation(UPDATE_PROJECT, { refetchQueries: ['RepoProject'] });
  const { confirm, showError } = useDialogs();
  const isAdmin = project.myRole === 'ADMIN';
  return (
    <Card className="mb-3">
      <Card.Body>
        <h2 className="h6">Ce projet n'a pas de dépôt git</h2>
        <p className="small text-secondary mb-2">
          Skipper peut héberger son dépôt : les sessions travaillent alors sur des branches, gardent un historique et poussent leur travail sur ce serveur, qui le sauvegarde dans sa base. Le dossier actuel du projet (et celui de chaque session) devient le premier commit de sa
          branche. Vous pouvez aussi relier un dépôt distant depuis « Modifier ».
        </p>
        {isAdmin ? (
          <Button
            size="sm"
            disabled={loading}
            onClick={async () => {
              if (!(await confirm({ title: 'Héberger le dépôt', message: 'Le contenu des dossiers du projet et de ses sessions sera importé dans un dépôt git hébergé par Skipper (pensez à un .gitignore pour node_modules et les fichiers volumineux). L’hébergement ne se désactive pas ensuite.', confirmLabel: 'Héberger' }))) return;
              await update({ variables: { id: project.id, input: { gitHosted: true } } }).catch(showError);
            }}
          >
            {loading ? <Spinner size="sm" className="me-1" /> : <i className="bi bi-hdd-network me-1" />} Héberger un dépôt git
          </Button>
        ) : (
          <div className="small text-secondary">Un administrateur du projet peut l'activer.</div>
        )}
      </Card.Body>
    </Card>
  );
}

function CommitModal({ projectId, hash, onClose }: { projectId: string; hash: string; onClose: () => void }) {
  const { data, loading, error } = useQuery<{ repoCommit: RepoCommitDetail }>(REPO_COMMIT, { variables: { projectId, hash } });
  const d = data?.repoCommit;
  return (
    <Modal show onHide={onClose} size="xl" scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h6 text-truncate">{d ? d.commit.subject : hash.slice(0, 8)}</Modal.Title>
      </Modal.Header>
      <Modal.Body className="p-0">
        {loading && <PageLoading className="p-3" />}
        {error && <Alert variant="danger" className="m-3">{error.message}</Alert>}
        {d && (
          <>
            <div className="repo-commit-head small">
              <div>
                <strong>{d.commit.author}</strong> <span className="text-secondary">&lt;{d.commit.email}&gt;</span> · {new Date(d.commit.date).toLocaleString('fr-FR')}
              </div>
              <div className="font-monospace text-secondary">
                {d.commit.hash}
                {d.commit.parents.length > 0 && <> · parent{d.commit.parents.length > 1 ? 's' : ''} {d.commit.parents.map((p) => p.slice(0, 8)).join(', ')}</>}
              </div>
              {d.commit.body && <pre className="repo-commit-body">{d.commit.body}</pre>}
              <ul className="list-unstyled mb-0 mt-2">
                {d.files.map((f) => (
                  <li key={f.path} className="font-monospace">
                    <span className={`repo-status repo-status-${f.status}`}>{f.status}</span> {f.origPath ? `${f.origPath} → ` : ''}
                    {f.path} {f.additions != null && <span className="repo-add">+{f.additions}</span>} {f.deletions != null && <span className="repo-del">−{f.deletions}</span>}
                  </li>
                ))}
              </ul>
            </div>
            <DiffView text={d.diff} />
          </>
        )}
      </Modal.Body>
    </Modal>
  );
}

function History({ projectId, gitRef, path, onOpen }: { projectId: string; gitRef: string; path: string; onOpen: (hash: string) => void }) {
  const { data, loading, error, fetchMore } = useQuery<{ repoLog: RepoCommit[] }>(REPO_LOG, { variables: { projectId, ref: gitRef, limit: PAGE, skip: 0, path: path || null }, fetchPolicy: 'cache-and-network' });
  const [more, setMore] = useState(true);
  useEffect(() => setMore(true), [gitRef, path]);
  const commits = data?.repoLog ?? [];
  const days = useMemo(() => {
    const groups: { day: string; commits: RepoCommit[] }[] = [];
    for (const c of commits) {
      const day = dayLabel(c.date);
      if (groups.at(-1)?.day !== day) groups.push({ day, commits: [] });
      groups.at(-1)!.commits.push(c);
    }
    return groups;
  }, [commits]);
  if (error) return <Alert variant="danger">{error.message}</Alert>;
  if (loading && !data) return <PageLoading />;
  if (!commits.length) return <div className="text-secondary small p-2">Aucun commit{path ? ` pour ${path}` : ''}.</div>;
  return (
    <div className="repo-history">
      {days.map((g) => (
        <div key={g.day}>
          <div className="repo-day">{g.day}</div>
          {g.commits.map((c) => (
            <button key={c.hash} type="button" className="repo-commit" onClick={() => onOpen(c.hash)}>
              <span className="repo-commit-subject">{c.subject}</span>
              <span className="repo-commit-meta">
                {c.author} · {timeAgo(c.date)} · <code>{c.shortHash}</code>
              </span>
            </button>
          ))}
        </div>
      ))}
      {more && commits.length >= PAGE && (
        <Button
          size="sm"
          variant="outline-secondary"
          className="m-2"
          onClick={() =>
            fetchMore({
              variables: { skip: commits.length },
              updateQuery: (prev, { fetchMoreResult }) => {
                if (fetchMoreResult.repoLog.length < PAGE) setMore(false);
                return { repoLog: [...prev.repoLog, ...fetchMoreResult.repoLog] };
              },
            })
          }
        >
          Commits plus anciens
        </Button>
      )}
    </div>
  );
}

function FileView({ projectId, gitRef, path }: { projectId: string; gitRef: string; path: string }) {
  const { data, loading, error } = useQuery<{ repoFile: RepoFile }>(REPO_FILE, { variables: { projectId, ref: gitRef, path } });
  if (error) return <Alert variant="danger">{error.message}</Alert>;
  if (loading || !data) return <PageLoading />;
  const f = data.repoFile;
  return (
    <div className="repo-file">
      <div className="repo-file-head small text-secondary">
        {formatSize(f.size)}
        {f.truncated && ' · affiché en partie (2 Mo)'}
      </div>
      {f.binary ? (
        <div className="p-3 small text-secondary">Fichier binaire : pas d'aperçu.</div>
      ) : (
        <pre className="repo-code">
          {f.content.split('\n').map((line, i) => (
            <div key={i} className="repo-code-line">
              <span className="repo-ln">{i + 1}</span>
              <span>{line || ' '}</span>
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function Tree({ projectId, gitRef, path, onNavigate }: { projectId: string; gitRef: string; path: string; onNavigate: (path: string, isDir: boolean) => void }) {
  const { data, loading, error } = useQuery<{ repoTree: RepoEntry[] }>(REPO_TREE, { variables: { projectId, ref: gitRef, path } });
  if (error) return <Alert variant="danger">{error.message}</Alert>;
  if (loading || !data) return <PageLoading />;
  const icon = (e: RepoEntry) => (e.kind === 'DIR' ? 'bi-folder2' : e.kind === 'SUBMODULE' ? 'bi-box-arrow-up-right' : e.kind === 'SYMLINK' ? 'bi-link-45deg' : 'bi-file-earmark');
  return (
    <div className="repo-tree">
      {data.repoTree.map((e) => (
        <button key={e.path} type="button" className={`repo-entry${e.kind === 'DIR' ? ' dir' : ''}`} disabled={e.kind === 'SUBMODULE'} onClick={() => onNavigate(e.path, e.kind === 'DIR')}>
          <i className={`bi ${icon(e)}`} />
          <span className="repo-entry-name">{e.name}</span>
          {e.size != null && <span className="repo-entry-size">{formatSize(e.size)}</span>}
        </button>
      ))}
      {!data.repoTree.length && <div className="text-secondary small p-2">Dossier vide.</div>}
    </div>
  );
}

/** Consultation du dépôt : choix de la révision, fichiers ou historique. */
function Browser({ project }: { project: RepoProject }) {
  const refsQ = useQuery<{ repoRefs: RepoRef[] }>(REPO_REFS, { variables: { projectId: project.id } });
  const refs = refsQ.data?.repoRefs ?? [];
  const [gitRef, setGitRef] = useState<string | null>(null);
  const [view, setView] = useState<'files' | 'history'>('files');
  const [path, setPath] = useState('');
  const [isFile, setIsFile] = useState(false);
  const [commit, setCommit] = useState<string | null>(null);
  const current = gitRef ?? refs.find((r) => r.isDefault)?.name ?? refs[0]?.name ?? null;
  const branches = refs.filter((r) => r.kind === 'BRANCH');
  const tags = refs.filter((r) => r.kind === 'TAG');
  const head = refs.find((r) => r.name === current);
  const crumbs = path ? path.split('/') : [];

  if (refsQ.error) return <Alert variant="warning">{refsQ.error.message}</Alert>;
  if (refsQ.loading && !refsQ.data) return <PageLoading />;
  if (!current) return <div className="text-secondary small">Le dépôt n'a encore aucune branche.</div>;
  return (
    <Card>
      <Card.Header className="repo-toolbar">
        <Form.Select
          size="sm"
          value={current}
          onChange={(e) => {
            setGitRef(e.target.value);
            setPath('');
            setIsFile(false);
          }}
          className="repo-ref-select"
          aria-label="Branche ou tag"
        >
          <optgroup label={`Branches (${branches.length})`}>
            {branches.map((r) => (
              <option key={`b:${r.name}`} value={r.name}>
                {r.name}
                {r.isDefault ? ' (principale)' : ''}
              </option>
            ))}
          </optgroup>
          {tags.length > 0 && (
            <optgroup label={`Tags (${tags.length})`}>
              {tags.map((r) => (
                <option key={`t:${r.name}`} value={r.name}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          )}
        </Form.Select>
        <Nav variant="underline" activeKey={view} onSelect={(k) => setView((k as 'files' | 'history') ?? 'files')}>
          <Nav.Item>
            <Nav.Link eventKey="files">
              <i className="bi bi-folder2-open me-1" />
              Fichiers
            </Nav.Link>
          </Nav.Item>
          <Nav.Item>
            <Nav.Link eventKey="history">
              <i className="bi bi-clock-history me-1" />
              Historique
            </Nav.Link>
          </Nav.Item>
        </Nav>
        <Button size="sm" variant="outline-secondary" className="ms-auto" title={project.gitHosted ? 'Recharger' : 'Récupérer les nouveautés du dépôt distant'} onClick={() => refsQ.refetch({ projectId: project.id, refresh: true })}>
          <i className="bi bi-arrow-clockwise" />
        </Button>
      </Card.Header>
      {head && (
        <button type="button" className="repo-last" onClick={() => setCommit(head.hash)}>
          <span className="text-truncate">{head.subject}</span>
          <span className="repo-commit-meta">
            {head.author} · {timeAgo(head.date)} · <code>{head.shortHash}</code>
          </span>
        </button>
      )}
      <div className="repo-crumbs small">
        <button type="button" className="btn btn-link btn-sm p-0" onClick={() => (setPath(''), setIsFile(false))}>
          {project.name}
        </button>
        {crumbs.map((c, i) => (
          <span key={i}>
            {' / '}
            {i === crumbs.length - 1 ? (
              <strong>{c}</strong>
            ) : (
              <button type="button" className="btn btn-link btn-sm p-0" onClick={() => (setPath(crumbs.slice(0, i + 1).join('/')), setIsFile(false))}>
                {c}
              </button>
            )}
          </span>
        ))}
        {path && view === 'files' && (
          <button type="button" className="btn btn-link btn-sm p-0 ms-2" onClick={() => setView('history')}>
            historique de {isFile ? 'ce fichier' : 'ce dossier'}
          </button>
        )}
      </div>
      <Card.Body className="p-0">
        {view === 'history' ? (
          <History projectId={project.id} gitRef={current} path={path} onOpen={setCommit} />
        ) : isFile ? (
          <FileView projectId={project.id} gitRef={current} path={path} />
        ) : (
          <Tree
            projectId={project.id}
            gitRef={current}
            path={path}
            onNavigate={(p, dir) => {
              setPath(p);
              setIsFile(!dir);
            }}
          />
        )}
      </Card.Body>
      {commit && <CommitModal projectId={project.id} hash={commit} onClose={() => setCommit(null)} />}
    </Card>
  );
}

/**
 * Page « Dépôt » d'un projet : dépôt hébergé par Skipper (clone, sauvegardes, jetons) ou proposition de l'héberger, puis
 * la consultation du dépôt (hébergé ou distant) : branches et tags, fichiers, historique, détail des commits.
 */
export default function RepoPage() {
  const { id = '' } = useParams();
  const { data, loading, error } = useQuery<{ project: RepoProject | null }>(REPO_PROJECT, { variables: { id } });
  const project = data?.project;
  useTabTitle(project ? `Dépôt · ${project.name}` : null);
  useGitTarget(project?.gitUrl ? { projectId: project.id, worksessionId: null, label: project.name } : null);
  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">{error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  return (
    <>
      <ProjectHeader project={project} active="repo" />
      {project.isPersonal && !project.gitUrl ? (
        <div className="text-secondary small">L'espace personnel n'a pas de dépôt git.</div>
      ) : (
        <>
          {project.gitHosted && project.hostedGit ? (
            <HostedCard project={project} hosted={project.hostedGit} />
          ) : project.gitUrl ? (
            <div className="small text-secondary mb-2">
              Dépôt distant <code>{project.gitUrl}</code>, lu dans le dossier principal du projet (récupéré au plus toutes les minutes). Les changements en cours des sessions sont dans leur panneau git ; les PR dans{' '}
              <Link to={`/projects/${project.id}/pull-requests`}>Pull requests</Link>.
            </div>
          ) : (
            <NoRepoCard project={project} />
          )}
          {project.gitUrl && <Browser project={project} />}
        </>
      )}
    </>
  );
}
