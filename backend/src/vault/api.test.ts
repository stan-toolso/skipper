import { describe, expect, it } from 'vitest';
import { redact, resolveTarget, validateBaseUrl, validateCall } from './api.js';
import { classifyAddress } from './http.js';
import type { ApiSettings } from './types.js';

const settings: ApiSettings = { baseUrl: 'https://api.example.com/v1/', authScheme: 'header', authName: 'X-Api-Key', username: null };

describe('validateBaseUrl', () => {
  it('normalise et retire requête et ancre', () => {
    expect(validateBaseUrl(' https://api.example.com/v1?x=1#y ')).toBe('https://api.example.com/v1');
  });
  it('refuse les adresses internes, les identifiants dans l’URL et les schémas exotiques', () => {
    expect(() => validateBaseUrl('http://localhost:3000')).toThrow();
    expect(() => validateBaseUrl('http://169.254.169.254/latest')).toThrow();
    expect(() => validateBaseUrl('http://metadata.google.internal')).toThrow();
    expect(() => validateBaseUrl('https://user:pw@api.example.com')).toThrow();
    expect(() => validateBaseUrl('ftp://api.example.com')).toThrow();
    expect(() => validateBaseUrl('')).toThrow();
  });
});

describe('classifyAddress', () => {
  it('distingue réservé, privé et public', () => {
    expect(classifyAddress('127.0.0.1')).toBe('forbidden');
    expect(classifyAddress('169.254.10.1')).toBe('forbidden');
    expect(classifyAddress('::1')).toBe('forbidden');
    expect(classifyAddress('10.1.2.3')).toBe('private');
    expect(classifyAddress('192.168.0.1')).toBe('private');
    expect(classifyAddress('fd00::1')).toBe('private');
    expect(classifyAddress('93.184.216.34')).toBe('public');
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('forbidden');
  });
});

describe('validateCall', () => {
  it('lecture seule : seules GET, HEAD, OPTIONS passent', () => {
    expect(validateCall(settings, true, { path: 'x' }).method).toBe('GET');
    expect(() => validateCall(settings, true, { path: 'x', method: 'post' })).toThrow(/lecture seule/);
    expect(validateCall(settings, false, { path: 'x', method: 'post' }).method).toBe('POST');
  });
  it('refuse les en-têtes sensibles et celui qui porte le jeton', () => {
    expect(() => validateCall(settings, false, { path: 'x', headers: { Authorization: 'Bearer y' } })).toThrow();
    expect(() => validateCall(settings, false, { path: 'x', headers: { Cookie: 'a=b' } })).toThrow();
    expect(() => validateCall(settings, false, { path: 'x', headers: { 'X-Forwarded-For': '1.2.3.4' } })).toThrow();
    expect(() => validateCall(settings, false, { path: 'x', headers: { 'x-api-key': 'z' } })).toThrow();
    expect(validateCall(settings, false, { path: 'x', headers: { Accept: 'text/plain' } }).headers).toEqual({ accept: 'text/plain' });
  });
});

describe('resolveTarget', () => {
  const base = 'https://api.example.com/v1';
  it('résout un chemin relatif sous l’adresse de base', () => {
    expect(resolveTarget(base, 'users/42').toString()).toBe('https://api.example.com/v1/users/42');
    expect(resolveTarget(base, '/users').toString()).toBe('https://api.example.com/v1/users');
    expect(resolveTarget(base, 'users', { page: '2', q: 'a b' }).toString()).toBe('https://api.example.com/v1/users?page=2&q=a+b');
  });
  it('ne sort ni de l’origine ni du chemin de base', () => {
    expect(() => resolveTarget(base, 'https://evil.example/x')).toThrow(/chemin relatif/);
    expect(() => resolveTarget(base, '//evil.example/x')).toThrow();
    expect(() => resolveTarget(base, '../admin')).toThrow(/rester sous/);
    expect(() => resolveTarget(base, '%2e%2e/admin')).toThrow(/rester sous/);
    expect(() => resolveTarget(base, 'users/%zz')).toThrow(/mal encodé/);
  });
});

describe('redact', () => {
  it('masque le jeton brut, encodé, et en base64 pour basic', () => {
    const creds = { ...settings, authScheme: 'basic' as const, username: 'bob', token: 'sécret/1' };
    const b64 = Buffer.from('bob:sécret/1').toString('base64');
    const text = `token=sécret/1 url=${encodeURIComponent('sécret/1')} auth=${b64}`;
    expect(redact(text, creds)).toBe('token=[secret masqué] url=[secret masqué] auth=[secret masqué]');
  });
  it('ne masque pas un jeton trop court pour être significatif', () => {
    expect(redact('a1 a1', { ...settings, token: 'a1' })).toBe('a1 a1');
  });
});
