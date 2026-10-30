import { useEffect } from 'react';
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
 * navigateur émet aussi après le défilement automatique qui précède un clic sur un bouton à moitié visible).
 */
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
  const style = at ? { position: 'fixed' as const, top: at.top, left: at.left, right: at.right } : undefined;
  return (
    <div className={`wb-pop${up ? ' up' : ''}`} style={style} onClick={(e) => e.stopPropagation()}>
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
