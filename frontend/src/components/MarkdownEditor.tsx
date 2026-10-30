import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { useTheme } from '../lib/theme';
import { darkAppTheme, lightAppTheme } from '../lib/codemirrorTheme';

let markdownSupport: Promise<Extension> | null = null;
/** Mode Markdown de CodeMirror, chargé une fois à la demande (comme les autres langages de l'explorateur de fichiers). */
function loadMarkdown(): Promise<Extension> {
  if (!markdownSupport) {
    const desc = LanguageDescription.matchLanguageName(languages, 'markdown', true);
    markdownSupport = desc ? desc.load() : Promise.resolve([]);
  }
  return markdownSupport;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Appelé sur Ctrl/Cmd + S. */
  onSave?: () => void;
  placeholder?: string;
  minHeight?: string;
  autoFocus?: boolean;
}

/**
 * Éditeur de texte Markdown (CodeMirror) : coloration de la syntaxe, retour à la ligne automatique, sans gouttière,
 * accordé au thème de l'application. Sert aux instructions du contexte ; le rendu se fait avec `Markdown`.
 */
export default function MarkdownEditor({ value, onChange, onSave, placeholder, minHeight = '320px', autoFocus }: Props) {
  const uiTheme = useTheme();
  const [language, setLanguage] = useState<Extension | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadMarkdown().then((ext) => {
      if (!cancelled) setLanguage(ext);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
