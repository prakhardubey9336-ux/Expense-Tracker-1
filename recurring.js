/**
 * src/repositories/recurring.js
 * ---------------------------------------------------------------------------
 * Recurring expenses ("Hostel rent ₹3,000 every month").
 *
 * THE IDEMPOTENCY RULE
 *   Nothing is created when you open a page. Transactions are written only when
 *   you explicitly press "Generate due entries" (POST /api/recurring/run).
 *   Even then, migration 003 added
 *       UNIQUE (recurring_rule_id, transaction_date) WHERE recurring_rule_id IS NOT NULL
 *   so a rule can produce at most ONE transaction per date. Running the
 *   generator twice - or ten times - cannot create duplicates. The code also
 *   uses INSERT OR IGNORE plus a database transaction, so it is safe under
 *   repeated clicks.
 * ---------------------------------------------------------------------------
 */

const { db } = require('../../database');
const { notFound, todayISO } = require('../validation');
const { toRupees } = require('../money');

/** Adds N days / months / years to a YYYY-MM-DD string. */
function advance(dateISO, frequency) {
  const [y, m, d] = dateISO.split('-').map(Number);
  if (frequency === 'daily') {
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }
  if (frequency === 'weekly') {
    return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  }
  if (frequency === 'monthly') {
    // clamp to the last day of the target month (31 Jan -> 28/29 Feb)
    const targetMonth = m; // 0-based next month index in Date.UTC
    const lastDay = new Date(Date.UTC(y, targetMonth + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, targetMonth, Math.min(d, lastDay))).toISOString().slice(0, 10);
  }
  // yearly
  const lastDay = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return new Date(Date.UTC(y + 1, m - 1, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** How many times has this rule already produced a transaction? */
const countGeneratedStmt = db.prepare(
  'SELECT COUNT(*) AS c, MAX(transaction_date) AS last FROM transactions WHERE recurring_rule_id = ?'
);

function decorate(row) {
  const { c, last } = countGeneratedStmt.get(row.id);
  return {
    ...row,
    is_active: Boolean(row.is_active),
    generatedCount: c,
    lastGeneratedOn: last,
    amount: toRupees(row.amount_minor),
  };
}

function listRules(workspaceId) {
  return db
    .prepare('SELECT * FROM recurring_rules WHERE workspace_id = ? ORDER BY is_active DESC, next_due_date ASC')
    .all(workspaceId)
    .map(decorate);
}

function getRule(id, workspaceId) {
  const row = db.prepare('SELECT * FROM recurring_rules WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw notFound('Recurring rule not found.');
  return decorate(row);
}

function createRule(data, workspaceId) {
  const info = db
    .prepare(
      `INSERT INTO recurring_rules
         (workspace_id, title, type, category, amount_minor, frequency, start_date, next_due_date, notes, is_active)
       VALUES (@workspace_id, @title, @type, @category, @amount_minor, @frequency, @start_date, @next_due_date, @notes, @is_active)`
    )
    .run({
      workspace_id: workspaceId,
      title: data.title,
      type: data.type,
      category: data.category,
      amount_minor: data.amount_minor,
      frequency: data.frequency,
      start_date: data.start_date,
      next_due_date: data.next_due_date,
      notes: data.notes ?? null,
      is_active: data.is_active ?? 1,
    });
  return getRule(info.lastInsertRowid, workspaceId);
}

function updateRule(id, data, workspaceId) {
  getRule(id, workspaceId);
  db.prepare(
    `UPDATE recurring_rules
        SET title = @title, type = @type, category = @category, amount_minor = @amount_minor,
            frequency = @frequency, start_date = @start_date, next_due_date = @next_due_date,
            notes = @notes, is_active = @is_active, updated_at = datetime('now')
      WHERE id = @id AND workspace_id = @workspace_id`
  ).run({
    id,
    workspace_id: workspaceId,
    title: data.title,
    type: data.type,
    category: data.category,
    amount_minor: data.amount_minor,
    frequency: data.frequency,
    start_date: data.start_date,
    next_due_date: data.next_due_date,
    notes: data.notes ?? null,
    is_active: data.is_active ?? 1,
  });
  return getRule(id, workspaceId);
}

function deleteRule(id, workspaceId) {
  const rule = getRule(id, workspaceId);
  // Generated transactions keep their recurring_rule_id (they are real history),
  // but we detach them so deleting the rule does not break anything.
  db.prepare('UPDATE transactions SET recurring_rule_id = NULL WHERE recurring_rule_id = ?').run(id);
  db.prepare('DELETE FROM recurring_rules WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  return rule;
}

/** Upcoming expected payments for the next N days (read-only, creates nothing). */
function upcoming(workspaceId, days = 45) {
  const rules = db
    .prepare(`SELECT * FROM recurring_rules WHERE workspace_id = ? AND is_active = 1`)
    .all(workspaceId);

  const today = todayISO();
  const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const items = [];

  for (const rule of rules) {
    let due = rule.next_due_date;
    let guard = 0;
    while (due <= horizon && guard < 60) {
      items.push({
        ruleId: rule.id,
        title: rule.title,
        category: rule.category,
        type: rule.type,
        frequency: rule.frequency,
        amount: toRupees(rule.amount_minor),
        dueDate: due,
        isOverdue: due < today,
      });
      due = advance(due, rule.frequency);
      guard += 1;
    }
  }

  items.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  return {
    horizonDays: days,
    total: items.reduce((sum, item) => sum + (item.type === 'expense' ? item.amount : 0), 0),
    items,
  };
}

/**
 * Creates transactions for every due date up to today.
 * IDEMPOTENT: `INSERT OR IGNORE` + the unique index means a second run inserts 0.
 */
function runDue(workspaceId, { today = todayISO() } = {}) {
  const rules = db
    .prepare('SELECT * FROM recurring_rules WHERE workspace_id = ? AND is_active = 1')
    .all(workspaceId);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO transactions
      (workspace_id, type, title, category, amount_minor, transaction_date, notes, recurring_rule_id)
    VALUES (@workspace_id, @type, @title, @category, @amount_minor, @transaction_date, @notes, @recurring_rule_id)
  `);
  const bumpNext = db.prepare('UPDATE recurring_rules SET next_due_date = ?, updated_at = datetime(\'now\') WHERE id = ?');

  const created = [];

  const run = db.transaction(() => {
    for (const rule of rules) {
      let due = rule.next_due_date;
      let guard = 0;
      while (due <= today && guard < 400) {
        const info = insert.run({
          workspace_id: workspaceId,
          type: rule.type,
          title: rule.title,
          category: rule.category,
          amount_minor: rule.amount_minor,
          transaction_date: due,
          notes: rule.notes ? `${rule.notes} (auto-generated from recurring rule)` : 'Auto-generated from recurring rule',
          recurring_rule_id: rule.id,
        });
        if (info.changes > 0) created.push({ ruleId: rule.id, title: rule.title, date: due, amount: toRupees(rule.amount_minor) });
        due = advance(due, rule.frequency);
        guard += 1;
      }
      if (due !== rule.next_due_date) bumpNext.run(due, rule.id);
    }
  });
  run();

  return { createdCount: created.length, created, rules: listRules(workspaceId) };
}

module.exports = { listRules, getRule, createRule, updateRule, deleteRule, upcoming, runDue, advance };
