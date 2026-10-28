/**
 * public/js/sync.js
 * ---------------------------------------------------------------------------
 * Copies the data you enter in SmartSpend into your Supabase tables.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The working copy of the books is still the local SQLite file (that is what
 * keeps the app usable offline, in local mode, and keeps all 240 backend tests
 * meaningful). Supabase is the **account + cloud** side. Until this file, only
 * the profile row was written there, so filling in a transaction form showed
 * nothing in the Supabase table editor. Now every write schedules a sync that
 * mirrors your books into the Postgres tables from `supabase/schema.sql`.
 *
 * HOW IT WORKS (snapshot mirror, in this order)
 * --------------------------------------------
 *   1. Read everything from the local API (the same endpoints the screens use).
 *   2. Work out which Supabase book (workspaces row) belongs to each local book.
 *   3. DELETE only *your* rows from Supabase (RLS scopes the delete; the filter
 *      is explicit so it can never touch another account).
 *   4. INSERT them again in foreign-key order, parents first, remembering which
 *      Supabase uuid belongs to which local integer id (`local_id`).
 *   5. Store the result so Settings → "Cloud copy" can show the truth.
 *
 * WHY DELETE + INSERT INSTEAD OF A CLEVER DIFF
 * -------------------------------------------
 * The local book is the source of truth and it is tiny (a few hundred rows).
 * A wipe-and-rewrite is impossible to get half-right: no stale rows, no
 * duplicated invoices, and a failed run simply leaves the previous copy in
 * place because PostgREST works per request. It is also easy to explain in a
 * viva: "the cloud is a copy; the copy is replaced".
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 *   • No two-way sync. Editing rows in the Supabase table editor will NOT send
 *     them back to SQLite; the next push overwrites them. (Said plainly in the
 *     Settings card and in docs/SCHEMA.md §6.)
 *   • No background timer. A push is scheduled after a write and on page load.
 *   • Nothing happens in local mode or when signed out.
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  const supa = window.SmartSpendSupabase;
  const store =
    window.SmartSpendStore || { get: () => null, set: () => {}, remove: () => {}, isPersistent: () => false };

  const STATE_KEY = 'smartspend:sync-state';
  const DEBOUNCE_MS = 2500;

  /* =====================================================================
     1. READING THE LOCAL BOOKS
     ===================================================================== */

  /** GET helper: returns parsed JSON, throws on a failed request. */
  async function api(path, workspaceId = null) {
    const headers = {};
    if (workspaceId) headers['X-Workspace-Id'] = String(workspaceId);
    const response = await fetch(path, { headers });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error((payload && payload.error && payload.error.message) || `Request failed (${response.status})`);
    }
    return payload;
  }

  /** Reads every transaction of one book, following the pagination. */
  async function allTransactions(workspaceId) {
    const rows = [];
    const limit = 200;
    let offset = 0;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await api(`/api/transactions?limit=${limit}&offset=${offset}`, workspaceId);
      rows.push(...(page.data || []));
      const total = page.pagination ? page.pagination.total : rows.length;
      offset += limit;
      if (rows.length >= total || (page.data || []).length === 0) break;
    }
    return rows;
  }

  /**
   * Collects everything the app knows, in the shape the sync needs.
   * Any endpoint that fails simply yields an empty list — a half-broken screen
   * must not block the sync of everything else.
   */
  async function readLocal() {
    const snapshot = {
      workspaces: [],
      transactions: [],
      budgets: [],
      categoryBudgets: [],
      goals: [],
      contributions: [],
      rules: [],
      customers: [],
      vendors: [],
      invoices: [],
      invoiceItems: [],
      invoicePayments: [],
      bills: [],
      billPayments: [],
    };

    const ws = await api('/api/workspaces');
    snapshot.workspaces = ws.data || [];

    for (const workspace of snapshot.workspaces) {
      const id = workspace.id;
      try {
        snapshot.transactions.push(...(await allTransactions(id)));
      } catch { /* ignore one broken book */ }
      try {
        const budgets = await api('/api/budgets?limit=500', id);
        snapshot.budgets.push(...(budgets.data || []).filter((b) => b.isSet !== false));
      } catch { /* ignore */ }
      try {
        const cats = await api('/api/category-budgets?limit=500', id);
        snapshot.categoryBudgets.push(...(cats.data || []));
      } catch { /* ignore */ }
      try {
        const goals = await api('/api/savings-goals?include_archived=true', id);
        for (const goal of goals.data || []) {
          goal.workspace_id = goal.workspace_id || id;
          snapshot.goals.push(goal);
          try {
            const detail = await api(`/api/savings-goals/${goal.id}`, id);
            snapshot.contributions.push(...((detail.data && detail.data.contributions) || []));
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      try {
        const rules = await api('/api/recurring', id);
        snapshot.rules.push(...(rules.data || []).map((r) => ({ ...r, workspace_id: r.workspace_id || id })));
      } catch { /* ignore */ }
    }

    // Business records (customers, vendors, invoices, bills) live in the
    // business book and are served by /api/business/*.
    try {
      const customers = await api('/api/business/customers?include_archived=true');
      snapshot.customers = customers.data || [];
    } catch { /* ignore */ }
    try {
      const vendors = await api('/api/business/vendors?include_archived=true');
      snapshot.vendors = vendors.data || [];
    } catch { /* ignore */ }

    try {
      const invoices = await api('/api/business/invoices?status=all&limit=500');
      const rows = (invoices.data && invoices.data.rows) || [];
      for (const invoice of rows) {
        snapshot.invoices.push(invoice);
        try {
          const detail = await api(`/api/business/invoices/${invoice.id}`);
          const data = detail.data || {};
          snapshot.invoiceItems.push(...(data.items || []).map((item) => ({ ...item, invoice_local_id: invoice.id })));
          snapshot.invoicePayments.push(...(data.payments || []).map((p) => ({ ...p, invoice_local_id: invoice.id })));
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    try {
      const bills = await api('/api/business/bills?status=all&limit=500');
      const rows = (bills.data && bills.data.rows) || [];
      for (const bill of rows) {
        snapshot.bills.push(bill);
        try {
          const detail = await api(`/api/business/bills/${bill.id}`);
          const data = detail.data || {};
          snapshot.billPayments.push(...(data.payments || []).map((p) => ({ ...p, bill_local_id: bill.id })));
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    return snapshot;
  }

  /* =====================================================================
     2. ROW BUILDERS — local row → Supabase row
     ---------------------------------------------------------------------
     Only real columns are sent. Totals are NOT sent: the database triggers
     recompute `subtotal/tax/total` from the invoice lines, so a copy can never
     disagree with the rules in docs/SCHEMA.md.
     ===================================================================== */

  const blankToNull = (value) => (value === '' || value === undefined ? null : value);

  const builders = {
    customers: (c, ctx) => ({
      local_id: c.id,
      workspace_id: ctx.ws(c.workspace_id),
      name: c.name,
      contact_person: blankToNull(c.contact_person),
      email: blankToNull(c.email),
      phone: blankToNull(c.phone),
      address: blankToNull(c.address),
      notes: blankToNull(c.notes),
      is_archived: Boolean(c.is_archived),
    }),

    vendors: (v, ctx) => ({
      local_id: v.id,
      workspace_id: ctx.ws(v.workspace_id),
      name: v.name,
      contact_person: blankToNull(v.contact_person),
      email: blankToNull(v.email),
      phone: blankToNull(v.phone),
      address: blankToNull(v.address),
      notes: blankToNull(v.notes),
      is_archived: Boolean(v.is_archived),
    }),

    recurring_rules: (r, ctx) => ({
      local_id: r.id,
      workspace_id: ctx.ws(r.workspace_id),
      title: r.title,
      type: r.type || 'expense',
      category: r.category,
      amount_minor: r.amount_minor,
      frequency: r.frequency,
      start_date: r.start_date,
      next_due_date: r.next_due_date,
      notes: blankToNull(r.notes),
      is_active: r.is_active === undefined ? true : Boolean(r.is_active),
    }),

    savings_goals: (g, ctx) => ({
      local_id: g.id,
      workspace_id: ctx.ws(g.workspace_id),
      name: g.name,
      target_minor: g.target_minor,
      target_date: blankToNull(g.target_date),
      notes: blankToNull(g.notes),
      is_archived: Boolean(g.is_archived),
    }),

    invoices: (i, ctx) => ({
      local_id: i.id,
      workspace_id: ctx.ws(i.workspace_id),
      invoice_number: i.invoice_number,
      customer_id: ctx.customer(i.customer_id),
      invoice_date: i.invoice_date,
      due_date: i.due_date,
      is_draft: Boolean(i.is_draft),
      is_cancelled: Boolean(i.is_cancelled),
      notes: blankToNull(i.notes),
    }),

    invoice_items: (item, ctx) => ({
      local_id: item.id,
      invoice_id: ctx.invoice(item.invoice_local_id),
      description: item.description,
      quantity: item.quantity,
      unit_price_minor: item.unit_price_minor,
      tax_rate: item.tax_rate || 0,
      position: item.position || 0,
    }),

    invoice_payments: (p, ctx) => ({
      local_id: p.id,
      invoice_id: ctx.invoice(p.invoice_local_id),
      amount_minor: p.amount_minor,
      paid_on: p.paid_on,
      method: p.method || 'cash',
      reference: p.reference || '', // NOT NULL in Postgres: duplicates are blocked by a unique key
      notes: blankToNull(p.notes),
    }),

    transactions: (t, ctx) => ({
      local_id: t.id,
      workspace_id: ctx.ws(t.workspace_id),
      type: t.type,
      title: t.title,
      category: t.category,
      amount_minor: t.amount_minor,
      transaction_date: t.transaction_date,
      notes: blankToNull(t.notes),
      payment_method: blankToNull(t.payment_method),
      customer_id: ctx.customer(t.customer_id),
      vendor_id: ctx.vendor(t.vendor_id),
      invoice_id: ctx.invoice(t.invoice_id),
      tax_rate: t.tax_rate || 0,
      tax_minor: t.tax_minor || 0,
      recurring_rule_id: ctx.rule(t.recurring_rule_id),
    }),

    vendor_bills: (b, ctx) => ({
      local_id: b.id,
      workspace_id: ctx.ws(b.workspace_id),
      vendor_id: ctx.vendor(b.vendor_id),
      bill_number: b.bill_number,
      bill_date: b.bill_date,
      due_date: b.due_date,
      description: blankToNull(b.description),
      notes: blankToNull(b.notes),
      amount_minor: b.amount_minor,
      tax_rate: b.tax_rate || 0,
      tax_minor: b.tax_minor || 0,
      is_cancelled: Boolean(b.is_cancelled),
    }),

    vendor_bill_payments: (p, ctx) => ({
      local_id: p.id,
      vendor_bill_id: ctx.bill(p.bill_local_id),
      amount_minor: p.amount_minor,
      paid_on: p.paid_on,
      method: p.method || 'cash',
      reference: p.reference || '',
      notes: blankToNull(p.notes),
    }),

    budgets: (b, ctx) => ({
      // the budgets endpoint has no local id — (workspace, month) is the key
      local_id: null,
      workspace_id: ctx.ws(b.workspace_id),
      month: b.month,
      amount_minor: b.amount_minor,
    }),

    category_budgets: (b, ctx) => ({
      local_id: b.id === undefined ? null : b.id,
      workspace_id: ctx.ws(b.workspace_id),
      month: b.month,
      category: b.category,
      amount_minor: b.amount_minor,
    }),

    savings_goal_contributions: (c, ctx) => ({
      local_id: c.id,
      goal_id: ctx.goal(c.goal_id === undefined ? c.savings_goal_id : c.goal_id),
      amount_minor: c.amount_minor,
      contributed_on: c.contributed_on,
      notes: blankToNull(c.notes),
    }),
  };

  /* =====================================================================
     3. WRITING TO SUPABASE
     ===================================================================== */

  // Foreign-key order. Parents first on the way in, children first on the way out.
  const INSERT_ORDER = [
    'customers',
    'vendors',
    'recurring_rules',
    'savings_goals',
    'invoices',
    'invoice_items',
    'invoice_payments',
    'transactions',
    'vendor_bills',
    'vendor_bill_payments',
    'budgets',
    'category_budgets',
    'savings_goal_contributions',
  ];
  const DELETE_ORDER = [
    'vendor_bill_payments',
    'invoice_payments',
    'invoice_items',
    'vendor_bills',
    'invoices',
    'transactions',
    'savings_goal_contributions',
    'savings_goals',
    'category_budgets',
    'budgets',
    'recurring_rules',
    'customers',
    'vendors',
  ];

  // These two are inserted one request at a time: the over-payment trigger reads
  // the payments already recorded, and rows inserted by the *same* statement are
  // not visible to that check.
  const ONE_BY_ONE = new Set(['invoice_payments', 'vendor_bill_payments']);

  /** Makes sure the signed-in user really has the two books in Supabase. */
  async function onlineWorkspaces(userId) {
    let result = await supa.restSelect('workspaces', { select: 'id,type', eq: { user_id: userId }, order: 'type' });
    if (!result.ok) return { error: explainRest(result) };

    if (!result.data || result.data.length === 0) {
      // Signed up before schema.sql was run (so the signup trigger never fired):
      // create the two books now instead of failing.
      await supa.restInsert('workspaces', [
        { name: 'Personal', type: 'individual' },
        { name: 'My Business', type: 'business' },
      ]);
      result = await supa.restSelect('workspaces', { select: 'id,type', eq: { user_id: userId } });
      if (!result.ok) return { error: explainRest(result) };
    }

    const map = {};
    for (const row of result.data || []) map[row.type] = row.id;
    if (!map.individual || !map.business) return { error: 'Supabase is missing one of the two books (workspaces).' };
    return { map };
  }

  function explainRest(result) {
    const data = result.data || {};
    const code = data.code || '';
    if (code === 'PGRST205' || /schema cache/i.test(data.message || '')) {
      return 'The Supabase tables do not exist yet — run supabase/schema.sql in the SQL editor.';
    }
    if (data.message) return data.message;
    return `Supabase answered ${result.status}.`;
  }

  /* =====================================================================
     4. THE PUSH
     ===================================================================== */

  let running = false;
  let timer = null;

  function saveState(patch) {
    const next = { ...(store.getJSON(STATE_KEY) || {}), ...patch, at: new Date().toISOString() };
    store.setJSON(STATE_KEY, next);
    window.dispatchEvent(new CustomEvent('smartspend:sync', { detail: next }));
    return next;
  }

  function status() {
    return store.getJSON(STATE_KEY) || null;
  }

  /**
   * Copies everything to Supabase.
   * Returns { ok, reason?, counts?, error? }.
   */
  async function push({ silent = false } = {}) {
    if (running) return { ok: false, reason: 'busy' };
    if (!supa) return { ok: false, reason: 'no-client' };

    const session = await supa.getSession().catch(() => null);
    if (!session || !session.user) {
      if (!silent) saveState({ ok: false, reason: 'signed-out' });
      return { ok: false, reason: 'signed-out' };
    }
    if (supa.isLocalMode && supa.isLocalMode()) {
      if (!silent) saveState({ ok: false, reason: 'local-mode' });
      return { ok: false, reason: 'local-mode' };
    }

    running = true;
    saveState({ ok: null, reason: 'syncing' });

    try {
      const spaces = await onlineWorkspaces(session.user.id);
      if (spaces.error) {
        saveState({ ok: false, reason: 'error', error: spaces.error });
        return { ok: false, reason: 'error', error: spaces.error };
      }

      const snapshot = await readLocal();

      // Local book id -> Supabase book id, by type, not by number.
      const localWorkspaceType = new Map((snapshot.workspaces || []).map((w) => [w.id, w.type]));
      const idMaps = {
        customer: new Map(),
        vendor: new Map(),
        invoice: new Map(),
        bill: new Map(),
        rule: new Map(),
        goal: new Map(),
      };

      // Invoices come before transactions, so customer ids are already mapped.
      for (const table of DELETE_ORDER) {
        const result = await supa.restDelete(table, { user_id: session.user.id });
        if (!result.ok) {
          const error = explainRest(result);
          saveState({ ok: false, reason: 'error', error: `Could not clear ${table}: ${error}` });
          return { ok: false, reason: 'error', error };
        }
      }

      const ctx = {
        ws: (localId) => {
          const type = localWorkspaceType.get(localId);
          return spaces.map[type] || spaces.map.individual;
        },
        customer: (localId) => (localId ? idMaps.customer.get(localId) || null : null),
        vendor: (localId) => (localId ? idMaps.vendor.get(localId) || null : null),
        invoice: (localId) => (localId ? idMaps.invoice.get(localId) || null : null),
        bill: (localId) => (localId ? idMaps.bill.get(localId) || null : null),
        rule: (localId) => (localId ? idMaps.rule.get(localId) || null : null),
        goal: (localId) => (localId ? idMaps.goal.get(localId) || null : null),
      };

      const source = {
        customers: snapshot.customers,
        vendors: snapshot.vendors,
        recurring_rules: snapshot.rules,
        savings_goals: snapshot.goals,
        invoices: snapshot.invoices,
        invoice_items: snapshot.invoiceItems,
        invoice_payments: snapshot.invoicePayments,
        transactions: snapshot.transactions,
        vendor_bills: snapshot.bills,
        vendor_bill_payments: snapshot.billPayments,
        budgets: snapshot.budgets,
        category_budgets: snapshot.categoryBudgets,
        savings_goal_contributions: snapshot.contributions,
      };

      const counts = {};

      for (const table of INSERT_ORDER) {
        const rows = (source[table] || [])
          .map((row) => builders[table](row, ctx))
          .filter((row) => {
            // A child row whose parent could not be mapped would fail the whole
            // batch; skip it and say so in the counts instead.
            if (table === 'invoice_items' || table === 'invoice_payments') return Boolean(row.invoice_id);
            if (table === 'vendor_bill_payments') return Boolean(row.vendor_bill_id);
            if (table === 'savings_goal_contributions') return Boolean(row.goal_id);
            if (table === 'transactions') return Boolean(row.workspace_id);
            return Boolean(row.workspace_id || table === 'invoice_items');
          });

        if (rows.length === 0) {
          counts[table] = 0;
          continue;
        }

        if (ONE_BY_ONE.has(table)) {
          let done = 0;
          for (const row of rows) {
            const result = await supa.restInsert(table, row);
            if (!result.ok) {
              const error = explainRest(result);
              saveState({ ok: false, reason: 'error', error: `${table}: ${error}`, counts });
              return { ok: false, reason: 'error', error: `${table}: ${error}`, counts };
            }
            done += 1;
          }
          counts[table] = done;
          continue;
        }

        const result = await supa.restInsert(table, rows);
        if (!result.ok) {
          const error = explainRest(result);
          saveState({ ok: false, reason: 'error', error: `${table}: ${error}`, counts });
          return { ok: false, reason: 'error', error: `${table}: ${error}`, counts };
        }
        counts[table] = rows.length;

        // Remember local id -> Supabase uuid for the tables other rows point at.
        for (const inserted of result.data || []) {
          if (inserted.local_id === null || inserted.local_id === undefined) continue;
          if (table === 'customers') idMaps.customer.set(inserted.local_id, inserted.id);
          if (table === 'vendors') idMaps.vendor.set(inserted.local_id, inserted.id);
          if (table === 'recurring_rules') idMaps.rule.set(inserted.local_id, inserted.id);
          if (table === 'savings_goals') idMaps.goal.set(inserted.local_id, inserted.id);
          if (table === 'invoices') idMaps.invoice.set(inserted.local_id, inserted.id);
          if (table === 'vendor_bills') idMaps.bill.set(inserted.local_id, inserted.id);
        }
      }

      saveState({ ok: true, reason: 'done', counts, error: null });
      return { ok: true, counts };
    } catch (error) {
      saveState({ ok: false, reason: 'error', error: error.message });
      return { ok: false, reason: 'error', error: error.message };
    } finally {
      running = false;
    }
  }

  /* =====================================================================
     5. WHEN TO PUSH
     ===================================================================== */

  /** Called by app.js after every successful create / update / delete. */
  function schedulePush() {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      push();
    }, DEBOUNCE_MS);
  }

  /** Page load: publish whatever is already in the local books. */
  function autoPushOnLoad() {
    if (!supa) return;
    const session = store.getJSON('smartspend:supabase-session');
    if (!session) return;
    if (supa.isLocalMode && supa.isLocalMode()) return;
    window.setTimeout(() => push({ silent: true }), 1200);
  }

  /* =====================================================================
     6. THE SETTINGS CARD
     ===================================================================== */

  const TABLE_LABELS = {
    transactions: 'transactions',
    budgets: 'budgets',
    category_budgets: 'category budgets',
    savings_goals: 'goals',
    savings_goal_contributions: 'goal contributions',
    recurring_rules: 'recurring rules',
    customers: 'customers',
    vendors: 'vendors',
    invoices: 'invoices',
    invoice_items: 'invoice lines',
    invoice_payments: 'invoice payments',
    vendor_bills: 'bills',
    vendor_bill_payments: 'bill payments',
  };

  function describe(rows) {
    return Object.entries(TABLE_LABELS)
      .filter(([key]) => rows[key] > 0)
      .map(([key, label]) => `${rows[key]} ${label}`)
      .join(' · ') || 'nothing yet';
  }

  function whenText(iso) {
    if (!iso) return 'never';
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds} seconds ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
    return new Date(iso).toLocaleString();
  }

  function paintCard() {
    const statusNode = document.getElementById('syncStatus');
    if (!statusNode) return;

    const state = status() || {};
    const total = state.counts ? Object.values(state.counts).reduce((a, b) => a + b, 0) : null;

    const set = (id, text) => {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    };

    if (running || state.reason === 'syncing') {
      statusNode.textContent = 'copying…';
      statusNode.dataset.state = 'warn';
    } else if (state.ok === true) {
      statusNode.textContent = 'copied';
      statusNode.dataset.state = 'ok';
    } else if (state.reason === 'signed-out') {
      statusNode.textContent = 'sign in to copy';
      statusNode.dataset.state = 'idle';
    } else if (state.reason === 'local-mode') {
      statusNode.textContent = 'local mode — no copy';
      statusNode.dataset.state = 'idle';
    } else if (state.ok === false) {
      statusNode.textContent = 'failed';
      statusNode.dataset.state = 'danger';
    } else {
      statusNode.textContent = 'not copied yet';
      statusNode.dataset.state = 'idle';
    }

    set('syncLastRun', state.at ? whenText(state.at) : 'never');
    set('syncRowCount', total === null ? '—' : `${total} rows`);
    if (state.counts) set('syncTables', describe(state.counts));

    const hint = document.getElementById('syncHint');
    if (hint) {
      if (state.error) {
        hint.textContent = `Last copy failed: ${state.error}`;
        hint.dataset.tone = 'error';
      } else if (state.reason === 'signed-out') {
        hint.textContent = 'You are in local mode or signed out, so nothing can be copied. Sign in to publish your books to Supabase.';
        hint.dataset.tone = 'warn';
      } else if (state.reason === 'local-mode') {
        hint.textContent = 'Local mode never sends anything anywhere — that is the point of it. Sign in to copy the books to Supabase.';
        hint.dataset.tone = 'warn';
      } else if (state.ok === true) {
        hint.textContent = 'Copied. Open the Supabase table editor to see the rows (each one keeps its local id in the local_id column).';
        hint.dataset.tone = 'ok';
      } else {
        hint.textContent =
          'A copy is sent a couple of seconds after you add or change something, and once when the app loads. It needs a signed-in account and supabase/schema.sql to have been run.';
        hint.dataset.tone = 'idle';
      }
    }
  }

  function wireCard() {
    const button = document.getElementById('syncNowBtn');
    if (button && !button.dataset.wired) {
      button.dataset.wired = '1';
      button.addEventListener('click', async () => {
        button.disabled = true;
        const idle = button.textContent;
        button.textContent = 'Copying…';
        await push();
        button.disabled = false;
        button.textContent = idle;
      });
    }
    paintCard();
  }

  window.addEventListener('smartspend:sync', paintCard);

  /** Called by the Settings renderer (js/personal-extras.js) — same pattern as cloud.js. */
  function refresh() {
    wireCard();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('syncCard')) wireCard();
  });

  window.SmartSpendSync = {
    push,
    refresh,
    paint: paintCard,
    schedulePush,
    status,
    autoPushOnLoad,
    readLocal,
    isRunning: () => running,
  };
})();
