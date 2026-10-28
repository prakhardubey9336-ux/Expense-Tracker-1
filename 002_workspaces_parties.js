/**
 * Migration 002 — workspaces, customers and vendors.
 *
 * WHAT IS A WORKSPACE?
 *   A workspace is one "finance book". SmartSpend 2.0 creates two:
 *     id 1 → "Personal"   (mode: individual)
 *     id 2 → "My Business" (mode: business)
 *   Every transaction, budget, invoice... belongs to exactly one workspace, so
 *   personal money and business money can never mix in a report.
 *
 * These are created with fixed ids and `INSERT OR IGNORE`, so running this on a
 * database that already has them does nothing.
 */

const id = '002_workspaces_parties';
const description = 'workspaces (individual + business), customers, vendors';

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
      type       TEXT    NOT NULL CHECK (type IN ('individual', 'business')),
      currency   TEXT    NOT NULL DEFAULT 'INR',
      notes      TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_type ON workspaces (type);

    -- ---------------------------------------------------------------- customers
    CREATE TABLE IF NOT EXISTS customers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id   INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      name           TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
      contact_person TEXT,
      email          TEXT,
      phone          TEXT,
      address        TEXT,
      notes          TEXT,
      is_archived    INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_customers_workspace ON customers (workspace_id, is_archived);
    CREATE INDEX IF NOT EXISTS idx_customers_name      ON customers (workspace_id, name);

    -- ------------------------------------------------------------------ vendors
    CREATE TABLE IF NOT EXISTS vendors (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id   INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      name           TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
      contact_person TEXT,
      email          TEXT,
      phone          TEXT,
      address        TEXT,
      notes          TEXT,
      is_archived    INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_vendors_workspace ON vendors (workspace_id, is_archived);
    CREATE INDEX IF NOT EXISTS idx_vendors_name      ON vendors (workspace_id, name);
  `);

  // Two default workspaces. Fixed ids keep the migration idempotent and let the
  // rest of the app rely on workspace 1 = individual, workspace 2 = business.
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, type) VALUES (1, 'Personal', 'individual')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, type) VALUES (2, 'My Business', 'business')`
  ).run();

  // Any transaction/budget that exists today is personal data.
  // (Migration 003 moves these columns into the rebuilt tables.)
}

module.exports = { id, description, up };
