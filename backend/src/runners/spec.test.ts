import { describe, expect, it } from 'vitest';
import { containerDrift, countZombies, cpusArgs, splitInspect, updateCpusValue, type ContainerSpec } from './spec.js';

const home = '/home/skipper';
const expected: ContainerSpec = {
  image: 'skipper-runner:latest',
  imageId: 'sha256:new',
  init: true,
  memory: '1g',
  cpus: '1',
  user: '1000:1000',
  home,
  workdir: '/home/skipper/skipper-workspaces/demo',
  restart: 'unless-stopped',
  mounts: ['/home/skipper/skipper-workspaces/.runners/demo/claude-home:/home/skipper/.claude', '/etc/passwd:/etc/passwd:ro', '/home/skipper/skipper-workspaces/demo:/home/skipper/skipper-workspaces/demo'],
  tmpfs: [`${home}:uid=1000,gid=1000,mode=0750,size=512m`],
  hosts: ['host.docker.internal:host-gateway'],
  command: ['sleep', 'infinity'],
};
const image = { id: 'sha256:new', createdAt: new Date('2026-10-10T13:00:41Z') };
const label = (overrides: Partial<ContainerSpec> = {}) => JSON.stringify({ ...expected, ...overrides });

describe('containerDrift', () => {
  it("ne signale rien quand le conteneur porte la configuration attendue et l'image courante", () => {
    expect(containerDrift(expected, { specLabel: label(), init: true, imageId: 'sha256:new' }, image)).toEqual([]);
  });

  it('explique un conteneur créé avant le suivi, sans --init et sur une image reconstruite', () => {
    const reasons = containerDrift(expected, { specLabel: null, init: null, imageId: 'sha256:old' }, image);
    expect(reasons[0]).toMatch(/avant le suivi/);
    expect(reasons).toContainEqual(expect.stringMatching(/--init absente/));
    expect(reasons).toContainEqual(expect.stringMatching(/image reconstruite le 10\/10\/2026/));
  });

  it('ne reproche pas --init ni l’image à un conteneur ancien qui les a déjà', () => {
    expect(containerDrift(expected, { specLabel: null, init: true, imageId: 'sha256:new' }, image)).toEqual(['conteneur créé avant le suivi de sa configuration']);
  });

  it('détecte une image reconstruite depuis la création', () => {
    expect(containerDrift(expected, { specLabel: label({ imageId: 'sha256:old' }), init: true, imageId: 'sha256:old' }, image)).toEqual(['image reconstruite le 10/10/2026 15:00']);
  });

  it("ne juge pas de l'image quand elle n'existe plus localement", () => {
    expect(containerDrift(expected, { specLabel: label({ imageId: 'sha256:old' }), init: true, imageId: 'sha256:old' }, null)).toEqual([]);
  });

  it('décrit chaque paramètre modifié : init, limites, montages, commande', () => {
    const facts = { specLabel: label({ init: false, memory: '768m', cpus: '2', mounts: expected.mounts.slice(1).concat(['/x:/home/skipper/.claude.json:ro']), command: ['sleep', '1d'] }), init: false, imageId: 'sha256:new' };
    expect(containerDrift(expected, facts, image)).toEqual([
      'option --init ajoutée',
      'limite mémoire 768m → 1g',
      'plafond CPU 2 → 1',
      'montage ~/.claude ajouté',
      'montage ~/.claude.json retiré',
      'commande modifié',
    ]);
  });

  it('signale le retrait du plafond CPU (défaut : aucun) ; sans plafond, docker run ne reçoit pas --cpus', () => {
    expect(containerDrift({ ...expected, cpus: '' }, { specLabel: label(), init: true, imageId: 'sha256:new' }, image)).toEqual(['plafond CPU 1 → aucun']);
    expect(containerDrift({ ...expected, cpus: '' }, { specLabel: label({ cpus: '' }), init: true, imageId: 'sha256:new' }, image)).toEqual([]);
    expect(cpusArgs('')).toEqual([]);
    expect(cpusArgs('0.5')).toEqual(['--cpus', '0.5']);
  });

  it("signale un changement d'image par son nom plutôt que par sa reconstruction", () => {
    expect(containerDrift(expected, { specLabel: label({ image: 'skipper-runner:old', imageId: 'sha256:old' }), init: true, imageId: 'sha256:old' }, image)).toEqual(['image skipper-runner:old → skipper-runner:latest']);
  });

  it('signale un paramètre inconnu de part et d’autre, et un label illisible', () => {
    expect(containerDrift({ ...expected, extra: 1 } as unknown as ContainerSpec, { specLabel: label(), init: true, imageId: 'sha256:new' }, image)).toEqual(['paramètre « extra » modifié']);
    expect(containerDrift(expected, { specLabel: '{oops', init: true, imageId: 'sha256:new' }, image)).toEqual(['configuration enregistrée sur le conteneur illisible']);
  });
});

describe('countZombies', () => {
  it('compte les processus en état Z, sans l’en-tête', () => {
    const top = `PID                 STAT                COMMAND
1                   Ss                  docker-init
7                   S                   sleep
812                 Z                   node
813                 Zs                  chrome
900                 R+                  ps
`;
    expect(countZombies(top)).toBe(2);
    expect(countZombies('PID STAT\n')).toBe(0);
    expect(countZombies('')).toBe(0);
  });
});

describe('splitInspect', () => {
  it('sépare les champs et garde les | du dernier (label JSON)', () => {
    expect(splitInspect('running|2026-10-10T15:00:03Z|<nil>|<no value>\n', 4)).toEqual(['running', '2026-10-10T15:00:03Z', null, null]);
    expect(splitInspect('running|true|{"a":"x|y"}', 3)).toEqual(['running', 'true', '{"a":"x|y"}']);
  });
});

describe('updateCpusValue', () => {
  it('garde le plafond demandé', () => {
    expect(updateCpusValue('1.5', 8)).toBe('1.5');
  });
  it('donne tous les cœurs de l\'hôte sans plafond, jamais 0', () => {
    expect(updateCpusValue('', 8)).toBe('8');
    expect(updateCpusValue('', 0)).toBe('1');
  });
});
