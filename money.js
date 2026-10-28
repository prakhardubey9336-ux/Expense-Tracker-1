/**
 * src/money.js
 * ---------------------------------------------------------------------------
 * All money maths for SmartSpend 2.0.
 *
 * RULE: money is stored and calculated as INTEGER PAISE (minor units).
 *   ₹1,234.50  ->  123450 paise
 *
 * Why? Floating point cannot represent 0.1 exactly, so `0.1 + 0.2` is
 * 0.30000000000000004 in JavaScript. Once you add hundreds of transactions the
 * totals drift and the cards stop matching the database. Integers do not.
 *
 * The UI works in rupees; the API accepts rupees for compatibility and converts
 * with toMinor() exactly once, on the server.
 * ---------------------------------------------------------------------------
 */

/** ₹ amount (number or numeric string) -> integer paise. Rounds to the nearest paisa. */
function toMinor(value) {
  const n = typeof value === 'string' ? Number(String(value).replace(/,/g, '').trim()) : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** integer paise -> rupees number (for display / API responses). */
function toRupees(minor) {
  const n = Number(minor);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

/** Formats paise as an Indian Rupee string: 123450 -> "₹1,234.50" */
function formatINR(minor, { showPaise = null } = {}) {
  const rupees = toRupees(minor);
  const needsPaise = showPaise === null ? Math.abs(Number(minor) % 100) > 0 : showPaise;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: needsPaise ? 2 : 0,
    maximumFractionDigits: needsPaise ? 2 : 0,
  }).format(rupees);
}

/**
 * Calculates one invoice/bill line.
 * lineTotal = quantity x unit price, and tax is applied on that line total.
 * Everything is rounded to whole paise so the invoice always adds up.
 */
function computeLine(item) {
  // Accept both camelCase (API style) and snake_case (validated row style) so
  // this function can never silently receive `undefined` and produce NaN.
  const qty = Number(item.quantity);
  const unit = Number(item.unitPriceMinor ?? item.unit_price_minor);
  const rate = Number(item.taxRate ?? item.tax_rate ?? 0) || 0;

  if (!Number.isFinite(qty) || !Number.isFinite(unit)) {
    throw new Error('Cannot compute a line total: quantity and unit price must be numbers.');
  }
  if (qty <= 0 || unit < 0 || rate < 0) {
    throw new Error('Cannot compute a line total: invalid quantity, price or tax rate.');
  }

  const lineTotalMinor = Math.round(qty * unit);
  const taxMinor = Math.round((lineTotalMinor * rate) / 100);
  return { lineTotalMinor, taxMinor, totalMinor: lineTotalMinor + taxMinor };
}

/**
 * Calculates invoice totals from validated items.
 * The server ALWAYS uses this; totals sent by the browser are ignored.
 */
function computeDocumentTotals(items) {
  let subtotalMinor = 0;
  let taxMinor = 0;
  const lines = items.map((item, index) => {
    const line = computeLine(item);
    subtotalMinor += line.lineTotalMinor;
    taxMinor += line.taxMinor;
    return {
      ...item,
      // the DB column names, normalised from whatever shape we were handed
      description: item.description,
      quantity: Number(item.quantity),
      unit_price_minor: Number(item.unitPriceMinor ?? item.unit_price_minor),
      tax_rate: Number(item.taxRate ?? item.tax_rate ?? 0) || 0,
      position: index,
      lineTotalMinor: line.lineTotalMinor,
      line_total_minor: line.lineTotalMinor,
      taxMinor: line.taxMinor,
      tax_minor: line.taxMinor,
      // shown in the UI next to each row
      lineTotal: toRupees(line.lineTotalMinor),
    };
  });
  return {
    lines,
    subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
  };
}

/** Splits a tax-inclusive amount into base + tax (used by the tax report). */
function splitInclusiveTax(amountMinor, ratePercent) {
  const rate = Number(ratePercent) || 0;
  if (rate <= 0) return { baseMinor: amountMinor, taxMinor: 0 };
  const baseMinor = Math.round((amountMinor * 100) / (100 + rate));
  return { baseMinor, taxMinor: amountMinor - baseMinor };
}

module.exports = { toMinor, toRupees, formatINR, computeLine, computeDocumentTotals, splitInclusiveTax };
