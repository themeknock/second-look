import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Loads .dev.vars into process.env so `npm test` picks the key up locally. Never logged. */
export function loadDevVars(file = join(process.cwd(), '.dev.vars')): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
