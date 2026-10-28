/**
 * src/repositories/goals.js
 * ---------------------------------------------------------------------------
 * Savings goals ("New laptop ₹40,000").
 *
 * Progress is NOT stored as a number that could drift: it is the SUM of the
 * contributions table. Adding money inserts a contribution row; withdrawing
 * inserts a negative one. Both run in a database transaction.
 * ---------------------------------------------------------------------------
 */

const { db } = require('../../database');
const { notFound, conflict } = require('../validation');
const { toRupees } = require('../money');

const GOAL_SELECT = `
  SELECT g.*,
         IFNULL((SELECT SUM(amount_minor) FROM savings_goal_contributions c WHERE c.goal_id = g.id), 0) AS saved_minor,
         (SELECT COUNT(*) FROM savings_goal_contributions c WHERE c.goal_id = g.id) AS contribution_count
    FROM savings_goals g
`;

function decorate(row) {
  if (!row) return row;
  const target = row.target_minor;
  const saved = row.saved_minor;
  const percent = target > 0 ? Math.round((saved / target) * 10000) / 100 : 0;
  return {
    ...row,
    is_archived: Boolean(row.is_archived),
    target: toRupees(target),
    saved: toRupees(saved),
    remaining: toRupees(Math.max(target - saved, 0)),
    percent: Math.min(percent, 100),
    rawPercent: percent,
    isComplete: saved >= target,
  };
}

function listGoals(workspaceId, { includeArchived = false } = {}) {
  return db
    .prepare(
      `${GOAL_SELECT} WHERE g.workspace_id = ? AND (@archived = 1 OR g.is_archived = 0)
       ORDER BY g.is_archived ASC, g.created_at DESC`
    )
    .all(workspaceId, { archived: includeArchived ? 1 : 0 })
    .map(decorate);
}

function getGoal(id, workspaceId) {
  const row = db.prepare(`${GOAL_SELECT} WHERE g.id = ? AND g.workspace_id = ?`).get(id, workspaceId);
  if (!row) throw notFound('Savings goal not found.');
  return {
    ...decorate(row),
    contributions: db
      .prepare('SELECT * FROM savings_goal_contributions WHERE goal_id = ? ORDER BY contributed_on DESC, id DESC')
      .all(id)
      .map((c) => ({ ...c, amount: toRupees(c.amount_minor) })),
  };
}

function createGoal(data, workspaceId) {
  const info = db
    .prepare(
      `INSERT INTO savings_goals (workspace_id, name, target_minor, target_date, notes)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(workspaceId, data.name, data.target_minor, data.target_date ?? null, data.notes ?? null);
  return getGoal(info.lastInsertRowid, workspaceId);
}

function updateGoal(id, data, workspaceId) {
  getGoal(id, workspaceId);
  db.prepare(
    `UPDATE savings_goals
        SET name = @name, target_minor = @target_minor, target_date = @target_date,
            notes = @notes, updated_at = datetime('now')
      WHERE id = @id AND workspace_id = @workspace_id`
  ).run({
    id,
    workspace_id: workspaceId,
    name: data.name,
    target_minor: data.target_minor,
    target_date: data.target_date ?? null,
    notes: data.notes ?? null,
  });
  return getGoal(id, workspaceId);
}

function deleteGoal(id, workspaceId) {
  const goal = getGoal(id, workspaceId);
  db.prepare('DELETE FROM savings_goals WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  return goal;
}

/**
 * Adds (or withdraws, with a negative amount) money against a goal.
 * A withdrawal can never push the balance below zero.
 */
function addContribution(id, data, workspaceId) {
  const goal = getGoal(id, workspaceId);
  if (goal.is_archived) throw conflict('This goal is archived. Restore it before adding money.');
  if (data.amount_minor < 0 && goal.saved_minor + data.amount_minor < 0) {
    throw conflict(`You cannot withdraw more than the ${toRupees(goal.saved_minor)} saved in this goal.`, {
      amount: `Maximum withdrawal is ${toRupees(goal.saved_minor)}.`,
    });
  }

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO savings_goal_contributions (goal_id, amount_minor, contributed_on, notes)
       VALUES (?, ?, ?, ?)`
    ).run(id, data.amount_minor, data.contributed_on, data.notes ?? null);
    db.prepare(`UPDATE savings_goals SET updated_at = datetime('now') WHERE id = ?`).run(id);
  });
  run();

  return getGoal(id, workspaceId);
}

function setArchived(id, workspaceId, archived) {
  getGoal(id, workspaceId);
  db.prepare(`UPDATE savings_goals SET is_archived = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
    .run(archived ? 1 : 0, id, workspaceId);
  return getGoal(id, workspaceId);
}

module.exports = { listGoals, getGoal, createGoal, updateGoal, deleteGoal, addContribution, setArchived };
