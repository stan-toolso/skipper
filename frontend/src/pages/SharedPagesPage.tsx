import { useQuery } from '@apollo/client';
import { useMemo, useState } from 'react';
import { Alert } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { sharedPageUrl } from '../apollo';
import { useAuth } from '../auth/AuthContext';
import PageLoading from '../components/PageLoading';
import ProjectHeader, { type ProjectHeaderProject } from '../components/ProjectHeader';
import FavoriteButton from '../components/pages/FavoriteButton';
import { useSessionLauncher } from '../components/SessionLauncher';
import { PULL_REQUESTS_PROJECT } from '../graphql/pullRequests';
import { SHARED_PAGES, type ArtifactKind, type SharedPage } from '../graphql/misc';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import './artifacts.css';

type Filter = 'all' | 'mine' | 'shared' | 'favorites';
type KindFilter = 'all' | ArtifactKind;

export function accessLabel(page: Pick<SharedPage, 'linkAccess' | 'projectAccess' | 'members'> & { publicAccess?: boolean }): { icon: string; text: string } {
  if (page.publicAccess) return { icon: 'bi-globe', text: 'Publique : tout le monde avec le lien, sans connexion' };
  if (page.linkAccess) return { icon: 'bi-building', text: 'Toute personne de Skipper avec le lien' };
  if (page.projectAccess) return { icon: 'bi-people', text: `Membres du projet${page.members.length ? ` et ${page.members.length} personne${page.members.length > 1 ? 's' : ''}` : ''}` };
  if (page.members.length) return { icon: 'bi-people', text: `Partagée avec ${page.members.length} personne${page.members.length > 1 ? 's' : ''}` };
  return { icon: 'bi-lock', text: 'Privée' };
}

/** Types d'artefacts : libellé, icône et teinte. D'autres types viendront (diapositives…) : une entrée ici, une valeur de l'enum ArtifactKind. */
export const ARTIFACT_KINDS: Record<ArtifactKind, { label: string; plural: string; icon: string; className: string; hint: string; prompt: string }> = {
  PAGE: {
    label: 'Page',
    plural: 'Pages',
    icon: 'bi-file-earmark-richtext',
    className: 'af-kind-page',
    hint: 'Un rapport, une maquette, une note : une page HTML écrite par un agent.',
    prompt: "Crée une page (artefact) qui présente : …\n\nPublie-la avec pages.publish et donne-moi le lien.",
  },
  DATA: {
    label: 'Données',
    plural: 'Données',
    icon: 'bi-bar-chart-line',
    className: 'af-kind-data',
    hint: 'Un tableau de bord dont les chiffres se rafraîchissent tout seuls (SQL du coffre, scripts).',
    prompt: "Crée un tableau de bord (artefact de données, kind: data) qui montre : …\n\nSources : la base « … » du coffre (regarde son schéma avec vault.sql_schema et mets les requêtes au point avec vault.sql_query avant de les déclarer). Rafraîchissement toutes les heures (refresh_minutes: 60). Publie-le avec pages.publish et donne-moi le lien.",
  },
  SLIDES: {
    label: 'Diapositives',
    plural: 'Diapositives',
    icon: 'bi-easel',
    className: 'af-kind-slides',
    hint: 'Une présentation à partir de vos idées, de notes ou d’un document : navigation, grille, plein écran, PDF.',
    prompt: "Crée une présentation (artefact de diapositives, kind: slides) sur : …\n\nPublic : … Une dizaine de diapositives, une idée par diapositive, sobre et lisible. Publie-la avec pages.publish et donne-moi le lien.",
  },
};

/** État d'un artefact de données pour la carte : à jour, en erreur, ou jamais rafraîchi. */
function dataState(page: SharedPage): { className: string; icon: string; text: string } | null {
  if (page.kind !== 'DATA') return null;
  const failing = page.sources.filter((s) => s.status === 'error' || s.status === 'skipped').length;
  if (failing) return { className: 'warn', icon: 'bi-exclamation-circle', text: `${failing} source${failing > 1 ? 's' : ''} en défaut` };
  if (!page.dataRefreshedAt) return { className: '', icon: 'bi-hourglass', text: 'Pas encore rafraîchi' };
  return { className: 'live', icon: page.refreshMinutes ? 'bi-arrow-repeat' : 'bi-check2', text: `Données ${timeAgo(page.dataRefreshedAt)}` };
}

function ArtifactCard({ page, mine }: { page: SharedPage; mine: boolean }) {
  const kind = ARTIFACT_KINDS[page.kind] ?? ARTIFACT_KINDS.PAGE;
  const state = dataState(page);
  const [broken, setBroken] = useState(false);
  return (
    <div className="af-card-wrap">
      <Link to={`/shared/${page.id}`} className="af-card" title={page.description ?? page.title}>
        <div className={`af-thumb ${kind.className}`}>
          <div className="af-thumb-inner">
            {broken ? (
              <div className="af-thumb-fallback">
                <i className={`bi ${kind.icon}`} />
              </div>
            ) : (
              // Aperçu réduit de la page elle-même (bac à sable, sans interaction) ; `thumb=1` : l'ouverture n'est pas comptée.
              <iframe src={`${sharedPageUrl(page.id)}?thumb=1`} title="" aria-hidden tabIndex={-1} loading="lazy" sandbox="allow-scripts" onError={() => setBroken(true)} />
            )}
          </div>
        </div>
        <div className="af-card-body">
          <span className={`af-card-icon ${kind.className}`}>
            <i className={`bi ${kind.icon}`} />
          </span>
          <div className="af-card-text">
            <div className="af-card-title">{page.title}</div>
            <div className="af-card-sub">
              <span title={new Date(page.updatedAt).toLocaleString()}>Mis à jour {timeAgo(page.updatedAt)}</span>
              <span className="sep">·</span>
              <span>{mine ? 'Vous' : page.owner.name}</span>
            </div>
          </div>
          {page.openComments > 0 && (
            <span className="af-card-badge comments" title={`${page.openComments} commentaire${page.openComments > 1 ? 's' : ''} à traiter`}>
              <i className="bi bi-chat-left-text" /> {page.openComments}
            </span>
          )}
          {state && !page.openComments && (
            <span className={`af-card-badge ${state.className}`} title={state.text}>
              <i className={`bi ${state.icon}`} />
              <span className="d-none d-sm-inline">{state.text}</span>
            </span>
          )}
        </div>
      </Link>
      <FavoriteButton page={page} className="af-fav" />
    </div>
  );
}

/**
 * Artefacts : ce que les agents produisent pour les personnes — pages HTML et tableaux de bord de données — privés
 * jusqu'au partage. Tuiles de création (une session lancée avec une consigne à compléter), filtres, cartes avec un
 * aperçu réduit de chaque artefact et une étoile « favori » (le lien reste dans la sidebar).
 *
 * Deux adresses : /shared (tous les artefacts de la personne) et /projects/<id>/artifacts (onglet Artefacts du projet :
 * ceux du projet qu'elle voit, y compris ceux dont le lien est ouvert ; les tuiles lancent la session dans ce projet).
 */
export default function SharedPagesPage() {
  const { id: projectId = null } = useParams();
  const { user } = useAuth();
  // Invité des pages partagées : il ne publie rien, la page ne liste que ce qu'on lui a partagé.
  const guest = Boolean(user?.isGuest);
  const projectQ = useQuery<{ project: ProjectHeaderProject | null }>(PULL_REQUESTS_PROJECT, { variables: { id: projectId }, skip: !projectId });
  const project = projectQ.data?.project ?? null;
  useTabTitle(projectId ? (project ? `Artefacts · ${project.name}` : null) : 'Artefacts');
  const { openNewSession } = useSessionLauncher();
  const [filter, setFilter] = useState<Filter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');
  const { data, loading, error } = usePollingQuery<{ sharedPages: SharedPage[] }>(SHARED_PAGES, { variables: { projectId }, pollInterval: 30_000 });
  // Un lecteur du projet ne lance pas de session : pas de tuiles de création.
  const canCreate = !guest && (!projectId || project?.myRole === 'ADMIN' || project?.myRole === 'MEMBER');
  const pages = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.sharedPages ?? [])
      .filter((p) => (filter === 'mine' ? p.owner.id === user?.id : filter === 'shared' ? p.owner.id !== user?.id : filter === 'favorites' ? p.favorite : true))
      .filter((p) => kind === 'all' || p.kind === kind)
      .filter((p) => !q || p.title.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q) || p.owner.name.toLowerCase().includes(q));
  }, [data, filter, kind, search, user?.id]);
  if ((loading && !data) || (projectId && projectQ.loading && !project)) return <PageLoading />;
  if (error || projectQ.error) return <Alert variant="danger">Erreur : {(error ?? projectQ.error)!.message}</Alert>;
  if (projectId && !project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const counts = { PAGE: 0, DATA: 0, SLIDES: 0 } as Record<ArtifactKind, number>;
  for (const p of data?.sharedPages ?? []) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  const empty =
    guest ? 'Aucun artefact partagé avec vous pour le moment.' : search.trim() ? 'Aucun artefact ne correspond à cette recherche.' : filter === 'mine' ? "Vous n'avez pas encore d'artefact : demandez-en un à un agent, ou partez d'une tuile ci-dessus." : filter === 'shared' ? 'Aucun artefact partagé avec vous.' : filter === 'favorites' ? 'Aucun favori : cliquez sur l’étoile d’un artefact pour garder son lien dans la sidebar.' : projectId ? 'Aucun artefact dans ce projet pour le moment : partez d’une tuile ci-dessus.' : 'Aucun artefact pour le moment.';
  return (
    <div className="af-page">
      {project && <ProjectHeader project={project} active="artifacts" />}
      <div className="af-head">
        <h1 className={project ? 'af-h1-sub' : undefined}>{guest ? 'Artefacts partagés avec vous' : project ? 'Artefacts du projet' : 'Artefacts'}</h1>
        {!guest && (
          <div className="af-filters" role="tablist" aria-label="Qui">
            {(
              [
                ['all', 'Tous'],
                ['mine', 'Les vôtres'],
                ['shared', 'Partagés avec vous'],
                ['favorites', 'Favoris'],
              ] as [Filter, string][]
            ).map(([f, label]) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {counts.DATA + counts.SLIDES > 0 && (
          <div className="af-filters" role="tablist" aria-label="Type">
            {(
              [
                ['all', 'Tous types'],
                ['PAGE', ARTIFACT_KINDS.PAGE.plural],
                ['DATA', ARTIFACT_KINDS.DATA.plural],
                ['SLIDES', ARTIFACT_KINDS.SLIDES.plural],
              ] as [KindFilter, string][]
            ).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {label}
              </button>
            ))}
          </div>
        )}
        <label className="af-search">
          <i className="bi bi-search" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher" aria-label="Rechercher un artefact" />
        </label>
      </div>
      {canCreate && (
        <>
          <p className="af-section">{project ? `Créer quelque chose de nouveau dans ${project.isPersonal ? 'votre espace' : `« ${project.name} »`}` : 'Créer quelque chose de nouveau'}</p>
          <div className="af-create">
            {(Object.entries(ARTIFACT_KINDS) as [ArtifactKind, (typeof ARTIFACT_KINDS)[ArtifactKind]][]).map(([k, def]) => (
              <button key={k} type="button" className={`af-tile${k !== 'PAGE' ? ' beta' : ''}`} onClick={() => openNewSession({ projectId, prompt: def.prompt })} title={`${def.label} : ${def.hint}`}>
                <div className={`af-tile-art ${def.className}`}>
                  <i className={`bi ${def.icon}`} />
                </div>
                <div className="af-tile-label">{def.label}</div>
                <div className="af-tile-hint">{def.hint}</div>
              </button>
            ))}
          </div>
        </>
      )}
      {guest && <p className="text-secondary small">Les artefacts que l'on a partagés avec vous. Ouvrez-en un pour le lire et y laisser des commentaires, généraux ou sur un endroit précis.</p>}
      {pages.length === 0 ? (
        <div className="af-empty">
          <i className="bi bi-collection" />
          {empty}
        </div>
      ) : (
        <div className="af-grid">
          {pages.map((p) => (
            <ArtifactCard key={p.id} page={p} mine={p.owner.id === user?.id} />
          ))}
        </div>
      )}
    </div>
  );
}
