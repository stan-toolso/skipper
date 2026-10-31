import { describe, expect, it } from 'vitest';
import { connectionErrorMessage, databasesSql, MAINTENANCE_DATABASE, validateDatabaseName } from './postgres.js';

describe('validateDatabaseName', () => {
  it('accepte un identifiant simple, espaces retirés', () => {
    expect(validateDatabaseName(' skipper ')).toBe('skipper');
    expect(validateDatabaseName('skipper-test_2')).toBe('skipper-test_2');
    expect(validateDatabaseName('42bis')).toBe('42bis');
  });
  it('refuse le vide, les espaces, les guillemets et les noms trop longs', () => {
    for (const bad of ['', '  ', 'ma base', 'a"b', "a'b", 'a;b', 'a.b', 'é', 'x'.repeat(64)]) {
      expect(() => validateDatabaseName(bad), bad).toThrow(/invalide/);
    }
    expect(() => validateDatabaseName(null)).toThrow(/invalide/);
  });
  it('nomme le champ dans le message', () => {
    expect(() => validateDatabaseName('a b', 'Le nom de la nouvelle base')).toThrow(/^Le nom de la nouvelle base est invalide/);
  });
});

describe('databasesSql', () => {
  it('exclut les bases interdites de connexion et ne mesure que celles accessibles', () => {
    const sql = databasesSql();
    expect(sql).toContain('d.datallowconn');
    expect(sql).toContain("has_database_privilege(d.datname, 'CONNECT')");
  });
  it('la base de maintenance par défaut est postgres', () => {
    expect(MAINTENANCE_DATABASE).toBe('postgres');
  });
});

describe('connectionErrorMessage', () => {
  const creds = { username: 'u', host: 'h', port: 5432, database: 'd', sslCa: null };
  const tlsError = Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });

  it('indique de fournir l\'autorité quand la chaîne est inconnue', () => {
    expect(connectionErrorMessage(creds, tlsError)).toMatch(/^Connexion PostgreSQL à u@h:5432\/d impossible : self-signed.*collez le certificat de l'autorité/);
  });

  it('signale une autorité fournie qui ne valide pas la chaîne', () => {
    expect(connectionErrorMessage({ ...creds, sslCa: '-----BEGIN CERTIFICATE-----' }, tlsError)).toMatch(/ne valide pas la chaîne/);
  });

  it('laisse les autres erreurs telles quelles', () => {
    expect(connectionErrorMessage(creds, new Error('timeout'))).toBe('Connexion PostgreSQL à u@h:5432/d impossible : timeout');
  });
});
