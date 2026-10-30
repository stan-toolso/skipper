import { useApolloClient, type ApolloCache } from '@apollo/client';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import { DELETE_PROJECT, DELETE_SESSION, DELETE_TERMINAL } from '../graphql/operations';
import { ARCHIVE_SESSION } from '../graphql/sessions';
import { useTabs } from './TabsContext';

export interface DeletableSession {
  id: string;
  name: string;
  /** Branche de son dossier de travail (projet git) : proposée à la suppression avec la session. */
  branch?: string | null;
}

export interface DeletableTerminal {
  id: string;
  name: string;
}

export interface DeletableProject {
  id: string;
  name: string;
  /** Chemins des onglets ouverts sur le projet (sessions, terminaux) à fermer avec lui. */
  paths: string[];
}

function evict(cache: ApolloCache<unknown>, __typename: string, id: string): void {
  cache.evict({ id: cache.identify({ __typename, id }) });
}

/**
 * Archivages et suppressions de sessions et de terminaux, affichés tout de suite : l'onglet se ferme et l'élément
 * disparaît des listes (couche optimiste du cache Apollo) pendant que le serveur travaille. En cas d'erreur, la
 * couche est retirée et l'élément réapparaît.
 *
 * Le dossier de travail d'une session (sa work session, notion technique) suit la session : archivé avec elle
 * (terminaux fermés, dossier et branche conservés), supprimé avec elle (la branche reste sauf demande).
 */
export function useDeletions() {
  const client = useApolloClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { confirm, showError } = useDialogs();
  const { closeMatching } = useTabs();

  const hide = (layer: string, tabs: (key: string) => boolean, objects: [string, string][]) => {
    flushSync(() => closeMatching(tabs));
    client.cache.recordOptimisticTransaction((cache) => {
      for (const [typename, id] of objects) evict(cache, typename, id);
    }, layer);
  };

  const finish = async (layer: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      void showError(err);
    } finally {
      client.cache.removeOptimistic(layer);
      client.cache.gc();
      void client.refetchQueries({ include: ['Sidebar'] }).catch(() => undefined);
    }
  };

  /** L'onglet de la session (sa page, ses fichiers, son navigateur, ses terminaux). */
  const sessionTabs = (id: string) => (key: string) => key === `/sessions/${id}` || key.startsWith(`/sessions/${id}/`);

  const archiveSession = async (session: DeletableSession) => {
    const ok = await confirm({
      title: 'Archiver la session',
      message: `Archiver la session « ${session.name} » ? Elle quitte la barre latérale avec son dossier de travail (terminaux fermés, modifications et branche conservées) et reste consultable, restaurable et relançable depuis l'historique du projet.`,
      confirmLabel: 'Archiver',
    });
    if (!ok) return;
    const layer = `archive:session:${session.id}`;
    hide(layer, sessionTabs(session.id), [['Session', session.id]]);
    await finish(layer, async () => {
      await client.mutate({ mutation: ARCHIVE_SESSION, variables: { id: session.id }, update: (cache) => evict(cache, 'Session', session.id) });
    });
  };

  const deleteSession = async (session: DeletableSession) => {
    const opts = {
      title: 'Supprimer la session',
      message: `Supprimer définitivement la session « ${session.name} » et tout son historique ? Son dossier de travail est supprimé avec elle (les modifications non validées sont perdues). Cette action est irréversible.`,
      confirmLabel: 'Supprimer définitivement',
      danger: true,
    };
    // Projet git : la branche de la session reste, sauf demande.
    const res = session.branch ? await confirm({ ...opts, checkbox: { label: `Supprimer aussi la branche ${session.branch}` } }) : (await confirm(opts)) ? { checked: false } : null;
    if (!res) return;
    const layer = `delete:session:${session.id}`;
    hide(layer, sessionTabs(session.id), [['Session', session.id]]);
    await finish(layer, async () => {
      await client.mutate({ mutation: DELETE_SESSION, variables: { id: session.id, deleteBranch: res.checked }, update: (cache) => evict(cache, 'Session', session.id) });
    });
  };

  const deleteTerminal = async (terminal: DeletableTerminal) => {
    const ok = await confirm({
      title: 'Supprimer le terminal',
      message: `Supprimer le terminal « ${terminal.name} » ? Le shell sera fermé s'il est encore ouvert.`,
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (!ok) return;
    const path = `/terminals/${terminal.id}`;
    const layer = `delete:terminal:${terminal.id}`;
    hide(layer, (key) => key === path || key.startsWith(`${path}/`), [['Terminal', terminal.id]]);
    await finish(layer, async () => {
      await client.mutate({ mutation: DELETE_TERMINAL, variables: { id: terminal.id }, update: (cache) => evict(cache, 'Terminal', terminal.id) });
    });
  };

  /** Suppression d'un projet (administrateurs) : tout ce qu'il contient disparaît, les onglets se ferment, la page revient à la liste des projets. */
  const deleteProject = async (project: DeletableProject) => {
    const ok = await confirm({
      title: 'Supprimer le projet',
      message: `Supprimer le projet « ${project.name} » ? Ses sessions (arrêtées) et leurs dossiers de travail, ses terminaux, ses workflows, son conteneur et son dossier principal seront supprimés. Irréversible.`,
      confirmLabel: 'Supprimer définitivement',
      danger: true,
    });
    if (!ok) return;
    const prefixes = [`/projects/${project.id}`, ...project.paths];
    const inside = (path: string) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));
    const layer = `delete:project:${project.id}`;
    hide(layer, inside, [['Project', project.id]]);
    if (inside(location.pathname)) navigate('/projects');
    await finish(layer, async () => {
      await client.mutate({ mutation: DELETE_PROJECT, variables: { id: project.id }, update: (cache) => evict(cache, 'Project', project.id) });
      void client.refetchQueries({ include: ['Projects'] }).catch(() => undefined);
    });
  };

  return { deleteProject, archiveSession, deleteSession, deleteTerminal };
}
