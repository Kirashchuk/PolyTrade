/**
 * Order-placement jurisdiction gate.
 * Source: https://docs.polymarket.com/api-reference/perps/geographic-restrictions (read 2026-10-19).
 * The operator declares where they physically are. Egress through a proxy does not change that
 * jurisdiction, so the gate never looks at the proxy location. Read-only market data is unrestricted.
 */
export const GEO_SOURCE = 'https://docs.polymarket.com/api-reference/perps/geographic-restrictions';
const COUNTRIES: Record<string, string> = { US: 'United States', CA: 'Canada', CU: 'Cuba', IR: 'Iran', KP: 'North Korea', SY: 'Syria' };
const REGIONS: Record<string, string> = { 'UA-43': 'Crimea', 'UA-40': 'Sevastopol (Crimea)', 'UA-14': 'Donetsk', 'UA-09': 'Luhansk' };
/** Countries that contain a restricted subdivision: the region must then be declared explicitly. */
const REGION_REQUIRED = new Set(['UA']);

export interface Jurisdiction { country: string; region: string; }

export function assertOrderPlacementAllowed(jurisdiction: Jurisdiction): void {
  const country = jurisdiction.country.trim().toUpperCase();
  const region = jurisdiction.region.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('Live mode requires operator.jurisdiction: the ISO 3166-1 code of the country where you physically operate the bot (e.g. "UA")');
  if (COUNTRIES[country]) throw new Error(`Order placement is not permitted from ${COUNTRIES[country]} (${GEO_SOURCE})`);
  if (REGION_REQUIRED.has(country) && !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(region)) throw new Error(`operator.region (ISO 3166-2, e.g. "UA-30") is required for ${country}: some of its regions are restricted`);
  if (region && !region.startsWith(`${country}-`)) throw new Error('operator.region must belong to operator.jurisdiction');
  if (REGIONS[region]) throw new Error(`Order placement is not permitted from ${REGIONS[region]} (${GEO_SOURCE})`);
}
