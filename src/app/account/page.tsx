import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import PageShell from '@/components/PageShell';
import BillingActions from '@/components/BillingActions';
import { db, schema } from '@/db';
import { currentUser } from '@/lib/auth';
import { resolveAccess } from '@/lib/entitlement';
import { PLANS, money, type PlanId } from '@/lib/plans';

export const metadata: Metadata = { title: 'Account' };

/*
 * The account page.
 *
 * States it must show honestly, because each one needs a different action:
 * on a trial that will convert, on a trial that will not, active, cancelling at
 * period end, in the grace window after a failed payment, and ended. The one
 * that matters most is the failed payment — it needs the exact date access ends
 * and a direct route to fix the card, because a customer surprised by losing
 * access disputes the charge instead of updating the card.
 */
export default async function AccountPage() {
  const user = await currentUser();
  if (!user) redirect('/sign-in?next=%2Faccount');

  const access = await resolveAccess();

  const rows = await db().select().from(schema.entitlements)
    .where(eq(schema.entitlements.userId, user.id)).limit(1);
  const ent = rows[0];

  const plan = ent?.tier ? PLANS[ent.tier as PlanId] : null;
  const until = ent?.accessUntil ?? null;
  const live = !!until && until > new Date() && !ent?.revokedAt;

  const dateFmt = (d: Date) =>
    d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <>
      <PageShell className="max-w-3xl">
        <h1 className="title-3d text-[1.9rem]">Account</h1>
        <p className="mt-2 text-[14.5px] text-muted">{user.email}</p>

        <section className="plate plate-face plate-glow mt-10 rounded-panel p-7">
          <div className="legend">Subscription</div>

          {!ent || (!live && ent.state === 'none') ? (
            <>
              <p className="mt-3 text-[15px]">No active plan.</p>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">
                You can upload, analyse and preview videos for free. A plan is needed to
                download the finished file.
              </p>
              <Link
                href="/pricing"
                className="pill pill-primary mt-6"
              >
                See plans
              </Link>
            </>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[1.35rem] font-medium">{plan?.name ?? 'Plan'}</span>
                {plan && (
                  <span className="tabular text-[14px] text-muted">
                    {money(plan.amount)}/{plan.interval}
                  </span>
                )}
                <StatusPill state={ent.state} cancelling={ent.cancelAtPeriodEnd} />
              </div>

              {/* The specific, actionable sentence for each state. */}
              <p className="mt-4 text-[14px] leading-relaxed text-muted">
                {ent.revokedAt ? (
                  <>Access is suspended because of a payment dispute on this account. Please
                     contact support.</>
                ) : ent.state === 'grace' ? (
                  <span className="text-warn">
                    Your last payment failed. Update your card to keep access
                    {until ? <> — it ends on <span className="tabular">{dateFmt(until)}</span></> : null}.
                  </span>
                ) : ent.cancelAtPeriodEnd && until ? (
                  <>Cancelled. You keep full access until{' '}
                    <span className="tabular text-text">{dateFmt(until)}</span>, and will not be
                    charged again.</>
                ) : ent.inTrial && until ? (
                  <>Free trial. Your card will first be charged{' '}
                    <span className="tabular text-text">
                      {plan ? money(plan.amount) : ''} on {dateFmt(until)}
                    </span>{' '}
                    unless you cancel before then.</>
                ) : until ? (
                  <>Renews on <span className="tabular text-text">{dateFmt(until)}</span>.</>
                ) : null}
              </p>

              {live && (
                <dl className="mt-7 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
                  <div className="bg-panel-2 px-4 py-3.5">
                    <dt className="legend">Left today</dt>
                    <dd className="tabular mt-1 text-[15px]">
                      {access.dailyRemaining} <span className="text-dim">/ {ent.dailyPatchCap}</span>
                    </dd>
                  </div>
                  <div className="bg-panel-2 px-4 py-3.5">
                    <dt className="legend">Left this period</dt>
                    <dd className="tabular mt-1 text-[15px]">
                      {access.periodRemaining} <span className="text-dim">/ {ent.periodPatchCap}</span>
                    </dd>
                  </div>
                </dl>
              )}

              <BillingActions />
            </>
          )}
        </section>

        <BillingActions signOutOnly />

        <p className="mt-10 text-[12.5px] leading-relaxed text-dim">
          Cancelling takes effect at the end of the period you have already paid for — you keep
          what you paid for. See our{' '}
          <Link href="/legal/refunds" className="underline hover:text-muted">refund policy</Link>.
        </p>
      </PageShell>
    </>
  );
}

function StatusPill({ state, cancelling }: { state: string; cancelling: boolean }) {
  const [label, tone] =
    state === 'revoked' ? ['Suspended', 'bad'] :
    state === 'grace' ? ['Payment failed', 'warn'] :
    cancelling ? ['Ends soon', 'warn'] :
    state === 'trialing' ? ['Trial', 'accent'] :
    state === 'active' ? ['Active', 'good'] :
    ['Ended', 'dim'];

  const cls: Record<string, string> = {
    bad: 'border-bad/40 text-bad',
    warn: 'border-warn/40 text-warn',
    accent: 'border-accent/40 text-accent-soft',
    good: 'border-good/40 text-good',
    dim: 'border-line text-dim',
  };

  return (
    <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.1em] ${cls[tone]}`}>
      {label}
    </span>
  );
}
