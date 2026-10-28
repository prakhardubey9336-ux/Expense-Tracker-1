/**
 * src/repositories/invoices.js
 * ---------------------------------------------------------------------------
 * Invoices + line items + payments.
 *
 * THE THREE GOLDEN RULES
 *  1. TOTALS ARE CALCULATED ON THE SERVER from the line items. Any total the
 *     browser sends is ignored (see validateInvoiceInput + computeDocumentTotals).
 *  2. STATUS IS NEVER STORED. It is derived from the payments table and the due
 *     date every time it is read, so opening or printing an invoice can never
 *     mark it paid. Only a recorded payment can.
 *  3. PAYMENTS CANNOT EXCEED THE OUTSTANDING BALANCE, and duplicate payments
 *     are rejected (UNIQUE index + an explicit check with a helpful message).
 *
 * All multi-row writes run inside `db.transaction(...)`, so an invoice can never
 * exist without its items.
 * ---------------------------------------------------------------------------
 */

const { db } = require('../../database');
const { notFound, conflict, badRequest, todayISO } = require('../validation');
const { toRupees, computeDocumentTotals } = require('../money');

/**
 * Shared SELECT. `paid_minor` and `status` are computed here, once, so the API
 * and the UI can never disagree about whether an invoice is overdue.
 */
const INVOICE_SELECT = `
  SELECT i.*,
         c.name  AS customer_name,
         c.email AS customer_email,
         c.phone AS customer_phone,
         c.address AS customer_address,
         IFNULL(p.paid_minor, 0) AS paid_minor,
         (i.total_minor - IFNULL(p.paid_minor, 0)) AS balance_minor,
         CASE
           WHEN i.is_cancelled = 1 THEN 'cancelled'
           WHEN i.is_draft = 1     THEN 'draft'
           WHEN IFNULL(p.paid_minor, 0) >= i.total_minor THEN 'paid'
           WHEN i.due_date < @today THEN 'overdue'
           WHEN IFNULL(p.paid_minor, 0) > 0 THEN 'partially_paid'
           ELSE 'unpaid'
         END AS status
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN (
         SELECT invoice_id, SUM(amount_minor) AS paid_minor
           FROM invoice_payments GROUP BY invoice_id
    ) p ON p.invoice_id = i.id
`;

function decorate(row) {
  if (!row) return row;
  return {
    ...row,
    is_draft: Boolean(row.is_draft),
    is_cancelled: Boolean(row.is_cancelled),
    subtotal: toRupees(row.subtotal_minor),
    tax: toRupees(row.tax_minor),
    total: toRupees(row.total_minor),
    paid: toRupees(row.paid_minor),
    balance: toRupees(row.balance_minor),
    // convenience flags for the UI badges
    isPaid: row.status === 'paid',
    isOverdue: row.status === 'overdue',
  };
}

function listInvoices(workspaceId, query = {}) {
  const clauses = ['i.workspace_id = @workspace_id'];
  const params = { workspace_id: workspaceId, today: todayISO() };

  if (query.customer_id) {
    clauses.push('i.customer_id = @customer_id');
    params.customer_id = Number(query.customer_id);
  }
  if (query.from) {
    clauses.push('i.invoice_date >= @from');
    params.from = query.from;
  }
  if (query.to) {
    clauses.push('i.invoice_date <= @to');
    params.to = query.to;
  }
  const search = (query.search || '').toString().trim();
  if (search) {
    clauses.push(`(i.invoice_number LIKE @search OR c.name LIKE @search OR IFNULL(i.notes,'') LIKE @search)`);
    params.search = `%${search.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
  }

  // Status filter runs on the computed value, which is why it is a subquery.
  let outer = `SELECT * FROM (${INVOICE_SELECT} WHERE ${clauses.join(' AND ')})`;
  if (query.status && query.status !== 'all') {
    outer += ' WHERE status = @status';
    params.status = String(query.status);
  }
  outer += ' ORDER BY invoice_date DESC, id DESC LIMIT @limit OFFSET @offset';

  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);

  const rows = db.prepare(outer).all({ ...params, limit, offset });

  // Totals for the currently filtered set (drives the summary strip).
  const allFiltered = db.prepare(`${INVOICE_SELECT} WHERE ${clauses.join(' AND ')}`).all(params);
  const summary = allFiltered.reduce(
    (acc, row) => {
      acc.count += 1;
      acc.total_minor += row.total_minor;
      acc.paid_minor += row.paid_minor;
      acc.balance_minor += row.balance_minor;
      if (row.status === 'overdue') { acc.overdue_count += 1; acc.overdue_minor += row.balance_minor; }
      return acc;
    },
    { count: 0, total_minor: 0, paid_minor: 0, balance_minor: 0, overdue_count: 0, overdue_minor: 0 }
  );

  return {
    rows: rows.map(decorate),
    summary: {
      count: summary.count,
      total: toRupees(summary.total_minor),
      paid: toRupees(summary.paid_minor),
      outstanding: toRupees(summary.balance_minor),
      overdueCount: summary.overdue_count,
      overdueAmount: toRupees(summary.overdue_minor),
    },
    limit,
    offset,
  };
}

function getInvoice(id, workspaceId) {
  const row = db
    .prepare(`${INVOICE_SELECT} WHERE i.id = @id AND i.workspace_id = @workspace_id`)
    .get({ id, workspace_id: workspaceId, today: todayISO() });
  if (!row) throw notFound('Invoice not found.');

  const items = db
    .prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position, id')
    .all(id)
    .map((item) => ({
      ...item,
      unit_price: toRupees(item.unit_price_minor),
      line_total: toRupees(item.line_total_minor),
    }));

  const payments = db
    .prepare('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_on DESC, id DESC')
    .all(id)
    .map((p) => ({ ...p, amount: toRupees(p.amount_minor) }));

  return { ...decorate(row), items, payments };
}

/** Next suggested invoice number, e.g. INV-0007. Only a suggestion. */
function suggestNumber(workspaceId) {
  const rows = db
    .prepare(`SELECT invoice_number FROM invoices WHERE workspace_id = ?`)
    .all(workspaceId);
  let max = 0;
  for (const row of rows) {
    const match = /(\d+)\s*$/.exec(row.invoice_number || '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  const year = new Date().getFullYear();
  return `INV-${year}-${String(max + 1).padStart(4, '0')}`;
}

function assertCustomer(customerId, workspaceId) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND workspace_id = ?').get(customerId, workspaceId);
  if (!customer) throw badRequest('Unknown customer.', { customer_id: 'Choose a customer from this workspace.' });
  if (customer.is_archived) {
    throw badRequest('That customer is archived.', { customer_id: 'Choose an active customer.' });
  }
  return customer;
}

function assertNumberFree(invoiceNumber, workspaceId, exceptId = null) {
  const clash = db
    .prepare('SELECT id FROM invoices WHERE workspace_id = ? AND lower(trim(invoice_number)) = lower(trim(?)) AND id <> ?')
    .get(workspaceId, invoiceNumber, exceptId ?? -1);
  if (clash) {
    throw conflict(`Invoice number "${invoiceNumber}" is already used in this workspace.`, {
      invoice_number: 'Invoice numbers must be unique. Try the next number.',
    });
  }
}

/** Writes the line items for an invoice (caller supplies the transaction). */
const insertItemStmt = db.prepare(`
  INSERT INTO invoice_items
    (invoice_id, description, quantity, unit_price_minor, tax_rate, line_total_minor, position)
  VALUES (@invoice_id, @description, @quantity, @unit_price_minor, @tax_rate, @line_total_minor, @position)
`);

function createInvoice(data, workspaceId) {
  assertCustomer(data.customer_id, workspaceId);
  assertNumberFree(data.invoice_number, workspaceId);

  // Totals come from the items, never from the request body.
  const totals = computeDocumentTotals(data.items);
  if (totals.totalMinor <= 0) {
    throw badRequest('Invoice total must be greater than 0. Add a price to at least one line item.', {
      items: 'Every invoice needs a line item with a price above ₹0.',
    });
  }

  const insertInvoice = db.prepare(`
    INSERT INTO invoices
      (workspace_id, invoice_number, customer_id, invoice_date, due_date,
       is_draft, notes, subtotal_minor, tax_minor, total_minor)
    VALUES
      (@workspace_id, @invoice_number, @customer_id, @invoice_date, @due_date,
       @is_draft, @notes, @subtotal_minor, @tax_minor, @total_minor)
  `);

  const run = db.transaction(() => {
    const info = insertInvoice.run({
      workspace_id: workspaceId,
      invoice_number: data.invoice_number,
      customer_id: data.customer_id,
      invoice_date: data.invoice_date,
      due_date: data.due_date,
      is_draft: data.is_draft ?? 0,
      notes: data.notes ?? null,
      subtotal_minor: totals.subtotalMinor,
      tax_minor: totals.taxMinor,
      total_minor: totals.totalMinor,
    });
    const invoiceId = info.lastInsertRowid;
    for (const line of totals.lines) {
      insertItemStmt.run({ invoice_id: invoiceId, ...line });
    }
    return invoiceId;
  });

  return getInvoice(run(), workspaceId);
}

function updateInvoice(id, data, workspaceId) {
  const existing = getInvoice(id, workspaceId);
  if (existing.is_cancelled) throw conflict('A cancelled invoice cannot be edited.');

  assertCustomer(data.customer_id, workspaceId);
  assertNumberFree(data.invoice_number, workspaceId, id);

  // Recalculate from items (ignore anything the client says about totals).
  const items = data.items || existing.items.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unit_price_minor: item.unit_price_minor,
    tax_rate: item.tax_rate,
  }));
  const totals = computeDocumentTotals(items);
  if (totals.totalMinor <= 0) {
    throw badRequest('Invoice total must be greater than 0.', {
      items: 'Every invoice needs a line item with a price above ₹0.',
    });
  }

  // Guard: you cannot shrink an invoice below what has already been paid.
  if (totals.totalMinor < existing.paid_minor) {
    throw conflict(
      `This invoice already has ${toRupees(existing.paid_minor)} recorded as paid, ` +
        `so its total cannot be reduced below that amount.`,
      { items: 'Remove or refund a payment first.' }
    );
  }

  const updateStmt = db.prepare(`
    UPDATE invoices
       SET invoice_number = @invoice_number, customer_id = @customer_id,
           invoice_date = @invoice_date, due_date = @due_date,
           is_draft = @is_draft, notes = @notes,
           subtotal_minor = @subtotal_minor, tax_minor = @tax_minor,
           total_minor = @total_minor, updated_at = datetime('now')
     WHERE id = @id AND workspace_id = @workspace_id
  `);

  const run = db.transaction(() => {
    updateStmt.run({
      id,
      workspace_id: workspaceId,
      invoice_number: data.invoice_number,
      customer_id: data.customer_id,
      invoice_date: data.invoice_date,
      due_date: data.due_date,
      is_draft: data.is_draft !== undefined ? data.is_draft : (existing.is_draft ? 1 : 0),
      notes: data.notes ?? null,
      subtotal_minor: totals.subtotalMinor,
      tax_minor: totals.taxMinor,
      total_minor: totals.totalMinor,
    });

    if (data.items) {
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
      for (const line of totals.lines) insertItemStmt.run({ invoice_id: id, ...line });
    }
  });
  run();

  return getInvoice(id, workspaceId);
}

function deleteInvoice(id, workspaceId) {
  const invoice = getInvoice(id, workspaceId);
  if (invoice.payments.length > 0) {
    throw conflict(
      'This invoice has payments recorded against it, so deleting it would remove financial history. ' +
        'Cancel the invoice instead.',
      { payments: invoice.payments.length },
    );
  }
  // Items and payments cascade via ON DELETE CASCADE.
  db.prepare('DELETE FROM invoices WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  return invoice;
}

function setCancelled(id, workspaceId, cancelled) {
  const invoice = getInvoice(id, workspaceId);
  if (cancelled && invoice.payments.length > 0) {
    throw conflict('An invoice with recorded payments cannot be cancelled. Remove the payments first.');
  }
  db.prepare(`UPDATE invoices SET is_cancelled = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
    .run(cancelled ? 1 : 0, id, workspaceId);
  return getInvoice(id, workspaceId);
}

function setDraft(id, workspaceId, isDraft) {
  getInvoice(id, workspaceId);
  db.prepare(`UPDATE invoices SET is_draft = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
    .run(isDraft ? 1 : 0, id, workspaceId);
  return getInvoice(id, workspaceId);
}

// ===========================================================================
// Payments
// ===========================================================================

/**
 * Records a payment against an invoice.
 * Rules (all enforced here on the server):
 *   - the invoice must exist in this workspace, not be a draft and not be cancelled
 *   - amount must be > 0
 *   - amount must not exceed the outstanding balance (no credit workflow)
 *   - an identical payment (same date, amount, reference) is rejected as a duplicate
 */
function addPayment(invoiceId, data, workspaceId) {
  const invoice = getInvoice(invoiceId, workspaceId);

  if (invoice.is_cancelled) throw conflict('This invoice is cancelled. No payments can be recorded.');
  if (invoice.is_draft) throw conflict('This invoice is still a draft. Publish it before recording a payment or income.');

  // Only published invoices can receive money: this avoids meaningless payments on drafts.
  if (invoice.balance_minor <= 0) {
    throw conflict('This invoice is already fully paid.', { amount: 'Nothing is outstanding on this invoice.' });
  }
  if (data.amount_minor > invoice.balance_minor) {
    throw badRequest(
      `Payment is larger than the outstanding balance of ${toRupees(invoice.balance_minor)}.`,
      { amount: `Enter ${toRupees(invoice.balance_minor)} or less.` },
    );
  }

  const duplicate = db
    .prepare(
      `SELECT id FROM invoice_payments
        WHERE invoice_id = ? AND paid_on = ? AND amount_minor = ? AND reference = ?`
    )
    .get(invoiceId, data.paid_on, data.amount_minor, data.reference ?? '');
  if (duplicate) {
    throw conflict(
      'An identical payment (same date, amount and reference) is already recorded on this invoice.',
      { amount: 'If this is a second real payment, change the reference or the date slightly.' },
    );
  }

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO invoice_payments (invoice_id, amount_minor, paid_on, method, reference, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        invoiceId,
        data.amount_minor,
        data.paid_on,
        data.method || 'cash',
        data.reference ?? '',
        data.notes ?? null
      );
    db.prepare(`UPDATE invoices SET updated_at = datetime('now') WHERE id = ?`).run(invoiceId);
    return info.lastInsertRowid;
  });

  const paymentId = run();
  return { payment: db.prepare('SELECT * FROM invoice_payments WHERE id = ?').get(paymentId), invoice: getInvoice(invoiceId, workspaceId) };
}

function deletePayment(invoiceId, paymentId, workspaceId) {
  getInvoice(invoiceId, workspaceId); // 404s if the invoice is not in this workspace
  const payment = db
    .prepare('SELECT * FROM invoice_payments WHERE id = ? AND invoice_id = ?')
    .get(paymentId, invoiceId);
  if (!payment) throw notFound('Payment not found.');

  db.prepare('DELETE FROM invoice_payments WHERE id = ? AND invoice_id = ?').run(paymentId, invoiceId);
  return { deleted: true, invoice: getInvoice(invoiceId, workspaceId) };
}

function listPayments(invoiceId, workspaceId) {
  getInvoice(invoiceId, workspaceId);
  return db
    .prepare('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_on DESC, id DESC')
    .all(invoiceId)
    .map((p) => ({ ...p, amount: toRupees(p.amount_minor) }));
}

/** Rows for the CSV export. */
function allForExport(workspaceId, query = {}) {
  const clauses = ['i.workspace_id = @workspace_id'];
  const params = { workspace_id: workspaceId, today: todayISO() };
  if (query.from) { clauses.push('i.invoice_date >= @from'); params.from = query.from; }
  if (query.to) { clauses.push('i.invoice_date <= @to'); params.to = query.to; }
  return db
    .prepare(`${INVOICE_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY invoice_date ASC, id ASC LIMIT 10000`)
    .all(params)
    .map(decorate);
}

module.exports = {
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  setCancelled,
  setDraft,
  addPayment,
  deletePayment,
  listPayments,
  suggestNumber,
  allForExport,
};
