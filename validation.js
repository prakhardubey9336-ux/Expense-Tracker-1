/**
 * src/validation.js
 * ---------------------------------------------------------------------------
 * One place for every "is this input allowed?" rule used by the API.
 *
 * The browser validates so the user gets instant feedback; the SERVER validates
 * again because that is the real gatekeeper. Anything that reaches a SQL
 * statement has already passed through this file.
 *
 * SmartSpend 2.0 adds: workspace-aware categories, integer-paise amounts,
 * customers/vendors, invoices (with line items), payments, vendor bills,
 * recurring rules and savings goals.
 * ---------------------------------------------------------------------------
 */

const { toMinor } = require('./money');

// ===========================================================================
// Allowed values (single source of truth, also exposed via /api/meta)
// ===========================================================================

const TRANSACTION_TYPES = ['income', 'expense'];

/**
 * Personal categories. The first eight are the ones asked for in the 2.0 brief;
 * the rest are kept so SmartSpend 1.0 records stay valid after the upgrade
 * (Travel / Bills / Health / Salary / Freelance were v1 categories).
 */
const PERSONAL_CATEGORIES = [
  'Food',
  'Transport',
  'Shopping',
  'Rent',
  'Education',
  'Healthcare',
  'Entertainment',
  'Other',
  // kept for backwards compatibility with v1 data
  'Bills',
  'Travel',
  'Health',
  'Salary',
  'Freelance',
];

const PERSONAL_INCOME_CATEGORIES = ['Salary', 'Freelance', 'Other'];

/** Business categories for expenses. */
const BUSINESS_EXPENSE_CATEGORIES = [
  'Purchases',
  'Rent & Utilities',
  'Salaries & Wages',
  'Marketing',
  'Software & Subscriptions',
  'Travel & Transportation',
  'Equipment & Maintenance',
  'Other Operating Expenses',
  'Other',
];

/** Business categories for income (sales etc.). */
const BUSINESS_INCOME_CATEGORIES = ['Sales', 'Other Income'];

const BUSINESS_CATEGORIES = [...new Set([...BUSINESS_INCOME_CATEGORIES, ...BUSINESS_EXPENSE_CATEGORIES])];

const PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'];

const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'];

/** Stored flags only. Computed statuses live in repositories/invoices.js. */
const INVOICE_STATUSES = ['draft', 'unpaid', 'partially_paid', 'paid', 'overdue', 'cancelled'];

const LIMITS = {
  titleMax: 100,
  notesMax: 500,
  amountMax: 1_000_000_000,
  budgetMax: 1_000_000_000,
  pageLimitMax: 500,
  nameMax: 120,
  addressMax: 300,
  descriptionMax: 200,
  invoiceNumberMax: 40,
  billNumberMax: 60,
  maxInvoiceItems: 50,
  maxQuantity: 100000,
};

/** Returns the category allow-list for a workspace type. */
function categoriesFor(workspaceType) {
  return workspaceType === 'business' ? BUSINESS_CATEGORIES : PERSONAL_CATEGORIES;
}

function incomeCategoriesFor(workspaceType) {
  return workspaceType === 'business' ? BUSINESS_INCOME_CATEGORIES : PERSONAL_INCOME_CATEGORIES;
}

// ===========================================================================
// Errors
// ===========================================================================

/** Error type the Express error handler turns into clean JSON (400/404/409). */
class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || null;
  }
}

const badRequest = (message, details) => new ApiError(400, message, details);
const notFound = (message = 'Resource not found.') => new ApiError(404, message);
const conflict = (message, details) => new ApiError(409, message, details);
const forbidden = (message = 'This record belongs to a different workspace.') => new ApiError(403, message);

// ===========================================================================
// Primitive checks
// ===========================================================================

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for real calendar dates in YYYY-MM-DD form (rejects 2025-02-31). */
function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1900 || y > 2200) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isValidMonthString(value) {
  return typeof value === 'string' && MONTH_RE.test(value);
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function roundMoney(n) {
  return Math.round(n * 100) / 100;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Validates a positive integer id (from a URL or a body field). */
function parseId(raw, label = 'transaction') {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest(`Invalid ${label} id. It must be a positive whole number.`);
  }
  return id;
}

/** Validates an optional positive integer id; returns null when empty. */
function parseOptionalId(raw, label = 'id') {
  if (raw === undefined || raw === null || raw === '') return null;
  return parseId(raw, label);
}

function parseMonth(raw, { required = true } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (!required) return null;
    throw badRequest('Month is required and must look like YYYY-MM (for example 2026-10).');
  }
  if (!isValidMonthString(raw)) {
    throw badRequest('Invalid month. Use the format YYYY-MM (for example 2026-10).');
  }
  return raw;
}

function parseDateField(raw, label, { required = true, fallback = null } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw badRequest(`${label} is required and must be a valid date in YYYY-MM-DD format.`);
    return fallback;
  }
  if (!isValidDateString(raw)) {
    throw badRequest(`${label} must be a valid calendar date in YYYY-MM-DD format.`);
  }
  return raw;
}

/** Trims a text field, enforces max length, returns null when empty. */
function parseText(raw, label, { max = 500, required = false } = {}) {
  if (raw === undefined || raw === null) {
    if (required) throw badRequest(`${label} is required.`);
    return null;
  }
  if (typeof raw !== 'string') {
    if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
    else throw badRequest(`${label} must be text.`);
  }
  const value = raw.trim();
  if (value.length === 0) {
    if (required) throw badRequest(`${label} is required.`);
    return null;
  }
  if (value.length > max) throw badRequest(`${label} cannot be longer than ${max} characters.`);
  return value;
}

/** ₹ string/number -> integer paise with range checks. */
function parseAmountMinor(raw, label, { allowZero = false, max = LIMITS.amountMax } = {}) {
  const n = toNumber(raw);
  if (n === null) throw badRequest(`${label} must be a number.`);
  const minor = toMinor(n);
  if (allowZero ? minor < 0 : minor <= 0) {
    throw badRequest(`${label} must be ${allowZero ? 'zero or greater' : 'greater than 0'}.`);
  }
  if (minor > Math.round(max * 100)) throw badRequest(`${label} is too large.`);
  return minor;
}

function parseEnum(raw, allowed, label) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (!allowed.includes(value)) {
    throw badRequest(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function parseEmail(raw, label = 'Email') {
  const value = parseText(raw, label, { max: 160 });
  if (value === null) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw badRequest(`${label} does not look like a valid email address.`);
  return value;
}

function parsePhone(raw, label = 'Phone') {
  const value = parseText(raw, label, { max: 30 });
  if (value === null) return null;
  if (!/^[0-9+\-()\s]{6,30}$/.test(value)) throw badRequest(`${label} may only contain digits, spaces and + - ( ).`);
  return value;
}

/** Optional date range used by reports and CSV exports. */
function parseDateRange(query = {}) {
  const from = query.from ? parseDateField(query.from, 'From date') : null;
  const to = query.to ? parseDateField(query.to, 'To date') : null;
  if (from && to && from > to) throw badRequest('"from" date cannot be after the "to" date.');
  return { from, to };
}

// ===========================================================================
// Entity validators
// ===========================================================================

/**
 * Validates a create/update transaction payload.
 * `categories` comes from the workspace type, so a personal workspace can never
 * store a business category and vice versa.
 */
function validateTransactionInput(body, { categories = PERSONAL_CATEGORIES, partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }

  const errors = {};
  const clean = {};
  const has = (field) => body[field] !== undefined && body[field] !== null;

  if (has('type') || !partial) {
    const type = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
    if (!TRANSACTION_TYPES.includes(type)) errors.type = 'Type must be either "income" or "expense".';
    else clean.type = type;
  }

  if (has('title') || !partial) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length === 0) errors.title = 'Title is required.';
    else if (title.length > LIMITS.titleMax) errors.title = `Title cannot be longer than ${LIMITS.titleMax} characters.`;
    else clean.title = title;
  }

  if (has('category') || !partial) {
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    if (!categories.includes(category)) {
      errors.category = `Category must be one of: ${categories.join(', ')}.`;
    } else clean.category = category;
  }

  if (has('amount') || !partial) {
    const amount = toNumber(body.amount);
    if (amount === null) errors.amount = 'Amount must be a number greater than 0.';
    else if (amount <= 0) errors.amount = 'Amount must be greater than 0.';
    else if (amount > LIMITS.amountMax) errors.amount = 'Amount is too large. Please enter a smaller value.';
    else clean.amount_minor = toMinor(amount);
  }

  if (has('transaction_date') || !partial) {
    if (!isValidDateString(body.transaction_date)) {
      errors.transaction_date = 'Date is required and must be a valid date in YYYY-MM-DD format.';
    } else clean.transaction_date = body.transaction_date;
  }

  if (body.notes !== undefined) {
    if (body.notes === null || body.notes === '') clean.notes = null;
    else if (typeof body.notes !== 'string') errors.notes = 'Notes must be text.';
    else if (body.notes.trim().length > LIMITS.notesMax) errors.notes = `Notes cannot be longer than ${LIMITS.notesMax} characters.`;
    else clean.notes = body.notes.trim() || null;
  } else if (!partial) {
    clean.notes = null;
  }

  // ---- business-only optional fields -----------------------------------
  if (body.payment_method !== undefined) {
    if (body.payment_method === null || body.payment_method === '') clean.payment_method = null;
    else if (!PAYMENT_METHODS.includes(body.payment_method)) {
      errors.payment_method = `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}.`;
    } else clean.payment_method = body.payment_method;
  }

  try {
    clean.customer_id = parseOptionalId(body.customer_id, 'customer');
  } catch {
    errors.customer_id = 'Invalid customer.';
  }
  try {
    clean.vendor_id = parseOptionalId(body.vendor_id, 'vendor');
  } catch {
    errors.vendor_id = 'Invalid vendor.';
  }

  if (body.tax_rate !== undefined && body.tax_rate !== null && body.tax_rate !== '') {
    const rate = toNumber(body.tax_rate);
    if (rate === null || rate < 0 || rate > 100) errors.tax_rate = 'Tax rate must be between 0 and 100.';
    else clean.tax_rate = rate;
  }

  if (Object.keys(errors).length > 0) {
    throw badRequest('Please fix the highlighted fields.', errors);
  }
  return clean;
}

/** Monthly budget (amount >= 0). */
function validateBudgetInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  const errors = {};
  const clean = {};

  try {
    clean.month = parseMonth(body.month);
  } catch (err) {
    errors.month = err.message;
  }

  const amount = toNumber(body.amount);
  if (amount === null) errors.amount = 'Budget amount must be a number.';
  else if (amount < 0) errors.amount = 'Budget amount cannot be negative.';
  else if (amount > LIMITS.budgetMax) errors.amount = 'Budget amount is too large.';
  else clean.amount_minor = toMinor(amount);

  if (Object.keys(errors).length > 0) throw badRequest('Please fix the highlighted fields.', errors);
  return clean;
}

/** Category budget for a month, e.g. Food: ₹4,000. */
function validateCategoryBudgetInput(body, { categories = PERSONAL_CATEGORIES } = {}) {
  const clean = validateBudgetInput(body);
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  if (!categories.includes(category)) {
    throw badRequest('Please fix the highlighted fields.', {
      category: `Category must be one of: ${categories.join(', ')}.`,
    });
  }
  clean.category = category;
  return clean;
}

/** Customer or vendor (same shape). */
function validatePartyInput(body, { kind = 'Customer' } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  return {
    name: parseText(body.name, `${kind} name`, { max: LIMITS.nameMax, required: true }),
    contact_person: parseText(body.contact_person, 'Contact person', { max: LIMITS.nameMax }),
    email: parseEmail(body.email),
    phone: parsePhone(body.phone),
    address: parseText(body.address, 'Address', { max: LIMITS.addressMax }),
    notes: parseText(body.notes, 'Notes', { max: LIMITS.notesMax }),
  };
}

/**
 * Invoice create/update payload.
 * NOTE: any `total`, `subtotal` or `amount` sent by the client is IGNORED -
 * totals are recalculated from the line items by the server.
 */
function validateInvoiceInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  const errors = {};
  const clean = {};

  if (body.invoice_number !== undefined || !partial) {
    const number = parseText(body.invoice_number, 'Invoice number', { max: LIMITS.invoiceNumberMax, required: true });
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(number)) {
      errors.invoice_number = 'Invoice number may only contain letters, numbers and / _ . -';
    } else clean.invoice_number = number;
  }

  try {
    clean.customer_id = parseId(body.customer_id, 'customer');
  } catch (err) {
    errors.customer_id = 'Please choose a customer.';
  }

  try {
    clean.invoice_date = parseDateField(body.invoice_date, 'Invoice date');
  } catch (err) {
    errors.invoice_date = err.message;
  }
  try {
    clean.due_date = parseDateField(body.due_date, 'Due date');
  } catch (err) {
    errors.due_date = err.message;
  }
  if (clean.invoice_date && clean.due_date && clean.due_date < clean.invoice_date) {
    errors.due_date = 'Due date cannot be before the invoice date.';
  }

  if (body.is_draft !== undefined) clean.is_draft = body.is_draft ? 1 : 0;
  clean.notes = parseText(body.notes, 'Notes', { max: LIMITS.notesMax });

  // ---- line items -------------------------------------------------------
  if (body.items !== undefined) {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      errors.items = 'An invoice needs at least one line item.';
    } else if (body.items.length > LIMITS.maxInvoiceItems) {
      errors.items = `An invoice cannot have more than ${LIMITS.maxInvoiceItems} line items.`;
    } else {
      const items = [];
      body.items.forEach((item, index) => {
        const lineLabel = `Line ${index + 1}`;
        if (!item || typeof item !== 'object') {
          errors.items = `${lineLabel} is invalid.`;
          return;
        }
        try {
          const description = parseText(item.description, `${lineLabel} description`, {
            max: LIMITS.descriptionMax,
            required: true,
          });
          const quantity = toNumber(item.quantity);
          if (quantity === null || quantity <= 0) throw badRequest(`${lineLabel} quantity must be greater than 0.`);
          if (quantity > LIMITS.maxQuantity) throw badRequest(`${lineLabel} quantity is too large.`);

          const unitPriceMinor = parseAmountMinor(item.unit_price ?? item.unitPrice, `${lineLabel} unit price`, {
            allowZero: true,
          });

          let taxRate = 0;
          if (item.tax_rate !== undefined && item.tax_rate !== null && item.tax_rate !== '') {
            const rate = toNumber(item.tax_rate);
            if (rate === null || rate < 0 || rate > 100) throw badRequest(`${lineLabel} tax rate must be between 0 and 100.`);
            taxRate = rate;
          }

          items.push({ description, quantity, unit_price_minor: unitPriceMinor, tax_rate: taxRate });
        } catch (err) {
          errors.items = err.message;
        }
      });
      if (!errors.items) clean.items = items;
    }
  } else if (!partial) {
    errors.items = 'An invoice needs at least one line item.';
  }

  if (Object.keys(errors).length > 0) throw badRequest('Please fix the highlighted fields.', errors);
  return clean;
}

/** A payment against an invoice or a vendor bill. */
function validatePaymentInput(body, { amountLabel = 'Payment amount' } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  const errors = {};
  const clean = {};

  try {
    clean.amount_minor = parseAmountMinor(body.amount ?? body.amount_minor, amountLabel);
  } catch (err) {
    errors.amount = err.message;
  }

  try {
    clean.paid_on = parseDateField(body.paid_on, 'Payment date');
  } catch (err) {
    errors.paid_on = err.message;
  }

  if (body.method !== undefined && body.method !== null && body.method !== '') {
    if (!PAYMENT_METHODS.includes(body.method)) {
      errors.method = `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}.`;
    } else clean.method = body.method;
  } else {
    clean.method = 'cash';
  }

  clean.reference = parseText(body.reference, 'Reference', { max: 80 }) || '';
  clean.notes = parseText(body.notes, 'Notes', { max: LIMITS.notesMax });

  if (Object.keys(errors).length > 0) throw badRequest('Please fix the highlighted fields.', errors);
  return clean;
}

/** A bill received from a vendor. */
function validateVendorBillInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  const errors = {};
  const clean = {};

  try {
    clean.vendor_id = parseId(body.vendor_id, 'vendor');
  } catch {
    errors.vendor_id = 'Please choose a vendor.';
  }

  try {
    clean.bill_number = parseText(body.bill_number, 'Bill number', { max: LIMITS.billNumberMax, required: true });
  } catch (err) {
    errors.bill_number = err.message;
  }

  try {
    clean.bill_date = parseDateField(body.bill_date, 'Bill date');
  } catch (err) {
    errors.bill_date = err.message;
  }
  try {
    clean.due_date = parseDateField(body.due_date, 'Due date');
  } catch (err) {
    errors.due_date = err.message;
  }
  if (clean.bill_date && clean.due_date && clean.due_date < clean.bill_date) {
    errors.due_date = 'Due date cannot be before the bill date.';
  }

  try {
    clean.amount_minor = parseAmountMinor(body.amount, 'Bill amount');
  } catch (err) {
    errors.amount = err.message;
  }

  if (body.tax_rate !== undefined && body.tax_rate !== null && body.tax_rate !== '') {
    const rate = toNumber(body.tax_rate);
    if (rate === null || rate < 0 || rate > 100) errors.tax_rate = 'Tax rate must be between 0 and 100.';
    else clean.tax_rate = rate;
  }

  clean.description = parseText(body.description, 'Description', { max: LIMITS.notesMax });
  clean.notes = parseText(body.notes, 'Notes', { max: LIMITS.notesMax });

  if (Object.keys(errors).length > 0) throw badRequest('Please fix the highlighted fields.', errors);
  return clean;
}

/** Recurring expense / income rule. */
function validateRecurringInput(body, { categories = PERSONAL_CATEGORIES } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  const errors = {};
  const clean = {};

  try {
    clean.title = parseText(body.title, 'Title', { max: LIMITS.titleMax, required: true });
  } catch (err) {
    errors.title = err.message;
  }

  const type = typeof body.type === 'string' ? body.type.trim().toLowerCase() : 'expense';
  if (!TRANSACTION_TYPES.includes(type)) errors.type = 'Type must be income or expense.';
  else clean.type = type;

  const category = typeof body.category === 'string' ? body.category.trim() : '';
  if (!categories.includes(category)) errors.category = 'Please choose a valid category.';
  else clean.category = category;

  try {
    clean.amount_minor = parseAmountMinor(body.amount, 'Amount');
  } catch (err) {
    errors.amount = err.message;
  }

  if (!RECURRENCE_FREQUENCIES.includes(body.frequency)) {
    errors.frequency = `Frequency must be one of: ${RECURRENCE_FREQUENCIES.join(', ')}.`;
  } else clean.frequency = body.frequency;

  try {
    clean.start_date = parseDateField(body.start_date, 'Start date');
  } catch (err) {
    errors.start_date = err.message;
  }

  clean.notes = parseText(body.notes, 'Notes', { max: LIMITS.notesMax });
  if (body.is_active !== undefined) clean.is_active = body.is_active ? 1 : 0;

  if (Object.keys(errors).length > 0) throw badRequest('Please fix the highlighted fields.', errors);
  // First expected payment is the start date.
  clean.next_due_date = clean.start_date;
  return clean;
}

/** Savings goal. */
function validateGoalInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  const errors = {};
  const clean = {};

  try {
    clean.name = parseText(body.name, 'Goal name', { max: LIMITS.titleMax, required: true });
  } catch (err) {
    errors.name = err.message;
  }

  try {
    clean.target_minor = parseAmountMinor(body.target, 'Target amount');
  } catch (err) {
    errors.target = err.message;
  }

  if (body.target_date !== undefined && body.target_date !== null && body.target_date !== '') {
    try {
      clean.target_date = parseDateField(body.target_date, 'Target date');
    } catch (err) {
      errors.target_date = err.message;
    }
  } else {
    clean.target_date = null;
  }

  clean.notes = parseText(body.notes, 'Notes', { max: LIMITS.notesMax });

  if (Object.keys(errors).length > 0) throw badRequest('Please fix the highlighted fields.', errors);
  return clean;
}

/** Contribution to a savings goal (may be negative to withdraw). */
function validateContributionInput(body) {
  const errors = {};
  const clean = {};

  const amount = toNumber(body.amount);
  if (amount === null) errors.amount = 'Amount must be a number.';
  else if (amount === 0) errors.amount = 'Amount cannot be zero.';
  else if (Math.abs(amount) > LIMITS.amountMax) errors.amount = 'Amount is too large.';
  else clean.amount_minor = toMinor(amount);

  try {
    clean.contributed_on = parseDateField(body.contributed_on || todayISO(), 'Contribution date');
  } catch (err) {
    errors.contributed_on = err.message;
  }

  clean.notes = parseText(body.notes, 'Notes', { max: LIMITS.notesMax });

  if (Object.keys(errors).length > 0) throw badRequest('Please fix the highlighted fields.', errors);
  return clean;
}

module.exports = {
  // values
  TRANSACTION_TYPES,
  PERSONAL_CATEGORIES,
  PERSONAL_INCOME_CATEGORIES,
  BUSINESS_CATEGORIES,
  BUSINESS_EXPENSE_CATEGORIES,
  BUSINESS_INCOME_CATEGORIES,
  PAYMENT_METHODS,
  RECURRENCE_FREQUENCIES,
  INVOICE_STATUSES,
  LIMITS,
  categoriesFor,
  incomeCategoriesFor,
  // errors
  ApiError,
  badRequest,
  notFound,
  conflict,
  forbidden,
  // primitives
  isValidDateString,
  isValidMonthString,
  toNumber,
  roundMoney,
  todayISO,
  parseId,
  parseOptionalId,
  parseMonth,
  parseDateField,
  parseText,
  parseAmountMinor,
  parseEnum,
  parseDateRange,
  // entities
  validateTransactionInput,
  validateBudgetInput,
  validateCategoryBudgetInput,
  validatePartyInput,
  validateInvoiceInput,
  validatePaymentInput,
  validateVendorBillInput,
  validateRecurringInput,
  validateGoalInput,
  validateContributionInput,
};
