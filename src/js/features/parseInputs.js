// ===================================================================================
// 5. INPUT PARSING FUNCTIONS
// ===================================================================================

function _escHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// CSV and TSV describe row values, not merged-cell structure. Normalize a
// ragged matrix to its widest record so every visual coordinate has a real
// cell. Missing values become empty strings; they never imply colspan.
function _padDelimitedRows(rows) {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    return rows.map(row => row.concat(Array(Math.max(0, width - row.length)).fill('')));
}

function parseInput() {
    const inputType = $('#inputType').val();
    const inputData = (window.tableIdeMonacoInput
        ? window.tableIdeMonacoInput.getValue()
        : $('#tableInput').val()
    ).trim();

    if (!inputData) {
        alert('Please input some data');
        return;
    }

    let tableHtml = '';

    switch (inputType) {
        case 'html':
            tableHtml = parseHtmlInput(inputData);
            break;
        case 'ascii':
            tableHtml = parseAsciiInput(inputData);
            break;
        case 'csv':
            tableHtml = parseCsvInput(inputData);
            break;
        case 'text':
            tableHtml = parseTextInput(inputData);
            break;
        case 'markdown':
            tableHtml = parseMarkdownInput(inputData);
            break;
        case 'json':
            tableHtml = parseJsonInput(inputData);
            break;
        case 'sql':
            tableHtml = parseSqlInput(inputData);
            break;
        default:
            alert('Unknown input type');
            return;
    }

    // Close the input modal if open
    $('#inputModal').modal('hide');

    // Route through sheet manager so each parse creates/updates a sheet
    if (typeof addSheet === 'function') {
        const sheetName = 'Sheet ' + (window._sheetCounter + 1);
        addSheet(sheetName, tableHtml);
    } else {
        // Fallback: direct render (no sheet manager loaded)
        window.lastParsedHtml = tableHtml;
        generateTabs(tableHtml);
        window.currentTable = $('#tableContainer table')[0];
        initializeAllFeatures();
        setupTableInteraction();
        window.saveCurrentState();
    }
}

/**
 * Parse one file into table HTML, picking the parser from its extension.
 * Resolves to '' when nothing table-shaped came out of it.
 */
function _parseFileToTable(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    // .xlsx is a binary ZIP, so it goes to the OOXML reader as bytes.
    // Everything else stays on the text path.
    if (ext === 'xlsx') {
        return file.arrayBuffer().then(parseXlsxInput);
    }

    return file.text().then(function (text) {
        if (ext === 'html' || ext === 'htm') return parseHtmlInput(text);
        if (ext === 'csv') return parseCsvInput(text);
        if (ext === 'tsv') return parseTextInput(text);
        if (ext === 'md') return parseMarkdownInput(text);
        if (ext === 'json') return parseJsonInput(text);
        if (ext === 'sql') return parseSqlInput(text);
        // .txt and others; try tab-delimited first
        if (text.includes('\t')) return parseTextInput(text);
        if (text.includes(',')) return parseCsvInput(text);
        return parseTextInput(text);
    });
}

function _addLoadedSheet(file, tableHtml) {
    const sheetName = file.name.replace(/\.[^/.]+$/, ''); // strip extension
    if (typeof addSheet === 'function') {
        addSheet(sheetName, tableHtml);
    } else {
        window.lastParsedHtml = tableHtml;
        generateTabs(tableHtml);
        window.currentTable = $('#tableContainer table')[0];
        initializeAllFeatures();
        setupTableInteraction();
        window.saveCurrentState();
    }
}

/**
 * Handle files selected via the Load button. Each file becomes its own sheet.
 *
 * Files load one at a time, in the order they were picked. Reading them in
 * parallel would add sheets in whichever order the reads happened to finish.
 * A file that fails to parse is skipped and reported once at the end, so one
 * bad file in a batch of ten doesn't stop the other nine.
 */
function handleFilesLoad(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return Promise.resolve();

    const loaded = [];
    const failed = [];

    return files.reduce(function (chain, file) {
        return chain.then(function () {
            return _parseFileToTable(file)
                .then(function (tableHtml) {
                    if (!tableHtml) {
                        failed.push(file.name);
                        return;
                    }
                    _addLoadedSheet(file, tableHtml);
                    loaded.push(file.name);
                })
                .catch(function (err) {
                    console.error('File parse failed:', file.name, err);
                    failed.push(file.name);
                });
        });
    }, Promise.resolve()).then(function () {
        if (loaded.length) {
            const text = loaded.length === 1
                ? 'Loaded: ' + loaded[0]
                : 'Loaded ' + loaded.length + ' files as sheets';
            $.toast({ heading: 'Loaded', text: text, icon: 'success', loader: false, stack: false });
        }
        if (failed.length) {
            alert('Could not parse ' + (failed.length === 1 ? 'file' : 'files') + ': ' + failed.join(', '));
        }
    });
}

/** Single-file entry point, kept for existing callers. */
function handleFileLoad(file) {
    return handleFilesLoad(file ? [file] : []);
}

function parseHtmlInput(html) {
    // Try to extract table-like structure
    const tablePattern = /<table[\s\S]*?<\/table>/gi;
    const matches = html.match(tablePattern);

    if (matches && matches.length > 0) {
        // Inject .tablecoil and .crosshair-table into every matched table that lacks them
        const normalized = matches.map(tableHtml => {
            return tableHtml.replace(/^<table([^>]*)>/i, (_fullMatch, attrs) => {
                const hasClass = /class\s*=/i.test(attrs);
                if (!hasClass) {
                    return `<table class="tablecoil crosshair-table"${attrs}>`;
                }
                // Add classes if missing
                let updated = attrs.replace(/class\s*=\s*["']([^"']*)["']/i, (_m, existing) => {
                    const classes = existing.split(/\s+/).filter(Boolean);
                    if (!classes.includes('tablecoil')) classes.push('tablecoil');
                    if (!classes.includes('crosshair-table')) classes.push('crosshair-table');
                    return `class="${classes.join(' ')}"`;
                });
                return `<table${updated}>`;
            });
        });
        return normalized.join('\n');
    }

    // If no table found, treat input as plain text and build a single-column table
    const escapedRows = html.split('\n')
        .map(line => '<tr id="test">' + line.split('\t').map(cell => `<td>${_escHtml(cell)}</td>`).join('') + '</tr>')
        .join('');
    return `<table class="tablecoil crosshair-table">${escapedRows}</table>`;
}

function parseAsciiInput(ascii) {
    const lines = ascii.split('\n').filter(line => line.trim());
    if (lines.length === 0) return '';

    // Simple ASCII table parser
    let tableHtml = '<table class="tablecoil crosshair-table">';

    lines.forEach((line, index) => {
        if (line.includes('+---') || line.includes('+===')) return; // Skip separator lines

        const cells = line.split('|').filter(cell => cell.trim());

        if (cells.length > 0) {
            tableHtml += '<tr id="test">';
            cells.forEach(cell => {
                const isHeader = index === 0 && line.toLowerCase().includes(cell.toLowerCase());
                tableHtml += isHeader ? `<th>${_escHtml(cell.trim())}</th>` : `<td>${_escHtml(cell.trim())}</td>`;
            });
            tableHtml += '</tr>';
        }
    });

    tableHtml += '</table>';
    return tableHtml;
}

// RFC 4180 compliant CSV tokeniser.
// Rules applied:
//   - Fields wrapped in " are quoted; they may contain commas and newlines
//   - "" inside a quoted field is a literal double-quote
//   - Single quotes are NOT qualifiers (treated as plain text)
//   - Unquoted field values are trimmed of surrounding whitespace
//   - Records separated by CRLF, LF, or bare CR; all three normalised
//   - Blank lines are skipped
function _parseRfc4180(csv) {
    const records = [];
    let pos = 0;
    const len = csv.length;

    while (pos < len) {
        const record = [];

        // Parse all fields in this record
        while (true) {
            let field = '';

            if (pos < len && csv[pos] === '"') {
                // Quoted field — consume until unescaped closing quote
                pos++; // skip opening "
                while (pos < len) {
                    if (csv[pos] === '"') {
                        if (pos + 1 < len && csv[pos + 1] === '"') {
                            field += '"'; // "" → literal "
                            pos += 2;
                        } else {
                            pos++; // consume closing "
                            break;
                        }
                    } else {
                        field += csv[pos++];
                    }
                }
                // Skip any junk between closing quote and next comma/EOL (non-spec)
                while (pos < len && csv[pos] !== ',' && csv[pos] !== '\r' && csv[pos] !== '\n') {
                    pos++;
                }
            } else {
                // Unquoted field — read until comma or line ending
                while (pos < len && csv[pos] !== ',' && csv[pos] !== '\r' && csv[pos] !== '\n') {
                    field += csv[pos++];
                }
                field = field.trim();
            }

            record.push(field);

            if (pos < len && csv[pos] === ',') {
                pos++; // comma → another field follows
            } else {
                break; // end of record
            }
        }

        // Consume line ending: \r\n, \n, or \r
        if (pos < len && csv[pos] === '\r') pos++;
        if (pos < len && csv[pos] === '\n') pos++;

        // Skip blank records (e.g. trailing newline)
        if (!(record.length === 1 && record[0] === '')) {
            records.push(record);
        }
    }

    return records;
}

function parseCsvInput(csv) {
    const records = _padDelimitedRows(_parseRfc4180(csv));
    if (records.length === 0) return '';

    let tableHtml = '<table class="tablecoil crosshair-table">';
    records.forEach((cells, index) => {
        tableHtml += '<tr id="test">';
        cells.forEach(cell => {
            tableHtml += index === 0 ? `<th>${_escHtml(cell)}</th>` : `<td>${_escHtml(cell)}</td>`;
        });
        tableHtml += '</tr>';
    });
    tableHtml += '</table>';
    return tableHtml;
}

function parseTextInput(text) {
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length === 0) return '';

    // Split on each delimiter rather than /\t+/: adjacent tabs represent an
    // intentional empty cell and must not collapse into one separator.
    const records = _padDelimitedRows(lines.map(line => line.replace(/\r$/, '').split('\t').map(cell => cell.trim())));

    let tableHtml = '<table class="tablecoil crosshair-table">';

    records.forEach((cells, index) => {
        if (cells.length > 0) {
            tableHtml += '<tr id="test">';
            cells.forEach(cell => {
                const isHeader = index === 0;
                tableHtml += isHeader ? `<th>${_escHtml(cell)}</th>` : `<td>${_escHtml(cell)}</td>`;
            });
            tableHtml += '</tr>';
        }
    });

    tableHtml += '</table>';
    return tableHtml;
}

/** Parse GitHub-Flavoured Markdown table:
 *  | H1 | H2 |
 *  | -- | -- |
 *  | v1 | v2 |
 */
function parseMarkdownInput(md) {
    const lines = md.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return '';

    let tableHtml = '<table class="tablecoil crosshair-table">';
    let headerDone = false;

    lines.forEach(line => {
        // Skip separator line (| --- | --- |)
        if (/^\|?[\s|:\-]+\|?$/.test(line)) return;

        const cells = line.split('|').map(c => c.trim()).filter((cell, i, a) => {
            // strip empty first/last cells produced by leading/trailing |
            return !(i === 0 && cell === '') && !(i === a.length - 1 && cell === '');
        });
        if (cells.length === 0) return;

        tableHtml += '<tr id="test">';
        cells.forEach(cell => {
            tableHtml += headerDone ? `<td>${_escHtml(cell)}</td>` : `<th>${_escHtml(cell)}</th>`;
        });
        tableHtml += '</tr>';
        headerDone = true;
    });

    tableHtml += '</table>';
    return tableHtml;
}

/** Parse JSON: array of objects or array of rows → table */
function parseJsonInput(json) {
    let data;
    try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) {
        if (typeof alert === 'function') alert('Invalid JSON: ' + e.message);
        return '';
    }

    // Support: array of objects, { table: [...] }, { table_1: [...], ... },
    // or wrapped objects like cws-netlist-v1 where the first key is metadata not data.
    if (!Array.isArray(data) && data && typeof data === 'object') {
        const arrayKey = Object.keys(data).find(k => Array.isArray(data[k]) && data[k].length > 0);
        data = arrayKey ? data[arrayKey] : [];
    }
    if (!Array.isArray(data) || data.length === 0) {
        if (typeof alert === 'function') alert('JSON must be an array of objects or rows.');
        return '';
    }

    // If array of arrays (cell grid or string grid)
    if (Array.isArray(data[0])) {
        let tableHtml = '<table class="tablecoil crosshair-table">';
        data.forEach((row, rIdx) => {
            tableHtml += '<tr id="test">';
            (Array.isArray(row) ? row : [row]).forEach((c) => {
                const isObj = c && typeof c === 'object';
                const tag = (isObj && c.header) || rIdx === 0 ? 'th' : 'td';
                let text = '';
                let colSpan = isObj && c.colSpan > 1 ? c.colSpan : 1;
                let rowSpan = isObj && c.rowSpan > 1 ? c.rowSpan : 1;
                if (isObj) {
                    text = c.text != null ? c.text : (c.value != null ? c.value : (c.content != null ? c.content : ''));
                } else if (c != null) {
                    text = String(c);
                }
                let attrs = '';
                if (colSpan > 1) attrs += ` colspan="${colSpan}"`;
                if (rowSpan > 1) attrs += ` rowspan="${rowSpan}"`;
                tableHtml += `<${tag}${attrs}>${_escHtml(text)}</${tag}>`;
            });
            tableHtml += '</tr>';
        });
        tableHtml += '</table>';
        return tableHtml;
    }

    const headers = Object.keys(data[0]);
    let tableHtml = '<table class="tablecoil crosshair-table"><tr id="test">';
    headers.forEach(h => { tableHtml += `<th>${_escHtml(h)}</th>`; });
    tableHtml += '</tr>';
    data.forEach(row => {
        tableHtml += '<tr id="test">';
        headers.forEach(h => {
            const val = row[h];
            let cellText = '';
            if (val && typeof val === 'object') {
                cellText = val.text != null ? val.text : (val.value != null ? val.value : (val.content != null ? val.content : ''));
            } else if (val !== undefined && val !== null) {
                cellText = String(val);
            }
            tableHtml += `<td>${_escHtml(cellText)}</td>`;
        });
        tableHtml += '</tr>';
    });
    tableHtml += '</table>';
    return tableHtml;
}

/** Parse SQL INSERT statements → table.
 *  Handles: INSERT INTO tbl (col1,col2) VALUES (v1,v2);
 */
function parseSqlInput(sql) {
    const insertRe = /INSERT\s+INTO\s+\S+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi;
    let match;
    let headers = null;
    const rows = [];

    while ((match = insertRe.exec(sql)) !== null) {
        if (!headers) {
            headers = match[1].split(',').map(c => c.trim().replace(/[`"']/g, ''));
        }
        const vals = match[2].split(',').map(v => v.trim().replace(/^'|'$/g, '').replace(/''/g, "'"));
        rows.push(vals);
    }

    if (!headers || rows.length === 0) {
        alert('No INSERT statements found in SQL input.');
        return '';
    }

    let tableHtml = '<table class="tablecoil crosshair-table"><tr id="test">';
    headers.forEach(h => { tableHtml += `<th>${_escHtml(h)}</th>`; });
    tableHtml += '</tr>';
    rows.forEach(row => {
        tableHtml += '<tr id="test">';
        headers.forEach((_, i) => { tableHtml += `<td>${_escHtml(row[i] !== undefined ? row[i] : '')}</td>`; });
        tableHtml += '</tr>';
    });
    tableHtml += '</table>';
    return tableHtml;
}

function formatHtml(html) {
    // Simple HTML formatter
    let formatted = '';
    const reg = /(>)(<)(\/*)/g;
    html = html.replace(reg, '$1\r\n$2$3');

    let pad = 0;
    html.split('\r\n').forEach(node => {
        let indent = 0;
        if (node.match(/.+<\/\w[^>]*>$/)) {
            indent = 0;
        } else if (node.match(/^<\/\w/) && pad > 0) {
            pad -= 1;
        } else if (node.match(/^<\w[^>]*[^\/]>.*$/)) {
            indent = 1;
        } else {
            indent = 0;
        }

        const padding = ''.repeat(pad * 4);
        formatted += padding + node + '\r\n';
        pad += indent;
    });

    return formatted;
}
