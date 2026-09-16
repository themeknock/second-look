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
    const truth = catalogue.address;
    const ok = truth.toLowerCase().startsWith(value.toLowerCase()) || value.toLowerCase().startsWith(truth.toLowerCase());
    const checked = `catalogue address -> ${truth}`;
    return ok
      ? supported(claim, checker, { checked, catalogue_key: 'address' })
      : contradicted(claim, checker, { checked, catalogue_key: 'address', reason: `agent said ${value}` });
  }

  return unverifiable(claim, checker, `no catalogue entry covers the fact "${fact || 'unknown'}"`);
}
