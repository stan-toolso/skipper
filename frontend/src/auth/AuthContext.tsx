import { useQuery } from '@apollo/client';
import { createContext, Fragment, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { logoutRequest, readCachedUser, writeCachedUser } from '../apollo';
import { COST_DISPLAY, type CostDisplay } from '../graphql/billing';
import { ME, type User } from '../graphql/operations';
import { getCostUnit, setCostUnit, type CostUnit } from '../lib/humanize';

interface AuthState {
  user: User | null;
  loading: boolean;
  error: Error | undefined;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
  /** Unité des coûts renvoyés par l'API (USD, ou crédits quand la facturation de la cellule est configurée). */
  costUnit: CostUnit;
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
  // Unité des coûts : lue une fois connecté ; formatCost la consulte, d'où l'état qui fait re-rendre l'interface.
  const [costUnit, setUnit] = useState<CostUnit>(getCostUnit);
  const { data: cost } = useQuery<{ costDisplay: CostDisplay }>(COST_DISPLAY, { skip: !user });
  useEffect(() => {
    if (!cost) return;
    setCostUnit(cost.costDisplay.unit);
    setUnit(cost.costDisplay.unit);
  }, [cost]);
  // Rechargement complet : vide toutes les données en mémoire et affiche l'écran de connexion.
  const logout = useCallback(async () => {
    await logoutRequest();
    window.location.assign('/');
  }, []);
  return (
    <AuthContext.Provider value={{ user, loading, error, logout, refresh: refetch, costUnit }}>
      {/* Unité changée (première visite, facturation configurée entre-temps) : tout est réaffiché dans la nouvelle unité. */}
      <Fragment key={costUnit}>{children}</Fragment>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé sous AuthProvider');
  return ctx;
}
