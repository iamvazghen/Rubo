/**
 * Tax on investment income, per jurisdiction and per account.
 *
 * Every figure is an estimate and is labelled as one. What is modelled:
 *   - Source-country withholding, from the ISIN's country prefix. US rate
 *     depends on whether a W-8BEN is on file (15 % vs 30 %). Funds domiciled in
 *     IE/LU pay distributions gross.
 *   - German residents: Abgeltungsteuer 25 % + Soli 5.5 % (+ church tax 8/9 %),
 *     foreign withholding credited up to 15 % of gross, the Sparerpauschbetrag
 *     (EUR 1,000 single / 2,000 joint) and the Teilfreistellung for funds.
 *     A German broker (Trade Republic) withholds this at payment and applies the
 *     Freistellungsauftrag; a foreign broker (IBKR) withholds nothing German, the
 *     tax is due with the return (Anlage KAP), so it is set aside instead.
 *   - Other residences: withholding only, flagged as not modelled further.
 * Not modelled: Vorabpauschale on accumulating funds, reclaims above treaty
 * rates, losses carried in the Verlustverrechnungstopf.
 */

export interface AccountTax {
  /** A broker in the residence country withholds residence-country tax itself. */
  domestic: boolean;
  /** US W-8BEN on file with this broker (lowers US withholding to 15 %). */
  w8ben: boolean;
  /** Germany: Freistellungsauftrag assigned to this broker, EUR. */
  exemption_order_eur: number;
}

export interface TaxProfile {
  /** ISO country of tax residence. */
  residence: string;
  filing: 'single' | 'joint';
  /** Church tax rate: 0, 0.08 (BY, BW) or 0.09 (other German states). */
  church_tax_rate: number;
  accounts: Record<string, AccountTax>;
  /** When the owner last confirmed these settings; null = still the defaults. */
  confirmed_at: string | null;
}

/** Defaults for the owner: resident in Köln (NRW), two brokers. Change with /tax. */
export const DEFAULT_TAX_PROFILE: TaxProfile = {
  residence: 'DE',
  filing: 'single',
  church_tax_rate: 0,
  accounts: {
    // Trade Republic files the W-8BEN at account opening; IBKR asks for it in the application.
    traderepublic: { domestic: true, w8ben: true, exemption_order_eur: 1000 },
    ibkr: { domestic: false, w8ben: true, exemption_order_eur: 0 },
  },
  confirmed_at: null,
};

export const ALLOWANCE_EUR = { single: 1000, joint: 2000 } as const;

/** Statutory withholding on dividends paid to a non-resident, by issuer country. */
const WITHHOLDING: Record<string, number> = {
  US: 0.3, CA: 0.25, CH: 0.35, FR: 0.25, NL: 0.15, GB: 0, IE: 0.25, LU: 0.15, DE: 0,
  ES: 0.19, IT: 0.26, DK: 0.27, NO: 0.25, SE: 0.3, FI: 0.35, BE: 0.3, AT: 0.275,
  AU: 0.3, JP: 0.15315, HK: 0, SG: 0,
};
/** Treaty rates a German resident gets at source without a reclaim, where lower. */
const DE_TREATY_AT_SOURCE: Record<string, number> = { US: 0.15, NL: 0.15, JP: 0.15315 };

export function issuerCountry(isin?: string): string | undefined {
  return isin && /^[A-Z]{2}/.test(isin) ? isin.slice(0, 2) : undefined;
}

export function withholdingRate(p: {
  isin?: string;
  assetType?: string;
  residence: string;
  account: AccountTax;
}): { rate: number; country?: string; note?: string } {
  const country = issuerCountry(p.isin);
  if (!country) return { rate: 0, note: 'no ISIN, so the issuer country and its withholding are unknown' };
  if (country === p.residence) return { rate: 0, country };
  if ((p.assetType === 'etf') && (country === 'IE' || country === 'LU')) {
    return { rate: 0, country, note: `${country}-domiciled fund: distributions are paid gross` };
  }
  if (country === 'US') return { rate: p.account.w8ben ? 0.15 : 0.3, country, note: p.account.w8ben ? 'W-8BEN on file' : 'no W-8BEN: 30 %' };
  const statutory = WITHHOLDING[country];
  if (statutory == null) return { rate: 0, country, note: `withholding for ${country} not in the table` };
  const treaty = p.residence === 'DE' ? DE_TREATY_AT_SOURCE[country] : undefined;
  const rate = treaty != null ? Math.min(treaty, statutory) : statutory;
  return { rate, country, note: rate > 0.15 ? `${Math.round(rate * 100)} % at source; the part above 15 % can be reclaimed` : undefined };
}

/**
 * Tax on a realised gain (a sale). Same German rates as income, no withholding;
 * funds get the Teilfreistellung on gains too. Losses are not offset here.
 */
export function capitalGainsTax(p: {
  gain_usd: number;
  assetType?: string;
  partialExemptionPct?: number;
  profile: TaxProfile;
  allowanceLeftEur: number;
  usdPerEur: number;
}): { tax_usd: number; allowance_used_usd: number } {
  if (p.gain_usd <= 0 || p.profile.residence !== 'DE') return { tax_usd: 0, allowance_used_usd: 0 };
  const exemption = p.assetType === 'etf' ? (p.partialExemptionPct ?? 30) / 100 : 0;
  const taxable = p.gain_usd * (1 - exemption);
  const allowanceUsed = Math.min(taxable, Math.max(0, p.allowanceLeftEur) * p.usdPerEur);
  const k = p.profile.church_tax_rate;
  const kapest = (taxable - allowanceUsed) / (4 + k);
  return { tax_usd: Math.round(kapest * (1 + 0.055 + k) * 100) / 100, allowance_used_usd: Math.round(allowanceUsed * 100) / 100 };
}

export interface TaxBreakdown {
  gross_usd: number;
  withholding_rate: number;
  withholding_usd: number;
  /** What actually arrives in the account on the pay date. */
  received_usd: number;
  /** Residence-country tax: withheld by a domestic broker, or due later with the return. */
  residence_tax_usd: number;
  residence_tax_settled: 'at_payment' | 'with_tax_return' | 'not_modelled';
  allowance_used_usd: number;
  /** Money that is really the owner's to plan with: received minus any tax still due. */
  net_usd: number;
  notes: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Tax on one payment.
 * `allowanceLeftEur`: what remains of the allowance usable for THIS account
 * (its Freistellungsauftrag for a German broker; the unassigned remainder,
 * claimed in the return, for a foreign one).
 */
export function taxOnPayment(p: {
  gross_usd: number;
  isin?: string;
  assetType?: string;
  partialExemptionPct?: number;
  account: AccountTax;
  profile: TaxProfile;
  allowanceLeftEur: number;
  usdPerEur: number;
}): TaxBreakdown {
  const notes: string[] = [];
  const wht = withholdingRate({ isin: p.isin, assetType: p.assetType, residence: p.profile.residence, account: p.account });
  if (wht.note) notes.push(wht.note);
  const withholding = p.gross_usd * wht.rate;
  const received = p.gross_usd - withholding;

  if (p.profile.residence !== 'DE') {
    notes.push(`home-country tax for ${p.profile.residence} is not modelled`);
    return {
      gross_usd: round2(p.gross_usd), withholding_rate: wht.rate, withholding_usd: round2(withholding),
      received_usd: round2(received), residence_tax_usd: 0, residence_tax_settled: 'not_modelled',
      allowance_used_usd: 0, net_usd: round2(received), notes,
    };
  }

  // Germany.
  const exemption = p.assetType === 'etf' ? (p.partialExemptionPct ?? 30) / 100 : 0;
  if (exemption > 0) notes.push(`Teilfreistellung: ${Math.round(exemption * 100)} % of the distribution is tax-free`);
  const taxable = p.gross_usd * (1 - exemption);
  const allowanceUsd = Math.max(0, p.allowanceLeftEur) * p.usdPerEur;
  const allowanceUsed = Math.min(taxable, allowanceUsd);
  const base = taxable - allowanceUsed;
  // Creditable foreign tax: at most 15 % of gross, and never more than the German tax on it.
  const credit = Math.min(withholding, p.gross_usd * 0.15);
  const k = p.profile.church_tax_rate;
  // KapESt with church tax: (base - 4 x credit) / (4 + k); Soli 5.5 % and church tax k on top.
  const kapest = Math.max(0, (base - 4 * credit) / (4 + k));
  const residenceTax = kapest * (1 + 0.055 + k);
  if (allowanceUsed > 0) notes.push(`Sparerpauschbetrag covers $${round2(allowanceUsed)}`);
  if (!p.account.domestic) notes.push('foreign broker: German tax is due with the return (Anlage KAP) and is set aside');

  return {
    gross_usd: round2(p.gross_usd),
    withholding_rate: wht.rate,
    withholding_usd: round2(withholding),
    received_usd: round2(p.account.domestic ? received - residenceTax : received),
    residence_tax_usd: round2(residenceTax),
    residence_tax_settled: p.account.domestic ? 'at_payment' : 'with_tax_return',
    allowance_used_usd: round2(allowanceUsed),
    net_usd: round2(received - residenceTax),
    notes,
  };
}
