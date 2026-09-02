/*
 * company.ts — the business details that appear in legally-operative text.
 *
 * THESE ARE PLACEHOLDERS AND MUST BE REPLACED BEFORE TAKING REAL MONEY.
 *
 * They are here rather than inline in the pages so there is exactly one place
 * to change them, and so `npm run check:legal` can fail the build while any
 * placeholder remains. Terms that name no legal entity are not enforceable, and
 * a privacy policy with no contact route does not satisfy GDPR or CCPA.
 *
 * The statement descriptor deserves particular attention: it is what appears on
 * a customer's bank statement, and a descriptor they do not recognise is one of
 * the largest single causes of "I don't recognise this charge" chargebacks. It
 * must match the brand they think they bought from.
 */

export interface Company {
  /** Registered legal entity, e.g. "Pristine Software LLC". */
  legalName: string;
  /**
   * Trading name shown to customers, and the one that has to match the bank
   * statement.
   *
   * This is deliberately "Pristine 4K" while the marketing copy says "Pristine".
   * The statement descriptor is PRISTINE4K and the domain is pristine4k.com, and
   * the single largest cause of "I don't recognise this charge" is a name on a
   * statement that matches nothing the customer remembers. So every artefact
   * that reaches them alongside money — receipts, sign-in mail, the legal pages
   * — uses the full name. Prose keeps the short form, which is normal: a
   * trading name and a wordmark are allowed to differ.
   */
  tradingName: string;
  /**
   * Registered address, single line. OPTIONAL.
   *
   * A street address is the strongest form of merchant identification and the
   * conservative reading of card-network rules expects one. But for a sole
   * proprietor the only address that exists is where they live, and publishing
   * a home address on a site advertised to strangers is its own risk — a real
   * one, not a compliance abstraction.
   *
   * So this is not required to launch. What IS required is that a customer can
   * identify who charged them and reach a human: a trading name, a country, and
   * a monitored support address. That is what most small digital sellers
   * publish, and it is what the pages fall back to when this is empty.
   *
   * Fill it in when there is somewhere to point at that is not a bedroom — a
   * virtual mailbox, a PO Box, or a registered agent once an entity exists.
   */
  address: string;
  /** Country of establishment — determines which consumer rules apply. */
  country: string;
  /** Support address. Must be monitored; it is quoted in the Terms. */
  supportEmail: string;
  /** Privacy contact. May be the same address. */
  privacyEmail: string;
  /** Exactly as it will appear on a bank statement. */
  statementDescriptor: string;
  /** Canonical site origin, no trailing slash. */
  origin: string;
}

const PLACEHOLDER = 'TO BE COMPLETED';

export const COMPANY: Company = {
  legalName: process.env.NEXT_PUBLIC_LEGAL_NAME ?? PLACEHOLDER,
  tradingName: 'Pristine 4K',
  address: process.env.NEXT_PUBLIC_LEGAL_ADDRESS ?? PLACEHOLDER,
  country: process.env.NEXT_PUBLIC_LEGAL_COUNTRY ?? PLACEHOLDER,
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? PLACEHOLDER,
  privacyEmail: process.env.NEXT_PUBLIC_PRIVACY_EMAIL ?? PLACEHOLDER,
  statementDescriptor: process.env.NEXT_PUBLIC_STATEMENT_DESCRIPTOR ?? 'PRISTINE4K',
  origin: process.env.NEXT_PUBLIC_ORIGIN ?? 'https://pristine4k.com',
};

/** Which required details are still placeholders. */
export function missingCompanyDetails(): string[] {
  /*
   * `address` is deliberately absent. See the note on the field: a home address
   * is worse than no address for a one-person business, and identification plus
   * a working contact route is the part that actually matters to a customer
   * trying to find out who charged them.
   */
  const required: (keyof Company)[] = [
    'legalName', 'country', 'supportEmail', 'privacyEmail',
  ];
  return required.filter((k) => !COMPANY[k] || COMPANY[k] === PLACEHOLDER);
}

export const legalIsComplete = (): boolean => missingCompanyDetails().length === 0;

/** Last substantive revision. Update when the terms actually change. */
export const LEGAL_UPDATED = 'not yet published';
