/**
 * src/routes/api.js
 * ---------------------------------------------------------------------------
 * The REST API. Each route:
 *   1. resolves the active workspace (Personal or Business),
 *   2. validates / parses the input,
 *   3. calls a repository function (which owns the SQL),
 *   4. returns JSON with a sensible HTTP status code.
 *
 * SmartSpend 1.0 routes still work unchanged: if no workspaceId is supplied we
 * default to workspace 1 (Personal). The browser sends `X-Workspace-Id` on every
 * request, which is how the mode switcher scopes everything.
 *
 * Business endpoints live in routes/business.js and are mounted at
 * /api/business/*.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const {
  PERSONAL_CATEGORIES,
  PERSONAL_INCOME_CATEGORIES,
  BUSINESS_CATEGORIES,
  TRANSACTION_TYPES,
  PAYMENT_METHODS,
  RECURRENCE_FREQUENCIES,
  categoriesFor,
  parseId,
  parseMonth,
  parseDateRange,
  validateTransactionInput,
  validateBudgetInput,
  validateCategoryBudgetInput,
  validateRecurringInput,
  validateGoalInput,
  validateContributionInput,
  badRequest,
} = require('../validation');
const { resolveWorkspace, listWorkspaces, getWorkspace, renameWorkspace } = require('../repositories/workspaces');
const txRepo = require('../repositories/transactions');
const budgetRepo = require('../repositories/budgets');
const analytics = require('../repositories/analytics');
const reports = require('../repositories/reports');
const recurring = require('../repositories/recurring');
const goals = require('../repositories/goals');
const { migrationStatus } = require('../migrations');
const { db } = require('../../database');
const { sendCsv, rupees } = require('../csv');

const router = express.Router();

/**
 * Attaches `req.workspace` for every request.
 * An explicit workspaceId that does not exist is a 404 - we never silently
 * fall back to another book, because that would mix personal and business data.
 */
function withWorkspace(req, res, next) {
  try {
    req.workspace = resolveWorkspace(req);
    next();
  } catch (error) {
    next(error);
  }
}

// ===========================================================================
// META / HEALTH / WORKSPACES
// ===========================================================================

router.get('/meta', (req, res) => {
  res.json({
    app: 'SmartSpend',
    version: '2.4.0',
    tagline: 'Your money, clearly organised.',
    // Personal lists kept under the v1 names so old code keeps working.
    categories: PERSONAL_CATEGORIES,
    types: TRANSACTION_TYPES,
    currentMonth: analytics.currentMonth(),
    personalCategories: PERSONAL_CATEGORIES,
    personalIncomeCategories: PERSONAL_INCOME_CATEGORIES,
    businessCategories: BUSINESS_CATEGORIES,
    paymentMethods: PAYMENT_METHODS,
    recurrenceFrequencies: RECURRENCE_FREQUENCIES,
    modes: [
      { mode: 'individual', label: 'Individual', description: 'Personal income, expenses, budgets and savings goals.' },
      { mode: 'business', label: 'Business', description: 'Sales, expenses, customers, invoices, bills and cash flow.' },
    ],
  });
});

router.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '2.4.0' });
});

router.get('/workspaces', (req, res) => {
  res.json({ data: listWorkspaces() });
});

router.get('/workspaces/:id', (req, res) => {
  res.json({ data: getWorkspace(parseId(req.params.id, 'workspace')) });
});

router.patch('/workspaces/:id', (req, res) => {
  const id = parseId(req.params.id, 'workspace');
  res.json({ data: renameWorkspace(id, { name: req.body?.name, notes: req.body?.notes }), message: 'Workspace updated.' });
});

// Which schema migrations have been applied (used by the Settings screen).
router.get('/system/migrations', (req, res) => {
  res.json({
    data: migrationStatus(db),
    counts: {
      transactions: db.prepare('SELECT COUNT(*) c FROM transactions').get().c,
      budgets: db.prepare('SELECT COUNT(*) c FROM budgets').get().c,
      invoices: db.prepare('SELECT COUNT(*) c FROM invoices').get().c,
      customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
      vendors: db.prepare('SELECT COUNT(*) c FROM vendors').get().c,
    },
  });
});

// ===========================================================================
// TRANSACTIONS  (used by both modes)
// ===========================================================================

router.get('/transactions', withWorkspace, (req, res) => {
  const result = txRepo.listTransactions(req.query, req.workspace.id);
  res.json({
    data: result.rows,
    pagination: {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      returned: result.rows.length,
    },
    totals: {
      income: result.filteredIncome,
      expense: result.filteredExpense,
      incomeMinor: result.filteredIncomeMinor,
      expenseMinor: result.filteredExpenseMinor,
    },
    workspace: { id: req.workspace.id, type: req.workspace.type, name: req.workspace.name },
  });
});

router.get('/transactions/:id', withWorkspace, (req, res) => {
  res.json({ data: txRepo.getTransactionById(parseId(req.params.id), req.workspace.id) });
});

router.post('/transactions', withWorkspace, (req, res) => {
  const clean = validateTransactionInput(req.body, { categories: categoriesFor(req.workspace.type) });
  const created = txRepo.createTransaction(clean, req.workspace.id);
  res.status(201).json({ data: created, message: 'Transaction added successfully.' });
});

router.put('/transactions/:id', withWorkspace, (req, res) => {
  const id = parseId(req.params.id);
  const clean = validateTransactionInput(req.body, { categories: categoriesFor(req.workspace.type) });
  res.json({ data: txRepo.updateTransaction(id, clean, req.workspace.id), message: 'Transaction updated successfully.' });
});

router.patch('/transactions/:id', withWorkspace, (req, res) => {
  const id = parseId(req.params.id);
  const existing = txRepo.getTransactionById(id, req.workspace.id);
  const merged = { ...existing, ...req.body };
  const clean = validateTransactionInput(merged, { categories: categoriesFor(req.workspace.type) });
  res.json({ data: txRepo.updateTransaction(id, clean, req.workspace.id), message: 'Transaction updated successfully.' });
});

router.delete('/transactions/:id', withWorkspace, (req, res) => {
  res.json({ data: txRepo.deleteTransaction(parseId(req.params.id), req.workspace.id), message: 'Transaction deleted.' });
});

// CSV export for whichever mode is active.
router.get('/export/transactions.csv', withWorkspace, (req, res) => {
  const { from, to } = parseDateRange(req.query);
  const rows = txRepo.allForExport({ ...req.query, from, to }, req.workspace.id);
  const header = ['Date', 'Type', 'Description', 'Category', 'Amount (INR)', 'Tax (INR)', 'Payment method', 'Notes'];
  const body = rows.map((row) => [
    row.transaction_date,
    row.type,
    row.title,
    row.category,
    rupees(row.amount_minor),
    rupees(row.tax_minor),
    row.payment_method || '',
    row.notes || '',
  ]);
  const tag = req.workspace.type === 'business' ? 'business' : 'personal';
  sendCsv(res, `smartspend-${tag}-transactions-${Date.now()}.csv`, [header, ...body]);
});

// ===========================================================================
// DASHBOARD SUMMARY
// ===========================================================================

router.get('/summary', withWorkspace, (req, res) => {
  const month = parseMonth(req.query.month, { required: false });
  const { from, to } = parseDateRange(req.query);
  res.json({
    data: analytics.getSummary(req.workspace.id, { month, from, to }),
    month,
    from,
    to,
    workspace: { id: req.workspace.id, type: req.workspace.type, name: req.workspace.name },
  });
});

// ===========================================================================
// BUDGETS  (individual mode in practice, but scoped per workspace)
// ===========================================================================

router.get('/budgets', withWorkspace, (req, res) => {
  if (req.query.month) {
    const month = parseMonth(req.query.month);
    return res.json({ data: budgetRepo.getBudgetForMonth(month, req.workspace.id) });
  }
  res.json({ data: budgetRepo.listBudgets(req.query.limit, req.workspace.id) });
});

router.put('/budgets', withWorkspace, (req, res) => {
  const clean = validateBudgetInput(req.body);
  res.json({ data: budgetRepo.upsertBudget(clean, req.workspace.id), message: 'Budget saved successfully.' });
});

router.delete('/budgets', withWorkspace, (req, res) => {
  const month = parseMonth(req.query.month);
  res.json({ data: budgetRepo.deleteBudget(month, req.workspace.id), message: 'Budget removed.' });
});

// ---- category budgets ------------------------------------------------------
router.get('/category-budgets', withWorkspace, (req, res) => {
  const month = parseMonth(req.query.month, { required: false }) || analytics.currentMonth();
  res.json({ data: budgetRepo.listCategoryBudgets(month, req.workspace.id), month });
});

router.put('/category-budgets', withWorkspace, (req, res) => {
  const clean = validateCategoryBudgetInput(req.body, { categories: categoriesFor(req.workspace.type) });
  res.json({ data: budgetRepo.upsertCategoryBudget(clean, req.workspace.id), message: 'Category budget saved.' });
});

router.delete('/category-budgets', withWorkspace, (req, res) => {
  const month = parseMonth(req.query.month);
  const category = req.query.category;
  if (!category) throw badRequest('category is required.');
  res.json({ data: budgetRepo.deleteCategoryBudget({ month, category }, req.workspace.id), message: 'Category budget removed.' });
});

// ===========================================================================
// ANALYTICS
// ===========================================================================

router.get('/analytics/monthly', withWorkspace, (req, res) => {
  const months = req.query.months;
  if (months !== undefined && (!/^\d+$/.test(String(months)) || Number(months) < 1 || Number(months) > 24)) {
    throw badRequest('"months" must be a whole number between 1 and 24.');
  }
  res.json({ data: analytics.getMonthlyTotals(req.workspace.id, months) });
});

router.get('/analytics/categories', withWorkspace, (req, res) => {
  const month = parseMonth(req.query.month, { required: false }) || analytics.currentMonth();
  res.json({ data: analytics.getCategoryTotals(req.workspace.id, month) });
});

router.get('/analytics/insights', withWorkspace, (req, res) => {
  const month = parseMonth(req.query.month, { required: false }) || analytics.currentMonth();
  res.json({ data: analytics.getInsights(req.workspace.id, month) });
});

// ===========================================================================
// SAVINGS GOALS  (individual)
// ===========================================================================

router.get('/savings-goals', withWorkspace, (req, res) => {
  res.json({
    data: goals.listGoals(req.workspace.id, { includeArchived: req.query.includeArchived === 'true' }),
  });
});

router.get('/savings-goals/:id', withWorkspace, (req, res) => {
  res.json({ data: goals.getGoal(parseId(req.params.id, 'goal'), req.workspace.id) });
});

router.post('/savings-goals', withWorkspace, (req, res) => {
  const clean = validateGoalInput(req.body);
  res.status(201).json({ data: goals.createGoal(clean, req.workspace.id), message: 'Savings goal created.' });
});

router.put('/savings-goals/:id', withWorkspace, (req, res) => {
  const id = parseId(req.params.id, 'goal');
  const clean = validateGoalInput(req.body);
  res.json({ data: goals.updateGoal(id, clean, req.workspace.id), message: 'Savings goal updated.' });
});

router.delete('/savings-goals/:id', withWorkspace, (req, res) => {
  res.json({ data: goals.deleteGoal(parseId(req.params.id, 'goal'), req.workspace.id), message: 'Savings goal deleted.' });
});

router.post('/savings-goals/:id/contributions', withWorkspace, (req, res) => {
  const id = parseId(req.params.id, 'goal');
  const clean = validateContributionInput(req.body);
  res.status(201).json({ data: goals.addContribution(id, clean, req.workspace.id), message: 'Savings updated.' });
});

router.post('/savings-goals/:id/archive', withWorkspace, (req, res) => {
  const id = parseId(req.params.id, 'goal');
  const archived = req.body?.archived !== false;
  res.json({ data: goals.setArchived(id, req.workspace.id, archived), message: archived ? 'Goal archived.' : 'Goal restored.' });
});

// ===========================================================================
// RECURRING EXPENSES  (individual)
// ===========================================================================

router.get('/recurring', withWorkspace, (req, res) => {
  res.json({ data: recurring.listRules(req.workspace.id) });
});

router.get('/recurring/upcoming', withWorkspace, (req, res) => {
  res.json({ data: recurring.upcoming(req.workspace.id, Number(req.query.days) || 45) });
});

router.get('/recurring/:id', withWorkspace, (req, res) => {
  res.json({ data: recurring.getRule(parseId(req.params.id, 'rule'), req.workspace.id) });
});

router.post('/recurring', withWorkspace, (req, res) => {
  const clean = validateRecurringInput(req.body, { categories: categoriesFor(req.workspace.type) });
  res.status(201).json({ data: recurring.createRule(clean, req.workspace.id), message: 'Recurring rule created.' });
});

router.put('/recurring/:id', withWorkspace, (req, res) => {
  const id = parseId(req.params.id, 'rule');
  const clean = validateRecurringInput(req.body, { categories: categoriesFor(req.workspace.type) });
  res.json({ data: recurring.updateRule(id, clean, req.workspace.id), message: 'Recurring rule updated.' });
});

router.delete('/recurring/:id', withWorkspace, (req, res) => {
  res.json({ data: recurring.deleteRule(parseId(req.params.id, 'rule'), req.workspace.id), message: 'Recurring rule deleted.' });
});

/**
 * Explicitly generate the transactions that have become due.
 * Idempotent: the unique index (recurring_rule_id, transaction_date) means a
 * second call inserts nothing.
 */
router.post('/recurring/run', withWorkspace, (req, res) => {
  const result = recurring.runDue(req.workspace.id);
  res.json({
    data: result,
    message: result.createdCount === 0
      ? 'No new entries were due — nothing was duplicated.'
      : `${result.createdCount} recurring ${result.createdCount === 1 ? 'entry' : 'entries'} created.`,
  });
});

// ===========================================================================
// REPORTS  (individual + shared)
// ===========================================================================

router.get('/reports/monthly-summary', withWorkspace, (req, res) => {
  const { from, to } = parseDateRange(req.query);
  res.json({ data: reports.monthlySummary(req.workspace.id, { from, to }) });
});

router.get('/reports/tax', withWorkspace, (req, res) => {
  const { from, to } = parseDateRange(req.query);
  res.json({ data: reports.taxSummary(req.workspace.id, { from, to }) });
});

router.get('/export/monthly-summary.csv', withWorkspace, (req, res) => {
  const { from, to } = parseDateRange(req.query);
  const rows = reports.monthlySummary(req.workspace.id, { from, to });
  const header = ['Month', 'Income (INR)', 'Expenses (INR)', 'Net (INR)', 'Savings rate (%)', 'Income entries', 'Expense entries'];
  const body = rows.map((row) => [
    row.month,
    rupees(row.income * 100),
    rupees(row.expense * 100),
    rupees(row.net * 100),
    row.savingsRate,
    row.incomeCount,
    row.expenseCount,
  ]);
  sendCsv(res, `smartspend-monthly-summary-${Date.now()}.csv`, [header, ...body]);
});

// ===========================================================================
// BUSINESS API
// ===========================================================================

router.use('/business', require('./business'));

// Any other /api/* path is a 404 rather than the HTML page.
router.use((req, res) => {
  res.status(404).json({ error: { message: `API route not found: ${req.method} ${req.originalUrl}` } });
});

module.exports = router;
