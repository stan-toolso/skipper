import { EditorView } from '@codemirror/view';

/**
 * Accorde CodeMirror au thème de l'application (deux palettes, choisies selon `useTheme()`).
 * Les couleurs sont figées ici plutôt qu'en variables `--cc-*` : CodeMirror injecte ses propres feuilles de style,
 * et ces valeurs reprennent celles de theme.css (fonds, bordures, accent) pour chacun des deux thèmes.
 */
export const darkAppTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#141414', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', lineHeight: '1.5' },
    '.cm-gutters': { backgroundColor: '#141414', borderRight: '1px solid #262626' },
    '.cm-activeLineGutter': { backgroundColor: '#1a1a1a' },
    '.cm-activeLine': { backgroundColor: '#1a1a1a' },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#d97757' },
    '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(217, 119, 87, 0.3)' },
    '.cm-placeholder': { color: '#5c5c5c' },
  },
  { dark: true },
);

export const lightAppTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#ffffff', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', lineHeight: '1.5' },
    '.cm-gutters': { backgroundColor: '#f6f7f8', borderRight: '1px solid #d5d9dd', color: '#8a9097' },
    '.cm-activeLineGutter': { backgroundColor: '#eceef0' },
    '.cm-activeLine': { backgroundColor: '#f6f7f8' },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#b85c3a' },
    '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(184, 92, 58, 0.25)' },
    '.cm-placeholder': { color: '#8a9097' },
  },
  { dark: false },
);
