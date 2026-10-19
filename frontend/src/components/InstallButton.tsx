import { useEffect, useState } from 'react';
import { isIos, isStandalone } from '../lib/device';
import { canPromptInstall, onInstallChange, promptInstall } from '../lib/pwa';
import { useDialogs } from './Dialogs';

/**
 * « Installer l'application » : sur Android/Chrome déclenche la fenêtre d'installation ; sur
 * iPhone/iPad (pas de fenêtre possible) explique le geste dans une boîte de dialogue. `available`
 * est faux si l'application est déjà installée ou si le navigateur ne permet rien.
 */
export function useInstallApp(): { available: boolean; install: () => void } {
  const { alert } = useDialogs();
  const [promptable, setPromptable] = useState(canPromptInstall());
  useEffect(() => onInstallChange(() => setPromptable(canPromptInstall())), []);
  const ios = isIos();
  const available = !isStandalone() && (promptable || ios);
  const install = () => {
    if (promptable) void promptInstall();
    else
      void alert({
        title: "Installer l'application",
        message: (
          <>
            Dans Safari : bouton <i className="bi bi-box-arrow-up" /> Partager, puis « Sur l'écran d'accueil ».
          </>
        ),
      });
  };
  return { available, install };
}
