/**
 * src/repositories/workspaces.js
 * ---------------------------------------------------------------------------
 * Workspaces = one finance book per mode.
 *   workspace 1 -> Personal   (individual mode)
 *   workspace 2 -> My Business (business mode)
 *
 * The mode switcher in the UI simply changes which workspace the API is asked
 * about. Because every table carries `workspace_id`, personal and business data
 * can never appear in the same report.
 *
 * IMPORTANT (honesty): there is no authentication. Anyone using the app can
 * read any workspace, so this is a LOCAL DEMONSTRATION of separation of
 * concerns, not secure multi-tenant isolation. See README "Known limitations".
 * ---------------------------------------------------------------------------
 */

const { db } = require('../../database');
const { notFound, parseText, ApiError } = require('../validation');

const listStmt = db.prepare(`
  SELECT w.*,
         (SELECT COUNT(*) FROM transactions t WHERE t.workspace_id = w.id) AS transaction_count,
         (SELECT COUNT(*) FROM invoices i WHERE i.workspace_id = w.id)     AS invoice_count,
         (SELECT COUNT(*) FROM customers c WHERE c.workspace_id = w.id)    AS customer_count,
         (SELECT COUNT(*) FROM vendors v WHERE v.workspace_id = w.id)      AS vendor_count
    FROM workspaces w
   ORDER BY w.type DESC, w.id
`);

const byIdStmt = db.prepare('SELECT * FROM workspaces WHERE id = ?');

function listWorkspaces() {
  return listStmt.all();
}

function getWorkspace(id) {
  const row = byIdStmt.get(id);
  if (!row) throw notFound('Workspace not found.');
  return row;
}

/** The default workspace for a mode. Used when the client sends no workspaceId. */
function defaultWorkspaceFor(type) {
  const row = db
    .prepare('SELECT * FROM workspaces WHERE type = ? ORDER BY id LIMIT 1')
    .get(type === 'business' ? 'business' : 'individual');
  if (!row) throw notFound(`No ${type} workspace exists.`);
  return row;
}

/**
 * Resolves the workspace for a request.
 * Order: body.workspaceId -> query.workspaceId -> X-Workspace-Id header -> default (individual).
 * The id must exist, otherwise we fail loudly instead of silently using data
 * from the wrong book.
 */
function resolveWorkspace(req, { type = null } = {}) {
  const raw =
    (req.body && req.body.workspaceId) ??
    (req.query && req.query.workspaceId) ??
    req.get('X-Workspace-Id');

  if (raw === undefined || raw === null || raw === '') {
    const fallback = defaultWorkspaceFor(type || 'individual');
    if (type && fallback.type !== type) throw notFound(`No ${type} workspace exists.`);
    return fallback;
  }

  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, 'Invalid workspaceId. It must be a positive whole number.');
  }
  const workspace = getWorkspace(id);
  if (type && workspace.type !== type) {
    throw new ApiError(400, `Workspace ${id} is a ${workspace.type} workspace, but this feature needs a ${type} workspace.`);
  }
  return workspace;
}

function renameWorkspace(id, { name, notes }) {
  getWorkspace(id);
  const cleanName = parseText(name, 'Workspace name', { max: 80, required: true });
  const cleanNotes = parseText(notes, 'Notes', { max: 500 });
  db.prepare(`UPDATE workspaces SET name = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(cleanName, cleanNotes, id);
  return getWorkspace(id);
}

module.exports = { listWorkspaces, getWorkspace, defaultWorkspaceFor, resolveWorkspace, renameWorkspace };
