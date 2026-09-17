# Sabitest — Technical Documentation

Complete handover notes for the Sabitest MVP: what it does, how it is built, how every part works, and how to run, extend and deploy it.

Read [README.md](README.md) first if you just want to get it running. This document is the deep reference.

---

## Table of contents

1. [What Sabitest is](#1-what-sabitest-is)
2. [Technology choices](#2-technology-choices)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Repository map](#4-repository-map)
5. [The data model](#5-the-data-model)
6. [The money system](#6-the-money-system)
7. [Core flows, step by step](#7-core-flows-step-by-step)
8. [The provider abstraction](#8-the-provider-abstraction)
9. [API reference](#9-api-reference)
10. [The customer app](#10-the-customer-app)
11. [The admin area](#11-the-admin-area)
12. [Security model](#12-security-model)
13. [Scheduled jobs and operations](#13-scheduled-jobs-and-operations)
14. [Environment variables](#14-environment-variables)
15. [Running and deploying](#15-running-and-deploying)
16. [Troubleshooting](#16-troubleshooting)
17. [How to extend it](#17-how-to-extend-it)
18. [Known gaps](#18-known-gaps)

---

## 1. What Sabitest is

Sabitest is a **reseller platform** with two product lines sharing one wallet:

| Product | What the customer gets | Where supply comes from |
| --- | --- | --- |
| **Virtual numbers** | A temporary phone number that receives an OTP for WhatsApp, Telegram, Instagram, a banking app, etc. | HEROsms |
| **Social boosting** | Followers, likes, views, members delivered to a social profile or post | Really Simple Social (RSS) |

The business model is margin: the platform buys from providers at cost, applies a markup, and sells to customers. Customers pre-fund a **Naira wallet** through Paystack and spend it across both products.

Three user-facing surfaces:

- **Public site** — landing page explaining the product, sign-up and sign-in.
- **Customer app** — dashboard, wallet, numbers, boosting, orders, support.
- **Admin area** — users, transactions, pricing, providers, refunds, support, analytics.

---

## 2. Technology choices

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | **Next.js 16, App Router** | One deployable for frontend and backend. Server Components read the database directly (no API layer for reads), Route Handlers cover the mutations that need to be callable from the browser. |
| Language | **TypeScript, strict mode** | Money code benefits from a type checker. |
| Styling | **Tailwind CSS v4** | Design tokens live in `globals.css` under `@theme`; no config file needed. |
| Auth + DB | **Supabase** (Postgres + GoTrue) | Managed auth with row level security enforced in the database, so a bug in application code cannot leak another customer's rows. |
| Payments | **Paystack** | Nigerian market standard. Card, bank transfer, USSD. Quotes NGN in kobo — the same unit used internally. |
| Numbers | **HEROsms** (swappable) | Behind an adapter interface. |
| Boosting | **Really Simple Social** (swappable) | Behind an adapter interface. |
| Validation | **Zod** | Every request body that reaches a route handler is parsed against a schema. |

There is no separate backend service, no ORM, and no state management library. Data flows: Server Component → Supabase → rendered HTML. Mutations go through Route Handlers or Server Actions.

---

## 3. Architecture at a glance

```
                        ┌──────────────────────────────────────┐
   Browser ───────────► │  Next.js (single deployment)         │
                        │                                      │
                        │  proxy.ts     session refresh +      │
                        │               route guarding         │
                        │                                      │
                        │  Server Components ──► reads (RLS)   │
                        │  Route Handlers    ──► writes        │
                        │  Server Actions    ──► admin forms   │
                        │                                      │
                        │  lib/services/  business rules       │
                        │  lib/providers/ vendor adapters      │
                        └───────┬──────────────┬───────────────┘
                                │              │
                    ┌───────────▼───┐   ┌──────▼──────────────────┐
                    │  Supabase     │   │  External providers     │
                    │  Postgres+RLS │   │  Paystack / HEROsms /   │
                    │  Auth         │   │  Really Simple Social   │
                    └───────────────┘   └─────────────────────────┘
```

### The layering rule

Each layer may only call the one below it:

```
pages / route handlers      ← authorisation, input validation, HTTP shape
        ↓
lib/services/*              ← business rules, money orchestration
        ↓
lib/wallet, lib/pricing     ← primitives
lib/providers/*             ← vendor I/O
        ↓
Postgres functions          ← atomic balance changes
```

A page never talks to a provider directly, and a provider adapter never touches the database. This is what makes vendor swaps a one-file change.

### Two Supabase clients, deliberately

| Client | Key | Used by | RLS |
| --- | --- | --- | --- |
| `createSupabaseServerClient()` | anon | Server Components, reads on behalf of a user | **Enforced** |
| `createSupabaseAdminClient()` | service role | Route handlers and services, after they have authorised the caller themselves | **Bypassed** |

Reads use the anon client so the database filters rows by the signed-in user — even a query with a missing `.eq("user_id", …)` cannot leak. Writes that move money use the service role, because customers must not have a write path to balances at all.

---

## 4. Repository map

```
sabitest/
├─ README.md                     setup and quick start
├─ DOCUMENTATION.md              this file
├─ package.json                  scripts and dependencies
├─ next.config.ts                Next.js config
├─ postcss.config.mjs            Tailwind v4 via @tailwindcss/postcss
├─ tsconfig.json                 strict TS, @/* path alias to src/
├─ .env.example                  every variable, documented
├─ AGENTS.md / CLAUDE.md         auto-generated by `next dev` for AI tooling; harmless
│
├─ supabase/
│  ├─ migrations/0001_schema.sql     tables, enums, indexes, updated_at triggers
│  ├─ migrations/0002_functions.sql  wallet functions, is_admin, signup trigger, analytics
│  ├─ migrations/0003_rls.sql        row level security policies
│  └─ seed.sql                       starter settings, providers, catalogue
│
└─ src/
   ├─ proxy.ts                   Next 16 middleware: refresh session, guard routes
   │
   ├─ app/
   │  ├─ layout.tsx              root layout, metadata
   │  ├─ globals.css             Tailwind import + design tokens
   │  ├─ page.tsx                landing page
   │  ├─ not-found.tsx           404
   │  ├─ suspended/page.tsx      shown to blocked accounts
   │  │
   │  ├─ (auth)/                 route group — centred card layout
   │  │  ├─ layout.tsx           logo + setup warning when env is missing
   │  │  ├─ login/               sign in
   │  │  ├─ register/            sign up
   │  │  ├─ forgot-password/     request reset link
   │  │  └─ reset-password/      set new password
   │  │
   │  ├─ (app)/                  route group — customer shell (sidebar + balance)
   │  │  ├─ layout.tsx           requireUser() guard, nav definition
   │  │  ├─ dashboard/           stats, quick actions, recent activity
   │  │  ├─ wallet/              balance, Paystack funding, statement
   │  │  ├─ numbers/             buy a number, live OTP panel
   │  │  ├─ boosting/            order followers/likes/views
   │  │  ├─ orders/              unified history + refund requests
   │  │  └─ support/             ticket list, ticket thread
   │  │
   │  ├─ admin/                  requireAdmin() guard on the layout
   │  │  ├─ page.tsx             overview
   │  │  ├─ users/               search, suspend, promote, adjust wallet
   │  │  ├─ transactions/        ledger + Paystack payments
   │  │  ├─ pricing/             markups, per-service prices, reprice all
   │  │  ├─ providers/           wiring, catalogue sync, balances
   │  │  ├─ refunds/             approve / reject queue
   │  │  ├─ support/             ticket queue
   │  │  └─ analytics/           funding vs sales chart, top services
   │  │
   │  ├─ api/
   │  │  ├─ wallet/fund/         start a Paystack checkout
   │  │  ├─ wallet/verify/       confirm on redirect back
   │  │  ├─ numbers/order/       price quote (GET) + purchase (POST)
   │  │  ├─ numbers/[id]/        poll status, sync messages
   │  │  ├─ numbers/[id]/cancel/ release + refund
   │  │  ├─ numbers/[id]/complete/ mark finished
   │  │  ├─ boosting/order/      quote (GET) + place order (POST)
   │  │  ├─ boosting/[id]/       poll progress
   │  │  ├─ refunds/             customer refund request
   │  │  ├─ webhooks/paystack/   payment authority
   │  │  └─ cron/                poll-numbers, sync-orders, sync-catalogue
   │  │
   │  └─ auth/
   │     ├─ callback/            exchange email link code for a session
   │     └─ signout/             clear session
   │
   ├─ components/
   │  ├─ ui.tsx                  Button, Card, Badge, Field, Table, Alert, StatCard…
   │  ├─ brand.tsx               Logo + inline icon set (no icon dependency)
   │  ├─ app-shell.tsx           sidebar + mobile nav, used by customer and admin
   │  ├─ auth/forms.tsx          login, register, forgot, reset forms
   │  ├─ wallet/fund-form.tsx    amount entry → Paystack redirect
   │  ├─ wallet/verify-banner.tsx confirms payment on return
   │  ├─ numbers/numbers-client.tsx  buy panel + live rentals with polling
   │  ├─ boosting/boosting-client.tsx service picker + progress list
   │  └─ orders/refund-button.tsx    inline refund request form
   │
   └─ lib/
      ├─ env.ts                  publicEnv (browser-safe) vs serverEnv() (throws in browser)
      ├─ money.ts                kobo helpers and formatting
      ├─ utils.ts                dates, countdown, references, OTP extraction
      ├─ types.ts                row shapes mirroring the SQL schema
      ├─ auth.ts                 getCurrentUser, requireUser, requireAdmin
      ├─ api.ts                  ApiError, ok/fail, parseBody, requireApiUser/Admin, cron guard
      ├─ wallet.ts               creditWallet, debitWallet, refundOrder
      ├─ pricing.ts              markup maths, rounding, per-quantity charges
      ├─ settings.ts             platform settings with 30s cache and env fallbacks
      ├─ supabase/               client.ts (browser), server.ts (SSR), admin.ts (service role)
      ├─ payments/
      │  ├─ paystack.ts          initialize, verify, HMAC webhook signature
      │  └─ credit.ts            applies a verified payment to the wallet (shared path)
      ├─ providers/
      │  ├─ http.ts              fetch with timeout, ProviderError, unit conversion
      │  ├─ sms/                 types.ts (contract), herosms.ts, mock.ts, index.ts
      │  └─ smm/                 types.ts (contract), rss.ts, mock.ts, index.ts
      └─ services/
         ├─ numbers.ts           quote, purchase, sync, cancel, complete
         ├─ boosting.ts          quote, order, sync, catalogue sync
         ├─ catalogue.ts         SMS catalogue sync, provider health
         └─ admin.ts             admin guard helper, analytics, audit logging
```

---

## 5. The data model

19 tables. Every money column is `bigint` holding **kobo**.

### Identity

| Table | Purpose | Notes |
| --- | --- | --- |
| `profiles` | One row per user, keyed to `auth.users.id` | `role` (`user`/`admin`), `status` (`active`/`suspended`/`banned`), `referral_code` |
| `wallets` | One row per user | `balance_kobo` with a `>= 0` check constraint |

A trigger on `auth.users` (`handle_new_user`) creates both rows on signup, so a user can never exist without a wallet.

### Money

| Table | Purpose |
| --- | --- |
| `wallet_transactions` | The ledger. Direction (`credit`/`debit`), category, amount, **balance before and after**, unique `reference`, free-form `metadata` |
| `payments` | Paystack checkout sessions: reference, amount, fees, channel, status, raw gateway payload |

`balance_before`/`balance_after` are stored on every row, so any balance can be audited without replaying the whole history.

### Virtual numbers

| Table | Purpose |
| --- | --- |
| `sms_countries` | Country list with the provider's own identifier in `provider_ref` |
| `sms_services` | WhatsApp, Telegram, … with `provider_ref` |
| `sms_pricing` | Cost and sell price per (provider, service, country, operator), plus stock and an optional markup override |
| `number_orders` | One rental: phone number, price, cost, status, OTP code, expiry, refund flag |
| `number_messages` | Every inbound SMS for an order (sender, body, extracted code) |

`number_orders.status`: `pending → waiting → received → completed`, or `cancelled` / `expired` / `refunded`.

### Boosting

| Table | Purpose |
| --- | --- |
| `smm_categories` | Instagram Followers, TikTok Views, … |
| `smm_services` | Panel service: provider id, min/max quantity, cost rate per 1k, sell rate per 1k, refill/cancel/dripfeed support |
| `smm_orders` | Link, quantity, charge, cost, start count, remains, status, drip-feed settings |

`smm_orders.status`: `pending → processing → in_progress → completed`, or `partial` / `cancelled` / `refunded` / `error`.

### Operations

| Table | Purpose |
| --- | --- |
| `refunds` | Customer-raised requests with an admin decision trail |
| `support_tickets` / `support_messages` | Threaded support; `is_staff` marks admin replies |
| `providers` | Metadata and health per integration — **never credentials** |
| `settings` | Key/value JSON platform configuration |
| `audit_logs` | Every admin action: actor, action, entity, metadata |

### Database functions (`0002_functions.sql`)

| Function | Purpose |
| --- | --- |
| `is_admin()` | `SECURITY DEFINER` check used inside RLS policies without recursion |
| `handle_new_user()` | Trigger creating profile + wallet on signup |
| `guard_profile_privileges()` | Trigger that reverts `role`, `status`, `notes` changes made by non-admins |
| `wallet_credit(...)` / `wallet_debit(...)` | The **only** way a balance changes |
| `admin_analytics(days)` | Whole admin dashboard in one aggregate query; granted to `service_role` only |

---

## 6. The money system

This is the part to understand before changing anything.

### Everything is kobo

1 NGN = 100 kobo. Balances, prices and provider costs are integers. No floats, no rounding drift. Paystack also quotes NGN in kobo, so no conversion happens at the payment boundary either.

Display formatting lives in `src/lib/money.ts` (`formatNaira`, `formatCompactNaira`); parsing user input is `parseNairaInput`, which rejects anything that is not a positive number with at most two decimals.

### Balances only move inside Postgres

```sql
wallet_credit(p_user, p_amount, p_category, p_reference, p_description, p_metadata)
wallet_debit (p_user, p_amount, p_category, p_reference, p_description, p_metadata)
```

Each function:

1. Locks the wallet row (`SELECT … FOR UPDATE`), so concurrent requests queue rather than race.
2. Computes the new balance; `wallet_debit` raises `INSUFFICIENT_FUNDS` if the balance is short.
3. Updates the wallet **and** inserts the ledger row in the same transaction.
4. Returns the ledger row.

Application code cannot update `wallets.balance_kobo` — nothing in the codebase does, and the customer-facing RLS policies grant no write access at all. `EXECUTE` on both functions is revoked from `anon` and `authenticated`; only `service_role` may call them.

### References are idempotency keys

`wallet_transactions.reference` is unique. Both functions first look for an existing row with that reference and return it unchanged if found. This makes the following harmless:

| Scenario | Key used | Result |
| --- | --- | --- |
| Paystack retries a webhook | `paystack:<reference>` | Second call returns the first ledger row; balance unchanged |
| Cron and an admin refund the same order | `refund:number:<order-id>` | One credit only |
| A user double-clicks a button | same reference | One row |

### Purchases debit first

Both purchase paths follow the same sequence:

1. **Debit the wallet.** If the balance is short, stop here — nothing was ordered.
2. **Call the provider.** If it throws, immediately credit the money back and return a clear error: *"You have not been charged."*
3. **Insert the order row.** If even this fails, refund again and surface a database error.

The alternative (call the provider first, then debit) would let a customer receive a number they never paid for. This order guarantees the platform never delivers unpaid value; the worst case is a refunded debit, which the ledger records honestly.

### Refunds

| Trigger | Where | Amount |
| --- | --- | --- |
| Number expired with no SMS | `syncNumberOrder` | Full price |
| Customer cancels a waiting number | `cancelNumberOrder` | Full price |
| Provider rejected the purchase | `purchaseNumber` / `createBoostOrder` | Full price |
| Boosting order cancelled upstream | `syncSmmOrder` | Full charge |
| Boosting order partially delivered | `syncSmmOrder` | Pro-rata on `remains` |
| Admin approves a request | `/admin/refunds` | Requested amount |

All of them call `refundOrder()` in `src/lib/wallet.ts`, which uses the key `refund:<type>:<order-id>`. Automatic and manual refunds therefore share one key and cannot both pay out.

---

## 7. Core flows, step by step

### 7.1 Signup and session

1. `RegisterForm` calls `supabase.auth.signUp` in the browser with `full_name` and `phone` in user metadata.
2. Supabase inserts into `auth.users`; the `handle_new_user` trigger creates `profiles` + `wallets`.
3. If email confirmation is on, the user gets a link to `/auth/callback?next=/dashboard`; that route handler exchanges the code for a session cookie and redirects.
4. On every subsequent request `src/proxy.ts` refreshes the session cookie and redirects signed-out visitors away from protected prefixes.
5. Pages call `requireUser()`, which loads profile + wallet and redirects to `/login` (signed out) or `/suspended` (blocked).

Route protection exists in two places on purpose: the proxy is a fast path, and each page and route handler re-checks. The proxy alone is never treated as an authorisation boundary.

### 7.2 Funding the wallet

```
FundWalletForm  ──POST /api/wallet/fund──►  validate amount against settings
                                            insert payments row (pending)
                                            Paystack /transaction/initialize
                ◄──authorization_url──────  store it on the payment row
   redirect ──►  Paystack hosted checkout
                                            ┌─ Paystack ──POST /api/webhooks/paystack
   redirect back to /wallet?reference=…     │  verify HMAC-SHA512 over raw body
   VerifyPaymentBanner ──POST /api/wallet/verify   applyPaystackSuccess()
                                            └─ credit wallet (idempotent)
```

Two paths converge on `applyPaystackSuccess()` in `src/lib/payments/credit.ts`:

- The **webhook** is the authority — it fires even if the customer closes the tab.
- The **verify call** on redirect makes the balance correct immediately instead of after webhook latency.

Whichever arrives first credits the wallet; the second is a no-op because the reference already exists. The credited amount is always the one **Paystack reports**, never the one the browser asked for.

### 7.3 Buying a virtual number

1. The numbers page renders services, countries and a price map built from `sms_pricing`.
2. Selecting a combination not in the price map triggers `GET /api/numbers/order` for a live quote (provider cost × markup, rounded up to the naira).
3. **Buy** → `POST /api/numbers/order`:
   - `quoteNumberPrice()` resolves the price again server-side — the browser's number is never trusted.
   - `debitWallet()` takes the money.
   - `provider.purchase()` requests a number; on failure the debit is reversed.
   - A `number_orders` row is written with status `waiting` and an expiry (default 20 minutes, from settings).
   - The ledger row is linked back to the order for the admin transaction view.
4. The client polls `GET /api/numbers/[id]` every 5 seconds and ticks a countdown every second.
5. Each poll runs `syncNumberOrder()`, which asks the provider for the order, stores any new messages in `number_messages`, extracts the OTP, and flips the status to `received`.
6. **Done with this number** → `POST /api/numbers/[id]/complete` releases it upstream and marks it `completed`.

### 7.4 A rental that fails

If the timer runs out with no SMS, either the customer's next poll or the `poll-numbers` cron detects it:

1. `syncNumberOrder()` sees provider status `expired`/`cancelled`, or that `expires_at` has passed.
2. If `auto_refund_expired` is on and the order has no messages, `refundOrder()` credits the full price.
3. The order becomes `refunded` and the number is released upstream.

Nothing is charged for a number that never worked, and the customer does not have to ask.

### 7.5 A boosting order

1. The boosting page lists categories and services with sell rates per 1,000.
2. The client computes a live total; the server recomputes it in `quoteBoostCharge()` and enforces the service's min/max.
3. `POST /api/boosting/order` debits, calls `provider.createOrder()`, reverses the debit on failure, then writes an `smm_orders` row.
4. The client polls `GET /api/boosting/[id]` every 10 seconds; `sync-orders` cron covers everyone else.
5. `syncSmmOrder()` updates status, `start_count` and `remains`, and issues a full or pro-rata refund if the panel cancels or partially delivers.

### 7.6 Refund request → decision

1. On the orders page, eligible orders show **Request refund**; `POST /api/refunds` files a `pending` row (money does not move).
2. The request appears in **Admin → Refunds** with the customer, order, amount and reason.
3. **Approve** credits the wallet through the shared idempotency key, marks the order `refunded`, stamps the decision, and writes an audit log entry. **Reject** records the note only.

---

## 8. The provider abstraction

The requirement was that HEROsms and Really Simple Social can be swapped later. The mechanism:

### One contract per product line

`src/lib/providers/sms/types.ts`:

```ts
export interface SmsProvider {
  readonly key: string;
  readonly label: string;
  isConfigured(): boolean;
  getBalanceKobo(): Promise<number>;
  listCountries(): Promise<SmsCountryOffer[]>;
  listServices(countryCode?: string): Promise<SmsServiceOffer[]>;
  purchase(input: SmsPurchaseInput): Promise<SmsOrder>;
  getOrder(providerOrderId: string): Promise<SmsOrder>;
  cancel(providerOrderId: string): Promise<void>;
  finish(providerOrderId: string): Promise<void>;
}
```

`src/lib/providers/smm/types.ts` does the same for boosting (`listServices`, `createOrder`, `getOrder`, `getOrders`, optional `cancelOrders` and `refill`).

Both contracts speak in **kobo** and in **normalised statuses**. `normaliseNumberStatus()` and `normaliseSmmStatus()` map the many spellings vendors use (`1`, `STATUS_WAIT_CODE`, `In progress`, `Canceled`…) onto our enums, so the rest of the codebase never sees vendor vocabulary.

### A registry, not a conditional

`src/lib/providers/sms/index.ts`:

```ts
const REGISTRY: Record<string, SmsProvider> = {
  herosms: heroSmsProvider,
  mock: mockSmsProvider,
};

export function getSmsProvider(key?: string): SmsProvider {
  return REGISTRY[key || serverEnv().smsProvider];
}
```

Orders store the `provider_key` they were placed with, so `syncNumberOrder()` calls the provider that actually owns the order — mid-flight orders keep working after a vendor switch.

### Mock adapters

`SMS_PROVIDER=mock` and `SMM_PROVIDER=mock` give in-memory implementations:

- A mock number delivers an OTP 15 seconds after purchase and expires after 5 minutes, so the buy → receive → complete and the expire → refund paths can both be demonstrated in a minute.
- A mock boosting order moves `pending → in_progress → completed` over about a minute with `remains` counting down.

This makes the platform demonstrable and testable before any commercial agreement exists.

### The HEROsms adapter — read this before going live

`src/lib/providers/sms/herosms.ts` targets a JSON REST API. Because the vendor's documentation was not available while building, two things are deliberately soft:

1. **Endpoint paths** are collected in a single `PATHS` map at the top of the file.
2. **Response reading** goes through a `pick(object, [names])` helper that accepts the usual naming variations (`number`/`phone`/`msisdn`, `id`/`order_id`/`activation_id`, and so on), and `unwrapList`/`unwrapObject` handle `{data: […]}`, `{results: […]}` or a bare array.

Authentication style is configurable with `HEROSMS_AUTH_SCHEME` (`bearer`, `header` for `x-api-key`, or `query`).

**Action for the integrator:** compare `PATHS` and the `map*` functions against the real HEROsms documentation and correct them. That one file is the entire blast radius. `src/lib/providers/smm/rss.ts` needs no such treatment — it implements the standard SMM panel API (form-encoded `key` + `action`), which RSS follows.

---

## 9. API reference

All responses share one envelope:

```jsonc
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "message": "Human readable.", "code": "machine_code" } }
```

Errors are raised as `ApiError` and converted by `handleRoute()`. Unexpected exceptions are logged server-side and returned as a generic message — provider and database internals are never echoed to the browser.

### Wallet

| Endpoint | Auth | Body / query | Returns |
| --- | --- | --- | --- |
| `POST /api/wallet/fund` | user | `{ amountKobo }` | `{ authorizationUrl, reference }` |
| `POST /api/wallet/verify` | user (owner) | `{ reference }` | `{ status: success\|pending\|failed, amountKobo }` |
| `POST /api/webhooks/paystack` | HMAC signature | Paystack event | `{ ok, applied }` |

`fund` enforces `min_funding_kobo` / `max_funding_kobo` from settings. `verify` refuses references belonging to another account. The webhook returns 401 on a bad signature and 200 once verified, even if processing fails, so Paystack does not retry forever — a stuck payment stays visible in **Admin → Transactions**.

### Virtual numbers

| Endpoint | Auth | Body / query | Returns |
| --- | --- | --- | --- |
| `GET /api/numbers/order` | user | `?serviceCode=&countryCode=` | `{ priceKobo }` |
| `POST /api/numbers/order` | user | `{ serviceCode, countryCode }` | `{ order }` (201) |
| `GET /api/numbers/[id]` | owner or admin | — | `{ order, messages }` (syncs first) |
| `POST /api/numbers/[id]/cancel` | owner or admin | — | `{ order }` refunded |
| `POST /api/numbers/[id]/complete` | owner or admin | — | `{ status: "completed" }` |

`cancel` refuses once a code has arrived (409) — the value was delivered.

### Boosting

| Endpoint | Auth | Body / query | Returns |
| --- | --- | --- | --- |
| `GET /api/boosting/order` | user | `?serviceId=&quantity=` | `{ chargeKobo }` |
| `POST /api/boosting/order` | user | `{ serviceId, link, quantity, runs?, intervalMinutes? }` | `{ order }` (201) |
| `GET /api/boosting/[id]` | owner or admin | — | `{ order }` (syncs first) |

### Refunds

| Endpoint | Auth | Body | Returns |
| --- | --- | --- | --- |
| `POST /api/refunds` | user (owner) | `{ orderType, orderId, reason }` | `{ status: "pending" }` (201) |

Rejects orders already refunded (409) and duplicate pending requests (409).

### Cron

| Endpoint | Auth | Frequency | Does |
| --- | --- | --- | --- |
| `GET /api/cron/poll-numbers` | `CRON_SECRET` | every minute | Syncs up to 100 live rentals; stores codes, expires and refunds |
| `GET /api/cron/sync-orders` | `CRON_SECRET` | every 5 min | Syncs up to 100 active boosting orders |
| `GET /api/cron/sync-catalogue` | `CRON_SECRET` | daily | Refreshes catalogues and provider balances |

Secret goes in `?secret=` or `Authorization: Bearer …`.

### Auth

| Endpoint | Purpose |
| --- | --- |
| `GET /auth/callback?code=&next=` | Exchanges an email-link code for a session, then redirects (only to relative paths) |
| `POST /auth/signout` | Clears the session, redirects home |

---

## 10. The customer app

| Page | What it does |
| --- | --- |
| **Landing** `/` | Product explanation, features, how it works, pricing preview, FAQ. Shows *Dashboard* instead of *Sign in* when a session exists. |
| **Dashboard** `/dashboard` | Balance, lifetime counts, recent spend, four quick actions, recent orders and wallet activity. |
| **Wallet** `/wallet` | Balance card, funding form with preset amounts, 50-row statement showing running balance, and recent Paystack attempts. Handles the `?reference=` return. |
| **Numbers** `/numbers` | Service and country pickers with live pricing and an affordability check; active rentals poll every 5s with a per-second countdown, copy buttons for number and code, cancel/complete actions; recent rentals below. |
| **Boosting** `/boosting` | Category → service → link → quantity, with min/max badges, refill/drip-feed indicators and a live total. Orders list shows a delivery progress bar. |
| **Orders** `/orders` | Tabs for numbers, boosting and refund requests; inline **Request refund** on eligible orders. |
| **Support** `/support` | New ticket form with category and priority; ticket list; `/support/[id]` is the thread with replies and a close action. |

Interaction details worth knowing:

- The buy buttons disable when the balance is short, and the reason is stated rather than failing at submit.
- Polling is driven by the set of live order ids; when nothing is live, no timers run.
- Copy buttons fail silently when the clipboard is blocked rather than showing an error the user cannot act on.

---

## 11. The admin area

Guarded by `requireAdmin()` on `src/app/admin/layout.tsx`. Admin forms use **Server Actions** rather than API routes — they are same-origin form posts, so there is no client JavaScript to ship and CSRF is handled by the framework.

| Page | Capabilities |
| --- | --- |
| **Overview** `/admin` | Wallet liability, 30-day funding/sales/refunds, net, user and order counts, an attention counter (pending refunds + open tickets), newest users, latest orders. |
| **Users** `/admin/users` | Search by email or name, filter by status, change status and role inline, credit or debit any wallet with a reason. Self-demotion is blocked. |
| **Transactions** `/admin/transactions` | Full ledger with category and reference filters and pagination, plus a Paystack payments view with fees and channel. |
| **Pricing** `/admin/pricing` | Default markups for both product lines; per-row cost and sell price editing with live margin percentages; **Recalculate all sell prices from cost**. |
| **Providers** `/admin/providers` | Which adapter each area uses and whether its credentials are present; catalogue sync buttons; balance refresh; enable/disable; last error per provider. |
| **Refunds** `/admin/refunds` | Queue filtered by status with pending count and value; approve (credits + marks the order) or reject with a note. |
| **Support** `/admin/support` | Ticket queue with priority and status filters; opens the same thread view customers see, and replies are marked `is_staff`. |
| **Analytics** `/admin/analytics` | 7/30/90-day range; funding vs sales bar chart rendered with plain divs (no chart library); OTP success rate; refund ratio; top services by revenue. |

Every mutating admin action writes to `audit_logs` through `logAdminAction()`.

---

## 12. Security model

### Row level security

RLS is enabled on all 18 application tables. The shape of the policies:

| Table group | Customer | Admin |
| --- | --- | --- |
| `profiles`, `wallets`, `wallet_transactions`, `payments` | Read own rows only | Read all |
| `number_orders`, `number_messages`, `smm_orders`, `refunds` | Read own rows | Read all |
| Catalogue (`sms_*`, `smm_*`) | Read active rows | Full write |
| `providers`, `settings`, `audit_logs` | No access | Full access |
| `support_tickets`, `support_messages` | Read/insert own; cannot post as staff | Full access |

`is_admin()` is `SECURITY DEFINER`, so policies can call it without recursing through the `profiles` policies.

### Privilege escalation is blocked in the database

Customers can update their own profile, but the `guard_profile_privileges` trigger reverts any change to `role`, `status` or `notes` unless the caller is an admin. A forged request that adds `role=admin` therefore fails at the database, not merely in the UI.

### Secrets

- Only `NEXT_PUBLIC_*` variables reach the browser: app name, site URL, Supabase URL, Supabase **anon** key, Paystack **public** key. Nothing else is even readable client-side.
- `serverEnv()` throws if evaluated in a browser context; `createSupabaseAdminClient()` does the same. A mistaken import becomes a loud error instead of a leaked key.
- Provider API keys live in environment variables. The `providers` table holds only names, base URLs, balances and health — by design, so a database compromise does not hand over vendor accounts.

### Payments

Webhook signatures are verified with HMAC-SHA512 over the **raw** request body, compared with `crypto.timingSafeEqual`. The credited amount comes from the verified Paystack payload, so a tampered client request cannot inflate a top-up.

### Input handling

Every route handler body is parsed with Zod before use. Validation failures return 422 naming the offending field. Prices, quantities and eligibility are always recomputed server-side; the browser's numbers are treated as hints for display only.

---

## 13. Scheduled jobs and operations

| Job | Cadence | Why it matters |
| --- | --- | --- |
| `poll-numbers` | 1 min | A customer may close the tab. This delivers the OTP into their history and refunds dead rentals on time. |
| `sync-orders` | 5 min | Boosting orders run for hours; this keeps statuses honest and triggers partial refunds. |
| `sync-catalogue` | daily | Provider prices and availability drift; this pulls new cost prices and re-derives sell prices. |

On Vercel, add to `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/poll-numbers?secret=YOUR_SECRET",   "schedule": "* * * * *" },
    { "path": "/api/cron/sync-orders?secret=YOUR_SECRET",    "schedule": "*/5 * * * *" },
    { "path": "/api/cron/sync-catalogue?secret=YOUR_SECRET", "schedule": "0 3 * * *" }
  ]
}
```

Elsewhere, any scheduler that can issue an authenticated GET will do.

**Catalogue sync is conservative:** a sell price that an admin set by hand (no markup override recorded) is left alone; only cost prices and availability are refreshed.

---

## 14. Environment variables

| Variable | Scope | Required | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | public | no | Brand name in UI and metadata |
| `NEXT_PUBLIC_SITE_URL` | public | yes | Paystack callback and email links |
| `NEXT_PUBLIC_SUPABASE_URL` | public | **yes** | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | **yes** | Client auth and RLS-scoped reads |
| `SUPABASE_SERVICE_ROLE_KEY` | server | **yes** | Wallet, orders, provider writes |
| `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` | public | no | Reserved for inline checkout |
| `PAYSTACK_SECRET_KEY` | server | for payments | Initialize, verify, webhook signature |
| `PAYSTACK_BASE_URL` | server | no | Defaults to `https://api.paystack.co` |
| `SMS_PROVIDER` | server | no | `herosms` or `mock` (default `mock`) |
| `HEROSMS_BASE_URL` | server | for numbers | API base |
| `HEROSMS_API_KEY` | server | for numbers | Credential |
| `HEROSMS_AUTH_SCHEME` | server | no | `bearer` (default), `header`, `query` |
| `HEROSMS_API_KEY_PARAM` | server | no | Query parameter name when scheme is `query` |
| `SMM_PROVIDER` | server | no | `rss` or `mock` (default `mock`) |
| `RSS_API_URL` | server | for boosting | Panel endpoint |
| `RSS_API_KEY` | server | for boosting | Credential |
| `DEFAULT_SMS_MARKUP_PERCENT` | server | no | Fallback markup (default 25) |
| `DEFAULT_SMM_MARKUP_PERCENT` | server | no | Fallback markup (default 20) |
| `CRON_SECRET` | server | for cron | Shared secret for job endpoints |

Markups set in **Admin → Pricing** are stored in `settings` and take precedence over the env defaults.

---

## 15. Running and deploying

### Local

```bash
npm install
cp .env.example .env.local     # fill in Supabase at minimum
npm run dev                    # http://localhost:3000
```

Apply `supabase/migrations/0001` → `0002` → `0003` and optionally `seed.sql` in the Supabase SQL editor, then sign up and promote yourself:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

With `SMS_PROVIDER=mock` and `SMM_PROVIDER=mock` the full order flows work immediately.

### Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build **and** full type check |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |

### Deploying to Vercel

1. Push the repository and import it — Next.js is detected automatically.
2. Add every server variable from the table above, and set `NEXT_PUBLIC_SITE_URL` to the production domain.
3. Point the Paystack webhook at `https://<domain>/api/webhooks/paystack`.
4. Add the production domain and `/auth/callback` to Supabase → Authentication → URL Configuration.
5. Add `vercel.json` crons.
6. Deploy, then run the catalogue syncs from **Admin → Providers**.

The app runs anywhere Node 20+ runs; nothing is Vercel-specific except the cron declaration.

---

## 16. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Auth pages show "Supabase is not configured" | `NEXT_PUBLIC_SUPABASE_*` missing | Fill `.env.local`, restart the dev server (public vars are inlined at build) |
| Purchases fail with "wallet and provider operations need it" | `SUPABASE_SERVICE_ROLE_KEY` missing | Add it; it is server-only and never exposed |
| Admin overview shows "Analytics unavailable" | Migration `0002` not applied | Run the functions migration |
| Every protected page redirects to `/login` | No session, or cookies blocked | Confirm the Supabase redirect URL matches the origin |
| Wallet not credited after payment | Webhook unreachable | Check Paystack webhook logs; loading `/wallet?reference=…` verifies the same payment |
| Numbers page says "Unavailable" | No `sms_pricing` row and provider not configured | Run seed, or set credentials and sync from Admin → Providers |
| Boosting page has no services | Catalogue never synced | **Admin → Providers → Sync**, or run `seed.sql` |
| Provider calls time out | Wrong base URL or blocked egress | Adapters time out at 20s and surface `ProviderError`; check **Admin → Providers** last error |

---

## 17. How to extend it

### Add a virtual-number vendor

1. Create `src/lib/providers/sms/<vendor>.ts` exporting an object satisfying `SmsProvider`.
2. Map its statuses with `normaliseNumberStatus()` and convert prices with `majorToKobo()`.
3. Register it in `src/lib/providers/sms/index.ts`.
4. Set `SMS_PROVIDER=<vendor>` and redeploy. Existing orders keep syncing through their stored `provider_key`.

The same three steps apply to boosting panels with `SmmProvider`.

### Add a payment gateway

Mirror `src/lib/payments/paystack.ts` (initialize / verify / verify-signature), add a route under `src/app/api/webhooks/`, and reuse `applyPaystackSuccess()` as the template — the wallet credit itself is gateway-agnostic.

### Add a product line

1. Tables and RLS in a new migration.
2. A provider contract and adapter under `src/lib/providers/`.
3. A service module under `src/lib/services/` following the debit → call → reverse-on-failure pattern.
4. Route handlers under `src/app/api/`, a page under `src/app/(app)/`, and a nav entry in `src/app/(app)/layout.tsx`.

### Turn on strict database types

```bash
npx supabase gen types typescript --project-id <ref> > src/lib/supabase/database.types.ts
```

Then re-export `Database` from `src/lib/supabase/types.ts` in place of the loose `Db` alias. The row interfaces in `src/lib/types.ts` become redundant at that point.

---

## 18. Known gaps

Honest list of what an MVP does not yet have:

- **Supabase types are not generated.** Clients use a loose type; row shapes are hand-mirrored in `src/lib/types.ts` and can drift from the SQL if someone changes one without the other.
- **No automated tests.** The money paths — idempotency, reverse-on-failure, partial refunds — are the first things that deserve coverage.
- **The HEROsms endpoint map is unverified** against vendor documentation. See §8.
- **No email notifications** for delivered orders, approved refunds or support replies.
- **Referral codes are generated but unused** — no reward logic.
- **Pricing is edited row by row**; no CSV import or bulk rules beyond the global markup and *reprice all*.
- **No rate limiting** on order endpoints beyond the wallet balance itself.
- **Support attachments** are not implemented (text only).
- **The SQL has not been executed** in this environment — it was written and reviewed but never run against a live Postgres, so treat the first migration run as the real smoke test.
