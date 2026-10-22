// ===================================================================================
// NODE INTERACTIONS; Pan, zoom, node drag, port wire connections, selection
// ===================================================================================

class NodeInteractionManager {
    constructor() {
        this.container    = null;
        this.isPanning    = false;
        this.panStart     = { x: 0, y: 0, vpX: 0, vpY: 0 };
        this.draggedNode  = null;    // primary dragged node id (kept for compat)
        this.dragOffset   = { x: 0, y: 0 };
        this.dragGroup    = [];      // [{ nodeId, offsetX, offsetY }] — for multi-drag
        // { sourceNodeId, sourcePortId, startPos:{x,y}, currentPos:{x,y} }
        this.wireInProgress = null;
        // { startX, startY, endX, endY }  — screen-space
        this.selectionBox = null;
        this.spaceHeld    = false;
        this.selectedWireId = null;   // wire clicked for deletion

        this._boundPointerDown = this._onPointerDown.bind(this);
        this._boundPointerMove = this._onPointerMove.bind(this);
        this._boundPointerUp   = this._onPointerUp.bind(this);
        this._boundWheel       = this._onWheel.bind(this);
        this._boundKeyDown     = this._onKeyDown.bind(this);
        this._boundKeyUp       = this._onKeyUp.bind(this);
        this._boundContextMenu = this._onContextMenu.bind(this);
        this._portMenuEl       = null;   // active port context menu DOM element
        this._opts             = {};
    }

    // Tell the host canvas the view or node positions changed. The table
    // canvas owns more than the graph (selection overlay, rulers, zoom label,
    // sheet frames), so it needs to hear about moves it did not make itself.
    _emit(name, arg) {
        const fn = this._opts[name];
        if (typeof fn === 'function') fn(arg);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    // opts.wheel === false leaves wheel handling to the host (the table canvas
    // pans on a plain wheel, which suits trackpads better than zoom-only).
    // opts.onViewportChange / onNodesMoving / onNodesMoved are host hooks.
    init(containerEl, opts) {
        this.container = containerEl;
        this._opts = opts || {};
        if (this._opts.wheel !== false) this.container.addEventListener('wheel', this._boundWheel, { passive: false });
        // Pointer events: mouse + touch + stylus. Move/up stay on document so
        // gestures tracked outside the canvas keep working and `e.target` on
        // pointerup is the real element under the pointer (wire completion).
        this.container.addEventListener('pointerdown', this._boundPointerDown);
        this.container.addEventListener('contextmenu', this._boundContextMenu);
        document.addEventListener('pointermove', this._boundPointerMove);
        document.addEventListener('pointerup',   this._boundPointerUp);
        document.addEventListener('pointercancel', this._boundPointerUp);
        document.addEventListener('keydown',     this._boundKeyDown);
        document.addEventListener('keyup',       this._boundKeyUp);
    }

    destroy() {
        if (!this.container) return;
        this.container.removeEventListener('wheel',       this._boundWheel);
        this.container.removeEventListener('pointerdown', this._boundPointerDown);
        this.container.removeEventListener('contextmenu', this._boundContextMenu);
        document.removeEventListener('pointermove', this._boundPointerMove);
        document.removeEventListener('pointerup',   this._boundPointerUp);
        document.removeEventListener('pointercancel', this._boundPointerUp);
        document.removeEventListener('keydown',   this._boundKeyDown);
        document.removeEventListener('keyup',     this._boundKeyUp);
        this._dismissPortMenu();
        this.container      = null;
        this.isPanning      = false;
        this.draggedNode    = null;
        this.dragGroup      = [];
        this.wireInProgress = null;
        this.selectionBox   = null;
        this.selectedWireId = null;
    }

    // ── Coordinate helper ──────────────────────────────────────────────────────

    screenToCanvas(clientX, clientY) {
        const vp   = window.NodeGraph.viewport;
        const rect = this.container.getBoundingClientRect();
        return {
            x: (clientX - rect.left - vp.x) / vp.zoom,
            y: (clientY - rect.top  - vp.y) / vp.zoom
        };
    }

    containerPos(clientX, clientY) {
        const rect = this.container.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    // ── Wheel — zoom toward cursor ─────────────────────────────────────────────

    _onWheel(e) {
        e.preventDefault();
        const vp    = window.NodeGraph.viewport;
        const rect  = this.container.getBoundingClientRect();
        const mx    = e.clientX - rect.left;
        const my    = e.clientY - rect.top;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const oldZ  = vp.zoom;
        const newZ  = Math.max(0.1, Math.min(4, oldZ * delta));

        vp.x    = mx - (mx - vp.x) * (newZ / oldZ);
        vp.y    = my - (my - vp.y) * (newZ / oldZ);
        vp.zoom = newZ;

        window.nodeCanvasRenderer.markBgDirty();
        window.nodeCanvasRenderer.markStaticDirty();
    }

    // ── Mouse Down ──────────────────────────────────────────────────────────────

    _onPointerDown(e) {
        // Right-click excluded (context menu owns it); touch/pen report button 0.
        // Middle-click (button 1) is preserved for pan below.
        if (e.button === 2 || e.isPrimary === false) return;

        const target = e.target;

        // ── Port → start wire
        const portEl = target.closest('.ne-port');
        if (portEl) {
            e.preventDefault();
            this._startWire(portEl, e);
            return;
        }

        // ── Collapse toggle
        if (target.classList.contains('ne-node-collapse-btn')) {
            const nodeEl = target.closest('.ne-node');
            if (nodeEl) {
                window.nodeGraphManager.toggleCollapse(nodeEl.dataset.nodeId);
                if (typeof window.renderNodeDom === 'function') {
                    window.renderNodeDom(nodeEl.dataset.nodeId);
                }
                window.nodeCanvasRenderer.markStaticDirty();
            }
            return;
        }

        // ── Config button → open config panel
        if (target.classList.contains('ne-node-config-btn')) {
            const nodeEl = target.closest('.ne-node');
            if (nodeEl && typeof window.nodeConfigPanel !== 'undefined') {
                window.nodeConfigPanel.open(nodeEl.dataset.nodeId);
            }
            return;
        }

        // ── Delete node button
        if (target.classList.contains('ne-node-delete-btn')) {
            const nodeEl = target.closest('.ne-node');
            if (nodeEl) {
                window.nodeGraphManager.removeNode(nodeEl.dataset.nodeId);
                nodeEl.remove();
                window.nodeCanvasRenderer.markStaticDirty();
                if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();
            }
            return;
        }

        // ── Node header → drag + select. A table card's header counts too, so
        // tables and operator nodes select and move as one group.
        const headerEl = target.closest('.ne-node-header, .tf-canvas-card > .accordion');
        if (headerEl && !this.spaceHeld) {
            const nodeEl = headerEl.closest('[data-node-id]');
            if (nodeEl) {
                const nodeId = nodeEl.dataset.nodeId;
                // If Ctrl/Meta held, add to selection; otherwise select this node
                // (but don't deselect the group if this node is already part of it)
                const node = window.NodeGraph.nodes[nodeId];
                if (!node) return;

                if (e.ctrlKey || e.metaKey) {
                    // Additive / subtractive selection
                    window.nodeGraphManager.selectNode(nodeId, true);
                } else if (!node.selected) {
                    // Node wasn't previously selected — replace selection with just this one
                    window.nodeGraphManager.deselectAll();
                    node.selected = true;
                }
                // If node was already selected, keep the whole group selected and drag all

                this._updateSelectionVisuals();
                this._startNodeDrag(nodeEl, e);
                window.nodeCanvasRenderer.markStaticDirty();
            }
            return;
        }

        // ── Middle-click or space+left → pan
        if (e.button === 1 || this.spaceHeld) {
            e.preventDefault();
            this._startPan(e);
            return;
        }

        // ── Empty canvas → deselect + rubber-band (Shift+drag = pan)
        const isCanvas = target === this.container
            || target.id === 'nodeCanvasLayer'
            || target.id === 'nodeHtmlLayer'
            || target.classList.contains('tf-sheet-frame')
            || target.closest('#nodeEditorViewport') === this.container;

        if (isCanvas && e.button === 0) {
            if (e.shiftKey) {
                // Shift+drag on empty canvas = pan (alternative to Space)
                e.preventDefault();
                this._startPan(e);
            } else {
                const cp       = this.screenToCanvas(e.clientX, e.clientY);
                const hitWire  = this._hitTestWires(cp.x, cp.y);
                if (hitWire) {
                    // Select the wire; deselect nodes and any previously selected wire
                    window.nodeGraphManager.deselectAll();
                    this._updateSelectionVisuals();
                    this._setSelectedWire(hitWire);
                } else {
                    this._clearWireSelection();
                    window.nodeGraphManager.deselectAll();
                    this._updateSelectionVisuals();
                    this._startSelectionBox(e);
                }
            }
        }
    }

    // ── Pointer Move ─────────────────────────────────────────────────────────────

    _onPointerMove(e) {
        if (e.isPrimary === false) return;   // secondary touches don't move things
        if (this.isPanning) {
            const vp = window.NodeGraph.viewport;
            vp.x = this.panStart.vpX + (e.clientX - this.panStart.x);
            vp.y = this.panStart.vpY + (e.clientY - this.panStart.y);
            window.nodeCanvasRenderer.markBgDirty();
            window.nodeCanvasRenderer.markStaticDirty();
            this._emit('onViewportChange');
            return;
        }

        if (this.dragGroup.length > 0) {
            const cp = this.screenToCanvas(e.clientX, e.clientY);
            this.dragGroup.forEach(({ nodeId, offsetX, offsetY }) => {
                const newX = cp.x - offsetX;
                const newY = cp.y - offsetY;
                window.nodeGraphManager.moveNode(nodeId, newX, newY);
                const el = document.querySelector(`[data-node-id="${nodeId}"]`);
                if (el) {
                    el.style.left = newX + 'px';
                    el.style.top  = newY + 'px';
                }
            });
            this._dragMoved = true;
            window.nodeCanvasRenderer.markStaticDirty();
            this._emit('onNodesMoving', this.dragGroup.map(g => g.nodeId));
            return;
        }

        if (this.wireInProgress) {
            this.wireInProgress.currentPos = this.screenToCanvas(e.clientX, e.clientY);
            return;
        }

        if (this.selectionBox) {
            const cp = this.containerPos(e.clientX, e.clientY);
            this.selectionBox.endX = cp.x;
            this.selectionBox.endY = cp.y;
        }
    }

    // ── Pointer Up ───────────────────────────────────────────────────────────────

    _onPointerUp(e) {
        if (e.isPrimary === false) return;
        if (this.isPanning) {
            this.isPanning = false;
            if (this.container) this.container.style.cursor = this.spaceHeld ? 'grab' : '';
            return;
        }

        if (this.dragGroup.length > 0) {
            const moved = this.dragGroup.map(g => g.nodeId);
            const didMove = this._dragMoved;
            this.draggedNode = null;
            this.dragGroup   = [];
            this._dragMoved  = false;
            window.nodeCanvasRenderer.markStaticDirty();
            if (didMove) this._emit('onNodesMoved', moved);
            if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();
            return;
        }

        if (this.wireInProgress) {
            const target   = e.target;
            const portEl   = target ? target.closest('.ne-port') : null;
            if (portEl) {
                this._completeWire(portEl);
            }
            this.wireInProgress = null;
            window.nodeCanvasRenderer.markStaticDirty();
            return;
        }

        if (this.selectionBox) {
            this._finalizeSelectionBox();
            this.selectionBox = null;
        }
    }

    // ── Key Events ──────────────────────────────────────────────────────────────

    _onKeyDown(e) {
        if (!window.nodeEditorEnabled) return;

        // Space → grab-pan mode
        if (e.code === 'Space' && !e.target.matches('input,textarea,[contenteditable="true"]')) {
            e.preventDefault();
            this.spaceHeld = true;
            if (this.container) this.container.style.cursor = 'grab';
            return;
        }

        // With cells selected in a table, Delete and Ctrl+A belong to the grid.
        const cellsSelected = (window.selectedCells || []).length > 0;

        // Delete / Backspace → remove selected nodes, or selected wire if no nodes selected
        if ((e.key === 'Delete' || e.key === 'Backspace') && !cellsSelected &&
            !e.target.matches('input,textarea,[contenteditable="true"]')) {
            const hasSelectedNodes = window.nodeGraphManager.getSelectedNodes().length > 0;
            if (hasSelectedNodes) {
                this._deleteSelectedNodes();
            } else if (this.selectedWireId) {
                this._deleteSelectedWire();
            }
            return;
        }

        // Ctrl+A → select all
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !cellsSelected &&
            !e.target.matches('input,textarea,[contenteditable="true"]')) {
            e.preventDefault();
            this._selectAllNodes();
        }
    }

    _onKeyUp(e) {
        if (e.code === 'Space') {
            this.spaceHeld = false;
            if (this.container) this.container.style.cursor = '';
        }
    }

    // ── Pan ─────────────────────────────────────────────────────────────────────

    _startPan(e) {
        const vp = window.NodeGraph.viewport;
        this.isPanning = true;
        this.panStart  = { x: e.clientX, y: e.clientY, vpX: vp.x, vpY: vp.y };
        if (this.container) this.container.style.cursor = 'grabbing';
    }

    // ── Node Drag ───────────────────────────────────────────────────────────────

    _startNodeDrag(nodeEl, e) {
        this._dragMoved = false;
        const cp = this.screenToCanvas(e.clientX, e.clientY);
        // Build drag group from all currently selected nodes
        const selectedNodes = Object.values(window.NodeGraph.nodes).filter(n => n.selected);
        if (selectedNodes.length === 0) {
            // Fallback: just drag the clicked node
            const node = window.NodeGraph.nodes[nodeEl.dataset.nodeId];
            if (node) selectedNodes.push(node);
        }
        this.dragGroup = selectedNodes.map(n => ({
            nodeId:  n.id,
            offsetX: cp.x - n.x,
            offsetY: cp.y - n.y
        }));
        // Keep legacy draggedNode pointing at the primary (for anything still using it)
        this.draggedNode = nodeEl.dataset.nodeId;
        this.dragOffset  = {
            x: cp.x - (window.NodeGraph.nodes[this.draggedNode]?.x || 0),
            y: cp.y - (window.NodeGraph.nodes[this.draggedNode]?.y || 0)
        };
    }

    // ── Wire Connection ─────────────────────────────────────────────────────────

    _startWire(portEl, e) {
        const nodeEl = portEl.closest('[data-node-id]');
        if (!nodeEl) return;
        this._clearWireSelection();
        const cp = this.screenToCanvas(e.clientX, e.clientY);
        this.wireInProgress = {
            sourceNodeId: nodeEl.dataset.nodeId,
            sourcePortId: portEl.dataset.portId,
            startPos:    { ...cp },
            currentPos:  { ...cp }
        };
    }

    _completeWire(targetPortEl) {
        const wp = this.wireInProgress;
        if (!wp) return;

        const targetNodeEl = targetPortEl.closest('[data-node-id]');
        if (!targetNodeEl) return;

        const targetNodeId = targetNodeEl.dataset.nodeId;
        const targetPortId = targetPortEl.dataset.portId;

        if (targetNodeId === wp.sourceNodeId) return; // no self-connect

        // ── Direction validation ──────────────────────────────────────────────
        // Source port must be 'out' or 'inout'; target port must be 'in' or 'inout'
        const srcNode = window.NodeGraph.nodes[wp.sourceNodeId];
        const tgtNode = window.NodeGraph.nodes[targetNodeId];

        if (srcNode && tgtNode) {
            const _portDir = (node, rawPortId) => {
                // Strip '-out' suffix to find the base header
                const baseId = rawPortId.replace(/-out$/, '');
                const header = node.headers.find(h => h.portId === baseId);
                if (!header) return rawPortId.endsWith('-out') ? 'out' : 'in';
                return header.direction || 'inout';
            };

            const srcDir = _portDir(srcNode, wp.sourcePortId);
            const tgtDir = _portDir(tgtNode, targetPortId);

            // Source must allow output; target must allow input
            const srcCanOut = srcDir === 'out' || srcDir === 'inout';
            const tgtCanIn  = tgtDir === 'in'  || tgtDir === 'inout';

            if (!srcCanOut) {
                $.toast({ heading: 'Node Editor', text: 'Source port does not support output', icon: 'warning', loader: false, stack: false });
                return;
            }
            if (!tgtCanIn) {
                $.toast({ heading: 'Node Editor', text: 'Target port does not support input', icon: 'warning', loader: false, stack: false });
                return;
            }
        }

        const wireId = window.nodeGraphManager.addWire(
            wp.sourceNodeId, wp.sourcePortId,
            targetNodeId, targetPortId
        );

        if (wireId) {
            const srcNode   = window.NodeGraph.nodes[wp.sourceNodeId];
            const tgtNode   = window.NodeGraph.nodes[targetNodeId];
            const srcHeader = srcNode && srcNode.headers.find(h => h.portId === wp.sourcePortId || h.portId + '-out' === wp.sourcePortId);
            const tgtHeader = tgtNode && tgtNode.headers.find(h => h.portId === targetPortId     || h.portId + '-out' === targetPortId);

            const srcLabel = (srcNode ? srcNode.label : '') + (srcHeader ? '.' + srcHeader.label : '');
            const tgtLabel = (tgtNode ? tgtNode.label : '') + (tgtHeader ? '.' + tgtHeader.label : '');

            // Re-render both endpoints so ⚙ button state reflects new wire
            if (typeof window.renderNodeDom === 'function') {
                window.renderNodeDom(wp.sourceNodeId);
                window.renderNodeDom(targetNodeId);
            }

            $.toast({
                heading:   'Node Editor',
                text:      `Connected ${srcLabel} → ${tgtLabel}`,
                icon:      'success',
                loader:    false,
                stack:     false,
                hideAfter: 2500
            });

            if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();
        }
    }

    // ── Selection Box ───────────────────────────────────────────────────────────

    _startSelectionBox(e) {
        const cp = this.containerPos(e.clientX, e.clientY);
        this.selectionBox = { startX: cp.x, startY: cp.y, endX: cp.x, endY: cp.y };
    }

    _finalizeSelectionBox() {
        const { startX, startY, endX, endY } = this.selectionBox;
        const x  = Math.min(startX, endX);
        const y  = Math.min(startY, endY);
        const bw = Math.abs(endX - startX);
        const bh = Math.abs(endY - startY);

        if (bw < 4 && bh < 4) return; // too small — treat as click

        const vp  = window.NodeGraph.viewport;
        const cx1 = (x      - vp.x) / vp.zoom;
        const cy1 = (y      - vp.y) / vp.zoom;
        const cx2 = (x + bw - vp.x) / vp.zoom;
        const cy2 = (y + bh - vp.y) / vp.zoom;

        window.nodeGraphManager.deselectAll();
        Object.values(window.NodeGraph.nodes).forEach(node => {
            const nw = node.width || 280;
            const nh = node.collapsed ? 42 : (node.height || 300);
            if (node.x < cx2 && node.x + nw > cx1 && node.y < cy2 && node.y + nh > cy1) {
                node.selected = true;
            }
        });

        this._updateSelectionVisuals();
        window.nodeCanvasRenderer.markStaticDirty();
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    _updateSelectionVisuals() {
        document.querySelectorAll('[data-node-id]').forEach(el => {
            const node = window.NodeGraph.nodes[el.dataset.nodeId];
            el.classList.toggle('selected', !!(node && node.selected));
        });
        this._emit('onSelectionChange');
    }

    _deleteSelectedNodes() {
        // A selected table card is not deleted from here: a table belongs to
        // its sheet, and removing it is a table edit with its own undo.
        const selected = window.nodeGraphManager.getSelectedNodes().filter(n => !n.tableBacked);
        if (selected.length === 0) return;

        selected.forEach(node => {
            const el = document.querySelector(`[data-node-id="${node.id}"]`);
            if (el) el.remove();
            window.nodeGraphManager.removeNode(node.id);
        });

        window.nodeCanvasRenderer.markStaticDirty();
        if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();
        $.toast({
            heading: 'Node Editor',
            text:    `Deleted ${selected.length} node${selected.length > 1 ? 's' : ''}`,
            icon:    'info', loader: false, stack: false
        });
    }

    _selectAllNodes() {
        Object.values(window.NodeGraph.nodes).forEach(n => { n.selected = true; });
        this._updateSelectionVisuals();
        window.nodeCanvasRenderer.markStaticDirty();
    }

    // ── Wire hit-test & selection ───────────────────────────────────────────────

    /**
     * Sample each bezier wire at 20 points and return the first wireId whose
     * curve passes within 8 screen-pixels of (canvasX, canvasY), or null.
     */
    _hitTestWires(canvasX, canvasY) {
        const SAMPLES    = 20;
        const vp         = window.NodeGraph.viewport;
        const hitRadius  = 8 / vp.zoom;  // convert screen-px threshold to canvas-px

        for (const [wireId, wire] of Object.entries(window.NodeGraph.wires || {})) {
            const p1 = window.nodeGraphManager.getPortWorldPosition(wire.sourceNodeId, wire.sourcePortId);
            const p2 = window.nodeGraphManager.getPortWorldPosition(wire.targetNodeId, wire.targetPortId);
            if (!p1 || !p2) continue;

            // Must match _drawBezier control-point formula exactly
            const dx = Math.abs(p2.x - p1.x) * 0.55 + 40;
            const cp1x = p1.x + dx,  cp1y = p1.y;
            const cp2x = p2.x - dx,  cp2y = p2.y;

            for (let i = 0; i <= SAMPLES; i++) {
                const t  = i / SAMPLES;
                const mt = 1 - t;
                const bx = mt*mt*mt*p1.x + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*p2.x;
                const by = mt*mt*mt*p1.y + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*p2.y;
                if (Math.hypot(canvasX - bx, canvasY - by) <= hitRadius) return wireId;
            }
        }
        return null;
    }

    _setSelectedWire(wireId) {
        this.selectedWireId = wireId;
        window.nodeCanvasRenderer.markStaticDirty();
    }

    _clearWireSelection() {
        if (!this.selectedWireId) return;
        this.selectedWireId = null;
        window.nodeCanvasRenderer.markStaticDirty();
    }

    _deleteSelectedWire() {
        if (!this.selectedWireId) return;
        window.nodeGraphManager.removeWire(this.selectedWireId);
        this.selectedWireId = null;
        window.nodeCanvasRenderer.markStaticDirty();
        if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();
        $.toast({
            heading: 'Node Editor',
            text:    'Wire deleted',
            icon:    'info', loader: false, stack: false
        });
    }

    // ── Port right-click context menu (Option E) ────────────────────────────────

    _onContextMenu(e) {
        // Only trigger on output ports of table/operator nodes
        const portEl = e.target.closest('.ne-port-out, .ne-port[data-port-id$="-out"]');
        if (!portEl) return;

        e.preventDefault();
        e.stopPropagation();

        const nodeEl   = portEl.closest('[data-node-id]');
        if (!nodeEl) return;

        const sourceNodeId = nodeEl.dataset.nodeId;
        const sourcePortId = portEl.dataset.portId;

        this._dismissPortMenu();
        this._showPortMenu(e.clientX, e.clientY, sourceNodeId, sourcePortId);
    }

    _showPortMenu(clientX, clientY, sourceNodeId, sourcePortId) {
        const operatorTypes = ['filter', 'vlookup', 'formula', 'join', 'append', 'api'];
        const menu = document.createElement('div');
        menu.className = 'ne-port-menu';
        menu.setAttribute('role', 'menu');

        const heading = document.createElement('div');
        heading.className   = 'ne-port-menu-heading';
        heading.textContent = 'Add connected node';
        menu.appendChild(heading);

        operatorTypes.forEach(type => {
            const def  = window.NodeTypes.get(type);
            const item = document.createElement('button');
            item.className   = 'ne-port-menu-item';
            item.setAttribute('role', 'menuitem');
            item.innerHTML   = `<span class="ne-port-menu-icon" style="background:${def.color}">${def.icon}</span><span>${def.label}</span>`;
            item.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                this._spawnConnectedNode(type, sourceNodeId, sourcePortId);
                this._dismissPortMenu();
            });
            menu.appendChild(item);
        });

        // ── Connect to an existing operator node ──────────────────────────────
        // Joins expose their free Left/Right input explicitly, so a second table
        // can be wired into a Join without dragging a wire across the canvas.
        const targets = [];
        Object.values(window.NodeGraph.nodes).forEach(n => {
            if (n.id === sourceNodeId || !window.NodeTypes.isOperator(n.nodeType)) return;
            if (n.nodeType === 'join') {
                ['join-in-left', 'join-in-right'].forEach(portId => {
                    const taken = Object.values(window.NodeGraph.wires).some(
                        w => w.targetNodeId === n.id && w.targetPortId === portId
                    );
                    if (!taken) targets.push({ nodeId: n.id, portId, label: `${n.label} — ${portId === 'join-in-left' ? 'Left' : 'Right'} input` });
                });
            } else if (n.nodeType === 'append') {
                // Append takes any number of tables into one port.
                const alreadyWired = Object.values(window.NodeGraph.wires).some(
                    w => w.targetNodeId === n.id && w.sourceNodeId === sourceNodeId
                );
                if (!alreadyWired) targets.push({ nodeId: n.id, portId: 'append-in', label: n.label });
            } else {
                const inHeader = n.headers.find(h => h.direction === 'in');
                if (!inHeader) return;
                const alreadyWired = Object.values(window.NodeGraph.wires).some(
                    w => w.targetNodeId === n.id && w.sourceNodeId === sourceNodeId
                );
                if (!alreadyWired) targets.push({ nodeId: n.id, portId: inHeader.portId, label: n.label });
            }
        });

        if (targets.length) {
            const heading2 = document.createElement('div');
            heading2.className   = 'ne-port-menu-heading';
            heading2.textContent = 'Connect to existing node';
            menu.appendChild(heading2);

            targets.forEach(t => {
                const n    = window.NodeGraph.nodes[t.nodeId];
                const def  = window.NodeTypes.get(n.nodeType);
                const item = document.createElement('button');
                item.className = 'ne-port-menu-item';
                item.setAttribute('role', 'menuitem');
                item.innerHTML = `<span class="ne-port-menu-icon" style="background:${def.color}">${def.icon}</span><span>${t.label}</span>`;
                item.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                    window.nodeGraphManager.addWire(sourceNodeId, sourcePortId, t.nodeId, t.portId);
                    if (typeof window.renderNodeDom === 'function') {
                        window.renderNodeDom(t.nodeId);
                        window.renderNodeDom(sourceNodeId);
                    }
                    window.nodeCanvasRenderer.markStaticDirty();
                    if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();
                    $.toast({ heading: 'Node Editor', text: `Wired to ${t.label}`, icon: 'success', loader: false, stack: false, hideAfter: 2500 });
                    this._dismissPortMenu();
                });
                menu.appendChild(item);
            });
        }

        // Position near cursor, keep inside viewport
        document.body.appendChild(menu);
        this._portMenuEl = menu;

        const vw = window.innerWidth, vh = window.innerHeight;
        const mw = menu.offsetWidth  || 180;
        const mh = menu.offsetHeight || 200;
        menu.style.left = Math.min(clientX, vw - mw - 8) + 'px';
        menu.style.top  = Math.min(clientY, vh - mh - 8) + 'px';

        // Dismiss on outside press
        const dismiss = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissPortMenu();
                document.removeEventListener('pointerdown', dismiss);
            }
        };
        setTimeout(() => document.addEventListener('pointerdown', dismiss), 0);
    }

    _dismissPortMenu() {
        if (this._portMenuEl) {
            this._portMenuEl.remove();
            this._portMenuEl = null;
        }
    }

    _spawnConnectedNode(type, sourceNodeId, sourcePortId) {
        if (!window.NodeTypes || !window.nodeGraphManager) return;

        const def     = window.NodeTypes.get(type);
        const srcNode = window.NodeGraph.nodes[sourceNodeId];
        if (!srcNode) return;

        // Place new node to the right of the source node
        const x = srcNode.x + (srcNode.width || 280) + 80;
        const y = srcNode.y;

        const label   = def.label + ' ' + (Object.values(window.NodeGraph.nodes).filter(n => n.nodeType === type).length + 1);
        const config  = window.NodeTypes.defaultConfig(type);
        const headers = window.NodeTypes.defaultHeaders(type) || [];
        const newId   = window.nodeGraphManager.addNode(label, x, y, headers, type, config);

        const newNode = window.NodeGraph.nodes[newId];
        let targetPortId = null;

        if (type === 'join') {
            // Join has two fixed input ports: join-in-left and join-in-right.
            // Wire to left first; if left is already taken wire to right.
            const leftConnected = Object.values(window.NodeGraph.wires).some(
                w => w.targetNodeId === newId && w.targetPortId === 'join-in-left'
            );
            targetPortId = leftConnected ? 'join-in-right' : 'join-in-left';
        } else {
            // All other operator types: use the first structural 'in' port
            const targetHeader = newNode.headers.find(h => h.direction === 'in');
            targetPortId = targetHeader ? targetHeader.portId : null;
        }

        if (targetPortId) {
            window.nodeGraphManager.addWire(sourceNodeId, sourcePortId, newId, targetPortId);
        }

        if (typeof window.renderNodeDom === 'function') {
            window.renderNodeDom(newId);
            window.renderNodeDom(sourceNodeId);
        }

        window.nodeCanvasRenderer.markStaticDirty();
        if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();

        const hint = type === 'join'
            ? `Added Join — wired to ${targetPortId === 'join-in-left' ? 'Left' : 'Right'} input. Drag a wire from another table to the remaining input port, then open ⚙ to configure.`
            : `Added ${def.label} — configure ⚙ to continue`;

        $.toast({ heading: 'Node Editor', text: hint, icon: 'success', loader: false, stack: false, hideAfter: 3500 });
    }
}

window.nodeInteractionManager = new NodeInteractionManager();

