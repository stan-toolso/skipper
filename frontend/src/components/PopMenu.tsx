import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

export interface MenuItem {
  label: string;
  icon: string;
  to?: string;
  onClick?: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}

/**
 * Petit menu flottant (sidebar, actions d'une ligne de tableau). Par défaut absolu sous son parent `position: relative` ;
 * avec `at`, fixe à l'écran (pour sortir d'une cellule ou d'un conteneur qui rogne). Se ferme au clic ailleurs, à
 * l'échappement et, fixe, quand la personne fait défiler (molette ou doigt : pas l'événement scroll lui-même, que le
 * navigateur émet aussi après le défilement automatique qui précède un clic sur un bouton à moitié visible). Fixe,
 * il est ramené dans la fenêtre s'il en sort (bouton « ⋮ » à gauche d'une carte sur mobile : ancré à droite du
 * bouton, le menu partait hors écran ; bouton en bas : il remonte).
 */
const EDGE = 8;
export default function PopMenu({ items, onClose, up, at }: { items: MenuItem[]; onClose: () => void; up?: boolean; at?: { top: number; left?: number; right?: number } }) {
  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', key);
    if (at) {
      window.addEventListener('wheel', close, { capture: true, passive: true });
      window.addEventListener('touchmove', close, { capture: true, passive: true });
    }
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', key);
      if (at) {
        window.removeEventListener('wheel', close, true);
        window.removeEventListener('touchmove', close, true);
      }
    };
  }, [onClose, at]);
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ top?: number; left?: number; right?: number } | null>(null);
  useLayoutEffect(() => {
    setFit(null);
    if (!at || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const next: { top?: number; left?: number; right?: number } = {};
    if (r.left < EDGE) next.left = EDGE;
    else if (r.right > window.innerWidth - EDGE) next.right = EDGE;
    if (r.bottom > window.innerHeight - EDGE) next.top = Math.max(EDGE, window.innerHeight - EDGE - r.height);
    if (Object.keys(next).length) setFit(next);
  }, [at]);
  const style = at ? { position: 'fixed' as const, top: fit?.top ?? at.top, left: fit?.left ?? (fit?.right != null ? undefined : at.left), right: fit?.right ?? (fit?.left != null ? undefined : at.right) } : undefined;
  return (
    <div ref={ref} className={`wb-pop${up ? ' up' : ''}`} style={style} onClick={(e) => e.stopPropagation()}>
      {items.map((it) => (
        <div key={it.label}>
          {it.separatorBefore && <div className="wb-pop-sep" />}
          {it.to ? (
            <Link to={it.to} className={`wb-pop-item${it.danger ? ' danger' : ''}`} onClick={onClose}>
              <i className={`bi ${it.icon} wb-icon`} /> {it.label}
            </Link>
          ) : (
            <button
              type="button"
              className={`wb-pop-item${it.danger ? ' danger' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                onClose();
                it.onClick?.();
              }}
            >
              <i className={`bi ${it.icon} wb-icon`} /> {it.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
