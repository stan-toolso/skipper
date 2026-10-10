import { useApolloClient, type ApolloCache } from '@apollo/client';
import { flushSync } from 'react-dom';
import { useDialogs } from '../components/Dialogs';
import { ARCHIVE_WORKTREE, DELETE_SESSION, DELETE_TERMINAL, DELETE_WORKTREE, WORKTREE_CONTENTS } from '../graphql/operations';
import { ARCHIVE_SESSION } from '../graphql/sessions';
import { useTabs } from './TabsContext';

interface WorktreeContents {
  worktree: { id: string; branch: string; label: string; sessions: { id: string }[]; terminals: { id: string }[] } | null;
}

export interface DeletableItem {
  id: string;
  name: string;
  worktreeId?: string | null;
}

export interface DeletableWorktree {
  id: string;
  branch: string;
  label: string;
}

const typenames = { session: 'Session', terminal: 'Terminal' } as const;

function evict(cache: ApolloCache<unknown>, __typename: string, id: string): void {
  cache.evict({ id: cache.identify({ __typename, id }) });
}

/**
 * Archivages et suppressions de sessions, terminaux et worktrees, affichés tout de suite : l'onglet se ferme
 * (ou revient sur ses fichiers) et l'élément disparaît des listes (couche optimiste du cache Apollo) pendant
 * que le serveur travaille. En cas d'erreur, la couche est retirée et l'élément réapparaît.
 *
 * Quand on retire le dernier élément d'un worktree, la confirmation propose d'archiver aussi le worktree,
 * qui serait sinon laissé vide. Archiver une session ne demande pas de confirmation : rien n'est perdu.
 */
export function useDeletions() {
  const client = useApolloClient();
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

  /** Le worktree ne contiendra plus rien une fois l'élément retiré ? */
  const lastInWorktree = async (kind: 'session' | 'terminal', item: DeletableItem, fetchPolicy: 'cache-first' | 'network-only'): Promise<DeletableWorktree | null> => {
    if (!item.worktreeId) return null;
    try {
      const { data } = await client.query<WorktreeContents>({ query: WORKTREE_CONTENTS, variables: { id: item.worktreeId }, fetchPolicy });
      const w = data.worktree;
      if (!w) return null;
      const others = [...w.sessions.filter((s) => kind !== 'session' || s.id !== item.id), ...w.terminals.filter((t) => kind !== 'terminal' || t.id !== item.id)];
      return others.length === 0 ? { id: w.id, branch: w.branch, label: w.label } : null;
    } catch {
      return null;
    }
  };

  const archiveWorktreeIfStillEmpty = async (kind: 'session' | 'terminal', item: DeletableItem, worktree: DeletableWorktree) => {
    // Vérifié à nouveau auprès du serveur : un agent a pu y ouvrir une session pendant la confirmation.
    if (await lastInWorktree(kind, item, 'network-only')) {
      await client.mutate({ mutation: ARCHIVE_WORKTREE, variables: { id: worktree.id }, update: (cache) => evict(cache, 'Worktree', worktree.id) });
    } else {
      void alert({ title: 'Worktree conservé', message: `Le worktree « ${worktree.label} » n'a pas été archivé : une session ou un terminal y a été ouvert entre-temps.` });
    }
  };

  const archiveSession = async (session: DeletableItem) => {
    const path = `/sessions/${session.id}`;
    const worktree = await lastInWorktree('session', session, 'cache-first');
    let withWorktree = false;
    if (worktree) {
      const res = await confirm({
        title: 'Archiver la session',
        message: `Archiver la session « ${session.name} » ? Elle reste consultable et relançable depuis l'historique du projet.`,
        confirmLabel: 'Archiver',
        checkbox: { label: `Archiver aussi le worktree « ${worktree.label} », qui sera vide (restaurable depuis l'historique avec ses sessions)` },
      });
      if (!res) return;
      withWorktree = res.checked;
    }
    const layer = `archive:session:${session.id}`;
    hide(layer, (key) => key === path || key.startsWith(`${path}/`) || (withWorktree && key.startsWith(`/worktrees/${worktree?.id}/`)), [['Session', session.id], ...(withWorktree && worktree ? [['Worktree', worktree.id] as [string, string]] : [])]);
    await finish(layer, async () => {
      await client.mutate({ mutation: ARCHIVE_SESSION, variables: { id: session.id }, update: (cache) => evict(cache, 'Session', session.id) });
      if (withWorktree && worktree) await archiveWorktreeIfStillEmpty('session', session, worktree);
    });
  };

  const removeItem = async (kind: 'session' | 'terminal', item: DeletableItem) => {
    const path = `/${kind}s/${item.id}`;
    const worktree = await lastInWorktree(kind, item, 'cache-first');
    const opts = {
      title: kind === 'session' ? 'Supprimer la session' : 'Supprimer le terminal',
      message: kind === 'session' ? `Supprimer définitivement la session « ${item.name} » et tout son historique ? Cette action est irréversible.` : `Supprimer le terminal « ${item.name} » ? Le shell sera fermé s'il est encore ouvert.`,
      confirmLabel: kind === 'session' ? 'Supprimer définitivement' : 'Supprimer',
      danger: true,
    };
    let withWorktree = false;
    if (worktree) {
      const res = await confirm({ ...opts, checkbox: { label: `Archiver aussi le worktree « ${worktree.label} », qui sera vide (restaurable depuis l'historique)` } });
      if (!res) return;
      withWorktree = res.checked;
    } else if (!(await confirm(opts))) return;

    const layer = `delete:${kind}:${item.id}`;
    hide(layer, (key) => key === path || key.startsWith(`${path}/`) || (withWorktree && key.startsWith(`/worktrees/${worktree?.id}/`)), [[typenames[kind], item.id], ...(withWorktree && worktree ? [['Worktree', worktree.id] as [string, string]] : [])]);
    await finish(layer, async () => {
      await client.mutate({ mutation: kind === 'session' ? DELETE_SESSION : DELETE_TERMINAL, variables: { id: item.id }, update: (cache) => evict(cache, typenames[kind], item.id) });
      if (withWorktree && worktree) await archiveWorktreeIfStillEmpty(kind, item, worktree);
    });
  };

  const worktreePaths = (worktree: DeletableWorktree) => {
    const cached = client.readQuery<WorktreeContents>({ query: WORKTREE_CONTENTS, variables: { id: worktree.id } })?.worktree;
    return new Set([...(cached?.sessions ?? []).map((s) => `/sessions/${s.id}`), ...(cached?.terminals ?? []).map((t) => `/terminals/${t.id}`)]);
  };

  const archiveWorktree = async (worktree: DeletableWorktree) => {
    const ok = await confirm({
      title: 'Archiver le worktree',
      message: `Archiver le worktree « ${worktree.label} » ? Ses sessions sont archivées (arrêtées si elles tournent), ses terminaux fermés ; son dossier et sa branche sont conservés. Restaurez-le avec ses sessions depuis l'historique du projet.`,
      confirmLabel: 'Archiver',
    });
    if (!ok) return;
    const paths = worktreePaths(worktree);
    const layer = `archive:worktree:${worktree.id}`;
    hide(layer, (key) => key.startsWith(`/worktrees/${worktree.id}/`) || paths.has(key) || [...paths].some((p) => key.startsWith(`${p}/`)), [['Worktree', worktree.id]]);
    await finish(layer, async () => {
      await client.mutate({ mutation: ARCHIVE_WORKTREE, variables: { id: worktree.id }, update: (cache) => evict(cache, 'Worktree', worktree.id) });
    });
  };

  const removeWorktree = async (worktree: DeletableWorktree) => {
    const res = await confirm({
      title: 'Supprimer le worktree',
      message: `Supprimer le worktree « ${worktree.label} » ? Ses sessions actives (arrêtées), ses terminaux et son dossier seront supprimés ; les fichiers non validés seront perdus. Préférez l'archivage pour garder une trace.`,
      confirmLabel: 'Supprimer',
      danger: true,
      checkbox: { label: 'Supprimer aussi la branche locale' },
    });
    if (!res) return;
    const paths = worktreePaths(worktree);
    const layer = `delete:worktree:${worktree.id}`;
    hide(layer, (key) => key.startsWith(`/worktrees/${worktree.id}/`) || paths.has(key) || [...paths].some((p) => key.startsWith(`${p}/`)), [['Worktree', worktree.id]]);
    await finish(layer, async () => {
      await client.mutate({ mutation: DELETE_WORKTREE, variables: { id: worktree.id, deleteBranch: res.checked }, update: (cache) => evict(cache, 'Worktree', worktree.id) });
    });
  };

  return {
    archiveSession,
    deleteSession: (session: DeletableItem) => removeItem('session', session),
    deleteTerminal: (terminal: DeletableItem) => removeItem('terminal', terminal),
    archiveWorktree,
    deleteWorktree: removeWorktree,
  };
}
