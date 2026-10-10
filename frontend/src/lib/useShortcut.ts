import { useEffect, useRef } from 'react';
import { shortcuts, type ShortcutDef, type ShortcutHandler } from './shortcuts';

/** Enregistre un raccourci pendant le montage du composant (le gestionnaire peut changer à chaque rendu). */
export function useShortcut(def: ShortcutDef, handler: ShortcutHandler, enabled = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = `${def.id}|${def.keys.join(',')}|${def.scope}|${def.focus ?? ''}|${def.anyShift ? 1 : 0}|${def.preventDefault === false ? 0 : 1}`;
  useEffect(() => {
    if (!enabled) return;
    return shortcuts.register(def, (e) => handlerRef.current(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
}
