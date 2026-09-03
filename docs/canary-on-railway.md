# The canary, on Railway

It used to run as a GitHub Action. That stopped when Actions billing was
blocked on the account, and a canary nobody notices has stopped is worse than
no canary at all — the whole point is that you trust it.

Railway is a better home for it anyway, for one reason: **the database is
already there.** The GitHub runner had no connection string on purpose (a
production credential on a build runner is a worse risk than the failures it
catches), so it could only run `--http-only` and never saw the staleness nag.
On Railway it can reach the same Postgres as the app, so it also tracks how long
it has been since a human confirmed a real TikTok upload came back untouched.

## What it checks

Everything that can be checked without TikTok: the site responds, the paywall
refuses an unauthenticated patch, the webhook secret is configured, and a real
Checkout Session still reaches Stripe — which is the only check that proves the
live key and the price ids still agree with each other.

It does **not** prove the method still works. Nothing automated can; see the
note at the top of `scripts/canary.mts`.

## Setting it up — once, in the Railway dashboard

NO NEW GITHUB REPO. One repo, one Railway project, two services inside it:

    GitHub: AwesomeSauce711/pristine        <- one repo, unchanged
                     |
             +-------+-------+
             v               v
    Railway project "pristine"
      +-- service: web       npm start        (already there)
      +-- service: canary    npm run canary   (what you are adding)

A Railway project is a container for services; you already have the web
service and Postgres in this one. Both code services build from the same repo
and the same commit and differ only in the command they run, which is what
railway.canary.json sets.

It must go in the SAME project as the site, or it cannot reference the
database.

1. Open the existing **pristine** project — the canvas with the web service and
   Postgres tiles on it. Press **Cmd/Ctrl+K** and type "new service", or click
   **`+ New`** at the top right OF THAT CANVAS (labelled **Create** in some
   versions). Clicking New from the dashboard home instead makes a whole new
   project, which is the mistake to avoid.

   Choose **GitHub Repo → `AwesomeSauce711/pristine`** — the same one already
   deployed. A new tile appears beside the web service. Name it `canary`.

2. **Settings → Config-as-code → Path:** `railway.canary.json`

   This is why the file exists: the main service must keep using Railway's
   auto-detected Next.js build, and this one must not build Next at all. A
   `railway.json` at the root would apply to both.

3. **Settings → Networking:** do not generate a domain. It is not a server.

4. **Variables:**

   | name | value |
   |---|---|
   | `CANARY_ORIGIN` | `https://pristine4k.com` |
   | `DATABASE_URL` | reference the Postgres service |
   | `RESEND_API_KEY` | same value as the web service (the annual notice is an email) |
   | `EMAIL_FROM` | same as the web service |
   | `NEXT_PUBLIC_ORIGIN` | `https://pristine4k.com` (the link in the notice) |
   | `STRIPE_PRICE_WEEK`, `STRIPE_PRICE_MONTH`, `STRIPE_PRICE_YEAR` | same as the web service (to tell which plan a subscription is) |

   `CANARY_ORIGIN` is deliberately not `NEXT_PUBLIC_ORIGIN`: that variable is
   whatever the local environment points at, and a canary that cheerfully
   reports localhost is healthy is worse than none.

5. **Settings → Cron Schedule** should already read `17 13 * * *` from the
   config file — daily, off the hour to miss the stampede. Railway runs the
   start command and waits for the process to exit, which the canary does with
   a status code.

6. **Settings → Notifications:** turn on deployment failure alerts. This is the
   part that matters. A failing check that emails nobody is the same silence
   the GitHub billing problem created.

## Reading it

Exit 0 means every check passed. Non-zero means at least one fatal check
failed, which Railway shows as a failed run. The staleness nag is a warning and
never fails the run on its own — it is a number that grows until you record a
real upload:

```
npm run canary -- --confirm ok
```

## Running it by hand

From your machine, against production, any time:

```
npm run canary
```

## The annual renewal notice runs on the same schedule

`npm run renewal:notices` emails each Annual subscriber once per term, 15 to
31 days before the plan renews, with the date, the amount and how to cancel.
That notice is required by law for subscriptions with a term of a year or
more (California and several other states); no other plan gets a reminder.
The cron service runs it daily after the canary; `railway.canary.json` already
sets the start command to:

    npm run canary && npm run renewal:notices

It needs `DATABASE_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `NEXT_PUBLIC_ORIGIN`
and the live `STRIPE_PRICE_*` ids in the service's variables. It is safe to
run more often than daily: each term is marked when its notice goes out.
