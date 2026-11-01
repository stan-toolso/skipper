import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Dictée vocale par la reconnaissance de la parole du navigateur (Web Speech API : Chrome, Edge, Safari macOS et iOS ;
 * absente de Firefox). Rien ne passe par le serveur de Skipper : le navigateur transcrit (Chrome envoie le son à son
 * propre service), et le texte reconnu s'insère au fil de la parole dans la zone de saisie, après ce qui y était déjà.
 */

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const dictationSupported = () => recognitionCtor() !== null;

/** Texte de la saisie pendant la dictée : ce qui y était au départ, puis la transcription (séparés par une espace). */
export function withTranscript(base: string, transcript: string): string {
  const said = transcript.replace(/\s+/g, ' ').trim();
  if (!said) return base;
  if (!base) return said.charAt(0).toUpperCase() + said.slice(1);
  return /\s$/.test(base) ? base + said : `${base} ${said}`;
}

/** Transcription complète d'une liste de résultats (définitifs puis provisoires), dans l'ordre. */
export function joinResults(results: ArrayLike<RecognitionResult>): string {
  let text = '';
  for (let i = 0; i < results.length; i++) text += `${results[i][0].transcript} `;
  return text;
}

const ERRORS: Record<string, string> = {
  'not-allowed': "Micro refusé : autorisez-le pour ce site dans les réglages du navigateur.",
  'service-not-allowed': "La reconnaissance vocale n'est pas autorisée sur cet appareil.",
  'audio-capture': 'Aucun micro détecté.',
  network: 'La reconnaissance vocale a besoin du réseau.',
};

/**
 * Dictée dans une zone de saisie : `getText` lit le texte au début de la dictée, `setText` reçoit le texte complet à
 * chaque mot reconnu. `toggle` démarre ou arrête ; la dictée s'arrête seule après un silence prolongé.
 */
export function useDictation(getText: () => string, setText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const setRef = useRef(setText);
  setRef.current = setText;

  const stop = useCallback(() => rec.current?.stop(), []);

  const toggle = useCallback(() => {
    if (rec.current) {
      rec.current.stop();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = navigator.language || 'fr-FR';
    r.continuous = true;
    r.interimResults = true;
    const base = getText();
    r.onresult = (e) => setRef.current(withTranscript(base, joinResults(e.results)));
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') setError(ERRORS[e.error] ?? `Dictée interrompue (${e.error}).`);
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    setError(null);
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
    }
  }, [getText]);

  // Quitter la page (ou démonter la saisie) coupe le micro.
  useEffect(() => () => rec.current?.abort(), []);

  return { supported: dictationSupported(), listening, error, toggle, stop };
}
