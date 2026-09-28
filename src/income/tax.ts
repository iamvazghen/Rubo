/**
 * Tax on investment income and gains, for whoever runs Rubo.
 *
 * Every figure is an estimate and is labelled as one. Amounts are in the
 * owner's base currency (`/setup currency`). What is modelled:
 *   - Source-country withholding, from the ISIN's country prefix, at the
 *     statutory rate or the treaty rate the residence country gets at source.
 *     US withholding for non-US residents depends on a W-8BEN (15 % vs 30 %).
 *     IE/LU-domiciled funds pay distributions gross.
 *   - Residence-country tax from `jurisdictions.ts` (built-in rules, or the
 *     owner's own flat rules), with foreign tax credited up to the cap, the
 *     annual allowance and any fund exemption. Where a domestic broker withholds,
 *     the tax is taken at payment; otherwise it is due with the return and is
 *     set aside before the owner's plan is applied.
 *   - No residence set, or no rules for it: withholding only, said on every figure.
 */
import { jurisdictionFor, type Jurisdiction, type TaxOptions } from './jurisdictions.js';

export interface AccountTax {
  /** Broker id from brokers.ts, when known. */
  broker?: string;
  /** The broker is in the owner's residence country (it may withhold residence tax). */
  domestic: boolean;
  /** US W-8BEN on file with this broker (non-US residents: US withholding 15 % instead of 30 %). */
  w8ben: boolean;
  /** Part of the annual allowance assigned to this broker (e.g. a German Freistellungsauftrag), in the jurisdiction's currency. */
  allowance_assigned: number;
}

export interface TaxProfile {
  /** ISO country of tax residence; null until the owner sets it. */
  residence: string | null;
  filing: 'single' | 'joint';
  /** Jurisdiction-specific settings (church_tax_rate) or the owner's own rules (flat_rate, allowance, credit_cap_rate). */
  options: TaxOptions;
  accounts: Record<string, AccountTax>;
  /** When the owner last reviewed these settings. */
  confirmed_at: string | null;
}

/** Nothing assumed: residence unknown, no accounts until the first import. */
export const EMPTY_TAX_PROFILE: TaxProfile = { residence: null, filing: 'single', options: {}, accounts: {}, confirmed_at: null };

/** Statutory withholding on dividends paid to a non-resident, by issuer country. */
const WITHHOLDING: Record<string, number> = {
  US: 0.3, CA: 0.25, CH: 0.35, FR: 0.25, NL: 0.15, GB: 0, IE: 0.25, LU: 0.15, DE: 0.26375,
  ES: 0.19, IT: 0.26, DK: 0.27, NO: 0.25, SE: 0.3, FI: 0.35, BE: 0.3, AT: 0.275,
  AU: 0.3, JP: 0.15315, HK: 0, SG: 0,
};

export function issuerCountry(isin?: string): string | undefined {
  return isin && /^[A-Z]{2}/.test(isin) ? isin.slice(0, 2) : undefined;
}

export function withholdingRate(p: {
  isin?: string;
  assetType?: string;
  residence: string | null;
  account: AccountTax;
  jurisdiction: Jurisdiction | null;
}): { rate: number; country?: string; note?: string } {
  const country = issuerCountry(p.isin);
  if (!country) return { rate: 0, note: 'no ISIN, so the issuer country and its withholding are unknown' };
  if (country === p.residence) return { rate: 0, country };
  if (p.assetType === 'etf' && (country === 'IE' || country === 'LU')) {
    return { rate: 0, country, note: `${country}-domiciled fund: distributions are paid gross` };
  }
  if (country === 'US') return { rate: p.account.w8ben ? 0.15 : 0.3, country, note: p.account.w8ben ? 'W-8BEN on file' : 'no W-8BEN: 30 % US withholding' };
  const statutory = WITHHOLDING[country];
  if (statutory == null) return { rate: 0, country, note: `withholding for ${country} is not in the table` };
  const treaty = p.jurisdiction?.treatyAtSource[country];
  const rate = treaty != null ? Math.min(treaty, statutory) : statutory;
  return { rate, country, note: rate > 0.15 ? `${Math.round(rate * 1000) / 10} % at source; the part above the treaty rate may be reclaimable` : undefined };
}

export interface TaxBreakdown {
  gross: number;
  withholding_rate: number;
  withholding: number;
  /** What actually arrives in the account on the pay date. */
  received: number;
  /** Residence-country tax: withheld by a domestic broker, or due later with the return. */
  residence_tax: number;
  residence_tax_label: string;
  residence_tax_settled: 'at_payment' | 'with_tax_return' | 'not_modelled';
  allowance_used: number;
  /** Money that is really the owner's to plan with: received minus any tax still due. */
  net: number;
  notes: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Tax on one payment, all amounts in the base currency.
 * `allowanceLeft`: what remains usable for THIS account, in the jurisdiction's currency.
 * `basePerAllowanceUnit`: base currency per unit of that currency.
 */
export function taxOnPayment(p: {
  gross: number;
  isin?: string;
  assetType?: string;
  partialExemptionPct?: number;
  account: AccountTax;
  profile: TaxProfile;
  allowanceLeft: number;
  basePerAllowanceUnit: number;
}): TaxBreakdown {
  const notes: string[] = [];
  const j = jurisdictionFor(p.profile.residence, p.profile.options);
  const wht = withholdingRate({ isin: p.isin, assetType: p.assetType, residence: p.profile.residence, account: p.account, jurisdiction: j });
  if (wht.note) notes.push(wht.note);
  const withholding = p.gross * wht.rate;
  const received = p.gross - withholding;

  if (!j) {
    notes.push(p.profile.residence
      ? `no tax rules for ${p.profile.residence}: set your own with /tax set flat_rate …, or add them to jurisdictions.ts`
      : 'tax residence not set (/tax set residence XX): only withholding at source is shown');
    return {
      gross: round2(p.gross), withholding_rate: wht.rate, withholding: round2(withholding), received: round2(received),
      residence_tax: 0, residence_tax_label: 'tax', residence_tax_settled: 'not_modelled', allowance_used: 0, net: round2(received), notes,
    };
  }

  const exemption = p.assetType === 'etf' ? (p.partialExemptionPct ?? j.fundExemptionPct) / 100 : 0;
  if (exemption > 0) notes.push(`${Math.round(exemption * 100)} % of fund income is tax-exempt`);
  const taxable = p.gross * (1 - exemption);
  const allowanceUsed = Math.min(taxable, Math.max(0, p.allowanceLeft) * p.basePerAllowanceUnit);
  const credit = Math.min(withholding, p.gross * j.creditCapRate);
  const residenceTax = j.tax({ base: taxable - allowanceUsed, credit, options: p.profile.options });
  const atPayment = p.account.domestic && j.brokerWithholds;
  if (allowanceUsed > 0) notes.push(`tax-free allowance covers ${round2(allowanceUsed)}`);
  if (!atPayment && residenceTax > 0) notes.push(`${j.label} is due with your return and is set aside`);

  return {
    gross: round2(p.gross),
    withholding_rate: wht.rate,
    withholding: round2(withholding),
    received: round2(atPayment ? received - residenceTax : received),
    residence_tax: round2(residenceTax),
    residence_tax_label: j.label,
    residence_tax_settled: atPayment ? 'at_payment' : 'with_tax_return',
    allowance_used: round2(allowanceUsed),
    net: round2(received - residenceTax),
    notes,
  };
}

/** Tax on a realised gain (a sale): no withholding; fund exemption applies. Losses are not offset. */
export function capitalGainsTax(p: {
  gain: number;
  assetType?: string;
  partialExemptionPct?: number;
  profile: TaxProfile;
  allowanceLeft: number;
  basePerAllowanceUnit: number;
}): { tax: number; allowance_used: number } {
  const j = jurisdictionFor(p.profile.residence, p.profile.options);
  if (p.gain <= 0 || !j) return { tax: 0, allowance_used: 0 };
  const exemption = p.assetType === 'etf' ? (p.partialExemptionPct ?? j.fundExemptionPct) / 100 : 0;
  const taxable = p.gain * (1 - exemption);
  const allowanceUsed = Math.min(taxable, Math.max(0, p.allowanceLeft) * p.basePerAllowanceUnit);
  return { tax: round2(j.tax({ base: taxable - allowanceUsed, credit: 0, options: p.profile.options })), allowance_used: round2(allowanceUsed) };
}
