/**
 * src/repositories/budgets.js
 * ---------------------------------------------------------------------------
 * Two kinds of budget:
 *   1. `budgets`           -> one overall spending limit per month
 *   2. `category_budgets`  -> an optional limit per category per month
 *
 * Both are scoped to a workspace, so Personal and Business each keep their own.
 * "Spent" is never stored: it is always summed from the transactions table, so
 * editing or deleting a transaction immediately changes the progress bars.
 * ---------------------------------------------------------------------------
 */

const { db } = require('../../database');
const { notFound } = require('../validation');
const { toRupees } = require('../money');

const selectMonthStmt = db.prepare('SELECT * FROM budgets WHERE workspace_id = ? AND month = ?');

// UPSERT: insert the budget, or update it when that workspace+month already exists.
const upsertStmt = db.prepare(`
  INSERT INTO budgets (workspace_id, month, amount_minor)
  VALUES (@workspace_id, @month, @amount_minor)
  ON CONFLICT(workspace_id, month) DO UPDATE
    SET amount_minor = excluded.amount_minor,
        updated_at = datetime('now')
`);

const expenseForMonthStmt = db.prepare(`
  SELECT IFNULL(SUM(amount_minor), 0) AS spent_minor, COUNT(*) AS count
    FROM transactions
   WHERE workspace_id = ? AND type = 'expense' AND substr(transaction_date, 1, 7) = ?
`);

const spendByCategoryStmt = db.prepare(`
  SELECT category, SUM(amount_minor) AS spent_minor, COUNT(*) AS count
    FROM transactions
   WHERE workspace_id = ? AND type = 'expense' AND substr(transaction_date, 1, 7) = ?
   GROUP BY category
`);

const categoryBudgetsStmt = db.prepare(`
  SELECT * FROM category_budgets WHERE workspace_id = ? AND month = ? ORDER BY category
`);

/** Adds the calculated fields (spent / remaining / percent used) to a budget. */
function withUsage(budget, month, workspaceId) {
  const { spent_minor: spentMinor, count } = expenseForMonthStmt.get(workspaceId, month);
  const amountMinor = budget ? budget.amount_minor : 0;
  const percentUsed = amountMinor > 0 ? Math.round((spentMinor / amountMinor) * 10000) / 100 : null;

  return {
    month,
    amount: toRupees(amountMinor),
    amount_minor: amountMinor,
    spent: toRupees(spentMinor),
    spent_minor: spentMinor,
    expenseCount: count,
    remaining: toRupees(amountMinor - spentMinor),
    remaining_minor: amountMinor - spentMinor,
    percentUsed, // null when no budget has been set
    isSet: Boolean(budget),
    exceeded: amountMinor > 0 && spentMinor > amountMinor,
    // 75%+ is "approaching the limit" - the UI shows an amber bar
    warning: amountMinor > 0 && spentMinor >= amountMinor * 0.75 && spentMinor <= amountMinor,
    updatedAt: budget ? budget.updated_at : null,
  };
}

/** GET /api/budgets?month=YYYY-MM — always returns a useful object, even if unset. */
function getBudgetForMonth(month, workspaceId = 1) {
  return withUsage(selectMonthStmt.get(workspaceId, month) || null, month, workspaceId);
}

/** PUT /api/budgets — create or update the budget for a month. */
function upsertBudget({ month, amount_minor }, workspaceId = 1) {
  upsertStmt.run({ workspace_id: workspaceId, month, amount_minor });
  return getBudgetForMonth(month, workspaceId);
}

function deleteBudget(month, workspaceId = 1) {
  const existing = selectMonthStmt.get(workspaceId, month);
  if (!existing) throw notFound('No budget is set for that month.');
  db.prepare('DELETE FROM budgets WHERE workspace_id = ? AND month = ?').run(workspaceId, month);
  return withUsage(null, month, workspaceId);
}

/** Budget history for the budget screen. */
function listBudgets(limit = 24, workspaceId = 1) {
  const rows = db
    .prepare('SELECT * FROM budgets WHERE workspace_id = ? ORDER BY month DESC LIMIT ?')
    .all(workspaceId, Math.min(Math.max(Number(limit) || 24, 1), 60));
  return rows.map((row) => withUsage(row, row.month, workspaceId));
}

// ===========================================================================
// Category budgets
// ===========================================================================

/** Category budgets + live spend for a month. */
function listCategoryBudgets(month, workspaceId = 1) {
  const budgets = categoryBudgetsStmt.all(workspaceId, month);
  const spendRows = spendByCategoryStmt.all(workspaceId, month);
  const spendMap = new Map(spendRows.map((r) => [r.category, r.spent_minor]));

  return budgets.map((row) => {
    const spentMinor = spendMap.get(row.category) || 0;
    const percentUsed = row.amount_minor > 0 ? Math.round((spentMinor / row.amount_minor) * 10000) / 100 : 0;
    return {
      id: row.id,
      month: row.month,
      category: row.category,
      amount: toRupees(row.amount_minor),
      amount_minor: row.amount_minor,
      spent: toRupees(spentMinor),
      spent_minor: spentMinor,
      remaining: toRupees(row.amount_minor - spentMinor),
      remaining_minor: row.amount_minor - spentMinor,
      percentUsed,
      exceeded: spentMinor > row.amount_minor,
      warning: spentMinor >= row.amount_minor * 0.75 && spentMinor <= row.amount_minor,
    };
  });
}

const upsertCategoryStmt = db.prepare(`
  INSERT INTO category_budgets (workspace_id, month, category, amount_minor)
  VALUES (@workspace_id, @month, @category, @amount_minor)
  ON CONFLICT(workspace_id, month, category) DO UPDATE
    SET amount_minor = excluded.amount_minor,
        updated_at = datetime('now')
`);

function upsertCategoryBudget({ month, category, amount_minor }, workspaceId = 1) {
  upsertCategoryStmt.run({ workspace_id: workspaceId, month, category, amount_minor });
  return listCategoryBudgets(month, workspaceId).find((b) => b.category === category);
}

function deleteCategoryBudget({ month, category }, workspaceId = 1) {
  const info = db
    .prepare('DELETE FROM category_budgets WHERE workspace_id = ? AND month = ? AND category = ?')
    .run(workspaceId, month, category);
  if (info.changes === 0) throw notFound('No category budget is set for that month and category.');
  return { deleted: true, month, category };
}

module.exports = {
  getBudgetForMonth,
  upsertBudget,
  deleteBudget,
  listBudgets,
  listCategoryBudgets,
  upsertCategoryBudget,
  deleteCategoryBudget,
};
