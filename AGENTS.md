# Sidestream Repository Instructions

Read `README.md` before changing this repository. Keep it current after every
behavior, API, deployment, or workflow change.

## Checkout contract

The paid Sidestream sequence is exactly:

1. Upgrade
2. Google authentication
3. Stripe Checkout

`GET /api/checkout/start` owns the sequence. A signed-out request redirects to
Google authentication. A signed-in Free account creates or reuses the locked
Checkout intent and redirects to Stripe. Keep every step server-owned by that
route.

Stripe can report a completed zero-total Checkout Session with
`payment_status=paid`, `amount_total=0`, and no PaymentIntent. Preserve support
for that shape and `no_payment_required` under the exact existing
Session/Price/Product/activation validation.

Run `npm run verify:checkout-contract` and `npm run test:entitlement` after any
checkout, authentication, activation-claim, account, or Stripe fulfillment
change.

## Production deployment contract

Production source is the clean, pushed commit at `origin/main`. Feature,
release, and local branches are not Production sources, even if Vercel labels a
deployment Ready.

Use only:

```sh
npm run deploy:production
```

Do not run a raw `vercel deploy --prod`, promote a feature deployment, or deploy
from a detached/stale checkout. First integrate the intended change onto the
current `origin/main`, then use the guarded command. The guard must continue to
verify the exact Vercel project, the direct checkout baseline, the zero-total
fulfillment baseline, the source checkout contract, and equality between local
HEAD and remote `main`. It must also read the exact Git SHA from canonical
Production `/version.json` and require that SHA to be an ancestor of the
candidate. A divergent candidate is a full-site rollback and must fail before
the build.

After deployment, verify the canonical `https://sidestream.tv` alias and the
actual `/api/checkout/start` response. The guarded command does this
automatically and requires `/version.json` to report the deployed `HEAD`. A
Ready build alone is not Production proof.
