#!/usr/bin/env bash
#
# runthrough.sh — exercise the whole live site from outside.
#
# Every check here is one a customer or an attacker could run. It deliberately
# does NOT sign in or request a code: doing so in production sends real email,
# and firing sign-in codes at made-up addresses to make a test pass is how a
# sending domain gets blocklisted.
#
# The purchase path is therefore only checked as far as "checkout reaches
# Stripe". The rest of it — pay, return, download — has to be walked by a human
# with a real card, once, and it was.
#
#   npm run runthrough                          against production
#   B=http://localhost:3001 npm run runthrough  against a dev server
#
B="${B:-https://pristine4k.com}"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then printf "  ok   %-44s %s\n" "$1" "$2"; pass=$((pass+1)); else printf "  FAIL %-44s got %s want %s\n" "$1" "$2" "$3"; fail=$((fail+1)); fi; }
code(){ curl -s -o /dev/null -w "%{http_code}" --max-time 25 "$@"; }

echo; echo "PAGES"
for p in / /pricing /app /sign-in /welcome /legal/terms /legal/privacy /legal/refunds; do
  chk "GET $p" "$(code "$B$p")" "200"
done
chk "GET /account (signed out)" "$(code "$B/account")" "307"
chk "GET /nonexistent" "$(code "$B/nope-does-not-exist")" "404"

echo; echo "PAYWALL AND ACCESS"
chk "POST /api/patch unauthenticated" "$(code -X POST "$B/api/patch")" "401"
chk "POST /api/billing/portal unauth"  "$(code -X POST -H "Origin: $B" "$B/api/billing/portal")" "401"
chk "POST /api/billing/sync unauth"    "$(code -X POST -H "Origin: $B" "$B/api/billing/sync")" "401"
chk "POST /api/dev/unlock (must 404)"  "$(code -X POST "$B/api/dev/unlock")" "404"

echo; echo "WEBHOOK"
chk "unsigned webhook rejected"        "$(code -X POST -d '{}' "$B/api/stripe/webhook")" "400"
chk "bad signature rejected"           "$(code -X POST -H 'stripe-signature: t=1,v1=deadbeef' -d '{}' "$B/api/stripe/webhook")" "400"

echo; echo "CSRF"
chk "cross-origin POST refused"        "$(code -X POST -H 'Origin: https://evil.example' -H 'content-type: application/json' -d '{}' "$B/api/billing/checkout")" "403"
chk "same-origin POST reaches the route (401: sign in first)" "$(code -X POST -H "Origin: $B" -H 'content-type: application/json' -d '{"plan":"week","consented":true}' "$B/api/billing/checkout")" "401"

echo; echo "CLAIM (cannot be forged)"
chk "no cookie"                        "$(code "$B/api/billing/claim")" "303"
chk "forged nonce"                     "$(code -H 'Cookie: __Host-pristine_claim=deadbeefdeadbeef' "$B/api/billing/claim")" "303"
S=$(curl -s -D - -o /dev/null --max-time 25 -H 'Cookie: __Host-pristine_claim=deadbeefdeadbeef' "$B/api/billing/claim" | grep -ci "set-cookie: __Host-pristine_session")
chk "forged nonce mints no session"    "$S" "0"

echo; echo "HEADERS"
H=$(curl -sI --max-time 25 "$B/")
for h in "content-security-policy" "strict-transport-security" "x-frame-options" "x-content-type-options" "referrer-policy" "permissions-policy"; do
  printf "  %-4s %-44s\n" "$(echo "$H" | grep -qi "^$h" && echo ok || echo FAIL)" "$h"
  echo "$H" | grep -qi "^$h" && pass=$((pass+1)) || fail=$((fail+1))
done
chk "no x-powered-by" "$(echo "$H" | grep -ci '^x-powered-by')" "0"
chk "api responses no-store" "$(curl -sI --max-time 25 "$B/api/status" | grep -ci 'no-store')" "1"

echo; echo "CONTENT"
chk "pricing shows \$4.99"   "$(curl -s --max-time 25 "$B/pricing" | grep -c '\$4\.99')" "1"
chk "legal banner cleared"   "$(curl -s --max-time 25 "$B/legal/terms" | grep -ciE 'to be completed')" "0"
chk "FAQ is an accordion"    "$(curl -s --max-time 25 "$B/" | grep -c '<details')" "5"
chk "no method explanation"  "$(curl -s --max-time 25 "$B/" | grep -ci 'decoy audio track')" "0"

echo
echo "  $pass passed, $fail failed"
