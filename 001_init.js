/**
 * Migration 001 — baseline (the SmartSpend 1.0 schema).
 *
 * For a brand-new database this creates the original two tables.
 * For an EXISTING v1 database every statement is a no-op because of
 * `IF NOT EXISTS`, so nothing is lost and no data is touched.
 */

const id = '001_init';
const description = 'Baseline: transactions + budgets tables from SmartSpend 1.0';

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      type             TEXT    NOT NULL CHECK (type IN ('income', 'expense')),
      title            TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 100),
      category         TEXT    NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 40),
      amount           REAL    NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
      transaction_date TEXT    NOT NULL CHECK (transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      notes            TEXT             CHECK (notes IS NULL OR length(notes) <= 500),
      created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_date     ON transactions (transaction_date DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (category);
    CREATE INDEX IF NOT EXISTS idx_transactions_type     ON transactions (type);

    CREATE TABLE IF NOT EXISTS budgets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      month      TEXT    NOT NULL UNIQUE
                 CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
      amount     REAL    NOT NULL CHECK (amount >= 0 AND amount <= 1000000000),
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { id, description, up };
