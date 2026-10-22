// ===================================================================================
// SHEET MANAGER; Excel-style sheet tabs for multi-table support
// ===================================================================================

window.sheets = [];
window.activeSheetId = null;
window._sheetCounter = 0;

// ── Table ids ─────────────────────────────────────────────────────────────
// Every table carries data-table-ide-id="t-<sheet>" (or t-<sheet>-<n> when a
// sheet holds several). Undo history, the node editor, and the all-sheets
// canvas all look tables up by this id, so it has to be unique across every
// sheet, not only within one. It is assigned once and never re-derived from
// position: renaming a sheet keeps its tables' ids, and so their history.

function _tableIdSlug(name) {
    const slug = String(name || '')
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return slug || 'sheet';
}

// Ids in use anywhere: the live DOM plus every sheet's stored html, since a
// sheet that is not mounted still owns its ids.
function _usedTableIds(extraHtml) {
    const used = new Set();
    const scan = html => {
        const re = /data-table-ide-id="([^"]*)"/g;
        let m;
        while ((m = re.exec(html || ''))) used.add(m[1]);
    };
    document.querySelectorAll('#tableContainer table[data-table-ide-id]').forEach(t => used.add(t.getAttribute('data-table-ide-id')));
    (window.sheets || []).forEach(s => { scan(s.rawHtml); scan(s.containerHtml); });
    scan(extraHtml);
    return used;
}

function allocTableId(base, used) {
    used = used || _usedTableIds();
    let id = base, n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return id;
}

/**
 * Give every table in html an id, keeping ids it already has unless another
 * table already owns them. Returns the rewritten html.
 */
function stampTableIds(html, sheet) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    const tables = tmp.querySelectorAll('table');
    if (!tables.length) return html;

    // Ids elsewhere, not counting this sheet's own copies of these tables.
    const own = new Set([...tables].map(t => t.getAttribute('data-table-ide-id')).filter(Boolean));
    const used = _usedTableIds();
    own.forEach(id => used.delete(id));

    const base = 't-' + _tableIdSlug(sheet && sheet.name);
    const seen = new Set();
    tables.forEach((t, i) => {
        const cur = t.getAttribute('data-table-ide-id');
        // A positional t-<n> is the pre-unification scheme: every sheet had a
        // t-0, so it is never safe to keep once sheets share a canvas.
        if (cur && !/^t-\d+$/.test(cur) && !used.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            return;
        }
        const id = allocTableId(tables.length > 1 ? `${base}-${i + 1}` : base, new Set([...used, ...seen]));
        t.setAttribute('data-table-ide-id', id);
        seen.add(id);
    });
    return tmp.innerHTML;
}

/**
 * The current, edited html for a sheet. Mounted canvas cards win, then the
 * live container for the active sheet, then the stored snapshot.
 */
function getSheetHtml(sheet) {
    if (!sheet) return '';
    if (window.SheetCanvas && window.SheetCanvas.isMounted()) {
        const live = window.SheetCanvas.sheetHtml(sheet.id);
        if (live != null) return live;
    } else if (sheet.id === window.activeSheetId) {
        const c = document.getElementById('tableContainer');
        if (c && c.querySelector('table')) return c.innerHTML;
    }
    return sheet.containerHtml || sheet.rawHtml || '';
}

window.stampTableIds = stampTableIds;
window.allocTableId  = allocTableId;
window.tableIdSlug   = _tableIdSlug;
window.getSheetHtml  = getSheetHtml;

/**
 * Add a new sheet with the given name and raw table HTML.
 * Automatically switches to the new sheet.
 */
function addSheet(name, rawHtml, meta) {
    // Save current sheet's container state before switching
    if (window.activeSheetId !== null) {
        _saveActiveSheetState();
    }

    const id = 'sheet-' + (++window._sheetCounter);
    const sheetName = name || ('Sheet ' + window._sheetCounter);
    rawHtml = stampTableIds(rawHtml, { name: sheetName });

    window.sheets.push({
        id: id,
        name: sheetName,
        rawHtml: rawHtml,
        containerHtml: null,  // populated when switching away from this sheet
        // Index-aligned with the <table> elements inside rawHtml (generateTabs
        // stamps them data-table-ide-id="t-0", "t-1", … in the same order), so
        // origins[i] is the exact region table i was extracted from. This is
        // what makes "send it back to where it came from" addressable instead
        // of a guess. Null for a sheet authored here with no upstream.
        origins: (meta && meta.origins) || null,
    });

    // Store raw html for decoupled tab count
    window.lastParsedHtml = rawHtml;

    renderSheetTabs();
    _activateSheet(id);
}

/**
 * Add a blank sheet manually.
 */
function addBlankSheet() {
    const blankTable = '<table class="tablecoil crosshair-table"><tr><th>Header 1</th><th>Header 2</th></tr><tr><td>Cell 1</td><td>Cell 2</td></tr></table>';
    addSheet('Sheet ' + (window._sheetCounter + 1), blankTable);
}

function loadNetlistAsSheets(netlist) {
    if (!netlist || !Array.isArray(netlist.components)) {
        $.toast({ heading: 'Table IDE', text: 'Invalid netlist format', icon: 'error', loader: false, stack: false });
        return;
    }
    const compRows = netlist.components.map(c => ({
        id: c.id || '', refdes: c.refdes || '', value: c.value || '',
        symbolType: c.symbolType || '', domain: c.domain || '',
        x: c.x != null ? String(c.x) : '', y: c.y != null ? String(c.y) : '',
    }));
    const connRows = (netlist.connections || []).map(e => ({
        id: e.id || '', from: e.from || '', to: e.to || '',
        color: e.color || '', length: e.length != null ? String(e.length) : '',
        signalType: e.signalType || '',
    }));
    if (compRows.length) addSheet('Components', parseJsonInput(JSON.stringify(compRows)));
    if (connRows.length) addSheet('Connections', parseJsonInput(JSON.stringify(connRows)));
    $.toast({
        heading: 'Schema Loaded',
        text: `${compRows.length} components, ${connRows.length} connections`,
        icon: 'success', loader: false, stack: false,
    });
}
window.loadNetlistAsSheets = loadNetlistAsSheets;

// Structured gx-tables/2 rows are a cell GRID ({text, colSpan, rowSpan,
// header}), not flat objects — parseJsonInput can't build this (one <td> per
// object key, no span attribute it ever writes). This is the other half of
// the fix: gx-tables-v1 sending a colspan and Table IDE having no path to render
// one back would have been the same loss with extra steps.
// Delegates to the shared renderer (`tableRender.js`), which the headless
// TableDriver loads too. Two implementations of "render a cell grid" would
// eventually disagree about a merged cell, which is the one thing this tool
// exists to preserve. The local fallback keeps a forked copy working if the
// file is not loaded, and it is deliberately the same code, not a simpler one.
function cellGridToTableHtml(rows) {
    if (window.GxTableRender) return window.GxTableRender.toHtml(rows).text;
    var html = '<table class="tablecoil crosshair-table">';
    (rows || []).forEach(function (row) {
        html += '<tr>';
        (Array.isArray(row) ? row : [row]).forEach(function (c) {
            var isObj = c && typeof c === 'object';
            var tag = (isObj && c.header) ? 'th' : 'td';
            var colSpan = isObj && c.colSpan > 1 ? c.colSpan : 1;
            var rowSpan = isObj && c.rowSpan > 1 ? c.rowSpan : 1;
            var text = '';
            if (isObj) {
                text = c.text != null ? c.text : (c.value != null ? c.value : (c.content != null ? c.content : ''));
            } else if (c != null) {
                text = String(c);
            }
            var attrs = '';
            if (colSpan > 1) attrs += ' colspan="' + colSpan + '"';
            if (rowSpan > 1) attrs += ' rowspan="' + rowSpan + '"';
            html += '<' + tag + attrs + '>' + _escHtml(text) + '</' + tag + '>';
        });
        html += '</tr>';
    });
    return html + '</table>';
}

/**
 * Build sheets from a gx-tables/2 (or legacy gx-tables-v1) payload — Schema
 * Editor's BOM/findings, PDF's extracted tables, or any tool sending tables
 * over CwsBridge. Accepts both schemas via window.GxTables.normalizeEnvelope
 * (root-injected, private — assets/os/tables.js) so a v1 payload still saved
 * on someone's disk from before this shipped keeps opening; when GxTables
 * isn't injected (forked standalone), falls back to the pre-2026-08-14e
 * flat-object path, which cannot render a merged cell — same limit it always
 * had, not a new one.
 */
function loadTablesAsSheets(payload) {
    var normalized = window.GxTables ? window.GxTables.normalizeEnvelope(payload) : null;
    // normalizeEnvelope passes an already-v2-tagged payload through AS IS — it
    // does not re-check it, because a payload this tool itself just built (the
    // send side) is already known-good and re-validating every local call would
    // be pure overhead. But this function's other caller is CwsBridge: a value
    // crossing a tool boundary, claiming a schema this receiver is about to
    // trust enough to write straight into `colspan`/`rowspan` HTML attributes.
    // validate() is what actually checks colSpan/rowSpan are integers before
    // any of it reaches cellGridToTableHtml — skipping it here would mean the
    // structural contract exists but nothing on the receiving end enforces it.
    if (normalized) {
        var errs = window.GxTables.validate(normalized);
        if (errs.length) {
            $.toast({
                heading: 'Tables rejected', text: errs[0] + (errs.length > 1 ? ' (+' + (errs.length - 1) + ' more)' : ''),
                icon: 'error', loader: false, stack: false,
            });
            return;
        }
    }
    var tables = normalized ? normalized.tables : ((payload && payload.tables) || []);

    // Group by SOURCE PAGE before creating sheets. Table IDE's model is a sheet per
    // page that may hold several tables (generateTabs already renders each
    // <table> as its own accordion card), so four tables selected off page 9
    // belong on one "Page 9" sheet — not scattered across four unrelated sheets
    // with nothing left to say they were ever related.
    //
    // Tables with no origin (authored elsewhere, or a pre-origin payload) can't
    // be grouped and each keep their own sheet, which is the old behaviour.
    var groups = [];
    var byKey = {};
    tables.forEach(function (t, i) {
        if (!Array.isArray(t.rows) || !t.rows.length) return;
        var page = t.origin && t.origin.page;
        var key = page != null ? ('page:' + page) : ('solo:' + i);
        if (!byKey[key]) {
            byKey[key] = {
                name: page != null ? ('Page ' + page) : (t.name || null),
                tables: [],
                origins: [],
            };
            groups.push(byKey[key]);
        }
        byKey[key].tables.push(t);
        byKey[key].origins.push(t.origin || null);
    });

    var added = 0;
    groups.forEach(function (g) {
        var html = g.tables.map(function (t) {
            if (Array.isArray(t.rows) && t.rows.length > 0 && Array.isArray(t.rows[0])) {
                return cellGridToTableHtml(t.rows);
            }
            return normalized ? cellGridToTableHtml(t.rows) : parseJsonInput(JSON.stringify(t.rows));
        }).join('');
        addSheet(g.name || ('Table ' + (window._sheetCounter + 1)), html,
            { origins: g.origins.some(Boolean) ? g.origins : null });
        added++;
    });
    $.toast({
        heading: (payload && payload.meta && payload.meta.title) || 'Tables received',
        text: added + ' sheet' + (added === 1 ? '' : 's') + ' added',
        icon: added ? 'success' : 'warning', loader: false, stack: false,
    });
}
window.loadTablesAsSheets = loadTablesAsSheets;

/**
 * Build sheets from a ginexys-diagram-v2 (or v1) payload received over CwsBridge.
 * v2 sheets: Components, Wires, Connections, Connectors, BOM, Hierarchy.
 * v1 falls back gracefully (no BOM/Hierarchy, no layer/path columns).
 */
function loadDiagramAsSheets(diagram) {
    var v2 = diagram?.schema === 'ginexys-diagram-v2';
    var v1 = diagram?.schema === 'ginexys-diagram-v1';
    if (!v2 && !v1) {
        $.toast({ heading: 'Table IDE', text: 'Invalid diagram format', icon: 'error', loader: false, stack: false });
        return;
    }
    var t = diagram.topology || {};

    // ── Components ─────────────────────────────────────────────
    // v2: adds layer column. Grouped elements arrive with type:"module".
    var comps = t.components || [];
    if (comps.length) {
        var compRows = comps.map(function(c) {
            var row = {
                id:     c.id                         || '',
                type:   c.type                       || '',
                symbol: c.symbol || c.symbolType || c.type || '',
                refdes: c.refdes                     || '',
                value:  c.value                      || '',
                domain: c.domain                     || '',
                x:      c.x      != null ? String(c.x) : '',
                y:      c.y      != null ? String(c.y) : '',
                bbox_w: c.bbox?.width  != null ? String(c.bbox.width)  : '',
                bbox_h: c.bbox?.height != null ? String(c.bbox.height) : '',
            };
            if (v2) row.layer = c.layer || '';
            return row;
        });
        addSheet('Components', parseJsonInput(JSON.stringify(compRows)));
    }

    // ── Wires ───────────────────────────────────────────────────
    // v2: adds path and layer columns.
    var wires = t.wires || [];
    if (wires.length) {
        var wireRows = wires.map(function(w) {
            var ep0 = w.endpoints?.[0];
            var ep1 = w.endpoints?.[1];
            var row = {
                id:        w.id        || '',
                color:     w.color     || '',
                width:     w.width  != null ? String(w.width) : '',
                length:    w.length != null ? String(Math.round(w.length)) : '',
                linearity: w.linearity != null ? String(w.linearity.toFixed(3)) : '',
                from_x:    ep0?.x != null ? String(ep0.x.toFixed(1)) : '',
                from_y:    ep0?.y != null ? String(ep0.y.toFixed(1)) : '',
                to_x:      ep1?.x != null ? String(ep1.x.toFixed(1)) : '',
                to_y:      ep1?.y != null ? String(ep1.y.toFixed(1)) : '',
            };
            if (v2) { row.path = w.path || ''; row.layer = w.layer || ''; }
            return row;
        });
        addSheet('Wires', parseJsonInput(JSON.stringify(wireRows)));
    }

    // ── Connections ────────────────────────────────────────────
    // v2: top-level topology.connections[]. v1: graph.edges fallback.
    var connEdges = v2 ? (t.connections || []) : (t.graph?.edges || []);
    if (connEdges.length) {
        var connRows = connEdges.map(function(e) {
            return {
                id:         e.id         || '',
                from:       e.from       || '',
                to:         e.to         || '',
                color:      e.color      || '',
                length:     e.length != null ? String(Math.round(e.length)) : '',
                signalType: e.signalType || '',
            };
        });
        addSheet('Connections', parseJsonInput(JSON.stringify(connRows)));
    }

    // ── Connectors ─────────────────────────────────────────────
    var connectors = t.connectors || [];
    if (connectors.length) {
        var pinRows = connectors.map(function(c) {
            return {
                id:     c.id || '',
                bbox_x: c.bbox?.x != null ? String(c.bbox.x.toFixed(1)) : '',
                bbox_y: c.bbox?.y != null ? String(c.bbox.y.toFixed(1)) : '',
            };
        });
        addSheet('Connectors', parseJsonInput(JSON.stringify(pinRows)));
    }

    // ── BOM (v2 only) ──────────────────────────────────────────
    // Aggregate component counts by symbol type.
    if (v2 && comps.length) {
        var bomMap = {};
        comps.forEach(function(c) {
            var key = c.symbol || c.type || 'unknown';
            bomMap[key] = (bomMap[key] || 0) + 1;
        });
        var bomRows = Object.keys(bomMap).sort().map(function(sym) {
            return { symbol: sym, count: String(bomMap[sym]) };
        });
        if (bomRows.length) addSheet('BOM', parseJsonInput(JSON.stringify(bomRows)));
    }

    // ── Hierarchy (v2 only) ────────────────────────────────────
    // User-defined layer groups from Structure view.
    if (v2) {
        var groups = diagram.structure?.groups || [];
        if (groups.length) {
            var hierRows = groups.map(function(g) {
                return {
                    id:       g.id   || '',
                    name:     g.name || '',
                    type:     'module',
                    children: (g.children || []).join(', '),
                };
            });
            addSheet('Hierarchy', parseJsonInput(JSON.stringify(hierRows)));
        }
    }

    var sheetCount = comps.length + wires.length + connEdges.length;
    $.toast({
        heading: 'Diagram Loaded',
        text: (v2 ? '[v2] ' : '[v1] ') +
              comps.length + ' components · ' +
              wires.length + ' wires · ' +
              connEdges.length + ' connections',
        icon: 'success', loader: false, stack: false,
    });
}
window.loadDiagramAsSheets = loadDiagramAsSheets;

/**
 * Switch to a different sheet by id.
 */
function switchSheet(id) {
    if (id === window.activeSheetId) return;

    // Save current sheet state
    _saveActiveSheetState();

    window.lastParsedHtml = null; // reset before activating
    _activateSheet(id);
}

/**
 * Make a sheet active without moving the view. Used when the user clicks into
 * a table on the all-sheets canvas: the table's sheet becomes the one the
 * tabs, history and exports refer to, but the canvas stays where it is.
 */
function setActiveSheetQuiet(id) {
    if (id === window.activeSheetId) return;
    const sheet = window.sheets.find(s => s.id === id);
    if (!sheet) return;
    window.activeSheetId = id;
    window.lastParsedHtml = sheet.rawHtml;
    renderSheetTabs();
    if (typeof window.syncHistoryButtons === 'function') window.syncHistoryButtons();
}
window.setActiveSheetQuiet = setActiveSheetQuiet;

/**
 * Rename a sheet (called on dblclick).
 */
function renameSheet(id, newName) {
    const sheet = window.sheets.find(s => s.id === id);
    if (!sheet || !newName.trim()) return;
    sheet.name = newName.trim();
    renderSheetTabs();
}

/**
 * Delete a sheet. Switches to adjacent sheet if active.
 */
function deleteSheet(id) {
    if (window.sheets.length <= 1) {
        $.toast({ heading: 'Sheet', text: 'Cannot delete the only sheet', icon: 'warning', loader: false, stack: false });
        return;
    }

    const idx = window.sheets.findIndex(s => s.id === id);
    if (idx === -1) return;

    const wasActive = (id === window.activeSheetId);
    window.sheets.splice(idx, 1);
    if (window.SheetCanvas && window.SheetCanvas.isMounted()) window.SheetCanvas.removeSheetCards(id);

    if (typeof window.clearSheetHistory === 'function') window.clearSheetHistory(id);

    if (wasActive) {
        // Switch to adjacent sheet
        const nextSheet = window.sheets[Math.min(idx, window.sheets.length - 1)];
        window.activeSheetId = null;
        window.lastParsedHtml = null;
        renderSheetTabs();
        _activateSheet(nextSheet.id);
    } else {
        renderSheetTabs();
    }
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

function _saveActiveSheetState() {
    // Every sheet is live on the canvas, so every sheet can have unsaved edits.
    if (window.SheetCanvas && window.SheetCanvas.isMounted()) {
        window.SheetCanvas.saveAll();
        return;
    }
    if (window.activeSheetId === null) return;
    const sheet = window.sheets.find(s => s.id === window.activeSheetId);
    if (sheet) {
        sheet.containerHtml = $('#tableContainer').html();
    }
}

function _activateSheet(id) {
    const sheet = window.sheets.find(s => s.id === id);
    if (!sheet) return;

    window.activeSheetId = id;
    window.lastParsedHtml = sheet.rawHtml;

    // All sheets are already on the canvas: nothing to swap in, just point
    // the view at this one. A sheet added while mounted has no cards yet and
    // gets them here.
    if (window.SheetCanvas && window.SheetCanvas.isMounted()) {
        window.SheetCanvas.ensureSheetCards(id);
        window.currentTable = window.SheetCanvas.firstTable(id) || null;
        renderSheetTabs();
        window.SheetCanvas.focusSheet(id);
        if (typeof window.syncHistoryButtons === 'function') window.syncHistoryButtons();
        return;
    }

    if (sheet.containerHtml) {
        // Restore previously saved container state
        $('#tableContainer').html(sheet.containerHtml);
        window.currentTable = $('#tableContainer table')[0] || null;
        initializeAllFeatures();
        setupTableInteraction();
    } else {
        // First time loading this sheet; render via generateTabs
        generateTabs(sheet.rawHtml);
        window.currentTable = $('#tableContainer table')[0] || null;
        initializeAllFeatures();
        setupTableInteraction();
        window.saveCurrentState();
    }

    renderSheetTabs();
    if (typeof window.syncHistoryButtons === 'function') window.syncHistoryButtons();
}

/**
 * Re-render the sheet tab bar DOM.
 */
function renderSheetTabs() {
    // Frames carry the sheet name and the active highlight.
    if (window.SheetCanvas && window.SheetCanvas.isMounted()) window.SheetCanvas.renderFrames();

    let $bar = $('#sheetTabBar');
    if (!$bar.length) return;

    $bar.empty();

    window.sheets.forEach(function (sheet) {
        const isActive = sheet.id === window.activeSheetId;
        const $tab = $('<div>')
            .addClass('sheet-tab' + (isActive ? ' active' : ''))
            .attr('data-sheet-id', sheet.id);

        const $label = $('<span>')
            .addClass('sheet-tab-label')
            .text(sheet.name);

        const $close = $('<button>')
            .addClass('sheet-tab-close')
            .attr('title', 'Delete sheet')
            .html('&times;');

        $tab.append($label).append($close);
        $bar.append($tab);

        // Switch on click
        $tab.on('click', function (e) {
            if (!$(e.target).hasClass('sheet-tab-close')) {
                switchSheet(sheet.id);
            }
        });

        // Rename on dblclick
        $label.on('dblclick', function (e) {
            e.stopPropagation();
            const currentName = sheet.name;
            $label.attr('contenteditable', 'true').focus();
            // Select all text
            const range = document.createRange();
            range.selectNodeContents($label[0]);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);

            $label.one('blur keydown', function (ev) {
                if (ev.type === 'blur' || ev.key === 'Enter') {
                    ev.preventDefault();
                    const newName = $label.text().trim() || currentName;
                    $label.removeAttr('contenteditable');
                    renameSheet(sheet.id, newName);
                } else if (ev.key === 'Escape') {
                    $label.text(currentName).removeAttr('contenteditable');
                }
            });
        });

        // Delete on close button click
        $close.on('click', function (e) {
            e.stopPropagation();
            deleteSheet(sheet.id);
        });
    });

    // "+" add blank sheet button
    const $addBtn = $('<button>')
        .addClass('sheet-tab-add')
        .attr('title', 'Add blank sheet')
        .text('+');
    $addBtn.on('click', addBlankSheet);
    $bar.append($addBtn);
}
