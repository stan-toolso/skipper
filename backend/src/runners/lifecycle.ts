import type { Project } from '../projects/types.js';
import { sessionService } from '../sessions/service.js';
import { runner } from './index.js';

/**
 * Arrêt et recréation de l'environnement d'exécution d'un projet depuis sa page. Les processus des
 * sessions tournent dans le conteneur : le supprimer les tue (code 137), ce qui passait pour un manque
 * de mémoire. On interrompt donc d'abord proprement les sessions du projet (statut « interrompue »,
 * sans erreur), puis on agit sur le conteneur, et, pour une recréation, on relance toutes les sessions
 * interrompues dès que le nouveau conteneur est prêt.
 */
export const runnerLifecycle = {
  /** Supprime le conteneur, le recrée avec l'image et les limites actuelles, puis reprend les sessions interrompues. */
  async reset(project: Project): Promise<{ interrupted: string[]; resumed: string[] }> {
    const sessions = await sessionService.interruptForRunner(project.id, 'runner_reset');
    await runner.remove(project);
    try {
      await runner.ensureReady(project);
    } catch (err) {
      // Conteneur impossible à recréer (image absente, Docker en panne) : les sessions restent interrompues,
      // avec « Reprendre » sur leur page ; l'erreur remonte à la page du projet.
      console.error(`[runner] recréation de ${runner.containerName(project)}`, err);
      throw err;
    }
    const resumed = await sessionService.resumeAfterRunner(sessions);
    if (sessions.length) console.log(`[runner] ${runner.containerName(project)} recréé : ${resumed.length}/${sessions.length} session(s) reprise(s)`);
    return { interrupted: sessions.map((s) => s.id), resumed };
  },

  /** Arrête le conteneur après avoir interrompu les sessions du projet ; elles se reprennent à la main (bouton ou message). */
  async stop(project: Project): Promise<{ interrupted: string[] }> {
    const sessions = await sessionService.interruptForRunner(project.id, 'runner_stop');
    await runner.stop(project);
    return { interrupted: sessions.map((s) => s.id) };
  },
};
