import { describe, expect, it } from 'vitest';
import { siteAllows, validateFieldKey, validateUrl, variableName } from './website.js';

describe('siteAllows', () => {
  it('même hôte et port, ou sous-domaine', () => {
    expect(siteAllows('https://admin.example.com/login', 'https://admin.example.com')).toBe(true);
    expect(siteAllows('https://example.com/', 'https://app.example.com:8443')).toBe(true);
    expect(siteAllows('https://Example.com/', 'https://EXAMPLE.com')).toBe(true);
  });
  it('refuse un autre hôte, un autre port du même hôte, et le passage à http', () => {
    expect(siteAllows('https://example.com/', 'https://example.org')).toBe(false);
    expect(siteAllows('https://example.com:8443/', 'https://example.com')).toBe(false);
    expect(siteAllows('https://example.com/', 'http://example.com')).toBe(false);
    expect(siteAllows('https://example.com/', 'file:///tmp/x')).toBe(false);
    expect(siteAllows('https://example.com/', 'https://notexample.com')).toBe(false);
  });
});

describe('champs', () => {
  it('clé de champ et nom de variable', () => {
    expect(validateFieldKey(' Password ')).toBe('password');
    expect(() => validateFieldKey('1abc')).toThrow();
    expect(() => validateFieldKey('a-b')).toThrow();
    expect(variableName('admin-site', 'password')).toBe('ADMIN_SITE_PASSWORD');
  });
  it('adresse du site : http(s) seulement, normalisée', () => {
    expect(validateUrl('HTTPS://Example.com/login')).toBe('https://example.com/login');
    expect(() => validateUrl('ftp://example.com')).toThrow();
    expect(() => validateUrl('')).toThrow();
  });
});
