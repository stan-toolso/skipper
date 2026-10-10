import { useSyncExternalStore } from 'react';

/**
 * Thème clair / sombre / système, mémorisé dans ce navigateur seulement (`skipper.theme` : 'light' ou 'dark' ;
 * absent = système). Appliqué par l'attribut `data-bs-theme` de <html> (modes de couleur Bootstrap 5.3) ; un
 * script en tête de index.html l'applique avant le premier rendu pour éviter un flash.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'skipper.theme';
const listeners = new Set<() => void>();
const META_COLORS: Record<Theme, string> = { dark: '#0f0f0f', light: '#eceef1' };

export function themePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(pref: ThemePreference = themePreference()): Theme {
  if (pref !== 'system') return pref;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

let current: Theme = typeof document === 'undefined' ? 'dark' : resolveTheme();

export function applyTheme(): void {
  current = resolveTheme();
  document.documentElement.setAttribute('data-bs-theme', current);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLORS[current]);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', current);
  listeners.forEach((l) => l());
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* stockage indisponible : le choix vaut jusqu'au rechargement */
  }
  applyTheme();
}

if (typeof window !== 'undefined') {
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (themePreference() === 'system') applyTheme();
    });
  } catch {
    /* matchMedia indisponible */
  }
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) applyTheme();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Thème résolu (clair ou sombre), mis à jour en direct. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => current, () => 'dark');
}

export function useThemePreference(): [ThemePreference, (pref: ThemePreference) => void] {
  const pref = useSyncExternalStore(subscribe, themePreference, () => 'system' as ThemePreference);
  return [pref, setThemePreference];
}
