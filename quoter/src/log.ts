/** JSON-lines logger. Every line passes through redaction; secrets never reach stdout or files. */
export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const secrets = new Set<string>();
/** Register a runtime secret (keys, proxy passwords, API secrets) so it is masked wherever it appears. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) secrets.add(value);
}

const PATTERNS: [RegExp, string][] = [
  [/\b(https?|socks5h?):\/\/[^\s:@/]+:[^\s@/]+@/gi, '$1://***:***@'],
  [/0x[0-9a-fA-F]{64}\b/g, '0x<redacted-key>'],
  [/("?(?:secret|private_?key|privateKey|password|sig|polymarket-secret)"?\s*[:=]\s*)"[^"]*"/gi, '$1"<redacted>"'],
];
export function redact(text: string): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join('<redacted>');
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/** Observers of already-redacted log lines (the dashboard alert feed). */
const listeners = new Set<(line: string, level: Level) => void>();
export function onLog(listener: (line: string, level: Level) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(options: { level?: Level; scope?: string; sink?: (line: string) => void; now?: () => number } = {}): Logger {
  const min = ORDER[options.level ?? 'info'];
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = options.now ?? Date.now;
  const write = (scope: string | undefined, level: Level, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    let line: string;
    try { line = JSON.stringify({ t: new Date(now()).toISOString(), level, scope, msg, ...data }, (_key, value) => typeof value === 'bigint' ? value.toString() : value instanceof Error ? value.message : value); }
    catch { line = JSON.stringify({ t: new Date(now()).toISOString(), level, scope, msg }); }
    const redacted = redact(line);
    sink(redacted);
    for (const listener of listeners) { try { listener(redacted, level); } catch { /* a listener never breaks logging */ } }
  };
  const make = (scope: string | undefined): Logger => ({
    debug: (msg, data) => write(scope, 'debug', msg, data),
    info: (msg, data) => write(scope, 'info', msg, data),
    warn: (msg, data) => write(scope, 'warn', msg, data),
    error: (msg, data) => write(scope, 'error', msg, data),
    child: (name) => make(scope ? `${scope}.${name}` : name),
  });
  return make(options.scope);
}

export const errorText = (error: unknown): string => redact(error instanceof Error ? error.message : String(error));
