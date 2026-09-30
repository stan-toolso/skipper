import { WebSocketServer } from 'ws';
import { createAuthContext, requireProject } from '../auth/access.js';
import { authSession, readCookie, SESSION_COOKIE } from '../auth/session.js';
import { rejectUpgrade, type UpgradeHandler } from '../websockets.js';
import { terminalService } from './service.js';

/**
 * WebSockets `/terminals/<id>`. La connexion est authentifiée par le cookie de session ; il faut être
 * membre du projet du terminal.
 */
export function terminalUpgradeHandler(): UpgradeHandler {
  const wss = new WebSocketServer({ noServer: true });
  return (req, socket, head) => {
    const match = (req.url ?? '').match(/^\/terminals\/([0-9a-f-]{36})(?:\?|$)/);
    if (!match) return false;
    const id = match[1];
    void (async () => {
      const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
      if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
      const terminal = await terminalService.get(id);
      await requireProject(createAuthContext(user), terminal.projectId, 'member');
      wss.handleUpgrade(req, socket, head, (ws) => terminalService.attach(id, ws));
    })().catch((err) => {
      console.warn(`[terminals] connexion refusée sur ${id} : ${(err as Error).message}`);
      rejectUpgrade(socket, 403, 'Forbidden');
    });
    return true;
  };
}
