import Link from 'next/link';
import PageShell from '@/components/PageShell';
import { COMPANY, LEGAL_UPDATED, missingCompanyDetails } from '@/lib/company';

/*
 * Shared shell for the legal pages.
 *
 * The unmissable banner is deliberate. These documents are legally operative:
 * Terms that name no legal entity are not enforceable, and a privacy policy
 * with no contact route does not satisfy GDPR or CCPA. A quiet "TODO" in the
 * source would be shipped by accident; a red banner on the page itself will not
 * be.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  const missing = missingCompanyDetails();

  return (
    <>
      <PageShell className="max-w-3xl">
        {missing.length > 0 && (
          <div className="mb-10 rounded-panel border border-bad/40 bg-bad/5 px-6 py-5">
            <p className="text-[14px] font-medium text-bad">
              Draft — not ready to publish
            </p>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
              These documents still contain placeholders and must not be relied on. Missing:{' '}
              <span className="tabular text-text">{missing.join(', ')}</span>. Set them in{' '}
              <span className="tabular">.env.local</span> (see{' '}
              <span className="tabular">.env.example</span>), then have a lawyer review the text
              before taking real payments.
            </p>
          </div>
        )}

        <nav className="mb-10 flex gap-6 border-b border-line-soft pb-5 text-[13.5px]">
          <Link href="/legal/terms" className="inline-flex min-h-11 items-center text-muted transition hover:text-text">Terms</Link>
          <Link href="/legal/privacy" className="inline-flex min-h-11 items-center text-muted transition hover:text-text">Privacy</Link>
          <Link href="/legal/refunds" className="inline-flex min-h-11 items-center text-muted transition hover:text-text">Refunds</Link>
        </nav>

        <article
          className="[&_h1]:text-[1.9rem] [&_h1]:font-semibold [&_h1]:tracking-[-0.02em]
                     [&_h2]:mt-11 [&_h2]:text-[1.15rem] [&_h2]:font-medium
                     [&_p]:mt-4 [&_p]:text-[14.5px] [&_p]:leading-relaxed [&_p]:text-muted
                     [&_li]:mt-2 [&_li]:text-[14.5px] [&_li]:leading-relaxed [&_li]:text-muted
                     [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-5
                     [&_strong]:text-text [&_a]:underline [&_a]:decoration-line"
        >
          {children}
        </article>

        <p className="mt-16 border-t border-line-soft pt-6 text-[12.5px] text-dim">
          {COMPANY.legalName}
          {COMPANY.address !== 'TO BE COMPLETED' && <> · {COMPANY.address}</>}
          {' · '}Last updated: {LEGAL_UPDATED}
        </p>
      </PageShell>
    </>
  );
}
