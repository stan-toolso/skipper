/**
 * Work session : l'unité de travail d'un projet. Un dossier à elle, à côté du checkout principal — un
 * `git worktree` sur sa propre branche pour un projet relié à un dépôt, un simple dossier sinon. Toute
 * session et tout terminal s'exécutent dans l'une d'elles ; rien ne tourne dans le checkout principal.
 */
export interface Worksession {
  id: string;
  projectId: string;
  /** Nom du dossier (slug). */
  name: string;
  /** Branche extraite (projet git) ; pour un projet sans dépôt, le nom du dossier. */
  branch: string;
  /** Libellé libre affiché dans l'interface (ce dont elle parle) ; null : la branche. */
  label: string | null;
  /** Tâche à laquelle elle est consacrée : ses sessions suivantes y travaillent aussi. */
  taskId: string | null;
  /** Archivée : sessions archivées avec elle, dossier conservé, branche conservée ; restaurable depuis l'historique. */
  archivedAt: Date | null;
  createdAt: Date;
}

/** Libellé affiché : le libellé choisi, sinon la branche. */
export const worksessionLabel = (w: Pick<Worksession, 'label' | 'branch'>): string => w.label ?? w.branch;
