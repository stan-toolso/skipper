import { useApolloClient, type ApolloCache } from '@apollo/client';
import { flushSync } from 'react-dom';
import { useDialogs } from '../components/Dialogs';
import { DELETE_SESSION, DELETE_TERMINAL, DELETE_WORKTREE, WORKTREE_CONTENTS } from '../graphql/operations';
import { useTabs } from './TabsContext';

interface WorktreeContents {
  worktree: { id: string; branch: string; sessions: { id: string }[]; terminals: { id: string }[] } | null;
}

export interface DeletableItem {
  id: string;
  name: string;
  worktreeId?: string | null;
}

export interface DeletableWorktree {
  id: string;
  branch: string;
}

const typenames = { session: 'Session', terminal: 'Terminal' } as const;

function evict(cache: ApolloCache<unknown>, __typename: string, id: string): void {
  cache.evict({ id: cache.identify({ __typename, id }) });
}

/**
 * Suppressions de sessions, terminaux et worktrees, affichées tout de suite : après confirmation, l'onglet
 * se ferme et l'élément disparaît des listes (couche optimiste du cache Apollo) pendant que le serveur
 * travaille (arrêt de l'agent, `git worktree remove`...). En cas d'erreur, la couche est retirée et
 * l'élément réapparaît.
 *
 * Quand on supprime le dernier élément d'un worktree, la confirmation propose de supprimer aussi le
 * worktree, qui serait sinon laissé vide.
 */
export function useDeletions() {
  const client = useApolloClient();
  const { confirm, alert, showError } = useDialogs();
  const { closeMatching } = useTabs();

  /** Ferme les onglets concernés (rendu immédiat, pour qu'aucune page ouverte ne relise un objet retiré), puis masque les objets. */
  const hide = (layer: string, tabs: (key: string) => boolean, objects: [string, string][]) => {
    flushSync(() => closeMatching(tabs));
    client.cache.recordOptimisticTransaction((cache) => {
      for (const [typename, id] of objects) evict(cache, typename, id);
    }, layer);
  };

  /** Le worktree ne contiendra plus rien une fois l'élément retiré ? (lu dans le cache de la sidebar si possible) */
  const lastInWorktree = async (kind: 'session' | 'terminal', item: DeletableItem, fetchPolicy: 'cache-first' | 'network-only'): Promise<DeletableWorktree | null> => {
    if (!item.worktreeId) return null;
    try {
      const { data } = await client.query<WorktreeContents>({ query: WORKTREE_CONTENTS, variables: { id: item.worktreeId }, fetchPolicy });
      const w = data.worktree;
      if (!w) return null;
      const others = [...w.sessions.filter((s) => kind !== 'session' || s.id !== item.id), ...w.terminals.filter((t) => kind !== 'terminal' || t.id !== item.id)];
      return others.length === 0 ? { id: w.id, branch: w.branch } : null;
    } catch {
      return null;
    }
  };

  const removeItem = async (kind: 'session' | 'terminal', item: DeletableItem) => {
    const path = `/${kind}s/${item.id}`;
    const worktree = await lastInWorktree(kind, item, 'cache-first');
    const opts = {
      title: kind === 'session' ? 'Supprimer la session' : 'Supprimer le terminal',
      message: kind === 'session' ? `Supprimer la session « ${item.name} » et tout son historique ?` : `Supprimer le terminal « ${item.name} » ? Le shell sera fermé s'il est encore ouvert.`,
      confirmLabel: 'Supprimer',
      danger: true,
    };
    let withWorktree = false;
    if (worktree) {
      const res = await confirm({
        ...opts,
        checkbox: { label: `Supprimer aussi le worktree « ${worktree.branch} », qui sera vide (dossier supprimé, fichiers non validés perdus ; la branche est conservée)` },
      });
      if (!res) return;
      withWorktree = res.checked;
    } else if (!(await confirm(opts))) return;

    const layer = `delete:${kind}:${item.id}`;
    hide(
      layer,
      (key) => key === path || key.startsWith(`${path}/`) || (withWorktree && key.startsWith(`/worktrees/${worktree?.id}/`)),
      [[typenames[kind], item.id], ...(withWorktree && worktree ? [['Worktree', worktree.id] as [string, string]] : [])],
    );
    try {
      await client.mutate({ mutation: kind === 'session' ? DELETE_SESSION : DELETE_TERMINAL, variables: { id: item.id }, update: (cache) => evict(cache, typenames[kind], item.id) });
      if (withWorktree && worktree) {
        // Vérifié à nouveau auprès du serveur : un agent a pu y ouvrir une session pendant la confirmation.
        if (await lastInWorktree(kind, item, 'network-only')) {
          await client.mutate({ mutation: DELETE_WORKTREE, variables: { id: worktree.id, deleteBranch: false }, update: (cache) => evict(cache, 'Worktree', worktree.id) });
        } else {
          void alert({ title: 'Worktree conservé', message: `Le worktree « ${worktree.branch} » n'a pas été supprimé : une session ou un terminal y a été ouvert entre-temps.` });
        }
      }
    } catch (err) {
      void showError(err);
    } finally {
      client.cache.removeOptimistic(layer);
      client.cache.gc();
    }
  };

  const removeWorktree = async (worktree: DeletableWorktree) => {
    const res = await confirm({
      title: 'Supprimer le worktree',
      message: `Supprimer le worktree « ${worktree.branch} » ? Ses sessions (arrêtées), ses terminaux et son dossier seront supprimés ; les fichiers non validés seront perdus.`,
      confirmLabel: 'Supprimer',
      danger: true,
      checkbox: { label: 'Supprimer aussi la branche locale' },
    });
    if (!res) return;
    // Les sessions et terminaux du worktree disparaissent avec lui : leurs onglets aussi.
    const cached = client.readQuery<WorktreeContents>({ query: WORKTREE_CONTENTS, variables: { id: worktree.id } })?.worktree;
    const paths = new Set([...(cached?.sessions ?? []).map((s) => `/sessions/${s.id}`), ...(cached?.terminals ?? []).map((t) => `/terminals/${t.id}`)]);
    const layer = `delete:worktree:${worktree.id}`;
    hide(layer, (key) => key.startsWith(`/worktrees/${worktree.id}/`) || paths.has(key) || [...paths].some((p) => key.startsWith(`${p}/`)), [['Worktree', worktree.id]]);
    try {
      await client.mutate({ mutation: DELETE_WORKTREE, variables: { id: worktree.id, deleteBranch: res.checked }, update: (cache) => evict(cache, 'Worktree', worktree.id) });
    } catch (err) {
      void showError(err);
    } finally {
      client.cache.removeOptimistic(layer);
      client.cache.gc();
    }
  };

  return {
    deleteSession: (session: DeletableItem) => removeItem('session', session),
    deleteTerminal: (terminal: DeletableItem) => removeItem('terminal', terminal),
    deleteWorktree: removeWorktree,
  };
}
