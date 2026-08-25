# Sidestream Repository Instructions

Read `README.md` before changing this repository. Keep it current after every
behavior, API, deployment, or workflow change.

## Repository scope and canonical branch

This repository owns the complete Sidestream web service:

- public website and account/checkout pages
- Vercel middleware and server API routes
- website-owned database migrations, manifests, tests, and deployment scripts

The Premiere Pro extension/app is owned by the separate FlowState repository at
`/Users/alexgarrett/alexg.mov/nle-plugins/FlowState`. Do not move app code into
this repository or website/server code into FlowState unless Alex explicitly
requests a repository-boundary change.

`origin/main` is the only canonical branch. Existing `codex/*`, `orch/*`,
release, detached, and worktree branches are historical/non-canonical and must
be ignored unless Alex explicitly names one. Do not inspect them for missing
work, use them as a starting point, merge them, push them, deploy them, or
create another branch/worktree by default.

At the start of every task:

```sh
git fetch origin main --prune
git checkout main
git pull --ff-only origin main
git status --short --branch
```

Work directly on local `main`, commit to `main`, and push only
`main:main`. If local `main` cannot fast-forward cleanly, or the working tree
contains changes that are not part of the current task, stop and ask Alex
instead of switching branches or recovering code from another checkout.

## Checkout contract

The Free-plan Upgrade chooser has two explicit branches:

1. Upgrade
2. More Credits or Unlimited

More Credits is the installation-wallet path: the panel posts the exact
server-advertised pack to `/api/credits/purchase`, then opens one-time Stripe
Checkout. Unlimited preserves the account-owned sequence:

1. Unlimited
2. Google authentication
3. Stripe Checkout

`GET /api/checkout/start` owns the Unlimited sequence. A signed-out request redirects to
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

Agent sessions must publish only by committing on the current, synchronized
local `main` and pushing `main:main`. The Vercel Git integration tracks only
`main` for Production; all other pushed branches are Preview deployments and
must be ignored unless Alex explicitly requests one. Before pushing, run:

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
