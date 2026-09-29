import { Alert, Button } from 'react-bootstrap';
import { useLocation } from 'react-router-dom';
import { googleLoginUrl } from '../apollo';

const errorMessages: Record<string, string> = {
  not_invited: "Cette adresse Google n'a été invitée sur aucun projet. Demandez une invitation à l'administrateur d'un projet.",
  email_not_verified: "L'adresse e-mail de ce compte Google n'est pas vérifiée.",
  account_mismatch: 'Cette adresse est déjà reliée à un autre compte Google.',
  not_configured: "La connexion Google n'est pas configurée sur le serveur (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
  invalid_state: 'La connexion a expiré ou a été altérée. Réessayez.',
  cancelled: 'Connexion annulée.',
  access_denied: 'Connexion refusée par Google.',
  google_error: 'Google a renvoyé une erreur pendant la connexion. Réessayez.',
};

/** Écran de connexion : uniquement via Google. Affiche l'erreur éventuelle renvoyée par le serveur (`?authError=`). */
export default function LoginPage() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const errorCode = params.get('authError');
  params.delete('authError');
  const next = `${location.pathname}${params.toString() ? `?${params}` : ''}`;

  return (
    <div className="d-flex align-items-center justify-content-center" style={{ minHeight: '100vh' }}>
      <div className="text-center" style={{ width: 380 }}>
        <div className="mb-4" style={{ fontSize: 28, fontWeight: 600, color: 'var(--cc-accent)' }}>
          ✻ Skipper
        </div>
        <p className="text-secondary mb-4">Pilotage de sessions d'agents. Connectez-vous avec le compte Google invité sur vos projets.</p>
        {errorCode && (
          <Alert variant="warning" className="text-start py-2 small">
            {errorMessages[errorCode] ?? `Connexion impossible (${errorCode}).`}
          </Alert>
        )}
        <Button href={googleLoginUrl(next === '/' ? '/' : next)} size="lg" className="w-100">
          <i className="bi bi-google me-2" />
          Se connecter avec Google
        </Button>
      </div>
    </div>
  );
}
