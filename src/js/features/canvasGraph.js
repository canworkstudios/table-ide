// ===================================================================================
// CANVAS GRAPH; the node editor running on the table canvas
// ===================================================================================
//
// Tables and operator nodes share one surface. A table card IS a graph node:
// its node id is the table's data-table-ide-id (t-<sheet>), it gets one output
// connector, and its columns are read from the live <table> whenever the graph
// needs them (a run, or opening a node's config). There is no second copy of
// the data, so nothing has to be loaded into the graph or written back out.
//
// A table has ONE connector, not one per column: the executor hands every
// column of a source table to whatever it is wired to, so a per-column port
// only ever chose where the wire was drawn from.
//
// This module attaches the node editor's renderer (wires, minimap, marquee) and
// interaction manager to the table canvas viewport, keeps table nodes in step
// with the cards, and implements Combine.

(function () {
    'use strict';

    let attached = false;

    const graph = () => window.NodeGraph;
    const cards = () => (window.SheetCanvas ? window.SheetCanvas.cards() : $());

    // ── Table nodes ────────────────────────────────────────────────────────────

    // Columns of a table as columnar headers: first row is the labels, the
    // rest is data. Read by cell index, so a merged cell counts once.
    function _headersFromTable(table, nodeId) {
        const rows = Array.from(table.rows || []);
        if (!rows.length) return [];
        const width = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
        const text = c => (c ? c.textContent.trim() : '');
        const headers = [];
        for (let i = 0; i < width; i++) {
            headers.push({
                portId:    `${nodeId}:c${i}`,
                label:     text(rows[0].cells[i]) || `Column ${i + 1}`,
                values:    rows.slice(1).map(r => text(r.cells[i])),
                cellIds:   [],
                direction: 'out',
            });
        }
        return headers;
    }

    function _labelFor(card, tableIndex, tableCount) {
        const sheet = (window.sheets || []).find(s => s.id === card.dataset.sheetId);
        const name = sheet ? sheet.name : 'Table';
        return tableCount > 1 ? `${name} · Table ${tableIndex + 1}` : name;
    }

    function _ensurePort(card, nodeId) {
        let port = card.querySelector(':scope > .tf-card-port');
        if (!port) {
            port = document.createElement('div');
            port.className = 'ne-port ne-port-out tf-card-port';
            port.title = 'Drag to connect this table to a node';
            card.appendChild(port);
        }
        port.dataset.portId = `${nodeId}-out`;
    }

    // Bring table nodes in line with the cards on the canvas: create a node for
    // every card, refresh columns and geometry, and drop nodes whose table is
    // gone (removeNode takes their wires with them).
    function syncTableNodes() {
        if (!window.SheetCanvas || !window.SheetCanvas.isMounted()) return;
        const nodes = graph().nodes;
        const seen = new Set();
        const perSheet = {};
        cards().each(function () { perSheet[this.dataset.sheetId] = (perSheet[this.dataset.sheetId] || 0) + 1; });
        const indexInSheet = {};

        cards().each(function () {
            const table = this.querySelector('table');
            const id = table && table.getAttribute('data-table-ide-id');
            if (!id) return;
            seen.add(id);
            this.dataset.nodeId = id;
            _ensurePort(this, id);

            const idx = indexInSheet[this.dataset.sheetId] = (indexInSheet[this.dataset.sheetId] ?? -1) + 1;
            const fields = {
                label:         _labelFor(this, idx, perSheet[this.dataset.sheetId]),
                x:             parseFloat(this.dataset.tfX) || 0,
                y:             parseFloat(this.dataset.tfY) || 0,
                width:         this.offsetWidth,
                height:        this.offsetHeight,
                headers:       _headersFromTable(table, id),
                sourceSheetId: this.dataset.sheetId,
                sourceTableId: id,
            };
            if (nodes[id]) {
                Object.assign(nodes[id], fields);
            } else {
                nodes[id] = Object.assign({
                    id, nodeType: 'table', tableBacked: true, collapsed: false, selected: false,
                    config: {}, execState: 'idle', execError: null,
                }, fields);
            }
            this.classList.toggle('selected', !!nodes[id].selected);
        });

        Object.values(nodes).forEach(n => {
            if (n.tableBacked && !seen.has(n.id)) window.nodeGraphManager.removeNode(n.id);
        });
        _markDirty();
        _updateCombineButton();
    }

    // Cheap per-frame update while cards move or resize: geometry only.
    function refreshGeometry() {
        const nodes = graph().nodes;
        cards().each(function () {
            const n = nodes[this.dataset.nodeId];
            if (!n) return;
            n.x = parseFloat(this.dataset.tfX) || 0;
            n.y = parseFloat(this.dataset.tfY) || 0;
            n.width = this.offsetWidth;
            n.height = this.offsetHeight;
        });
        _markDirty();
    }

    function _markDirty() {
        if (!window.nodeCanvasRenderer) return;
        window.nodeCanvasRenderer.markStaticDirty();
    }

    // ── Attach / detach ────────────────────────────────────────────────────────

    function attach(viewportEl) {
        if (attached || !window.nodeCanvasRenderer || !window.nodeInteractionManager) return;
        attached = true;

        window.nodeCanvasRenderer.init();
        window.nodeCanvasRenderer.start();
        window.nodeInteractionManager.init(viewportEl, {
            wheel: false,
            onViewportChange: () => window.TableCanvas && window.TableCanvas.applyTransform(),
            onNodesMoving:    ids => window.SheetCanvas.syncCardPositions(ids, false),
            onNodesMoved:     ids => { window.SheetCanvas.syncCardPositions(ids, true); refreshGeometry(); },
            onSelectionChange: _updateCombineButton,
        });

        syncTableNodes();
        // Operator nodes live only in the graph while the canvas is off.
        Object.values(graph().nodes).forEach(n => {
            if (!n.tableBacked && typeof window.renderNodeDom === 'function') window.renderNodeDom(n.id);
        });
        _markDirty();
    }

    function detach() {
        if (!attached) return;
        attached = false;
        if (window.nodeConfigPanel && typeof window.nodeConfigPanel.close === 'function') {
            const panel = document.getElementById('neConfigPanel');
            if (panel && panel.style.display !== 'none') window.nodeConfigPanel.close();
        }
        window.nodeInteractionManager.destroy();
        window.nodeCanvasRenderer.stop();
    }

    // ── Sheet drag (frame label) ───────────────────────────────────────────────

    function dragSheet(sheetId, $sheetCards, e) {
        if (!attached || !$sheetCards.length) return;
        refreshGeometry();
        const im = window.nodeInteractionManager;
        window.nodeGraphManager.deselectAll();
        $sheetCards.each(function () {
            const n = graph().nodes[this.dataset.nodeId];
            if (n) n.selected = true;
        });
        im._updateSelectionVisuals();
        im._startNodeDrag($sheetCards[0], e);
        _markDirty();
    }

    // ── Combine ────────────────────────────────────────────────────────────────

    function _selectedTables() {
        return window.nodeGraphManager.getSelectedNodes().filter(n => n.tableBacked);
    }

    function _updateCombineButton() {
        const n = _selectedTables().length;
        $('#neCombine').prop('disabled', n < 2)
            .attr('title', n < 2
                ? 'Select two or more tables to combine: drag a box around them, or Ctrl+A'
                : `Stack the ${n} selected tables into one Combined sheet`);
    }

    // Wire every selected table into a new Append node, run it, and build the
    // result as a new "Combined" sheet. The Append node stays on the canvas,
    // so re-running after an edit and Build Table give an updated copy.
    async function combineSelected() {
        syncTableNodes();
        const sheetOrder = id => (window.sheets || []).findIndex(s => s.id === id);
        const tables = _selectedTables().sort((a, b) =>
            (sheetOrder(a.sourceSheetId) - sheetOrder(b.sourceSheetId)) || (a.y - b.y) || (a.x - b.x));
        if (tables.length < 2) {
            $.toast({ heading: 'Combine', text: 'Select two or more tables: drag a box around them, or Ctrl+A.', icon: 'info', loader: false, stack: false });
            return;
        }

        const maxX = Math.max(...tables.map(t => t.x + (t.width || 0)));
        const minY = Math.min(...tables.map(t => t.y));
        const id = window.nodeGraphManager.addNode('Combined', maxX + 120, minY,
            window.NodeTypes.defaultHeaders('append'), 'append', window.NodeTypes.defaultConfig('append'));
        tables.forEach(t => window.nodeGraphManager.addWire(t.id, `${t.id}-out`, id, 'append-in'));

        window.nodeGraphManager.deselectAll();
        graph().nodes[id].selected = true;
        window.renderNodeDom(id);
        window.nodeInteractionManager._updateSelectionVisuals();
        _markDirty();

        await window.nodeExecutor.run();

        const node = graph().nodes[id];
        if (!node || node.execState !== 'done') return;
        if (typeof addSheet === 'function') {
            addSheet('Combined', window.nodeOutputTableHtml(node));
            $.toast({ heading: 'Combine', text: `${tables.length} tables stacked into the Combined sheet`, icon: 'success', loader: false, stack: false });
        }
    }

    $(function () {
        $('#neCombine').on('click', combineSelected);
    });

    window.CanvasGraph = { attach, detach, syncTableNodes, refreshGeometry, dragSheet, combineSelected };
})();
