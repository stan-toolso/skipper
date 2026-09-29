/** Écran tactile (téléphone, tablette) : pas de souris pour le survol, clavier virtuel. */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: none), (pointer: coarse)').matches;
}

/**
 * Faut-il donner le focus à un champ à l'ouverture d'une page ? Oui au clavier physique, non sur
 * mobile : le focus y ouvre le clavier virtuel et masque la moitié de l'écran à chaque navigation.
 */
export function canAutoFocus(): boolean {
  return !isTouchDevice();
}

/** L'application tourne-t-elle installée sur l'écran d'accueil (mode plein écran) ? */
export function isStandalone(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);
}

export function isIos(): boolean {
  return typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);
}
