/*
 * check-legal.mts — refuse to ship legal pages full of placeholders.
 *
 * Terms that name no legal entity are not enforceable, and a privacy policy
 * with no contact route does not satisfy GDPR or CCPA. Those are easy things to
 * forget in the rush to launch and expensive things to have forgotten, so this
 * is wired into the build rather than left as a note.
 *
 * Run: npx tsx scripts/check-legal.mts
 */

import { COMPANY, missingCompanyDetails } from '../src/lib/company';

const missing = missingCompanyDetails();

if (missing.length === 0) {
  console.log('\n  legal: all business details are set\n');
  console.log(`    ${COMPANY.legalName}`);
  console.log(`    ${COMPANY.address}`);
  console.log(`    ${COMPANY.supportEmail}`);
  console.log(`    statement descriptor: ${COMPANY.statementDescriptor}\n`);
  process.exit(0);
}

console.error('\n  legal: NOT READY TO PUBLISH\n');
console.error('  These are still placeholders, and the Terms, Privacy Policy and Refund');
console.error('  Policy quote them directly:\n');
for (const k of missing) console.error(`    NEXT_PUBLIC_${camelToEnv(k)}`);
console.error('\n  Set them in .env.local (see .env.example), then have a lawyer read the');
console.error('  text before taking real payments. It is a draft, not advice.\n');
process.exit(1);

function camelToEnv(k: string): string {
  const map: Record<string, string> = {
    legalName: 'LEGAL_NAME',
    address: 'LEGAL_ADDRESS',
    country: 'LEGAL_COUNTRY',
    supportEmail: 'SUPPORT_EMAIL',
    privacyEmail: 'PRIVACY_EMAIL',
  };
  return map[k] ?? k.toUpperCase();
}
