import { AppError } from '../errors.js';
import { runner } from '../runners/index.js';
import { CdpClient } from './cdp.js';
import { liveBrowserService } from './live.js';

/**
 * Saisie d'une valeur du coffre dans le navigateur headless d'une session : le serveur repère le champ
 * qui a le focus (origine de la page, libellé et type du champ), vérifie la politique de l'élément, puis
 * tape la valeur par CDP (`Input.insertText`) dans cette même page. Rien n'est écrit sur disque ni
 * transmis à l'agent.
 */

export interface FocusedField {
  targetId: string;
  /** Adresse de la page sans requête ni ancre. */
  url: string;
  origin: string;
  /** Libellé du champ (aria-label, name, id, placeholder ou balise). */
  field: string;
  /** Type du champ : password, text, email, textarea, contenteditable... */
  type: string;
}

/** Script évalué dans chaque page : décrit l'élément actif s'il est saisissable. */
const PROBE = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const tag = el.tagName.toLowerCase();
  const editable = tag === 'input' || tag === 'textarea' || el.isContentEditable;
  if (!editable) return null;
  const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag === 'textarea' ? 'textarea' : 'contenteditable';
  if (tag === 'input' && ['checkbox', 'radio', 'submit', 'button', 'file', 'hidden', 'image', 'reset', 'range', 'color'].includes(type)) return null;
  const field = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || el.getAttribute('placeholder') || tag;
  return { field, type, hasFocus: document.hasFocus(), url: location.origin + location.pathname, origin: location.origin };
})()`;

interface Probe {
  field: string;
  type: string;
  hasFocus: boolean;
  url: string;
  origin: string;
}

async function withCdp<T>(sessionId: string, fn: (cdp: CdpClient) => Promise<T>): Promise<T> {
  const browser = liveBrowserService.browserOf(sessionId);
  if (!browser) throw new AppError("Aucun navigateur ouvert pour cette session : l'option « navigateur headless » du projet doit être activée");
  const cdp = await CdpClient.connect(runner.cdpTunnelCommand(browser.project, browser.cdp.port), browser.cdp.browserPath);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

/** Évalue le script de repérage dans un onglet. */
async function probePage(cdp: CdpClient, targetId: string): Promise<Probe | null> {
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  try {
    const res = await cdp.send<{ result: { value?: Probe | null } }>('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId);
    return res.result.value ?? null;
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
}

export const browserFill = {
  /** Champ qui a le focus dans le navigateur de la session (exactement un onglet doit en avoir un). */
  async focus(sessionId: string): Promise<FocusedField> {
    return withCdp(sessionId, async (cdp) => {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
      const candidates: (Probe & { targetId: string })[] = [];
      for (const t of targetInfos.filter((t) => t.type === 'page')) {
        const p = await probePage(cdp, t.targetId).catch(() => null);
        if (p) candidates.push({ ...p, targetId: t.targetId });
      }
      let chosen = candidates;
      if (chosen.length > 1) chosen = candidates.filter((c) => c.hasFocus);
      if (chosen.length === 0) throw new AppError("Aucun champ de saisie n'a le focus dans le navigateur : clique d'abord le champ à remplir (browser_click), puis réessaie");
      if (chosen.length > 1) throw new AppError('Plusieurs onglets ont un champ actif : ferme les onglets inutiles (browser_tabs), puis réessaie');
      const c = chosen[0];
      return { targetId: c.targetId, url: c.url, origin: c.origin, field: c.field, type: c.type };
    });
  },

  /** Tape la valeur dans le champ actif de l'onglet, après avoir vérifié qu'il est toujours celui repéré. */
  async fill(sessionId: string, targetId: string, origin: string, value: string): Promise<void> {
    return withCdp(sessionId, async (cdp) => {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
      if (!targetInfos.some((t) => t.targetId === targetId)) throw new AppError("L'onglet du champ a été fermé : réessaie");
      const probe = await probePage(cdp, targetId);
      if (!probe) throw new AppError("Le champ n'a plus le focus : clique-le à nouveau, puis réessaie");
      if (probe.origin !== origin) throw new AppError(`La page a changé (${probe.origin}) : réessaie`);
      const { sessionId: cdpSession } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      try {
        await cdp.send('Input.insertText', { text: value }, cdpSession);
      } finally {
        await cdp.send('Target.detachFromTarget', { sessionId: cdpSession }).catch(() => undefined);
      }
    });
  },
};
