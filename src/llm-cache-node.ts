import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CacheableRequest, LlmCache, LlmUsage } from './llm';

/**
 * Node-only file cache. Keyed on the full prompt, so changing a prompt invalidates it.
 * Stores the usage the original call reported, so a cached eval still prints the real
 * cost of producing those numbers rather than zero.
 */
const CACHE_DIR = join(process.cwd(), '.llm-cache');

function keyFor(req: CacheableRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([req.provider, req.model, 'no-reasoning', req.system, req.user, req.schema_name, req.schema]))
    .digest('hex')
    .slice(0, 32);
}

export const fileCache: LlmCache = {
  get<T>(req: CacheableRequest): { data: T; usage: LlmUsage } | null {
    const file = join(CACHE_DIR, `${keyFor(req)}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  },
  set(req: CacheableRequest, value: { data: unknown; usage: LlmUsage }): void {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${keyFor(req)}.json`), JSON.stringify(value));
  },
};
