// ============================================================================
//  Minimal Excel (.xlsx) writer. No dependencies, no network: the tool has no
//  build step and loads nothing but Firebase, and a backup export should not be
//  the thing that breaks when a CDN is down.
//
//  buildXlsx([{ name, rows, widths? }]) -> Uint8Array
//    rows   : array of arrays; row 0 is the header (bold, frozen)
//    cells  : string | number | boolean | null/undefined (blank)
//    widths : optional column widths in characters; otherwise estimated
//
//  An .xlsx file is a ZIP of XML parts. This writes the smallest set Excel,
//  Numbers, LibreOffice and Google Sheets all open: content types, workbook,
//  styles (normal / bold header / wrapped), and one worksheet per sheet, with
//  inline strings (no shared-string table) and ZIP "stored" entries (no
//  compression, so no inflate code is needed). The same file lives in both the
//  hiring tool and motion voting; keep them identical.
// ============================================================================

const enc = new TextEncoder();

// XML text: escape the five specials and drop control characters XML 1.0
// forbids (a pasted tab-free note can still carry \u0000-\u001f junk).
function xml(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function colName(i) { // 0 -> A, 25 -> Z, 26 -> AA
  let s = ""; i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

// Excel sheet names: 1-31 chars, none of : \ / ? * [ ], unique (case-insensitive).
function sheetNames(sheets) {
  const used = new Set();
  return sheets.map((s, i) => {
    let base = String(s.name || `Sheet${i + 1}`).replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`;
    let name = base, n = 2;
    while (used.has(name.toLowerCase())) { const sfx = ` (${n++})`; name = base.slice(0, 31 - sfx.length) + sfx; }
    used.add(name.toLowerCase());
    return name;
  });
}

function estimateWidths(rows) {
  const w = [];
  rows.forEach((r) => r.forEach((v, c) => {
    const len = v == null ? 0 : Math.max(...String(v).split("\n").map((l) => l.length));
    w[c] = Math.max(w[c] || 6, Math.min(60, len + 2));
  }));
  return w;
}

function sheetXml(rows, widths) {
  const cols = widths.map((wd, i) => `<col min="${i + 1}" max="${i + 1}" width="${wd}" customWidth="1"/>`).join("");
  const body = rows.map((r, ri) => {
    const cells = r.map((v, ci) => {
      if (v == null || v === "") return "";
      const ref = colName(ci) + (ri + 1);
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${ri === 0 ? ' s="1"' : ""}><v>${v}</v></c>`;
      if (typeof v === "boolean") return `<c r="${ref}" t="b"${ri === 0 ? ' s="1"' : ""}><v>${v ? 1 : 0}</v></c>`;
      const s = String(v);
      const style = ri === 0 ? ' s="1"' : s.includes("\n") ? ' s="2"' : "";
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(s)}</t></is></c>`;
    }).join("");
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join("");
  const freeze = rows.length > 1
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + freeze + (cols ? `<cols>${cols}</cols>` : "") + `<sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
  + `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
  + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>`
  + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// ---- ZIP (stored, no compression) -----------------------------------------
let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) { // files: [{ name, data: Uint8Array }]
  const chunks = [], central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  // DOS date/time for "now": the archive needs some value; Excel ignores it.
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0)]);
    chunks.push(local, name, f.data);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + size;
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0)]);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

export function buildXlsx(sheets) {
  const names = sheetNames(sheets);
  const files = [];
  const add = (name, text) => files.push({ name, data: enc.encode(text) });
  add("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    + `</Types>`);
  add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`);
  add("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  add("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    + `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `</Relationships>`);
  add("xl/styles.xml", STYLES);
  sheets.forEach((s, i) => {
    const rows = (s.rows || []).map((r) => (Array.isArray(r) ? r : [r]));
    add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(rows, s.widths || estimateWidths(rows)));
  });
  return zip(files);
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
