/**
 * Migration 004 — invoices, invoice items, invoice payments, vendor bills.
 *
 * DESIGN NOTES
 *  - INVOICE STATUS IS NEVER STORED. It is derived from the payments table plus
 *    the due date (see src/repositories/invoices.js). That is why printing or
 *    opening an invoice can never mark it "Paid" — only recorded money can.
 *  - `is_draft` / `is_cancelled` are the only manual flags.
 *  - Money is INTEGER paise everywhere.
 *  - ON DELETE RESTRICT on customers/vendors means the database itself refuses
 *    to delete a customer that still has invoices (belt and braces: the API
 *    returns a friendly 409 before we ever get here).
 *  - `reference TEXT NOT NULL DEFAULT ''` (not NULL) so the UNIQUE index really
 *    does block duplicate payments - SQLite treats NULLs as distinct.
 */

const id = '004_invoices_bills';
const description = 'invoices + items + payments, vendor bills + payments';

function up(db) {
  db.exec(`
    -- ================================================================ invoices
    CREATE TABLE IF NOT EXISTS invoices (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id   INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      invoice_number TEXT    NOT NULL CHECK (length(trim(invoice_number)) BETWEEN 1 AND 40),
      customer_id    INTEGER NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
      invoice_date   TEXT    NOT NULL CHECK (invoice_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      due_date       TEXT    NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      is_draft       INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0, 1)),
      is_cancelled   INTEGER NOT NULL DEFAULT 0 CHECK (is_cancelled IN (0, 1)),
      notes          TEXT,
      subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
      tax_minor      INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      total_minor    INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (workspace_id, invoice_number),
      CHECK (due_date >= invoice_date)
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_workspace ON invoices (workspace_id, invoice_date DESC);
    CREATE INDEX IF NOT EXISTS idx_invoices_customer  ON invoices (customer_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_due       ON invoices (workspace_id, due_date);

    -- ============================================================ invoice items
    CREATE TABLE IF NOT EXISTS invoice_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id       INTEGER NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
      description      TEXT    NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 200),
      quantity         REAL    NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
      unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
      tax_rate         REAL    NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
      line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
      position         INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id, position);

    -- ========================================================= invoice payments
    CREATE TABLE IF NOT EXISTS invoice_payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id  INTEGER NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      paid_on     TEXT    NOT NULL CHECK (paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      method      TEXT    NOT NULL DEFAULT 'cash',
      reference   TEXT    NOT NULL DEFAULT '',
      notes       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      -- blocks an accidental double-submit of the exact same payment
      UNIQUE (invoice_id, paid_on, amount_minor, reference)
    );

    CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments (invoice_id);
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_date    ON invoice_payments (paid_on);

    -- ============================================================= vendor bills
    CREATE TABLE IF NOT EXISTS vendor_bills (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id  INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      vendor_id     INTEGER NOT NULL REFERENCES vendors (id) ON DELETE RESTRICT,
      bill_number   TEXT    NOT NULL CHECK (length(trim(bill_number)) BETWEEN 1 AND 60),
      bill_date     TEXT    NOT NULL CHECK (bill_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      due_date      TEXT    NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      description   TEXT,
      amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
      tax_rate      REAL    NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
      tax_minor     INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      is_cancelled  INTEGER NOT NULL DEFAULT 0 CHECK (is_cancelled IN (0, 1)),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (workspace_id, vendor_id, bill_number),
      CHECK (due_date >= bill_date)
    );

    CREATE INDEX IF NOT EXISTS idx_vendor_bills_workspace ON vendor_bills (workspace_id, bill_date DESC);
    CREATE INDEX IF NOT EXISTS idx_vendor_bills_vendor    ON vendor_bills (vendor_id);
    CREATE INDEX IF NOT EXISTS idx_vendor_bills_due       ON vendor_bills (workspace_id, due_date);

    -- ==================================================== vendor bill payments
    CREATE TABLE IF NOT EXISTS vendor_bill_payments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_bill_id INTEGER NOT NULL REFERENCES vendor_bills (id) ON DELETE CASCADE,
      amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
      paid_on        TEXT    NOT NULL CHECK (paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      method         TEXT    NOT NULL DEFAULT 'cash',
      reference      TEXT    NOT NULL DEFAULT '',
      notes          TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (vendor_bill_id, paid_on, amount_minor, reference)
    );

    CREATE INDEX IF NOT EXISTS idx_vendor_bill_payments_bill ON vendor_bill_payments (vendor_bill_id);
    CREATE INDEX IF NOT EXISTS idx_vendor_bill_payments_date ON vendor_bill_payments (paid_on);
  `);
}

module.exports = { id, description, up };
