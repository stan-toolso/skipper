import { config } from '../config.js';
import type { GoogleProfile } from '../users/types.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export const googleAuth = {
  get configured(): boolean {
    return Boolean(config.googleClientId && config.googleClientSecret);
  },

  get redirectUri(): string {
    return `${config.apiUrl}/auth/google/callback`;
  },

  /** URL de la page de connexion Google (flux « authorization code »). */
  authorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    return `${AUTH_URL}?${params}`;
  },

  /** Échange le code contre un jeton d'accès puis lit le profil de l'utilisateur. */
  async fetchProfile(code: string): Promise<GoogleProfile> {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error(`Échange du code Google refusé (${tokenRes.status}) : ${(await tokenRes.text()).slice(0, 200)}`);
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) throw new Error("Réponse Google sans jeton d'accès");

    const infoRes = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (!infoRes.ok) throw new Error(`Lecture du profil Google impossible (${infoRes.status})`);
    const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
    if (!info.sub || !info.email) throw new Error('Profil Google incomplet');
    return { sub: info.sub, email: info.email, emailVerified: Boolean(info.email_verified), name: info.name ?? null, picture: info.picture ?? null };
  },
};
