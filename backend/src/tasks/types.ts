import type { Actor } from '../context/types.js';

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
export const TASK_PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  sessionId: string | null;
  /** Branche git de la tâche (worktree dédié), conservée après suppression du worktree. */
  branch: string | null;
  createdByType: Actor['type'];
  createdBySessionId: string | null;
  dueDate: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  priority?: TaskPriority | null;
  status?: TaskStatus | null;
  sessionId?: string | null;
  dueDate?: string | null;
}

export interface UpdateTaskInput {
  title?: string | null;
  description?: string | null;
  priority?: TaskPriority | null;
  status?: TaskStatus | null;
  sessionId?: string | null;
  branch?: string | null;
  dueDate?: string | null;
}

export interface TaskFilter {
  projectId?: string;
  projectIds?: string[];
  status?: TaskStatus[];
  priority?: TaskPriority;
  sessionId?: string;
  limit?: number;
}
