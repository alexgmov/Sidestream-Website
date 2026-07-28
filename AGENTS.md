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

Agent sessions must publish only by fast-forwarding the intended commit onto
`origin/main`. The Vercel Git integration tracks only `main` for Production;
all other pushed branches are Preview deployments. Before pushing, run:

```sh
npm run verify:production-source
npm run test:entitlement
npm run build
```

Do not run `vercel deploy --prod`, `npm run deploy:production`, assign the
canonical alias, promote a feature deployment, or deploy from a detached/stale
checkout in an agent session. Local Vercel CLI authentication is intentionally
absent so a stale checkout cannot bypass current repository guards. The guarded
CLI command remains an owner-only emergency tool after deliberate human
reauthentication; it must not become the routine agent release path.

After pushing `main`, wait for the Git-linked Production deployment and verify
that canonical `https://sidestream.tv/version.json` reports the pushed SHA and
that `/api/checkout/start` still returns the expected direct redirect. A Ready
build or Preview deployment alone is not Production proof.
