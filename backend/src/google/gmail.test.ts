import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Client Gmail testé sans réseau : googleAccountService.json renvoie des réponses préparées par URL.
const { calls, responses } = vi.hoisted(() => ({ calls: [] as string[], responses: new Map<string, unknown>() }));
vi.mock('./service.js', () => ({
  googleAccountService: {
    json: async (_accountId: string, url: string) => {
      calls.push(url);
      for (const [suffix, value] of responses) if (url.endsWith(suffix)) return value;
      throw new Error(`réponse non préparée pour ${url}`);
    },
  },
}));

const gmail = await import('./gmail.js');

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const message = {
  id: 'm1',
  threadId: 't1',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: 'perrine@example.org' }, { name: 'Subject', value: 'Remboursement courses' }],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Voici le ticket de caisse.') } },
      { mimeType: 'image/jpeg', filename: 'Image_261009_125550.jpeg', body: { size: 3, attachmentId: 'ATT-1' } },
      { mimeType: 'text/plain', filename: 'note.txt', body: { size: 5, data: b64('bonjour') } },
      { mimeType: 'image/jpeg', filename: 'image_261009_125550.jpeg', body: { size: 3, attachmentId: 'ATT-2' } },
    ],
  },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'gmail-test-'));
  calls.length = 0;
  responses.clear();
  responses.set('/messages/m1?format=full', message);
  responses.set('/messages/m1/attachments/ATT-1', { size: 3, data: b64('JPG') });
  responses.set('/messages/m1/attachments/ATT-2', { size: 3, data: b64('BIS') });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('gmail.read', () => {
  it('liste les pièces jointes numérotées, stockées à part ou en ligne, sans leur contenu', async () => {
    const m = await gmail.read('a', 'm1');
    expect(m.body).toBe('Voici le ticket de caisse.');
    expect(m.attachments).toEqual([
      { index: 1, filename: 'Image_261009_125550.jpeg', mimeType: 'image/jpeg', size: 3 },
      { index: 2, filename: 'note.txt', mimeType: 'text/plain', size: 5 },
      { index: 3, filename: 'image_261009_125550.jpeg', mimeType: 'image/jpeg', size: 3 },
    ]);
    expect(gmail.renderMessage(m)).toContain('Pièces jointes (gmail_attachment pour en télécharger une) : 1. Image_261009_125550.jpeg (image/jpeg, 3 octets) ; 2. note.txt');
  });
});

describe('gmail.downloadAttachment', () => {
  const target = (name: string) => path.join(dir, 'pj', name);

  it('télécharge une pièce jointe stockée à part, désignée par son numéro', async () => {
    const r = await gmail.downloadAttachment('a', 'm1', '1', target);
    expect(r).toEqual({ filename: 'Image_261009_125550.jpeg', mimeType: 'image/jpeg', bytes: 3, localPath: target('Image_261009_125550.jpeg') });
    expect(await readFile(r.localPath, 'utf8')).toBe('JPG');
    expect(calls.some((u) => u.endsWith('/messages/m1/attachments/ATT-1'))).toBe(true);
  });

  it('écrit une pièce jointe en ligne sans second appel à Gmail, désignée par son nom', async () => {
    const r = await gmail.downloadAttachment('a', 'm1', 'NOTE.txt', target);
    expect(await readFile(r.localPath, 'utf8')).toBe('bonjour');
    expect(calls.filter((u) => u.includes('/attachments/'))).toEqual([]);
  });

  it('refuse un numéro ou un nom inconnu et un nom ambigu, en rappelant la liste', async () => {
    await expect(gmail.downloadAttachment('a', 'm1', '4', target)).rejects.toThrow('Pas de pièce jointe numéro 4 (pièces jointes : 1. Image_261009_125550.jpeg ; 2. note.txt ; 3. image_261009_125550.jpeg)');
    await expect(gmail.downloadAttachment('a', 'm1', 'ticket.pdf', target)).rejects.toThrow('Pas de pièce jointe nommée « ticket.pdf »');
    await expect(gmail.downloadAttachment('a', 'm1', 'image_261009_125550.jpeg', target)).rejects.toThrow('désigne-la par son numéro');
    expect(calls.filter((u) => u.includes('/attachments/'))).toEqual([]);
  });

  it('ne garde du nom de fichier que sa dernière composante', async () => {
    responses.set('/messages/m2?format=full', { id: 'm2', threadId: 't2', payload: { parts: [{ mimeType: 'text/plain', filename: '../../etc/passwd', body: { size: 1, data: b64('x') } }] } });
    const r = await gmail.downloadAttachment('a', 'm2', '1', target);
    expect(r.localPath).toBe(target('passwd'));
  });

  it('signale un message sans pièce jointe', async () => {
    responses.set('/messages/m3?format=full', { id: 'm3', threadId: 't3', payload: { mimeType: 'text/plain', body: { data: b64('rien') } } });
    await expect(gmail.downloadAttachment('a', 'm3', '1', target)).rejects.toThrow("Ce message n'a pas de pièce jointe");
  });
});
