// ===================================================================================
// NODE GRAPH; Data model for nodes, wires, ports, and viewport state
// ===================================================================================

window.NodeGraph = {
    nodes: {},
    wires: {},
    viewport: { x: 0, y: 0, zoom: 1 }
};

class NodeGraphManager {
    constructor() {
        this.graph = window.NodeGraph;
    }

    // ── Nodes ──────────────────────────────────────────────────────────────────

    addNode(label, x, y, headers = [], nodeType = 'table', config = {}) {
        const id = 'node-' + crypto.randomUUID().slice(0, 8);
        this.graph.nodes[id] = {
            id,
            label,
            x,
            y,
            width: 280,
            collapsed: false,
            selected: false,
            headers,   // [{ portId, label, cellIds: [], direction: 'inout'|'in'|'out' }]
            sourceSheetId: null,
            nodeType,
            config,
            execState: 'idle',   // 'idle' | 'running' | 'done' | 'error'
            execError: null
        };
        return id;
    }

    removeNode(nodeId) {
        // Collect the other-end node IDs before deleting wires
        const affectedNodes = new Set();
        Object.keys(this.graph.wires).forEach(wireId => {
            const wire = this.graph.wires[wireId];
            if (wire.sourceNodeId === nodeId) affectedNodes.add(wire.targetNodeId);
            if (wire.targetNodeId === nodeId) affectedNodes.add(wire.sourceNodeId);
        });

        // Remove all wires connected to this node
        Object.keys(this.graph.wires).forEach(wireId => {
            const wire = this.graph.wires[wireId];
            if (wire.sourceNodeId === nodeId || wire.targetNodeId === nodeId) {
                this.removeWire(wireId);
            }
        });

        // Release all cell references
        const node = this.graph.nodes[nodeId];
        if (node) {
            node.headers.forEach(header => {
                header.cellIds.forEach(cellId => window.cellStoreManager.release(cellId));
            });
        }

        delete this.graph.nodes[nodeId];

        // Re-render affected nodes so their ⚙ button state updates
        affectedNodes.forEach(affectedId => {
            if (this.graph.nodes[affectedId] && typeof window.renderNodeDom === 'function') {
                window.renderNodeDom(affectedId);
            }
        });
    }

    moveNode(nodeId, x, y) {
        if (this.graph.nodes[nodeId]) {
            this.graph.nodes[nodeId].x = x;
            this.graph.nodes[nodeId].y = y;
        }
    }

    toggleCollapse(nodeId) {
        if (this.graph.nodes[nodeId]) {
            this.graph.nodes[nodeId].collapsed = !this.graph.nodes[nodeId].collapsed;
        }
    }

    selectNode(nodeId, addToSelection = false) {
        if (!addToSelection) {
            Object.values(this.graph.nodes).forEach(n => { n.selected = false; });
        }
        if (this.graph.nodes[nodeId]) {
            this.graph.nodes[nodeId].selected = true;
        }
    }

    deselectAll() {
        Object.values(this.graph.nodes).forEach(n => { n.selected = false; });
    }

    getSelectedNodes() {
        return Object.values(this.graph.nodes).filter(n => n.selected);
    }

    // ── Wires ──────────────────────────────────────────────────────────────────

    addWire(sourceNodeId, sourcePortId, targetNodeId, targetPortId, type = 'link') {
        if (sourceNodeId === targetNodeId) return null;

        const duplicate = Object.values(this.graph.wires).find(w =>
            w.sourceNodeId === sourceNodeId && w.sourcePortId === sourcePortId &&
            w.targetNodeId === targetNodeId && w.targetPortId === targetPortId
        );
        if (duplicate) return null;

        const id = 'wire-' + crypto.randomUUID().slice(0, 8);
        this.graph.wires[id] = {
            id,
            sourceNodeId,
            sourcePortId,
            targetNodeId,
            targetPortId,
            type,
            hovered: false
        };
        return id;
    }

    removeWire(wireId) {
        delete this.graph.wires[wireId];
    }

    getWiresForNode(nodeId) {
        return Object.values(this.graph.wires).filter(w =>
            w.sourceNodeId === nodeId || w.targetNodeId === nodeId
        );
    }

    // ── Port World Position (canvas-space coordinates for wire rendering) ───────

    getPortWorldPosition(nodeId, portId) {
        // A table card has one output connector however many columns it has,
        // so a wire naming a specific column (the MCP connect verb picks one)
        // is drawn from that connector.
        const portEl = document.querySelector(`[data-node-id="${nodeId}"] [data-port-id="${portId}"]`)
            || (this.graph.nodes[nodeId]?.tableBacked
                ? document.querySelector(`[data-node-id="${nodeId}"] .ne-port-out`) : null);
        if (!portEl) return null;

        const nodeEl = document.querySelector(`[data-node-id="${nodeId}"]`);
        if (!nodeEl) return null;

        const node = this.graph.nodes[nodeId];
        if (!node) return null;

        const vp       = this.graph.viewport;
        const portRect = portEl.getBoundingClientRect();
        const nodeRect = nodeEl.getBoundingClientRect();

        // Both rects are in screen-space after the CSS transform, so their
        // difference cancels the translate and leaves only the zoom scaling.
        // Dividing by vp.zoom converts screen-space offset → canvas-space offset.
        const relX = (portRect.left + portRect.width  / 2) - nodeRect.left;
        const relY = (portRect.top  + portRect.height / 2) - nodeRect.top;

        return {
            x: node.x + relX / vp.zoom,
            y: node.y + relY / vp.zoom
        };
    }

    // ── Viewport ───────────────────────────────────────────────────────────────

    resetViewport() {
        this.graph.viewport = { x: 0, y: 0, zoom: 1 };
    }

    fitToView(containerWidth, containerHeight) {
        const nodes = Object.values(this.graph.nodes);
        if (nodes.length === 0) {
            this.resetViewport();
            return;
        }

        const padding = 60;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        nodes.forEach(node => {
            const nw = node.width || 280;
            const nh = node.collapsed ? 42 : (node.height || 300);
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
            maxX = Math.max(maxX, node.x + nw);
            maxY = Math.max(maxY, node.y + nh);
        });

        const contentW = maxX - minX + padding * 2;
        const contentH = maxY - minY + padding * 2;
        const zoom = Math.min(
            containerWidth / contentW,
            containerHeight / contentH,
            1.5
        );

        this.graph.viewport.zoom = Math.max(0.15, zoom);
        this.graph.viewport.x = (containerWidth / 2) - ((minX + (maxX - minX) / 2) * this.graph.viewport.zoom);
        this.graph.viewport.y = (containerHeight / 2) - ((minY + (maxY - minY) / 2) * this.graph.viewport.zoom);
    }

    // ── Snapshot / Restore ────────────────────────────────────────────────────

    snapshot() {
        return JSON.parse(JSON.stringify(this.graph));
    }

    restore(snap) {
        window.NodeGraph = JSON.parse(JSON.stringify(snap));
        this.graph = window.NodeGraph;
    }
}

window.nodeGraphManager = new NodeGraphManager();
