import { inspect } from 'node:util';
import { config, type LogLevel } from './config.js';

/**
 * Journal du backend : une ligne par message, horodatage ISO, niveau, puis le message avec son préfixe
 * de module (`[sessions] …`). Les niveaux sous `LOG_LEVEL` (défaut : info) sont tus. `debug` et `info`
 * vont sur la sortie standard, `warn` et `error` sur la sortie d'erreur (pm2 les sépare dans deux fichiers).
 *
 * Arguments supplémentaires : une `Error` donne `Nom : message`, avec sa trace seulement au niveau `error` ;
 * tout autre objet est inspecté sur une seule ligne.
 */

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LABEL: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

let threshold: LogLevel = config.logLevel;

/** Destinations, remplaçables dans les tests. */
export const logOutput = {
  stdout: (line: string) => void process.stdout.write(`${line}\n`),
  stderr: (line: string) => void process.stderr.write(`${line}\n`),
};

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function getLogLevel(): LogLevel {
  return threshold;
}

export const isLogLevelEnabled = (level: LogLevel): boolean => ORDER[level] >= ORDER[threshold];

function formatArg(value: unknown, level: LogLevel): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    const head = value.message ? `${value.name} : ${value.message}` : value.name;
    if (level !== 'error' || !value.stack) return head;
    // La première ligne de la trace répète « Nom: message » : on garde les lignes « at … » seulement.
    const trace = value.stack.split('\n').slice(1).filter((l) => l.trim());
    return trace.length ? `${head}\n${trace.join('\n')}` : head;
  }
  if (value === undefined) return 'undefined';
  return inspect(value, { depth: 4, breakLength: Infinity, compact: true });
}

/** Ligne complète d'un message (sans saut de ligne final). */
export function formatLine(level: LogLevel, args: unknown[], at: Date = new Date()): string {
  const text = args.map((a) => formatArg(a, level)).join(' ');
  return `${at.toISOString()} ${LABEL[level]} ${text}`;
}

function emit(level: LogLevel, args: unknown[]): void {
  if (!isLogLevelEnabled(level)) return;
  const line = formatLine(level, args);
  if (level === 'warn' || level === 'error') logOutput.stderr(line);
  else logOutput.stdout(line);
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Journal sans préfixe : `log.info('[module] message')`. */
export const log: Logger = {
  debug: (...args) => emit('debug', args),
  info: (...args) => emit('info', args),
  warn: (...args) => emit('warn', args),
  error: (...args) => emit('error', args),
};

/** Journal d'un module : le préfixe `[module]` est ajouté à chaque message. */
export function createLogger(module: string): Logger {
  const prefix = `[${module}]`;
  return {
    debug: (...args) => emit('debug', [prefix, ...args]),
    info: (...args) => emit('info', [prefix, ...args]),
    warn: (...args) => emit('warn', [prefix, ...args]),
    error: (...args) => emit('error', [prefix, ...args]),
  };
}

/** Avertissements Node attendus par conception, journalisés une seule fois en `info` au lieu d'une pile en `warn`. */
const EXPECTED_WARNINGS: Record<string, string> = {
  // Le SDK Claude signale que `canUseTool` n'est pas consulté pour les outils pré-autorisés (serveurs MCP internes)
  // ni en mode bypassPermissions : c'est voulu, et répété à chaque session.
  CLAUDE_SDK_CAN_USE_TOOL_SHADOWED: 'SDK Claude',
};

/**
 * Remplace le gestionnaire par défaut des avertissements de Node (trace multi-ligne, conseil `--trace-warnings`)
 * par une ligne de journal, et ne journalise qu'une fois les avertissements attendus.
 */
export function captureProcessWarnings(): void {
  const seen = new Set<string>();
  process.removeAllListeners('warning');
  process.on('warning', (warning: Error & { code?: string }) => {
    const code = warning.code;
    if (code && code in EXPECTED_WARNINGS) {
      if (seen.has(code)) return;
      seen.add(code);
      log.info(`[node] avertissement attendu du ${EXPECTED_WARNINGS[code]} (${code}, affiché une seule fois) : ${warning.message}`);
      return;
    }
    log.warn(`[node] ${warning.name}${code ? ` (${code})` : ''} : ${warning.message}`);
  });
}
