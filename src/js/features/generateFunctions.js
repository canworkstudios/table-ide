function generateTabs(tableHtml) {
    let buttonIndex = parseInt($('#buttonIndex').val());
    if (isNaN(buttonIndex) || buttonIndex < 1) { buttonIndex = 1; $('#buttonIndex').val(1); }
    if (buttonIndex > 100) { buttonIndex = 100; $('#buttonIndex').val(100); }

    window.saveCurrentState();

    // Parse input and find every <table> — each gets its own card
    const $parsed = $('<div>').html(tableHtml);
    const $tables = $parsed.find('table');

    if ($tables.length === 0) {
        const cleanHtml = window.DOMPurify ? window.DOMPurify.sanitize(tableHtml, { ALLOW_DATA_ATTR: true }) : tableHtml;
        $('#tableContainer')[0].innerHTML = cleanHtml;
        setupTableInteraction();
        return;
    }

    let blocksHtml = '';

    $tables.each(function (i) {
        $(this).attr('data-table-ide-id', `t-${i}`);

        let spHtml = '<div class="sp-selector">\n';
        for (let j = 1; j <= buttonIndex; j++) {
            spHtml += `  <button class="sp-option" data-value="${j}" data-panel="${i}">${j}</button>\n`;
        }
        spHtml += '</div>';

        const tableOuterHtml = $('<div>').append($(this).clone()).html();

        blocksHtml +=
            `<button class="accordion active"><b>Table ${i + 1}</b></button>` +
            `<div class="panel">${spHtml}${tableOuterHtml}</div>`;
    });

    const cleanBlocks = window.DOMPurify ? window.DOMPurify.sanitize(blocksHtml, { ALLOW_DATA_ATTR: true }) : blocksHtml;
    $('#tableContainer')[0].innerHTML = cleanBlocks;

    setupTableInteraction();

    // Build rulers after layout is painted so getBoundingClientRect() has real widths
    if (typeof window.renderTableRulers === 'function') {
        requestAnimationFrame(() => {
            $('#tableContainer table.tablecoil').each(function () {
                window.renderTableRulers(this);
            });
        });
    }

    console.log(`Generated ${buttonIndex} tab(s) across ${$tables.length} table(s)`);
    $.toast({ heading: 'Done', text: `Generated ${buttonIndex} tabs`, icon: 'success', loader: false, stack: false });
}

function generateCode() {
    const format = $('#exportFormat').val() || 'html';
    console.group('Generate Code Process; format:', format);

    try {
        const $tables = $('#tableContainer table');
        if ($tables.length === 0) {
            alert('No table to generate from. Please parse a table first.');
            return;
        }

        let output = '';

        if (format === 'html') {
            output = exportAsHtml();
        } else if (format === 'json') {
            output = exportAsJson($tables);
        } else if (format === 'markdown') {
            output = exportAsMarkdown($tables);
        } else if (format === 'csv') {
            const csvContent = exportAsCsv(window.currentTable || $tables[0]);
            // Download the CSV file. BOM so Excel opens UTF-8 correctly.
            const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'table.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            output = csvContent; // Also show in editor
        } else if (format === 'sql') {
            output = exportAsSql($tables);
        } else if (format === 'ascii') {
            output = exportAsAscii($tables);
        } else if (format === 'xlsx') {
            // Public branch, generation only. The gate that decides whether the
            // user may actually run this lives in the injected private layer
            // (window.GxTableIdeXlsxExport, see assets/table-formatter/ui/):
            // "- when signed in". Presence-guarded here, so a fork of this
            // MIT file keeps working — it just can't produce xlsx, and the
            // platform notice tells the user where that feature lives.
            if (window.GxTableIdeXlsxExport?.canExport?.()) {
                const { blob, fileName } = exportAsXlsx($tables);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                // Binary can't live in the text editor; show a stub instead.
                output = `/* ${fileName} exported — binary file, download triggered. */`;
            } else {
                // Provide a visible hold-out so a standalone/fork user isn't
                // left staring at a silently unavailable option.
                output = '// Excel (.xlsx) export is a Ginexys platform feature — available when signed in.';
            }
        }

        if (window.tableIdeMonaco) {
            window.tableIdeMonaco.setValue(output);
        } else {
            $('#tableOutput').val(output);
        }

        setupTableInteraction();
        console.log('Generation successful, length:', output.length);
    } catch (error) {
        console.error('Error in code generation:', error);
        alert('Failed to generate. Check console for details.');
    } finally {
        console.groupEnd();
    }
}

function exportAsHtml() {
    const $clone = $('#tableContainer').clone();

    // Strip ruler wrappers — replace each with just its table
    $clone.find('.table-ide-ruler-wrap').each(function () {
        $(this).replaceWith($(this).find('table').first());
    });

    if (crosshairEnabled) {
        $clone.find('table').addClass('crosshair-table');
    } else {
        $clone.find('.highlight-row, .highlight-col').removeClass('highlight-row highlight-col');
    }

    $clone.find('tr').attr('id', 'test');
    $clone.removeAttr('style');
    $clone.find('td, th, tr').removeClass('selected-cell');
    $clone.find('.text-center.p-5:has(p:contains("Table View"))').remove();
    // $clone.find('td').removeAttr('style');

    return formatHtml($('<div>').append($clone).html());
}

// Helper: get headers and rows from a table DOM element
function getTableData(tableEl) {
    const $table = $(tableEl);
    const headers = [];
    const rows = [];

    $table.find('tr').each(function (rowIdx) {
        const cells = [];
        $(this).find('th, td').each(function () {
            cells.push($(this).text().trim());
        });
        if (rowIdx === 0 && $(this).find('th').length > 0) {
            headers.push(...cells);
        } else {
            if (cells.length > 0) rows.push(cells);
        }
    });

    // If no <th> headers were found, treat first row as headers
    if (headers.length === 0 && rows.length > 0) {
        headers.push(...rows.shift());
    }

    return { headers, rows };
}

function exportAsJson($tables) {
    const result = {};
    const tableCount = $tables.length;

    $tables.each(function (i) {
        const { headers, rows } = getTableData(this);
        const key = tableCount === 1 ? 'table' : `table_${i + 1}`;
        result[key] = rows.map(row => {
            const obj = {};
            headers.forEach((h, idx) => {
                obj[h || `col_${idx + 1}`] = row[idx] !== undefined ? row[idx] : '';
            });
            return obj;
        });
    });

    return JSON.stringify(tableCount === 1 ? result['table'] : result, null, 2);
}

function exportAsCsv(tableEl) {
    const { headers, rows } = getTableData(tableEl);
    const escapeCell = val => {
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    const lines = [];
    if (headers.length > 0) lines.push(headers.map(escapeCell).join(','));
    rows.forEach(row => lines.push(row.map(escapeCell).join(',')));
    return lines.join('\r\n');
}

function exportAsMarkdown($tables) {
    const parts = [];

    $tables.each(function () {
        const { headers, rows } = getTableData(this);
        if (headers.length === 0) return;

        const lines = [];
        lines.push('| ' + headers.join(' | ') + ' |');
        lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
        rows.forEach(row => {
            const padded = headers.map((_, i) => row[i] !== undefined ? row[i] : '');
            lines.push('| ' + padded.join(' | ') + ' |');
        });
        parts.push(lines.join('\n'));
    });

    return parts.join('\n\n');
}

function exportAsSql($tables) {
    const parts = [];

    $tables.each(function (i) {
        const { headers, rows } = getTableData(this);
        const tableName = `table_${i + 1}`;
        const cols = headers.length > 0
            ? headers.map((h, idx) => h ? h.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '') || `col_${idx + 1}` : `col_${idx + 1}`)
            : (rows[0] || []).map((_, idx) => `col_${idx + 1}`);

        const colDefs = cols.map(c => `  ${c} TEXT`).join(',\n');
        let sql = `CREATE TABLE ${tableName} (\n${colDefs}\n);\n`;

        rows.forEach(row => {
            const values = cols.map((_, idx) => {
                const v = row[idx] !== undefined ? row[idx] : '';
                return `'${v.replace(/'/g, "''")}'`;
            });
            sql += `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${values.join(', ')});\n`;
        });

        parts.push(sql);
    });

    return parts.join('\n');
}

/**
 * Export table(s) as an ASCII box-drawing table.
 * Example:
 *   +------+-------+
 *   | Name | Score |
 *   +======+=======+
 *   | Bob  |    42 |
 *   +------+-------+
 */
function exportAsAscii($tables) {
    const parts = [];

    $tables.each(function () {
        const { headers, rows } = getTableData(this);
        const allRows = headers.length > 0 ? [headers, ...rows] : rows;
        if (allRows.length === 0) return;

        // Compute column widths
        const cols = allRows[0].length;
        const widths = Array.from({ length: cols }, (_, c) =>
            Math.max(...allRows.map(row => String(row[c] !== undefined ? row[c] : '').length))
        );

        const sep  = (ch) => '+' + widths.map(w => ch.repeat(w + 2)).join('+') + '+';
        const row  = (cells) => '| ' + cells.map((c, i) => String(c !== undefined ? c : '').padEnd(widths[i])).join(' | ') + ' |';

        const lines = [];
        lines.push(sep('-'));
        if (headers.length > 0) {
            lines.push(row(headers));
            lines.push(sep('='));
            rows.forEach(r => lines.push(row(r)));
        } else {
            allRows.forEach(r => lines.push(row(r)));
        }
        lines.push(sep('-'));
        parts.push(lines.join('\n'));
    });

    return parts.join('\n\n');
}

// ── XLSX writer ─────────────────────────────────────────────────────────────────
// Built by hand, store-compression ZIP with inline strings (no sharedStrings.xml)
// so a workbook parsable by Excel/LibreOffice/Google Sheets can be produced with
// zero dependencies. ~The same philosophy as the xlsxReader in xlsxReader.js.

/** CRC32 (IEEE) — needed for ZIP local headers. */
const _crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function _crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Store-method ZIP writer: [{ name, data }] → Blob. */
function _storeZip(entries) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBytes = enc.encode(name);
        const crc = _crc32(data);
        const size = data.length;

        const local = new Uint8Array(30 + nameBytes.length);
        const dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 0x0800, true); // UTF-8 flag
        dv.setUint16(8, 0, true);      // store
        dv.setUint32(14, crc, true);
        dv.setUint32(18, size, true);
        dv.setUint32(22, size, true);
        dv.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);

        const cent = new Uint8Array(46 + nameBytes.length);
        const cdv = new DataView(cent.buffer);
        cdv.setUint32(0, 0x02014b50, true);
        cdv.setUint16(4, 20, true);
        cdv.setUint16(6, 20, true);
        cdv.setUint16(8, 0x0800, true);
        cdv.setUint32(16, crc, true);
        cdv.setUint32(20, size, true);
        cdv.setUint32(24, size, true);
        cdv.setUint16(28, nameBytes.length, true);
        cdv.setUint32(42, offset, true);
        cent.set(nameBytes, 46);

        chunks.push(local, data);
        central.push(cent);
        offset += local.length + size;
    }

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const eDv = new DataView(eocd.buffer);
    eDv.setUint32(0, 0x06054b50, true);
    eDv.setUint16(8, central.length, true);
    eDv.setUint16(10, central.length, true);
    eDv.setUint32(12, centralSize, true);
    eDv.setUint32(16, offset, true);

    const total = chunks.reduce((n, c) => n + c.length, 0) + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of [...chunks, ...central, eocd]) { out.set(c, pos); pos += c.length; }
    return out;
}

function _xlsxEsc(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 0 → A, 25 → Z, 26 → AA … (Excel column letters). */
function _xlsxColLetter(n) {
    let s = '';
    n += 1;
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/**
 * Build an .xlsx Blob from one or more tables.
 * Every table becomes a worksheet; the first row of each table becomes the
 * header row. Zero dependencies — store-compressed ZIP, inline strings.
 * @param {jQuery} $tables — the jQuery selection of <table> elements
 * @returns {{ blob: Blob, fileName: string }}
 */
function exportAsXlsx($tables) {
    const sheets = [];
    let sheetIdx = 1;

    $tables.each(function () {
        const { headers, rows } = getTableData(this);
        const allRows = headers.length > 0 ? [headers, ...rows] : rows;
        if (!allRows.length) return;

        const width = Math.max(...allRows.map(r => r.length), 1);
        let rowsXml = '';
        allRows.forEach((row, ri) => {
            let cellsXml = '';
            for (let ci = 0; ci < width; ci++) {
                const v = row[ci] !== undefined ? row[ci] : '';
                cellsXml += `<c r="${_xlsxColLetter(ci)}${ri + 1}" t="inlineStr"><is><t>${_xlsxEsc(v)}</t></is></c>`;
            }
            rowsXml += `<row r="${ri + 1}">${cellsXml}</row>`;
        });

        sheets.push({
            name: `Sheet${sheetIdx}`,
            xml: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
        });
        sheetIdx++;
    });

    if (!sheets.length) throw new Error('No table rows to export');

    const enc = new TextEncoder();
    const entries = [];
    const push = (name, xml) => entries.push({ name, data: enc.encode(xml) });

    push('[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>');

    push('_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>');

    push('xl/workbook.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' +
        sheets.map((s, i) => `<sheet name="${_xlsxEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>');

    push('xl/_rels/workbook.xml.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        '</Relationships>');

    sheets.forEach((s, i) => push(`xl/worksheets/sheet${i + 1}.xml`, s.xml));

    push('xl/styles.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
        '<borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
        '</styleSheet>');

    const bytes = _storeZip(entries);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fileName = sheets.length > 1 ? 'tables.xlsx' : 'table.xlsx';
    return { blob, fileName };
}

function copyInput() {
        const formatBoard = window.tableIdeMonaco
            ? window.tableIdeMonaco.getValue()
            : $('#tableOutput').val();
        if (!formatBoard || formatBoard.trim() === '') {
            // More descriptive error message
            $.toast({ heading: 'Info', text: 'The text area is empty. Please add content before copying.', icon: 'warning', loader: false, stack: false });
            return;
        }
        if (navigator.clipboard) {
            navigator.clipboard.writeText(formatBoard)
                .then(() => {
                    $.toast({ heading: 'Copied', text: 'HTML copied to clipboard!', icon: 'success', loader: false, stack: false });
                })
        } else {
            $.toast({ heading: 'Error', text: 'Failed to copy', icon: 'error', loader: false, stack: false })
        }
    }