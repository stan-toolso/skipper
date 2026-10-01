import { useQuery } from '@apollo/client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { logoutRequest, readCachedUser, writeCachedUser } from '../apollo';
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
  // En attendant `me`, l'utilisateur de la dernière visite : l'interface et ses requêtes démarrent sans attendre.
  const [cached] = useState(() => readCachedUser<User>());
  useEffect(() => {
    if (data) writeCachedUser(data.me);
  }, [data]);
  const user = data ? data.me : error ? null : cached;
  // Rechargement complet : vide toutes les données en mémoire et affiche l'écran de connexion.
  const logout = useCallback(async () => {
    await logoutRequest();
    window.location.assign('/');
  }, []);
  return <AuthContext.Provider value={{ user, loading, error, logout, refresh: refetch }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé sous AuthProvider');
  return ctx;
}
