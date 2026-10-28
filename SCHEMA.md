# The Supabase (PostgreSQL) schema

`supabase/schema.sql` builds the **whole database** for SmartSpend in one Supabase project: 15
tables, 3 reporting views, 20 triggers/functions, Row Level Security on every table, and a private
`receipts` bucket. `supabase/verify.sql` then proves the behaviour with 28 self-checking assertions.

> **Read this first.** The schema is **ready**, but the app in this repository still reads and
> writes its **local SQLite file**. Supabase currently holds accounts, profiles, receipts and — from
> this version — a complete, empty database ready for the finance data. Section 6 lists what is left
> to do. Nothing below claims the app is already using these tables.

---

## 1. How to run it

1. Supabase dashboard → **SQL Editor** → **New query** → paste **all** of `supabase/schema.sql` → **Run**.
   Expected: `Success. No rows returned`. Re-running is safe (every statement is idempotent).
2. Optional but recommended: paste `supabase/verify.sql` → Run.
   It prints 28 `PASS` lines in the *Notices* panel and ends with `ROLLBACK`, so it leaves **no rows**
   behind. Any failure raises an error, which also undoes everything.

Check afterwards:

```sql
select table_name from information_schema.tables where table_schema = 'public' order by 1;  -- 15 tables
select table_name from information_schema.views  where table_schema = 'public';             -- 3 views
select count(*) from pg_tables where schemaname = 'public' and rowsecurity;                -- 15 (RLS on)
select count(*) from pg_policies where schemaname = 'public';                              -- 60 policies
```

---

## 2. Tables

Every table carries `id uuid primary key`, `user_id uuid` (default `auth.uid()`), and timestamps.
Money is **`*_minor bigint` = integer paise**; a generated `amount` column shows rupees.

| # | Table | Holds | Notes |
|---|---|---|---|
| 1 | `profiles` | one row per auth user | created by a trigger on `auth.users`; `id` **is** the user id |
| 2 | `workspaces` | the two books: `individual`, `business` | `unique (user_id, type)` — one book per mode per user |
| 3 | `customers` | business parties | `is_archived` instead of deleting |
| 4 | `vendors` | business suppliers | same shape as customers |
| 5 | `recurring_rules` | "₹3,000 rent every month on the 5th" | nothing is generated until you ask |
| 6 | `transactions` | income / expenses | `type in ('income','expense')`, amount `> 0` |
| 7 | `budgets` | one monthly budget per book | `unique (workspace_id, month)` |
| 8 | `category_budgets` | per-category monthly limits | `unique (workspace_id, month, category)` |
| 9 | `savings_goals` | target amount + date | progress is always `SUM(contributions)` |
| 10 | `savings_goal_contributions` | money actually put aside | may be negative (a withdrawal) |
| 11 | `invoices` | header + totals | totals written by a trigger, never by the client |
| 12 | `invoice_items` | lines: qty × price + tax % | `line_total_minor` computed by a trigger |
| 13 | `invoice_payments` | money received | over-payment blocked by a trigger |
| 14 | `vendor_bills` | money the business owes | `unique (workspace_id, vendor_id, bill_number)` |
| 15 | `vendor_bill_payments` | money paid out | same guards as invoice payments |

### Views (all `security_invoker = true`, so RLS still applies inside them)

| View | Returns |
|---|---|
| `invoice_balances` | per invoice: `paid_minor`, `balance_minor`, and a **derived** `status` (`draft` / `open` / `partial` / `paid` / `overdue` / `cancelled`) |
| `vendor_bill_balances` | the same for bills |
| `workspace_totals` | income, expenses, balance and row count per book |

---

## 3. Design decisions (and why)

**`user_id` on every table.** The RLS predicate is one line — `user_id = auth.uid()` — and it is
indexed. `auth.uid()` is filled in by Postgres from the caller's JWT, so a browser cannot forge it.

**Composite foreign keys `(workspace_id, user_id)`.** Child rows cannot point at another user's
book, even if the API is buggy: `foreign key (workspace_id, user_id) references workspaces (id,
user_id)`. This replaces the app's "trust the workspace header" check with a database guarantee.

**Invoice status is never stored.** It is computed in `invoice_balances` from the payments plus the
due date. That is why opening or printing an invoice can never mark it paid — only recorded money can.

**Totals come from triggers, not from the browser.**
`invoice_items_set_line_total()` forces `line_total_minor = round(quantity × unit_price_minor)` and
`invoices_recalculate_totals()` rewrites `subtotal/tax/total` from the lines, using exactly the
formula in `src/money.js`:
`subtotal = Σ line`, `tax = Σ round(line × rate / 100)`, `total = subtotal + tax`.
A client that posts `total_minor: 1` is simply ignored (the verify script checks this: ₹4,040 wins).

**Payments are guarded.** `invoice_payments_check_amount()` locks the invoice row (`for update`), then
refuses anything larger than the outstanding balance, and refuses any payment on a cancelled invoice.
`unique (invoice_id, paid_on, amount_minor, reference)` blocks the classic double-submit — `reference`
is `NOT NULL DEFAULT ''` because Postgres treats `NULL` values as distinct.

**Money is `bigint` paise, dates are `date`, flags are `boolean`.**
The SQLite file uses `TEXT` dates and `0/1` integers; Postgres validates dates itself. Mapping:

| SQLite | Postgres |
|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `uuid primary key default gen_random_uuid()` |
| `amount_minor INTEGER` | `amount_minor bigint` (+ generated `amount numeric(14,2)`) |
| `transaction_date TEXT 'YYYY-MM-DD'` | `transaction_date date` |
| `is_draft INTEGER 0/1` | `is_draft boolean` |
| `created_at TEXT datetime('now')` | `created_at timestamptz default now()` |
| `month TEXT 'YYYY-MM'` | same, with a `CHECK (month ~ '^\d{4}-(0[1-9]\|1[0-2])$')` |

---

## 4. Security model in one table

| Role | What it can do |
|---|---|
| `anon` (no token) | **nothing** — no grants on any table, and RLS would return zero rows anyway |
| `authenticated` (signed-in user) | read / insert / update / delete **only rows where `user_id = auth.uid()`** |
| `service_role` (secret key — never in the browser) | everything; bypasses RLS. Used only by server jobs |
| SQL editor / table editor | runs as the database owner, so it bypasses RLS — that is why you can see all rows in the dashboard |

`anon` is revoked explicitly, and default privileges are set so tables added later are not granted to
`anon` either.

---

## 5. What `verify.sql` actually checks (28 assertions)

Signup creates a profile and both books · line totals are recomputed (3×₹1,000 + 1×₹500 = ₹3,500) ·
client-sent invoice totals ignored (₹4,040) · tax = ₹540 at 18% · status `open` → `partial` → `paid` ·
outstanding balance arithmetic · over-payment rejected · duplicate payment rejected · cancelled
invoice refuses payment · cancelled status derived · duplicate invoice number rejected per book ·
recurring rule cannot duplicate a date · cannot create a row for another user · Bob sees none of
Alice's customers / invoices / transactions / view rows · Bob cannot write into Alice's book ·
logged-out role cannot read · deleting a book cascades its invoices and customers but leaves the
other book intact.

Result on a clean PostgreSQL 17 database with the Supabase auth/storage objects stubbed:
**28/28 PASS, ending in `ROLLBACK` with 0 leftover rows.**

---

## 6. How the app gets data into these tables (new in 2.4)

The tables are no longer "just sitting there". On every write the browser copies the local
bookkeeping into Postgres, so whatever you type into a form shows up in the Supabase table editor.

**What actually happens**

1. You save something (a transaction, a budget, an invoice …). It is written to SQLite by the
   Express API exactly as before — that write is the one that must succeed.
2. `public/js/sync.js` waits ~2.5 s for you to stop clicking, then reads the whole local book back
   through `/api/*` (`readLocal()`), and **mirrors the snapshot**:
   `delete from … where user_id = auth.uid()` for each table in `DELETE_ORDER`, then `insert` in
   `INSERT_ORDER` (parents before children).
3. The Settings card (**Settings → Supabase copy**) shows the state: `copied · 40 rows ·
   just now`, or the exact error, plus a **Copy to Supabase now** button.

Deleting *only your own rows* and re-inserting is what makes it idempotent: pushing twice cannot
duplicate anything, deleted local rows disappear remotely, and a second account's rows are never
touched (`user_id` comes from the column default `auth.uid()`, so the browser cannot claim to be
someone else and RLS applies to every statement).

| Step | Status |
|---|---|
| Schema (this file) | **done and tested** (28 assertions) |
| Auth, profiles, receipts bucket | **done and tested** (`docs/SUPABASE.md`) |
| One-way mirror of the local book into these tables | **done and tested** (2.4 — see above) |
| Repositories reading/writing Supabase instead of SQLite | **not started** (the tables are a copy, not the source of truth) |
| Server verifying the Supabase JWT on `/api/*` | **not started** |

**What the mirror does not do** — do not claim otherwise in a viva or a report:

- It is **one-way, SQLite → Postgres**. Editing a row in the Supabase table editor does not change
  the app; the next push overwrites it. Postgres is a searchable, shareable copy, not the master.
- It runs **in the browser**, so it needs the tab to be open. Nothing is copied while the laptop is
  shut — `autoPushOnLoad()` catches up on the next visit.
- Local mode (`Continue without an account`) sends nothing at all.
- Money is copied as integer `amount_minor`; derived columns (`subtotal_minor`, `tax_minor`,
  `total_minor`, `balance_minor`, statuses, counts) are **never sent** — the triggers in §11
  compute them, which is also the test that they are right.
- `budgets` has no local integer id, so it carries `local_id = null` and is keyed by
  workspace + month.

The remaining work is still the adapter in `src/repositories/`: swap `better-sqlite3` calls for
PostgREST (or `pg`) calls, keep the same function signatures, and let every existing test run
unchanged. The column names were chosen to match the SQLite schema exactly so that swap stays
mechanical — the only real differences are uuid ids, `date`/`boolean` types and `user_id`.
