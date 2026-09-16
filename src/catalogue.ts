import catalogueJson from '../seed/catalogue.json';
import type { Catalogue, CatalogueService } from './schema';

/**
 * The ground truth the checkers compare claims against. Fictional company,
 * committed to the repo so the eval is reproducible by anyone.
 */
export const catalogue = catalogueJson as Catalogue;

export function serviceByKey(key: string | null | undefined): CatalogueService | null {
  if (!key) return null;
  return catalogue.services.find((s) => s.key === key) ?? null;
}

/** Longest alias first, so "water heater installation" wins over "water heater". */
export function serviceFromText(text: string): CatalogueService | null {
  const lower = text.toLowerCase();
  let best: { service: CatalogueService; len: number } | null = null;
  for (const service of catalogue.services) {
    for (const alias of [service.label, ...service.aliases]) {
      const a = alias.toLowerCase();
      if (lower.includes(a) && (!best || a.length > best.len)) {
        best = { service, len: a.length };
      }
    }
  }
  return best ? best.service : null;
}
