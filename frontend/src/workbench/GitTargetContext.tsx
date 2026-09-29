import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/** Workspace suivi par le panneau git : projet (checkout principal) ou worktree. */
export interface GitTarget {
  projectId: string;
  worktreeId: string | null;
  label: string;
}

interface State {
  target: GitTarget | null;
  setTarget: (t: GitTarget | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const Ctx = createContext<State | null>(null);
const OPEN_KEY = 'skipper.workbench.gitPanel';

export function GitTargetProvider({ children }: { children: ReactNode }) {
  const [target, setTargetState] = useState<GitTarget | null>(null);
  const [open, setOpenState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const location = useLocation();
  // Une page qui ne déclare pas de cible la retire à la navigation.
  useEffect(() => setTargetState(null), [location.pathname]);
  const setTarget = useCallback((t: GitTarget | null) => {
    setTargetState((prev) => (prev && t && prev.projectId === t.projectId && prev.worktreeId === t.worktreeId && prev.label === t.label ? prev : t));
  }, []);
  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(() => ({ target, setTarget, open, setOpen }), [target, setTarget, open, setOpen]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGitPanel(): State {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGitPanel doit être utilisé dans un GitTargetProvider');
  return ctx;
}

/** Déclare, depuis une page, le workspace que le panneau git doit suivre. */
export function useGitTarget(target: GitTarget | null | undefined): void {
  const { setTarget } = useGitPanel();
  const key = target ? `${target.projectId}|${target.worktreeId ?? ''}|${target.label}` : '';
  useEffect(() => {
    if (target) setTarget(target);
  }, [key, setTarget]); // eslint-disable-line react-hooks/exhaustive-deps
}
