import type { AgentRun, CheckedClaim, Claim } from '../schema';
import { serviceByKey } from '../catalogue';
import { contradicted, eventsBefore, nameMatches, resultObject, supported, turnTs, unverifiable } from './util';

export const PRICE_TOOLS = ['get_price', 'price', 'quote'];

/** A stated price is checked against a get_price result first, then the catalogue. */
export function checkPrice(run: AgentRun, claim: Claim): CheckedClaim {
  const checker = 'price';
  const amount = typeof claim.normalized.amount === 'number' ? claim.normalized.amount : null;
  if (amount === null) {
    return unverifiable(claim, checker, 'the claim did not state an amount to check');
  }

  const ts = turnTs(run, claim.turn_index);
  const priceResults = eventsBefore(run, ts).filter(
    ({ event }) => event.type === 'tool.result' && nameMatches(event, PRICE_TOOLS),
  );

  const serviceKey = typeof claim.normalized.service === 'string' ? claim.normalized.service : null;

  if (serviceKey) {
    const fromTool = priceResults.find(({ event }) => String(resultObject(event).service ?? '') === serviceKey);
    if (fromTool) {
      const quoted = Number(resultObject(fromTool.event).amount);
      return quoted === amount
        ? supported(claim, checker, {
            checked: `tool.result get_price -> ${serviceKey} $${quoted}`,
            event_index: fromTool.index,
          })
        : contradicted(claim, checker, {
            checked: `tool.result get_price -> ${serviceKey} $${quoted}`,
            event_index: fromTool.index,
            reason: `agent said $${amount}, the tool returned $${quoted}`,
          });
    }

    const service = serviceByKey(serviceKey);
    if (service) {
      return service.price === amount
        ? supported(claim, checker, {
            checked: `catalogue ${service.key} -> $${service.price}`,
            catalogue_key: service.key,
          })
        : contradicted(claim, checker, {
            checked: `catalogue ${service.key} -> $${service.price}`,
            catalogue_key: service.key,
            reason: `agent said $${amount}, the catalogue says $${service.price}`,
          });
    }
  }

  if (priceResults.length > 0) {
    const match = priceResults.find(({ event }) => Number(resultObject(event).amount) === amount);
    if (match) {
      const r = resultObject(match.event);
      return supported(claim, checker, {
        checked: `tool.result get_price -> ${r.service} $${r.amount}`,
        event_index: match.index,
      });
    }
    const last = priceResults[priceResults.length - 1];
    const r = resultObject(last.event);
    return contradicted(claim, checker, {
      checked: `tool.result get_price -> ${r.service} $${r.amount}`,
      event_index: last.index,
      reason: `agent said $${amount}, no price result in this run returned that amount`,
    });
  }

  return unverifiable(claim, checker, 'the claim named no catalogue service and the run has no price tool result');
}
