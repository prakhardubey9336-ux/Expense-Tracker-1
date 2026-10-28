/**
 * scripts/seed-demo.js  (OPTIONAL — not part of the running application)
 * ---------------------------------------------------------------------------
 * Fills the database with a realistic set of demo transactions and a couple of
 * budgets, so the dashboard looks busy during a presentation or a viva demo.
 *
 * The application itself NEVER generates fake data — this is a separate helper
 * you choose to run.
 *
 * Usage:
 *   node scripts/seed-demo.js           # read the current date and add demo rows
 *   node scripts/seed-demo.js --reset   # DELETE all transactions + budgets first
 *
 * Stop the server first (or it is also fine to run with the server running —
 * SQLite handles concurrent access), then refresh your browser.
 * ---------------------------------------------------------------------------
 */

const { db } = require('../database');
const { defaultWorkspaceFor } = require('../src/repositories/workspaces');
const { toMinor } = require('../src/money');

// SmartSpend 2.0: every row belongs to a workspace. This script only ever
// touches the INDIVIDUAL (personal) workspace, so it can never add demo
// transactions to the business books.
const workspace = defaultWorkspaceFor('individual');

const reset = process.argv.includes('--reset');

// --- small date helpers ----------------------------------------------------
const now = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const monthOf = (offset) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 7);
};
const dayIn = (monthOffset, day) => `${monthOf(monthOffset)}-${String(day).padStart(2, '0')}`;

const month0 = monthOf(0); // this month
const month1 = monthOf(-1); // last month
const month2 = monthOf(-2); // two months ago

// --- demo rows -------------------------------------------------------------
// [type, title, category, amount, date, notes]
const rows = [
  // ---- two months ago ----
  ['income', 'Monthly allowance', 'Salary', 6000, dayIn(-2, 2), 'From parents'],
  ['expense', 'Semester stationery', 'Education', 850, dayIn(-2, 5), 'Notebooks and printouts'],
  ['expense', 'Canteen lunches', 'Food', 640, dayIn(-2, 11), null],
  ['expense', 'Bus pass', 'Travel', 500, dayIn(-2, 18), 'Monthly pass'],

  // ---- last month ----
  ['income', 'Monthly allowance', 'Salary', 6000, dayIn(-1, 2), null],
  ['income', 'Freelance poster design', 'Freelance', 2500, dayIn(-1, 9), 'Client: college fest'],
  ['expense', 'Mess bill', 'Food', 1800, dayIn(-1, 4), null],
  ['expense', 'Mobile recharge', 'Bills', 299, dayIn(-1, 6), '28-day plan'],
  ['expense', 'Movie with friends', 'Entertainment', 450, dayIn(-1, 13), 'PVR cinema'],
  ['expense', 'Lab manual printing', 'Education', 220, dayIn(-1, 17), null],
  ['expense', 'Metro card top-up', 'Travel', 300, dayIn(-1, 21), null],
  ['expense', 'Shoes', 'Shopping', 1299, dayIn(-1, 25), 'Sports shoes for PT'],

  // ---- this month ----
  ['income', 'Monthly allowance', 'Salary', 6000, dayIn(0, 2), null],
  ['income', 'Internship stipend', 'Freelance', 4500, dayIn(0, 8), 'Part-time internship'],
  ['expense', 'Canteen lunch', 'Food', 150, dayIn(0, 3), 'With project group'],
  ['expense', 'Metro card top-up', 'Travel', 400, dayIn(0, 4), null],
  ['expense', 'Mobile recharge', 'Bills', 299, dayIn(0, 6), null],
  ['expense', 'Notebook and pens', 'Shopping', 340, dayIn(0, 9), 'Exam prep'],
  ['expense', 'Pharmacy', 'Health', 180, dayIn(0, 12), 'Cold medicine'],
  ['expense', 'Movie ticket', 'Entertainment', 250, dayIn(0, 15), 'Weekend show'],
  ['expense', 'Practice set for DSA', 'Education', 620, dayIn(0, 18), null],
  ['expense', 'Groceries for hostel', 'Food', 480, dayIn(0, 22), null],
];

// Keep demo data in the current month only if today is late enough.
// (Rows dated in the future would look odd, so we clamp them to today.)
const todayISO = iso(now);
const safeRows = rows.map(([type, title, category, amount, date, notes]) => [
  type,
  title,
  category,
  amount,
  date > todayISO ? todayISO : date,
  notes,
]);

// `amount` is now a generated column (amount_minor / 100), so we write paise.
const insert = db.prepare(`
  INSERT INTO transactions (workspace_id, type, title, category, amount_minor, transaction_date, notes)
  VALUES (@workspace_id, @type, @title, @category, @amount_minor, @transaction_date, @notes)
`);
const upsertBudget = db.prepare(`
  INSERT INTO budgets (workspace_id, month, amount_minor) VALUES (@workspace_id, @month, @amount_minor)
  ON CONFLICT(workspace_id, month) DO UPDATE SET amount_minor = excluded.amount_minor, updated_at = datetime('now')
`);

// A database transaction: either everything is written, or nothing is.
const seed = db.transaction(() => {
  if (reset) {
    // Only this workspace's demo rows — never the business books.
    db.prepare('DELETE FROM transactions WHERE workspace_id = ?').run(workspace.id);
    db.prepare('DELETE FROM budgets WHERE workspace_id = ?').run(workspace.id);
    console.log('Deleted all existing personal transactions and budgets.');
  }

  let inserted = 0;
  for (const [type, title, category, amount, transaction_date, notes] of safeRows) {
    insert.run({
      workspace_id: workspace.id,
      type,
      title,
      category,
      amount_minor: toMinor(amount),
      transaction_date,
      notes,
    });
    inserted += 1;
  }

  upsertBudget.run({ workspace_id: workspace.id, month: month0, amount_minor: toMinor(3000) });
  upsertBudget.run({ workspace_id: workspace.id, month: month1, amount_minor: toMinor(3500) });
  upsertBudget.run({ workspace_id: workspace.id, month: month2, amount_minor: toMinor(2500) });

  return inserted;
});

try {
  const count = seed();
  const totals = db
    .prepare(
      `SELECT
         IFNULL(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
         IFNULL(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expense,
         COUNT(*) AS rows
       FROM transactions WHERE workspace_id = @workspace_id`
    )
    .get({ workspace_id: workspace.id });

  console.log('');
  console.log(`  Demo data added: ${count} new transactions (${totals.rows} rows in the table now).`);
  console.log(`  Income: ₹${totals.income.toLocaleString('en-IN')}   Expenses: ₹${totals.expense.toLocaleString('en-IN')}`);
  console.log(`  Budgets set for: ${month2}, ${month1}, ${month0}`);
  console.log(`  Workspace: ${workspace.id} (${workspace.name}) — the business books were not touched.`);
  console.log('');
  console.log('  Refresh http://localhost:3000 to see it.');
  console.log('  To start over: node scripts/seed-demo.js --reset');
  console.log('');
} catch (error) {
  console.error('Could not add demo data:', error.message);
  process.exitCode = 1;
}
