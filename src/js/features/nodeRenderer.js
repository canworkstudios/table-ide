// ===================================================================================
// NODE RENDERER; 3-Layer Canvas Rendering
//   Layer 1 — Background:  dot grid, canvas fill  (redraws on pan/zoom/resize/theme)
//   Layer 2 — Static:      committed wires        (redraws on graph structure change)
//   Layer 3 — Active:      drag previews, temp wire, selection box  (every frame)
// Compositing: two offscreen buffers (bg + static) drawImage'd onto the visible canvas.
// ===================================================================================

class NodeCanvasRenderer {
    constructor() {
        this.mainCanvas   = null;
        this.bgBuffer     = null;
        this.staticBuffer = null;
        this.mainCtx      = null;
        this.bgCtx        = null;
        this.staticCtx    = null;
        this.htmlLayer    = null;
        this.minimapCanvas = null;
        this.minimapCtx    = null;

        this.isRunning    = false;
        this._bgDirty     = true;
        this._staticDirty = true;
        this._bgDirtyPending     = false;
        this._staticDirtyPending = false;
        this._boundFrame  = this._renderFrame.bind(this);

        this._colors = {
            bg:         '#f8f9fa',
            gridDot:    '#e5e7eb',
            gridMajor:  '#d1d5db',
            wire:       '#6b7280',
            wireHover:  '#1a73e8',
        };
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    init() {
        this.mainCanvas   = document.getElementById('nodeCanvasLayer');
        this.bgBuffer     = document.getElementById('neBgBuffer');
        this.staticBuffer = document.getElementById('neStaticBuffer');
        this.htmlLayer    = document.getElementById('nodeHtmlLayer');
        this.minimapCanvas = document.getElementById('neMinimapCanvas');

        if (!this.mainCanvas || !this.bgBuffer || !this.staticBuffer || !this.htmlLayer) {
            console.warn('NodeRenderer: required canvas elements not found');
            return;
        }

        this.mainCtx   = this.mainCanvas.getContext('2d');
        this.bgCtx     = this.bgBuffer.getContext('2d');
        this.staticCtx = this.staticBuffer.getContext('2d');
        if (this.minimapCanvas) this.minimapCtx = this.minimapCanvas.getContext('2d');

        this._readColors();
        this._bgDirty     = true;
        this._staticDirty = true;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;

        // Prefer GSAP ticker for lag-smoothing; fall back to rAF if GSAP didn't load
        if (typeof gsap !== 'undefined' && gsap.ticker) {
            this._usingGsap = true;
            gsap.ticker.add(this._boundFrame);
        } else {
            this._usingGsap = false;
            this._rafLoop();
        }
    }

    _rafLoop() {
        if (!this.isRunning) return;
        this._renderFrame();
        requestAnimationFrame(() => this._rafLoop());
    }

    stop() {
        this.isRunning = false;
        if (this._usingGsap && typeof gsap !== 'undefined' && gsap.ticker) {
            gsap.ticker.remove(this._boundFrame);
        }
        // rAF loop self-terminates via this.isRunning check
    }

    markBgDirty() {
        if (this._bgDirtyPending) return;
        this._bgDirtyPending = true;
        requestAnimationFrame(() => {
            this._bgDirty = true;
            this._bgDirtyPending = false;
        });
    }

    markStaticDirty() {
        if (this._staticDirtyPending) return;
        this._staticDirtyPending = true;
        requestAnimationFrame(() => {
            this._staticDirty = true;
            this._staticDirtyPending = false;
        });
    }

    onThemeChange() {
        this._readColors();
        this._bgDirty     = true;
        this._staticDirty = true;
    }

    // ── Color cache (CSS vars can't be read by Canvas directly) ───────────────

    _readColors() {
        const s = getComputedStyle(document.documentElement);
        const get = (v, fallback) => {
            const val = s.getPropertyValue(v).trim();
            return val || fallback;
        };
        this._colors.bg        = get('--t-bg-workspace', '#f8f9fa');
        this._colors.gridDot   = get('--t-border',       '#e5e7eb');
        this._colors.gridMajor = get('--t-text-light',   '#9ca3af');
        this._colors.wire      = get('--t-text-muted',   '#6b7280');
        this._colors.wireHover = get('--t-primary',      '#1a73e8');
    }

    // ── Canvas resize (keep all three buffers in sync) ─────────────────────────

    _resize() {
        if (!this.mainCanvas) return false;
        const p = this.mainCanvas.parentElement;
        const w = p.clientWidth;
        const h = p.clientHeight;
        if (this.mainCanvas.width === w && this.mainCanvas.height === h) return false;

        this.mainCanvas.width   = w;
        this.mainCanvas.height  = h;
        this.bgBuffer.width     = w;
        this.bgBuffer.height    = h;
        this.staticBuffer.width  = w;
        this.staticBuffer.height = h;

        this._bgDirty     = true;
        this._staticDirty = true;
        return true;
    }

    // ── Main render loop (called by GSAP ticker) ───────────────────────────────

    _renderFrame() {
        if (!this.isRunning || !this.mainCtx) return;

        this._resize();

        const w  = this.mainCanvas.width;
        const h  = this.mainCanvas.height;
        const vp = window.NodeGraph.viewport;

        if (this._bgDirty) {
            this._drawBackground(this.bgCtx, w, h, vp);
            this._bgDirty = false;
        }

        if (this._staticDirty) {
            this._drawStatic(this.staticCtx, w, h, vp);
            this._staticDirty = false;
        }

        // Composite: bg + static + active
        this.mainCtx.clearRect(0, 0, w, h);
        this.mainCtx.drawImage(this.bgBuffer,     0, 0);
        this.mainCtx.drawImage(this.staticBuffer, 0, 0);
        this._drawActive(this.mainCtx, vp);

        // Sync HTML overlay transform
        this.htmlLayer.style.transform       = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
        this.htmlLayer.style.transformOrigin = '0 0';

        // Minimap (always redraws — it's cheap)
        this._drawMinimap(vp, w, h);
    }

    // ── Layer 1: Background ────────────────────────────────────────────────────

    _drawBackground(ctx, w, h, vp) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = this._colors.bg;
        ctx.fillRect(0, 0, w, h);

        const spacing  = 20 * vp.zoom;
        if (spacing < 4) return; // too zoomed-out to draw dots

        const offsetX  = ((vp.x % spacing) + spacing) % spacing;
        const offsetY  = ((vp.y % spacing) + spacing) % spacing;
        const majorEvery = 5;

        // We track logical grid index to identify major intersections
        const startIX = Math.floor(-vp.x / (20 * vp.zoom));
        const startIY = Math.floor(-vp.y / (20 * vp.zoom));

        let xi = 0;
        for (let x = offsetX; x < w + spacing; x += spacing, xi++) {
            let yi = 0;
            for (let y = offsetY; y < h + spacing; y += spacing, yi++) {
                const isMajor = ((startIX + xi) % majorEvery === 0) && ((startIY + yi) % majorEvery === 0);
                const r = isMajor ? Math.min(2, vp.zoom * 1.5) : Math.min(1.2, vp.zoom);
                ctx.fillStyle = isMajor ? this._colors.gridMajor : this._colors.gridDot;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    // ── Layer 2: Static (committed wires) ─────────────────────────────────────

    _drawStatic(ctx, w, h, vp) {
        ctx.clearRect(0, 0, w, h);
        ctx.save();
        ctx.translate(vp.x, vp.y);
        ctx.scale(vp.zoom, vp.zoom);

        const selectedWireId = window.nodeInteractionManager
            ? window.nodeInteractionManager.selectedWireId
            : null;

        Object.values(window.NodeGraph.wires || {}).forEach(wire => {
            if (wire.id === selectedWireId) return; // draw selected wire last (on top)
            const p1 = window.nodeGraphManager.getPortWorldPosition(wire.sourceNodeId, wire.sourcePortId);
            const p2 = window.nodeGraphManager.getPortWorldPosition(wire.targetNodeId, wire.targetPortId);
            if (p1 && p2) {
                this._drawBezier(ctx, p1, p2,
                    wire.hovered ? this._colors.wireHover : this._colors.wire,
                    2 / vp.zoom, false);
            }
        });

        // Draw selected wire on top in red so it's clearly highlighted
        if (selectedWireId) {
            const sw = window.NodeGraph.wires[selectedWireId];
            if (sw) {
                const p1 = window.nodeGraphManager.getPortWorldPosition(sw.sourceNodeId, sw.sourcePortId);
                const p2 = window.nodeGraphManager.getPortWorldPosition(sw.targetNodeId, sw.targetPortId);
                if (p1 && p2) {
                    this._drawBezier(ctx, p1, p2, '#ef4444', 3 / vp.zoom, false);
                }
            }
        }

        ctx.restore();
    }

    // ── Minimap ────────────────────────────────────────────────────────────────

    _drawMinimap(vp, canvasW, canvasH) {
        if (!this.minimapCtx || !this.minimapCanvas) return;

        const mc  = this.minimapCanvas;
        const ctx = this.minimapCtx;
        const mw  = mc.width  || 160;
        const mh  = mc.height || 100;

        ctx.clearRect(0, 0, mw, mh);

        // Background
        ctx.fillStyle = this._colors.bg;
        ctx.fillRect(0, 0, mw, mh);

        const nodes = Object.values(window.NodeGraph.nodes || {});
        if (nodes.length === 0) return;

        // Compute world bounding box of all nodes
        let minX =  Infinity, minY =  Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        nodes.forEach(n => {
            const nw = n.width || 280;
            const nh = n.collapsed ? 42 : (n.height || 220);
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + nw);
            maxY = Math.max(maxY, n.y + nh);
        });

        // Also include current viewport frustum in bounds so it's always visible
        const vpLeft   = (-vp.x) / vp.zoom;
        const vpTop    = (-vp.y) / vp.zoom;
        const vpRight  = vpLeft + canvasW / vp.zoom;
        const vpBottom = vpTop  + canvasH / vp.zoom;
        minX = Math.min(minX, vpLeft);   minY = Math.min(minY, vpTop);
        maxX = Math.max(maxX, vpRight);  maxY = Math.max(maxY, vpBottom);

        // Add 5% padding
        const pad  = 0.05;
        const ww   = maxX - minX || 1;
        const wh   = maxY - minY || 1;
        minX -= ww * pad;  minY -= wh * pad;
        maxX += ww * pad;  maxY += wh * pad;

        // world→minimap scale (maintain aspect, letter-box)
        const scaleX = mw / (maxX - minX);
        const scaleY = mh / (maxY - minY);
        const scale  = Math.min(scaleX, scaleY);
        const offX   = (mw - (maxX - minX) * scale) / 2;
        const offY   = (mh - (maxY - minY) * scale) / 2;

        const toMM = (wx, wy) => ({
            x: offX + (wx - minX) * scale,
            y: offY + (wy - minY) * scale
        });

        // Draw wires
        ctx.strokeStyle = this._colors.wire;
        ctx.lineWidth   = 0.5;
        ctx.globalAlpha = 0.5;
        Object.values(window.NodeGraph.wires || {}).forEach(wire => {
            const sn = window.NodeGraph.nodes[wire.sourceNodeId];
            const tn = window.NodeGraph.nodes[wire.targetNodeId];
            if (!sn || !tn) return;
            const p1 = toMM(sn.x + (sn.width || 280), sn.y + 21);
            const p2 = toMM(tn.x,                      tn.y + 21);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        });
        ctx.globalAlpha = 1;

        // Draw nodes
        const isOp = n => window.NodeTypes && window.NodeTypes.isOperator(n.nodeType);
        nodes.forEach(n => {
            const nw = n.width || 280;
            const nh = n.collapsed ? 42 : (n.height || 220);
            const p  = toMM(n.x, n.y);
            const pw = nw * scale;
            const ph = nh * scale;

            // Fill
            ctx.fillStyle = n.selected
                ? 'rgba(26,115,232,0.55)'
                : isOp(n)
                    ? 'rgba(14,165,233,0.45)'
                    : (this._colors.wire + '55');
            ctx.fillRect(p.x, p.y, Math.max(pw, 3), Math.max(ph, 3));

            // Border
            ctx.strokeStyle = n.selected ? '#1a73e8' : this._colors.wire;
            ctx.lineWidth   = n.selected ? 1 : 0.5;
            ctx.strokeRect(p.x, p.y, Math.max(pw, 3), Math.max(ph, 3));
        });

        // Draw viewport frustum
        const vfp1 = toMM(vpLeft, vpTop);
        const vfW  = (vpRight - vpLeft) * scale;
        const vfH  = (vpBottom - vpTop) * scale;
        ctx.strokeStyle = 'rgba(26,115,232,0.7)';
        ctx.lineWidth   = 1;
        ctx.fillStyle   = 'rgba(26,115,232,0.06)';
        ctx.fillRect(vfp1.x, vfp1.y, vfW, vfH);
        ctx.strokeRect(vfp1.x, vfp1.y, vfW, vfH);
    }

    // ── Layer 3: Active (temp wire, selection box) ─────────────────────────────

    _drawActive(ctx, vp) {
        const im = window.nodeInteractionManager;
        if (!im) return;

        // Temporary wire being dragged
        if (im.wireInProgress && im.wireInProgress.startPos && im.wireInProgress.currentPos) {
            ctx.save();
            ctx.translate(vp.x, vp.y);
            ctx.scale(vp.zoom, vp.zoom);
            this._drawBezier(ctx,
                im.wireInProgress.startPos,
                im.wireInProgress.currentPos,
                this._colors.wireHover,
                2 / vp.zoom, true);
            ctx.restore();
        }

        // Selection rubber-band box (screen-space — no transform)
        if (im.selectionBox) {
            const { startX, startY, endX, endY } = im.selectionBox;
            const x  = Math.min(startX, endX);
            const y  = Math.min(startY, endY);
            const bw = Math.abs(endX - startX);
            const bh = Math.abs(endY - startY);

            ctx.save();
            ctx.strokeStyle = this._colors.wireHover;
            ctx.lineWidth   = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(x, y, bw, bh);
            ctx.fillStyle = 'rgba(26,115,232,0.07)';
            ctx.fillRect(x, y, bw, bh);
            ctx.setLineDash([]);
            ctx.restore();
        }
    }

    // ── Bezier wire helper ─────────────────────────────────────────────────────

    _drawBezier(ctx, p1, p2, color, lineWidth, dashed) {
        const dx = Math.abs(p2.x - p1.x) * 0.55 + 40;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.bezierCurveTo(p1.x + dx, p1.y, p2.x - dx, p2.y, p2.x, p2.y);
        ctx.strokeStyle = color;
        ctx.lineWidth   = lineWidth;
        if (dashed) ctx.setLineDash([8 / (window.NodeGraph.viewport.zoom || 1), 4 / (window.NodeGraph.viewport.zoom || 1)]);
        ctx.stroke();
        if (dashed) ctx.setLineDash([]);
    }
}

window.nodeCanvasRenderer = new NodeCanvasRenderer();
