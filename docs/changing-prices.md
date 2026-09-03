# Changing what a plan costs

Stripe Prices are immutable. Changing an amount means creating a **new** Price
and pointing the site at it, which is easy. The part that is not obvious is
what happens to the people already paying.

## The thing that will bite you

A subscription keeps billing on the Price it was created with, forever, until
it is cancelled or moved. The site recognises a subscription by matching its
Price id against the configured ones (`planForPriceId`), and an id that
matches nothing maps to no plan. No plan means no tier, and no tier means **no
access** the next time that customer's entitlement is recomputed.

So swapping `STRIPE_PRICE_MONTH` on its own locks out every existing monthly
customer, silently, while they carry on paying.

That is what `STRIPE_PRICE_<PLAN>_LEGACY` is for: a comma-separated list of
the Price ids that plan used to have. They are **recognised, never sold** — a
new checkout always goes through `priceIdForPlan`, which only ever returns the
current one.

## Lowering a price

Cutting is easy and needs no consent from anybody: the automatic-renewal laws
care about increases and about charges nobody was shown, not about charging
someone less.

1. **Create the new Price** in Stripe, or run `npm run stripe:seed`, which
   creates what is missing and prints the ids.
2. **Edit the amount** in `src/lib/plans.ts`. It must match the new Price to
   the cent. Everything the reader sees — the pricing page, the annual saving
   badge, the Terms, the consent text stored with each purchase — is rendered
   from this number, so nothing else needs touching.
3. **Move the old id down.** On the web service AND the canary service in
   Railway:
   ```
   STRIPE_PRICE_MONTH=price_the_new_one
   STRIPE_PRICE_MONTH_LEGACY=price_the_old_one
   ```
   Already retired ids stay in the list, comma-separated. Both services need
   it: the canary runs the annual renewal notices, which read the plan from
   the Price.
4. **Deploy**, then check `/api/status` reports `"prices":"ok"`. It refuses
   with `mismatch` if the site and Stripe disagree on an amount, or if a
   Price id is filed under two plans. Until it says `ok`, checkout returns a
   503 rather than charging anyone the wrong amount, so a half-finished change
   fails safe.
5. **Decide about the people already on the old price.** Doing nothing is
   valid: they keep paying the old amount and everything works. To pass the
   cut on, update each subscription in the Stripe Dashboard to the new Price
   with proration set to **none**, so they finish the period they paid for and
   simply renew cheaper. With a handful of subscribers this is a few clicks.
   With many, script it over `subscriptions.list` and remember that every
   change fires a webhook the site will handle on its own.

If you migrate everybody, you can eventually empty the `_LEGACY` list. There
is no hurry, and leaving it costs nothing.

## Raising a price

Same mechanics, different obligations. Existing subscribers must be told
before their next renewal (thirty days' notice is what the Terms promise) and
they must be able to cancel first. The path of least regret is to leave every
existing subscription on its old Price and let the new one apply to new
customers only, which the legacy list makes the default behaviour rather than
a migration project.

## What to check afterwards

- `npm run verify` — the entitlement checks cover retired ids and a misfiled
  price map.
- `/api/status` shows `"prices":"ok"`.
- The pricing page shows the new amount and the recomputed saving badge.
- One existing subscriber's account page still shows their plan and allowance.
