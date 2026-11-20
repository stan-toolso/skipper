import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HumanRequest } from '../requests/types.js';

// Saisie de secrets par une personne : les valeurs vont dans le coffre, la réponse remise à l'agent n'en porte aucune.
const { requests, vault, users, sessions, sessionSecrets } = vi.hoisted(() => ({
  sessionSecrets: { store: vi.fn() },
  requests: { get: vi.fn(), answer: vi.fn() },
  vault: { getInternal: vi.fn(), update: vi.fn(), create: vi.fn(), link: vi.fn(), delete: vi.fn(), agentItems: vi.fn() },
  users: { roleFor: vi.fn() },
  sessions: { findById: vi.fn() },
}));
vi.mock('../requests/service.js', () => ({ requestService: requests, REQUEST_SETTLED: 'REQUEST_SETTLED' }));
vi.mock('./service.js', () => ({ vaultService: vault }));
vi.mock('../users/service.js', () => ({ userService: users }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: sessions }));
vi.mock('./sessionSecrets.js', () => ({ sessionSecretService: sessionSecrets }));

const { provideSecrets, redactSecret, parseSecretRef, normalizeRequestedFields, prepareSecretsRequest } = await import('./secretRequests.js');

const request = (payload: Record<string, unknown>, over: Partial<HumanRequest> = {}): HumanRequest =>
  ({
    id: 'r1',
    sessionId: 's1',
    type: 'secrets',
    status: 'pending',
    title: 't',
    message: null,
    response: null,
    answeredById: null,
    createdAt: new Date(),
    answeredAt: null,
    payload: { item: 'deploy-key', itemId: null, description: null, fields: [{ key: 'private_key', label: 'Clé', hint: null, multiline: true }], projectId: 'p', personalUserId: 'u', ...payload },
    ...over,
  }) as HumanRequest;

beforeEach(() => {
  for (const group of [requests, vault, users, sessions, sessionSecrets]) for (const fn of Object.values(group)) fn.mockReset();
  sessions.findById.mockResolvedValue({ id: 's1', projectId: 'p', name: 'Session' });
  requests.answer.mockImplementation(async (_id: string, response: Record<string, unknown>) => ({ id: 'r1', response }));
  vault.create.mockImplementation(async (_a: unknown, projectId: string | null, input: { name: string; requireApproval: boolean }) => ({ id: 'n1', name: input.name, kind: 'secret', ownerProjectId: projectId, requireApproval: input.requireApproval }));
});

describe('provideSecrets', () => {
  it('crée un secret personnel ouvert aux sessions du projet et répond sans valeur', async () => {
    requests.get.mockResolvedValue(request({}));
    await provideSecrets('r1', 'u', { values: [{ key: 'private_key', value: 'SUPER-SECRET' }] });
    expect(vault.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u' }), null, expect.objectContaining({ name: 'deploy-key', kind: 'secret', requireApproval: true, fields: [{ key: 'private_key', label: 'Clé', secret: true, value: 'SUPER-SECRET' }] }));
    expect(vault.link).toHaveBeenCalledWith(expect.anything(), 'n1', 'p', 'personal');
    const response = requests.answer.mock.calls[0][1];
    expect(response).toEqual({ item: 'deploy-key', itemId: 'n1', fields: ['private_key'], created: true, destination: 'personal', requireApproval: true });
    expect(JSON.stringify(response)).not.toContain('SUPER-SECRET');
  });

  it('refuse le coffre du projet à qui ne l\'administre pas, et le coffre personnel à une autre personne', async () => {
    requests.get.mockResolvedValue(request({}));
    users.roleFor.mockResolvedValue('member');
    await expect(provideSecrets('r1', 'u', { values: [{ key: 'private_key', value: 'x' }], destination: 'project' })).rejects.toThrow(/administrateur/);
    await expect(provideSecrets('r1', 'autre', { values: [{ key: 'private_key', value: 'x' }], destination: 'personal' })).rejects.toThrow(/ne tourne pas avec vos droits/);
    expect(vault.create).not.toHaveBeenCalled();
    expect(requests.answer).not.toHaveBeenCalled();
  });

  it('crée dans le coffre du projet pour un administrateur, sans accord si demandé', async () => {
    requests.get.mockResolvedValue(request({}));
    users.roleFor.mockResolvedValue('admin');
    await provideSecrets('r1', 'autre', { values: [{ key: 'private_key', value: 'x' }], requireApproval: false });
    expect(vault.create).toHaveBeenCalledWith(expect.anything(), 'p', expect.objectContaining({ requireApproval: false }));
    expect(vault.link).not.toHaveBeenCalled();
  });

  it('met à jour un secret existant en gardant ses autres champs', async () => {
    requests.get.mockResolvedValue(request({ itemId: 'e1' }));
    vault.getInternal.mockResolvedValue({ id: 'e1', name: 'deploy-key', kind: 'secret', settings: { fields: [{ key: 'user', label: 'Utilisateur', secret: false, value: 'deploy' }, { key: 'private_key', label: 'Clé', secret: true, value: null }] } });
    vault.update.mockResolvedValue({ id: 'e1', name: 'deploy-key', requireApproval: true });
    await provideSecrets('r1', 'u', { values: [{ key: 'private_key', value: 'neuve' }] });
    expect(vault.update).toHaveBeenCalledWith(expect.anything(), 'e1', {
      fields: [
        { key: 'user', label: 'Utilisateur', secret: false, value: 'deploy' },
        { key: 'private_key', label: 'Clé', secret: true, value: 'neuve' },
      ],
    });
    expect(requests.answer.mock.calls[0][1]).toEqual(expect.objectContaining({ destination: 'existing', created: false }));
  });

  it('confie le secret à la session seule, sans toucher au coffre', async () => {
    requests.get.mockResolvedValue(request({ ephemeral: true }));
    const expiresAt = new Date('2026-11-21T17:00:00Z');
    sessionSecrets.store.mockResolvedValue({ id: 'ss1', name: 'deploy-key', requireApproval: false, expiresAt });
    await provideSecrets('r1', 'autre', { values: [{ key: 'private_key', value: 'EPHEMERE' }], destination: 'session', requireApproval: false });
    expect(sessionSecrets.store).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', name: 'deploy-key', values: { private_key: 'EPHEMERE' }, requireApproval: false, createdById: 'autre' }));
    expect(vault.create).not.toHaveBeenCalled();
    const response = requests.answer.mock.calls[0][1];
    expect(response).toEqual(expect.objectContaining({ destination: 'session', item: 'deploy-key', expiresAt: expiresAt.toISOString() }));
    expect(JSON.stringify(response)).not.toContain('EPHEMERE');
  });

  it('exige chaque champ, et refuse une autre demande ou une demande déjà réglée', async () => {
    requests.get.mockResolvedValue(request({}));
    await expect(provideSecrets('r1', 'u', { values: [] })).rejects.toThrow(/à remplir : Clé/);
    requests.get.mockResolvedValue(request({}, { type: 'permission' }));
    await expect(provideSecrets('r1', 'u', { values: [{ key: 'private_key', value: 'x' }] })).rejects.toThrow(/n'attend pas de secrets/);
    requests.get.mockResolvedValue(request({}, { status: 'answered' }));
    await expect(provideSecrets('r1', 'u', { values: [{ key: 'private_key', value: 'x' }] })).rejects.toMatchObject({ code: 'REQUEST_SETTLED' });
  });
});

describe('outils', () => {
  it('redactSecret masque la valeur entière et ses lignes', () => {
    const key = '-----BEGIN KEY-----\nAAAABBBBCCCCDDDD\n-----END KEY-----';
    expect(redactSecret(`x ${key} y`, key)).toBe('x [secret masqué] y');
    expect(redactSecret('ligne AAAABBBBCCCCDDDD', key)).toBe('ligne [secret masqué]');
    expect(redactSecret('abc', 'ab')).toBe('abc');
  });

  it('parseSecretRef et normalizeRequestedFields valident leurs entrées', () => {
    expect(parseSecretRef(' Cle.Private_Key ')).toEqual({ session: false, item: 'cle', field: 'private_key' });
    expect(parseSecretRef('session:brevo.token')).toEqual({ session: true, item: 'brevo', field: 'token' });
    expect(() => parseSecretRef('cle')).toThrow();
    expect(() => normalizeRequestedFields([])).toThrow();
    expect(() => normalizeRequestedFields([{ key: 'a' }, { key: 'A' }])).toThrow(/deux fois/);
    expect(normalizeRequestedFields([{ key: 'token', hint: ' ' }])).toEqual([{ key: 'token', label: 'token', hint: null, multiline: false }]);
  });

  it('prepareSecretsRequest retrouve un secret existant, refuse un autre type', async () => {
    vault.agentItems.mockResolvedValue([{ id: 'e1', name: 'deploy-key', kind: 'secret' }, { id: 'h', name: 'prod', kind: 'ssh' }]);
    const fields = normalizeRequestedFields([{ key: 'token' }]);
    expect((await prepareSecretsRequest({ projectId: 'p', rightsHolderId: 'u', item: 'Deploy-Key', fields })).itemId).toBe('e1');
    await expect(prepareSecretsRequest({ projectId: 'p', rightsHolderId: 'u', item: 'prod', fields })).rejects.toThrow(/n'est pas un secret/);
    await expect(prepareSecretsRequest({ projectId: 'p', rightsHolderId: 'u', item: 'nom invalide', fields })).rejects.toThrow(/invalide/);
  });
});
