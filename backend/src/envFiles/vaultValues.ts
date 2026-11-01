import type { ApiSettings, AwsSettings, PostgresSettings, ScalewaySettings, SecretSettings, SshSettings, VaultItem, WebsiteSettings } from '../vault/types.js';

/**
 * Champs d'un élément du coffre utilisables dans un fichier d'environnement (`{{vault:élément.champ}}`), par type.
 * `fieldNames` sert l'aide de l'éditeur (sans rien déchiffrer) ; `fieldValues` les valeurs, secrets déchiffrés fournis.
 */

export function fieldNames(item: VaultItem): string[] {
  switch (item.kind) {
    case 'secret':
      return (item.settings as SecretSettings).fields.map((f) => f.key);
    case 'website':
      return ['url', ...(item.settings as WebsiteSettings).fields.map((f) => f.key)];
    case 'postgres':
      return ['url', 'host', 'port', 'user', 'password', 'database'];
    case 'api':
      return (item.settings as ApiSettings).authScheme === 'basic' ? ['url', 'user', 'password'] : ['url', 'token'];
    case 'ssh':
      return ['host', 'port', 'user', 'private_key'];
    case 'aws':
      return (item.settings as AwsSettings).auth === 'keys' ? ['access_key_id', 'secret_access_key', 'region'] : ['region'];
    case 'scaleway':
      return ['access_key', 'secret_key', 'organization_id', 'project_id', 'region', 'zone'];
    default:
      return [];
  }
}

export function fieldValues(item: VaultItem, secrets: Record<string, string>): Record<string, string> {
  switch (item.kind) {
    case 'secret':
    case 'website': {
      const s = item.settings as SecretSettings | WebsiteSettings;
      const out: Record<string, string> = 'url' in s ? { url: s.url } : {};
      for (const f of s.fields) out[f.key] = f.secret ? secrets[f.key] ?? '' : f.value ?? '';
      return out;
    }
    case 'postgres': {
      const s = item.settings as PostgresSettings;
      const password = secrets.password ?? '';
      const database = s.database ?? 'postgres';
      const auth = `${encodeURIComponent(s.username)}${password ? `:${encodeURIComponent(password)}` : ''}`;
      const url = `postgresql://${auth}@${s.host}:${s.port}/${encodeURIComponent(database)}${s.ssl ? '?sslmode=require' : ''}`;
      return { url, host: s.host, port: String(s.port), user: s.username, password, database };
    }
    case 'api': {
      const s = item.settings as ApiSettings;
      return s.authScheme === 'basic' ? { url: s.baseUrl, user: s.username ?? '', password: secrets.token ?? '' } : { url: s.baseUrl, token: secrets.token ?? '' };
    }
    case 'ssh': {
      const s = item.settings as SshSettings;
      return { host: s.host, port: String(s.port), user: s.username, private_key: secrets.privateKey ?? '' };
    }
    case 'aws': {
      const s = item.settings as AwsSettings;
      return s.auth === 'keys' ? { access_key_id: s.accessKeyId ?? '', secret_access_key: secrets.secretAccessKey ?? '', region: s.region } : { region: s.region };
    }
    case 'scaleway': {
      const s = item.settings as ScalewaySettings;
      return { access_key: s.accessKey, secret_key: secrets.secretKey ?? '', organization_id: s.organizationId ?? '', project_id: s.projectId ?? '', region: s.region, zone: s.zone };
    }
    default:
      return {};
  }
}
