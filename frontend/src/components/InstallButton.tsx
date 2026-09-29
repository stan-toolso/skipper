import { useEffect, useState } from 'react';
import { isIos, isStandalone } from '../lib/device';
import { canPromptInstall, onInstallChange, promptInstall } from '../lib/pwa';

/**
 * « Installer l'application » : sur Android/Chrome déclenche la fenêtre d'installation ; sur
 * iPhone/iPad (pas de fenêtre possible) explique le geste. Rien si l'application est déjà installée.
 */
export default function InstallButton() {
  const [promptable, setPromptable] = useState(canPromptInstall());
  const [showIosHint, setShowIosHint] = useState(false);
  useEffect(() => onInstallChange(() => setPromptable(canPromptInstall())), []);
  if (isStandalone()) return null;
  const ios = isIos();
  if (!promptable && !ios) return null;
  return (
    <>
      <button
        type="button"
        className="wb-menu-item wb-install"
        onClick={() => {
          if (promptable) void promptInstall();
          else setShowIosHint((v) => !v);
        }}
      >
        <i className="bi bi-phone wb-icon" /> Installer l'application
      </button>
      {showIosHint && (
        <div className="wb-install-hint">
          Dans Safari : bouton <i className="bi bi-box-arrow-up" /> Partager, puis « Sur l'écran d'accueil ».
        </div>
      )}
    </>
  );
}
