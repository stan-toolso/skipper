import { describe, expect, it, vi } from 'vitest';

// Fonctions pures : le runner (Docker) n'est jamais sollicité ici.
vi.mock('../runners/index.js', () => ({ runner: {} }));

const { checkApiCall, checkPolicy, commandEnv, isReadInvocation, parseInvocation, validateAccessKey, validateRegion, validateSecretKey, validateZone } = await import('./scaleway.js');

describe('scaleway : découpage des commandes', () => {
  it('retire « scw », repère le chemin et le verbe malgré les options et les arguments clé=valeur', () => {
    expect(parseInvocation('scw instance server list zone=fr-par-1 -o json')).toMatchObject({ path: ['instance', 'server'], verb: 'list' });
    expect(parseInvocation('-o json rdb instance get 11111111-1111-1111-1111-111111111111 region=fr-par')).toMatchObject({ path: ['rdb', 'instance'], verb: 'get' });
    expect(parseInvocation('mnq sqs credentials list')).toMatchObject({ path: ['mnq', 'sqs', 'credentials'], verb: 'list' });
    expect(parseInvocation('instance server create name=web type=DEV1-S')).toMatchObject({ path: ['instance', 'server'], verb: 'create' });
    expect(parseInvocation('version')).toMatchObject({ path: [], verb: 'version', help: true });
    expect(parseInvocation('secret version access abc')).toMatchObject({ path: ['secret', 'version'], verb: 'access', help: false });
    expect(parseInvocation('instance server delete --help')).toMatchObject({ path: ['instance', 'server'], verb: 'delete', help: true });
    expect(parseInvocation('instance server-type availability')).toMatchObject({ path: ['instance', 'server-type', 'availability'], verb: null });
    expect(() => parseInvocation('  ')).toThrow(/Commande vide/);
  });
});

describe('scaleway : politique', () => {
  const item = { name: 'scw', readOnly: true, commandAllowlist: [] as string[] };

  it('reconnaît les lectures et les chemins sensibles', () => {
    expect(isReadInvocation(parseInvocation('instance server list'))).toBe(true);
    expect(isReadInvocation(parseInvocation('account project list'))).toBe(true);
    expect(isReadInvocation(parseInvocation('k8s cluster get abc'))).toBe(true);
    expect(isReadInvocation(parseInvocation('help'))).toBe(true);
    expect(isReadInvocation(parseInvocation('help instance server'))).toBe(true);
    expect(isReadInvocation(parseInvocation('instance server -h'))).toBe(true);
    expect(isReadInvocation(parseInvocation('instance server help'))).toBe(false);
    expect(isReadInvocation(parseInvocation('instance server start abc'))).toBe(false);
    expect(isReadInvocation(parseInvocation('secret version access abc'))).toBe(false);
    expect(isReadInvocation(parseInvocation('secret version list abc'))).toBe(false);
    expect(isReadInvocation(parseInvocation('iam api-key list'))).toBe(false);
    expect(isReadInvocation(parseInvocation('mnq sqs credentials get abc'))).toBe(false);
    expect(isReadInvocation(parseInvocation('instance server-type availability'))).toBe(false);
  });

  it('refuse les écritures en lecture seule, les accepte sinon', () => {
    expect(() => checkPolicy(parseInvocation('instance server delete abc'), item)).toThrow(/lecture seule/);
    expect(() => checkPolicy(parseInvocation('instance server list'), item)).not.toThrow();
    expect(() => checkPolicy(parseInvocation('instance server delete abc'), { ...item, readOnly: false })).not.toThrow();
  });

  it('refuse toujours les profils locaux, le débogage, la configuration et les connexions interactives', () => {
    const rw = { ...item, readOnly: false };
    expect(() => checkPolicy(parseInvocation('-p admin instance server list'), rw)).toThrow(/-p/);
    expect(() => checkPolicy(parseInvocation('instance server list --debug'), item)).toThrow(/--debug/);
    expect(() => checkPolicy(parseInvocation('init'), rw)).toThrow(/init/);
    expect(() => checkPolicy(parseInvocation('config get access-key'), rw)).toThrow(/config/);
    expect(() => checkPolicy(parseInvocation('info'), item)).toThrow(/info/);
    expect(() => checkPolicy(parseInvocation('object config get type=rclone'), rw)).toThrow(/object config/);
    expect(() => checkPolicy(parseInvocation('k8s kubeconfig get abc'), rw)).toThrow(/kubeconfig/);
    expect(() => checkPolicy(parseInvocation('instance server ssh abc'), rw)).toThrow(/ssh/);
    expect(() => checkPolicy(parseInvocation('registry login'), rw)).toThrow(/registry login/);
  });

  it('applique la liste blanche de préfixes', () => {
    const restricted = { ...item, readOnly: false, commandAllowlist: ['instance server list', 'rdb instance'] };
    expect(() => checkPolicy(parseInvocation('scw instance server list zone=fr-par-1'), restricted)).not.toThrow();
    expect(() => checkPolicy(parseInvocation('rdb instance get abc'), restricted)).not.toThrow();
    expect(() => checkPolicy(parseInvocation('instance server get abc'), restricted)).toThrow(/politique/);
  });

  it("limite l'API en lecture seule : GET, hors chemins qui révèlent un secret ou un accès", () => {
    expect(() => checkApiCall(true, { path: 'instance/v1/zones/fr-par-1/servers' }, 'scw')).not.toThrow();
    expect(() => checkApiCall(true, { path: '/account/v3/projects', query: { organization_id: 'x' } }, 'scw')).not.toThrow();
    expect(() => checkApiCall(true, { path: 'secret-manager/v1beta1/regions/fr-par/secrets/abc/versions/latest/access' }, 'scw')).toThrow(/secret/);
    expect(() => checkApiCall(true, { path: 'k8s/v1/regions/fr-par/clusters/abc/kubeconfig' }, 'scw')).toThrow(/secret ou un accès/);
    expect(() => checkApiCall(true, { path: 'iam/v1alpha1/api-keys' }, 'scw')).toThrow(/secret ou un accès/);
    expect(() => checkApiCall(false, { path: 'iam/v1alpha1/api-keys' }, 'scw')).not.toThrow();
    expect(() => checkApiCall(true, { path: 'https://evil.example/x' }, 'scw')).toThrow(/chemin relatif/);
  });
});

describe('scaleway : réglages et environnement', () => {
  it('valide les clés, la région et la zone', () => {
    expect(validateAccessKey(' SCWABCDEFGHIJKLMNOPQ ')).toBe('SCWABCDEFGHIJKLMNOPQ');
    expect(() => validateAccessKey('AKIAIOSFODNN7EXAMPLE')).toThrow(/SCW/);
    expect(validateSecretKey('11111111-2222-3333-4444-555555555555')).toBe('11111111-2222-3333-4444-555555555555');
    expect(() => validateSecretKey('pas-un-uuid')).toThrow(/UUID/);
    expect(validateRegion(' FR-PAR ')).toBe('fr-par');
    expect(() => validateRegion('paris')).toThrow(/Région/);
    expect(validateZone('fr-par-2', 'fr-par')).toBe('fr-par-2');
    expect(() => validateZone('nl-ams-1', 'fr-par')).toThrow(/région/);
  });

  it('transmet identifiants, portée et préférences au CLI, sans organisation ni projet quand ils manquent', () => {
    const env = commandEnv({ accessKey: 'SCWA', secretKey: 's', organizationId: null, projectId: 'p', region: 'fr-par', zone: 'fr-par-1' });
    expect(env).toMatchObject({ SCW_ACCESS_KEY: 'SCWA', SCW_SECRET_KEY: 's', SCW_DEFAULT_PROJECT_ID: 'p', SCW_DEFAULT_REGION: 'fr-par', SCW_DEFAULT_ZONE: 'fr-par-1', SCW_DISABLE_CHECK_VERSION: 'true' });
    expect(env).not.toHaveProperty('SCW_DEFAULT_ORGANIZATION_ID');
  });
});
