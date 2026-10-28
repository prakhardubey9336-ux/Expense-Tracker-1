/**
 * src/migrations/index.js
 * ---------------------------------------------------------------------------
 * A tiny, versioned migration runner.
 *
 * WHY: SmartSpend 2.0 changes the database a lot (workspaces, integer paise,
 * invoices, customers, vendors...). We must NEVER drop the user's tables.
 * So every schema change is a numbered migration file that runs exactly once.
 * The `schema_migrations` table records what has already been applied.
 *
 *   src/migrations/001_init.js                 baseline (v1 tables)
 *   src/migrations/002_workspaces_parties.js   workspaces, customers, vendors
 *   src/migrations/003_minor_units.js          rebuild transactions + budgets
 *   src/migrations/004_invoices_bills.js       invoices, items, payments, bills
 *   src/migrations/005_recurring_goals.js       recurring rules, savings goals,
 *                                              category budgets
 *   src/migrations/006_bill_notes.js           notes column on vendor bills
 *
 * Rules for writing a migration (see docs/MIGRATIONS.md):
 *   - idempotent where possible (`IF NOT EXISTS`)
 *   - wrap the change in a transaction (the runner does this for you)
 *   - copy data forward with `INSERT INTO new ... SELECT ... FROM old`
 *   - never `DROP TABLE` unless the data was already copied
 * ---------------------------------------------------------------------------
 */

const migrations = [
  require('./001_init'),
  require('./002_workspaces_parties'),
  require('./003_minor_units'),
  require('./004_invoices_bills'),
  require('./005_recurring_goals'),
  require('./006_bill_notes'),
];

/**
 * Applies every migration that has not been applied yet.
 * Returns the list of ids that ran in this call.
 */
function runMigrations(db, { log = false } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id)
  );
  const record = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');

  const ran = [];

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    if (log) console.log(`  [db] applying migration ${migration.id} — ${migration.description}`);

    // Foreign keys must be OFF while a table is rebuilt (SQLite "12-step"
    // ALTER procedure). We turn them back on afterwards.
    db.pragma('foreign_keys = OFF');
    try {
      const apply = db.transaction(() => {
        migration.up(db);
        record.run(migration.id);
      });
      apply();
      ran.push(migration.id);
    } catch (error) {
      // The transaction rolled back, so the database is exactly as it was.
      db.pragma('foreign_keys = ON');
      const wrapped = new Error(`Migration ${migration.id} failed: ${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  // Sanity check: if this reports rows, a migration broke a reference.
  const brokenRefs = db.pragma('foreign_key_check');
  if (Array.isArray(brokenRefs) && brokenRefs.length > 0 && log) {
    console.warn(`  [db] warning: ${brokenRefs.length} broken foreign key reference(s) found`);
  }

  return ran;
}

/** Used by the Settings screen and the tests. */
function migrationStatus(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Map(
    db.prepare('SELECT id, applied_at FROM schema_migrations').all().map((r) => [r.id, r.applied_at])
  );
  return migrations.map((m) => ({
    id: m.id,
    description: m.description,
    applied: applied.has(m.id),
    appliedAt: applied.get(m.id) || null,
  }));
}

module.exports = { runMigrations, migrationStatus, migrations };
