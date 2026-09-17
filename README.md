# Sabitest

Reseller platform for **virtual numbers** (OTP verification) and **social boosting**, paid from a single Naira wallet.

- **Frontend + backend:** Next.js 16 (App Router, TypeScript, Tailwind v4)
- **Auth + database:** Supabase (Postgres, RLS)
- **Payments:** Paystack (wallet funding)
- **Virtual numbers:** HEROsms (behind a swappable adapter)
- **Social boosting:** Really Simple Social (behind a swappable adapter)

Provider API keys are read from server environment variables only. They are never stored in the database and never reach the browser.

---

## Quick start

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

The app boots with `SMS_PROVIDER=mock` and `SMM_PROVIDER=mock`, so you can click through the entire buy → receive OTP → refund flow before you have any provider credentials. You still need Supabase for auth and data.

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **Project Settings → API** — copy into `.env.local`:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (server only — never expose)
3. Run the migrations, in order, in the SQL editor:
   - `supabase/migrations/0001_schema.sql`
   - `supabase/migrations/0002_functions.sql`
   - `supabase/migrations/0003_rls.sql`
   - `supabase/seed.sql` (optional starter catalogue and settings)

   Or with the CLI:

   ```bash
   npx supabase link --project-ref <your-ref>
   npx supabase db push
   ```

4. **Authentication → URL Configuration** — set Site URL to your origin (e.g. `http://localhost:3000`) and add `<origin>/auth/callback` as a redirect URL.

### 2. Become an admin

Sign up through the app, then run in the SQL editor:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

`/admin` is then reachable from the sidebar.

### 3. Paystack

1. Copy your test keys from **Settings → API Keys & Webhooks** into `PAYSTACK_SECRET_KEY` and `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY`.
2. Set the webhook URL to `https://<your-domain>/api/webhooks/paystack`.
3. Locally, expose your dev server (`ngrok http 3000`) and point the webhook there, or rely on the redirect-based verification at `/wallet?reference=…` which confirms the same payment.

Amounts are in kobo end to end, which is also Paystack's unit for NGN — no conversion anywhere.

### 4. Providers

| Area | Env switch | Values | Credentials |
| --- | --- | --- | --- |
| Numbers | `SMS_PROVIDER` | `herosms`, `mock` | `HEROSMS_API_KEY`, `HEROSMS_BASE_URL` |
| Boosting | `SMM_PROVIDER` | `rss`, `mock` | `RSS_API_KEY`, `RSS_API_URL` |

Once credentials are in place, go to **Admin → Providers** and run *Sync from …* to pull countries, services and cost prices into the database. Sell prices are derived from cost × markup (**Admin → Pricing**) and rounded up to the nearest naira.

> **HEROsms note:** the adapter in `src/lib/providers/sms/herosms.ts` targets a JSON REST API with the endpoint paths listed in its `PATHS` map and tolerant field mapping. Confirm those paths and field names against your HEROsms account documentation before going live — that one file is the only thing you need to change.
>
> **Really Simple Social** uses the standard SMM panel API (`key` + `action` form posts), which `src/lib/providers/smm/rss.ts` implements as-is.

### 5. Scheduled jobs

Set `CRON_SECRET`, then schedule these (Vercel Cron, GitHub Actions, cron-job.org, …):

| Endpoint | Frequency | Does |
| --- | --- | --- |
| `/api/cron/poll-numbers?secret=…` | every minute | Stores OTPs that arrived while nobody was watching; expires and refunds dead rentals |
| `/api/cron/sync-orders?secret=…` | every 5 minutes | Updates boosting order progress; refunds cancelled or partial orders |
| `/api/cron/sync-catalogue?secret=…` | daily | Refreshes provider catalogues and balances |

The secret can go in the query string or an `Authorization: Bearer` header.

---

## How the money works

All amounts are integer **kobo** (1 NGN = 100 kobo). Floats never touch a balance.

- Balances only ever change through the Postgres functions `wallet_credit` / `wallet_debit`, which lock the wallet row and write a ledger entry in the same transaction. Application code cannot update `wallets.balance_kobo` directly.
- Every movement carries an optional `reference` that acts as an **idempotency key**. A replayed Paystack webhook, a double-clicked refund, or a cron job racing an admin all resolve to one ledger row.
- Purchases **debit first, then call the provider**. If the provider fails, the debit is reversed immediately and the customer sees "you have not been charged".
- Refunds are keyed `refund:<type>:<order-id>`, so automatic expiry refunds and admin-approved refunds can never both pay out.

## Security model

- **RLS on every table.** Customers can read only their own rows; the catalogue is read-only to them; pricing, providers and settings are admin-only.
- **The browser has no write path to money.** Wallets, ledgers and orders are written exclusively by the server using the service-role key.
- `src/lib/supabase/admin.ts` throws if it is ever evaluated in a browser bundle; `serverEnv()` does the same.
- Paystack webhooks are verified with HMAC-SHA512 over the raw body, compared in constant time.
- Role and status changes are stripped from customer-initiated profile updates by a database trigger, so a customer cannot promote themselves by editing a request.
- Admin actions (user changes, wallet adjustments, refunds, pricing, syncs) are written to `audit_logs`.

## Project structure

```
src/
├─ app/
│  ├─ page.tsx                 landing
│  ├─ (auth)/                  login, register, forgot/reset password
│  ├─ (app)/                   dashboard, wallet, numbers, boosting, orders, support
│  ├─ admin/                   overview, users, transactions, pricing, providers,
│  │                           refunds, support, analytics
│  ├─ api/
│  │  ├─ wallet/               fund, verify
│  │  ├─ numbers/              order, [id] status, cancel, complete
│  │  ├─ boosting/             order, [id] status
│  │  ├─ refunds/              customer refund requests
│  │  ├─ webhooks/paystack/    payment authority
│  │  └─ cron/                 poll-numbers, sync-orders, sync-catalogue
│  └─ auth/                    callback, signout
├─ components/                 ui kit, app shell, feature clients
├─ lib/
│  ├─ providers/
│  │  ├─ sms/                  types.ts (contract), herosms.ts, mock.ts, index.ts
│  │  └─ smm/                  types.ts (contract), rss.ts, mock.ts, index.ts
│  ├─ payments/                paystack.ts, credit.ts
│  ├─ services/                numbers.ts, boosting.ts, catalogue.ts, admin.ts
│  ├─ supabase/                client.ts, server.ts, admin.ts
│  └─ auth.ts, wallet.ts, pricing.ts, settings.ts, api.ts, money.ts, env.ts
└─ proxy.ts                    session refresh + route guarding
```

## Swapping a provider

1. Write `src/lib/providers/sms/<vendor>.ts` (or `smm/`) implementing the `SmsProvider` / `SmmProvider` interface from `types.ts`.
2. Add one line to the `REGISTRY` map in that folder's `index.ts`.
3. Point `SMS_PROVIDER` / `SMM_PROVIDER` at the new key and redeploy.

Nothing outside those folders knows a vendor name — pages, routes and services only see the interface.

## Scripts

```bash
npm run dev        # development server
npm run build      # production build (also type-checks)
npm run start      # serve the production build
npm run typecheck  # tsc --noEmit
```

## Known gaps for after the MVP

- Supabase types are not generated yet — `src/lib/supabase/types.ts` explains how to switch on strict typing.
- No automated tests.
- Email notifications (order delivered, refund approved) are not wired up.
- Referral codes are generated on signup but no referral rewards are paid.
- Admin pricing edits one row at a time; there is no CSV import.
