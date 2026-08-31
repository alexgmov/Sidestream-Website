# Meta creative ROAS

## Authority and outcome

The Website owns creative capture, exact customer/payment lineage, the daily
Meta spend ledger, and the protected report. FlowState only proxies and renders
the sanitized report. A browser, CEP package, Meta click, payment-stage event,
or dashboard cannot declare a purchase by itself.

The observed calculation is:

```text
Meta ad URL: utm_content={{ad.id}}
                  |
                  v
immutable Website acquisition + creative key
                  |
                  v
server-owned Checkout intent + exact Customer 360 profile
                  |
                  v
positive verified net customer money, by currency
                  |
                  +----------------------+
                                         |
Meta daily export -> normalized CSV -> spend ledger, by currency
                                         |
                                         v
                    ROAS = net revenue / spend
```

The report counts a purchased customer only when one live Customer 360 profile
with positive verified net money is attached to the Meta acquisition through
the exact Checkout/commerce lineage. The selected Meta acquisition is unique
per profile and currency. Quarantined acquisition roots are excluded. Stripe
provider identifiers, emails, install hashes, and customer IDs never enter the
report.

## Creative key contract

Set the Meta destination URL parameter to:

```text
https://sidestream.tv/meta-paid?utm_content={{ad.id}}
```

Use `/meta-default` instead only when that ad intentionally enters the default
experience. `utm_content` must appear exactly once and contain 1-64 ASCII
letters, numbers, dots, underscores, or hyphens. Invalid, repeated, or absent
values fall back to the existing `paid` or `default` variant key. The variant
continues to live separately in the experiment cohort, so recording an ad ID
does not change which experience is selected.

Use Meta's numeric ad ID because it is stable and globally specific. Renaming
an ad does not rewrite historical attribution. The normalized spend row's
`creative_key` and `ad_id` should therefore normally be identical.

## Spend import

The Website does not give Meta API credentials to the dashboard. Export daily
ad-level spend from Meta, normalize it to this exact UTF-8 CSV contract, and
store amounts in the account currency's integer minor units:

```csv
spend_day,campaign,creative_key,ad_id,currency,spend_minor,impressions,clicks
2026-08-30,sidestream_direct_offer_test,2385001,2385001,usd,1234,10000,225
```

The `campaign` is the Website's canonical UTM campaign, not a mutable display
name. Current deterministic Meta routes use `sidestream_direct_offer_test`.
The import rejects extra/reordered headers, decimals, negative numbers,
duplicate daily creative rows, unsafe dimensions, more than 10,000 rows, or a
file larger than 10 MiB. An exact replay updates the same daily row, which lets
later Meta export corrections replace provisional spend without creating a
duplicate.

Validate without touching a database:

```sh
npm run meta-spend:import -- --file /absolute/path/meta-spend.csv --namespace test
```

Apply to Test after `20260831120000_add_meta_ad_spend.sql` is present:

```sh
npm run meta-spend:import -- --file /absolute/path/meta-spend.csv --namespace test --apply
```

Production accepts only `SIDESTREAM_POSTGRES_URL_NON_POOLING` and additionally
requires the exact `IMPORT-META-AD-SPEND` operation confirmation plus the
connected target fingerprint printed by the first refused apply. Never put a
database URL or confirmation value in shell history, logs, documentation, or
the CSV.

## Protected report

`POST /api/internal/meta-roas-report` uses the same POST-only, no-browser-origin,
no-store `SIDESTREAM_CRM_ADMIN_SECRET` boundary as Customer 360. Inputs are
`licenseNamespace`, `from`, `through`, `asOf`, and optional canonical
`campaign`. The acquisition and spend windows are identical and exclusive at
`through`; purchase outcomes mature through `asOf`.

Each creative exposes canonical acquisition and downstream stage counts plus
currency-isolated purchased customers, net revenue, spend, impressions, Meta
clicks, ROAS, and CAC. A zero/missing spend denominator returns `null` ROAS and
`missing_spend`, never `0`. Spend without a matching Sidestream acquisition,
acquisitions missing creative keys, and creative rows missing spend remain
explicit integrity gates. Cross-currency totals are forbidden.

## Readiness gate

Creative-level marketing decisions are ready only when all of these are true:

1. The deployed Meta ad URL supplies its exact ad ID as `utm_content`.
2. The Website migration and protected report are live at the canonical SHA.
3. The same UTC date range has a complete daily Meta export imported.
4. The report shows no unexplained missing-creative or spend-without-acquisition
   rows for the campaign being judged.
5. At least one real paid customer has exact checkout-linked creative lineage;
   payment-stage counts alone do not qualify.
6. ROAS is read within one currency and the cohort has enough time and volume
   to mature.

Historical Meta landings recorded only as `paid` or `default` cannot be
retroactively assigned to a specific ad. They remain visible as aggregate
variant history and must not be mixed into a new creative's result.
