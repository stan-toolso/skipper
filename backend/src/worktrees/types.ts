export interface Worktree {
  id: string;
  projectId: string;
  /** Nom du dossier (slug). */
  name: string;
  branch: string;
  /** Libellé libre affiché dans l'interface ; null : la branche. */
  label: string | null;
  /** Archivé : sessions archivées avec lui, dossier conservé, branche conservée ; restaurable depuis l'historique. */
  archivedAt: Date | null;
  createdAt: Date;
}

/** Libellé affiché : le libellé choisi, sinon la branche. */
export const worktreeLabel = (w: Pick<Worktree, 'label' | 'branch'>): string => w.label ?? w.branch;
