import type { QueryResult, QueryResultRow } from "pg";
import type Stripe from "stripe";
import { getStripe } from "./account.js";
import { LICENSE_ENTITLEMENT_STATUS_SQL } from "./license-entitlement-sql.js";
import { withPostgresTransaction } from "./postgres.js";

type LicenseNamespace = "production" | "test";

type CustomerSummaryClient = Readonly<{
  query<Row extends QueryResultRow = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}>;

type SummaryRow = QueryResultRow & Readonly<{
  unlimited_access_users: string | number | bigint;
  paid_users: string | number | bigint;
  paid_unlimited_access_users: string | number | bigint;
}>;

type PaymentIntentPage = Readonly<{
  data: readonly Pick<Stripe.PaymentIntent, "id" | "status">[];
  has_more: boolean;
}>;

type CustomerSummaryDependencies = Readonly<{
  transaction: <T>(callback: (client: CustomerSummaryClient) => Promise<T>) => Promise<T>;
  runtimeNamespace: () => LicenseNamespace;
  listPaymentIntents: (startingAfter?: string) => Promise<PaymentIntentPage>;
}>;

const defaultDependencies: CustomerSummaryDependencies = {
  transaction: (callback) => withPostgresTransaction(callback, {
    isolationLevel: "repeatable read",
    readOnly: true,
  }),
  runtimeNamespace: () => resolveRuntimeLicenseNamespace(process.env),
  listPaymentIntents: (startingAfter) => getStripe().paymentIntents.list({
    limit: 100,
    ...(startingAfter ? { starting_after: startingAfter } : {}),
  }),
};

export class CustomerSummaryValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CustomerSummaryValidationError";
    this.code = code;
  }
}

export async function queryCustomerSummary(
  request: unknown,
  overrides: Partial<CustomerSummaryDependencies> = {},
) {
  const licenseNamespace = parseSummaryInput(request);
  const dependencies = { ...defaultDependencies, ...overrides };
  if (dependencies.runtimeNamespace() !== licenseNamespace) {
    throw new CustomerSummaryValidationError(
      "invalid_namespace",
      "licenseNamespace does not match the deployed license database",
    );
  }

  const [licenseTotals, successfulPayments] = await Promise.all([
    dependencies.transaction(async (client) => {
      const result = await client.query<SummaryRow>(`
        with exact_licenses as (
          select
            l.account_id,
            l.stripe_payment_intent_id,
            ${LICENSE_ENTITLEMENT_STATUS_SQL} as entitlement_status
          from public.sidestream_licenses l
          where l.plan_key in ('sidestream_pro', 'sidestream_unlimited')
        ),
        account_rollup as (
          select
            account_id,
            bool_or(entitlement_status = 'active') as has_unlimited_access,
            bool_or(stripe_payment_intent_id is not null) as has_paid,
            bool_or(
              entitlement_status = 'active'
              and stripe_payment_intent_id is not null
            ) as has_paid_unlimited_access
          from exact_licenses
          group by account_id
        )
        select
          count(*) filter (where has_unlimited_access)::text as unlimited_access_users,
          count(*) filter (where has_paid)::text as paid_users,
          count(*) filter (where has_paid_unlimited_access)::text as paid_unlimited_access_users
        from account_rollup
      `);
      const row = result.rows[0];
      return {
        unlimitedAccessUsers: decimalCount(row?.unlimited_access_users),
        paidUsers: decimalCount(row?.paid_users),
        paidUnlimitedAccessUsers: decimalCount(row?.paid_unlimited_access_users),
      };
    }),
    countSuccessfulStripePayments(dependencies.listPaymentIntents),
  ]);

  return {
    licenseNamespace,
    totals: {
      ...licenseTotals,
      successfulPayments,
    },
  };
}

async function countSuccessfulStripePayments(
  listPaymentIntents: CustomerSummaryDependencies["listPaymentIntents"],
) {
  let startingAfter: string | undefined;
  let successfulPayments = 0n;

  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await listPaymentIntents(startingAfter);
    for (const paymentIntent of page.data) {
      if (paymentIntent.status === "succeeded") successfulPayments += 1n;
    }
    if (!page.has_more) return successfulPayments.toString();

    const lastPaymentIntent = page.data.at(-1);
    if (!lastPaymentIntent?.id) {
      throw new Error("Stripe PaymentIntent pagination returned an invalid page");
    }
    startingAfter = lastPaymentIntent.id;
  }

  throw new Error("Stripe PaymentIntent summary exceeded the 10,000-row safety cap");
}

export function resolveRuntimeLicenseNamespace(
  environment: Readonly<Record<string, string | undefined>>,
): LicenseNamespace {
  const explicit = environment.SIDESTREAM_LICENSE_NAMESPACE?.trim().toLowerCase();
  if (explicit) {
    if (explicit === "production" || explicit === "test") return explicit;
    throw new Error("SIDESTREAM_LICENSE_NAMESPACE must be production or test");
  }
  const deployment = environment.VERCEL_ENV?.trim().toLowerCase();
  if (deployment === "production") return "production";
  if (deployment === "preview" || deployment === "development" || deployment === "test") {
    return "test";
  }
  throw new Error("Customer summary requires a trusted deployment namespace");
}

function parseSummaryInput(request: unknown): LicenseNamespace {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new CustomerSummaryValidationError("invalid_request", "request body must be an object");
  }
  const body = request as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "licenseNamespace")) {
    throw new CustomerSummaryValidationError("unknown_request_key", "request body has unknown fields");
  }
  if (body.licenseNamespace !== "production" && body.licenseNamespace !== "test") {
    throw new CustomerSummaryValidationError(
      "invalid_namespace",
      "licenseNamespace must be production or test",
    );
  }
  return body.licenseNamespace;
}

function decimalCount(value: string | number | bigint | undefined) {
  const normalized = String(value ?? "0");
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error("Customer summary count is invalid");
  }
  return normalized;
}
