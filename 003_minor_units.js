/**
 * Migration 003 — rebuild `transactions` and `budgets`.
 *
 * WHY REBUILD? SQLite cannot add a foreign key, a CHECK constraint or change a
 * UNIQUE constraint on an existing table. The official workaround is the
 * "12-step ALTER TABLE" procedure:
 *     1. create the new table with the shape you want
 *     2. INSERT INTO new SELECT ... FROM old   <-- data is copied, ids kept
 *     3. drop the old table
 *     4. rename new -> old
 *     5. recreate indexes
 * The runner wraps this in a single transaction, so it either fully succeeds
 * or leaves the original tables untouched.
 *
 * WHAT CHANGES
 *   transactions
 *     + workspace_id   -> each row belongs to Personal or Business
 *     + amount_minor   -> money is now stored as INTEGER paise (no rounding bugs)
 *     ~ amount         -> now a GENERATED column (amount_minor / 100) so old
 *                         code that reads `amount` keeps working, but there is
 *                         only ONE source of truth
 *     + payment_method, customer_id, vendor_id, invoice_id,
 *       tax_rate, tax_minor, recurring_rule_id
 *   budgets
 *     + workspace_id, amount_minor
 *     ~ UNIQUE(month) becomes UNIQUE(workspace_id, month) so each workspace can
 *       keep its own budget for the same month
 */

const id = '003_minor_units';
const description = 'rebuild transactions + budgets: workspace_id, integer paise, business fields';

function up(db) {
  // ---------------------------------------------------------------------------
  // transactions
  // ---------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE transactions_v2 (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id     INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      type             TEXT    NOT NULL CHECK (type IN ('income', 'expense')),
      title            TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 100),
      category         TEXT    NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 40),
      amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 100000000000),
      amount           REAL    GENERATED ALWAYS AS (amount_minor / 100.0) VIRTUAL,
      transaction_date TEXT    NOT NULL CHECK (transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      notes            TEXT             CHECK (notes IS NULL OR length(notes) <= 500),
      -- business-only fields; harmless (NULL) for personal rows
      payment_method   TEXT,
      customer_id      INTEGER REFERENCES customers (id) ON DELETE SET NULL,
      vendor_id        INTEGER REFERENCES vendors (id)   ON DELETE SET NULL,
      invoice_id       INTEGER,
      tax_rate         REAL    NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
      tax_minor        INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      recurring_rule_id INTEGER,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Copy every existing row into workspace 1 (Personal) and convert
    -- rupees REAL -> integer paise. ROUND() removes floating point noise.
    INSERT INTO transactions_v2
      (id, workspace_id, type, title, category, amount_minor, transaction_date, notes, created_at)
    SELECT
      id, 1, type, title, category,
      CAST(ROUND(amount * 100) AS INTEGER),
      transaction_date, notes, created_at
    FROM transactions;

    DROP TABLE transactions;
    ALTER TABLE transactions_v2 RENAME TO transactions;

    CREATE INDEX IF NOT EXISTS idx_transactions_ws_date
      ON transactions (workspace_id, transaction_date DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_ws_category
      ON transactions (workspace_id, category);
    CREATE INDEX IF NOT EXISTS idx_transactions_ws_type
      ON transactions (workspace_id, type);
    CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions (customer_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_vendor   ON transactions (vendor_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_invoice  ON transactions (invoice_id);

    -- Idempotent recurring generation: a rule can only ever produce ONE
    -- transaction per date. The database enforces it, not the JavaScript.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_recurring_once
      ON transactions (recurring_rule_id, transaction_date)
      WHERE recurring_rule_id IS NOT NULL;
  `);

  // ---------------------------------------------------------------------------
  // budgets
  // ---------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE budgets_v2 (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      month        TEXT    NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
      amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0 AND amount_minor <= 100000000000),
      amount       REAL    GENERATED ALWAYS AS (amount_minor / 100.0) VIRTUAL,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (workspace_id, month)
    );

    INSERT INTO budgets_v2 (id, workspace_id, month, amount_minor, created_at, updated_at)
    SELECT id, 1, month, CAST(ROUND(amount * 100) AS INTEGER), created_at, updated_at
    FROM budgets;

    DROP TABLE budgets;
    ALTER TABLE budgets_v2 RENAME TO budgets;

    CREATE INDEX IF NOT EXISTS idx_budgets_workspace ON budgets (workspace_id, month);
  `);
}

module.exports = { id, description, up };
