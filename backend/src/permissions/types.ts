/** Règle d'autorisation d'outil mémorisée pour un projet, au format des permissions Claude Code. */
export interface PermissionRule {
  id: string;
  projectId: string;
  toolName: string;
  /** Motif propre à l'outil (ex. "git status:*" pour Bash) ; null = tout l'outil. */
  ruleContent: string | null;
  createdBySessionId: string | null;
  createdAt: Date;
}

/** Représentation textuelle d'une règle, telle qu'attendue par `allowedTools` : Read, Bash(git status:*)... */
export const formatRule = (rule: { toolName: string; ruleContent?: string | null }): string => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName);
