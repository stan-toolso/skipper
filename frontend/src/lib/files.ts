import { useQuery } from '@apollo/client';
import { useLocation, useParams } from 'react-router-dom';
import { PROJECT, SESSION_WORKSPACE, type Project } from '../graphql/operations';

/** Workspace visé par l'explorateur (requêtes git et fichiers) : checkout principal d'un projet, ou le dossier d'une session (sa work session). */
export interface WorkspaceRef {
  projectId: string;
  worksessionId: string | null;
}

/** Ce qu'il faut pour adresser l'explorateur : les fichiers d'une session sont sous sa page, ceux du projet sous la sienne. */
export interface FilesTarget {
  projectId: string;
  sessionId?: string | null;
}

/** URL de l'explorateur (path vide) ou de l'éditeur d'un fichier, chaque segment encodé. */
export function filesUrl(ref: FilesTarget, path = ''): string {
  const base = ref.sessionId ? `/sessions/${ref.sessionId}/files` : `/projects/${ref.projectId}/files`;
  if (!path) return base;
  return `${base}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export interface WorkspaceInfo extends WorkspaceRef {
  /** Session dont c'est le dossier ; null pour le checkout principal. */
  sessionId: string | null;
  sessionName: string | null;
  /** Libellé : nom du projet, ou "projet · branche" pour le dossier d'une session. */
  label: string;
  projectName: string;
  branch: string | null;
  path: string | null;
  exists: boolean;
}

/**
 * Résout le workspace depuis l'URL courante (/projects/:id/files/* ou /sessions/:id/files/*), avec le chemin du
 * fichier demandé (splat). Une session d'avant les work sessions (sans dossier à elle) ouvre le checkout principal.
 */
export function useWorkspaceFromRoute(): { info: WorkspaceInfo | null; loading: boolean; error: Error | undefined; filePath: string } {
  const params = useParams();
  const { pathname } = useLocation();
  const sessionId = pathname.startsWith('/sessions/') ? params.id : undefined;
  const projectId = sessionId ? undefined : params.id;
  const filePath = params['*'] ?? '';
  const { data: pData, loading: pLoading, error: pError } = useQuery<{ project: (Project & { workspaceExists: boolean }) | null }>(PROJECT, { variables: { id: projectId }, skip: !projectId });
  const { data: sData, loading: sLoading, error: sError } = useQuery<{
    session: { id: string; name: string; project: { id: string; name: string; slug: string; workspacePath: string }; worksession: { id: string; name: string; branch: string; path: string; exists: boolean } | null } | null;
  }>(SESSION_WORKSPACE, { variables: { id: sessionId }, skip: !sessionId });

  let info: WorkspaceInfo | null = null;
  if (sessionId && sData?.session) {
    const s = sData.session;
    const w = s.worksession;
    info = { projectId: s.project.id, worksessionId: w?.id ?? null, sessionId: s.id, sessionName: s.name, label: `${s.project.name} · ${w?.branch ?? s.name}`, projectName: s.project.name, branch: w?.branch ?? null, path: w?.path ?? s.project.workspacePath, exists: w?.exists ?? true };
  } else if (projectId && pData?.project) {
    const p = pData.project;
    info = { projectId: p.id, worksessionId: null, sessionId: null, sessionName: null, label: p.name, projectName: p.name, branch: p.git?.branch ?? null, path: p.workspacePath, exists: p.workspaceExists };
  }
  return { info, loading: pLoading || sLoading, error: pError ?? sError, filePath };
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
