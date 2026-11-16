/**
 * Google Apps Script web app for Praw's `sheets_append_receipt` (README "Receipts and Google Sheets").
 * Contract: POST JSON {secret, worksheet, rows}. The secret is compared with the Script Property SHEETS_SECRET.
 * Setup: a standalone or bound script. Set the Script Properties SHEETS_SECRET and, for a standalone script, SPREADSHEET_ID
 * (the id in the sheet's URL). Then Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone. Use the /exec URL.
 */
const ALLOWED_SHEETS = ['Sheet1'];
const MAX_ROWS = 50;
const MAX_CELL = 500;

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('SHEETS_SECRET');
    if (!expected || typeof body.secret !== 'string' || !safeEqual_(body.secret, expected)) return out_({ ok: false, error: 'unauthorized' });
    if (ALLOWED_SHEETS.indexOf(body.worksheet) < 0) return out_({ ok: false, error: 'worksheet' });
    const rows = body.rows;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) return out_({ ok: false, error: 'rows' });
    const width = rows[0].length;
    const clean = rows.map(function (r) {
      if (!Array.isArray(r) || r.length !== width || width > 20) throw new Error('row shape');
      return r.map(function (c) {
        if (typeof c === 'number' && isFinite(c)) return c;
        var s = String(c == null ? '' : c).slice(0, MAX_CELL);
        // Formula injection guard (the app already prefixes these; this is the second layer).
        return /^[\s]*[=+\-@＝＋－＠\t\r\n]/.test(s) ? "'" + s : s;
      });
    });
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    const book = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    const sheet = book.getSheetByName(body.worksheet);
    if (!sheet) return out_({ ok: false, error: 'missing sheet' });
    sheet.getRange(sheet.getLastRow() + 1, 1, clean.length, width).setValues(clean);
    return out_({ ok: true, appended: clean.length });
  } catch (err) {
    return out_({ ok: false, error: 'bad request' });
  }
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
