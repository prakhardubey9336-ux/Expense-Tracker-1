/**
 * src/repositories/analytics.js
 * ---------------------------------------------------------------------------
 * Read-only calculations for BOTH modes.
 *
 * Every number comes from SQLite with SUM()/GROUP BY inside a workspace filter -
 * nothing is hardcoded, and personal rows can never leak into a business
 * report because every query starts from `workspace_id = @workspace_id`.
 *
 * Two families of functions:
 *   getSummary / getMonthlyTotals / getCategoryTotals / getInsights   (individual)
 *   getBusinessDashboard / getMonthlyProfitTrend / getCashFlow        (business)
 * ---------------------------------------------------------------------------
 */

const { db } = require('../../database');
const { toRupees } = require('../money');

// ===========================================================================
// Shared helpers
// ===========================================================================

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

/** ["2026-05", ... "2026-10"] — the last `count` months, oldest first. */
function lastMonths(count, endMonth = currentMonth()) {
  const months = [];
  for (let i = count - 1; i >= 0; i -= 1) months.push(shiftMonth(endMonth, -i));
  return months;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

const formatINR = (rupees) => `₹${Number(rupees).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// ===========================================================================
// INDIVIDUAL MODE
// ===========================================================================

const summaryStmt = db.prepare(`
  SELECT
    IFNULL(SUM(CASE WHEN type = 'income'  THEN amount_minor ELSE 0 END), 0) AS income_minor,
    IFNULL(SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS expense_minor,
    SUM(CASE WHEN type = 'income'  THEN 1 ELSE 0 END)                       AS income_count,
    SUM(CASE WHEN type = 'expense' THEN 1 ELSE 0 END)                       AS expense_count,
    COUNT(*)                                                                AS transaction_count
  FROM transactions
  WHERE workspace_id = @workspace_id
    AND (@from IS NULL OR transaction_date >= @from)
    AND (@to   IS NULL OR transaction_date <= @to)
`);

const topCategoryStmt = db.prepare(`
  SELECT category, SUM(amount_minor) AS total_minor, COUNT(*) AS count
    FROM transactions
   WHERE workspace_id = @workspace_id AND type = 'expense'
     AND (@month IS NULL OR substr(transaction_date, 1, 7) = @month)
   GROUP BY category
   ORDER BY total_minor DESC
   LIMIT 1
`);

/**
 * Totals for a workspace.
 * @param {object} opts { month } or { from, to } — both optional (all time).
 */
function getSummary(workspaceId = 1, { month = null, from = null, to = null } = {}) {
  const rangeFrom = from || (month ? `${month}-01` : null);
  const rangeTo = to || (month ? `${month}-31` : null);

  const row = summaryStmt.get({ workspace_id: workspaceId, from: rangeFrom, to: rangeTo });

  const totalIncome = toRupees(row.income_minor);
  const totalExpenses = toRupees(row.expense_minor);
  const balance = toRupees(row.income_minor - row.expense_minor);

  // Savings rate guard: never divide by zero.
  const savingsRate = row.income_minor > 0
    ? Math.round(((row.income_minor - row.expense_minor) / row.income_minor) * 10000) / 100
    : 0;

  const top = topCategoryStmt.get({ workspace_id: workspaceId, month });

  // Month-over-month comparison. Only meaningful when a single month is
  // selected, so it is omitted for range and all-time summaries.
  const comparison = month ? buildComparison(workspaceId, month, row) : null;

  return {
    totalIncome,
    totalExpenses,
    balance,
    savingsAmount: balance, // what is left after expenses
    savingsRate,
    totalIncomeMinor: row.income_minor,
    totalExpensesMinor: row.expense_minor,
    balanceMinor: row.income_minor - row.expense_minor,
    incomeCount: row.income_count || 0,
    expenseCount: row.expense_count || 0,
    transactionCount: row.transaction_count || 0,
    highestCategory: top
      ? { category: top.category, total: toRupees(top.total_minor), totalMinor: top.total_minor, count: top.count }
      : null,
    ...(comparison ? { previous: comparison.previous, change: comparison.change } : {}),
  };
}

/** '2026-01' -> '2025-12'. Plain string maths, no timezone involved. */
function previousMonthKey(month) {
  const [year, monthNo] = month.split('-').map(Number);
  const y = monthNo === 1 ? year - 1 : year;
  const m = monthNo === 1 ? 12 : monthNo - 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Percent change, or null when there is no sensible baseline. */
function percentChange(currentMinor, previousMinor) {
  if (!previousMinor) return null;
  return Math.round(((currentMinor - previousMinor) / Math.abs(previousMinor)) * 1000) / 10;
}

/**
 * Builds the { previous, change } block used by the "vs last month" chips on
 * the dashboard. A month with no records at all returns no comparison rather
 * than a misleading 100% jump.
 */
function buildComparison(workspaceId, month, currentRow) {
  const previousMonth = previousMonthKey(month);
  const prev = summaryStmt.get({
    workspace_id: workspaceId,
    from: `${previousMonth}-01`,
    to: `${previousMonth}-31`,
  });

  if (!prev.transaction_count) return null;

  const prevRate = prev.income_minor > 0
    ? Math.round(((prev.income_minor - prev.expense_minor) / prev.income_minor) * 10000) / 100
    : 0;
  const curRate = currentRow.income_minor > 0
    ? Math.round(((currentRow.income_minor - currentRow.expense_minor) / currentRow.income_minor) * 10000) / 100
    : 0;

  return {
    previous: {
      month: previousMonth,
      totalIncome: toRupees(prev.income_minor),
      totalExpenses: toRupees(prev.expense_minor),
      balance: toRupees(prev.income_minor - prev.expense_minor),
      savingsRate: prevRate,
      transactionCount: prev.transaction_count,
    },
    change: {
      income: percentChange(currentRow.income_minor, prev.income_minor),
      expenses: percentChange(currentRow.expense_minor, prev.expense_minor),
      balance: percentChange(currentRow.income_minor - currentRow.expense_minor, prev.income_minor - prev.expense_minor),
      savingsRate: Math.round((curRate - prevRate) * 10) / 10,
    },
  };
}

const monthlyStmt = db.prepare(`
  SELECT substr(transaction_date, 1, 7) AS month,
         IFNULL(SUM(CASE WHEN type = 'income'  THEN amount_minor ELSE 0 END), 0) AS income_minor,
         IFNULL(SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS expense_minor
    FROM transactions
   WHERE workspace_id = ?
   GROUP BY month
   ORDER BY month DESC
   LIMIT ?
`);

/** Income vs expense per month (months with no data are filled with zeros). */
function getMonthlyTotals(workspaceId = 1, months = 6) {
  const count = Math.min(Math.max(Number(months) || 6, 1), 24);
  const rows = monthlyStmt.all(workspaceId, count);
  const map = new Map(rows.map((r) => [r.month, r]));

  const endMonth = rows.length > 0 ? rows[0].month : currentMonth();
  const window = lastMonths(count, endMonth);

  return window.map((month) => {
    const row = map.get(month);
    const incomeMinor = row ? row.income_minor : 0;
    const expenseMinor = row ? row.expense_minor : 0;
    return {
      month,
      income: toRupees(incomeMinor),
      expense: toRupees(expenseMinor),
      balance: toRupees(incomeMinor - expenseMinor),
      income_minor: incomeMinor,
      expense_minor: expenseMinor,
    };
  });
}

const categoriesStmt = db.prepare(`
  SELECT category, SUM(amount_minor) AS total_minor, COUNT(*) AS count
    FROM transactions
   WHERE workspace_id = ? AND type = 'expense'
     AND substr(transaction_date, 1, 7) = ?
   GROUP BY category
   ORDER BY total_minor DESC
`);

function getCategoryTotals(workspaceId = 1, month = currentMonth()) {
  const rows = categoriesStmt.all(workspaceId, month);
  const totalMinor = rows.reduce((sum, r) => sum + r.total_minor, 0);

  return {
    month,
    total: toRupees(totalMinor),
    totalMinor,
    categories: rows.map((r) => ({
      category: r.category,
      total: toRupees(r.total_minor),
      totalMinor: r.total_minor,
      count: r.count,
      percent: totalMinor > 0 ? Math.round((r.total_minor / totalMinor) * 1000) / 10 : 0,
    })),
  };
}

/**
 * Rule-based insights for Individual mode.
 * Each rule only fires when the database actually supports the statement.
 */
function getInsights(workspaceId = 1, month = currentMonth()) {
  const monthStats = getSummary(workspaceId, { month });
  const allStats = getSummary(workspaceId);
  const budget = db
    .prepare('SELECT * FROM budgets WHERE workspace_id = ? AND month = ?')
    .get(workspaceId, month);
  const insights = [];
  const label = monthLabel(month);

  if (monthStats.transactionCount === 0) {
    insights.push({
      id: 'no-transactions',
      tone: 'info',
      title: `No entries for ${label} yet`,
      text: 'Add an income or expense transaction to see your insights for this month.',
    });
  } else {
    if (monthStats.highestCategory) {
      const top = monthStats.highestCategory;
      const share = monthStats.totalExpenses > 0
        ? Math.round((top.total / monthStats.totalExpenses) * 1000) / 10
        : 0;
      insights.push({
        id: 'top-category',
        tone: 'info',
        title: `${top.category} is your highest spending category`,
        text: `You spent ${formatINR(top.total)} on ${top.category} in ${label} — that is ${share}% of this month's expenses across ${top.count} transaction${top.count === 1 ? '' : 's'}.`,
      });
    }

    if (monthStats.expenseCount === 0) {
      insights.push({
        id: 'no-expenses',
        tone: 'success',
        title: `No expenses recorded in ${label}`,
        text: `You have recorded ${formatINR(monthStats.totalIncome)} of income and no expenses this month.`,
      });
    }

    if (budget && budget.amount_minor > 0) {
      const spent = monthStats.totalExpenses;
      const percentUsed = Math.round((spent / (budget.amount_minor / 100)) * 1000) / 10;
      if (spent > budget.amount_minor / 100) {
        insights.push({
          id: 'budget-exceeded',
          tone: 'danger',
          title: `You have exceeded your ${label} budget`,
          text: `You spent ${formatINR(spent)} against a budget of ${formatINR(budget.amount_minor / 100)} — over by ${formatINR(spent - budget.amount_minor / 100)} (${percentUsed}% used).`,
        });
      } else {
        insights.push({
          id: 'budget-usage',
          tone: percentUsed >= 80 ? 'warning' : 'success',
          title: `You have used ${percentUsed}% of your monthly budget`,
          text: `${formatINR(spent)} spent of ${formatINR(budget.amount_minor / 100)}. You still have ${formatINR(budget.amount_minor / 100 - spent)} left for ${label}.`,
        });
      }
    } else {
      insights.push({
        id: 'no-budget',
        tone: 'warning',
        title: `No budget set for ${label}`,
        text: 'Set a monthly budget to track how much of it you have used.',
      });
    }

    if (monthStats.expenseCount > 0 && monthStats.incomeCount > 0) {
      const diff = monthStats.totalIncome - monthStats.totalExpenses;
      if (diff < 0) {
        insights.push({
          id: 'expenses-exceed-income',
          tone: 'danger',
          title: 'Your expenses exceed your income this month',
          text: `Spending is ${formatINR(Math.abs(diff))} more than income in ${label}.`,
        });
      } else {
        insights.push({
          id: 'income-exceeds-expenses',
          tone: 'success',
          title: 'Your recorded income exceeds your expenses',
          text: `You recorded ${formatINR(monthStats.totalIncome)} of income against ${formatINR(monthStats.totalExpenses)} of expenses in ${label} — a surplus of ${formatINR(diff)}.`,
        });
      }
    }
  }

  if (allStats.totalIncome > 0) {
    insights.push({
      id: 'savings-rate',
      tone: allStats.savingsRate < 0 ? 'danger' : allStats.savingsRate >= 20 ? 'success' : 'info',
      title: `Your overall savings rate is ${allStats.savingsRate}%`,
      text: `Across all recorded transactions you earned ${formatINR(allStats.totalIncome)} and spent ${formatINR(allStats.totalExpenses)}.`,
    });
  }

  return { month, monthLabel: label, insights };
}

// ===========================================================================
// BUSINESS MODE
// ===========================================================================

/** Outstanding money on invoices / bills, computed from payments. */
const outstandingStmt = db.prepare(`
  SELECT
    (SELECT IFNULL(SUM(i.total_minor - IFNULL(p.paid, 0)), 0)
       FROM invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount_minor) AS paid FROM invoice_payments GROUP BY invoice_id) p
              ON p.invoice_id = i.id
      WHERE i.workspace_id = @workspace_id AND i.is_draft = 0 AND i.is_cancelled = 0
        AND (i.total_minor - IFNULL(p.paid, 0)) > 0)                          AS receivable_minor,
    (SELECT COUNT(*)
       FROM invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount_minor) AS paid FROM invoice_payments GROUP BY invoice_id) p
              ON p.invoice_id = i.id
      WHERE i.workspace_id = @workspace_id AND i.is_draft = 0 AND i.is_cancelled = 0
        AND (i.total_minor - IFNULL(p.paid, 0)) > 0)                          AS receivable_count,
    (SELECT IFNULL(SUM((i.amount_minor + i.tax_minor) - IFNULL(p.paid, 0)), 0)
       FROM vendor_bills i
       LEFT JOIN (SELECT vendor_bill_id, SUM(amount_minor) AS paid FROM vendor_bill_payments GROUP BY vendor_bill_id) p
              ON p.vendor_bill_id = i.id
      WHERE i.workspace_id = @workspace_id AND i.is_cancelled = 0
        AND ((i.amount_minor + i.tax_minor) - IFNULL(p.paid, 0)) > 0)         AS payable_minor,
    (SELECT COUNT(*)
       FROM vendor_bills i
       LEFT JOIN (SELECT vendor_bill_id, SUM(amount_minor) AS paid FROM vendor_bill_payments GROUP BY vendor_bill_id) p
              ON p.vendor_bill_id = i.id
      WHERE i.workspace_id = @workspace_id AND i.is_cancelled = 0
        AND ((i.amount_minor + i.tax_minor) - IFNULL(p.paid, 0)) > 0)         AS payable_count
`);

/** Overdue invoices: not a draft, not cancelled, unpaid balance, due date passed. */
const overdueStmt = db.prepare(`
  SELECT COUNT(*) AS count,
         IFNULL(SUM(i.total_minor - IFNULL(p.paid, 0)), 0) AS amount_minor
    FROM invoices i
    LEFT JOIN (SELECT invoice_id, SUM(amount_minor) AS paid FROM invoice_payments GROUP BY invoice_id) p
           ON p.invoice_id = i.id
   WHERE i.workspace_id = ?
     AND i.is_draft = 0 AND i.is_cancelled = 0
     AND i.due_date < ?
     AND (i.total_minor - IFNULL(p.paid, 0)) > 0
`);

const cashStmt = db.prepare(`
  SELECT
    (SELECT IFNULL(SUM(p.amount_minor), 0) FROM invoice_payments p
       JOIN invoices i ON i.id = p.invoice_id
      WHERE i.workspace_id = @workspace_id
        AND (@from IS NULL OR p.paid_on >= @from)
        AND (@to   IS NULL OR p.paid_on <= @to))                              AS invoice_cash_minor,
    (SELECT IFNULL(SUM(p.amount_minor), 0) FROM vendor_bill_payments p
       JOIN vendor_bills b ON b.id = p.vendor_bill_id
      WHERE b.workspace_id = @workspace_id
        AND (@from IS NULL OR p.paid_on >= @from)
        AND (@to   IS NULL OR p.paid_on <= @to))                              AS bill_cash_minor,
    (SELECT IFNULL(SUM(amount_minor), 0) FROM transactions
      WHERE workspace_id = @workspace_id AND type = 'income'
        AND (@from IS NULL OR transaction_date >= @from)
        AND (@to   IS NULL OR transaction_date <= @to))                       AS income_minor,
    (SELECT IFNULL(SUM(amount_minor), 0) FROM transactions
      WHERE workspace_id = @workspace_id AND type = 'expense'
        AND (@from IS NULL OR transaction_date >= @from)
        AND (@to   IS NULL OR transaction_date <= @to))                       AS expense_minor
`);

/**
 * Business dashboard.
 *
 * DEFINITIONS (shown in the UI too):
 *   Revenue      = income transactions in the period (recorded sales/income)
 *   Expenses     = expense transactions in the period (recorded business costs)
 *   Net profit   = revenue - expenses   (a simple bookkeeping estimate)
 *   Receivable   = unpaid balance of issued invoices - NOT received money
 *   Payable      = unpaid balance of vendor bills   - NOT money paid yet
 *   Cash in/out  = actual cash movements (payments + transactions)
 *
 * Invoice payments are deliberately kept out of "revenue" so nothing is
 * counted twice, and unpaid invoices never appear as cash received.
 */
function getBusinessDashboard(workspaceId = 2, { from = null, to = null } = {}) {
  const totals = summaryStmt.get({ workspace_id: workspaceId, from, to });
  const revenueMinor = totals.income_minor;
  const expensesMinor = totals.expense_minor;
  const netMinor = revenueMinor - expensesMinor;

  const outstanding = outstandingStmt.get({ workspace_id: workspaceId });
  const overdue = overdueStmt.get(workspaceId, todayISO());
  const cash = cashStmt.get({ workspace_id: workspaceId, from, to });

  const moneyInMinor = cash.invoice_cash_minor + cash.income_minor;
  const moneyOutMinor = cash.bill_cash_minor + cash.expense_minor;

  // expense breakdown by category
  const byCategory = db
    .prepare(
      `SELECT category, SUM(amount_minor) AS total_minor, COUNT(*) AS count
         FROM transactions
        WHERE workspace_id = @workspace_id AND type = 'expense'
          AND (@from IS NULL OR transaction_date >= @from)
          AND (@to   IS NULL OR transaction_date <= @to)
        GROUP BY category
        ORDER BY total_minor DESC`
    )
    .all({ workspace_id: workspaceId, from, to });

  return {
    from,
    to,
    revenue: toRupees(revenueMinor),
    expenses: toRupees(expensesMinor),
    netProfit: toRupees(netMinor),
    profitMargin: revenueMinor > 0 ? Math.round((netMinor / revenueMinor) * 10000) / 100 : null,
    revenueMinor,
    expensesMinor,
    netProfitMinor: netMinor,
    incomeCount: totals.income_count || 0,
    expenseCount: totals.expense_count || 0,
    transactionCount: totals.transaction_count || 0,
    receivable: {
      amount: toRupees(outstanding.receivable_minor),
      amountMinor: outstanding.receivable_minor,
      invoiceCount: outstanding.receivable_count,
      overdueAmount: toRupees(overdue.amount_minor),
      overdueCount: overdue.count,
    },
    payable: {
      amount: toRupees(outstanding.payable_minor),
      amountMinor: outstanding.payable_minor,
      billCount: outstanding.payable_count,
    },
    cashFlow: {
      moneyIn: toRupees(moneyInMinor),
      moneyOut: toRupees(moneyOutMinor),
      net: toRupees(moneyInMinor - moneyOutMinor),
      moneyInMinor,
      moneyOutMinor,
      invoicePayments: toRupees(cash.invoice_cash_minor),
      billPayments: toRupees(cash.bill_cash_minor),
      incomeTransactions: toRupees(cash.income_minor),
      expenseTransactions: toRupees(cash.expense_minor),
    },
    // Latest entries for the two "recent" panels on the dashboard.
    recentSales: db
      .prepare(
        `SELECT id, title, category, transaction_date, amount_minor
           FROM transactions
          WHERE workspace_id = @workspace_id AND type = 'income'
          ORDER BY transaction_date DESC, id DESC
          LIMIT 5`
      )
      .all({ workspace_id: workspaceId })
      .map((row) => ({ ...row, amount: toRupees(row.amount_minor) })),
    recentExpenses: db
      .prepare(
        `SELECT id, title, category, transaction_date, amount_minor
           FROM transactions
          WHERE workspace_id = @workspace_id AND type = 'expense'
          ORDER BY transaction_date DESC, id DESC
          LIMIT 5`
      )
      .all({ workspace_id: workspaceId })
      .map((row) => ({ ...row, amount: toRupees(row.amount_minor) })),

    // Overdue documents, so the dashboard can point at what needs attention.
    overdueInvoices: db
      .prepare(
        `SELECT 'invoice' AS kind, i.id AS id, i.invoice_number AS number, i.due_date AS due_date,
                c.name AS party,
                (i.total_minor - IFNULL((SELECT SUM(amount_minor) FROM invoice_payments p WHERE p.invoice_id = i.id), 0)) AS balance_minor
           FROM invoices i
           JOIN customers c ON c.id = i.customer_id
          WHERE i.workspace_id = @workspace_id
            AND i.is_draft = 0 AND i.is_cancelled = 0
            AND i.due_date < @today
            AND IFNULL((SELECT SUM(amount_minor) FROM invoice_payments p WHERE p.invoice_id = i.id), 0) < i.total_minor
          ORDER BY i.due_date ASC
          LIMIT 5`
      )
      .all({ workspace_id: workspaceId, today: todayISO() })
      .map((row) => ({ ...row, balance: toRupees(row.balance_minor) })),
    overdueBills: db
      .prepare(
        `SELECT 'bill' AS kind, b.id AS id, b.bill_number AS number, b.due_date AS due_date,
                v.name AS party,
                ((b.amount_minor + b.tax_minor) - IFNULL((SELECT SUM(amount_minor) FROM vendor_bill_payments p WHERE p.vendor_bill_id = b.id), 0)) AS balance_minor
           FROM vendor_bills b
           JOIN vendors v ON v.id = b.vendor_id
          WHERE b.workspace_id = @workspace_id
            AND b.is_cancelled = 0
            AND b.due_date < @today
            AND IFNULL((SELECT SUM(amount_minor) FROM vendor_bill_payments p WHERE p.vendor_bill_id = b.id), 0) < (b.amount_minor + b.tax_minor)
          ORDER BY b.due_date ASC
          LIMIT 5`
      )
      .all({ workspace_id: workspaceId, today: todayISO() })
      .map((row) => ({ ...row, balance: toRupees(row.balance_minor) })),

    expenseByCategory: byCategory.map((row) => ({
      category: row.category,
      total: toRupees(row.total_minor),
      totalMinor: row.total_minor,
      count: row.count,
      percent: expensesMinor > 0 ? Math.round((row.total_minor / expensesMinor) * 1000) / 10 : 0,
    })),

    // How long the money has been owed (0-30 / 31-60 / 61+ days past due).
    aging: getReceivablesAging(workspaceId),
    topCustomers: getTopCustomers(workspaceId, 5),
  };
}

/**
 * Receivables aging. Buckets are computed from the due date on the server so
 * the dashboard never has to reason about "today" in the browser's timezone.
 */
function getReceivablesAging(workspaceId) {
  const rows = db
    .prepare(
      `SELECT (i.total_minor - IFNULL(p.paid, 0)) AS balance_minor, i.due_date AS due_date
         FROM invoices i
         LEFT JOIN (SELECT invoice_id, SUM(amount_minor) AS paid
                      FROM invoice_payments GROUP BY invoice_id) p ON p.invoice_id = i.id
        WHERE i.workspace_id = @workspace_id
          AND i.is_draft = 0 AND i.is_cancelled = 0
          AND (i.total_minor - IFNULL(p.paid, 0)) > 0`
    )
    .all({ workspace_id: workspaceId });

  const today = todayISO();
  const buckets = [
    { key: 'current', label: 'Not due yet', amountMinor: 0, count: 0 },
    { key: 'd1_30', label: '1–30 days', amountMinor: 0, count: 0 },
    { key: 'd31_60', label: '31–60 days', amountMinor: 0, count: 0 },
    { key: 'd60_plus', label: '60+ days', amountMinor: 0, count: 0 },
  ];

  for (const row of rows) {
    // Whole days between the due date and today; negative means not due yet.
    const daysLate = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.due_date}T00:00:00Z`)) / 86400000);
    let bucket = buckets[0];
    if (daysLate > 60) bucket = buckets[3];
    else if (daysLate > 30) bucket = buckets[2];
    else if (daysLate > 0) bucket = buckets[1];
    bucket.amountMinor += row.balance_minor;
    bucket.count += 1;
  }

  const totalMinor = buckets.reduce((sum, b) => sum + b.amountMinor, 0);
  return {
    totalMinor,
    total: toRupees(totalMinor),
    lateMinor: buckets[1].amountMinor + buckets[2].amountMinor + buckets[3].amountMinor,
    late: toRupees(buckets[1].amountMinor + buckets[2].amountMinor + buckets[3].amountMinor),
    buckets: buckets.map((b) => ({
      ...b,
      amount: toRupees(b.amountMinor),
      percent: totalMinor > 0 ? Math.round((b.amountMinor / totalMinor) * 1000) / 10 : 0,
    })),
  };
}

/** Customers ranked by the total value of their invoices. */
function getTopCustomers(workspaceId, limit = 5) {
  return db
    .prepare(
      `SELECT c.id AS customer_id, c.name AS name,
              COUNT(i.id) AS invoice_count,
              IFNULL(SUM(i.total_minor), 0) AS invoiced_minor,
              IFNULL(SUM(i.total_minor - IFNULL(p.paid, 0)), 0) AS outstanding_minor
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN (SELECT invoice_id, SUM(amount_minor) AS paid
                      FROM invoice_payments GROUP BY invoice_id) p ON p.invoice_id = i.id
        WHERE i.workspace_id = @workspace_id AND i.is_cancelled = 0 AND i.is_draft = 0
        GROUP BY c.id
        ORDER BY invoiced_minor DESC, c.name ASC
        LIMIT @limit`
    )
    .all({ workspace_id: workspaceId, limit })
    .map((row) => ({
      customerId: row.customer_id,
      name: row.name,
      invoiceCount: row.invoice_count,
      invoiced: toRupees(row.invoiced_minor),
      invoicedMinor: row.invoiced_minor,
      outstanding: toRupees(row.outstanding_minor),
      outstandingMinor: row.outstanding_minor,
    }));
}

/** Monthly profit trend: revenue, expenses and net per month. */
function getMonthlyProfitTrend(workspaceId = 1, months = 6) {
  const rows = getMonthlyTotals(workspaceId, months);
  return rows.map((row) => ({
    ...row,
    netProfit: row.balance,
    netProfitMinor: row.income_minor - row.expense_minor,
  }));
}

/** Cash flow report with the actual movement lines (not just totals). */
function getCashFlow(workspaceId = 2, { from = null, to = null } = {}) {
  const cash = cashStmt.get({ workspace_id: workspaceId, from, to });

  const entries = db
    .prepare(
      `SELECT * FROM (
         SELECT 'invoice_payment' AS kind, p.id AS id, p.paid_on AS entry_date,
                ('Invoice ' || i.invoice_number || ' — ' || c.name) AS label,
                p.method AS method, p.amount_minor AS amount_minor, i.invoice_number AS reference
           FROM invoice_payments p
           JOIN invoices i  ON i.id = p.invoice_id
           JOIN customers c ON c.id = i.customer_id
          WHERE i.workspace_id = @workspace_id
         UNION ALL
         SELECT 'income' AS kind, t.id AS id, t.transaction_date AS entry_date,
                t.title AS label, IFNULL(t.payment_method, '') AS method,
                t.amount_minor AS amount_minor, '' AS reference
           FROM transactions t
          WHERE t.workspace_id = @workspace_id AND t.type = 'income'
         UNION ALL
         SELECT 'bill_payment' AS kind, p.id AS id, p.paid_on AS entry_date,
                ('Bill ' || b.bill_number || ' — ' || v.name) AS label,
                p.method AS method, -p.amount_minor AS amount_minor, b.bill_number AS reference
           FROM vendor_bill_payments p
           JOIN vendor_bills b ON b.id = p.vendor_bill_id
           JOIN vendors v      ON v.id = b.vendor_id
          WHERE b.workspace_id = @workspace_id
         UNION ALL
         SELECT 'expense' AS kind, t.id AS id, t.transaction_date AS entry_date,
                t.title AS label, IFNULL(t.payment_method, '') AS method,
                -t.amount_minor AS amount_minor, '' AS reference
           FROM transactions t
          WHERE t.workspace_id = @workspace_id AND t.type = 'expense'
       )
       WHERE (@from IS NULL OR entry_date >= @from)
         AND (@to   IS NULL OR entry_date <= @to)
       ORDER BY entry_date DESC, id DESC
       LIMIT 500`
    )
    .all({ workspace_id: workspaceId, from, to });

  const moneyInMinor = cash.invoice_cash_minor + cash.income_minor;
  const moneyOutMinor = cash.bill_cash_minor + cash.expense_minor;

  return {
    from,
    to,
    moneyIn: toRupees(moneyInMinor),
    moneyOut: toRupees(moneyOutMinor),
    net: toRupees(moneyInMinor - moneyOutMinor),
    moneyInMinor,
    moneyOutMinor,
    // Explicitly separate from cash: these are NOT money moved yet.
    notYetReceived: toRupees(
      outstandingStmt.get({ workspace_id: workspaceId }).receivable_minor
    ),
    notYetPaid: toRupees(
      outstandingStmt.get({ workspace_id: workspaceId }).payable_minor
    ),
    entries: entries.map((row) => ({
      ...row,
      amount: toRupees(row.amount_minor),
      direction: row.amount_minor >= 0 ? 'in' : 'out',
    })),
  };
}

module.exports = {
  // shared
  currentMonth,
  todayISO,
  shiftMonth,
  lastMonths,
  monthLabel,
  // individual
  getSummary,
  getMonthlyTotals,
  getCategoryTotals,
  getInsights,
  // business
  getBusinessDashboard,
  getMonthlyProfitTrend,
  getCashFlow,
};
