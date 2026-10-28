/**
 * scripts/seed-business-demo.js
 * ---------------------------------------------------------------------------
 * Creates a small, clearly-labelled demo set of BUSINESS records so the
 * Business mode can be explored without inventing your own data.
 *
 *   npm run seed:business            # add demo records (skips if already there)
 *   npm run seed:business -- --force # wipe ONLY the demo records, then re-add
 *
 * SAFETY
 *   - It only ever writes to the BUSINESS workspace (type = 'business').
 *     Your personal transactions, budgets and goals are never read or changed.
 *   - Every record it creates is prefixed with "[DEMO]" or a DEMO- number, so
 *     demo rows are obvious in the UI and in CSV exports.
 *   - It refuses to run twice unless asked, so it cannot pile up duplicates.
 *
 * The numbers are internally consistent on purpose, which makes the reports
 * easy to check by hand:
 *   Revenue ₹32,500 · Expenses ₹6,000 · Net profit ₹26,500
 *   Invoice DEMO-0001 2×₹5,000 + 18% tax + 1×₹2,000 = ₹13,800, ₹5,000 paid
 *     → balance ₹8,800, status "partially paid"
 *   Invoice DEMO-0002 ₹8,000 + 18% tax = ₹9,440, due in the past → "overdue"
 *   Bill DEMO-BILL-77 ₹4,000 + 5% tax = ₹4,200, ₹1,000 paid → balance ₹3,200
 */

'use strict';

const { db } = require('../database');
const { defaultWorkspaceFor } = require('../src/repositories/workspaces');
const invoices = require('../src/repositories/invoices');
const vendorBills = require('../src/repositories/vendorBills');
const { toMinor } = require('../src/money');

const FORCE = process.argv.includes('--force');

/** Finds the business workspace without needing an HTTP request. */
function businessWorkspace() {
  return defaultWorkspaceFor('business');
}

const today = new Date();
const iso = (date) => date.toISOString().slice(0, 10);
const daysFromNow = (days) => {
  const date = new Date(today.getTime() + days * 86400000);
  return iso(date);
};

function countExistingDemo(workspaceId) {
  const tx = db
    .prepare("SELECT COUNT(*) c FROM transactions WHERE workspace_id = ? AND title LIKE '[DEMO]%'")
    .get(workspaceId).c;
  const inv = db
    .prepare("SELECT COUNT(*) c FROM invoices WHERE workspace_id = ? AND invoice_number LIKE 'DEMO-%'")
    .get(workspaceId).c;
  const bill = db
    .prepare("SELECT COUNT(*) c FROM vendor_bills WHERE workspace_id = ? AND bill_number LIKE 'DEMO-%'")
    .get(workspaceId).c;
  const customer = db
    .prepare("SELECT COUNT(*) c FROM customers WHERE workspace_id = ? AND name LIKE '[DEMO]%'")
    .get(workspaceId).c;
  const vendor = db
    .prepare("SELECT COUNT(*) c FROM vendors WHERE workspace_id = ? AND name LIKE '[DEMO]%'")
    .get(workspaceId).c;
  return { tx, inv, bill, customer, vendor, total: tx + inv + bill + customer + vendor };
}

function removeDemo(workspaceId) {
  // Documents first (children cascade), then parties, then plain transactions.
  const invoiceIds = db
    .prepare("SELECT id FROM invoices WHERE workspace_id = ? AND invoice_number LIKE 'DEMO-%'")
    .all(workspaceId)
    .map((row) => row.id);
  for (const id of invoiceIds) {
    db.prepare('DELETE FROM invoice_payments WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  }

  const billIds = db
    .prepare("SELECT id FROM vendor_bills WHERE workspace_id = ? AND bill_number LIKE 'DEMO-%'")
    .all(workspaceId)
    .map((row) => row.id);
  for (const id of billIds) {
    db.prepare('DELETE FROM vendor_bill_payments WHERE vendor_bill_id = ?').run(id);
    db.prepare('DELETE FROM vendor_bills WHERE id = ?').run(id);
  }

  db.prepare("DELETE FROM transactions WHERE workspace_id = ? AND title LIKE '[DEMO]%'").run(workspaceId);
  db.prepare("DELETE FROM customers WHERE workspace_id = ? AND name LIKE '[DEMO]%'").run(workspaceId);
  db.prepare("DELETE FROM vendors WHERE workspace_id = ? AND name LIKE '[DEMO]%'").run(workspaceId);
}

function main() {
  const workspace = businessWorkspace();
  const existing = countExistingDemo(workspace.id);

  if (existing.total > 0 && !FORCE) {
    console.log(`\nBusiness demo data already exists (${existing.total} records).`);
    console.log('Nothing was changed. Re-run with:  npm run seed:business -- --force\n');
    return;
  }
  if (existing.total > 0 && FORCE) {
    removeDemo(workspace.id);
    console.log('Removed the previous demo records.');
  }

  const seed = db.transaction(() => {
    // ---- customers and vendors (prefixed so they are obvious) -------------
    const insertCustomer = db.prepare(`
      INSERT INTO customers (workspace_id, name, contact_person, email, phone, address, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const customerA = insertCustomer.run(
      workspace.id,
      '[DEMO] Sharma Traders',
      'Rekha Sharma',
      'rekha@demo-sharma.example',
      '98100 12345',
      'Karol Bagh, New Delhi',
      'Demo record created by npm run seed:business'
    ).lastInsertRowid;
    const customerB = insertCustomer.run(
      workspace.id,
      '[DEMO] Gupta & Sons',
      null,
      'accounts@demo-gupta.example',
      '98765 43210',
      null,
      'Demo record created by npm run seed:business'
    ).lastInsertRowid;

    const insertVendor = db.prepare(`
      INSERT INTO vendors (workspace_id, name, contact_person, email, phone, address, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const vendorA = insertVendor.run(
      workspace.id,
      '[DEMO] Delhi Paper Mart',
      'Imran',
      'sales@demo-paper.example',
      '99001 12233',
      'Chawri Bazar, Delhi',
      'Demo record created by npm run seed:business'
    ).lastInsertRowid;

    // ---- transactions ----------------------------------------------------
    const insertTx = db.prepare(`
      INSERT INTO transactions
        (workspace_id, type, title, amount_minor, category, transaction_date, notes, payment_method, tax_rate, customer_id, vendor_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows = [
      ['income', '[DEMO] Counter sales — week 1', 12500, 'Sales', daysFromNow(-25), 'upi', 0, null, null],
      ['income', '[DEMO] Wholesale order — Sharma Traders', 20000, 'Sales', daysFromNow(-16), 'bank_transfer', 0, customerA, null],
      ['expense', '[DEMO] Shop rent', 6000, 'Rent & Utilities', daysFromNow(-23), 'bank_transfer', 0, null, null],
    ];
    for (const [type, title, amount, category, date, method, taxRate, customerId, vendorId] of rows) {
      insertTx.run(workspace.id, type, title, toMinor(amount), category, date, 'Demo record', method, taxRate, customerId, vendorId);
    }

    return { customerA, customerB, vendorA };
  });

  const ids = seed();

  // ---- invoices (created through the real repository, so totals and status
  //      behave exactly as they do for a user) -----------------------------
  const invoiceA = invoices.createInvoice(
    {
      invoice_number: 'DEMO-0001',
      customer_id: Number(ids.customerA),
      invoice_date: daysFromNow(-18),
      due_date: daysFromNow(12),
      notes: 'Demo invoice. Totals are calculated by the server.',
      is_draft: 0,
      items: [
        { description: '[DEMO] A4 paper boxes', quantity: 2, unit_price_minor: toMinor(5000), tax_rate: 18 },
        { description: '[DEMO] Delivery charge', quantity: 1, unit_price_minor: toMinor(2000), tax_rate: 0 },
      ],
    },
    workspace.id
  );

  invoices.createInvoice(
    {
      invoice_number: 'DEMO-0002',
      customer_id: Number(ids.customerB),
      invoice_date: daysFromNow(-40),
      due_date: daysFromNow(-8), // in the past on purpose → overdue
      notes: 'Demo invoice that is overdue, so the dashboard has something to flag.',
      is_draft: 0,
      items: [{ description: '[DEMO] Monthly design retainer', quantity: 1, unit_price_minor: toMinor(8000), tax_rate: 18 }],
    },
    workspace.id
  );

  invoices.addPayment(
    invoiceA.id,
    { amount_minor: toMinor(5000), paid_on: daysFromNow(-10), method: 'upi', reference: 'DEMO-UPI-1' },
    workspace.id
  );

  // ---- vendor bill -------------------------------------------------------
  const bill = vendorBills.createBill(
    {
      vendor_id: Number(ids.vendorA),
      bill_number: 'DEMO-BILL-77',
      bill_date: daysFromNow(-20),
      due_date: daysFromNow(10),
      amount_minor: toMinor(4000),
      tax_rate: 5,
      description: '[DEMO] Paper stock',
      notes: 'Demo bill. 30-day credit.',
    },
    workspace.id
  );

  vendorBills.addPayment(bill.id, { amount_minor: toMinor(1000), paid_on: daysFromNow(-6), method: 'cash', reference: null }, workspace.id);

  const after = countExistingDemo(workspace.id);
  console.log(`\nBusiness demo data created in workspace ${workspace.id} ("${workspace.name}").`);
  console.log(`  ${after.customer} customers · ${after.vendor} vendors · ${after.tx} transactions · ${after.inv} invoices · ${after.bill} bills`);
  console.log('\nEverything created is prefixed with [DEMO] or DEMO-, and no personal records were touched.');
  console.log('Remove it again with:  npm run seed:business -- --force\n');
}

try {
  main();
} catch (error) {
  console.error('\nCould not create the business demo data:', error.message);
  process.exitCode = 1;
}
