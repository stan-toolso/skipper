import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { useTheme } from '../lib/theme';
import { darkAppTheme, lightAppTheme } from '../lib/codemirrorTheme';

const languageSupport = new Map<string, Promise<Extension>>();
/** Mode de CodeMirror (Markdown par défaut), chargé une fois à la demande (comme les autres langages de l'explorateur de fichiers). */
function loadLanguage(name: string): Promise<Extension> {
  let support = languageSupport.get(name);
  if (!support) {
    const desc = LanguageDescription.matchLanguageName(languages, name, true);
    support = desc ? desc.load() : Promise.resolve([]);
    languageSupport.set(name, support);
  }
  return support;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Appelé sur Ctrl/Cmd + S. */
  onSave?: () => void;
  placeholder?: string;
  minHeight?: string;
  autoFocus?: boolean;
  /** Langage de coloration (nom CodeMirror, ex. « properties », « json ») ; défaut : Markdown. */
  language?: string;
}

/**
 * Éditeur de texte Markdown (CodeMirror) : coloration de la syntaxe, retour à la ligne automatique, sans gouttière,
 * accordé au thème de l'application. Sert aux instructions du contexte (le rendu se fait avec `Markdown`) et, avec un
 * autre langage, aux fichiers d'environnement d'un projet.
 */
export default function MarkdownEditor({ value, onChange, onSave, placeholder, minHeight = '320px', autoFocus, language: languageName = 'markdown' }: Props) {
  const uiTheme = useTheme();
  const [language, setLanguage] = useState<Extension | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadLanguage(languageName).then((ext) => {
      if (!cancelled) setLanguage(ext);
    });
    return () => {
      cancelled = true;
    };
  }, [languageName]);

  const extensions = useMemo<Extension[]>(() => {
    const list: Extension[] = [uiTheme === 'light' ? lightAppTheme : darkAppTheme, EditorView.lineWrapping];
    if (placeholder) list.push(cmPlaceholder(placeholder));
    if (onSave) {
      list.push(
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                onSave();
                return true;
              },
            },
          ]),
        ),
      );
    }
    if (language) list.push(language);
    return list;
  }, [language, onSave, placeholder, uiTheme]);

  return (
    <div className="md-editor">
      <CodeMirror
        value={value}
        minHeight={minHeight}
        theme={uiTheme === 'light' ? 'light' : oneDark}
        extensions={extensions}
        onChange={onChange}
        autoFocus={autoFocus}
        basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, bracketMatching: false, autocompletion: false, tabSize: 2 }}
      />
    </div>
  );
}
