# SmartSpend — Smart Personal & Business Expense Tracker

> **Your money, clearly organised.**

SmartSpend is a complete, working finance dashboard built as a **B.Tech CSE mini project**.
You can record income and expenses, filter and search them, set monthly budgets, save towards
goals, and see live charts and insights — all stored permanently in a local **SQLite** database.

**Version 2.2 added a real login.** Opening the app now shows a sign-in page backed by
**Supabase Auth** (create account, sign in, sign out, password-reset email). You can also press
*Continue without an account* to use everything offline in local mode. See
[§18](#18-accounts-and-supabase-new-in-22) and `docs/SUPABASE.md`.

**Version 2.3 adds the database for Supabase.** `supabase/schema.sql` now builds the complete
PostgreSQL schema — 15 tables (both books, invoices, payments, budgets, goals, recurring rules),
3 reporting views, integrity triggers that enforce the money rules inside the database, and 60
Row Level Security policies so a user can only ever touch their own rows. `supabase/verify.sql`
proves it with 28 assertions. Full documentation: **`docs/SCHEMA.md`**.

**Version 2.0 adds a second mode.** The same app now runs as two separate books:

| Mode | For | Main screens |
|---|---|---|
| **Individual** | personal money | Dashboard, Transactions, Budgets, Savings Goals, Recurring, Analytics, Insights, Reports, Settings |
| **Business** | a small business or shop | Business Dashboard, Transactions, Customers, Vendors, Invoices, Bills & Payables, Cash Flow, Reports, Settings |

On the very first visit a short welcome card asks **"What will you use SmartSpend for?"** —
Individual or Business — and opens that book. A switch at the top of the sidebar moves between them
afterwards. Each mode has its own workspace id in the database, so a personal report can never
contain a business sale (or the other way round).
Individual mode stays as simple as it was in 1.0 — the business machinery is invisible there.

The interface is a modern single-page dashboard (no page reloads), but the code stays
beginner-friendly: plain HTML, CSS and vanilla JavaScript, plus a small Express + SQLite backend.

---

## Table of contents

1. [What you get](#1-what-you-get)
2. [Technology stack](#2-technology-stack)
3. [Folder structure](#3-folder-structure)
4. [Setup and run (step by step)](#4-setup-and-run-step-by-step)
5. [How to stop, restart and reset](#5-how-to-stop-restart-and-reset)
6. [Screens and features](#6-screens-and-features)
7. [**How Individual and Business modes differ**](#7-how-individual-and-business-modes-differ)
8. [Database design explained](#8-database-design-explained)
9. [API endpoint documentation](#9-api-endpoint-documentation)
10. [Formulas used](#10-formulas-used)
11. [Security and validation](#11-security-and-validation)
12. [Charts and the internet connection](#12-charts-and-the-internet-connection)
13. [Automated tests](#13-automated-tests)
14. [Manual testing checklist](#14-manual-testing-checklist)
15. [Troubleshooting](#15-troubleshooting)
16. [Extra documents for submission](#16-extra-documents-for-submission)
17. [Limitations and honest notes](#17-limitations-and-honest-notes)
18. [**Accounts and Supabase (new in 2.2)**](#18-accounts-and-supabase-new-in-22)
19. [**Putting it online (and why GitHub Pages can't)**](#19-putting-it-online-and-why-github-pages-cant)

---

## 1. What you get

| Deliverable | Where |
|---|---|
| Frontend source (HTML, CSS, vanilla JS) | `public/` |
| Backend source (Express REST API) | `server.js`, `src/` |
| SQLite initialisation + schema | `database.js` |
| Package configuration | `package.json` |
| Versioned database migrations | `src/migrations/` (6 migrations, append-only) |
| Automated API tests (79 checks) | `test/api.test.js` |
| Automated 2.0 acceptance tests (138 checks) | `test/business.test.js` |
| Automated migration tests (23 checks) | `test/migration.test.js` |
| API reference for every endpoint | `docs/API.md` |
| Step-by-step test script | `docs/TEST_STEPS.md` |
| Acceptance-criteria report (15 items) | `docs/ACCEPTANCE.md` |
| Project report outline | `docs/PROJECT_REPORT.md` |
| Viva questions & answers | `docs/VIVA_QUESTIONS.md` |
| **Supabase setup + what it does/does not protect** | `docs/SUPABASE.md` |
| **Database schema documentation (15 tables, 3 views, 60 RLS policies)** | `docs/SCHEMA.md` |
| Supabase SQL: the whole database + integrity triggers + receipts bucket | `supabase/schema.sql` |
| Supabase self-test (28 assertions, rolls back) | `supabase/verify.sql` |
| Optional demo data scripts | `scripts/seed-demo.js` (personal), `scripts/seed-business-demo.js` (business) |
| Login page + auth guard | `public/login.html`, `public/js/login.js`, `public/js/auth-guard.js` |
| Browser test suites (Playwright, optional) | `tests-ui/` — 6 scripts, 151 checks in total |
| **Deployment guide (GitHub Pages can't run this)** | `docs/DEPLOY.md` |
| Container + Render blueprint | `Dockerfile`, `render.yaml`, `.dockerignore` |
| Supabase client (no external library) | `public/js/supabase-config.js`, `public/js/supabase-client.js` |
| Copying the local book into Supabase | `public/js/sync.js` |
| Settings → Account & cloud card | `public/js/cloud.js` |

Everything is real and connected: the dashboard numbers come from SQLite on every page load.
There is no hardcoded total and no `localStorage` pretending to be a database.

---

## 2. Technology stack

**Frontend**

- HTML5 — one page (`public/index.html`) containing five views.
- CSS3 — design tokens, light/dark themes, responsive breakpoints, animations (`public/style.css`).
- Vanilla JavaScript — `fetch()` calls, validation, filtering, DOM updates, charts (`public/app.js`).
- Chart.js 4.4.6 — bar and doughnut charts.

**Backend**

- Node.js (LTS) — JavaScript runtime.
- Express 4 — REST API and static file server.
- JSON for all request/response bodies.

**Database**

- SQLite via `better-sqlite3` — a normal file (`expense-tracker.db`) that is created automatically.
- No MySQL, no XAMPP, no phpMyAdmin, no Docker, no separate database server.

**Accounts (new in 2.2)**

- Supabase Auth + PostgREST over plain `fetch()` — a hand-written 300-line client
  (`public/js/supabase-client.js`), so **no `@supabase/supabase-js` bundle** and still no build step.
- Supabase Postgres stores `profiles` (one row per account) and a private `receipts` bucket.
- **The money tables are still SQLite — but they are mirrored into Postgres.** Saving anything
  re-copies the local book into the Supabase tables ~3 s later (`public/js/sync.js`), so the data
  shows up in the Supabase table editor. It is a **one-way copy**: SQLite stays the source of truth.
  Honest details in [§18](#18-accounts-and-supabase-new-in-22) and `docs/SCHEMA.md` §6.

**Intentionally NOT used:** React, Angular, Vue, Next.js, TypeScript, Tailwind CSS, jQuery,
MongoDB, ORMs. The project stays readable for a second-year student.

---

## 3. Folder structure

```
smartspend-expense-tracker/
├── package.json              # dependencies + npm scripts
├── server.js                 # entry point: Express app, static files, error handler
├── database.js               # opens expense-tracker.db, enables WAL + foreign keys, runs migrations
├── README.md                 # this file
├── tests-ui/                 # the Playwright browser suites (optional, see §13)
│   ├── ui2.js · features.js · authtest.js · authtest2.js · previewtest.js · synctest.js
│   ├── prepare.sh            # builds a throwaway DB for them
│   └── README.md
├── .gitignore                # keeps node_modules and the .db file out of git
│
├── src/                      # backend modules (kept small and focused)
│   ├── money.js              # integer-paise helpers: toMinor, toRupees, line + document totals
│   ├── validation.js         # every allow-list and input check, ApiError helpers
│   ├── csv.js                # safe CSV building (formula-injection guard) + download headers
│   ├── migrations/
│   │   ├── index.js          # append-only migration runner (one transaction per migration)
│   │   └── 001…006_*.js      # 001 init → 006 bill notes
│   ├── routes/
│   │   ├── api.js            # personal + shared REST routes (1.0 contract preserved)
│   │   └── business.js       # all /api/business/* routes
│   └── repositories/         # every SQL statement lives here
│       ├── workspaces.js     ├── transactions.js   ├── budgets.js
│       ├── analytics.js      ├── reports.js        ├── parties.js
│       ├── invoices.js       ├── vendorBills.js    ├── goals.js
│       └── recurring.js
│
├── public/                   # frontend (served at http://localhost:3000)
│   ├── index.html            # one page, every screen as a <section data-view="…">
│   ├── style.css             # design tokens, themes, responsive rules
│   ├── app.js                # shared core: state, api(), mode switcher, personal screens
│   ├── js/
│   │   ├── business.js       # business dashboard, customers, vendors, bills, cash flow, reports
│   │   ├── invoices.js       # invoice list, editor, viewer/print, payments
│   │   └── personal-extras.js# savings goals, recurring, reports, settings
│   └── assets/
│       ├── favicon.svg
│       └── vendor/chart.umd.min.js   # offline copy of Chart.js
│
├── test/
│   ├── api.test.js           # 1.0 personal CRUD/analytics (79 checks)
│   ├── business.test.js      # 2.0 acceptance suite (138 checks)
│   └── migration.test.js     # migrations + data preservation (23 checks)
│
├── scripts/
│   ├── seed-demo.js          # OPTIONAL personal demo data
│   └── seed-business-demo.js # OPTIONAL business demo data (only touches the business book)
│
├── docs/
│   ├── API.md                # endpoint-by-endpoint reference
│   ├── TEST_STEPS.md         # manual test script
│   ├── ACCEPTANCE.md         # the 15 acceptance criteria, verified
│   ├── PROJECT_REPORT.md     # abstract → future scope
│   ├── VIVA_QUESTIONS.md     # viva preparation
│   └── screenshots/          # pictures used in the report
│
└── expense-tracker.db        # generated automatically on first run (not committed)
```

---

## 4. Setup and run (step by step)

### Step 1 — Install Node.js LTS

Download from <https://nodejs.org> (choose the **LTS** version) and install it.
Check it worked:

```bash
node --version    # should print v18.x or v20.x or newer
npm --version
```

### Step 2 — Open the project in VS Code

`File → Open Folder…` → select `smartspend-expense-tracker`.

### Step 3 — Install dependencies

Open the VS Code terminal (`Ctrl + ~`) and run:

```bash
npm install
```

This installs `express` and `better-sqlite3`. `better-sqlite3` is a *native* module, so npm may
compile a small C++ add-on the first time. That is normal and takes a few seconds.

### Step 4 — Start the server

```bash
npm start
```

You should see:

```
  SmartSpend — Your money, clearly organised.
  ------------------------------------------------
  Database : .../smartspend-expense-tracker/expense-tracker.db
  Server   : http://localhost:3000
  Stop     : press Ctrl + C in this terminal
```

On the **first** run the database file and both tables are created automatically. There is
nothing else to install or import.

### Step 5 — Open the app and sign in

Go to **<http://localhost:3000>** in Chrome, Edge or Firefox. You land on **`/login.html`**:

| Button | What happens |
|---|---|
| **Sign in** | email + password checked by Supabase |
| **Create account** | new Supabase account (6+ character password) |
| **Forgot your password?** | sends a reset email |
| **Continue without an account** | local mode — the 1.0/2.0 experience, nothing sent anywhere |

The small line at the bottom of the card is a real status check of your Supabase project
(*"Supabase connected · email confirmation required"*, or *"offline"*).

Two things to know before your first signup:

1. **The SQL must be run once.** A publishable key cannot create tables, so open
   **Supabase → SQL Editor**, paste all of `supabase/schema.sql`, and press **Run**. Until then,
   Settings → *Account & cloud* honestly says *"schema not installed"*.
2. **Email confirmation is currently ON** in this project. Signup then returns no session until
   you click the link in the inbox. To demo a one-click signup, turn off
   *Authentication → Providers → Email → Confirm email*.

Full walkthrough, redirect URLs and error table: **`docs/SUPABASE.md`**.

> **No internet during the viva?** Press *Continue without an account*. Everything except the
> login and the profile row works exactly as before, offline.

### Step 6 — Answer the welcome question

The first time this browser opens SmartSpend, a full-screen card asks:

> **What will you use SmartSpend for?** — *Individual* or *Business*

Pick one and press **Continue**. It only decides which book opens first; nothing is created or
deleted, the sidebar switcher still moves between both books, and **Settings → Change my purpose**
brings the question back. The answer is remembered in `localStorage`
(`smartspend:onboarded`), which is also how you can reset it: DevTools → Application → Local
Storage → delete that key and reload.

This is a convenience choice **inside** your chosen book — the login happens before it, and the
Individual/Business switch is still not a permission (see §7 and §18).

> **Important:** the terminal must stay open while you use the app. The Node.js process *is*
> the server — if you close the terminal (or press `Ctrl + C`), the page stops responding and
> you will see the message *"Cannot reach the SmartSpend server."*

---

## 5. How to stop, restart and reset

| Action | How |
|---|---|
| **Stop** the server | Click the terminal and press `Ctrl + C` |
| **Restart** | Run `npm start` again in the project folder |
| **Auto-restart on file changes** (development) | `npm run dev` (uses Node's `--watch`) |
| **Add personal demo data** (presentations only) | `npm run seed` · start clean with `npm run seed:reset` |
| **Add business demo data** (presentations only) | `npm run seed:business` · re-create it with `npm run seed:business -- --force` |
| **Change the port** | `PORT=4000 npm start` (macOS/Linux) or `set PORT=4000 && npm start` (Windows CMD) |
| **Wipe all data** | Stop the server, delete `expense-tracker.db` (and `expense-tracker.db-wal` / `-shm` if present), run `npm start` — a fresh empty database is created |
| **Backup data** | Stop the server and copy `expense-tracker.db` somewhere safe |

Stopping and restarting **does not** delete anything: transactions and budgets stay in the file.

### Screenshots

Already captured from the running app and included for your report:

| File | Shows |
|---|---|
| `docs/screenshots/30-login.png` · `30b-login-create-account.png` | The new Supabase login page (sign in / create account) |
| `docs/screenshots/30c-login-confirm-email.png` | What you see when email confirmation is required |
| `docs/screenshots/30d-cloud-connected.png` | Settings → Account & cloud, connected |
| `docs/screenshots/30e-login-mobile.png` | The login page at phone width |
| `docs/screenshots/30f-preview-storage-blocked.png` | Honest message when a sandboxed frame blocks storage (`docs/SUPABASE.md` §10) |
| `docs/screenshots/00-purpose-chooser.png` · `00b-purpose-selected.png` | The first-run "What will you use SmartSpend for?" chooser |
| `docs/screenshots/01-dashboard.png` | Dashboard: summary cards with month-over-month chips, charts, budget with daily allowance, recent transactions |
| `docs/screenshots/02-transactions.png` | Transaction table with search, filters and quick date ranges |
| `docs/screenshots/03-monthly-budget.png` | Monthly budget screen with progress bar and history |
| `docs/screenshots/04-analytics.png` | Analytics: doughnut, bar chart and category table |
| `docs/screenshots/05-insights.png` | Spending insights and month snapshot |
| `docs/screenshots/06-add-transaction-dialog.png` | The add / edit transaction dialog |
| `docs/screenshots/07-dashboard-dark.png` | Individual dashboard in dark theme |
| `docs/screenshots/08-mobile.png` · `09-tablet.png` | Responsive layouts (drawer nav, stacked cards) |
| `docs/screenshots/10-business-dashboard.png` | **Business** dashboard: six cards, revenue vs expenses, expense breakdown, receivables aging and top customers |
| `docs/screenshots/11-invoices.png` | **Business** invoice list with derived statuses and balances |
| `docs/screenshots/12-invoice-view.png` | Invoice viewer (print / save as PDF) |
| `docs/screenshots/13-cash-flow.png` | Cash flow with "not yet received / not yet paid" boxes |
| `docs/screenshots/14-business-reports.png` | Tax estimate report with its disclaimer |
| `docs/screenshots/15-recurring.png` | Recurring rules, upcoming payments, idempotent generation |
| `docs/screenshots/16-savings-goals.png` | Savings goals with contribution-based progress |
| `docs/screenshots/17-business-dark-theme.png` | Business mode in dark theme |
| `docs/screenshots/18-mobile-business.png` · `19-mobile-drawer.png` | Business mode and the drawer with the mode switcher, on a phone |
| `docs/screenshots/20-individual-reports.png` | Individual reports: monthly summary, category breakdown, CSV export |
| `docs/screenshots/21-settings.png` | Settings — including the honest note about there being no login |
| `docs/screenshots/22-customers.png` | Customers list (safe delete / archive) |
| `docs/screenshots/23-bills.png` | Vendor bills and payables |
| `docs/screenshots/24-business-dashboard-dark.png` | Business dashboard in dark theme |

These were taken with the optional demo data (`npm run seed:reset`).

---

## 6. Screens and features

### Dashboard

- Four summary cards: **Total Income**, **Total Expenses**, **Available Balance**, **Savings Rate**.
- **Income vs Expenses** bar chart for the last 6 months (Chart.js).
- **Spending by Category** doughnut chart for the selected month, with a ranked legend.
- **Month-over-month chips** on each card (↑ 23.5% / ↓ 37.8% vs last month), coloured by what the
  number *means*: rising income is good, rising expenses is not. A month with no records in the
  previous month shows no chip at all rather than a misleading 100%.
- **Monthly budget progress bar** (teal-safe → amber at 75% → red when exceeded) plus a
  **daily allowance** line: *"That is about ₹70.25 a day for the 4 days left in October 2026."*
- **Highest spending category** for the selected month.
- Three short **insights** generated from real records.
- **Recent transactions** table (latest five).

### Transactions

- Full **CRUD**: add, view, edit, delete (with a confirmation dialog).
- Sorted **newest first**.
- **Search** across title, category and notes.
- **Filters**: category, type (income/expense), month, and a from/to date range.
- **Clear filters** button and a live summary of what is currently filtered.
- Pagination ("Load more") and a friendly empty state.
- Client-side *and* server-side validation with inline error messages.
- **Quick ranges** above the filters: *This month · Last month · Last 30 days · This year · All
  time*. They fill the From/To inputs and re-run the same server-side filter, so the table and the
  CSV can never disagree.

### Monthly Budget

- Pick a **month**, enter an **amount**, press **Save Budget** (stored per month).
- Shows budget, spent, remaining, expense count, a percentage "ring", and a progress bar.
- Bar turns **amber at ≥75%** and **red when over budget**.
- List of previously saved budgets with mini progress bars.
- Remove budget button; negative amounts rejected; recalculates whenever transactions change.

### Expense Analytics

- Doughnut chart of expenses by category for the selected month.
- Bar chart comparing monthly income vs expenses.
- Category table with transaction counts, amounts and share-of-spending bars.

### Spending Insights

- Rule-based insight cards (top category, budget usage, income vs expense, empty month, savings rate…).
- Month snapshot panel.
- Only shows statements that the data actually supports.

### Savings Goals *(new in 2.0 — Individual)*

- Create a goal with a name, target amount and optional target date.
- Press **Add money** to record a contribution (negative amount withdraws; a goal can never go
  below zero). Progress is the **sum of contributions**, so the bar can never drift from reality.
- Side panel totals: saved, target, still to save, goals reached. Goals can be archived or deleted.

### Recurring Expenses *(new in 2.0 — Individual)*

- Rules describe a regular payment (title, category, amount, daily/weekly/monthly/yearly, first due date).
- **Upcoming Expected Payments**: what the next 45 days look like — nothing is created automatically.
- **Generate due entries** creates a real transaction for every date that has passed. It is
  **idempotent**: the database has `UNIQUE(recurring_rule_id, transaction_date)` and the insert is
  `INSERT OR IGNORE`, so pressing the button twice (or reloading the page) creates nothing extra.

### Reports *(new in 2.0 — Individual)*

- Date range with a 12-month quick pick.
- Monthly summary table (income, expenses, net, savings rate) and category breakdown with shares.
- **CSV export** for transactions and the monthly summary, honouring the visible range.

### Business Dashboard *(new in 2.0 — Business)*

- Six cards: Revenue, Business Expenses, **Net Profit** (revenue − expenses), Outstanding (customers),
  Outstanding (vendors), Net Cash Flow — each labelled with what it does and does not include.
- Revenue vs Expenses bars, or a Net Profit trend line (toggle).
- Expense breakdown doughnut by business category.
- **Receivables Aging**: how much of what you are owed is not due yet, 1–30 days late, 31–60 days
  and 60+ days, with the late total spelled out (*"₹9,440 of ₹21,280 is already past its due date"*).
  Buckets are calculated on the server from the due date.
- **Top Customers**: ranked by invoiced value, with each customer's outstanding amount on hover.
- Recent sales / recent expenses lists and a **Needs Attention** panel of overdue invoices and bills.
- A permanent banner: *"Basic bookkeeping estimates — not audited financial statements."*

### Customers & Vendors *(new in 2.0 — Business)*

- Full CRUD with contact person, email, phone, address, notes.
- Search, archived toggle, per-party invoice/bill count and outstanding amount.
- **No silent cascading deletes.** Deleting a customer who has invoices returns *409* with an
  explanation; the app offers **Archive** instead, which hides the party from pickers but keeps
  every financial record intact. The database also has `ON DELETE RESTRICT` as a second guard.

### Invoices *(new in 2.0 — Business)*

- Unique invoice number per workspace (`INV-2026-0001`, suggested automatically, uniqueness enforced
  by the server: a duplicate is a *409*).
- Line items (description, quantity, unit price, optional tax %) with **server-calculated** subtotal,
  tax and total. The editor shows a preview only — the stored numbers come from the server.
- Statuses: **Draft, Unpaid, Partially Paid, Paid, Overdue, Cancelled** — derived on read.
- **Record payment**: part payments allowed, over-payment rejected, duplicate payment rejected.
- **View** and **Print / Save as PDF** — printing never marks an invoice paid.

### Bills & Payables *(new in 2.0 — Business)*

- Record a bill you received: vendor, bill number, dates, amount, optional tax rate, description.
- Status, amount paid, remaining and total outstanding are calculated the same way as invoices.
- Payments respect the outstanding balance, and the same payment cannot be recorded twice.

### Cash Flow *(new in 2.0 — Business)*

- Date range → money received, money paid, net.
- Money received = invoice payments actually recorded + income transactions.
  Money paid = vendor bill payments + expense transactions.
- **Unpaid invoices and unpaid bills are excluded** and reported separately as
  "not yet received" / "not yet paid", so the report can never flatter the numbers.
- Movement list shows every cash event with its source (customer payment, vendor payment, income
  entry, expense entry) and a CSV export.

### Business Reports *(new in 2.0 — Business)*

- Expenses by category with net / tax / total, plus tax entered on invoices.
- Payment-method breakdown (money in vs money out).
- CSV export of transactions, invoices, bills and the tax report for the selected range.
- An explicit disclaimer: figures are **estimates for your own records, not tax or legal advice**.

### Cross-cutting

- **First-run purpose chooser** — a full-screen card asks "What will you use SmartSpend for?"
  (Individual / Business) once per browser, with a keyboard-navigable choice and a **Continue**
  button that stays disabled until something is picked. Re-openable from Settings.
- **Mode switcher** in the sidebar (Individual / Business), remembered in `localStorage`; a URL hash
  like `#invoices` opens the right mode automatically.
- **Dark / light theme** toggle (remembered in `localStorage`, respects your OS preference).
- **Global month selector** in the top bar controls dashboard, analytics, budget and insights.
- Responsive: desktop sidebar → off-canvas drawer on tablet/mobile; table becomes stacked cards on phones.
- Loading skeletons, spinners, empty states, success/error toasts, visible focus rings, `Esc` closes dialogs.

### Colour theme

The interface uses an **indigo / violet** brand palette (`#4338ca` in light mode, `#6366f1` in dark
mode) on cool grey-lavender surfaces. Positive money uses a teal accent and negative money a red one,
so income and expenses stay readable without fighting the brand colour.

Every colour lives in one place — the design tokens at the top of `public/style.css`:

```css
:root {
  --indigo-600: #4338ca;   /* brand */
  --brand: var(--indigo-600);
  --bg: #f4f5fb;           /* page background */
  --surface: #ffffff;      /* cards */
  --income: #0d9488;       /* money in  */
  --expense: #d13d33;      /* money out */
}

html[data-theme='dark'] {
  --brand: #6366f1;
  --bg: #0b0d1a;
  --surface: #131629;
  --income: #2dd4bf;
  --expense: #ff8e85;
}
```

**Buttons.** One shared `.btn` style with three variants: `btn-primary` (indigo gradient, inset
highlight, soft brand shadow), `btn-ghost` (transparent with a hairline border that turns indigo-soft
on hover) and `btn-danger`. All of them are 40px tall (32px for `btn-sm`), 12px radius, lift 1px on
hover, and show a visible focus ring — so they are comfortable to hit on a phone and obvious when
tabbed to with a keyboard. Icon buttons (row actions, the theme toggle) share the same shape language
at 38px, and dark mode gets its own gradient so the primary button never disappears into the card.

Change those values and the whole app follows — both themes, every screen, no component edits. The
chart colours are the only exception, because Chart.js needs real colour strings: they come from
`CATEGORY_COLORS` / `FALLBACK_PALETTE` in `public/app.js` and are read back from the CSS variables
for income, expense and grid lines.

---

## 7. How Individual and Business modes differ

Both modes are the same program: same HTML, same CSS, same Express server, same SQLite file.
What changes is **which workspace id is in use** and **which screens the sidebar offers**.

| | Individual | Business |
|---|---|---|
| Purpose | personal money | a shop / freelance / small company |
| Categories | Food, Transport, Shopping, Rent, Education, Healthcare, Entertainment, Other (+ Salary, Freelance income) | Sales, Other Income, Purchases, Rent & Utilities, Salaries & Wages, Marketing, Software & Subscriptions, Travel & Transportation, Equipment & Maintenance, Other Operating Expenses, Other |
| Extra transaction fields | — | payment method, optional tax rate, optional customer, optional vendor |
| Money documents | — | invoices (with line items, tax, payments), vendor bills |
| Parties | — | customers, vendors |
| Budgeting | monthly + per-category budgets | — (not shown, to keep business screens focused) |
| Goals & recurring | savings goals, recurring rules | — |
| Reports | monthly summary, category breakdown, CSV | cash flow, tax estimate, payment methods, CSV |
| Dashboard headline | income, expenses, balance, savings rate | revenue, expenses, net profit, outstanding customer payments, outstanding vendor payments, net cash flow |

### What the mode switcher actually is (be honest about this)

SmartSpend has **no login**. There is no password, no session, no user table. The switcher is a
**local profile selection**: workspace 1 is `Personal`, workspace 2 is `My Business`, and both live
in the same `expense-tracker.db` file on your computer.

What it *does* give you is real and useful: **every query is filtered by `workspace_id`**, so the two
books never mix in a dashboard, a report or a CSV export. What it *does not* give you is security —
anyone sitting at the machine can open either book. This is stated on the Settings screen inside the
app as well, because presenting it as "secure multi-user authentication" would be false.

### Rules that keep the business numbers honest

1. **Revenue and expenses** come only from recorded transactions. An unpaid invoice is not revenue
   yet; an unpaid bill is not an expense paid.
2. **Outstanding amounts** (receivables, payables) are always shown in their own cards and are
   never added into cash flow.
3. **Invoice totals are calculated on the server** from quantity × unit price (+ optional tax).
   If the browser sends a total, it is ignored.
4. **Status is derived, never stored**: `draft`, `unpaid`, `partially paid`, `paid`, `overdue`,
   `cancelled`. Opening or printing an invoice cannot change it; only a recorded payment can.
5. **Payments are validated**: they cannot exceed the outstanding balance, and the same payment
   cannot be recorded twice.
6. **Tax numbers are estimates** based only on rates you type in yourself. SmartSpend does not
   decide what is deductible, and the app says "estimate, not tax advice" on every tax screen.

---

## 8. Database design explained

The database is one file: **`expense-tracker.db`**. SQLite is opened with `PRAGMA foreign_keys = ON`
and WAL journaling, and the schema is created by **six versioned migrations** in `src/migrations/`
that run automatically on start-up:

| # | Migration | What it does |
|---|---|---|
| 001 | `init` | 1.0 baseline (`transactions`, `budgets`) — marks an existing 1.0 file as versioned |
| 002 | `workspaces_parties` | `workspaces`, `customers`, `vendors`; workspace 1 = Personal, 2 = My Business |
| 003 | `minor_units` | rebuilds `transactions` + `budgets`: adds `workspace_id`, integer `amount_minor`, business columns |
| 004 | `invoices_bills` | `invoices`, `invoice_items`, `invoice_payments`, `vendor_bills`, `vendor_bill_payments` |
| 005 | `recurring_goals` | `recurring_rules`, `savings_goals`, `savings_goal_contributions`, `category_budgets` |
| 006 | `bill_notes` | optional `notes` on `vendor_bills` |

Each migration runs **inside one transaction** and is recorded in `schema_migrations`; the runner is
append-only (a migration that already ran is never re-run) and it verifies `PRAGMA foreign_key_check`
afterwards. Migrating a 1.0 file is **non-destructive** — `test/migration.test.js` proves every row,
every field and every paise survives.

### The 15 tables

| Table | Purpose |
|---|---|
| `workspaces` | one finance book per mode (`individual` / `business`) |
| `transactions` | income & expenses for both modes (business columns are optional) |
| `budgets`, `category_budgets` | monthly limit, plus optional per-category limits |
| `recurring_rules` | recurring expense/income definitions |
| `savings_goals`, `savings_goal_contributions` | goals and the money actually put into them |
| `customers`, `vendors` | business parties (archivable) |
| `invoices`, `invoice_items`, `invoice_payments` | invoices, their lines, their payments |
| `vendor_bills`, `vendor_bill_payments` | bills you owe and the payments you made |
| `schema_migrations` | which migrations have run |

### Table `transactions` — one row per money movement

| Column | Type | Meaning | Rule |
|---|---|---|---|
| `id` | INTEGER | Unique row number | `PRIMARY KEY AUTOINCREMENT` |
| `workspace_id` | INTEGER | Which book this row belongs to | `NOT NULL REFERENCES workspaces(id)` |
| `type` | TEXT | `income` or `expense` | `CHECK (type IN ('income','expense'))` |
| `title` | TEXT | Short description | `NOT NULL`, 1–100 characters |
| `category` | TEXT | Food / Sales / Rent & Utilities / … | `NOT NULL`, checked against the mode's allow-list in the API |
| `amount_minor` | INTEGER | **Money in paise** (₹4,850 = `485000`) | `NOT NULL`, `CHECK (amount_minor > 0)` |
| `amount` | REAL | *Generated* `amount_minor / 100` | `GENERATED ALWAYS … VIRTUAL` — read-only |
| `transaction_date` | TEXT | When the money moved | `NOT NULL`, `YYYY-MM-DD` (`GLOB` check) |
| `notes` | TEXT | Optional free text | `NULL`, ≤ 500 characters |
| `payment_method` | TEXT | `cash`/`upi`/`card`/`bank_transfer`/`cheque`/`other` | optional, business mode fills it |
| `tax_rate` | REAL | Tax % entered by the user | optional, **never assumed** |
| `customer_id`, `vendor_id` | INTEGER | Optional links | `REFERENCES customers/vendors ON DELETE RESTRICT` |
| `invoice_reference` | TEXT | Optional invoice number | `NOT NULL DEFAULT ''` |
| `recurring_rule_id` | INTEGER | Set when a rule generated this row | `UNIQUE(recurring_rule_id, transaction_date)` |
| `created_at`, `updated_at` | TEXT | Timestamps | defaults + trigger on update |

**Why integer paise?** `0.1 + 0.2` in floating point is `0.30000000000000004`. Money is therefore
stored as whole paise and converted for display (`toMinor()` / `toRupees()` in `src/money.js`).
The old `amount` column is kept as a **generated** column so any 1.0-era code still reading
`amount` keeps working — but nothing can write to it.

**Why store the date as TEXT?** `YYYY-MM-DD` sorts correctly and `substr(transaction_date, 1, 7)`
gives `YYYY-MM`, so monthly grouping needs no date functions.

### `invoices`, `invoice_items`, `invoice_payments`

- `invoices` stores `invoice_number` (unique **per workspace**), `customer_id`, `invoice_date`,
  `due_date`, `subtotal_minor`, `tax_minor`, `total_minor`, `is_draft`, `is_cancelled`, `notes`.
- `invoice_items` stores one row per line: `description`, `quantity`, `unit_price_minor`,
  `tax_rate`, `line_total_minor`, `tax_minor`, `position`. `ON DELETE CASCADE` from the invoice.
- `invoice_payments` stores `amount_minor`, `paid_on`, `method`, `reference`. A `UNIQUE` index on
  `(invoice_id, paid_on, amount_minor, method)` plus an explicit server check makes a duplicate
  payment impossible.
- **`status` is not a column.** It is computed in SQL on every read:
  `cancelled → draft → paid → overdue → partially paid → unpaid`.

`vendor_bills` / `vendor_bill_payments` follow exactly the same pattern (a bill's total is
`amount_minor + tax_minor`).

### `savings_goals` and the idempotent recurring engine

- A goal's progress is `SUM(savings_goal_contributions.amount_minor)` — never a stored number that
  could drift. Withdrawals are negative contributions, and the server refuses to go below zero.
- Recurring rules create transactions through `INSERT OR IGNORE` against the partial unique index
  `UNIQUE(recurring_rule_id, transaction_date) WHERE recurring_rule_id IS NOT NULL`. That is what
  makes **generation idempotent**: pressing "Generate due entries" twice, or reloading the page,
  can never duplicate an entry.

---

## 9. API endpoint documentation

Base URL: `http://localhost:3000/api` · All responses are JSON.
**The full reference for every endpoint (request body, response shape, status codes) is in
[`docs/API.md`](docs/API.md).** The tables below are the quick summary.

Every request may carry a workspace header:

```http
X-Workspace-Id: 2        # 1 = Personal (individual), 2 = My Business (business)
```

If the header is missing the server uses the default workspace for that route's mode, and if it
points at a workspace of the wrong type the request is rejected with **400** instead of silently
reading the other book.

### Business endpoints at a glance (2.0)

All business routes live under `/api/business` and always resolve a **business** workspace first.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/business/dashboard` | Revenue, expenses, net profit, receivable, payable, cash flow, trend, recent lists, overdue |
| GET | `/api/business/cash-flow` | Money received / paid / net + movements (excludes unpaid documents) |
| GET | `/api/business/reports/tax` | Expenses by category with net / tax / total + disclaimer |
| GET | `/api/business/reports/payment-methods` | Totals by payment method and direction |
| GET | `/api/business/customers` · `/customers/:id` | List (search, `include_archived`) / one |
| POST | `/api/business/customers` | Create (201) |
| PUT | `/api/business/customers/:id` | Update |
| DELETE | `/api/business/customers/:id` | Delete — **409** while invoices/transactions refer to it |
| POST | `/api/business/customers/:id/archive` | Archive / restore (`{ "archived": true }`) |
| GET/POST/PUT/DELETE | `/api/business/vendors…` | Same contract for vendors |
| GET | `/api/business/invoices` | List (search, status, customer_id, from, to) + summary |
| GET | `/api/business/invoices/next-number` | Suggested next number, e.g. `INV-2026-0004` |
| GET | `/api/business/invoices/:id` | One invoice + items + payments + derived status |
| POST | `/api/business/invoices` | Create with `items[]` (201); totals are recalculated server-side |
| PUT | `/api/business/invoices/:id` | Update (recalculates totals) |
| DELETE | `/api/business/invoices/:id` | Delete |
| POST | `/api/business/invoices/:id/publish` | Draft ⇄ published |
| POST | `/api/business/invoices/:id/cancel` | Cancel / restore |
| GET/POST | `/api/business/invoices/:id/payments` | List / record a payment (201) |
| DELETE | `/api/business/invoices/:id/payments/:paymentId` | Remove a payment (invoice reopens) |
| GET/POST/PUT/DELETE | `/api/business/bills…` | Vendor bills with the same rules |
| GET/POST | `/api/business/bills/:id/payments` | List / record a vendor payment |
| GET | `/api/business/export/transactions.csv` | Filtered transactions CSV |
| GET | `/api/business/export/invoices.csv` | Invoices CSV (with computed status) |
| GET | `/api/business/export/bills.csv` | Bills CSV |
| GET | `/api/business/export/tax-report.csv` | Tax estimate CSV |

### Individual endpoints added in 2.0

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/workspaces` · `/api/workspaces/:id` | The two books (id, name, type, counts) |
| PATCH | `/api/workspaces/:id` | Rename a workspace |
| GET | `/api/system/migrations` | Which migrations ran + row counts (used by Settings) |
| GET | `/api/savings-goals` | List goals with saved / remaining / percent |
| POST/PUT/DELETE | `/api/savings-goals…` | Manage goals |
| POST | `/api/savings-goals/:id/contributions` | Add (or withdraw) money |
| POST | `/api/savings-goals/:id/archive` | Archive / restore |
| GET | `/api/recurring` · `/api/recurring/upcoming` | Rules and expected payments (45 days) |
| POST/PUT/DELETE | `/api/recurring…` | Manage rules |
| POST | `/api/recurring/run` | Generate due entries — **idempotent** |
| GET | `/api/category-budgets` · PUT · DELETE | Per-category budgets |
| GET | `/api/reports/monthly-summary` | Monthly income / expense / net / savings rate |
| GET | `/api/export/monthly-summary.csv` | Monthly summary CSV |

### Meta & health

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/meta` | App name, tagline, allowed categories/types, current month |
| GET | `/api/health` | Simple `{ status: "ok" }` check |

```json
// GET /api/meta
{
  "app": "SmartSpend",
  "tagline": "Your money, clearly organised.",
  "categories": ["Food", "Travel", "..."],
  "types": ["income", "expense"],
  "currentMonth": "2026-10"
}
```

### Transactions

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/transactions` | List with optional filters |
| GET | `/api/transactions/:id` | One transaction |
| POST | `/api/transactions` | Create (201) |
| PUT | `/api/transactions/:id` | Full update |
| PATCH | `/api/transactions/:id` | Partial update |
| DELETE | `/api/transactions/:id` | Delete |

**Query parameters for GET `/api/transactions`**

| Param | Example | Meaning |
|---|---|---|
| `search` | `?search=canteen` | Matches title, category or notes |
| `category` | `?category=Food` | Exact category |
| `type` | `?type=expense` | `income` or `expense` |
| `month` | `?month=2026-10` | `YYYY-MM` |
| `from` / `to` | `?from=2026-10-01&to=2026-10-31` | Date range (`YYYY-MM-DD`) |
| `limit` / `offset` | `?limit=20&offset=20` | Pagination (limit ≤ 500) |

```jsonc
// GET /api/transactions?category=Food&limit=2
{
  "data": [
    {
      "id": 7,
      "type": "expense",
      "title": "Lunch at canteen",
      "category": "Food",
      "amount": 150,
      "transaction_date": "2026-10-06",
      "notes": null,
      "created_at": "2026-10-28 09:14:02"
    }
  ],
  "pagination": { "total": 1, "limit": 2, "offset": 0, "returned": 1 },
  "totals": { "income": 0, "expense": 150 }
}
```

```jsonc
// POST /api/transactions  (request body)
{
  "type": "expense",
  "title": "Lunch at canteen",
  "category": "Food",
  "amount": 150,
  "transaction_date": "2026-10-06",
  "notes": "Canteen"
}
// 201 response
{ "data": { "id": 7, "...": "..." }, "message": "Transaction added successfully." }
```

### Dashboard summary

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/summary` | All-time totals |
| GET | `/api/summary?month=2026-10` | Totals for one month |

```jsonc
{
  "data": {
    "totalIncome": 15500,
    "totalExpenses": 3349,
    "balance": 12151,
    "savingsRate": 78.4,          // 0 when there is no income (no divide-by-zero)
    "incomeCount": 3,
    "expenseCount": 8,
    "transactionCount": 11,
    "highestCategory": { "category": "Travel", "total": 400, "count": 1 }
  },
  "month": null
}
```

### Budgets

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/budgets?month=2026-10` | Budget + live spend for one month |
| GET | `/api/budgets` | History of saved budgets |
| PUT | `/api/budgets` | Create or update (upsert) |
| DELETE | `/api/budgets?month=2026-10` | Remove a budget |

```jsonc
// GET /api/budgets?month=2026-10
{
  "data": {
    "month": "2026-10",
    "amount": 2000,
    "spent": 1439,
    "expenseCount": 5,
    "remaining": 561,
    "percentUsed": 71.95,
    "isSet": true,
    "exceeded": false,
    "updatedAt": "2026-10-28 09:20:11"
  }
}
```

```jsonc
// PUT /api/budgets
{ "month": "2026-10", "amount": 2000 }
```

### Analytics

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/analytics/monthly?months=6` | Income/expense per month (1–24 months) |
| GET | `/api/analytics/categories?month=2026-10` | Expenses grouped by category |
| GET | `/api/analytics/insights?month=2026-10` | Rule-based insight list |

```jsonc
// GET /api/analytics/monthly?months=3
{ "data": [
  { "month": "2026-08", "income": 0,     "expense": 0,    "balance": 0 },
  { "month": "2026-09", "income": 8000,  "expense": 1910, "balance": 6090 },
  { "month": "2026-10", "income": 7500,  "expense": 1439, "balance": 6061 }
] }

// GET /api/analytics/categories?month=2026-10
{ "data": {
  "month": "2026-10",
  "total": 1439,
  "categories": [
    { "category": "Travel", "total": 400, "count": 1, "percent": 27.8 }
  ]
} }

// GET /api/analytics/insights?month=2026-10
{ "data": {
  "month": "2026-10",
  "monthLabel": "October 2026",
  "insights": [
    { "id": "top-category", "tone": "info",
      "title": "Travel is your highest spending category",
      "text": "You spent ₹400 on Travel in October 2026 — that is 27.8% of this month's expenses across 1 transaction." }
  ]
} }
```

### Status codes and error format

| Code | When |
|---|---|
| 200 | Successful GET / PUT / DELETE |
| 201 | Transaction created |
| 400 | Validation failed, bad id, bad JSON, bad month filter |
| 404 | Unknown transaction, unknown API route |
| 413 | Request body too large |
| 500 | Unexpected server error (details logged on the server only) |

```jsonc
// 400 — field-level errors are returned so the form can highlight inputs
{
  "error": {
    "message": "Please fix the highlighted fields.",
    "fields": { "amount": "Amount must be greater than 0." }
  }
}
```

---

## 10. Formulas used

| Figure | Formula | Notes |
|---|---|---|
| Total Income | `SUM(amount) WHERE type = 'income'` | |
| Total Expenses | `SUM(amount) WHERE type = 'expense'` | |
| Available Balance | `Total Income − Total Expenses` | Can be negative |
| Savings Rate | `((Income − Expenses) / Income) × 100` | Only when `Income > 0`; otherwise **0** (division-by-zero guard) |
| Budget Used % | `(Month Expenses / Month Budget) × 100` | `null` when no budget is set |
| Remaining Budget | `Budget − Month Expenses` | Negative when overspent |
| Category share | `(Category Expense / Month Expense Total) × 100` | |

Money is rounded to 2 decimals on the server before it is stored/returned, so totals and charts
can never disagree by a floating-point crumb.

---

## 11. Security and validation

This is a **local educational project, not production software for real financial data.** Still,
it follows the good habits a viva examiner will ask about:

- **Prepared statements everywhere.** Every query with user input uses `?`/`@name` parameters
  (`better-sqlite3` prepared statements). No string concatenation into SQL — SQL injection is
  blocked, and this is verified by an automated test that inserts
  `Robert'); DROP TABLE transactions;--` as a title and confirms the table still exists.
- **Server-side validation is the real gatekeeper.** The frontend validates for a nice
  experience, then the server independently checks: required fields, title ≤ 100 chars,
  notes ≤ 500, amount > 0 and finite, real calendar dates (rejects `2026-02-31`), allowed
  categories, allowed types, `YYYY-MM` months, and positive integer ids.
- **No `innerHTML` with user data.** All database values are inserted with `textContent` through
  the `el()` helper. Only hardcoded icon markup uses `innerHTML`.
- **Database constraints as a second line of defence.** `CHECK` constraints mirror the API rules,
  so even a manual SQL edit cannot create a negative amount or a bad type.
- **Safe error handling.** A single central Express error handler returns clean JSON messages;
  stack traces and internal details are logged in the terminal only.
- **No secrets.** There are no API keys, passwords or `.env` values anywhere in the project, and
  nothing sensitive is exposed to the browser.
- **Small hardening details.** `x-powered-by` is disabled, JSON bodies are limited to 100 kB, and
  `LIKE` wildcards in search input are escaped.
- **Authentication is intentionally not implemented.** A single-user local app does not need it,
  and doing it half-way would be worse than not doing it.

---

## 12. Charts and the internet connection

Chart.js 4.4.6 is **bundled locally** at `public/assets/vendor/chart.umd.min.js`, so
**no internet connection is required** to render the charts. This is important for a college lab
or an offline demo.

As a safety net, `index.html` contains a tiny fallback that loads Chart.js from
`https://cdn.jsdelivr.net/npm/chart.js@4.4.6/dist/chart.umd.min.js` **only if** the local file is
missing. So:

- Local file present → **offline-safe** (the default situation).
- Local file deleted + internet available → charts still work from the CDN.
- Local file deleted + no internet → the chart boxes show a friendly "Charts unavailable"
  message; all tables, totals and insights keep working.

---

## 13. Automated tests

Three real end-to-end suites are included. Each one starts the actual Express server on an
ephemeral port against a **temporary** database (`SMARTSPEND_DB`), so your own data is never touched.

```bash
npm test              # runs all three, in order

npm run test:api      # 1.0 personal behaviour (must keep working)
npm run test:business # 2.0 acceptance criteria
npm run test:migration# migrations + data preservation
```

Last run in this environment:

```
  79 passed, 0 failed, 79 total checks        (test/api.test.js)
  Business / acceptance: 138 passed, 0 failed (test/business.test.js)
  Migration: 23 passed, 0 failed              (test/migration.test.js)
  ── 240 checks, 0 failures ──
```

**`test/api.test.js` (79 checks)** — the original 1.0 suite, untouched, so a regression in personal
mode would be caught immediately: CRUD, persistence across a real server restart, validation
failures, 404s, budget maths, overspend, search/filter/pagination, analytics, insights, SQL-injection
resistance, malformed JSON, PATCH and budget deletion.

**`test/business.test.js` (138 checks)** — the 2.0 acceptance suite. It covers, among others:

- revenue / expenses / **net profit = revenue − expenses** arithmetic, checked against the DB;
- **no cross-mode leakage**: business transactions never appear in personal reports and vice versa;
- customer & vendor CRUD, blocked delete with a clear message, archive/restore;
- invoices: **server-side totals**, client-sent totals ignored, unique numbers (409), line items,
  draft/publish, cancel, and status derivation;
- **partial payments** updating the outstanding balance, over-payment rejected (400),
  duplicate payment rejected (409), status reopening when a payment is removed;
- **overdue** detection from due date + remaining balance;
- vendor bills and their payments, with the same safety rules;
- **cash flow excluding unpaid invoices and bills**, reported separately;
- CSV exports: filters honoured, correct rows only, no cross-workspace leakage;
- invalid amounts, dates, ids, workspace ids and payment values being rejected.

**`test/migration.test.js` (23 checks)** — a 1.0-shaped database is migrated and then compared with
the original: every row, every field, notes with quotes, paise-exact amounts, two workspaces created,
all 15 tables present, `amount` kept as a generated column for old code, re-running is a no-op, and a
fresh database starts clean.

The UI was additionally verified in a real headless Chromium browser:

| Browser suite | Checks | Covers |
|---|---|---|
| dashboard walkthrough | **74 / 74** | first-run chooser, both modes, every screen, creating a customer, an invoice with two lines, partial payment, refused over-payment, bill payment, CSV downloads, deep links, dark mode, mobile drawer, zero JS errors |
| 2.1 refinements | **22 / 22** | button styling/tap targets, purpose chooser, delta chips, daily budget line, filter presets, aging panel |
| **login (new)** | **21 / 21** | anonymous redirect, sign-in/sign-up tabs, client validation, **a real Supabase wrong-password error**, password reveal, strength hint, local-mode entry, reload persistence, local sign-out, **forged token rejected** → `/login.html?expired=1`, mobile layout |
| **static host / GitHub Pages (new)** | **11 / 11** | served under `/<repo>/` with no backend: no missing assets, login form still works, one honest banner instead of 404 noise, no invented numbers |
| **sandboxed preview frame (new)** | **9 / 9** | the login page inside `<iframe sandbox="allow-scripts">` — storage notice shown, *Continue without an account* really opens the app, sign-in gives an honest message instead of a redirect loop |
| **signed-in state (new)** | **14 / 14** | account panel, Settings card in both *schema-missing* and *connected* states, display-name save, cloud sign-out, login page skipping itself when a session exists |

The signed-in suite mocks Supabase with request interception, so **no throwaway accounts are created**
in the real project.

All six suites are shipped in **`tests-ui/`** with their own `README.md` and a `prepare.sh` that
builds a throwaway database for them (they create records, so they must never run against your own
`expense-tracker.db`). Playwright is **not** a project dependency — install it inside `tests-ui/`
when you want to run them:

```bash
cd tests-ui && npm install playwright && npx playwright install chromium
bash prepare.sh                                   # copy of the DB + demo business rows
PORT=3100 SMARTSPEND_DB=/tmp/smartspend-tests/ui.db npm start    # other terminal
BASE=http://localhost:3100 node tests-ui/ui2.js   # 74/74
```

`npm test` still needs nothing but `npm install` and works completely offline. Run the app and use `docs/TEST_STEPS.md` instead — it walks through the same
scenario by hand.

---

## 14. Manual testing checklist

Do these in order in the browser. Expected results are exactly what the app produces.

| # | Test | Steps | Expected |
|---|---|---|---|
| 1 | **Add income** | Add Transaction → Income → title "Pocket money", ₹5,000, Salary, today's date → Save | Total Income = ₹5,000, Balance = ₹5,000, success toast |
| 2 | **Add expense** | Add Transaction → Expense → "Lunch", ₹150, Food → Save | Total Expenses = ₹150, Balance = **₹4,850** |
| 3 | **Edit** | Click ✏️ on "Lunch" → change amount to 200 → Save Changes | Expenses = ₹200, Balance = **₹4,800**, charts update |
| 4 | **Delete** | Click 🗑️ on "Lunch" → confirm Delete | Expenses = ₹0, Balance = **₹5,000** |
| 5 | **Persistence** | Refresh the page, then stop the server (`Ctrl + C`) and `npm start` again | The ₹5,000 income is still there |
| 6 | **Validation** | Try an empty title; amount `0`; amount `-50`; date cleared | Inline red messages, nothing is saved. (Backend also rejects these — see `npm test`) |
| 7 | **Budget** | Monthly Budget → select the month → amount `1000` → Save, then add a ₹150 expense dated in that month | Usage **15%**, Remaining **₹850**, teal bar |
| 8 | **Overspend** | Change the budget to ₹100 (or add a big expense) | Bar turns **red**, caption says "Over budget by ₹…" |
| 9 | **Filters** | Transactions → type a title fragment in Search; pick a Category; pick a Month; then Clear filters | Rows narrow with each filter; summary line describes the filter; Clear restores all rows |
| 10 | **Charts & insights** | Open Expense Analytics and Spending Insights | Doughnut + bar charts match your data; insight cards mention your real category and budget |
| 11 | **Empty states** | Change the top-bar month to a month with no data | "No expenses this month" in the doughnut, "No entries for …" insight |
| 12 | **Theme** | Click the sun/moon icon | Whole app switches instantly; choice survives a refresh |
| 13 | **Responsive** | Narrow the window to phone width | Sidebar becomes a drawer (hamburger), stat cards stack, table becomes cards |
| 14 | **Server down** | Stop the server, then click anything | Red toast: "Cannot reach the SmartSpend server. Is it still running?" — no crash |
| 15 | **Switch mode** | Click **Business** in the sidebar | Sidebar, title and dashboard change; the caption reads "Business book · My Business"; the month picker in the top bar disappears |
| 16 | **No cross-mode leakage** | In Business add an expense "Shop rent"; switch back to Individual and open Transactions | "Shop rent" is **not** in the personal list, and personal totals are unchanged |
| 17 | **Customer** | Business → Customers → Add customer | Row appears with 0 invoices and ₹0 outstanding |
| 18 | **Safe delete** | Delete a customer who has an invoice | Refused with *"…cannot be deleted because it is linked to 1 invoice. Archive it instead…"*; the customer stays |
| 19 | **Invoice totals** | Invoices → New invoice → 3 × ₹1,000 (18% tax) + 1 × ₹500 (0%) → Save | Server stores subtotal **₹3,500**, tax **₹540** (18% of ₹3,000), total **₹4,040** — matching the editor preview |
| 20 | **Opening ≠ paying** | Open that invoice, print preview, close | Status stays **Unpaid**; nothing is marked paid |
| 21 | **Partial payment** | View the invoice → Record payment → ₹1,040 | Status becomes **Partially paid**, balance **₹3,000**, dashboard "Outstanding (customers)" drops by ₹1,040 |
| 22 | **Over-payment** | Record a payment larger than the balance | Rejected with *"Maximum is ₹3,000"*, nothing saved |
| 23 | **Overdue** | Create an invoice with a due date in the past | Status badge shows **Overdue** and it appears in *Needs Attention* |
| 24 | **Bills** | Bills & Payables → Record bill → pay part of it | Status **Partially paid**, remaining and total outstanding update |
| 25 | **Cash flow** | Cash Flow screen | Money received counts only recorded payments + income; the unpaid invoice appears under "Not yet received", not in the total |
| 26 | **CSV** | Reports → export Transactions / Invoices / Bills / Tax report | Files download with a header row and only this mode's records |
| 27 | **Recurring idempotency** | Recurring → Generate due entries, then press it again | First press creates the missing entries; second press reports *nothing was due* and creates nothing |
| 28 | **Savings goal** | Savings Goals → New goal ₹10,000 → Add money ₹2,500 | Bar shows **25%**, remaining **₹7,500** |
| 29 | **Deep link** | Open `http://localhost:3000/#invoices` in a new tab | The app opens **in Business mode** on the Invoices screen |
| 30 | **Settings honesty** | Open Settings in either mode | Shows the workspace, the six applied migrations, and the note that this is a local demonstration, not secure multi-user authentication |

---

## 15. Troubleshooting

### The login buttons do nothing (or the dashboard says it cannot reach the server)

Both symptoms have the same cause: the page is being shown inside a **sandboxed iframe** — some
editors and preview panes do this. Such a frame blocks `localStorage` *and* native form submission,
and it sends `Origin: null`, so `/api` calls need CORS headers (the server sends them since 2.2).

The app now degrades honestly instead of failing silently: the login page shows a warning, the
buttons work anyway, and *Continue without an account* opens the app. To avoid the limitations
entirely, open **<http://localhost:3000>** in a normal browser tab. Full details:
`docs/SUPABASE.md` §10.

### `better-sqlite3` fails to install (native module)

This is the only dependency that needs a compiler. Symptoms: `node-gyp` errors, `MSB8020`,
`gyp ERR!`, `prebuild-install` warnings during `npm install`.

Try in this order:

1. **Use Node.js LTS (v18 or v20)** — prebuilt binaries exist for these. Node "Current"
   versions sometimes have none yet. Check with `node --version`.
2. **Delete and reinstall**: remove `node_modules` and `package-lock.json`, then `npm install`
   again.
3. **Windows:** install the *Desktop development with C++* workload from
   [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), then
   `npm install` again. If you see `EPERM`/`long path` errors, run the terminal as Administrator.
4. **Force a build from source** (uses your compiler):
   `npm install better-sqlite3 --build-from-source`
5. **macOS:** `xcode-select --install`, then `npm install` again.
6. **Linux:** `sudo apt install -y build-essential python3`, then `npm install` again.
7. Company/school proxy: `npm config set registry https://registry.npmjs.org/` and retry.

If none of that works, do **not** silently switch to another database library — the project is
designed around `better-sqlite3`. Show the exact error to your lab instructor; it is almost always
a Node version or missing C++ toolchain issue.

### `Error: listen EADDRINUSE :::3000`

Port 3000 is already used (often a previous server that is still running).
Either stop the other process, or start on another port: `PORT=4000 npm start`
(Windows CMD: `set PORT=4000 && npm start`) and open <http://localhost:4000>.

### The page loads but every card is empty / "Cannot reach the SmartSpend server"

The Node.js process is not running. Run `npm start` and keep that terminal open.

### Charts show "Charts unavailable"

`public/assets/vendor/chart.umd.min.js` is missing and there is no internet for the CDN
fallback. Re-copy the file into that folder, or connect to the internet once.

### `npm install` is slow or blocked

School/lab networks sometimes block npm. Use a mobile hotspot, or pre-download the two
dependencies at home.

---

## 16. Extra documents for submission

| File | What it is for |
|---|---|
| `docs/API.md` | Complete API reference: every endpoint, request body, response, status codes |
| `docs/TEST_STEPS.md` | A hand-runnable test script (Individual and Business), with expected results |
| `docs/ACCEPTANCE.md` | The 15 acceptance criteria with the evidence for each one |
| `docs/PROJECT_REPORT.md` | Report outline: abstract, objectives, design, testing, future scope |
| `docs/VIVA_QUESTIONS.md` | Viva questions with model answers (includes the 2.0 questions) |
| `docs/SUPABASE.md` | Supabase setup (SQL, redirect URLs, confirmation toggle) + exactly what the login does and does not protect |
| `docs/screenshots/` | Screenshots of the running app for your report |

### Optional demo data

Two separate, clearly-labelled seed scripts exist. **Neither runs automatically**, and neither
touches the other mode's data.

```bash
npm run seed            # add personal demo transactions + budgets (workspace 1)
npm run seed:reset      # wipe personal rows first, then re-add
npm run seed:business   # add business demo records  (workspace 2) — all prefixed [DEMO]/DEMO-
npm run seed:business -- --force   # remove the demo records and re-create them
```

`seed:business` creates 2 customers, 1 vendor, 3 transactions, 2 invoices (one partially paid,
one overdue) and 1 vendor bill (partially paid) with numbers that reconcile by hand:
revenue ₹32,500, expenses ₹6,000, net profit ₹26,500, receivable ₹18,240, payable ₹3,200.
It refuses to run twice unless you pass `--force`, so it can never pile up duplicates.

---

## 17. Limitations and honest notes

**Architecture and security**

- **There is now a login** (v2.2): Supabase Auth accounts, an `auth-guard.js` gate on `/`, and RLS on
  the `profiles` table. It is still **not** a multi-tenant system — the Express API does not verify
  tokens and the finance data is a single local SQLite file. Read §18 before writing about security.
- The database file is unencrypted and shared by every account that signs in on this computer.
- The Individual / Business switcher is a **local profile selection**, not authentication. Data is
  separated by `workspace_id` in every query (which is real), but it is *not* secured from another
  person using the same machine. The app says so on the Settings screen.
- The database file is unencrypted. Fine for a college project; not for real bank data.
- There is no audit log, no user roles and no permission model.

**Financial scope**

- Currency is fixed to ₹ (INR). Money is stored as integer paise (`amount_minor`) and displayed as
  rupees; multi-currency is out of scope.
- Business numbers are **basic bookkeeping estimates, not audited financial statements**. There is no
  double-entry ledger, no chart of accounts, no GST filing, no depreciation, no inventory valuation.
- **Tax figures are estimates** based only on rates the user types in. SmartSpend never decides what
  is deductible and does not give tax advice.
- Invoice status is derived from payments + due date; there are no credit notes, no partial refunds
  against a paid invoice (remove the payment instead, which is logged on screen), and no
  multi-currency invoices.
- Deleting a customer/vendor with linked records is blocked, but deleting an **invoice** with
  payments removes those payments with it. The confirmation dialog says so.
- Reports and CSV exports are designed for personal / small-business volumes (thousands of rows).

**Frontend**

- No build step, no framework, no TypeScript — a deliberate choice so a second-year student can read
  every line.
- Charts need the bundled `chart.umd.min.js`; if it is missing (and there is no internet) the app
  shows a friendly "Charts unavailable" message and all tables still work.
- Print-to-PDF uses the browser's own print dialog; the exact pagination depends on the browser.
- The UI was verified in headless Chromium. Old browsers without `<dialog>` support will still work
  but fall back to non-modal behaviour.

**Not implemented (and not claimed)**

- No password reset, no OAuth, no email, no receipt image upload, no bank-statement import,
  no multi-device sync, no backup automation, no PWA/offline install.
- **This is not production-ready software and should not be used to keep real financial records.**

---

## 18. Accounts and Supabase (new in 2.2)

### What the user sees

1. `/` redirects to **`/login.html`** when there is no session and local mode is off.
2. Sign in, create account, forgot password, or **Continue without an account**.
3. On success the sidebar footer shows an account panel — avatar initial, email, and
   **Sign out**. In local mode it says *Local mode*.
4. **Settings → Account & cloud** shows the live Supabase state, lets you save a display name, and
   tells you plainly when `supabase/schema.sql` has not been run.

### What is stored where

| Data | Where |
|---|---|
| Account, password hash, sessions | Supabase Auth (`auth.users`) |
| `profiles` row (email, display name, default mode) | Supabase Postgres, protected by RLS (`auth.uid() = id`) |
| Receipt files | Supabase Storage, private `receipts` bucket, `<uid>/…` folders |
| **Transactions, budgets, goals, invoices, customers, bills, reports** | **SQLite, `expense-tracker.db`, on this computer** — the source of truth. A one-way copy of the whole book is mirrored into the matching Postgres tables after every save and on every page load, so it appears in the Supabase table editor. Editing a row in Postgres changes nothing in the app — see `docs/SCHEMA.md` §6 |

### Files

| File | Job |
|---|---|
| `public/js/safe-storage.js` | a `localStorage` wrapper that never throws (memory fallback for sandboxed frames / private mode) |
| `public/js/supabase-config.js` | project URL + publishable key (public by design) |
| `public/js/supabase-client.js` | dependency-free client: signup / token / user / logout, `restSelect` / `restInsert` / `restUpdate`, session in `localStorage`, human error messages |
| `public/js/sync.js` | one-way mirror of the local book into the Supabase tables after every save (delete my rows, insert in FK order, `local_id`, debounced) plus the **Settings → Supabase copy** card |
| `public/js/login.js` | tabs, validation, password reveal, strength hint, reset email, status line |
| `public/js/auth-guard.js` | synchronous redirect to the login page, then a background `GET /auth/v1/user` re-validation; injects the account panel |
| `public/js/cloud.js` | the Settings → Account & cloud card |
| `supabase/schema.sql` | idempotent DDL: 15 tables (profiles + both books), 3 views, integrity triggers, 60 RLS policies, private `receipts` bucket |
| `supabase/verify.sql` | self-test: 28 assertions, ends with `ROLLBACK` so nothing is left behind |

### The three honest caveats

1. **`/api/*` is not authenticated.** The gate is in the browser. `curl localhost:3000/api/transactions`
   still answers. Acceptable for a localhost mini project; written down here so nobody claims
   otherwise in the report.
2. **Two browsers, one account, different data.** Each browser uses its own `expense-tracker.db`,
   because the money tables were never moved to Supabase.
3. **Mode switching is still not a permission.** Individual vs Business is a workspace id.
4. **The API answers `Access-Control-Allow-Origin: *`.** `/api/*` uses no cookies or tokens, so this
   grants nothing that `curl` on the same port could not already do; it exists so the page also works
   when embedded in a sandboxed frame (such a frame sends `Origin: null`).

Moving the finance tables to Supabase later means: run `supabase/schema.sql` (it already contains
every table with `user_id uuid default auth.uid()` + RLS + integrity triggers — see `docs/SCHEMA.md`),
then swap the repositories over to it and make Express verify the bearer token before answering
`/api/*`. Setup instructions,
redirect URLs, the confirmation-email toggle and every error message are in **`docs/SUPABASE.md`**.

---

## 19. Putting it online (and why GitHub Pages can't)

SmartSpend is a **Node.js + Express + SQLite** application. GitHub Pages serves *static files
only*, so it can never run this app: there is no `/api`, no database file and nowhere to store a
transaction. A static copy will render, but the dashboard stays empty — which is what
*"deployed it and nothing works"* looks like.

| Where | What it is good for |
|---|---|
| GitHub **repository** | the source code, history and docs — perfect |
| GitHub **Pages** | a static showcase page only (*never* the app) |
| **Render / Railway / Fly.io / Koyeb / a VPS** | the actual running application |
| **localhost** | the viva, offline, with no setup |

Two things were fixed in 2.2 to make this less confusing:

* **all asset paths are relative** (`js/app.js`, not `/js/app.js`), so the pages also work when
  served from a sub-folder such as `https://user.github.io/repo/`;
* when `/api` cannot answer, the app shows **one honest banner** — *"No backend here …"* — instead
  of an error toast for every request.

### Deploy in three steps (Render, free)

1. Push this folder to GitHub.
2. <https://dashboard.render.com> → **New → Blueprint** → choose the repository. `render.yaml`
   defines the service (`npm install` → `npm start`, health check `/api/health`).
3. Open `https://<service>.onrender.com`, then update **Supabase → Authentication → URL
   Configuration** with that domain.

`render.yaml` also sets `SMARTSPEND_SEED_DEMO=1`, which fills an **empty** database with the demo
rows on boot — needed on free plans, whose disk is wiped on every restart. A ready `Dockerfile`
does the same job on any container host. Full details, the free-plan storage caveat and a
troubleshooting table: **`docs/DEPLOY.md`**.
