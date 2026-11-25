import { useContext, useEffect, useMemo, useState } from 'react';
import { getApolloContext, type ApolloClient } from '@apollo/client';
import { RESOLVE_REFS } from '../graphql/misc';
import { candidateRefs, type KnownRefs } from './idRefs';

/**
 * Identifiants courts cités seuls dans un texte Markdown (« **56f64f35** : … »), résolus par le serveur
 * (`resolveRefs`) en tâches ou sessions que la personne peut voir. Les demandes de tous les textes affichés sont
 * groupées en une requête (40 ms), et chaque réponse est gardée pour la page (un identifiant inconnu aussi : on ne le
 * redemande pas). Renvoie null tant que rien n'est reconnu, pour ne pas recalculer le rendu des textes sans référence.
 * Hors d'un fournisseur Apollo (page publique d'une session partagée, tests), rien n'est résolu.
 */

type Ref = { kind: 'task' | 'session'; id: string };
const cache = new Map<string, Ref | null>();
const queued = new Set<string>();
/** Demandés au serveur, réponse pas encore reçue. */
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
const BATCH = 200;

function flush(client: ApolloClient<unknown>) {
  timer = null;
  const prefixes = [...queued];
  queued.clear();
  prefixes.forEach((p) => inflight.add(p));
  for (let i = 0; i < prefixes.length; i += BATCH) {
    const chunk = prefixes.slice(i, i + BATCH);
    client
      .query<{ resolveRefs: { prefix: string; kind: string; id: string }[] }>({ query: RESOLVE_REFS, variables: { prefixes: chunk }, fetchPolicy: 'network-only' })
      .then(({ data }) => {
        for (const p of chunk) cache.set(p, null);
        for (const r of data?.resolveRefs ?? []) if (r.kind === 'task' || r.kind === 'session') cache.set(r.prefix, { kind: r.kind, id: r.id });
      })
      // Erreur (hors ligne, compte invité) : les identifiants restent du texte, sans nouvel essai pour cette page.
      .catch(() => chunk.forEach((p) => cache.set(p, null)))
      .finally(() => {
        chunk.forEach((p) => inflight.delete(p));
        listeners.forEach((l) => l());
      });
  }
}

export function useKnownRefs(text: string): KnownRefs | null {
  const client = useContext(getApolloContext()).client;
  const candidates = useMemo(() => (client ? candidateRefs(text) : []), [client, text]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!client || !candidates.some((c) => !cache.has(c))) return;
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    for (const c of candidates) if (!cache.has(c) && !inflight.has(c)) queued.add(c);
    if (queued.size && !timer) timer = setTimeout(() => flush(client as ApolloClient<unknown>), 40);
    return () => void listeners.delete(listener);
  }, [candidates, client, version]);
  return useMemo(() => {
    const known = new Map<string, Ref>();
    for (const c of candidates) {
      const ref = cache.get(c);
      if (ref) known.set(c, ref);
    }
    return known.size ? known : null;
    // version : relu après chaque réponse du serveur.
  }, [candidates, version]);
}
