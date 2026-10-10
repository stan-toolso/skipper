/**
 * Registre des raccourcis clavier : une seule déclaration par raccourci, un seul écouteur `keydown`, et une
 * aide générée depuis le registre. Les combinaisons s'écrivent « modificateurs+touche » : `mod+k` (⌘ sur Mac,
 * Ctrl ailleurs — les deux sont acceptés), `shift+Tab`, `Escape`, `?`, `digit` (1 à 9), `code:KeyW` (touche
 * physique, pour les combinaisons Alt dont le caractère dépend de la disposition du clavier).
 */

export type ShortcutScope = 'global' | 'page' | 'context';
export type ShortcutFocus = 'any' | 'outside-editable' | 'unless-typing';

export interface ShortcutDef {
  id: string;
  /** Combinaisons acceptées ; la première est affichée. */
  keys: readonly string[];
  label: string;
  scope: ShortcutScope;
  /** Regroupement dans l'aide. */
  area?: string;
  focus?: ShortcutFocus;
  /** Défaut : true. */
  preventDefault?: boolean;
  /** Ignorer Maj. */
  anyShift?: boolean;
}

/** Renvoie false pour laisser la main au raccourci suivant. */
export type ShortcutHandler = (event: KeyboardEvent) => boolean | void;

interface Registration {
  def: ShortcutDef;
  handler: ShortcutHandler;
  order: number;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

interface Combo {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string | null;
  code: string | null;
  digit: boolean;
  codeDigit: boolean;
}

function parseCombo(combo: string): Combo {
  const parts = combo.split('+').filter(Boolean);
  // « mod++ » : la touche +.
  if (combo.endsWith('++')) parts.push('+');
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const code = key.startsWith('code:') ? key.slice(5) : null;
  return { mod: mods.has('mod'), alt: mods.has('alt'), shift: mods.has('shift'), key: code ? null : key, code: code === 'digit' ? null : code, digit: key === 'digit', codeDigit: code === 'digit' };
}

function comboMatches(c: Combo, e: KeyboardEvent, anyShift: boolean): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const otherMod = isMac ? e.ctrlKey : e.metaKey;
  if (c.mod !== (mod || otherMod)) return false;
  if (c.alt !== e.altKey) return false;
  if (!anyShift && c.shift !== e.shiftKey) return false;
  if (c.digit) return /^[1-9]$/.test(e.key);
  if (c.codeDigit) return /^Digit[1-9]$/.test(e.code);
  if (c.code) return e.code === c.code;
  if (!c.key) return false;
  return c.key.length === 1 ? e.key.toLowerCase() === c.key.toLowerCase() : e.key === c.key;
}

const isEditable = (el: Element | null): boolean => {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
};

const focusOk = (focus: ShortcutFocus, el: Element | null): boolean => {
  if (focus === 'any') return true;
  if (focus === 'outside-editable') return !isEditable(el);
  // unless-typing : pas dans un input ; un textarea vide garde le raccourci (choisir une option au clavier).
  if (!el) return true;
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable) return false;
  if (el.tagName === 'TEXTAREA') return !(el as HTMLTextAreaElement).value;
  return true;
};

/** Alt tape un symbole ASCII dans un champ (Option+5 = { sur Mac FR) : c'est de la saisie, pas un raccourci. */
const typesSymbol = (e: KeyboardEvent): boolean => e.altKey && !e.metaKey && !e.ctrlKey && isEditable(document.activeElement) && e.key.length === 1 && /[^a-zA-Z0-9]/.test(e.key) && e.key.charCodeAt(0) < 128;

const SCOPE_RANK: Record<ShortcutScope, number> = { context: 0, page: 1, global: 2 };

class ShortcutRegistry {
  private readonly registrations = new Set<Registration>();
  private counter = 0;
  private listening = false;

  register(def: ShortcutDef, handler: ShortcutHandler): () => void {
    if (import.meta.env.DEV && [...this.registrations].some((r) => r.def.id === def.id)) console.warn(`[raccourcis] ${def.id} enregistré deux fois`);
    const reg: Registration = { def, handler, order: ++this.counter };
    this.registrations.add(reg);
    this.listen();
    return () => this.registrations.delete(reg);
  }

  /** Raccourcis enregistrés, pour l'aide. */
  list(): ShortcutDef[] {
    return [...this.registrations].map((r) => r.def);
  }

  private listen(): void {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    window.addEventListener('keydown', (e) => this.dispatch(e));
  }

  private dispatch(e: KeyboardEvent): void {
    if (e.defaultPrevented && e.key !== 'Escape') return;
    if (typesSymbol(e)) return;
    const el = document.activeElement;
    const candidates = [...this.registrations]
      .filter((r) => r.def.keys.some((k) => comboMatches(parseCombo(k), e, Boolean(r.def.anyShift))) && focusOk(r.def.focus ?? 'any', el))
      .sort((a, b) => SCOPE_RANK[a.def.scope] - SCOPE_RANK[b.def.scope] || b.order - a.order);
    for (const r of candidates) {
      if (r.handler(e) === false) continue;
      if (r.def.preventDefault !== false) e.preventDefault();
      return;
    }
  }
}

export const shortcuts = new ShortcutRegistry();

/** Touches affichées d'une combinaison : ['⌘', 'K'] ou ['Ctrl', 'K']. */
export function displayCombo(combo: string): string[] {
  const parts = combo.split('+').filter(Boolean);
  if (combo.endsWith('++')) parts.push('+');
  return parts.map((p) => {
    switch (p.toLowerCase()) {
      case 'mod':
        return isMac ? '⌘' : 'Ctrl';
      case 'alt':
        return isMac ? '⌥' : 'Alt';
      case 'shift':
        return isMac ? '⇧' : 'Maj';
      case 'escape':
        return 'Échap';
      case 'digit':
      case 'code:digit':
        return '1–9';
      case 'arrowup':
        return '↑';
      case 'arrowdown':
        return '↓';
      case 'arrowleft':
        return '←';
      case 'arrowright':
        return '→';
      case 'enter':
        return 'Entrée';
      default:
        if (p.startsWith('code:')) {
          const code = p.slice(5);
          if (code === 'BracketLeft') return '[';
          if (code === 'BracketRight') return ']';
          if (code === 'IntlBackslash' || code === 'Comma') return '<';
          return code.replace(/^Key/, '').replace(/^Digit/, '');
        }
        return p.length === 1 ? p.toUpperCase() : p;
    }
  });
}

export const displayComboText = (combo: string) => displayCombo(combo).join(isMac ? '' : '+');
