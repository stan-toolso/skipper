/**
 * Fichier d'environnement d'un projet : un modèle (texte, références `{{vault:élément.champ}}`) écrit à un chemin
 * relatif de chaque nouvelle work session, éditable dans l'interface (page Environnement) et par les agents (outils `env`).
 */
export interface EnvFile {
  id: string;
  projectId: string;
  /** Chemin relatif au dossier de travail (ex. `.env`, `backend/.env`). */
  path: string;
  content: string;
  /** Écrit à la création de chaque work session du projet. */
  applyOnCreate: boolean;
  updatedById: string | null;
  updatedBySessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Auteur d'une modification : une personne (interface) ou une session d'agent (avec la personne qui la pilote). */
export interface EnvActor {
  userId: string | null;
  sessionId?: string | null;
}

/** Compte rendu de l'écriture des fichiers dans une work session. */
export interface EnvApplyResult {
  written: string[];
  /** Fichiers non écrits (déjà présents à la création, chemin refusé...), avec la raison. */
  skipped: string[];
  /** Références au coffre non résolues (remplacées par une chaîne vide). */
  problems: string[];
}
