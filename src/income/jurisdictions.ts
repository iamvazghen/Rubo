/**
 * Tax rules on investment income, one entry per country of residence.
 *
 * To support another country, add an entry here (and a test). Until then an
 * owner anywhere can still describe their own rules without code, through the
 * profile options `flat_rate`, `allowance` and `credit_cap_rate` - see
 * `customJurisdiction`. With neither, Rubo models source withholding only and
 * says so on every figure.
 */

export interface TaxOptions {
  [key: string]: number | undefined;
}

export interface Jurisdiction {
  code: string;
  name: string;
  /** Currency the allowance is expressed in. */
  currency: string;
  /** Word used in messages, e.g. "German tax". */
  label: string;
  /** Tax-free amount per calendar year. */
  allowance(filing: 'single' | 'joint', options: TaxOptions): number;
  /** Largest share of the gross payment for which foreign withholding is credited. */
  creditCapRate: number;
  /** Share of fund distributions/gains that is tax-exempt, in percent (e.g. DE Teilfreistellung). */
  fundExemptionPct: number;
  /** A broker in this country withholds this tax at payment (else it is due with the return). */
  brokerWithholds: boolean;
  /** A domestic broker applies the allowance assigned to it (like a Freistellungsauftrag). */
  brokerAppliesAllowance: boolean;
  /** Withholding a resident gets at source without a reclaim, by issuer country, where below statutory. */
  treatyAtSource: Record<string, number>;
  /** Tax on `base` (after exemptions and allowance), with `credit` of foreign tax creditable. */
  tax(p: { base: number; credit: number; options: TaxOptions }): number;
  /** Settings this jurisdiction reads from the profile options, for /tax to explain. */
  optionHelp: Record<string, string>;
}

const germany: Jurisdiction = {
  code: 'DE',
  name: 'Germany',
  currency: 'EUR',
  label: 'German tax',
  allowance: (filing) => (filing === 'joint' ? 2000 : 1000),
  creditCapRate: 0.15,
  fundExemptionPct: 30,
  brokerWithholds: true,
  brokerAppliesAllowance: true,
  treatyAtSource: { US: 0.15, NL: 0.15, JP: 0.15315 },
  // Abgeltungsteuer: KapESt = (e - 4q) / (4 + k), then Soli 5.5 % and church tax k on top (§ 32d EStG).
  tax: ({ base, credit, options }) => {
    const k = options.church_tax_rate ?? 0;
    const kapest = Math.max(0, (base - 4 * credit) / (4 + k));
    return kapest * (1 + 0.055 + k);
  },
  optionHelp: { church_tax_rate: 'church tax: 0, 0.08 (Bavaria, Baden-Württemberg) or 0.09 (other states)' },
};

const austria: Jurisdiction = {
  code: 'AT',
  name: 'Austria',
  currency: 'EUR',
  label: 'Austrian KESt',
  allowance: () => 0,
  creditCapRate: 0.15,
  fundExemptionPct: 0,
  brokerWithholds: true,
  brokerAppliesAllowance: false,
  treatyAtSource: { US: 0.15 },
  // KESt 27.5 %, foreign withholding credited up to 15 %.
  tax: ({ base, credit }) => Math.max(0, base * 0.275 - credit),
  optionHelp: {},
};

export const JURISDICTIONS: Record<string, Jurisdiction> = { DE: germany, AT: austria };

/**
 * An owner's own flat rules, for a country Rubo has no entry for:
 * `/tax set flat_rate 0.2`, `/tax set allowance 500`, `/tax set credit_cap_rate 0.15`.
 */
export function customJurisdiction(residence: string, options: TaxOptions): Jurisdiction | null {
  if (options.flat_rate == null) return null;
  const rate = options.flat_rate;
  return {
    code: residence,
    name: 'your own rules',
    // Own rules are written in the base currency.
    currency: 'BASE',
    label: `${residence} tax`,
    allowance: () => options.allowance ?? 0,
    creditCapRate: options.credit_cap_rate ?? 0,
    fundExemptionPct: options.fund_exemption_pct ?? 0,
    brokerWithholds: Boolean(options.broker_withholds),
    brokerAppliesAllowance: false,
    treatyAtSource: {},
    tax: ({ base, credit }) => Math.max(0, base * rate - credit),
    optionHelp: {},
  };
}

export function jurisdictionFor(residence: string | null, options: TaxOptions): Jurisdiction | null {
  if (!residence) return null;
  return JURISDICTIONS[residence] ?? customJurisdiction(residence, options);
}
