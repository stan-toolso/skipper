import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/** Workspace suivi par le panneau de droite : projet (checkout principal) ou worksession, et tâche éventuelle. */
export interface GitTarget {
  projectId: string;
  worksessionId: string | null;
  label?: string;
  /** Tâche affichée dans l'onglet « Tâche » du panneau (page d'une session en charge d'une tâche). */
  taskId?: string | null;
}

interface State {
  target: GitTarget | null;
  setTarget: (t: GitTarget | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const Ctx = createContext<State | null>(null);
const OPEN_KEY = 'skipper.workbench.gitPanel';
const isMobile = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767.98px)').matches;

const sameTarget = (a: GitTarget | null, b: GitTarget | null) => (a === b) || (Boolean(a && b) && a!.projectId === b!.projectId && a!.worksessionId === b!.worksessionId && a!.label === b!.label && (a!.taskId ?? null) === (b!.taskId ?? null));

export function GitTargetProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  // La déclaration d'une page est liée au chemin où elle a été faite : naviguer vers une page qui ne déclare rien
  // la fait tomber, sans la vider par un effet (une page dont les données sont déjà en cache déclare dans le même
  // rendu que la navigation et serait écrasée).
  const [declared, setDeclared] = useState<{ path: string; target: GitTarget } | null>(null);
  // Sur mobile le panneau recouvre le contenu : il s'ouvre à la demande et se referme à chaque navigation.
  const [open, setOpenState] = useState<boolean>(() => {
    if (isMobile()) return false;
    try {
      return localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (isMobile()) setOpenState(false);
  }, [location.pathname]);
  const setTarget = useCallback(
    (t: GitTarget | null) => {
      const path = location.pathname;
      setDeclared((prev) => (t ? (prev && prev.path === path && sameTarget(prev.target, t) ? prev : { path, target: t }) : prev && prev.path === path ? null : prev));
    },
    [location.pathname],
  );
  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    if (isMobile()) return;
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);
  const target = useMemo<GitTarget | null>(() => {
    if (declared && declared.path === location.pathname) return declared.target;
    // Sans déclaration : les pages d'un projet suivent son checkout principal.
    const m = location.pathname.match(/^\/projects\/([^/]+)(?:\/(?!new$)[^/]+)?$/);
    if (m && m[1] !== 'new' && !location.pathname.endsWith('/edit')) return { projectId: m[1], worksessionId: null };
    return null;
  }, [declared, location.pathname]);
  const value = useMemo(() => ({ target, setTarget, open, setOpen }), [target, setTarget, open, setOpen]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGitPanel(): State {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGitPanel doit être utilisé dans un GitTargetProvider');
  return ctx;
}

/** Déclare, depuis une page, le workspace (et la tâche) que le panneau de droite doit suivre. */
export function useGitTarget(target: GitTarget | null | undefined): void {
  const { setTarget } = useGitPanel();
  const key = target ? `${target.projectId}|${target.worksessionId ?? ''}|${target.label ?? ''}|${target.taskId ?? ''}` : '';
  useEffect(() => {
    if (target) setTarget(target);
  }, [key, setTarget]); // eslint-disable-line react-hooks/exhaustive-deps
}
