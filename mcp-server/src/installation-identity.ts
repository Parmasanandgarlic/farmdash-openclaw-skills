import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Returns an analytics-only ID; persistence is isolated to this one file. */
export function getInstallationId(options: { env?: NodeJS.ProcessEnv; filePath?: string } = {}): string | undefined {
  const env = options.env ?? process.env;
  const override = env.FARMDASH_INSTALLATION_ID;
  if (typeof override === 'string' && UUID_V4.test(override)) return override.toLowerCase();
  const filePath = options.filePath ?? join(env.LOCALAPPDATA || env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'farmdash', 'installation-id');
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8').trim();
      return UUID_V4.test(existing) ? existing.toLowerCase() : undefined;
    }
    const id = randomUUID();
    try {
      writeFileSync(filePath, id, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return id;
    } catch {
      if (existsSync(filePath)) {
        const winner = readFileSync(filePath, 'utf8').trim();
        if (UUID_V4.test(winner)) return winner.toLowerCase();
      }
      return undefined;
    }
  } catch {
    return undefined;
  }
}
