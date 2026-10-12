// Audit des vues en largeur mobile : capture chaque page et quelques scénarios (tiroirs, panneaux, modales),
// et signale les éléments qui dépassent du bord droit de l'écran (hors zones qui défilent volontairement).
//
//   node scripts/mobile-audit/mock-server.mjs &         # voir l'en-tête de mock-server.mjs
//   node scripts/mobile-audit/audit.mjs [filtre…]      # OUT=/tmp/skipper-mobile-shots, DEVICE="Pixel 7"
//
// Playwright n'est pas une dépendance du projet : le script le prend dans PLAYWRIGHT_PKG (dossier d'un paquet
// qui l'embarque, par défaut l'installation globale de @playwright/mcp) et le Chromium de PLAYWRIGHT_BROWSERS_PATH.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const PKG = process.env.PLAYWRIGHT_PKG || '/usr/local/lib/node_modules/@playwright/mcp';
const { chromium, devices } = createRequire(path.join(PKG, 'package.json'))('playwright');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/ms-playwright';
const BASE = process.env.BASE || 'http://127.0.0.1:4555';
const OUT = process.env.OUT || '/tmp/skipper-mobile-shots';
const only = process.argv.slice(2);

const ROUTES = [
  '/', '/projects', '/projects/new', '/projects/p1', '/projects/p1/edit', '/projects/p1/context', '/projects/p1/context?instruction=i1',
  '/projects/p1/tasks', '/projects/p1/vault', '/projects/p1/history', '/tasks', '/tasks/t1', '/vault', '/agents', '/agents/a1',
  '/workflows', '/workflows/w1', '/workflows/w1/runs/r1', '/shared', '/shared/s1', '/sessions', '/sessions/s1', '/sessions/s1/browser',
  '/requests', '/terminals/t1', '/settings', '/users', '/projects/p1/files', '/projects/p1/files/previsionnel/Previsionnel_2026-2027.html',
  '/projects/p1/files/src/index.ts', '/worktrees/w1/files',
];
/** Scénarios : nom → actions après le chargement de la route. */
const SCENARIOS = [
  ['sidebar', '/', async (p) => p.click('.wb-burger')],
  ['notifications', '/', async (p) => p.click('button[title="Notifications"]')],
  ['tabs-menu', '/projects/p1', async (p) => p.click('.wb-tabs-menu-anchor button')],
  ['git-panel', '/projects/p1', async (p) => p.click('.wb-git-btn')],
  ['git-panel-task', '/sessions/s1', async (p) => p.click('.wb-git-btn')],
  ['session-launcher', '/', async (p) => p.locator('.wb-content button', { hasText: 'Session' }).first().click()],
  ['dashboard-lists', '/', async (p) => p.locator('.dash-list').first().scrollIntoViewIfNeeded()],
  ['sessions-all', '/sessions', async (p) => p.locator('button', { hasText: 'Toutes' }).first().click()],
  ['session-settings', '/sessions/s1', async (p) => p.click('text=Réglages')],
  ['session-schedule', '/sessions/s1', async (p) => p.click('text=Planification')],
  ['task-modal', '/tasks', async (p) => p.click('text=Nouvelle tâche')],
  ['tasks-table', '/tasks', async (p) => p.locator('button[title="Liste"]').click()],
  ['vault-new', '/vault', async (p) => p.click('text=Ajouter un élément')],
  ['vault-expanded', '/vault', async (p) => p.click('.vault-row')],
  ['project-worktrees', '/projects/p1', async (p) => p.locator('text=Nouveau worktree').scrollIntoViewIfNeeded()],
  ['project-members', '/projects/p1', async (p) => p.locator('text=Membres').first().scrollIntoViewIfNeeded()],
  ['file-code', '/projects/p1/files/previsionnel/Previsionnel_2026-2027.html', async (p) => p.locator('button', { hasText: /^Code$/ }).click()],
  ['file-publish', '/projects/p1/files/previsionnel/Previsionnel_2026-2027.html', async (p) => p.locator('button', { hasText: 'Publier' }).first().click()],
  ['workflow-runs', '/workflows/w1', async (p) => p.locator('table').first().scrollIntoViewIfNeeded()],
  ['task-sessions', '/tasks/t1', async (p) => p.locator('table').first().scrollIntoViewIfNeeded()],
  ['settings-github', '/settings', async (p) => p.click('text=GitHub')],
  ['settings-opencode', '/settings', async (p) => p.click('text=OpenCode')],
  ['settings-server', '/settings', async (p) => p.click('text=Serveur')],
  ['search-palette', '/', async (p) => p.keyboard.press('Control+K')],
];

/** Éléments visibles dont le bord droit dépasse l'écran, sauf dans un conteneur prévu pour défiler ou qui rogne. */
const OVERFLOW_JS = () => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const seen = new Set();
  const legit = /wb-tabbar|wb-ws-strip|fx-tabs|sp-filters|table-responsive|cm-scroller|xterm|overflow-auto|wb-notif|dash-project-table/;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let p = el.parentElement;
    let skip = false;
    while (p) {
      const pcs = getComputedStyle(p);
      if ((/(auto|scroll)/.test(pcs.overflowX) && p.scrollWidth > p.clientWidth && legit.test(p.className)) || /(hidden|clip)/.test(pcs.overflowX)) {
        skip = true;
        break;
      }
      p = p.parentElement;
    }
    if (skip) continue;
    const key = `${el.tagName}.${el.className}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!el.closest('[data-ovf]')) el.setAttribute('data-ovf', '1');
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    out.push(`${el.tagName.toLowerCase()}${cls} right=${Math.round(r.right)} (écran ${vw}) « ${(el.textContent || '').trim().slice(0, 40)} »`);
  }
  return out.slice(0, 10);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices[process.env.DEVICE || 'Pixel 7'], deviceScaleFactor: 2, locale: 'fr-FR', colorScheme: process.env.SCHEME || 'light' });
await ctx.addInitScript(() => {
  localStorage.setItem('skipper.me', JSON.stringify({ id: 'u', email: 'moi@exemple.fr', name: 'Moi', isAdmin: true, isSuperAdmin: true }));
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
fs.mkdirSync(OUT, { recursive: true });
const report = [];
let problems = 0;

async function check(name, route, action) {
  if (only.length && !only.some((o) => name.includes(o) || route.includes(o))) return;
  errors.length = 0;
  try {
    // « load » plutôt que « networkidle » : les pages interrogent l'API en boucle.
    await page.goto(BASE + route, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(1200);
    if (action) {
      await action(page);
      await page.waitForTimeout(700);
    }
  } catch (e) {
    problems++;
    report.push(`?? ${name} : ${e.message.split('\n')[0].slice(0, 120)}`);
    return;
  }
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const out = await page.evaluate(OVERFLOW_JS);
  const flagged = page.locator('[data-ovf]');
  for (let i = 0; i < Math.min(await flagged.count(), 3); i++) {
    try {
      await flagged.nth(i).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/${name}__deborde${i}.png` });
    } catch {
      /* élément disparu entre-temps */
    }
  }
  // Erreurs JS attendues avec le serveur factice (iframe d'aperçu sans allow-same-origin) : ignorées.
  const errs = errors.filter((e) => !e.includes('sandboxed'));
  if (out.length || errs.length) problems++;
  report.push(`${out.length ? '!!' : 'ok'} ${name}${errs.length ? ' — erreurs JS : ' + errs.join(' | ') : ''}`);
  for (const o of out) report.push(`     ${o}`);
}

for (const route of ROUTES) await check(route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'accueil', route);
for (const [name, route, action] of SCENARIOS) await check(name, route, action);
await browser.close();
console.log(report.join('\n'));
console.log(`\nCaptures : ${OUT}`);
process.exit(problems ? 1 : 0);
