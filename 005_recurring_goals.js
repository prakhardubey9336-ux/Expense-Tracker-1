/**
 * Migration 005 — recurring rules, savings goals, category budgets.
 *
 * RECURRING EXPENSES
 *   A rule says "every month on the 5th: Hostel rent ₹3000".
 *   No transaction is created when a page loads. A transaction is created only
 *   when the user presses "Generate due entries", and even then the UNIQUE
 *   index from migration 003 (recurring_rule_id, transaction_date) makes the
 *   operation idempotent - running it twice can never duplicate a row.
 *
 * SAVINGS GOALS
 *   Goal (target) + contributions (money actually put aside). Progress is the
 *   SUM of contributions, so it can never drift out of sync.
 */

const id = '005_recurring_goals';
const description = 'recurring expense rules, savings goals + contributions, category budgets';

function up(db) {
  db.exec(`
    -- ========================================================= recurring rules
    CREATE TABLE IF NOT EXISTS recurring_rules (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id  INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      title         TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 100),
      type          TEXT    NOT NULL DEFAULT 'expense' CHECK (type IN ('income', 'expense')),
      category      TEXT    NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 40),
      amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
      amount        REAL    GENERATED ALWAYS AS (amount_minor / 100.0) VIRTUAL,
      frequency     TEXT    NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
      start_date    TEXT    NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      next_due_date TEXT    NOT NULL CHECK (next_due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      notes         TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_recurring_workspace ON recurring_rules (workspace_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_recurring_due       ON recurring_rules (next_due_date);

    -- =========================================================== savings goals
    CREATE TABLE IF NOT EXISTS savings_goals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      name         TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
      target_minor INTEGER NOT NULL CHECK (target_minor > 0),
      target       REAL    GENERATED ALWAYS AS (target_minor / 100.0) VIRTUAL,
      target_date  TEXT,
      notes        TEXT,
      is_archived  INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_savings_goals_workspace ON savings_goals (workspace_id, is_archived);

    CREATE TABLE IF NOT EXISTS savings_goal_contributions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id       INTEGER NOT NULL REFERENCES savings_goals (id) ON DELETE CASCADE,
      amount_minor  INTEGER NOT NULL CHECK (amount_minor <> 0),
      contributed_on TEXT   NOT NULL CHECK (contributed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      notes         TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_goal_contributions_goal ON savings_goal_contributions (goal_id);

    -- ======================================================== category budgets
    CREATE TABLE IF NOT EXISTS category_budgets (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
      month        TEXT    NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
      category     TEXT    NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 40),
      amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
      amount       REAL    GENERATED ALWAYS AS (amount_minor / 100.0) VIRTUAL,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (workspace_id, month, category)
    );

    CREATE INDEX IF NOT EXISTS idx_category_budgets_workspace
      ON category_budgets (workspace_id, month);
  `);
}

module.exports = { id, description, up };
