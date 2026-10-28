/**
 * src/repositories/vendorBills.js
 * ---------------------------------------------------------------------------
 * Bills we RECEIVE from vendors ("payables"), plus payments we make against them.
 *
 * Mirrors the invoice module:
 *   - status is derived from payments + due date (never stored)
 *   - a payment can never exceed the outstanding balance
 *   - duplicate payments are rejected
 *   - an unpaid bill is NOT counted as cash paid anywhere in the reports
 * ---------------------------------------------------------------------------
 */

const { db } = require('../../database');
const { notFound, conflict, badRequest, todayISO } = require('../validation');
const { toRupees } = require('../money');

const BILL_SELECT = `
  SELECT b.*,
         v.name  AS vendor_name,
         v.email AS vendor_email,
         v.phone AS vendor_phone,
         IFNULL(p.paid_minor, 0) AS paid_minor,
         (b.amount_minor + b.tax_minor - IFNULL(p.paid_minor, 0)) AS balance_minor,
         CASE
           WHEN b.is_cancelled = 1 THEN 'cancelled'
           WHEN IFNULL(p.paid_minor, 0) >= (b.amount_minor + b.tax_minor) THEN 'paid'
           WHEN b.due_date < @today THEN 'overdue'
           WHEN IFNULL(p.paid_minor, 0) > 0 THEN 'partially_paid'
           ELSE 'unpaid'
         END AS status
    FROM vendor_bills b
    JOIN vendors v ON v.id = b.vendor_id
    LEFT JOIN (
         SELECT vendor_bill_id, SUM(amount_minor) AS paid_minor
           FROM vendor_bill_payments GROUP BY vendor_bill_id
    ) p ON p.vendor_bill_id = b.id
`;

function decorate(row) {
  if (!row) return row;
  return {
    ...row,
    is_cancelled: Boolean(row.is_cancelled),
    total_minor: row.amount_minor + row.tax_minor,
    amount: toRupees(row.amount_minor),
    tax: toRupees(row.tax_minor),
    total: toRupees(row.amount_minor + row.tax_minor),
    paid: toRupees(row.paid_minor),
    balance: toRupees(row.balance_minor),
    isPaid: row.status === 'paid',
    isOverdue: row.status === 'overdue',
  };
}

function listBills(workspaceId, query = {}) {
  const clauses = ['b.workspace_id = @workspace_id'];
  const params = { workspace_id: workspaceId, today: todayISO() };

  if (query.vendor_id) { clauses.push('b.vendor_id = @vendor_id'); params.vendor_id = Number(query.vendor_id); }
  if (query.from) { clauses.push('b.bill_date >= @from'); params.from = query.from; }
  if (query.to) { clauses.push('b.bill_date <= @to'); params.to = query.to; }

  const search = (query.search || '').toString().trim();
  if (search) {
    clauses.push(`(b.bill_number LIKE @search OR v.name LIKE @search OR IFNULL(b.description,'') LIKE @search)`);
    params.search = `%${search.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
  }

  let outer = `SELECT * FROM (${BILL_SELECT} WHERE ${clauses.join(' AND ')})`;
  if (query.status && query.status !== 'all') {
    outer += ' WHERE status = @status';
    params.status = String(query.status);
  }
  outer += ' ORDER BY bill_date DESC, id DESC LIMIT @limit OFFSET @offset';

  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const rows = db.prepare(outer).all({ ...params, limit, offset });

  const allFiltered = db.prepare(`${BILL_SELECT} WHERE ${clauses.join(' AND ')}`).all(params);
  const summary = allFiltered.reduce(
    (acc, row) => {
      if (row.is_cancelled) return acc;
      acc.count += 1;
      acc.total_minor += row.amount_minor + row.tax_minor;
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

function getBill(id, workspaceId) {
  const row = db
    .prepare(`${BILL_SELECT} WHERE b.id = @id AND b.workspace_id = @workspace_id`)
    .get({ id, workspace_id: workspaceId, today: todayISO() });
  if (!row) throw notFound('Vendor bill not found.');

  const payments = db
    .prepare('SELECT * FROM vendor_bill_payments WHERE vendor_bill_id = ? ORDER BY paid_on DESC, id DESC')
    .all(id)
    .map((p) => ({ ...p, amount: toRupees(p.amount_minor) }));

  return { ...decorate(row), payments };
}

function createBill(data, workspaceId) {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ? AND workspace_id = ?').get(data.vendor_id, workspaceId);
  if (!vendor) throw badRequest('Unknown vendor.', { vendor_id: 'Choose a vendor from this workspace.' });

  const duplicate = db
    .prepare('SELECT id FROM vendor_bills WHERE workspace_id = ? AND vendor_id = ? AND lower(trim(bill_number)) = lower(trim(?))')
    .get(workspaceId, data.vendor_id, data.bill_number);
  if (duplicate) {
    throw conflict(`Bill number "${data.bill_number}" already exists for this vendor.`, {
      bill_number: 'Use a different bill number.',
    });
  }

  const taxRate = data.tax_rate ?? 0;
  const taxMinor = Math.round((data.amount_minor * taxRate) / 100);

  const info = db
    .prepare(
      `INSERT INTO vendor_bills
         (workspace_id, vendor_id, bill_number, bill_date, due_date, description, amount_minor, tax_rate, tax_minor, notes)
       VALUES (@workspace_id, @vendor_id, @bill_number, @bill_date, @due_date, @description, @amount_minor, @tax_rate, @tax_minor, @notes)`
    )
    .run({
      workspace_id: workspaceId,
      vendor_id: data.vendor_id,
      bill_number: data.bill_number,
      bill_date: data.bill_date,
      due_date: data.due_date,
      description: data.description ?? null,
      amount_minor: data.amount_minor,
      tax_rate: taxRate,
      tax_minor: taxMinor,
      notes: data.notes ?? null,
    });

  return getBill(info.lastInsertRowid, workspaceId);
}

function updateBill(id, data, workspaceId) {
  const existing = getBill(id, workspaceId);
  if (existing.is_cancelled) throw conflict('A cancelled bill cannot be edited.');

  const taxRate = data.tax_rate ?? 0;
  const taxMinor = Math.round((data.amount_minor * taxRate) / 100);
  const newTotal = data.amount_minor + taxMinor;

  if (newTotal < existing.paid_minor) {
    throw conflict(
      `This bill already has ${toRupees(existing.paid_minor)} paid against it, so its total cannot be reduced below that amount.`,
    );
  }

  db.prepare(
    `UPDATE vendor_bills
        SET vendor_id = @vendor_id, bill_number = @bill_number, bill_date = @bill_date,
            due_date = @due_date, description = @description, amount_minor = @amount_minor,
            tax_rate = @tax_rate, tax_minor = @tax_minor, notes = @notes,
            updated_at = datetime('now')
      WHERE id = @id AND workspace_id = @workspace_id`
  ).run({
    id,
    workspace_id: workspaceId,
    vendor_id: data.vendor_id,
    bill_number: data.bill_number,
    bill_date: data.bill_date,
    due_date: data.due_date,
    description: data.description ?? null,
    amount_minor: data.amount_minor,
    tax_rate: taxRate,
    tax_minor: taxMinor,
    notes: data.notes ?? null,
  });

  return getBill(id, workspaceId);
}

function deleteBill(id, workspaceId) {
  const bill = getBill(id, workspaceId);
  if (bill.payments.length > 0) {
    throw conflict('This bill has payments recorded against it. Cancel it instead of deleting.');
  }
  db.prepare('DELETE FROM vendor_bills WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  return bill;
}

function setCancelled(id, workspaceId, cancelled) {
  const bill = getBill(id, workspaceId);
  if (cancelled && bill.payments.length > 0) {
    throw conflict('A bill with recorded payments cannot be cancelled.');
  }
  db.prepare(`UPDATE vendor_bills SET is_cancelled = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
    .run(cancelled ? 1 : 0, id, workspaceId);
  return getBill(id, workspaceId);
}

function addPayment(billId, data, workspaceId) {
  const bill = getBill(billId, workspaceId);
  if (bill.is_cancelled) throw conflict('This bill is cancelled. No payments can be recorded.');
  if (bill.balance_minor <= 0) throw conflict('This bill is already fully paid.', { amount: 'Nothing is outstanding.' });
  if (data.amount_minor > bill.balance_minor) {
    throw badRequest(
      `Payment is larger than the outstanding balance of ${toRupees(bill.balance_minor)}.`,
      { amount: `Enter ${toRupees(bill.balance_minor)} or less.` },
    );
  }

  const duplicate = db
    .prepare('SELECT id FROM vendor_bill_payments WHERE vendor_bill_id = ? AND paid_on = ? AND amount_minor = ? AND reference = ?')
    .get(billId, data.paid_on, data.amount_minor, data.reference ?? '');
  if (duplicate) {
    throw conflict('An identical payment is already recorded on this bill.', {
      amount: 'Change the reference or the date if this is a genuinely separate payment.',
    });
  }

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO vendor_bill_payments (vendor_bill_id, amount_minor, paid_on, method, reference, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(billId, data.amount_minor, data.paid_on, data.method || 'cash', data.reference ?? '', data.notes ?? null);
    db.prepare(`UPDATE vendor_bills SET updated_at = datetime('now') WHERE id = ?`).run(billId);
    return info.lastInsertRowid;
  });

  const paymentId = run();
  return {
    payment: db.prepare('SELECT * FROM vendor_bill_payments WHERE id = ?').get(paymentId),
    bill: getBill(billId, workspaceId),
  };
}

function deletePayment(billId, paymentId, workspaceId) {
  getBill(billId, workspaceId);
  const payment = db
    .prepare('SELECT * FROM vendor_bill_payments WHERE id = ? AND vendor_bill_id = ?')
    .get(paymentId, billId);
  if (!payment) throw notFound('Payment not found.');
  db.prepare('DELETE FROM vendor_bill_payments WHERE id = ? AND vendor_bill_id = ?').run(paymentId, billId);
  return { deleted: true, bill: getBill(billId, workspaceId) };
}

function allForExport(workspaceId, query = {}) {
  const clauses = ['b.workspace_id = @workspace_id'];
  const params = { workspace_id: workspaceId, today: todayISO() };
  if (query.from) { clauses.push('b.bill_date >= @from'); params.from = query.from; }
  if (query.to) { clauses.push('b.bill_date <= @to'); params.to = query.to; }
  return db
    .prepare(`${BILL_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY bill_date ASC, id ASC LIMIT 10000`)
    .all(params)
    .map(decorate);
}

module.exports = {
  listBills,
  getBill,
  createBill,
  updateBill,
  deleteBill,
  setCancelled,
  addPayment,
  deletePayment,
  allForExport,
};
