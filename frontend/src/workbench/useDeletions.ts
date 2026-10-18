import { useApolloClient, type ApolloCache } from '@apollo/client';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import { ARCHIVE_WORKSESSION, DELETE_PROJECT, DELETE_SESSION, DELETE_TERMINAL, DELETE_WORKSESSION, WORKSESSION_CONTENTS } from '../graphql/operations';
import { ARCHIVE_SESSION } from '../graphql/sessions';
import { useTabs } from './TabsContext';

interface WorksessionContents {
  worksession: { id: string; branch: string; label: string; sessions: { id: string }[]; terminals: { id: string }[] } | null;
}

export interface DeletableItem {
  id: string;
  name: string;
  worksessionId?: string | null;
}

export interface DeletableWorksession {
  id: string;
  branch: string;
  label: string;
}

export interface DeletableProject {
  id: string;
  name: string;
  /** Chemins des onglets ouverts sur le projet (sessions, terminaux, worksessions) à fermer avec lui. */
  paths: string[];
}

const typenames = { session: 'Session', terminal: 'Terminal' } as const;

function evict(cache: ApolloCache<unknown>, __typename: string, id: string): void {
  cache.evict({ id: cache.identify({ __typename, id }) });
}

/**
 * Archivages et suppressions de sessions, terminaux et worksessions, affichés tout de suite : l'onglet se ferme
 * (ou revient sur ses fichiers) et l'élément disparaît des listes (couche optimiste du cache Apollo) pendant
 * que le serveur travaille. En cas d'erreur, la couche est retirée et l'élément réapparaît.
 *
 * Quand on retire le dernier élément d'une work session, la confirmation propose d'archiver aussi la work session,
 * qui serait sinon laissée vide (case cochée par défaut à l'archivage). Archiver une session qui n'est pas la
 * dernière de sa work session ne demande pas de confirmation : rien n'est perdu.
 */
export function useDeletions() {
  const client = useApolloClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { confirm, alert, showError } = useDialogs();
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

  /** La work session ne contiendra plus rien une fois l'élément retiré ? */
  const lastInWorksession = async (kind: 'session' | 'terminal', item: DeletableItem, fetchPolicy: 'cache-first' | 'network-only'): Promise<DeletableWorksession | null> => {
    if (!item.worksessionId) return null;
    try {
      const { data } = await client.query<WorksessionContents>({ query: WORKSESSION_CONTENTS, variables: { id: item.worksessionId }, fetchPolicy });
      const w = data.worksession;
      if (!w) return null;
      const others = [...w.sessions.filter((s) => kind !== 'session' || s.id !== item.id), ...w.terminals.filter((t) => kind !== 'terminal' || t.id !== item.id)];
      return others.length === 0 ? { id: w.id, branch: w.branch, label: w.label } : null;
    } catch {
      return null;
    }
  };

  const archiveWorksessionIfStillEmpty = async (kind: 'session' | 'terminal', item: DeletableItem, worksession: DeletableWorksession) => {
    // Vérifié à nouveau auprès du serveur : un agent a pu y ouvrir une session pendant la confirmation.
    if (await lastInWorksession(kind, item, 'network-only')) {
      await client.mutate({ mutation: ARCHIVE_WORKSESSION, variables: { id: worksession.id }, update: (cache) => evict(cache, 'Worksession', worksession.id) });
    } else {
      void alert({ title: 'Worksession conservé', message: `La work session « ${worksession.label} » n'a pas été archivé : une session ou un terminal y a été ouvert entre-temps.` });
    }
  };

  const archiveSession = async (session: DeletableItem) => {
    const path = `/sessions/${session.id}`;
    const worksession = await lastInWorksession('session', session, 'cache-first');
    let withWorksession = false;
    if (worksession) {
      const res = await confirm({
        title: 'Archiver la session',
        message: `Archiver la session « ${session.name} » ? Elle reste consultable et relançable depuis l'historique du projet.`,
        confirmLabel: 'Archiver',
        checkbox: { label: `Archiver aussi la work session « ${worksession.label} », qui sera vide (restaurable depuis l'historique avec ses sessions)`, defaultChecked: true },
      });
      if (!res) return;
      withWorksession = res.checked;
    }
    const layer = `archive:session:${session.id}`;
    hide(layer, (key) => key === path || key.startsWith(`${path}/`) || (withWorksession && key.startsWith(`/worksessions/${worksession?.id}/`)), [['Session', session.id], ...(withWorksession && worksession ? [['Worksession', worksession.id] as [string, string]] : [])]);
    await finish(layer, async () => {
      await client.mutate({ mutation: ARCHIVE_SESSION, variables: { id: session.id }, update: (cache) => evict(cache, 'Session', session.id) });
      if (withWorksession && worksession) await archiveWorksessionIfStillEmpty('session', session, worksession);
    });
  };

  const removeItem = async (kind: 'session' | 'terminal', item: DeletableItem) => {
    const path = `/${kind}s/${item.id}`;
    const worksession = await lastInWorksession(kind, item, 'cache-first');
    const opts = {
      title: kind === 'session' ? 'Supprimer la session' : 'Supprimer le terminal',
      message: kind === 'session' ? `Supprimer définitivement la session « ${item.name} » et tout son historique ? Cette action est irréversible.` : `Supprimer le terminal « ${item.name} » ? Le shell sera fermé s'il est encore ouvert.`,
      confirmLabel: kind === 'session' ? 'Supprimer définitivement' : 'Supprimer',
      danger: true,
    };
    let withWorksession = false;
    if (worksession) {
      const res = await confirm({ ...opts, checkbox: { label: `Archiver aussi la work session « ${worksession.label} », qui sera vide (restaurable depuis l'historique)` } });
      if (!res) return;
      withWorksession = res.checked;
    } else if (!(await confirm(opts))) return;

    const layer = `delete:${kind}:${item.id}`;
    hide(layer, (key) => key === path || key.startsWith(`${path}/`) || (withWorksession && key.startsWith(`/worksessions/${worksession?.id}/`)), [[typenames[kind], item.id], ...(withWorksession && worksession ? [['Worksession', worksession.id] as [string, string]] : [])]);
    await finish(layer, async () => {
      await client.mutate({ mutation: kind === 'session' ? DELETE_SESSION : DELETE_TERMINAL, variables: { id: item.id }, update: (cache) => evict(cache, typenames[kind], item.id) });
      if (withWorksession && worksession) await archiveWorksessionIfStillEmpty(kind, item, worksession);
    });
  };

  const worksessionPaths = (worksession: DeletableWorksession) => {
    const cached = client.readQuery<WorksessionContents>({ query: WORKSESSION_CONTENTS, variables: { id: worksession.id } })?.worksession;
    return new Set([...(cached?.sessions ?? []).map((s) => `/sessions/${s.id}`), ...(cached?.terminals ?? []).map((t) => `/terminals/${t.id}`)]);
  };

  const archiveWorksession = async (worksession: DeletableWorksession) => {
    const ok = await confirm({
      title: 'Archiver la work session',
      message: `Archiver la work session « ${worksession.label} » ? Ses sessions sont archivées (arrêtées si elles tournent), ses terminaux fermés ; son dossier et sa branche sont conservés. Restaurez-le avec ses sessions depuis l'historique du projet.`,
      confirmLabel: 'Archiver',
    });
    if (!ok) return;
    const paths = worksessionPaths(worksession);
    const layer = `archive:worksession:${worksession.id}`;
    hide(layer, (key) => key.startsWith(`/worksessions/${worksession.id}/`) || paths.has(key) || [...paths].some((p) => key.startsWith(`${p}/`)), [['Worksession', worksession.id]]);
    await finish(layer, async () => {
      await client.mutate({ mutation: ARCHIVE_WORKSESSION, variables: { id: worksession.id }, update: (cache) => evict(cache, 'Worksession', worksession.id) });
    });
  };

  const removeWorksession = async (worksession: DeletableWorksession) => {
    const res = await confirm({
      title: 'Supprimer la work session',
      message: `Supprimer la work session « ${worksession.label} » ? Son dossier est supprimé (les fichiers non validés sont perdus) et ses terminaux fermés. Ses sessions sont conservées : arrêtées si elles tournent, puis archivées avec leur transcript, leur coût et leur planification, consultables dans l'historique du projet. Pour pouvoir le restaurer tel quel, préférez l'archivage.`,
      confirmLabel: 'Supprimer',
      danger: true,
      checkbox: { label: 'Supprimer aussi la branche locale' },
    });
    if (!res) return;
    const paths = worksessionPaths(worksession);
    const layer = `delete:worksession:${worksession.id}`;
    hide(layer, (key) => key.startsWith(`/worksessions/${worksession.id}/`) || paths.has(key) || [...paths].some((p) => key.startsWith(`${p}/`)), [['Worksession', worksession.id]]);
    await finish(layer, async () => {
      await client.mutate({ mutation: DELETE_WORKSESSION, variables: { id: worksession.id, deleteBranch: res.checked }, update: (cache) => evict(cache, 'Worksession', worksession.id) });
    });
  };

  /** Suppression d'un projet (administrateurs) : tout ce qu'il contient disparaît, les onglets se ferment, la page revient à la liste des projets. */
  const deleteProject = async (project: DeletableProject) => {
    const ok = await confirm({
      title: 'Supprimer le projet',
      message: `Supprimer le projet « ${project.name} » ? Ses sessions (arrêtées), terminaux, work sessions, agents, workflows, son conteneur et son dossier de travail seront supprimés. Irréversible.`,
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

  return {
    deleteProject,
    archiveSession,
    deleteSession: (session: DeletableItem) => removeItem('session', session),
    deleteTerminal: (terminal: DeletableItem) => removeItem('terminal', terminal),
    archiveWorksession,
    deleteWorksession: removeWorksession,
  };
}
