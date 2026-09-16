import type { AgentRun, CheckedClaim, Claim, RunVerdict } from '../schema';
import { checkBooking } from './booking';
import { checkKbFact } from './kb';
import { checkPrice } from './price';
import { checkPromise } from './promise';
import { checkTransfer } from './transfer';
import { unverifiable } from './util';

export { checkBooking, checkKbFact, checkPrice, checkPromise, checkTransfer };

/** One claim in, one verdict out, always with the evidence it was checked against. */
export function checkClaim(run: AgentRun, claim: Claim): CheckedClaim {
  switch (claim.kind) {
    case 'booking':
      return checkBooking(run, claim);
    case 'price':
      return checkPrice(run, claim);
    case 'transfer':
      return checkTransfer(run, claim);
    case 'kb_fact':
      return checkKbFact(run, claim);
    case 'promise':
      return checkPromise(run, claim);
    default:
      return unverifiable(claim, 'none', 'no deterministic checker covers this kind of claim');
  }
}

export function runChecks(run: AgentRun, claims: Claim[]): CheckedClaim[] {
  return claims.map((claim) => checkClaim(run, claim));
}

/** B6 step 4. CONTRADICTED beats everything; high-risk unknowns go to a human. */
export function runVerdict(claims: CheckedClaim[]): RunVerdict {
  if (claims.some((c) => c.verdict === 'CONTRADICTED')) return 'FAIL';
  if (claims.some((c) => c.verdict === 'UNVERIFIABLE' && c.risk === 'high')) return 'NEEDS_HUMAN';
  return 'PASS';
}
