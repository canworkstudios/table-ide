// SPDX-License-Identifier: MIT
// ===================================================================================
// XLSX READING (OOXML → Table IDE HTML)
// ===================================================================================
//
// A .xlsx is a ZIP archive. This module reads the SpreadsheetML parts with the
// same minimal ZIP reader used by pdf-processor's docxToGxDoc.js (DataView +
// DecompressionStream) and maps each worksheet to a Table IDE table element —
// first row becomes the <th> header row, exactly like parseCsvInput.
//
// Self-contained on purpose: classic script, no modules, no dependencies, so a
// fork keeps exactly one file and nothing else changes.

// ── Minimal ZIP reader (same pattern as docxToGxDoc.js) ─────────────────────────

/**
 * Extract one entry from a ZIP archive by scanning local file headers.
 * Supports stored (0) and deflate (8) entries.
 */
// Data descriptor signature (optional per APPNOTE, but every writer worth
// worrying about emits it) — used to relocate a streamed entry's real size.
const _DATA_DESC_SIG = 0x08074b50;

/**
 * Find the end of a streamed entry (general-purpose flag bit 3 set), whose
 * local header lies about compressed/uncompressed size (both read 0). The
 * true sizes live in a 12- or 16-byte descriptor written after the entry's
 * data, found by scanning for its signature — the same recovery every real
 * unzip implementation performs for this case.
 */
function _xlsxFindDataDescriptor(dv, bytes, dataStart) {
    for (let i = dataStart; i + 16 <= bytes.length; i++) {
        if (dv.getUint32(i, true) !== _DATA_DESC_SIG) continue;
        const compSize = dv.getUint32(i + 8, true);
        // A signature match can be coincidental compressed-data bytes; a real
        // descriptor's declared compressed size must land exactly back on it.
        if (i - dataStart === compSize) {
            return { compSize, descLen: 16 };
        }
    }
    throw new Error('Streamed .xlsx entry has no data descriptor');
}

async function _xlsxUnzipEntry(bytes, wantedName) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    let offset = 0;

    while (offset + 30 <= bytes.length) {
        if (dv.getUint32(offset, true) !== 0x04034b50) break; // central dir / EOCD
        const flags = dv.getUint16(offset + 6, true);
        const method = dv.getUint16(offset + 8, true);
        const streamed = !!(flags & 0x0008);
        let compSize = dv.getUint32(offset + 18, true);
        const nameLen = dv.getUint16(offset + 26, true);
        const extraLen = dv.getUint16(offset + 28, true);
        const dataStart = offset + 30 + nameLen + extraLen;

        const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLen));

        // Streamed entries lie about compSize (0) in the local header — the
        // real size is only recoverable by locating the trailing descriptor.
        let descLen = 0;
        if (streamed) {
            const found = _xlsxFindDataDescriptor(dv, bytes, dataStart);
            compSize = found.compSize;
            descLen = found.descLen;
        }

        if (name === wantedName) {
            const data = bytes.subarray(dataStart, dataStart + compSize);
            if (method === 0) return data;
            if (method === 8) return _xlsxInflateRaw(data);
            throw new Error(`Unsupported .xlsx compression method ${method} for "${name}"`);
        }

        offset = dataStart + compSize + descLen;
    }

    throw new Error(`"${wantedName}" not found in .xlsx archive`);
}

/** Deflate raw (RFC 1951) via the platform's native decompressor. */
async function _xlsxInflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('DecompressionStream is not available in this browser');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function _xlsxReadOptional(bytes, name) {
    try {
        const entry = await _xlsxUnzipEntry(bytes, name);
        return new TextDecoder().decode(entry);
    } catch (_) {
        return null;
    }
}

/** Column letters → index (A=1, AA=27…). */
function _xlsxColIndex(ref) {
    let idx = 0;
    for (const ch of ref) {
        if (ch >= 'A' && ch <= 'Z') idx = idx * 26 + (ch.charCodeAt(0) - 64);
        else if (ch >= 'a' && ch <= 'z') idx = idx * 26 + (ch.charCodeAt(0) - 96);
        else break;
    }
    return idx - 1;
}

/** List worksheets from workbook.xml: [{ name, rid, index }] in order. */
function _xlsxSheets(workbookXml) {
    const sheets = [];
    const re = /<sheet\b[^>]*?\/?>/g;
    let m;
    while ((m = re.exec(workbookXml))) {
        const tag = m[0];
        const name = (tag.match(/name="([^"]*)"/) || [])[1] || '';
        const rid = (tag.match(/r:id="([^"]*)"/) || [])[1] || null;
        sheets.push({ name, rid });
    }
    return sheets;
}

/** Map rId → worksheet target from workbook.xml.rels. */
function _xlsxRels(relsXml) {
    const map = {};
    const re = /<Relationship\b[^>]*?\/?>/g;
    let m;
    while ((m = re.exec(relsXml))) {
        const id = (m[0].match(/Id="([^"]*)"/) || [])[1];
        const target = (m[0].match(/Target="([^"]*)"/) || [])[1];
        if (id && target && target.toLowerCase().endsWith('.xml')) map[id] = target;
    }
    return map;
}

/** sharedStrings.xml → array of plain strings. */
function _xlsxSharedStrings(sharedXml) {
    if (!sharedXml) return [];
    const out = [];
    const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(sharedXml))) {
        const inner = m[1];
        let text = '';
        const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let tm;
        while ((tm = tRe.exec(inner))) text += tm[1];
        out.push(_xlsxUnescape(text));
    }
    return out;
}

/** One worksheet → `<table class="tablecoil crosshair-table">…</table>`. */
function _xlsxSheetToTable(sheetXml, shared) {
    const parsed = new DOMParser().parseFromString(sheetXml, 'application/xml');
    if (!parsed || parsed.getElementsByTagName('parsererror').length) return '';

    const sheetData = parsed.getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'sheetData'
    )[0] || parsed.getElementsByTagName('sheetData')[0];
    if (!sheetData) return '';

    // Gather rows as arrays of resolved strings, tracking the widest row.
    const matrix = [];
    let width = 0;
    const rowEls = [...sheetData.children].filter(c => c.localName === 'row');

    for (const rowEl of rowEls) {
        const rAttr = rowEl.getAttribute('r');
        let rowIndex = rAttr ? parseInt(rAttr, 10) - 1 : matrix.length;
        if (isNaN(rowIndex)) rowIndex = matrix.length;
        if (rowIndex < 0) rowIndex = matrix.length;

        const cells = [];
        for (const cEl of [...rowEl.children].filter(c => c.localName === 'c')) {
            const ref = cEl.getAttribute('r') || '';
            let col = _xlsxColIndex(ref);
            if (isNaN(col) || col < 0) col = cells.length; // fallback: in-order

            const t = cEl.getAttribute('t') || 'n';
            const vEl = [...cEl.children].find(c => c.localName === 'v');
            const isEl = [...cEl.children].find(c => c.localName === 'is');

            let value = '';
            if (t === 'inlineStr' && isEl) {
                value = _xlsxInlineText(isEl);
            } else if (vEl) {
                const v = vEl.textContent || '';
                if (t === 's') {
                    const idx = parseInt(v, 10);
                    value = !isNaN(idx) && shared[idx] !== undefined ? shared[idx] : '';
                } else if (t === 'b') {
                    value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
                } else if (t === 'str') {
                    value = v;
                } else if (t === 'e') {
                    value = ''; // errors surface as blank cells
                } else {
                    value = v;
                }
            }
            cells[col] = value;
        }

        // Pad gaps between cell refs so visual columns line up.
        const filled = Array.from({ length: cells.length }, (_, i) =>
            cells[i] !== undefined ? cells[i] : String(''));
        matrix[rowIndex] = filled;
        width = Math.max(width, filled.length);
    }

    // Trim trailing fully-empty rows.
    while (matrix.length && (matrix[matrix.length - 1] || []).every(v => v === '')) matrix.pop();
    if (!matrix.length) return '';

    // Pad every row to the widest row (same convention as _padDelimitedRows).
    const rows = matrix.map(row => {
        const padded = Array.from({ length: width }, (_, i) => (row && row[i] !== undefined ? row[i] : String('')));
        return padded;
    });

    let html = '<table class="tablecoil crosshair-table">';
    rows.forEach((cells, idx) => {
        html += '<tr id="test">';
        cells.forEach(cell => {
            html += idx === 0 ? `<th>${_xlsxEsc(cell)}</th>` : `<td>${_xlsxEsc(cell)}</td>`;
        });
        html += '</tr>';
    });
    html += '</table>';
    return html;
}

function _xlsxInlineText(isEl) {
    let text = '';
    for (const tEl of isEl.getElementsByTagName('t')) text += tEl.textContent || '';
    return _xlsxUnescape(text);
}

function _xlsxUnescape(str) {
    return String(str)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function _xlsxEsc(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Parse a .xlsx file into Table IDE table HTML.
 * @param {ArrayBuffer|Uint8Array} arrayBuffer — the .xlsx bytes
 * @returns {Promise<string>} one <table> per worksheet, joined.
 */
async function parseXlsxInput(arrayBuffer) {
    const bytes = arrayBuffer instanceof Uint8Array
        ? arrayBuffer
        : new Uint8Array(arrayBuffer instanceof ArrayBuffer ? arrayBuffer : await new Blob([arrayBuffer]).arrayBuffer());

    const workbookXml = new TextDecoder().decode(await _xlsxUnzipEntry(bytes, 'xl/workbook.xml'));
    const sheets = _xlsxSheets(workbookXml);
    const rels = _xlsxRels(await _xlsxReadOptional(bytes, 'xl/_rels/workbook.xml.rels') || '');
    const shared = _xlsxSharedStrings(await _xlsxReadOptional(bytes, 'xl/sharedStrings.xml'));

    const tables = [];
    for (let i = 0; i < sheets.length; i++) {
        const sheet = sheets[i];
        const relsTarget = (sheet.rid && rels[sheet.rid]) || `worksheets/sheet${i + 1}.xml`;
        // Excel/openpyxl write ABSOLUTE rel targets ("/xl/worksheets/sheet1.xml"),
        // while some writers emit archive-relative ones ("worksheets/sheet1.xml").
        // Both must resolve: a target already rooted at /xl/ is joined as-is.
        const target = relsTarget.startsWith('/')
            ? relsTarget.replace(/^\//, '')
            : `xl/${relsTarget}`;
        const sheetXml = await _xlsxReadOptional(bytes, target);
        if (!sheetXml) continue;
        const table = _xlsxSheetToTable(sheetXml, shared);
        if (table) tables.push(table);
    }
    return tables.join('\n');
}