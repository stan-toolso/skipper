import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBaseUrl } from '../apollo';

/** Limites, alignées sur le backend (`backend/src/sessions/attachments.ts`). */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/** Fichier choisi par l'utilisateur, en attente d'envoi avec l'instruction. */
export interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  mediaType: string;
  size: number;
  /** URL d'aperçu (images), révoquée au retrait. */
  previewUrl: string | null;
}

/** Forme envoyée à l'API (`AttachmentInput`). */
export interface AttachmentInput {
  name: string;
  mediaType: string;
  data: string;
}

/** Fichier joint tel que renvoyé par l'API (session ou événement `instruction`). */
export interface AttachmentRef {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

export function isImageType(mediaType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType);
}

/** URL de téléchargement d'un fichier joint (route HTTP authentifiée par le cookie). */
export function attachmentUrl(sessionId: string, attachmentId: string): string {
  return `${apiBaseUrl}/api/attachments/${sessionId}/${attachmentId}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function guessMediaType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const byExt: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv', ts: 'text/plain', tsx: 'text/plain', js: 'text/plain', py: 'text/plain', sql: 'text/plain', yml: 'text/plain', yaml: 'text/plain', log: 'text/plain' };
  return byExt[ext] ?? 'application/octet-stream';
}

/** Nom d'une image collée depuis le presse-papiers (les navigateurs l'appellent « image.png »). */
function pastedName(file: File, index: number): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `capture-${stamp}${index ? `-${index + 1}` : ''}.${ext}`;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Lecture impossible : ${file.name}`));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

/** Encode les fichiers en attente pour l'API. */
export async function toAttachmentInputs(items: PendingAttachment[]): Promise<AttachmentInput[]> {
  return Promise.all(items.map(async (item) => ({ name: item.name, mediaType: item.mediaType, data: await readAsBase64(item.file) })));
}

/** Fichiers d'un événement de collage ou de dépôt, dans l'ordre. */
export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files: File[] = [];
  if (dt.items?.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files.length ? files : Array.from(dt.files ?? []);
}

/**
 * Fichiers à joindre à une instruction : ajout (sélecteur, collage, dépôt), retrait, limites de taille et de nombre.
 * `error` signale le dernier refus ; `reset` vide la liste après envoi.
 */
export function usePendingAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Les URL d'aperçu sont révoquées quand le composant disparaît.
  useEffect(() => () => itemsRef.current.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl)), []);

  const add = useCallback((files: File[] | FileList | null | undefined, source: 'pick' | 'paste' | 'drop' = 'pick') => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setError(null);
    setItems((current) => {
      const next = [...current];
      let total = current.reduce((sum, i) => sum + i.size, 0);
      list.forEach((file, index) => {
        if (next.length >= MAX_ATTACHMENTS) {
          setError(`Au plus ${MAX_ATTACHMENTS} fichiers par instruction`);
          return;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setError(`« ${file.name} » dépasse ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo`);
          return;
        }
        if (total + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
          setError(`Les fichiers joints dépassent ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} Mo au total`);
          return;
        }
        if (file.size === 0) {
          setError(`« ${file.name} » est vide`);
          return;
        }
        const mediaType = guessMediaType(file);
        total += file.size;
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          name: source === 'paste' ? pastedName(file, index) : file.name,
          mediaType,
          size: file.size,
          previewUrl: isImageType(mediaType) ? URL.createObjectURL(file) : null,
        });
      });
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setItems((current) => {
      const item = current.find((i) => i.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return current.filter((i) => i.id !== id);
    });
  }, []);

  const reset = useCallback(() => {
    setItems((current) => {
      current.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
      return [];
    });
    setError(null);
  }, []);

  /** À brancher sur `onPaste` d'une zone de texte : les fichiers du presse-papiers (captures d'écran) sont joints. */
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = filesFromDataTransfer(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      add(files, 'paste');
    },
    [add],
  );

  /** À brancher sur `onDrop` (avec `onDragOver` qui appelle preventDefault). */
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const files = filesFromDataTransfer(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      add(files, 'drop');
    },
    [add],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  }, []);

  return { items, error, add, remove, reset, onPaste, onDrop, onDragOver };
}
