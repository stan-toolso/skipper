import { useQuery, type DocumentNode, type OperationVariables, type QueryHookOptions, type QueryResult, type TypedDocumentNode } from '@apollo/client';
import { useEffect } from 'react';
import { usePageVisible } from './usePageVisible';

/**
 * `useQuery` dont le sondage s'arrête quand la page est cachée (onglet en arrière-plan, téléphone verrouillé)
 * et repart à chaque affichage : Apollo arrête définitivement le sondage d'une requête quand son dernier
 * abonné disparaît (page cachée dans un onglet du workbench) et ne le reprend pas seul.
 */
export function usePollingQuery<TData = unknown, TVariables extends OperationVariables = OperationVariables>(
  query: DocumentNode | TypedDocumentNode<TData, TVariables>,
  options: QueryHookOptions<TData, TVariables> & { pollInterval: number },
): QueryResult<TData, TVariables> {
  const visible = usePageVisible();
  const interval = visible && !options.skip ? options.pollInterval : 0;
  const result = useQuery<TData, TVariables>(query, { ...options, pollInterval: interval });
  const { startPolling, stopPolling } = result;
  useEffect(() => {
    if (!interval) return;
    startPolling(interval);
    return () => stopPolling();
  }, [interval, startPolling, stopPolling]);
  return result;
}
