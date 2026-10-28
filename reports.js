/**
 * src/repositories/reports.js
 * ---------------------------------------------------------------------------
 * Date-filtered reports + the data behind the CSV exports.
 *
 * TAX REPORT DISCLAIMER (also shown in the UI):
 *   These numbers are for record-keeping only. SmartSpend does not know which
 *   of your expenses are tax deductible, and it never applies a tax rate you
 *   have not configured yourself. This is NOT tax or legal advice.
 *
 * Tax on a transaction is calculated from that row's own `tax_rate`
 * (tax_minor = round(amount_minor * rate / 100)) by the server when the row is
 * created or updated, so it can never be forged by the browser.
 * ---------------------------------------------------------------------------
 */

const { db } = require('../../database');
const { toRupees } = require('../money');

/** Expense totals by category, with any tax the user configured. */
function taxSummary(workspaceId, { from = null, to = null } = {}) {
  const rows = db
    .prepare(
      `SELECT category,
              COUNT(*)                                   AS count,
              IFNULL(SUM(amount_minor), 0)               AS net_minor,
              IFNULL(SUM(tax_minor), 0)                  AS tax_minor
         FROM transactions
        WHERE workspace_id = @workspace_id AND type = 'expense'
          AND (@from IS NULL OR transaction_date >= @from)
          AND (@to   IS NULL OR transaction_date <= @to)
        GROUP BY category
        ORDER BY net_minor DESC`
    )
    .all({ workspace_id: workspaceId, from, to });

  const totals = rows.reduce(
    (acc, row) => {
      acc.net_minor += row.net_minor;
      acc.tax_minor += row.tax_minor;
      acc.count += row.count;
      return acc;
    },
    { net_minor: 0, tax_minor: 0, count: 0 }
  );

  // Tax collected on invoices (output tax) for the same period.
  const invoiceTax = db
    .prepare(
      `SELECT IFNULL(SUM(tax_minor), 0) AS tax_minor, COUNT(*) AS count
         FROM invoices
        WHERE workspace_id = @workspace_id AND is_cancelled = 0
          AND (@from IS NULL OR invoice_date >= @from)
          AND (@to   IS NULL OR invoice_date <= @to)`
    )
    .get({ workspace_id: workspaceId, from, to });

  return {
    from,
    to,
    categories: rows.map((row) => ({
      category: row.category,
      count: row.count,
      net: toRupees(row.net_minor),
      tax: toRupees(row.tax_minor),
      total: toRupees(row.net_minor + row.tax_minor),
      netMinor: row.net_minor,
      taxMinor: row.tax_minor,
    })),
    totals: {
      count: totals.count,
      net: toRupees(totals.net_minor),
      tax: toRupees(totals.tax_minor),
      total: toRupees(totals.net_minor + totals.tax_minor),
    },
    invoiceTax: {
      collectedOnInvoices: toRupees(invoiceTax.tax_minor),
      invoiceCount: invoiceTax.count,
    },
    disclaimer:
      'Tax figures are estimates for your own records. SmartSpend does not determine which expenses are deductible and applies only the tax rates you enter. This is not tax or legal advice.',
  };
}

/** Monthly summary used by the Individual reports screen. */
function monthlySummary(workspaceId, { from = null, to = null } = {}) {
  const rows = db
    .prepare(
      `SELECT substr(transaction_date, 1, 7) AS month,
              IFNULL(SUM(CASE WHEN type = 'income'  THEN amount_minor ELSE 0 END), 0) AS income_minor,
              IFNULL(SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS expense_minor,
              SUM(CASE WHEN type = 'income'  THEN 1 ELSE 0 END) AS income_count,
              SUM(CASE WHEN type = 'expense' THEN 1 ELSE 0 END) AS expense_count
         FROM transactions
        WHERE workspace_id = @workspace_id
          AND (@from IS NULL OR transaction_date >= @from)
          AND (@to   IS NULL OR transaction_date <= @to)
        GROUP BY month
        ORDER BY month DESC`
    )
    .all({ workspace_id: workspaceId, from, to });

  return rows.map((row) => ({
    month: row.month,
    income: toRupees(row.income_minor),
    expense: toRupees(row.expense_minor),
    net: toRupees(row.income_minor - row.expense_minor),
    savingsRate:
      row.income_minor > 0 ? Math.round(((row.income_minor - row.expense_minor) / row.income_minor) * 10000) / 100 : 0,
    incomeCount: row.income_count || 0,
    expenseCount: row.expense_count || 0,
  }));
}

/** Income and expense totals by payment method (useful for a business owner). */
function paymentMethodBreakdown(workspaceId, { from = null, to = null, type = null } = {}) {
  const rows = db
    .prepare(
      `SELECT IFNULL(payment_method, 'unspecified') AS method, type,
              IFNULL(SUM(amount_minor), 0) AS total_minor, COUNT(*) AS count
         FROM transactions
        WHERE workspace_id = @workspace_id
          AND (@from IS NULL OR transaction_date >= @from)
          AND (@to   IS NULL OR transaction_date <= @to)
          AND (@type IS NULL OR type = @type)
        GROUP BY method, type
        ORDER BY total_minor DESC`
    )
    .all({ workspace_id: workspaceId, from, to, type });

  return rows.map((row) => ({
    method: row.method,
    type: row.type,
    total: toRupees(row.total_minor),
    totalMinor: row.total_minor,
    count: row.count,
  }));
}

module.exports = { taxSummary, monthlySummary, paymentMethodBreakdown };
