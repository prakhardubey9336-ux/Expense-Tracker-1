/**
 * src/csv.js
 * ---------------------------------------------------------------------------
 * Generates CSV text for the export endpoints.
 *
 * CSV injection safety: a cell that starts with = + - @ (or a tab/CR) can be
 * executed as a formula by Excel/Sheets. We prefix those with a single quote,
 * which every spreadsheet treats as "this is text".
 * ---------------------------------------------------------------------------
 */

const { toRupees } = require('./money');

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);

  // Formula-injection guard (skip plain negative numbers, they are harmless).
  if (/^[=+@\t\r]/.test(text) || (/^-/.test(text) && Number.isNaN(Number(text)))) {
    text = `'${text}`;
  }

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** rows = array of arrays (first row = header). */
function toCsv(rows) {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

/** Rupees for export (2 decimals, no currency symbol so spreadsheets can sum it). */
const rupees = (minor) => toRupees(minor).toFixed(2);

/**
 * Sends a CSV download. Adds a UTF-8 BOM so Excel opens ₹ / accented text
 * correctly instead of mojibake.
 */
function sendCsv(res, filename, rows) {
  const body = `\uFEFF${toCsv(rows)}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}

module.exports = { toCsv, sendCsv, escapeCell, rupees };
