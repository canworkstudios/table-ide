// ====================================== TABLE CANVAS ======================================
// An infinite, pannable, zoomable surface for the table view — the Numbers model, where a
// sheet is a canvas holding free-floating tables rather than a document that stacks them.
//
//   • Wheel                 → pan; ctrl/cmd+wheel (and trackpad pinch) zooms to the cursor
//   • Space / middle / shift-drag → pan
//   • Drag empty canvas     → marquee-select tables and nodes
//   • Drag a card's header  → move it, with the rest of the selection
//   • Cmd/Ctrl + 0 / + / -  → reset / in / out
//
// The viewport math is lifted from the node editor (`nodeInteractions.js`): one
// `{x, y, zoom}` applied as a CSS transform, and screen↔canvas conversion through the same
// formula. This file deliberately does NOT reuse NodeGraph's viewport OBJECT — the node
// editor and the table view are two surfaces the user can hold at different zooms, and
// sharing the state would make one jump when the other moved.
//
// Positions live in `data-tf-x` / `data-tf-y` on the card. tableHistory snapshots
// `outerHTML`, so a position rides along with undo/redo and save with no extra plumbing.
//
// With the canvas on, EVERY sheet is mounted at once (SheetCanvas below), not only
// the active one. Each card is tagged data-sheet-id, and each sheet gets a labelled
// frame around its cards. Clicking into a table makes its sheet active; clicking a
// sheet tab pans to that sheet's frame. Dragging a frame's label moves the sheet.
//
// The node editor lives on this same surface (canvasGraph.js). The surface IS
// #nodeHtmlLayer, the viewport hosts the node renderer's wire/minimap canvases,
// and the view state is NodeGraph.viewport, so tables, operator nodes and the
// wires between them share one pan and zoom. NodeInteractionManager owns pointer
// input (marquee, node + card drag, wires, space/middle/shift pan); this file
// keeps the wheel, keyboard zoom, sheet frames and sheet mounting.
(function () {
    'use strict';

    const SHEET_GAP = 120;  // horizontal space between two sheets' frames
    const FRAME_PAD = 24;   // frame inset around a sheet's cards
    const MIN_ZOOM = 0.2;
    const MAX_ZOOM = 3;
    const CARD_SEL = '.tf-canvas-card';

    // One view state for tables and nodes. NodeGraph.viewport can be replaced
    // wholesale (nodeGraphManager.restore), so read through it every time
    // rather than holding the object.
    const vp = {};
    ['x', 'y', 'zoom'].forEach(k => Object.defineProperty(vp, k, {
        get: () => window.NodeGraph.viewport[k],
        set: v => { window.NodeGraph.viewport[k] = v; },
    }));
    let $viewport = null;   // the clipping element (fixed size, overflow hidden)
    let $surface  = null;   // the transformed element (#nodeHtmlLayer while on)
    let enabled   = false;
    let mounted   = false;  // every sheet's cards are on the surface
    let frameRaf  = 0;
    let viewportClickGuard = null;
    let lastDragEnd = 0;
    let cardObserver = null;

    // ── Coordinate helpers (same formula as nodeInteractions.screenToCanvas) ──
    function screenToCanvas(clientX, clientY) {
        const r = $viewport[0].getBoundingClientRect();
        return { x: (clientX - r.left - vp.x) / vp.zoom,
                 y: (clientY - r.top  - vp.y) / vp.zoom };
    }

    function applyTransform() {
        $surface.css('transform', `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`);
        if (window.nodeCanvasRenderer) {
            window.nodeCanvasRenderer.markBgDirty();
            window.nodeCanvasRenderer.markStaticDirty();
        }
        $(document).trigger('tf-canvas-transform');
        // The selection overlay is body-level and fixed, so it has to be told the
        // geometry moved under it.
        if (typeof window.scheduleTableGeometrySync === 'function') window.scheduleTableGeometrySync(window.currentTable);
        else if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
        _syncZoomLabel();
    }

    function _syncZoomLabel() {
        $('#tfZoomLevel').text(Math.round(vp.zoom * 100) + '%');
    }

    // ── Zoom ──────────────────────────────────────────────────────────────────
    // Anchored at a screen point so the thing under the cursor stays under it.
    function zoomAt(clientX, clientY, factor) {
        const r  = $viewport[0].getBoundingClientRect();
        const mx = clientX - r.left;
        const my = clientY - r.top;
        const oldZ = vp.zoom;
        const newZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZ * factor));
        if (newZ === oldZ) return;
        vp.x = mx - (mx - vp.x) * (newZ / oldZ);
        vp.y = my - (my - vp.y) * (newZ / oldZ);
        vp.zoom = newZ;
        applyTransform();
    }

    // Zoom about the viewport centre — what the toolbar buttons and shortcuts use.
    function zoomBy(factor) {
        const r = $viewport[0].getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    }

    function setZoom(z) {
        const r = $viewport[0].getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, z / vp.zoom);
    }

    function resetView() { vp.x = 0; vp.y = 0; vp.zoom = 1; applyTransform(); }

    function _fitBounds(b) {
        const r  = $viewport[0].getBoundingClientRect();
        const pad = 60;
        const z  = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
            Math.min((r.width - pad * 2) / (b.maxX - b.minX), (r.height - pad * 2) / (b.maxY - b.minY), 1)));
        vp.zoom = z;
        vp.x = r.width  / 2 - ((b.minX + b.maxX) / 2) * z;
        vp.y = r.height / 2 - ((b.minY + b.maxY) / 2) * z;
        applyTransform();
    }

    // Frame every card and operator node.
    function fitToContent() {
        const b = _bounds($surface.children(CARD_SEL + ', .ne-node'));
        if (!b) return resetView();
        _fitBounds(b);
    }

    // ── Card placement ────────────────────────────────────────────────────────
    function setCardPos($card, x, y) {
        $card[0].dataset.tfX = Math.round(x);
        $card[0].dataset.tfY = Math.round(y);
        $card.css({ left: Math.round(x) + 'px', top: Math.round(y) + 'px' });
    }

    function _cardsOf($root, sheetId) {
        return $root.children(CARD_SEL).filter(function () { return this.dataset.sheetId === sheetId; });
    }

    function _bounds($cards) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        $cards.each(function () {
            const isNode = this.classList.contains('ne-node');
            if (!isNode && this.dataset.tfX == null) return;
            const x = isNode ? this.offsetLeft : (parseFloat(this.dataset.tfX) || 0);
            const y = isNode ? this.offsetTop  : (parseFloat(this.dataset.tfY) || 0);
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + this.offsetWidth); maxY = Math.max(maxY, y + this.offsetHeight);
        });
        return minX === Infinity ? null : { minX, minY, maxX, maxY };
    }

    // Place a card that has no stored position. Within its sheet it goes below the
    // lowest card, so a new table never lands on another. A sheet with nothing placed
    // yet starts a new column to the right of everything else.
    function _nextFreeSlot($root, $card) {
        const sheetId = $card[0].dataset.sheetId;
        const own = _bounds(_cardsOf($root, sheetId).not($card));
        if (own) return { x: own.minX, y: own.maxY + 40 };
        const all = _bounds($root.children(CARD_SEL).not($card));
        return { x: all ? all.maxX + SHEET_GAP : 40, y: 60 };
    }

    // Stored positions come from when each sheet had the canvas to itself, so
    // two sheets can both sit at x=40. Shift any sheet that overlaps an earlier
    // one to the right of it. The shift is written to the tables, so it sticks.
    function _separateSheets() {
        if (!mounted) return;
        const placed = [];
        (window.sheets || []).forEach(function (sheet) {
            const $cards = _cardsOf($surface, sheet.id);
            const b = _bounds($cards);
            if (!b) return;
            const hit = placed.some(p => b.minX < p.maxX + FRAME_PAD && b.maxX + FRAME_PAD > p.minX &&
                                         b.minY < p.maxY + FRAME_PAD && b.maxY + FRAME_PAD > p.minY);
            if (hit) {
                const right = Math.max.apply(null, placed.map(p => p.maxX));
                const dx = right + SHEET_GAP - b.minX;
                $cards.each(function () { _moveCard($(this), dx, 0); });
                b.minX += dx; b.maxX += dx;
            }
            placed.push(b);
        });
    }

    // Lay out auto-placed cards again with their real sizes. A card is first
    // placed while its grid chrome is still being built, so the width it had
    // then is not the width it ends up with; columns placed from that guess
    // leave gaps or overlap. Sheets are columns, left to right in tab order.
    // Cards the user has moved are never touched: they only push later
    // columns further right. Operator nodes are obstacles a column steps past.
    function _layoutAuto() {
        if (!mounted) return;
        const isAuto = el => { const t = el.querySelector('table'); return t && t.dataset.tfAuto === '1'; };
        const nodes = $surface.children('.ne-node').map(function () {
            return { minX: this.offsetLeft, minY: this.offsetTop,
                     maxX: this.offsetLeft + this.offsetWidth, maxY: this.offsetTop + this.offsetHeight };
        }).get();
        let cursor = 40;
        (window.sheets || []).forEach(function (sheet) {
            const $cards = _cardsOf($surface, sheet.id);
            if (!$cards.length) return;
            const $auto = $cards.filter(function () { return isAuto(this); });
            const $pinned = $cards.not($auto);
            let x, y;
            if ($pinned.length) {
                const b = _bounds($pinned);
                x = b.minX; y = b.maxY + 40;
            } else {
                x = cursor; y = 60;
                const w = Math.max.apply(null, $auto.map(function () { return this.offsetWidth; }).get());
                const h = $auto.get().reduce((sum, el) => sum + el.offsetHeight + 40, 0);
                let hit;
                while ((hit = nodes.find(n => x < n.maxX + FRAME_PAD && x + w + FRAME_PAD > n.minX && y < n.maxY && y + h > n.minY))) {
                    x = hit.maxX + SHEET_GAP;
                }
            }
            $auto.each(function () {
                if (parseFloat(this.dataset.tfX) !== x || parseFloat(this.dataset.tfY) !== y) {
                    setCardPos($(this), x, y);
                    const t = this.querySelector('table');
                    t.dataset.tfX = x; t.dataset.tfY = y;
                }
                y += this.offsetHeight + 40;
            });
            const b = _bounds($cards);
            if (b) cursor = Math.max(cursor, b.maxX + SHEET_GAP);
        });
    }

    function _moveCard($card, dx, dy) {
        const x = (parseFloat($card[0].dataset.tfX) || 0) + dx;
        const y = (parseFloat($card[0].dataset.tfY) || 0) + dy;
        setCardPos($card, x, y);
        const t = $card.find('table')[0];
        if (t) { t.dataset.tfX = $card[0].dataset.tfX; t.dataset.tfY = $card[0].dataset.tfY; }
    }

    // Wrap every top-level accordion+panel pair into one positioned card.
    // Idempotent: a card already wrapped is left alone.
    function _wrapCards() {
        // Cards live on the SURFACE once the canvas is on; before that they are
        // still direct children of the container. Wrap wherever they are.
        const $c = $surface && $surface.length ? $surface : $('#tableContainer');
        $c.children('.accordion').each(function () {
            const $btn = $(this);
            if ($btn.parent().hasClass('tf-canvas-card')) return;
            const $panel = $btn.next('.panel');
            const $card = $('<div class="tf-canvas-card"></div>');
            if ($btn[0].dataset.sheetId) $card[0].dataset.sheetId = $btn[0].dataset.sheetId;
            $btn.before($card);
            $card.append($btn).append($panel);
        });
        // Position anything not yet placed.
        $c.children(CARD_SEL).each(function () {
            const $card = $(this);
            const t = $card.find('table')[0];
            // A position stored on the table survives undo/redo, since history
            // snapshots the table's outerHTML and not the card's.
            const sx = t && t.dataset.tfX, sy = t && t.dataset.tfY;
            if (sx != null && sy != null && sx !== '') {
                setCardPos($card, parseFloat(sx), parseFloat(sy));
            } else if (this.dataset.tfX == null) {
                const p = _nextFreeSlot($c, $card);
                setCardPos($card, p.x, p.y);
                // Auto-placed: _layoutAuto may move it again once its real size
                // is known. Stored on the table so it survives serialization;
                // dragging the card clears it.
                if (t) { t.dataset.tfX = p.x; t.dataset.tfY = p.y; t.dataset.tfAuto = '1'; }
            }
            if (cardObserver) cardObserver.observe(this);
        });
    }

    // ── Sheet mounting ────────────────────────────────────────────────────────
    // Tag every top-level node of a sheet's card markup with its sheet id.
    function _sheetNodes(sheetId, html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html || '';
        const nodes = [...tmp.childNodes].filter(n => n.nodeType === 1);
        nodes.forEach(n => { n.dataset.sheetId = sheetId; });
        return nodes;
    }

    function _cardsHtmlFor(sheet) {
        if (sheet.containerHtml) return window.stampTableIds(sheet.containerHtml, sheet);
        const n = Math.max(1, parseInt($('#buttonIndex').val(), 10) || 1);
        const raw = window.stampTableIds(sheet.rawHtml || '', sheet);
        return (typeof buildTableCardsHtml === 'function' && buildTableCardsHtml(raw, n)) || '';
    }

    // The card markup exactly as a single-sheet container would hold it
    // (accordion + panel pairs, no card wrapper), so a sheet unmounted from the
    // canvas restores through the normal containerHtml path.
    function _serializeSheet(sheetId) {
        let html = '';
        _cardsOf($surface, sheetId).each(function () {
            $(this).children().not('.tf-card-port').each(function () { html += this.outerHTML; });
        });
        return html;
    }

    function _afterStructureChange() {
        _wrapCards();
        _layoutAuto();
        _separateSheets();
        renderFrames();
        if (window.CanvasGraph) window.CanvasGraph.syncTableNodes();
        if (typeof window.initializeAllFeatures === 'function') window.initializeAllFeatures();
        if (typeof window.setupTableInteraction === 'function') window.setupTableInteraction();
        requestAnimationFrame(_rerenderRulers);
    }

    // Caller saves the active sheet first, while #tableContainer still holds
    // plain cards: once the viewport wraps them, its innerHTML is no longer a
    // sheet snapshot.
    function _mountAll(curId) {
        $surface.empty();
        (window.sheets || []).forEach(function (sheet) {
            _sheetNodes(sheet.id, _cardsHtmlFor(sheet)).forEach(n => $surface[0].appendChild(n));
        });
        // Every table starts open on the canvas, even one collapsed in the list
        // view. Collapsing it here afterwards is the user's call.
        $surface.find('.panel').css('display', '');
        mounted = true;
        _afterStructureChange();
        window.currentTable = (curId && $surface.find(`table[data-table-ide-id="${curId}"]`)[0]) ||
                              firstTable(window.activeSheetId) || null;
    }

    function saveAll() {
        if (!mounted) return;
        (window.sheets || []).forEach(function (sheet) {
            if (_cardsOf($surface, sheet.id).length) sheet.containerHtml = _serializeSheet(sheet.id);
        });
    }

    function ensureSheetCards(sheetId) {
        if (!mounted || _cardsOf($surface, sheetId).length) return;
        const sheet = (window.sheets || []).find(s => s.id === sheetId);
        if (!sheet) return;
        _sheetNodes(sheetId, _cardsHtmlFor(sheet)).forEach(n => $surface[0].appendChild(n));
        _afterStructureChange();
    }

    function replaceSheetCards(sheetId, cardsHtml) {
        if (!mounted) return;
        const $old = _cardsOf($surface, sheetId);
        const nodes = _sheetNodes(sheetId, cardsHtml);
        if ($old.length) nodes.forEach(n => $old[0].parentNode.insertBefore(n, $old[0]));
        else nodes.forEach(n => $surface[0].appendChild(n));
        $old.remove();
        _afterStructureChange();
    }

    function removeSheetCards(sheetId) {
        if (!mounted) return;
        _cardsOf($surface, sheetId).remove();
        renderFrames();
        if (window.CanvasGraph) window.CanvasGraph.syncTableNodes();
    }

    function firstTable(sheetId) {
        if (!mounted) return null;
        return _cardsOf($surface, sheetId).find('table')[0] || null;
    }

    function sheetHtml(sheetId) {
        if (!mounted || !_cardsOf($surface, sheetId).length) return null;
        return _serializeSheet(sheetId);
    }

    function focusSheet(sheetId) {
        if (!mounted) return;
        const b = _bounds(_cardsOf($surface, sheetId));
        if (!b) return;
        _fitBounds(b);
    }

    // ── Sheet frames ──────────────────────────────────────────────────────────
    // One labelled box per sheet, sized to its cards. Drawn under the cards and
    // rebuilt whenever a card moves or resizes, so it never needs its own layout.
    function renderFrames() {
        if (!mounted) return;
        $surface.children('.tf-sheet-frame').remove();
        const frag = document.createDocumentFragment();
        (window.sheets || []).forEach(function (sheet) {
            const b = _bounds(_cardsOf($surface, sheet.id));
            if (!b) return;
            const f = document.createElement('div');
            f.className = 'tf-sheet-frame' + (sheet.id === window.activeSheetId ? ' is-active' : '');
            f.dataset.sheetId = sheet.id;
            f.style.left   = (b.minX - FRAME_PAD) + 'px';
            f.style.top    = (b.minY - FRAME_PAD - 22) + 'px';
            f.style.width  = (b.maxX - b.minX + FRAME_PAD * 2) + 'px';
            f.style.height = (b.maxY - b.minY + FRAME_PAD * 2 + 22) + 'px';
            const label = document.createElement('div');
            label.className = 'tf-sheet-frame-label';
            label.title = 'Drag to move this sheet. Click to make it active.';
            label.textContent = sheet.name;
            f.appendChild(label);
            frag.appendChild(f);
        });
        $surface[0].insertBefore(frag, $surface[0].firstChild);
    }

    function _scheduleFrames() {
        if (frameRaf) return;
        frameRaf = requestAnimationFrame(function () {
            frameRaf = 0;
            _layoutAuto();
            renderFrames();
            if (window.CanvasGraph) window.CanvasGraph.refreshGeometry();
        });
    }

    // ── Enable / disable ──────────────────────────────────────────────────────
    // Elements borrowed from the old node editor view. They keep their ids (the
    // renderer, config panel and CSS find them by id) and go back on disable.
    const BORROWED = ['#nodeCanvasLayer', '#neBgBuffer', '#neStaticBuffer'];

    function enable() {
        if (enabled) return;
        const $c = $('#tableContainer');
        if (!$c.length) return;

        const hasSheets = (window.sheets || []).length > 0;
        const curId = window.currentTable && window.currentTable.getAttribute('data-table-ide-id');
        if (hasSheets && typeof _saveActiveSheetState === 'function') _saveActiveSheetState();

        $c.addClass('tf-canvas-on');
        // Viewport clips; the surface carries the transform. Operator nodes are
        // re-rendered from the graph below, so any stale node DOM goes first.
        $surface  = $('#nodeHtmlLayer').detach().empty().addClass('tf-canvas-surface');
        if (!$surface.length) $surface = $('<div class="tf-canvas-surface"></div>');
        $viewport = $('<div class="tf-canvas-viewport"></div>');
        BORROWED.forEach(sel => $(sel).appendTo($viewport));
        $viewport.append($surface);
        $('.node-editor-minimap, #neConfigPanel').appendTo($viewport);
        $c.children().appendTo($surface);
        $c.append($viewport);

        if (window.ResizeObserver) cardObserver = new ResizeObserver(_scheduleFrames);
        _wire();
        enabled = true;

        if (hasSheets) {
            _mountAll(curId);
        } else {
            _wrapCards();
            _rerenderRulers();
        }
        if (window.CanvasGraph) window.CanvasGraph.attach($viewport[0]);
        if (hasSheets) fitToContent(); else applyTransform();
    }

    function disable() {
        if (!enabled) return;
        const $c = $('#tableContainer');
        if (window.CanvasGraph) window.CanvasGraph.detach();
        if (mounted) {
            saveAll();
            // Back to one sheet at a time: only the active sheet stays in the DOM.
            $surface.children('.tf-sheet-frame').remove();
            $surface.children(CARD_SEL).filter(function () {
                return this.dataset.sheetId && this.dataset.sheetId !== window.activeSheetId;
            }).remove();
            mounted = false;
        }
        if (cardObserver) { cardObserver.disconnect(); cardObserver = null; }
        // Operator nodes only exist on the canvas; the graph keeps them.
        $surface.children('.ne-node').remove();
        // Unwrap: cards back to plain accordion+panel in document order.
        $surface.find(CARD_SEL).each(function () {
            const $card = $(this);
            $card.children('.tf-card-port').remove();
            $card.before($card.children());
            $card.remove();
        });
        $surface.children().appendTo($c);
        // Return the borrowed node-editor elements to their old home.
        const $home = $('#nodeEditorViewport');
        BORROWED.forEach(sel => $(sel).appendTo($home));
        $surface.removeClass('tf-canvas-surface').css('transform', '').appendTo($home);
        $viewport.find('.node-editor-minimap, #neConfigPanel').appendTo($home);
        $viewport.remove();
        $c.removeClass('tf-canvas-on');
        $viewport = $surface = null;
        enabled = false;
        _unwire();
        if (!$.contains(document, window.currentTable || document.createElement('i'))) {
            window.currentTable = $c.find('table')[0] || null;
        }
        if (typeof window.setupTableInteraction === 'function') window.setupTableInteraction();
        _rerenderRulers();
    }

    // The one switch for the merged canvas. The Node Editor toggle, the canvas
    // toggle and the ?view=node-editor deep link all land here.
    function setOn(on) {
        if (on === enabled) return;
        if (on) { $('body').addClass('tf-canvas-active'); enable(); }
        else    { disable(); $('body').removeClass('tf-canvas-active'); }
        window.nodeEditorEnabled = enabled;
        $('#tfCanvasToggle').toggleClass('is-on', enabled);
        $('#nodeEditorToggle').toggleClass('active', enabled)
            .attr('title', enabled ? 'Canvas and nodes: ON' : 'Canvas and nodes: OFF');
    }

    function _rerenderRulers() {
        if (typeof window.renderTableRulers !== 'function') return;
        $('#tableContainer table.tablecoil').each(function () {
            if (this.getBoundingClientRect().width > 0) window.renderTableRulers(this);
        });
    }

    // ── Event wiring ──────────────────────────────────────────────────────────
    // Pointer input (marquee, drag, wires, pan) is NodeInteractionManager's,
    // attached by CanvasGraph. What stays here is what the graph manager has no
    // notion of: the wheel, keyboard zoom, sheets and frames.
    function _wire() {
        // Wheel: ctrl/meta (or trackpad pinch) zooms; plain wheel scrolls the surface.
        $viewport.on('wheel.tfcanvas', function (e) {
            const oe = e.originalEvent;
            // The config panel and minimap scroll or ignore the wheel themselves.
            if ($(oe.target).closest('#neConfigPanel').length) return;
            oe.preventDefault();
            if (oe.ctrlKey || oe.metaKey) {
                zoomAt(oe.clientX, oe.clientY, oe.deltaY > 0 ? 0.92 : 1.08);
            } else {
                vp.x -= oe.deltaX;
                vp.y -= oe.deltaY;
                applyTransform();
            }
        });

        // A card header is both the drag handle and the accordion toggle. A
        // drag ends with a click on the header, which would collapse the card
        // the user just moved, so swallow that one click. A plain click still
        // toggles. Capture phase, so it runs before headerAccordion's handler.
        viewportClickGuard = function (e) {
            if (performance.now() - lastDragEnd > 250) return;
            if (e.target.closest && e.target.closest('.tf-canvas-card > .accordion')) {
                e.stopPropagation();
                e.preventDefault();
            }
        };
        $viewport[0].addEventListener('click', viewportClickGuard, true);

        // Any press inside a card makes its sheet the active one, so history,
        // exports and the tab bar follow the table being worked on.
        $viewport.on('pointerdown.tfcanvas', CARD_SEL, function () {
            const id = this.dataset.sheetId;
            if (id && typeof window.setActiveSheetQuiet === 'function') window.setActiveSheetQuiet(id);
        });

        // Frame label: selects every table in the sheet and drags them as one
        // group; a press without a move just makes the sheet active.
        $viewport.on('pointerdown.tfcanvas', '.tf-sheet-frame-label', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            const id = $(this).parent()[0].dataset.sheetId;
            if (typeof window.setActiveSheetQuiet === 'function') window.setActiveSheetQuiet(id);
            if (window.CanvasGraph) window.CanvasGraph.dragSheet(id, _cardsOf($surface, id), e.originalEvent);
        });

        $(document).on('keydown.tfcanvas', function (e) {
            if (!(e.metaKey || e.ctrlKey)) return;
            if ($(e.target).is('input, textarea, [contenteditable=true]')) return;
            if (e.key === '0') { e.preventDefault(); resetView(); }
            else if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(1.1); }
            else if (e.key === '-') { e.preventDefault(); zoomBy(0.9); }
        });
    }

    function _unwire() {
        $(document).off('.tfcanvas');
        if ($viewport) {
            $viewport.off('.tfcanvas');
            if (viewportClickGuard) $viewport[0].removeEventListener('click', viewportClickGuard, true);
        }
        viewportClickGuard = null;
    }

    // Called by CanvasGraph while the graph manager drags cards: keep each
    // card's stored position (and its table's, which rides undo) in step.
    function syncCardPositions(ids, done) {
        let last = null;
        (ids || []).forEach(function (id) {
            const card = $surface && $surface.children(CARD_SEL).filter(function () { return this.dataset.nodeId === id; })[0];
            if (!card) return;
            card.dataset.tfX = Math.round(parseFloat(card.style.left) || 0);
            card.dataset.tfY = Math.round(parseFloat(card.style.top)  || 0);
            const t = card.querySelector('table');
            // Placed by hand now, so auto layout leaves it alone. Cleared on the
            // first move, not at drop, or a reflow mid-drag would fight the pointer.
            if (t) delete t.dataset.tfAuto;
            if (t && done) { t.dataset.tfX = card.dataset.tfX; t.dataset.tfY = card.dataset.tfY; last = t; }
        });
        _scheduleFrames();
        if (!done) return;
        lastDragEnd = performance.now();
        // Moving one table is a table edit with its own undo step; moving a
        // group is not, since undo is per table and would move only one back.
        if (last && ids.length === 1) {
            window.currentTable = last;
            if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
        }
        if (typeof window.scheduleTableGeometrySync === 'function') window.scheduleTableGeometrySync(window.currentTable);
        else if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
    }

    // Called after a table is added/removed so new cards get wrapped and placed.
    function refresh() {
        if (!enabled) return;
        // Newly appended nodes land in #tableContainer, outside the surface.
        const $c = $('#tableContainer');
        $c.children().not('.tf-canvas-viewport').each(function () {
            // A table drawn onto the canvas belongs to the active sheet.
            if (mounted && !this.dataset.sheetId && window.activeSheetId) this.dataset.sheetId = window.activeSheetId;
        }).appendTo($surface);
        _wrapCards();
        renderFrames();
    }

    // ── Toolbar wiring ────────────────────────────────────────────────────────
    $(function () {
        $('#tfCanvasToggle').on('click', function () { setOn(!enabled); });
        $('#tfZoomIn').on('click',  () => enabled && zoomBy(1.1));
        $('#tfZoomOut').on('click', () => enabled && zoomBy(0.9));
        $('#tfZoomFit').on('click', () => enabled && fitToContent());
        $('#tfZoomLevel').on('click', () => enabled && resetView());
    });

    window.SheetCanvas = {
        isMounted: () => enabled && mounted,
        cards: () => ($surface ? $surface.children(CARD_SEL) : $()),
        syncCardPositions,
        saveAll, ensureSheetCards, replaceSheetCards, removeSheetCards,
        firstTable, sheetHtml, focusSheet, renderFrames,
    };

    window.TableCanvas = {
        enable, disable, setOn, refresh, resetView, fitToContent, zoomBy, setZoom, applyTransform,
        screenToCanvas,
        isEnabled: () => enabled,
        get zoom() { return vp.zoom; }
    };
})();
