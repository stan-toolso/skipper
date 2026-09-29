import { useQuery } from '@apollo/client';
import { useParams } from 'react-router-dom';
import { PROJECT, WORKTREE, type Project } from '../graphql/operations';

/** Workspace visé par l'explorateur : checkout principal d'un projet, ou un worktree. */
export interface WorkspaceRef {
  projectId: string;
  worktreeId: string | null;
}

/** URL de l'explorateur (path vide) ou de l'éditeur d'un fichier, chaque segment encodé. */
export function filesUrl(ref: WorkspaceRef, path = ''): string {
  const base = ref.worktreeId ? `/worktrees/${ref.worktreeId}/files` : `/projects/${ref.projectId}/files`;
  if (!path) return base;
  return `${base}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export interface WorkspaceInfo extends WorkspaceRef {
  /** Libellé : nom du projet, ou "projet · branche" pour un worktree. */
  label: string;
  projectName: string;
  branch: string | null;
  path: string | null;
  exists: boolean;
}

/**
 * Résout le workspace depuis l'URL courante (/projects/:id/files/* ou /worktrees/:wid/files/*),
 * avec le chemin du fichier demandé (splat).
 */
export function useWorkspaceFromRoute(): { info: WorkspaceInfo | null; loading: boolean; error: Error | undefined; filePath: string } {
  const params = useParams();
  const projectId = params.id;
  const worktreeId = params.wid;
  const filePath = params['*'] ?? '';
  const { data: pData, loading: pLoading, error: pError } = useQuery<{ project: (Project & { workspaceExists: boolean }) | null }>(PROJECT, { variables: { id: projectId }, skip: !projectId });
  const { data: wData, loading: wLoading, error: wError } = useQuery<{
    worktree: { id: string; name: string; branch: string; path: string; exists: boolean; project: { id: string; name: string; slug: string } } | null;
  }>(WORKTREE, { variables: { id: worktreeId }, skip: !worktreeId });

  let info: WorkspaceInfo | null = null;
  if (worktreeId && wData?.worktree) {
    const w = wData.worktree;
    info = { projectId: w.project.id, worktreeId: w.id, label: `${w.project.name} · ${w.branch}`, projectName: w.project.name, branch: w.branch, path: w.path, exists: w.exists };
  } else if (projectId && pData?.project) {
    const p = pData.project;
    info = { projectId: p.id, worktreeId: null, label: p.name, projectName: p.name, branch: p.git?.branch ?? null, path: p.workspacePath, exists: p.workspaceExists };
  }
  return { info, loading: pLoading || wLoading, error: pError ?? wError, filePath };
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

/** Icône Bootstrap selon l'extension. */
export function fileIcon(name: string, kind: string): string {
  if (kind === 'dir') return 'bi-folder2';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'php', 'c', 'h', 'cpp', 'cs', 'swift', 'sh', 'sql', 'graphql'].includes(ext)) return 'bi-file-earmark-code';
  if (['md', 'txt', 'rst'].includes(ext)) return 'bi-file-earmark-text';
  if (['json', 'yml', 'yaml', 'toml', 'ini', 'env', 'xml'].includes(ext)) return 'bi-file-earmark-binary';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return 'bi-file-earmark-image';
  if (['html', 'htm', 'css', 'scss'].includes(ext)) return 'bi-file-earmark-richtext';
  return 'bi-file-earmark';
}
