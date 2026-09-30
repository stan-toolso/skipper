import { WebSocketServer } from 'ws';
import { createAuthContext, requireProject } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { sessionService } from '../sessions/service.js';
import { rejectUpgrade, type UpgradeHandler } from '../websockets.js';
import { liveBrowserService } from './live.js';

/**
 * WebSockets `/browsers/<session>` : vue en direct du navigateur headless d'une session (lecture seule).
 * La connexion est authentifiée par le cookie de session ; il faut être membre du projet de la session.
 */
export function browserUpgradeHandler(): UpgradeHandler {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  return (req, socket, head) => {
    const match = (req.url ?? '').match(/^\/browsers\/([0-9a-f-]{36})(?:\?|$)/);
    if (!match) return false;
    const id = match[1];
    void (async () => {
      const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
      if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
      const session = await sessionService.get(id);
      if (!session) return rejectUpgrade(socket, 404, 'Not Found');
      await requireProject(createAuthContext(user), session.projectId, 'member');
      wss.handleUpgrade(req, socket, head, (ws) => liveBrowserService.attach(id, ws));
    })().catch((err) => {
      console.warn(`[browser] connexion refusée sur ${id} : ${(err as Error).message}`);
      rejectUpgrade(socket, 403, 'Forbidden');
    });
    return true;
  };
}
