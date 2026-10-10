import { useEffect, useState } from 'react';
import { onUpdateAvailable, reloadForUpdate } from '../lib/pwa';

/** Bandeaux au-dessus des onglets : hors ligne, nouvelle version disponible. */
export default function StatusBanners() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [update, setUpdate] = useState(false);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  useEffect(() => onUpdateAvailable(() => setUpdate(true)), []);
  if (online && !update) return null;
  return (
    <div className="wb-banners">
      {!online && (
        <div className="wb-banner offline">
          <i className="bi bi-wifi-off me-2" />
          Vous êtes hors ligne. Les données peuvent être périmées ; elles se rafraîchiront au retour de la connexion.
        </div>
      )}
      {update && (
        <div className="wb-banner update">
          <i className="bi bi-arrow-repeat me-2" />
          Une nouvelle version de Skipper est disponible.
          <button type="button" className="wb-banner-btn" onClick={() => void reloadForUpdate()}>
            Recharger
          </button>
          <span className="wb-banner-hint">Les modifications non enregistrées seront perdues.</span>
        </div>
      )}
    </div>
  );
}
