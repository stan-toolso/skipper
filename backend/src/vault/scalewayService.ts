import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import * as api from './api.js';
import * as scaleway from './scaleway.js';
import { vaultRepository } from './repository.js';
import { vaultService } from './service.js';
import type { ScalewayCredentials, ScalewaySettings, VaultItem } from './types.js';

/**
 * Comptes Scaleway du coffre, partie avec état : identifiants de l'élément (clé d'accès publique dans les
 * réglages, clé secrète chiffrée), exécution d'une commande du CLI ou d'un appel d'API pour un agent, test.
 * Le service est le seul à voir la clé secrète : l'agent ne reçoit que la sortie de la commande ou la réponse.
 */

const settingsOf = (item: VaultItem): ScalewaySettings => {
  if (item.kind !== 'scaleway') throw new AppError(`« ${item.name} » n'est pas un compte Scaleway`);
  return item.settings as ScalewaySettings;
};


export const scalewayService = {
  settingsOf,

  /** Identifiants complets de l'élément, en mémoire le temps d'un usage. */
  credentials(item: VaultItem): ScalewayCredentials {
    const s = settingsOf(item);
    const secretKey = vaultService.secretsOf(item).secretKey;
    if (!secretKey) throw new AppError(`« ${item.name} » n'a pas de clé secrète`);
    return { accessKey: s.accessKey, secretKey, organizationId: s.organizationId, projectId: s.projectId, region: s.region, zone: s.zone };
  },

  /** Vérifie la commande d'un agent sans l'exécuter (avant la demande d'approbation). */
  check(item: VaultItem, command: string): scaleway.Invocation {
    const inv = scaleway.parseInvocation(command);
    scaleway.checkPolicy(inv, item);
    return inv;
  },

  /**
   * Commande du CLI pour un agent : découpage sans shell, politique (lecture seule, préfixes autorisés,
   * commandes interdites), puis exécution dans un conteneur jetable où `cwd` est monté.
   */
  async run(item: VaultItem, project: Project | null, cwd: string, command: string, timeoutMs: number) {
    const inv = scaleway.parseInvocation(command);
    scaleway.checkPolicy(inv, item);
    return scaleway.runCli(project, cwd, this.credentials(item), inv.tokens, timeoutMs);
  },

  /** Vérifie un appel d'API sans l'exécuter (méthode selon la lecture seule, chemin sous api.scaleway.com, chemins sensibles). */
  checkApi(item: VaultItem, call: api.ApiCall): void {
    api.validateCall(scaleway.apiCredentials({ secretKey: 'x' }), item.readOnly, call);
    scaleway.checkApiCall(item.readOnly, call, item.name);
  },

  /** Appel de l'API Scaleway pour un agent, authentifié par le serveur (X-Auth-Token), rendu par api.ts. */
  async api(item: VaultItem, call: api.ApiCall) {
    this.checkApi(item, call);
    return api.execute(scaleway.apiCredentials(this.credentials(item)), item.readOnly, call);
  },

  // ---- Test ----------------------------------------------------------------------------------------

  /** Vérifie la clé auprès d'IAM, mémorise l'identité constatée et complète l'organisation si elle manque. */
  async probe(item: VaultItem): Promise<string> {
    const creds = this.credentials(item);
    const who = await scaleway.identity(creds);
    const fresh = settingsOf(await vaultService.getInternal(item.id));
    const settings: ScalewaySettings = { ...fresh, identity: who.principal, organizationId: fresh.organizationId ?? who.organizationId, projectId: fresh.projectId ?? who.defaultProjectId };
    await vaultRepository.update(item.id, { settings });
    const parts = [who.principal];
    if (who.description) parts.push(`clé « ${who.description} »`);
    if (settings.projectId) parts.push(`projet ${settings.projectId}`);
    if (who.expiresAt) parts.push(`expire le ${new Date(who.expiresAt).toLocaleDateString('fr-FR', { dateStyle: 'medium', timeZone: 'Europe/Paris' })}`);
    return parts.join(' · ');
  },

};

vaultService.probers.set('scaleway', (item) => scalewayService.probe(item));
