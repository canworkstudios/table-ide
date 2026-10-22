// ===================================================================================
// NODE EDITOR; Main Controller
//   — Mode toggle (now an alias for the table canvas)
//   — DOM rendering for operator node cards
//   — Build Table, history integration, toolbar wiring
//
// Table nodes are the table cards themselves (see canvasGraph.js). Their data
// is read from the live table at run time, so there is no copy to load on
// enable or write back on disable.
// ===================================================================================

window.nodeEditorEnabled   = false;

// ──────────────────────────────────────────────────────────────────────────────
// Enable / Disable
// ──────────────────────────────────────────────────────────────────────────────

// The node editor no longer has its own view. Tables and operator nodes share
// the table canvas (tableCanvas.js + canvasGraph.js), so "Node Editor on" means
// "canvas on". These stay as the public entry points because lab mode, draw
// mode, the equation editor and the ?view=node-editor deep link all call them.
function enableNodeEditor() {
    if (window.nodeEditorEnabled) return;
    if (window.labModeEnabled && typeof disableLab === 'function') disableLab();
    if (window.TableCanvas) window.TableCanvas.setOn(true);
}

function disableNodeEditor() {
    if (!window.nodeEditorEnabled) return;
    if (window.TableCanvas) window.TableCanvas.setOn(false);
}

function toggleNodeEditor() {
    if (window.nodeEditorEnabled) disableNodeEditor();
    else enableNodeEditor();
}

// Shared helper: read one cell value from a header at row r
// Columnar headers (operator output): h.values[r]
// CellStore headers (source/table nodes): csm.get(h.cellIds[r])
function _nodeVal(h, r, csm) {
    if (h.values) return String(h.values[r] ?? '');
    const id = (h.cellIds || [])[r];
    const cell = id ? csm.get(id) : null;
    return cell ? cell.value : '';
}

function _esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ──────────────────────────────────────────────────────────────────────────────
// DOM Rendering — Node Cards
// ──────────────────────────────────────────────────────────────────────────────

const MAX_VISIBLE_ROWS = 8;

function renderNodeDom(nodeId) {
    const node = window.NodeGraph.nodes[nodeId];
    if (!node) return;
    // A table node IS its table card on the canvas; there is no separate
    // node DOM to draw, and removing "the old one" would delete the card.
    if (node.tableBacked) return;

    const htmlLayer = document.getElementById('nodeHtmlLayer');
    if (!htmlLayer) return;

    // Remove previous DOM for this node if it exists
    const old = htmlLayer.querySelector(`[data-node-id="${nodeId}"]`);
    if (old) old.remove();

    const csm        = window.cellStoreManager;
    const collapsed  = node.collapsed;
    const nodeType   = node.nodeType || 'table';
    const typeDef    = window.NodeTypes ? window.NodeTypes.get(nodeType) : null;
    const isOperator = window.NodeTypes ? window.NodeTypes.isOperator(nodeType) : false;

    // ── Header rows (port row per column) — direction-aware
    //
    //  Columns carrying an `outputGroup` are rendered under a group heading, so
    //  a node with several named outputs reads as several tables rather than
    //  one long column list. Wiring from any port inside a group carries that
    //  group's columns (see _readSourcePort in nodeExecutor.js).
    let headerRowsHtml = '';
    let lastGroup = undefined;
    node.headers.forEach(h => {
        if (h.outputGroup !== lastGroup) {
            lastGroup = h.outputGroup;
            if (h.outputGroup) {
                headerRowsHtml += `
            <div class="ne-node-group-heading" title="Output: ${_esc(h.groupLabel || h.outputGroup)}">${_esc(h.groupLabel || h.outputGroup)}</div>`;
            }
        }
        const dir = h.direction || (isOperator ? 'in' : 'inout');
        const showIn  = dir === 'in'  || dir === 'inout';
        const showOut = dir === 'out' || dir === 'inout';
        const inPort  = showIn
            ? `<div class="ne-port ne-port-in"  data-port-id="${h.portId}"     title="In: ${_esc(h.label)}"></div>`
            : `<div class="ne-port-spacer"></div>`;
        const outPort = showOut
            ? `<div class="ne-port ne-port-out" data-port-id="${h.portId}-out" title="Out: ${_esc(h.label)}"></div>`
            : `<div class="ne-port-spacer"></div>`;

        headerRowsHtml += `
            <div class="ne-node-row ne-node-col-row">
                ${inPort}
                <span class="ne-cell-label" title="${_esc(h.label)}">${_esc(h.label)}</span>
                ${outPort}
            </div>`;
    });

    // ── Data rows (up to MAX_VISIBLE_ROWS, only for table nodes or done operator nodes)
    //
    //  With named outputs the headers belong to different tables with different
    //  row counts, so a single row strip across all of them would interleave
    //  unrelated data. Preview the FIRST group only; the rest are reachable by
    //  wiring their ports, and the group headings above name them.
    let dataRowsHtml = '';
    const groupNames  = [...new Set(node.headers.map(h => h.outputGroup).filter(Boolean))];
    const previewCols = groupNames.length
        ? node.headers.filter(h => h.outputGroup === groupNames[0])
        : node.headers;

    if (!collapsed && previewCols.length > 0) {
        // rowCount: check h.values (columnar/operator headers) or h.cellIds (source/table headers)
        const rowCount    = previewCols.reduce((m, h) => Math.max(m, (h.values || h.cellIds || []).length), 0);
        const displayRows = Math.min(rowCount, MAX_VISIBLE_ROWS);

        for (let r = 0; r < displayRows; r++) {
            dataRowsHtml += '<div class="ne-node-data-row">';
            previewCols.forEach(h => {
                let val    = '';
                let cellId = '';
                if (h.values) {
                    // Columnar path — operator output, read directly from array
                    val = _esc(String(h.values[r] ?? ''));
                } else {
                    // CellStore path — source/table node
                    cellId = (h.cellIds || [])[r] || '';
                    const cell = cellId ? csm.get(cellId) : null;
                    val = cell ? _esc(cell.value) : '';
                }
                dataRowsHtml += `<span class="ne-cell-value" data-cell-id="${cellId}" title="${val}">${val || '<em class="ne-cell-empty">—</em>'}</span>`;
            });
            dataRowsHtml += '</div>';
        }

        if (rowCount > MAX_VISIBLE_ROWS) {
            dataRowsHtml += `<div class="ne-node-overflow-hint">+${rowCount - MAX_VISIBLE_ROWS} more rows</div>`;
        }
    }

    // ── Exec state badge
    const execState  = node.execState || 'idle';
    const execBadges = { idle: '', running: '<span class="ne-exec-badge ne-exec-running">●</span>', done: '<span class="ne-exec-badge ne-exec-done">✓</span>', error: '<span class="ne-exec-badge ne-exec-error" title="' + _esc(node.execError || '') + '">✕</span>' };
    const execBadge  = execBadges[execState] || '';

    // ── Type badge (operator nodes only)
    const typeBadge = typeDef && isOperator
        ? `<span class="ne-type-badge" style="background:${typeDef.color}" title="${_esc(typeDef.description)}">${typeDef.icon} ${typeDef.label}</span>`
        : '';

    // Both the config button and the placeholder below key off this, so it is
    // computed once — two copies of the scan drift apart the moment one changes.
    const hasInputWire = Object.values(window.NodeGraph.wires || {}).some(
        w => w.targetNodeId === nodeId
    );

    // ── Config button (operator nodes only) — disabled until at least one input wire exists
    let configBtn = '';
    if (isOperator) {
        configBtn = hasInputWire
            ? `<button class="ne-node-config-btn" title="Configure node">⚙</button>`
            : `<button class="ne-node-config-btn ne-config-btn-disabled" title="Connect a source table first" disabled>⚙</button>`;
    }

    // ── Operator placeholder when idle/running and no input wires yet
    let operatorPlaceholder = '';
    if (isOperator && !collapsed && (execState === 'idle' || execState === 'running')) {
        if (!hasInputWire) {
            operatorPlaceholder = `<div class="ne-operator-placeholder">Wire a table's output port here, then ⚙ configure</div>`;
        } else if (node.headers.filter(h => h.direction === 'out').length === 0) {
            operatorPlaceholder = `<div class="ne-operator-placeholder">${execState === 'running' ? 'Running…' : 'Configure ⚙ then click ▶ Run'}</div>`;
        }
    }

    // ── Build element
    const el = document.createElement('div');
    el.className = [
        'ne-node',
        node.selected  ? 'selected'  : '',
        collapsed      ? 'collapsed' : '',
        isOperator     ? 'ne-operator' : '',
        `ne-type-${nodeType}`,
        execState !== 'idle' ? `ne-exec-${execState}` : ''
    ].filter(Boolean).join(' ');

    el.dataset.nodeId   = nodeId;
    el.dataset.nodeType = nodeType;
    el.style.cssText    = `left:${node.x}px; top:${node.y}px; width:${node.width || 280}px;`;

    el.innerHTML = `
        <div class="ne-node-header">
            <span class="ne-node-collapse-btn" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▶' : '▼'}</span>
            ${typeBadge}
            <span class="ne-node-label" title="${_esc(node.label)}">${_esc(node.label)}</span>
            ${execBadge}
            <span class="ne-node-meta">${node.headers.length} col${node.headers.length !== 1 ? 's' : ''}</span>
            ${configBtn}
            <button class="ne-node-delete-btn" title="Remove node">✕</button>
        </div>
        <div class="ne-node-body${collapsed ? ' ne-hidden' : ''}">
            <div class="ne-node-col-rows">${headerRowsHtml}</div>
            ${operatorPlaceholder}
            <div class="ne-node-data-rows">${dataRowsHtml}</div>
        </div>`;

    htmlLayer.appendChild(el);
}

window.renderNodeDom = renderNodeDom;

// Every table on the canvas is already a node, so this only has to make sure
// the canvas is on and the graph has caught up. Kept for the MCP
// `add_sheet_node` verb.
function addCurrentSheetAsNode() {
    enableNodeEditor();
    if (window.CanvasGraph) window.CanvasGraph.syncTableNodes();
}
window.addCurrentSheetAsNode = addCurrentSheetAsNode;

// ──────────────────────────────────────────────────────────────────────────────
// Build Table from selected node (toolbar button: "Build Table")
// ──────────────────────────────────────────────────────────────────────────────

// A node's output columns as table HTML. Shared by Build Table and Combine.
function nodeOutputTableHtml(node) {
    const csm = window.cellStoreManager;

    // maxRows: check h.values (columnar) or h.cellIds (CellStore) length
    const maxRows = node.headers.reduce((m, h) => Math.max(m, (h.values || h.cellIds || []).length), 0);

    // Only output 'out' or 'inout' columns — skip structural 'in' ports (e.g. join-in-left)
    const outputHeaders = node.headers.filter(h => h.direction !== 'in');

    let html = '<table class="tablecoil crosshair-table"><thead><tr>';
    outputHeaders.forEach(h => { html += `<th>${_esc(h.label)}</th>`; });
    html += '</tr></thead><tbody>';
    for (let r = 0; r < maxRows; r++) {
        html += '<tr>';
        outputHeaders.forEach(h => { html += `<td>${_esc(_nodeVal(h, r, csm))}</td>`; });
        html += '</tr>';
    }
    return html + '</tbody></table>';
}
window.nodeOutputTableHtml = nodeOutputTableHtml;

function buildTableFromSelectedNode() {
    const selected = window.nodeGraphManager.getSelectedNodes();
    if (selected.length === 0) {
        $.toast({ heading: 'Node Editor', text: 'Select a node first', icon: 'warning', loader: false, stack: false });
        return;
    }

    const node = selected[0];
    const html = nodeOutputTableHtml(node);

    if (typeof addSheet === 'function') {
        addSheet(node.label + ' (node)', html);
        $.toast({ heading: 'Node Editor', text: `Table built from "${node.label}"`, icon: 'success', loader: false, stack: false });
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Fit to view (toolbar button)
// ──────────────────────────────────────────────────────────────────────────────

function fitNodeView() {
    if (window.TableCanvas) window.TableCanvas.fitToContent();
}

// ──────────────────────────────────────────────────────────────────────────────
// History integration
// ──────────────────────────────────────────────────────────────────────────────

function saveNodeEditorState() {
    if (!window.nodeEditorEnabled) return;
    if (!window.historyManager || window.historyManager.isRestoring) return;

    const state = JSON.stringify({
        type:      'nodeEditor',
        graph:     window.nodeGraphManager.snapshot(),
        cellStore: window.cellStoreManager.snapshot()
    });
    window.historyManager.saveState(state);
}

window.saveNodeEditorState = saveNodeEditorState;

// ──────────────────────────────────────────────────────────────────────────────
// Theme change listener
// ──────────────────────────────────────────────────────────────────────────────

// bridge.js receives the raw `cws:theme-change` postMessage and re-dispatches it
// as this CustomEvent, so listening here covers both the bridge and direct hosts.
window.addEventListener('cws-theme-change', function () {
    if (window.nodeEditorEnabled && window.nodeCanvasRenderer) {
        window.nodeCanvasRenderer.onThemeChange();
    }
});

// ──────────────────────────────────────────────────────────────────────────────
// Init (wires up toolbar buttons — called from tableIde.js)
// ──────────────────────────────────────────────────────────────────────────────

function initNodeEditor() {
    $('#nodeEditorToggle').on('click',  toggleNodeEditor);
    $('#neExit').on('click',           disableNodeEditor);
    $('#neFitView').on('click',        fitNodeView);
    $('#neBuildTable').on('click',     buildTableFromSelectedNode);
    $('#neRunGraph').on('click',       () => window.nodeExecutor.run());
    $('#neResetRun').on('click',       () => window.nodeExecutor.resetRunState());

    // Palette + config panel
    if (typeof window.nodePaletteInit === 'function') window.nodePaletteInit();
    if (typeof window.nodeConfigPanel !== 'undefined') window.nodeConfigPanel.init();
}
