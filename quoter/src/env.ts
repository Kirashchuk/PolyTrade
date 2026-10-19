import { existsSync, readFileSync } from 'node:fs';

/** Keys `quoter/.env` may contain. Wallet and Polymarket proxy keys are refused: export them in the shell. */
const FILE_KEYS = new Set(['QUOTER_EGRESS_PROXIES', 'QUOTER_CONFIG', 'QUOTER_LOG_LEVEL']);
const SECRET = /PRIVATE_KEY|SECRET|MNEMONIC|SEED/i;

/**
 * Scripts run with `bun --no-env-file`, so Bun does not import arbitrary files into the environment.
 * This loader reads only the allow-listed, non-wallet keys. Values already exported in the shell win.
 */
export function loadEnv(path: string, processEnv: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  if (existsSync(path)) {
    for (const [index, raw] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) throw new Error(`${path}:${index + 1}: expected KEY=value`);
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (SECRET.test(key)) throw new Error(`${path}: ${key} must not be stored in a file. Export it in the shell for the process lifetime.`);
      if (!FILE_KEYS.has(key)) throw new Error(`${path}:${index + 1}: unsupported key ${key}`);
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(processEnv)) if (value !== undefined) merged[key] = value;
  return merged;
}
