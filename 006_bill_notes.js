/**
 * Migration 006 — add `notes` to vendor_bills.
 *
 * Found while testing the 2.0 vendor-bill module: the UI collects an optional
 * note, but migration 004 forgot the column. Rather than editing 004 (which may
 * already have been applied on someone's database), we APPEND a migration.
 *
 * `ALTER TABLE ... ADD COLUMN` is safe and non-destructive: existing rows simply
 * get NULL, and no other table is touched. This is also a nice demonstration of
 * why append-only migrations matter.
 */

const id = '006_bill_notes';
const description = 'add optional notes column to vendor_bills';

function up(db) {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('vendor_bills')`).all().map((c) => c.name);
  if (!columns.includes('notes')) {
    db.exec(`ALTER TABLE vendor_bills ADD COLUMN notes TEXT`);
  }
}

module.exports = { id, description, up };
