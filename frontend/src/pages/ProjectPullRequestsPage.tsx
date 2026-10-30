import { useMutation, useQuery } from '@apollo/client';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, ButtonGroup, Form } from 'react-bootstrap';
import { useParams } from 'react-router-dom';
import PageLoading from '../components/PageLoading';
import ProjectHeader from '../components/ProjectHeader';
import { RegisterPullRequestModal, TrackedPullRequestTable } from '../components/TrackedPullRequests';
import { PULL_REQUESTS, PULL_REQUESTS_PROJECT, STAGE_LABELS, STAGE_ORDER, SYNC_PULL_REQUESTS, type PullRequestStage, type TrackedPullRequest } from '../graphql/pullRequests';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useTabTitle } from '../workbench/TabsContext';

interface PageProject {
  id: string;
  name: string;
  description: string | null;
  myRole: 'ADMIN' | 'MEMBER' | 'VIEWER';
  isPersonal: boolean;
  gitUrl: string | null;
}

type Filter = 'pending' | 'all' | PullRequestStage;
const PENDING: PullRequestStage[] = ['TO_MERGE', 'DRAFT', 'TO_DEPLOY'];
const FILTER_KEY = 'skipper.pullRequests.filter';

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Pull requests suivies d'un projet, par étape : à fusionner, brouillons, à déployer, déployées, annulées. La liste est
 * synchronisée avec GitHub au chargement (au plus toutes les 30 s) ; « Rafraîchir » force la synchronisation.
 */
export default function ProjectPullRequestsPage() {
  const { id = '' } = useParams();
  const projectQ = useQuery<{ project: PageProject | null }>(PULL_REQUESTS_PROJECT, { variables: { id } });
  const prsQ = usePollingQuery<{ pullRequests: TrackedPullRequest[] }>(PULL_REQUESTS, { variables: { projectId: id, limit: 500 }, pollInterval: 30_000, fetchPolicy: 'cache-and-network' });
  const [sync, { loading: syncing }] = useMutation(SYNC_PULL_REQUESTS, { refetchQueries: ['PullRequests'] });
  const [filter, setFilter] = useState<Filter>(() => (localStorage.getItem(FILTER_KEY) as Filter | null) ?? 'pending');
  const [search, setSearch] = useState('');
  const [registering, setRegistering] = useState(false);
  const project = projectQ.data?.project;
  useTabTitle(project ? `Pull requests · ${project.name}` : null);
  useGitTarget(project?.gitUrl ? { projectId: project.id, worksessionId: null, label: project.name } : null);

  const all = prsQ.data?.pullRequests ?? [];
  const counts = useMemo(() => {
    const c = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0])) as Record<PullRequestStage, number>;
    for (const pr of all) c[pr.stage]++;
    return c;
  }, [all]);
  const shown = useMemo(() => {
    const q = fold(search.trim());
    return all.filter((pr) => (filter === 'all' ? true : filter === 'pending' ? PENDING.includes(pr.stage) : pr.stage === filter)).filter((pr) => !q || fold(`#${pr.number} ${pr.title} ${pr.headBranch} ${pr.note} ${pr.task?.title ?? ''}`).includes(q));
  }, [all, filter, search]);
  const groups = useMemo(() => STAGE_ORDER.map((stage) => ({ stage, prs: shown.filter((pr) => pr.stage === stage) })).filter((g) => g.prs.length > 0), [shown]);
  const pick = (f: Filter) => {
    setFilter(f);
    localStorage.setItem(FILTER_KEY, f);
  };

  if (projectQ.loading && !project) return <PageLoading />;
  if (projectQ.error) return <Alert variant="danger">Erreur : {projectQ.error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const canWrite = project.myRole === 'ADMIN' || project.myRole === 'MEMBER';
  const pending = counts.TO_MERGE + counts.DRAFT + counts.TO_DEPLOY;

  return (
    <>
      <ProjectHeader project={project} active="pullRequests" />
      <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
        <ButtonGroup size="sm" className="flex-wrap">
          <Button variant={filter === 'pending' ? 'secondary' : 'outline-secondary'} onClick={() => pick('pending')} title="À fusionner, brouillons et à déployer">
            À traiter {pending > 0 && <Badge bg="light" text="dark" className="ms-1">{pending}</Badge>}
          </Button>
          {STAGE_ORDER.map((s) => (
            <Button key={s} variant={filter === s ? 'secondary' : 'outline-secondary'} onClick={() => pick(s)} title={STAGE_LABELS[s].hint}>
              {STAGE_LABELS[s].plural} {counts[s] > 0 && <Badge bg="light" text="dark" className="ms-1">{counts[s]}</Badge>}
            </Button>
          ))}
          <Button variant={filter === 'all' ? 'secondary' : 'outline-secondary'} onClick={() => pick('all')}>
            Toutes
          </Button>
        </ButtonGroup>
        <Form.Control size="sm" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filtrer (titre, numéro, branche, tâche, note)" style={{ width: 260 }} />
        <div className="ms-auto d-flex gap-2">
          <Button size="sm" variant="outline-secondary" disabled={syncing || !project.gitUrl} title="Relire l'état des pull requests sur GitHub" onClick={() => void sync({ variables: { projectId: id } }).catch(() => undefined)}>
            <i className={`bi bi-arrow-clockwise me-1${syncing ? ' spin' : ''}`} /> Rafraîchir
          </Button>
          {canWrite && (
            <Button size="sm" onClick={() => setRegistering(true)}>
              <i className="bi bi-plus-lg me-1" /> Suivre une PR
            </Button>
          )}
        </div>
      </div>
      {prsQ.error && <Alert variant="warning" className="py-2 small">Liste indisponible : {prsQ.error.message}</Alert>}
      {!project.gitUrl && <Alert variant="secondary" className="py-2 small">Ce projet n'est pas relié à un dépôt git : les pull requests suivies ne sont pas synchronisées avec GitHub.</Alert>}
      {prsQ.loading && !prsQ.data && <PageLoading />}
      {prsQ.data && groups.length === 0 && (
        <div className="text-secondary fst-italic small">
          {all.length === 0
            ? "Aucune pull request suivie. Les agents les déclarent avec les outils tasks.pr_open et pr_register ; les PR ouvertes depuis le panneau git ou sur la branche d'une tâche sont suivies automatiquement."
            : 'Aucune pull request ne correspond à ce filtre.'}
        </div>
      )}
      {groups.map((g) => (
        <section key={g.stage} className="mb-4">
          <h2 className="h6 d-flex align-items-center gap-2 mb-2">
            <i className={`bi ${STAGE_LABELS[g.stage].icon}`} />
            {STAGE_LABELS[g.stage].plural}
            <Badge bg="secondary" pill>
              {g.prs.length}
            </Badge>
            <span className="small text-secondary fw-normal">{STAGE_LABELS[g.stage].hint}</span>
          </h2>
          <div className="border rounded">
            <TrackedPullRequestTable prs={g.prs} />
          </div>
        </section>
      ))}
      {registering && <RegisterPullRequestModal projectId={id} onClose={() => setRegistering(false)} />}
    </>
  );
}
