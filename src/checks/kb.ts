import type { AgentRun, CheckedClaim, Claim } from '../schema';
import { catalogue } from '../catalogue';
import { contradicted, supported, unverifiable } from './util';

/** Hours, service area and address are checked against the catalogue, not a mood. */
export function checkKbFact(run: AgentRun, claim: Claim): CheckedClaim {
  const checker = 'kb';
  const fact = String(claim.normalized.fact ?? '');

  if (fact === 'hours') {
    const open = String(claim.normalized.open ?? '');
    const close = String(claim.normalized.close ?? '');

    // "We're closed on Sundays" carries no opening pair but is still checkable. The
    // extractor sometimes puts the word "closed" in the time fields, which is not a time.
    const isClock = (v: string) => /^\d{2}:\d{2}$/.test(v);
    if (!isClock(open) || !isClock(close)) {
      if (/\bsunday/i.test(claim.text)) {
        const saysClosed = /\bclosed\b/i.test(claim.text);
        const truth = catalogue.hours.sunday === 'closed';
        return saysClosed === truth
          ? supported(claim, checker, { checked: `catalogue hours.sunday -> ${catalogue.hours.sunday}`, catalogue_key: 'hours.sunday' })
          : contradicted(claim, checker, {
              checked: `catalogue hours.sunday -> ${catalogue.hours.sunday}`,
              catalogue_key: 'hours.sunday',
              reason: 'the agent said the opposite',
            });
      }
      return unverifiable(claim, checker, 'the claim stated no opening and closing time to compare');
    }

    const ok = open === catalogue.hours.open && close === catalogue.hours.close;
    const checked = `catalogue hours -> ${catalogue.hours.days} ${catalogue.hours.open}-${catalogue.hours.close}`;
    return ok
      ? supported(claim, checker, { checked, catalogue_key: 'hours' })
      : contradicted(claim, checker, {
          checked,
          catalogue_key: 'hours',
          reason: `agent said ${open}-${close}`,
        });
  }

  if (fact === 'service_area') {
    const postcode = String(claim.normalized.postcode ?? '');
    if (!/^\d{5}$/.test(postcode)) {
      return unverifiable(claim, checker, 'the claim named no postcode to check against the service area');
    }
    const ok = catalogue.service_area_postcodes.includes(postcode);
    const checked = `catalogue service_area_postcodes (${catalogue.service_area_postcodes.length} codes)`;
    return ok
      ? supported(claim, checker, { checked: `${checked} -> ${postcode} is covered`, catalogue_key: 'service_area_postcodes' })
      : contradicted(claim, checker, {
          checked,
          catalogue_key: 'service_area_postcodes',
          reason: `${postcode} is not in the service area`,
        });
  }

  if (fact === 'address') {
    const value = String(claim.normalized.value ?? '').replace(/\.$/, '').trim();
    if (value.length < 5) {
      return unverifiable(claim, checker, 'the claim stated no address to compare');
    }
    const truth = catalogue.address;
    const ok = truth.toLowerCase().startsWith(value.toLowerCase()) || value.toLowerCase().startsWith(truth.toLowerCase());
    const checked = `catalogue address -> ${truth}`;
    return ok
      ? supported(claim, checker, { checked, catalogue_key: 'address' })
      : contradicted(claim, checker, { checked, catalogue_key: 'address', reason: `agent said ${value}` });
  }

  return unverifiable(claim, checker, `no catalogue entry covers the fact "${fact || 'unknown'}"`);
}
