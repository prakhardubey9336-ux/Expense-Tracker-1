/**
 * src/repositories/parties.js
 * ---------------------------------------------------------------------------
 * Customers and vendors. They have the same shape, so one factory builds both
 * repositories and we avoid duplicating ~150 lines of SQL.
 *
 * SAFE DELETION (an important requirement):
 *   A customer with invoices, or a vendor with bills/expenses, is ARCHIVED
 *   instead of deleted. Deleting would silently orphan financial records, so:
 *     - DELETE /api/customers/:id  -> returns 409 with a clear message while
 *       the customer is referenced
 *     - POST   /api/customers/:id/archive -> hides it from pickers but keeps
 *       every historical record intact
 *   The database also has ON DELETE RESTRICT on invoices.customer_id as a
 *   second line of defence.
 * ---------------------------------------------------------------------------
 */

const { db } = require('../../database');
const { notFound, conflict } = require('../validation');

function buildRepo(table, kind) {
  const label = kind === 'customer' ? 'Customer' : 'Vendor';

  // Which records reference this party?
  const referenceChecks =
    kind === 'customer'
      ? [
          { sql: 'SELECT COUNT(*) c FROM invoices WHERE customer_id = ?', what: 'invoice' },
          { sql: 'SELECT COUNT(*) c FROM transactions WHERE customer_id = ?', what: 'transaction' },
        ]
      : [
          { sql: 'SELECT COUNT(*) c FROM vendor_bills WHERE vendor_id = ?', what: 'bill' },
          { sql: 'SELECT COUNT(*) c FROM transactions WHERE vendor_id = ?', what: 'transaction' },
        ];

  const listStmt = db.prepare(`
    SELECT p.*,
           ${kind === 'customer'
             ? `(SELECT COUNT(*) FROM invoices i WHERE i.customer_id = p.id)          AS invoice_count,
                (SELECT IFNULL(SUM(i.total_minor - IFNULL(pay.paid,0)), 0)
                   FROM invoices i
                   LEFT JOIN (SELECT invoice_id, SUM(amount_minor) paid FROM invoice_payments GROUP BY invoice_id) pay
                          ON pay.invoice_id = i.id
                  WHERE i.customer_id = p.id AND i.is_draft = 0 AND i.is_cancelled = 0) AS outstanding_minor`
             : `(SELECT COUNT(*) FROM vendor_bills b WHERE b.vendor_id = p.id)        AS bill_count,
                (SELECT IFNULL(SUM((b.amount_minor + b.tax_minor) - IFNULL(pay.paid,0)), 0)
                   FROM vendor_bills b
                   LEFT JOIN (SELECT vendor_bill_id, SUM(amount_minor) paid FROM vendor_bill_payments GROUP BY vendor_bill_id) pay
                          ON pay.vendor_bill_id = b.id
                  WHERE b.vendor_id = p.id AND b.is_cancelled = 0)                  AS outstanding_minor`}
      FROM ${table} p
     WHERE p.workspace_id = @workspace_id
       AND (@include_archived = 1 OR p.is_archived = 0)
       AND (@search IS NULL OR p.name LIKE @search OR IFNULL(p.email,'') LIKE @search OR IFNULL(p.phone,'') LIKE @search)
     ORDER BY p.is_archived ASC, p.name COLLATE NOCASE ASC
  `);

  const byIdStmt = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND workspace_id = ?`);

  const insertStmt = db.prepare(`
    INSERT INTO ${table} (workspace_id, name, contact_person, email, phone, address, notes)
    VALUES (@workspace_id, @name, @contact_person, @email, @phone, @address, @notes)
  `);

  const updateStmt = db.prepare(`
    UPDATE ${table}
       SET name = @name, contact_person = @contact_person, email = @email,
           phone = @phone, address = @address, notes = @notes,
           updated_at = datetime('now')
     WHERE id = @id AND workspace_id = @workspace_id
  `);

  const decorate = (row) => {
    if (!row) return row;
    return { ...row, is_archived: Boolean(row.is_archived) };
  };

  function list(workspaceId, query = {}) {
    const search = (query.search || '').toString().trim();
    const rows = listStmt.all({
      workspace_id: workspaceId,
      include_archived: query.includeArchived === 'true' || query.includeArchived === 1 ? 1 : 0,
      search: search ? `%${search.replace(/[%_]/g, (ch) => `\\${ch}`)}%` : null,
    });
    return rows.map(decorate);
  }

  function get(id, workspaceId) {
    const row = byIdStmt.get(id, workspaceId);
    if (!row) throw notFound(`${label} not found.`);
    return decorate(row);
  }

  function create(data, workspaceId) {
    // Friendly duplicate check: same name in the same workspace.
    const existing = db
      .prepare(`SELECT id FROM ${table} WHERE workspace_id = ? AND lower(trim(name)) = lower(trim(?))`)
      .get(workspaceId, data.name);
    if (existing) {
      throw conflict(`A ${label.toLowerCase()} called "${data.name}" already exists.`, {
        name: 'Use a different name, or edit the existing record.',
      });
    }

    const info = insertStmt.run({
      workspace_id: workspaceId,
      name: data.name,
      contact_person: data.contact_person ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      address: data.address ?? null,
      notes: data.notes ?? null,
    });
    return get(info.lastInsertRowid, workspaceId);
  }

  function update(id, data, workspaceId) {
    get(id, workspaceId);
    const clash = db
      .prepare(`SELECT id FROM ${table} WHERE workspace_id = ? AND lower(trim(name)) = lower(trim(?)) AND id <> ?`)
      .get(workspaceId, data.name, id);
    if (clash) {
      throw conflict(`Another ${label.toLowerCase()} already uses the name "${data.name}".`, {
        name: 'Please choose a different name.',
      });
    }
    updateStmt.run({
      id,
      workspace_id: workspaceId,
      name: data.name,
      contact_person: data.contact_person ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      address: data.address ?? null,
      notes: data.notes ?? null,
    });
    return get(id, workspaceId);
  }

  /** How many records would be affected if this party were deleted? */
  function references(id) {
    return referenceChecks.map((check) => ({
      what: check.what,
      count: db.prepare(check.sql).get(id).c,
    }));
  }

  function remove(id, workspaceId) {
    const party = get(id, workspaceId);
    const refs = references(id).filter((r) => r.count > 0);

    if (refs.length > 0) {
      // Refuse, and explain exactly why. The user can archive instead.
      const detail = refs.map((r) => `${r.count} ${r.what}${r.count === 1 ? '' : 's'}`).join(' and ');
      throw conflict(
        `${party.name} cannot be deleted because it is linked to ${detail}. ` +
          'Archive it instead to keep your financial records intact.',
        { references: refs }
      );
    }

    db.prepare(`DELETE FROM ${table} WHERE id = ? AND workspace_id = ?`).run(id, workspaceId);
    return party;
  }

  function setArchived(id, workspaceId, archived) {
    const party = get(id, workspaceId);
    db.prepare(`UPDATE ${table} SET is_archived = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
      .run(archived ? 1 : 0, id, workspaceId);
    return get(party.id, workspaceId);
  }

  return { list, get, create, update, remove, setArchived, references, table };
}

const customers = buildRepo('customers', 'customer');
const vendors = buildRepo('vendors', 'vendor');

module.exports = { customers, vendors };
