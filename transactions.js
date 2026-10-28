/**
 * src/repositories/transactions.js
 * ---------------------------------------------------------------------------
 * All SQL for the `transactions` table. Every query is scoped to a workspace,
 * so a Personal report can never include a Business row.
 *
 * Money: stored as `amount_minor` (integer paise). `amount` is a generated
 * column (amount_minor / 100) so responses still carry a rupee value for the
 * existing frontend and for readability.
 *
 * SECURITY: every user value is bound as a parameter (`?` / `@name`), never
 * concatenated into the SQL string.
 * ---------------------------------------------------------------------------
 */

const { db } = require('../../database');
const { ApiError, notFound, isValidMonthString, isValidDateString } = require('../validation');
const { toRupees } = require('../money');

const byIdStmt = db.prepare('SELECT * FROM transactions WHERE id = ? AND workspace_id = ?');

const insertStmt = db.prepare(`
  INSERT INTO transactions
    (workspace_id, type, title, category, amount_minor, transaction_date, notes,
     payment_method, customer_id, vendor_id, invoice_id, tax_rate, tax_minor, recurring_rule_id)
  VALUES
    (@workspace_id, @type, @title, @category, @amount_minor, @transaction_date, @notes,
     @payment_method, @customer_id, @vendor_id, @invoice_id, @tax_rate, @tax_minor, @recurring_rule_id)
`);

const updateStmt = db.prepare(`
  UPDATE transactions
     SET type = @type,
         title = @title,
         category = @category,
         amount_minor = @amount_minor,
         transaction_date = @transaction_date,
         notes = @notes,
         payment_method = @payment_method,
         customer_id = @customer_id,
         vendor_id = @vendor_id,
         tax_rate = @tax_rate,
         tax_minor = @tax_minor
   WHERE id = @id AND workspace_id = @workspace_id
`);

/**
 * Builds the WHERE clause for the filters. Only *placeholders* go into the SQL
 * string; the values always travel in the params object.
 *
 * `prefix` lets the same clause work for a plain query ("") and for a JOIN
 * where every column needs its table alias ("t."). No string replace hacks.
 */
function buildFilters(query, workspaceId, prefix = '') {
  const col = (name) => `${prefix}${name}`;
  const clauses = [`${col('workspace_id')} = @workspace_id`];
  const params = { workspace_id: workspaceId };

  const search = (query.search || '').toString().trim();
  if (search) {
    clauses.push(
      `(${col('title')} LIKE @search OR ${col('category')} LIKE @search OR IFNULL(${col('notes')}, '') LIKE @search)`
    );
    // escape LIKE wildcards so a user typing "100%" searches literally
    params.search = `%${search.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
  }

  if (query.category) {
    clauses.push(`${col('category')} = @category`);
    params.category = String(query.category);
  }

  if (query.type) {
    if (!['income', 'expense'].includes(query.type)) throw new ApiError(400, 'Invalid type filter.');
    clauses.push(`${col('type')} = @type`);
    params.type = String(query.type);
  }

  if (query.month) {
    if (!isValidMonthString(query.month)) throw new ApiError(400, 'Invalid month filter. Use YYYY-MM.');
    clauses.push(`substr(${col('transaction_date')}, 1, 7) = @month`);
    params.month = query.month;
  }

  if (query.from) {
    if (!isValidDateString(query.from)) throw new ApiError(400, 'Invalid "from" date. Use YYYY-MM-DD.');
    clauses.push(`${col('transaction_date')} >= @from`);
    params.from = query.from;
  }
  if (query.to) {
    if (!isValidDateString(query.to)) throw new ApiError(400, 'Invalid "to" date. Use YYYY-MM-DD.');
    clauses.push(`${col('transaction_date')} <= @to`);
    params.to = query.to;
  }

  if (query.payment_method) {
    clauses.push(`${col('payment_method')} = @payment_method`);
    params.payment_method = String(query.payment_method);
  }

  if (query.customer_id) {
    clauses.push(`${col('customer_id')} = @customer_id`);
    params.customer_id = Number(query.customer_id);
  }
  if (query.vendor_id) {
    clauses.push(`${col('vendor_id')} = @vendor_id`);
    params.vendor_id = Number(query.vendor_id);
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

/** Shared SELECT used by the list and the CSV export. */
const SELECT_JOINED = `
  SELECT t.*, c.name AS customer_name, v.name AS vendor_name
    FROM transactions t
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN vendors   v ON v.id = t.vendor_id
`;

function listTransactions(query = {}, workspaceId = 1) {
  const { where, params } = buildFilters(query, workspaceId, 't.');

  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);

  const rows = db
    .prepare(`${SELECT_JOINED} ${where} ORDER BY t.transaction_date DESC, t.id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS count,
         IFNULL(SUM(CASE WHEN type = 'income'  THEN amount_minor ELSE 0 END), 0) AS income_minor,
         IFNULL(SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS expense_minor
       FROM transactions ${buildFilters(query, workspaceId, '').where}`
    )
    .get(params);

  return {
    rows,
    total: totals.count,
    filteredIncome: toRupees(totals.income_minor),
    filteredExpense: toRupees(totals.expense_minor),
    filteredIncomeMinor: totals.income_minor,
    filteredExpenseMinor: totals.expense_minor,
    limit,
    offset,
  };
}

/** Rows for CSV export (no pagination, same filters). */
function allForExport(query = {}, workspaceId = 1) {
  const { where, params } = buildFilters(query, workspaceId, 't.');
  return db
    .prepare(`${SELECT_JOINED} ${where} ORDER BY t.transaction_date ASC, t.id ASC LIMIT 10000`)
    .all(params);
}

/** Single transaction, with the customer/vendor name joined in for display. */
function getTransactionById(id, workspaceId = 1) {
  const row = db
    .prepare(`${SELECT_JOINED} WHERE t.id = ? AND t.workspace_id = ?`)
    .get(id, workspaceId);
  if (!row) throw notFound('Transaction not found.');
  return row;
}

/** Validates that a customer/vendor reference belongs to the same workspace. */
function assertReferences(clean, workspaceId) {
  if (clean.customer_id) {
    const row = db.prepare('SELECT workspace_id FROM customers WHERE id = ?').get(clean.customer_id);
    if (!row) throw new ApiError(400, 'Unknown customer.', { customer_id: 'That customer no longer exists.' });
    if (row.workspace_id !== workspaceId) {
      throw new ApiError(400, 'That customer belongs to a different workspace.', { customer_id: 'Choose a customer from this workspace.' });
    }
  }
  if (clean.vendor_id) {
    const row = db.prepare('SELECT workspace_id FROM vendors WHERE id = ?').get(clean.vendor_id);
    if (!row) throw new ApiError(400, 'Unknown vendor.', { vendor_id: 'That vendor no longer exists.' });
    if (row.workspace_id !== workspaceId) {
      throw new ApiError(400, 'That vendor belongs to a different workspace.', { vendor_id: 'Choose a vendor from this workspace.' });
    }
  }
}

/** Calculates tax paise from the row's own tax_rate (server side, never trusted). */
function taxMinorFor(amountMinor, taxRate) {
  const rate = Number(taxRate) || 0;
  if (rate <= 0) return 0;
  return Math.round((amountMinor * rate) / 100);
}

function createTransaction(data, workspaceId = 1) {
  assertReferences(data, workspaceId);
  const amountMinor = data.amount_minor;
  const info = insertStmt.run({
    workspace_id: workspaceId,
    type: data.type,
    title: data.title,
    category: data.category,
    amount_minor: amountMinor,
    transaction_date: data.transaction_date,
    notes: data.notes ?? null,
    payment_method: data.payment_method ?? null,
    customer_id: data.customer_id ?? null,
    vendor_id: data.vendor_id ?? null,
    invoice_id: data.invoice_id ?? null,
    tax_rate: data.tax_rate ?? 0,
    tax_minor: taxMinorFor(amountMinor, data.tax_rate),
    recurring_rule_id: data.recurring_rule_id ?? null,
  });
  return getTransactionById(info.lastInsertRowid, workspaceId);
}

function updateTransaction(id, data, workspaceId = 1) {
  const existing = byIdStmt.get(id, workspaceId);
  if (!existing) throw notFound('Transaction not found.');
  assertReferences(data, workspaceId);

  updateStmt.run({
    id,
    workspace_id: workspaceId,
    type: data.type,
    title: data.title,
    category: data.category,
    amount_minor: data.amount_minor,
    transaction_date: data.transaction_date,
    notes: data.notes ?? null,
    payment_method: data.payment_method ?? null,
    customer_id: data.customer_id ?? null,
    vendor_id: data.vendor_id ?? null,
    tax_rate: data.tax_rate ?? 0,
    tax_minor: taxMinorFor(data.amount_minor, data.tax_rate),
  });
  return getTransactionById(id, workspaceId);
}

function deleteTransaction(id, workspaceId = 1) {
  const existing = getTransactionById(id, workspaceId);
  db.prepare('DELETE FROM transactions WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  return existing;
}

module.exports = {
  listTransactions,
  allForExport,
  getTransactionById,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  taxMinorFor,
};
