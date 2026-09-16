import type { Context, Next } from 'hono';
import type { Env } from './env';

/**
 * One bearer key. No orgs, no billing, no user table - this is single-tenant on purpose.
 * Everything except the dashboard, /metrics and the public view of a seed run needs it.
 */
export function bearerAuth() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const expected = c.env.INGEST_KEY;
    if (!expected) return c.json({ error: 'server', detail: 'INGEST_KEY is not configured' }, 500);
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!timingSafeEqual(token, expected)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
