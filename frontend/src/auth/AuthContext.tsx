import { useQuery } from '@apollo/client';
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { logoutRequest } from '../apollo';
import { ME, type User } from '../graphql/operations';

interface AuthState {
  user: User | null;
  loading: boolean;
  error: Error | undefined;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Utilisateur connecté (requête `me`) et déconnexion. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, loading, error, refetch } = useQuery<{ me: User | null }>(ME, { fetchPolicy: 'network-only' });
  // Rechargement complet : vide toutes les données en mémoire et affiche l'écran de connexion.
  const logout = useCallback(async () => {
    await logoutRequest();
    window.location.assign('/');
  }, []);
  return <AuthContext.Provider value={{ user: data?.me ?? null, loading, error, logout, refresh: refetch }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé sous AuthProvider');
  return ctx;
}
