// ===================================================================================
// TABLE RULER — column and row index strips around .tablecoil tables
//   renderTableRulers(table) — builds/rebuilds ruler wrap around a table
//   highlightRuler(table, cells) — highlights ruler segments for selected cells
//   destroyRulers(table) — removes ruler wrap and restores table to original position
// ===================================================================================

window.tableRuler = (function () {

    const DRAG_THRESHOLD_PX = 4; // pixels of movement before a mousedown becomes a reorder drag

    // Geometry inside the table canvas lives in layout coordinates and is then
    // transformed as one surface. Rulers must therefore be sized in layout
    // pixels, while the body-level selection overlay is positioned from
    // viewport rectangles. Keep those two updates in one scheduled pass so a
    // pane transition, SP switch, or canvas transform cannot update only half
    // of the chrome.
    function scheduleGeometrySync(table) {
        table = table || window.currentTable;
        if (!table || !document.documentElement.contains(table)) return;
        // Coalesce bursts to one measurement per paint, but never keep pushing
        // the frame away. Canvas pan/zoom emits continuously; cancelling on
        // every pointermove would make the overlay freeze until the gesture
        // ended.
        if (table._tableIdeGeometryFrame) return;
        table._tableIdeGeometryFrame = requestAnimationFrame(() => {
            delete table._tableIdeGeometryFrame;
            const wrap = $(table).closest('.table-ide-ruler-wrap')[0];
            if (wrap && table.offsetParent !== null) _syncRulerSegments(wrap, table);
            if (table === window.currentTable && typeof window.updateSelectionHandles === 'function') {
                window.updateSelectionHandles();
            }
        });
    }

    // ── Column labels ─────────────────────────────────────────────────────────
    // A, B, … Z, AA, AB … — the spreadsheet convention. Numbers on the column
    // strip and numbers on the row strip give a cell two coordinates that look
    // alike ("3,4"); letters make an address readable the way B7 is.
    function colLabel(idx) {
        let s = '';
        for (let n = idx; n >= 0; n = Math.floor(n / 26) - 1) {
            s = String.fromCharCode(65 + (n % 26)) + s;
        }
        return s;
    }

    // ── Sync ruler segment sizes to live cell dimensions post-layout ─────────
    // Called after the wrap is in the DOM so getBoundingClientRect is accurate.
    // Row segments: height matches each <tr> height.
    // Col segments: width matches each visual column width (first non-spanning cell wins).
    function _syncRulerSegments(wrap, table) {
        const mapper   = new window.VisualGridMapper(table);
        const $rowSegs = $(wrap).find('.table-ide-row-ruler .ruler-seg');
        const $colSegs = $(wrap).find('.table-ide-col-ruler .ruler-seg');

        // Row heights — read from live <tr> rects
        const rows = Array.from(table.rows).filter(r => !r.classList.contains('table-ide-drag-row') && !r.classList.contains('drop-indicator-row'));
        // Rows with zero height are hidden (collapsed accordion children, sp-hidden) —
        // hide their ruler segment instead of leaving a mis-sized ghost.
        $rowSegs.each(function (i) {
            const row = rows[i];
            if (!row) return;
            // offsetHeight is the untransformed layout size. Using the viewport
            // rect here double-applies TableCanvas zoom because the ruler is a
            // sibling inside that same transformed surface.
            const h = row.offsetHeight;
            if (h > 0) {
                $(this).css({ 'min-height': h + 'px', 'max-height': h + 'px', height: h + 'px', display: '' });
            } else {
                $(this).css('display', 'none');
            }
        });

        // Col widths — for each visual col, find the first non-spanning origin cell and read its width.
        // Track which cols have ANY visible cell: a col whose cells are all hidden
        // (e.g. inactive sp-N truncation classes) gets its segment hidden too.
        const seen       = new Array(mapper.maxCols).fill(false);
        const hasVisible = new Array(mapper.maxCols).fill(false);
        mapper.cellMap.forEach((info, cell) => {
            const w = cell.offsetWidth;
            if (w > 0) {
                for (let c = info.startCol; c < info.startCol + info.colspan; c++) hasVisible[c] = true;
            }
            if (info.colspan === 1 && !seen[info.startCol] && w > 0) {
                seen[info.startCol] = true;
                // A pinned column's authority is its <col> width, not the rect:
                // mid-drag the rect lags a frame behind and the ruler visibly
                // trails the boundary the user is holding.
                const pinned = table.querySelector('colgroup.tf-colgroup');
                const declared = pinned && pinned.children[info.startCol]
                    ? parseFloat(pinned.children[info.startCol].style.width) : 0;
                const use = declared || w;
                $colSegs.filter(`[data-col="${info.startCol}"]`)
                    .css({ 'min-width': use + 'px', 'max-width': use + 'px', width: use + 'px', display: '' });
            }
        });
        // Unseen cols: hide segment if the whole column is hidden, else average fallback
        const seenWidths = $colSegs.toArray().map((s, i) => seen[i] ? parseFloat($(s).css('min-width')) || 0 : 0).filter(w => w > 0);
        const avg = seenWidths.length ? Math.round(seenWidths.reduce((a, b) => a + b, 0) / seenWidths.length) : 80;
        $colSegs.each(function (i) {
            if (seen[i]) return;
            if (!hasVisible[i]) {
                $(this).css('display', 'none');
            } else {
                $(this).css({ 'min-width': avg + 'px', 'max-width': avg + 'px', width: avg + 'px', display: '' });
            }
        });

        // The row-ruler viewport has to be exactly as tall as the table
        // viewport, or scrollTop means something different on each side and the
        // numbers drift out of phase with the rows they name.
        //
        // It cannot be left to `align-items: stretch`: the strip's own content
        // is as tall as the whole table, so under stretch the flex line would
        // size to THAT and the viewport would never clip. The measurement has
        // to come from the sibling.
        const tableVp    = wrap.querySelector('.table-ide-table-vp');
        const rowRulerVp = wrap.querySelector('.table-ide-row-ruler-vp');
        // A zero height means the card is collapsed or offscreen, not that the
        // strip should be one pixel tall — pinning it there would leave the
        // ruler blank when the panel reopens.
        if (tableVp && rowRulerVp && tableVp.clientHeight > 0) {
            rowRulerVp.style.height = tableVp.clientHeight + 'px';
            rowRulerVp.scrollTop    = tableVp.scrollTop;
        }
    }

    // ── Column / row sizing ───────────────────────────────────────────────────
    //
    // The grid was `width: 100%` + `table-layout: auto`, which means the browser
    // decides every column width from its content and re-decides on every
    // keystroke. Nothing could be sized: a width you set was a suggestion auto
    // layout overrode, columns jumped as you typed, and one long value blew the
    // rest of the grid out of shape. That is the rigidity — the table looks
    // structured and cannot actually be shaped.
    //
    // A spreadsheet is auto UNTIL you take control, then it is exactly what you
    // set. So the first resize pins every column at the width it currently has,
    // switches the table to `table-layout: fixed`, and sets an explicit table
    // width. From then on a column is a number the user owns.
    //
    // Widths live in a <colgroup>, which is invisible to GridMapper (it walks
    // <tr>) and to the cell selection model, so merged cells and spans are
    // unaffected.

    const MIN_COL_PX = 24;
    const MIN_ROW_PX = 18;

    function _isPinned(table) {
        return table.getAttribute('data-tf-sized') === '1';
    }

    /** Freeze the current auto layout into explicit per-column widths. */
    function _pinColumns(table) {
        if (_isPinned(table)) return table.querySelector('colgroup.tf-colgroup');
        const mapper = new window.VisualGridMapper(table);
        const widths = new Array(mapper.maxCols).fill(0);

        // Measure BEFORE anything changes, or the pin captures a layout that is
        // already reacting to the pin.
        mapper.cellMap.forEach((info, cell) => {
            if (info.colspan !== 1) return;
            const w = cell.getBoundingClientRect().width;
            if (w > widths[info.startCol]) widths[info.startCol] = w;
        });
        for (let i = 0; i < widths.length; i++) {
            if (!widths[i]) widths[i] = 80;
        }

        const cg = document.createElement('colgroup');
        cg.className = 'tf-colgroup';
        widths.forEach(w => {
            const col = document.createElement('col');
            col.style.width = Math.round(w) + 'px';
            cg.appendChild(col);
        });
        table.insertBefore(cg, table.firstChild);

        table.style.tableLayout = 'fixed';
        table.style.width = Math.round(widths.reduce((a, b) => a + b, 0)) + 'px';
        table.setAttribute('data-tf-sized', '1');
        return cg;
    }

    /** Hand the grid back to the browser. */
    function releaseSizing(table) {
        const cg = table.querySelector('colgroup.tf-colgroup');
        if (cg) cg.remove();
        table.style.tableLayout = '';
        table.style.width = '';
        table.removeAttribute('data-tf-sized');
        Array.from(table.rows).forEach(r => { r.style.height = ''; });
        renderTableRulers(table);
    }

    function _setColWidth(table, colIdx, px) {
        const cg = _pinColumns(table);
        const col = cg && cg.children[colIdx];
        if (!col) return;
        col.style.width = Math.max(MIN_COL_PX, Math.round(px)) + 'px';
        let total = 0;
        Array.from(cg.children).forEach(c => { total += parseFloat(c.style.width) || 0; });
        table.style.width = Math.round(total) + 'px';
    }

    function _colWidth(table, colIdx) {
        const cg = table.querySelector('colgroup.tf-colgroup');
        if (cg && cg.children[colIdx]) return parseFloat(cg.children[colIdx].style.width) || 0;
        const mapper = new window.VisualGridMapper(table);
        let w = 0;
        mapper.cellMap.forEach((info, cell) => {
            if (info.colspan === 1 && info.startCol === colIdx) {
                w = Math.max(w, cell.getBoundingClientRect().width);
            }
        });
        return w;
    }

    /**
     * Width of the widest content in a column, so a double-click on the
     * boundary fits the column to it (the Excel gesture).
     *
     * Measured by cloning one cell's text into an off-screen span with the
     * cell's own font, because a pinned cell's rect is the pinned width and
     * tells you nothing about what is inside it.
     */
    function _autoFitWidth(table, colIdx) {
        const mapper = new window.VisualGridMapper(table);
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:-9999px;';
        document.body.appendChild(probe);
        let widest = MIN_COL_PX;
        mapper.cellMap.forEach((info, cell) => {
            if (info.colspan !== 1 || info.startCol !== colIdx) return;
            const cs = getComputedStyle(cell);
            probe.style.font = cs.font;
            probe.textContent = cell.textContent || '';
            const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2;
            widest = Math.max(widest, probe.getBoundingClientRect().width + pad);
        });
        probe.remove();
        return Math.ceil(widest);
    }

    function _setRowHeight(table, rowIdx, px) {
        const rows = Array.from(table.rows).filter(r =>
            !r.classList.contains('table-ide-drag-row') && !r.classList.contains('drop-indicator-row'));
        const row = rows[rowIdx];
        if (row) row.style.height = Math.max(MIN_ROW_PX, Math.round(px)) + 'px';
    }

    /**
     * Wire the drag grips that sit on each segment's trailing border.
     *
     * The grip is a child of the segment, so it has to stop the mousedown from
     * reaching the segment's own select/reorder handler.
     */
    function _wireResize($wrap, table) {
        let drag = null;

        const stop = () => {
            if (!drag) return;
            $('body').removeClass('tf-resizing-col tf-resizing-row');
            drag = null;
            $(document).off('mousemove.tfresize mouseup.tfresize');
            requestAnimationFrame(() => {
                _syncRulerSegments($wrap[0], table);
                if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
                if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
            });
        };

        const move = (e) => {
            if (!drag) return;
            if (drag.axis === 'col') {
                _setColWidth(table, drag.index, drag.start + (e.clientX - drag.origin));
            } else {
                _setRowHeight(table, drag.index, drag.start + (e.clientY - drag.origin));
            }
            _syncRulerSegments($wrap[0], table);
        };

        // Bound on the ruler containers, not on the wrap: the segment handlers
        // are delegated from those same containers and stop propagation, so a
        // wrap-level listener is never reached.
        $wrap.find('.table-ide-col-ruler-vp, .table-ide-row-ruler').on('mousedown', '.ruler-grip', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const $seg = $(this).closest('.ruler-seg');
            const axis = $(this).hasClass('ruler-grip-col') ? 'col' : 'row';
            const index = parseInt($seg.attr(axis === 'col' ? 'data-col' : 'data-row'), 10);
            if (isNaN(index)) return;
            drag = {
                axis, index,
                origin: axis === 'col' ? e.clientX : e.clientY,
                start: axis === 'col'
                    ? _colWidth(table, index)
                    : $seg[0].getBoundingClientRect().height,
            };
            $('body').addClass('tf-resizing-' + axis);
            $(document).on('mousemove.tfresize', move).on('mouseup.tfresize', stop);
        });

        // Double-click a column boundary → fit the column to its content.
        $wrap.find('.table-ide-col-ruler-vp').on('dblclick', '.ruler-grip-col', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt($(this).closest('.ruler-seg').attr('data-col'), 10);
            if (isNaN(idx)) return;
            _setColWidth(table, idx, _autoFitWidth(table, idx));
            _syncRulerSegments($wrap[0], table);
            if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
        });

        // Double-click the corner → release every pin, back to content-fit.
        $wrap.on('dblclick', '.table-ide-corner', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (_isPinned(table)) releaseSizing(table);
        });
    }

    // ── Apply a ruler-driven selection (row or column) ────────────────────────
    function _applyRulerSelection(table, cells, type) {
        // A row spans every column, including the ones the active sp- tab
        // hides — so selecting a row by its number used to pick up cells from
        // the other tabs, which Delete then cleared out of sight.
        const filtered = cells.filter(c => !$(c).hasClass('drag-handle') && window.isCellVisible(c));
        $(table).find('.selected-cell').removeClass('selected-cell');
        filtered.forEach(c => $(c).addClass('selected-cell'));
        window.selectedCells       = filtered;
        window.selectionAnchorCell = filtered[0]                    || null;
        window.selectionHeadCell   = filtered[filtered.length - 1]  || null;
        window.currentTable        = table;
        const $dd = $('#elementType');
        if ($dd.length) $dd.val(type);
        requestAnimationFrame(() => {
            if (typeof window.highlightRuler === 'function') {
                window.highlightRuler(table, window.selectedCells);
            }
            if (typeof window.updateSelectionHandles === 'function') {
                window.updateSelectionHandles();
            }
            _syncGridChrome(table);
        });
    }

    // ── Click-to-select: shift extends, ctrl/cmd adds ─────────────────
    // Three gestures, matching a spreadsheet header:
    //   plain click      → replace the selection with this row/column
    //   shift-click      → extend contiguously from the stored anchor
    //   ctrl/cmd-click   → add (or remove) this row/column, keeping the rest
    //
    // The additive case is what makes discontiguous selections possible, so
    // "delete rows 2, 5 and 9" is one gesture and one op instead of three.
    // _rulerRowSet / _rulerColSet is the authoritative set of selected indices;
    // cells are derived from it, never the other way round, because a merged
    // cell belongs to several indices at once.
    //
    // It is stored on the TABLE, not on the wrap: renderTableRulers throws the
    // wrap away and rebuilds it on every structural change, so a set kept there
    // was silently lost the moment you inserted a row — which is exactly when a
    // multi-selection matters most. The table element survives the rebuild.
    function _isAdditive(e)  { return !!(e && (e.metaKey || e.ctrlKey)); }
    function _isExtending(e) { return !!(e && e.shiftKey); }

    // Turn a set of row indices into the cell list, in visual order.
    function _cellsForRows(mapper, rows) {
        const cells = [];
        Array.from(rows).sort((a, b) => a - b).forEach(r => {
            mapper.getCellsInRow(r).forEach(c => {
                if (!$(c).hasClass('drag-handle') && cells.indexOf(c) === -1) cells.push(c);
            });
        });
        return cells;
    }

    function _cellsForCols(mapper, cols) {
        const cells = [];
        Array.from(cols).sort((a, b) => a - b).forEach(c => {
            mapper.getCellsInColumn(c).forEach(cell => {
                if (!$(cell).hasClass('drag-handle') && cells.indexOf(cell) === -1) cells.push(cell);
            });
        });
        return cells;
    }

    function _handleRulerRowClick($wrap, table, rowIdx, e) {
        const mapper = new window.VisualGridMapper(table);
        const w      = table;
        let rows;

        if (_isExtending(e) && w._rulerRowAnchor != null) {
            // Extend from the anchor. When the press is also additive the new
            // band unions with what was already held, which is how a
            // spreadsheet grows a second block without losing the first.
            const from = w._rulerRowAnchor;
            const min  = Math.min(from, rowIdx);
            const max  = Math.max(from, rowIdx);
            rows = _isAdditive(e) ? new Set(w._rulerRowSet || []) : new Set();
            for (let r = min; r <= max; r++) rows.add(r);
        } else if (_isAdditive(e)) {
            rows = new Set(w._rulerRowSet || []);
            // Toggle: ctrl-clicking a held row releases it. Never empty the
            // selection entirely — a no-op reads as a dead click.
            if (rows.has(rowIdx) && rows.size > 1) rows.delete(rowIdx);
            else                                   rows.add(rowIdx);
            w._rulerRowAnchor = rowIdx;
        } else {
            rows = new Set([rowIdx]);
            w._rulerRowAnchor = rowIdx;
        }

        w._rulerRowSet = rows;
        w._rulerColSet = null;
        w._rulerColAnchor = null;
        _applyRulerSelection(table, _cellsForRows(mapper, rows), 'row');
    }

    function _handleRulerColClick($wrap, table, colIdx, e) {
        const mapper = new window.VisualGridMapper(table);
        const w      = table;
        let cols;

        if (_isExtending(e) && w._rulerColAnchor != null) {
            const from = w._rulerColAnchor;
            const min  = Math.min(from, colIdx);
            const max  = Math.max(from, colIdx);
            cols = _isAdditive(e) ? new Set(w._rulerColSet || []) : new Set();
            for (let c = min; c <= max; c++) cols.add(c);
        } else if (_isAdditive(e)) {
            cols = new Set(w._rulerColSet || []);
            if (cols.has(colIdx) && cols.size > 1) cols.delete(colIdx);
            else                                   cols.add(colIdx);
            w._rulerColAnchor = colIdx;
        } else {
            cols = new Set([colIdx]);
            w._rulerColAnchor = colIdx;
        }

        w._rulerColSet = cols;
        w._rulerRowSet = null;
        w._rulerRowAnchor = null;
        _applyRulerSelection(table, _cellsForCols(mapper, cols), 'column');
    }

    // ── Drag across segments to select a band ────────────────────────────────
    // Mirrors drag-select on cells: press arms, movement extends, release ends.
    // The band is always computed from the ORIGIN index to the segment under the
    // pointer, so the gesture is reversible and never leaves stranded rows
    // behind when you drag back past where you started.
    //
    // An additive press (ctrl/cmd) sweeps a SECOND band without dropping the
    // first, which is the only way to build "rows 2-4 plus 8-9" by dragging.
    function _beginRulerSweep($wrap, table, axis, originIdx, e) {
        const isRow    = axis === 'row';
        const selector = isRow ? '.table-ide-row-ruler .ruler-seg'
                               : '.table-ide-col-ruler .ruler-seg';
        const attr     = isRow ? 'data-row' : 'data-col';
        const $segs    = $wrap.find(selector);
        if ($segs.length < 2) return;

        // Held set at press time: an additive sweep unions onto it, a plain
        // sweep replaces it.
        const additive = !!(e && (e.metaKey || e.ctrlKey));
        const base     = additive
            ? new Set(isRow ? (table._rulerRowSet || []) : (table._rulerColSet || []))
            : new Set();

        // Cache segment extents once — reading a rect per mousemove per segment
        // is the kind of layout thrash that makes a sweep feel heavy.
        const bounds = [];
        $segs.each(function () {
            const idx = parseInt($(this).attr(attr), 10);
            if (isNaN(idx)) return;
            const r = this.getBoundingClientRect();
            // A zero-extent segment is a hidden row/column (filtered out,
            // collapsed, sp-hidden). It must not swallow the pointer.
            if ((isRow ? r.height : r.width) === 0) return;
            bounds.push({ idx, start: isRow ? r.top : r.left, end: isRow ? r.bottom : r.right });
        });
        if (!bounds.length) return;

        let lastIdx = originIdx;
        let swept   = false;

        function idxAt(pos) {
            for (const b of bounds) {
                if (pos >= b.start && pos <= b.end) return b.idx;
            }
            // Past either end: clamp to the nearest segment so dragging off the
            // strip keeps extending to the edge rather than freezing.
            let best = null, bestD = Infinity;
            for (const b of bounds) {
                const d = pos < b.start ? b.start - pos : pos - b.end;
                if (d < bestD) { bestD = d; best = b.idx; }
            }
            return best;
        }

        function onMove(mv) {
            const idx = idxAt(isRow ? mv.clientY : mv.clientX);
            if (idx == null || idx === lastIdx) return;
            lastIdx = idx;
            swept   = true;

            // Fill the band from the VISIBLE segments only. Filling the raw
            // integer range would re-select rows/columns that a filter or a
            // collapsed group deliberately hid, so a sweep across a filtered
            // grid would silently act on data the user cannot even see.
            const set = new Set(base);
            const min = Math.min(originIdx, idx);
            const max = Math.max(originIdx, idx);
            bounds.forEach(b => { if (b.idx >= min && b.idx <= max) set.add(b.idx); });

            const mapper = new window.VisualGridMapper(table);
            if (isRow) {
                table._rulerRowSet = set;
                table._rulerColSet = null;
                _applyRulerSelection(table, _cellsForRows(mapper, set), 'row');
            } else {
                table._rulerColSet = set;
                table._rulerRowSet = null;
                _applyRulerSelection(table, _cellsForCols(mapper, set), 'column');
            }
        }

        function onUp() {
            $(document).off('.rulersweep');
            $('body').removeClass('gx-ruler-sweeping');
            // The anchor stays at the origin so a following shift-click extends
            // from where the sweep began, not from wherever it happened to end.
            if (swept) {
                if (isRow) table._rulerRowAnchor = originIdx;
                else       table._rulerColAnchor = originIdx;
            }
        }

        // Suppress text selection for the duration of the sweep.
        $('body').addClass('gx-ruler-sweeping');
        $(document).on('mousemove.rulersweep', onMove)
                   .on('mouseup.rulersweep', onUp);
    }

    // A right-click / caret press must not collapse a multi-selection that
    // already contains the pressed index — that is the whole point of having
    // built one. Only a press OUTSIDE the held set re-selects.
    function _preserveOrSelectRow($wrap, table, rowIdx) {
        const held = table._rulerRowSet;
        if (held && held.has(rowIdx) && held.size > 1) return;
        _handleRulerRowClick($wrap, table, rowIdx, {});
    }

    function _preserveOrSelectCol($wrap, table, colIdx) {
        const held = table._rulerColSet;
        if (held && held.has(colIdx) && held.size > 1) return;
        _handleRulerColClick($wrap, table, colIdx, {});
    }

    // ── Move row by visual index (insertBefore = target position 0..N) ────────
    function _moveRowByIndex(table, fromIdx, insertBefore) {
        if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return;
        const $rows = $(table).find('tr').not('.table-ide-drag-row').not('.drop-indicator-row');
        const $from = $rows.eq(fromIdx);
        if (!$from.length) return;
        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
        if (table._tableIdeStructObs) table._tableIdeStructObs.disconnect();
        if (insertBefore <= 0) {
            $rows.first().before($from);
        } else if (insertBefore >= $rows.length) {
            $rows.last().after($from);
        } else {
            $rows.eq(insertBefore).before($from);
        }
        requestAnimationFrame(() => renderTableRulers(table));
    }

    // ── Move col by mapper index — no row-handle offset (ruler context) ───────
    function _moveColByIndex(table, fromIdx, insertBefore) {
        if (fromIdx === insertBefore || fromIdx + 1 === insertBefore) return;
        const mapper  = new window.VisualGridMapper(table);
        const moved   = new Set();
        const toIdx   = insertBefore > fromIdx ? insertBefore - 1 : insertBefore;
        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
        if (table._tableIdeStructObs) table._tableIdeStructObs.disconnect();

        for (let r = 0; r < mapper.maxRows; r++) {
            const row = mapper.grid[r];
            if (!row) continue;
            const src = row[fromIdx];
            if (!src || !src.isOrigin || moved.has(src.element)) continue;
            moved.add(src.element);
            const $el = $(src.element);
            if ($el.hasClass('drag-handle')) continue;
            const dst = row[toIdx];
            if (dst && dst.isOrigin && dst.element !== src.element) {
                // Insert before (toIdx < fromIdx) or after (toIdx > fromIdx) the destination
                if (insertBefore > fromIdx) {
                    $(dst.element).after($el);
                } else {
                    $(dst.element).before($el);
                }
            } else if (!dst) {
                $el.closest('tr').append($el);
            } else {
                // Target is inside a colspan span — find next origin to the right
                let found = null;
                for (let c = toIdx + 1; c < mapper.maxCols; c++) {
                    if (row[c] && row[c].isOrigin && row[c].element !== src.element) {
                        found = row[c].element;
                        break;
                    }
                }
                if (found) $(found).before($el);
                else $el.closest('tr').append($el);
            }
        }

        requestAnimationFrame(() => renderTableRulers(table));
    }

    // ── Row ruler drag ────────────────────────────────────────────────────────
    function _startRulerRowDrag($wrap, table, rowIdx, e) {
        e.preventDefault();
        e.stopPropagation();
        const $segs = $wrap.find('.table-ide-row-ruler .ruler-seg');
        const n     = $segs.length;
        let insertBefore = rowIdx;

        $segs.eq(rowIdx).addClass('ruler-drag-src');

        function onMove(mv) {
            let ib = 0;
            $segs.each(function (i) {
                const rect = this.getBoundingClientRect();
                if (rect.height === 0) return; // hidden segment (sp-hidden / collapsed row)
                if (mv.clientY > rect.top + rect.height / 2) ib = i + 1;
            });
            if (ib > n) ib = n;
            insertBefore = ib;
            $segs.removeClass('ruler-drop-before ruler-drop-after');
            if (ib !== rowIdx && ib !== rowIdx + 1) {
                if (ib < n) $segs.eq(ib).addClass('ruler-drop-before');
                else        $segs.eq(n - 1).addClass('ruler-drop-after');
            }
        }

        $(document).on('mousemove.rulerdrag', onMove);
        $(document).one('mouseup.rulerdrag', function () {
            $(document).off('mousemove.rulerdrag');
            $segs.removeClass('ruler-drag-src ruler-drop-before ruler-drop-after');
            _moveRowByIndex(table, rowIdx, insertBefore);
        });
    }

    // ── Col ruler drag ────────────────────────────────────────────────────────
    function _startRulerColDrag($wrap, table, colIdx, e) {
        e.preventDefault();
        e.stopPropagation();
        const $segs  = $wrap.find('.table-ide-col-ruler .ruler-seg');
        const n      = $segs.length;
        let insertBefore = colIdx;

        $segs.eq(colIdx).addClass('ruler-drag-src');
        const mapper = new window.VisualGridMapper(table);
        $(mapper.getCellsInColumn(colIdx)).not('.drag-handle').addClass('column-dragging');

        function onMove(mv) {
            let ib = 0;
            $segs.each(function (i) {
                const rect = this.getBoundingClientRect();
                if (rect.width === 0) return; // hidden segment (sp-hidden column)
                if (mv.clientX > rect.left + rect.width / 2) ib = i + 1;
            });
            if (ib > n) ib = n;
            insertBefore = ib;
            $segs.removeClass('ruler-drop-before ruler-drop-after');
            if (ib !== colIdx && ib !== colIdx + 1) {
                if (ib < n) $segs.eq(ib).addClass('ruler-drop-before');
                else        $segs.eq(n - 1).addClass('ruler-drop-after');
            }
        }

        $(document).on('mousemove.rulerdrag', onMove);
        $(document).one('mouseup.rulerdrag', function () {
            $(document).off('mousemove.rulerdrag');
            $segs.removeClass('ruler-drag-src ruler-drop-before ruler-drop-after');
            $(mapper.getCellsInColumn(colIdx)).removeClass('column-dragging');
            _moveColByIndex(table, colIdx, insertBefore);
        });
    }

    // ── Select every cell in the table (the corner gesture) ──────────────────
    function _selectWholeTable(table) {
        const m = new window.VisualGridMapper(table);
        const cells = [];
        for (let r = 0; r < m.maxRows; r++) {
            for (let c = 0; c < m.maxCols; c++) {
                const gc = m.grid[r] && m.grid[r][c];
                if (!gc || !gc.isOrigin) continue;
                if ($(gc.element).hasClass('drag-handle')) continue;
                if (typeof window.isCellVisible === 'function' && !window.isCellVisible(gc.element)) continue;
                if (cells.indexOf(gc.element) === -1) cells.push(gc.element);
            }
        }
        _applyRulerSelection(table, cells, 'cell');
    }

    // ── Header caret menu (Numbers-style row/column actions) ──────────────────
    //
    // Replaces the two hidden affordances this used to rely on: a `+` pill whose
    // meaning changed depending on a global insert/duplicate mode nobody could
    // see, and a right-click that only worked if you knew to try it. A caret
    // appears on segment hover, and every action the pill and the mode toggle
    // used to encode is now a named item in one list.
    //
    // The ops live in tableOperations.js, which loads AFTER this file — so they
    // are resolved at click time, never at wire time.
    const ROW_MENU = [
        { label: 'Insert Row Above',  fn: 'addRowBefore' },
        { label: 'Insert Row Below',  fn: 'addRow' },
        { label: 'Duplicate Row',     fn: '_dupRow' },
        { sep: true },
        { label: 'Cut',               fn: '_cut' },
        { label: 'Copy',              fn: '_copy' },
        { label: 'Paste',             fn: '_paste' },
        { sep: true },
        { label: 'Delete Row',        fn: 'deleteRows', danger: true }
    ];
    const COL_MENU = [
        { label: 'Insert Column Before', fn: 'addColumnBefore' },
        { label: 'Insert Column After',  fn: 'addColumn' },
        { label: 'Duplicate Column',     fn: '_dupCol' },
        { sep: true },
        { label: 'Cut',                  fn: '_cut' },
        { label: 'Copy',                 fn: '_copy' },
        { label: 'Paste',                fn: '_paste' },
        { sep: true },
        { label: 'Fit Width to Content', fn: '_fitWidth' },
        { sep: true },
        { label: 'Delete Column',        fn: 'deleteColumns', danger: true }
    ];

    function _closeHeaderMenu() {
        $('#tableIdeHeaderMenu').remove();
        $('.ruler-menu-caret.is-open').removeClass('is-open');
        $(document).off('.tafnehdrmenu');
    }

    // Duplicate the selected row(s) / column(s) directly from the live selection,
    // so it does not depend on the #elementType dropdown the old mode toggle used.
    function _dupRow(table) {
        const rows = new Set();
        (window.selectedCells || []).forEach(c => rows.add($(c).parent()[0]));
        if (!rows.size) return;
        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
        if (table._tableIdeStructObs) table._tableIdeStructObs.disconnect();
        rows.forEach(r => $(r).after($(r).clone(false)));
        renderTableRulers(table);
        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
    }

    function _dupCol(table) {
        const m = new window.VisualGridMapper(table);
        const cols = new Set();
        (window.selectedCells || []).forEach(c => {
            const p = m.getVisualPosition(c);
            if (p) cols.add(p.startCol);
        });
        if (!cols.size) return;
        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
        if (table._tableIdeStructObs) table._tableIdeStructObs.disconnect();
        // Descending, so inserting into one column never shifts a column still queued.
        Array.from(cols).sort((a, b) => b - a).forEach(ci => {
            for (let r = 0; r < m.maxRows; r++) {
                const gc = m.grid[r] && m.grid[r][ci];
                if (gc && gc.isOrigin) $(gc.element).after($(gc.element).clone(false));
            }
        });
        renderTableRulers(table);
        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
    }

    function _fitWidth(table, axis, idx) {
        if (axis !== 'col') return;
        _setColWidth(table, idx, _autoFitWidth(table, idx));
        _syncRulerSegments($(table).closest('.table-ide-ruler-wrap')[0], table);
    }

    // Clipboard items reuse the existing matrix clipboard in tableOperations.js.
    function _copy() { if (typeof window.copySelected === 'function') window.copySelected(); }
    function _cut(table) {
        if (typeof window.copySelected === 'function') window.copySelected();
        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
        (window.selectedCells || []).forEach(c => $(c).empty());
        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
    }
    // pasteAfter already routes a v2 matrix to the active cell, which is the
    // spreadsheet behaviour; the legacy branch is its row/col fallback.
    function _paste() {
        if (typeof window.pasteAfter === 'function') window.pasteAfter();
    }

    const _LOCAL_OPS = { _dupRow, _dupCol, _fitWidth, _copy, _cut, _paste };

    // Open the caret menu for one row/column. Selecting the segment first is what
    // makes the shared ops (which all read window.selectedCells) act on it.
    // Two entry points, one menu. The caret opens it anchored beneath itself;
    // a right-click anywhere on the segment opens it at the pointer. Both go
    // through _buildHeaderMenu so the items, the ops and the close/Escape
    // wiring are defined exactly once.
    function _openHeaderMenu($wrap, table, axis, idx, anchorEl) {
        const $menu = _buildHeaderMenu($wrap, table, axis, idx);
        $(anchorEl).addClass('is-open');
        const r = anchorEl.getBoundingClientRect();
        _placeHeaderMenu($menu, r.left, r.bottom + 2, r.top - 2);
        _armHeaderMenuDismiss();
    }

    // Right-click entry: the menu opens where the pointer is.
    function _openHeaderMenuAt($wrap, table, axis, idx, x, y) {
        const $menu = _buildHeaderMenu($wrap, table, axis, idx);
        _placeHeaderMenu($menu, x, y, y);
        _armHeaderMenuDismiss();
    }

    // Keep the menu inside the viewport; flip above the origin if it would
    // overflow the bottom. flipTop is the y to sit ABOVE when flipping.
    function _placeHeaderMenu($menu, x, yBelow, flipTop) {
        const mw = $menu.outerWidth();
        const mh = $menu.outerHeight();
        let left = x;
        let top  = yBelow;
        if (left + mw + 8 > window.innerWidth)  left = Math.max(8, window.innerWidth - mw - 8);
        if (top + mh + 8 > window.innerHeight)  top  = Math.max(8, flipTop - mh);
        $menu.css({ left: left + 'px', top: top + 'px' });
    }

    function _armHeaderMenuDismiss() {
        // Defer so the mousedown/contextmenu that opened the menu does not
        // immediately close it.
        setTimeout(() => {
            $(document).on('mousedown.tafnehdrmenu', function (ev) {
                if (!$(ev.target).closest('#tableIdeHeaderMenu').length) _closeHeaderMenu();
            });
            $(document).on('keydown.tafnehdrmenu', function (ev) {
                if (ev.key === 'Escape') _closeHeaderMenu();
            });
        }, 0);
    }

    function _buildHeaderMenu($wrap, table, axis, idx) {
        _closeHeaderMenu();
        window.currentTable = table;
        if (axis === 'row') _preserveOrSelectRow($wrap, table, idx);
        else                _preserveOrSelectCol($wrap, table, idx);

        const items = axis === 'row' ? ROW_MENU : COL_MENU;
        const $menu = $('<div id="tableIdeHeaderMenu" class="table-ide-hdr-menu"></div>');
        items.forEach(it => {
            if (it.sep) { $menu.append('<div class="table-ide-hdr-menu-sep"></div>'); return; }
            $('<button type="button" class="table-ide-hdr-menu-item"></button>')
                .text(it.label)
                .toggleClass('is-danger', !!it.danger)
                .on('click', function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    _closeHeaderMenu();
                    const local = _LOCAL_OPS[it.fn];
                    if (local) local(table, axis, idx);
                    else if (typeof window[it.fn] === 'function') window[it.fn]();
                    if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
                })
                .appendTo($menu);
        });

        $('body').append($menu);
        return $menu;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GRID CHROME — the Supabase-style toolbar + footer around the viewport
    // ══════════════════════════════════════════════════════════════════════════
    //
    // Search, filter and sort are VIEW state, never document state: they hide
    // and reorder rows in the DOM but write nothing the exporter would pick up,
    // and clearing them restores the document exactly. That is the only way
    // this can sit on top of an arbitrary extracted table — whatever shape the
    // grid is, it is still rows and columns, so a row predicate always applies.
    //
    // Row order is restored from _gxGridOrder, captured once per table before
    // the first sort, so "no sort" is a real state and not an approximation.

    const GRID_HIDDEN_CLASS = 'gx-grid-filtered-out';

    // Body rows only — a <thead> row is a header, not data, and the drag/drop
    // scaffolding rows are not rows at all.
    function _gridBodyRows(table) {
        return Array.from(table.rows).filter(r =>
            !r.classList.contains('table-ide-drag-row') &&
            !r.classList.contains('drop-indicator-row') &&
            !(r.parentNode && r.parentNode.tagName === 'THEAD')
        );
    }

    function _gridState(table) {
        if (!table._gxGridState) {
            table._gxGridState = { q: '', filters: [], sorts: [] };
        }
        return table._gxGridState;
    }

    function _rowText(row) {
        return (row.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    // Build a row -> (colIdx -> text) reader ONCE per view pass.
    //
    // Reading through the mapper is what makes a colspan/rowspan grid resolve to
    // the same column the ruler labels, rather than to row.cells[colIdx] which
    // shifts under every merge. But constructing a mapper is a full grid walk,
    // so doing it per cell made a search keystroke O(rows x filters) walks; on
    // an extracted table of any size that is visibly slow. One mapper per pass.
    function _gridReader(table) {
        const m    = new window.VisualGridMapper(table);
        const body = _gridBodyRows(table);
        // Body rows start after the header rows the mapper also counts.
        const offset = m.maxRows - body.length;
        const rowOf  = new Map();
        body.forEach((r, i) => rowOf.set(r, i + offset));
        return function (row, colIdx) {
            const gr = rowOf.get(row);
            if (gr == null) return '';
            const gc = m.grid[gr] && m.grid[gr][colIdx];
            return gc && gc.element ? (gc.element.textContent || '').trim() : '';
        };
    }

    const _FILTER_OPS = {
        contains:  (v, t) => v.toLowerCase().includes(t.toLowerCase()),
        equals:    (v, t) => v.trim().toLowerCase() === t.trim().toLowerCase(),
        'not empty': v => v.trim() !== '',
        empty:     v => v.trim() === '',
        '>':       (v, t) => parseFloat(v) >  parseFloat(t),
        '<':       (v, t) => parseFloat(v) <  parseFloat(t)
    };

    // Apply search + filters (visibility) and sorts (order) to the live DOM.
    function _applyGridView(table) {
        const st   = _gridState(table);
        const rows = _gridBodyRows(table);
        const read = _gridReader(table);

        // ── Visibility ──
        let hidden = 0;
        rows.forEach(r => {
            let show = true;
            if (st.q && !_rowText(r).includes(st.q)) show = false;
            if (show) {
                for (const f of st.filters) {
                    const fn = _FILTER_OPS[f.op];
                    if (!fn) continue;
                    if (!fn(read(r, f.col), f.value)) { show = false; break; }
                }
            }
            r.classList.toggle(GRID_HIDDEN_CLASS, !show);
            if (!show) hidden++;
        });

        // ── Order ──
        if (st.sorts.length) {
            if (!table._gxGridOrder) table._gxGridOrder = rows.slice();
            const parent = rows[0] && rows[0].parentNode;
            if (parent) {
                const sorted = rows.slice().sort((a, b) => {
                    for (const srt of st.sorts) {
                        const av = read(a, srt.col);
                        const bv = read(b, srt.col);
                        const an = parseFloat(av), bn = parseFloat(bv);
                        let cmp;
                        // Numeric when BOTH sides are numeric, else locale text.
                        // Mixed columns are the norm in extracted tables, so a
                        // blind numeric compare would scatter the text rows.
                        if (!isNaN(an) && !isNaN(bn) && av.trim() !== '' && bv.trim() !== '') {
                            cmp = an - bn;
                        } else {
                            cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
                        }
                        if (cmp) return srt.dir === 'desc' ? -cmp : cmp;
                    }
                    return 0;
                });
                sorted.forEach(r => parent.appendChild(r));
            }
        } else if (table._gxGridOrder) {
            const parent = table._gxGridOrder[0] && table._gxGridOrder[0].parentNode;
            if (parent) table._gxGridOrder.forEach(r => { if (r.parentNode === parent) parent.appendChild(r); });
        }

        _syncGridChrome(table, hidden);
        scheduleGeometrySync(table);
    }

    // Footer counters + the filter/sort badge counts.
    function _syncGridChrome(table, hiddenCount) {
        const $wrap = $(table).closest('.table-ide-ruler-wrap');
        if (!$wrap.length) return;
        const st    = _gridState(table);
        const rows  = _gridBodyRows(table);
        const total = rows.length;
        if (hiddenCount == null) hiddenCount = rows.filter(r => r.classList.contains(GRID_HIDDEN_CLASS)).length;
        const shown = total - hiddenCount;
        const m     = new window.VisualGridMapper(table);

        const label = (n, one, many) => n + ' ' + (n === 1 ? one : many);
        $wrap.find('[data-gx-stat="rows"]').text(
            hiddenCount ? `${shown} of ${label(total, 'row', 'rows')}` : label(total, 'row', 'rows')
        );
        $wrap.find('[data-gx-stat="cols"]').text(label(m.maxCols, 'column', 'columns'));

        const selN = (window.selectedCells || []).filter(c => $.contains(table, c)).length;
        $wrap.find('[data-gx-stat="sel"]')
             .text(label(selN, 'cell selected', 'cells selected'))
             .prop('hidden', selN < 2);
        $wrap.find('[data-gx-stat="hidden"]')
             .text(`${hiddenCount} hidden by view`)
             .prop('hidden', hiddenCount === 0);

        const badge = (sel, n) => $wrap.find(`[data-gx-grid="${sel}"] .table-ide-grid-count`)
                                       .text(n).prop('hidden', n === 0);
        badge('filter', st.filters.length);
        badge('sort',   st.sorts.length);
        $wrap.find('[data-gx-grid="filter"]').toggleClass('is-active', st.filters.length > 0);
        $wrap.find('[data-gx-grid="sort"]').toggleClass('is-active',   st.sorts.length > 0);
    }

    function _closeGridPopover() {
        $('#tableIdeGridPopover').remove();
        $('[data-gx-grid]').attr('aria-expanded', 'false').removeClass('is-open');
        $(document).off('.gxgridpop');
    }

    // One popover shape for both filter and sort: a list of active clauses, each
    // removable, plus an "add" row. Supabase's pattern, and it keeps multi-column
    // sort/filter expressible without a dialog.
    function _openGridPopover(table, kind, anchorEl) {
        const wasOpen = $(anchorEl).hasClass('is-open');
        _closeGridPopover();
        if (wasOpen) return;

        const st = _gridState(table);
        const m  = new window.VisualGridMapper(table);
        const $pop = $('<div id="tableIdeGridPopover" class="table-ide-grid-pop"></div>');
        const list = kind === 'filter' ? st.filters : st.sorts;

        const colOptions = () => Array.from({ length: m.maxCols }, (_, i) =>
            `<option value="${i}">${colLabel(i)}</option>`).join('');

        function redraw() {
            $pop.empty();
            $pop.append(`<div class="table-ide-grid-pop-head">${kind === 'filter' ? 'Filters' : 'Sort'}</div>`);

            if (!list.length) {
                $pop.append(`<div class="table-ide-grid-pop-empty">No ${kind === 'filter' ? 'filters' : 'sorts'} applied to this table</div>`);
            }

            list.forEach((clause, i) => {
                const $row = $('<div class="table-ide-grid-pop-row"></div>');
                const $col = $(`<select class="table-ide-grid-pop-sel">${colOptions()}</select>`).val(String(clause.col));
                $col.on('change', function () { clause.col = parseInt(this.value, 10); _applyGridView(table); });
                $row.append($col);

                if (kind === 'filter') {
                    const $op = $('<select class="table-ide-grid-pop-sel"></select>');
                    Object.keys(_FILTER_OPS).forEach(o => $op.append(`<option value="${o}">${o}</option>`));
                    $op.val(clause.op).on('change', function () {
                        clause.op = this.value;
                        redraw();
                        _applyGridView(table);
                    });
                    $row.append($op);
                    // "empty"/"not empty" take no operand, so no dead input is shown.
                    if (clause.op !== 'empty' && clause.op !== 'not empty') {
                        const $val = $('<input type="text" class="table-ide-grid-pop-val" placeholder="value">').val(clause.value || '');
                        $val.on('input', function () { clause.value = this.value; _applyGridView(table); });
                        $row.append($val);
                    }
                } else {
                    const $dir = $('<select class="table-ide-grid-pop-sel"><option value="asc">ascending</option><option value="desc">descending</option></select>');
                    $dir.val(clause.dir).on('change', function () { clause.dir = this.value; _applyGridView(table); });
                    $row.append($dir);
                }

                $('<button type="button" class="table-ide-grid-pop-del" title="Remove">\u00d7</button>')
                    .on('click', function () { list.splice(i, 1); redraw(); _applyGridView(table); })
                    .appendTo($row);
                $pop.append($row);
            });

            $('<button type="button" class="table-ide-grid-pop-add"></button>')
                .text(kind === 'filter' ? '+ Add filter' : '+ Add sort')
                .on('click', function () {
                    list.push(kind === 'filter'
                        ? { col: 0, op: 'contains', value: '' }
                        : { col: 0, dir: 'asc' });
                    redraw();
                    _applyGridView(table);
                })
                .appendTo($pop);

            if (list.length) {
                $('<button type="button" class="table-ide-grid-pop-clear"></button>')
                    .text('Clear all')
                    .on('click', function () { list.length = 0; redraw(); _applyGridView(table); })
                    .appendTo($pop);
            }
        }

        redraw();
        $('body').append($pop);
        $(anchorEl).addClass('is-open').attr('aria-expanded', 'true');

        const r  = anchorEl.getBoundingClientRect();
        const pw = $pop.outerWidth(), ph = $pop.outerHeight();
        let left = r.left, top = r.bottom + 4;
        if (left + pw + 8 > window.innerWidth)  left = Math.max(8, window.innerWidth - pw - 8);
        if (top  + ph + 8 > window.innerHeight) top  = Math.max(8, r.top - ph - 4);
        $pop.css({ left: left + 'px', top: top + 'px' });

        setTimeout(() => {
            $(document).on('mousedown.gxgridpop', function (ev) {
                if (!$(ev.target).closest('#tableIdeGridPopover, [data-gx-grid]').length) _closeGridPopover();
            });
            $(document).on('keydown.gxgridpop', function (ev) {
                if (ev.key === 'Escape') _closeGridPopover();
            });
        }, 0);
    }

    function _wireGridChrome($wrap, table) {
        $wrap.find('.table-ide-grid-search-input').on('input.gxgrid', function () {
            _gridState(table).q = this.value.trim().toLowerCase();
            _applyGridView(table);
        });

        $wrap.find('[data-gx-grid]').on('click.gxgrid', function (e) {
            e.preventDefault();
            e.stopPropagation();
            window.currentTable = table;
            _openGridPopover(table, $(this).attr('data-gx-grid'), this);
        });

        // Restore the toolbar from state that survived a ruler rebuild — the
        // wrap is thrown away and rebuilt on every structural change, so the
        // inputs have to be re-seeded or the view would silently disagree with
        // the rows it is still filtering.
        const st = _gridState(table);
        if (st.q) $wrap.find('.table-ide-grid-search-input').val(st.q);
        _applyGridView(table);
    }

    // ── Build and inject ruler strips around a table ──────────────────────────
    function renderTableRulers(table) {
        const $table = $(table);
        if (!$table.length) return;

        // Skip hidden tables (inside collapsed accordion) — will be rebuilt on open
        if ($table[0].getBoundingClientRect().width === 0) return;

        // Guard against re-entrant calls from ResizeObserver
        if (table._tableIdeRulerRebuilding) return;

        // Remove any existing ruler wrap for this table
        const $existing = $table.closest('.table-ide-ruler-wrap');
        if ($existing.length) {
            $existing.before($table);
            $existing.remove();
        }

        // Disconnect previous MutationObserver (row/col add/delete watcher)
        if (table._tableIdeStructObs) {
            table._tableIdeStructObs.disconnect();
            delete table._tableIdeStructObs;
        }

        const mapper = new VisualGridMapper(table);
        if (mapper.maxCols === 0 || mapper.maxRows === 0) return;

        const nCols = mapper.maxCols;
        const rows  = Array.from(table.rows).filter(r => !r.classList.contains('table-ide-drag-row') && !r.classList.contains('drop-indicator-row'));
        const nRows = rows.length;

        // Build segments without fixed sizes — _syncRulerSegments sets them after DOM insertion
        // Each segment carries a grip on its trailing border: drag to size the
        // column/row, double-click a column grip to fit it to its content.
        const colSegs = Array.from({ length: nCols }, (_, i) =>
            `<div class="ruler-seg" data-col="${i}" title="Column ${colLabel(i)}">${colLabel(i)}<span class="ruler-menu-caret" data-col="${i}" title="Click to insert a column · right-click for column actions">+</span><span class="ruler-grip ruler-grip-col" title="Drag to resize · double-click to fit"></span></div>`
        ).join('');

        // A row inside <thead> is frozen by the stylesheet, so its segment is
        // frozen too — see .ruler-seg-frozen.
        const rowSegs = Array.from({ length: nRows }, (_, i) => {
            const frozen = rows[i] && rows[i].parentNode && rows[i].parentNode.tagName === 'THEAD' ? ' ruler-seg-frozen' : '';
            return `<div class="ruler-seg${frozen}" data-row="${i}" title="Row ${i + 1}">${i + 1}<span class="ruler-menu-caret" data-row="${i}" title="Click to insert a row · right-click for row actions">+</span><span class="ruler-grip ruler-grip-row" title="Drag to resize"></span></div>`;
        }).join('');

        // Assemble wrapper:
        //   header  = [corner | col-ruler-viewport (overflow:hidden, sync'd by JS)]
        //   body    = [row-ruler (always visible) | table-viewport (overflow-x:auto)]
        const $wrap = $(`
            <div class="table-ide-ruler-wrap">
                <div class="table-ide-grid-toolbar">
                    <div class="table-ide-grid-tb-group">
                        <span class="table-ide-grid-search">
                            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 14 14"/></svg>
                            <input type="search" class="table-ide-grid-search-input" placeholder="Search rows" aria-label="Search rows">
                        </span>
                    </div>
                    <div class="table-ide-grid-tb-group">
                        <button type="button" class="table-ide-grid-btn" data-gx-grid="filter" aria-expanded="false">
                            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M4.5 8h7M6.5 12h3"/></svg>
                            <span>Filter</span><span class="table-ide-grid-count" hidden></span>
                        </button>
                        <button type="button" class="table-ide-grid-btn" data-gx-grid="sort" aria-expanded="false">
                            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3v10M4.5 13l-2-2M4.5 13l2-2M11.5 13V3M11.5 3l-2 2M11.5 3l2 2"/></svg>
                            <span>Sort</span><span class="table-ide-grid-count" hidden></span>
                        </button>
                    </div>
                </div>
                <div class="table-ide-ruler-header">
                    <div class="table-ide-corner" title="Click to select the whole table · drag to move it · double-click to reset column widths"></div>
                    <div class="table-ide-col-ruler-vp">
                        <div class="table-ide-col-ruler">${colSegs}</div>
                    </div>
                </div>
                <div class="table-ide-ruler-body">
                    <div class="table-ide-row-ruler-vp">
                        <div class="table-ide-row-ruler">${rowSegs}</div>
                    </div>
                    <div class="table-ide-table-vp"></div>
                </div>
                <div class="table-ide-grid-footer">
                    <span class="table-ide-grid-stat" data-gx-stat="rows"></span>
                    <span class="table-ide-grid-stat-sep">·</span>
                    <span class="table-ide-grid-stat" data-gx-stat="cols"></span>
                    <span class="table-ide-grid-stat" data-gx-stat="sel" hidden></span>
                    <span class="table-ide-grid-footer-spacer"></span>
                    <span class="table-ide-grid-stat" data-gx-stat="hidden" hidden></span>
                </div>
            </div>
        `);

        // Move table into the table viewport
        $table.before($wrap);
        $wrap.find('.table-ide-table-vp').append($table);

        // Sync segment sizes after the browser has laid out the new DOM
        scheduleGeometrySync(table);

        _wireResize($wrap, table);
        _wireGridChrome($wrap, table);

        // Sync scroll: table-vp → col-ruler-vp (x) and row-ruler-vp (y).
        // Both strips live outside the table's own scroll container so they can
        // stay put while it scrolls sideways/down; the price is that the offset
        // has to be copied across by hand, on both axes.
        const tableVp    = $wrap.find('.table-ide-table-vp')[0];
        const colRulerVp = $wrap.find('.table-ide-col-ruler-vp')[0];
        const rowRulerVp = $wrap.find('.table-ide-row-ruler-vp')[0];
        tableVp.addEventListener('scroll', function () {
            colRulerVp.scrollLeft = this.scrollLeft;
            rowRulerVp.scrollTop  = this.scrollTop;
        }, { passive: true });

        // ── Corner: click selects the whole table; drag moves the block ──────
        // It used to toggle a hidden insert/duplicate mode that silently changed
        // what every + pill did. Selecting the table is what the same corner does
        // in a spreadsheet, and duplicate is now a named item in the caret menu.
        const $corner = $wrap.find('.table-ide-corner');
        $corner.on('mousedown.ruler', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            window.currentTable = table;
            _selectWholeTable(table);
            if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
            // A press that turns into a drag hands off to the block-move gesture
            // already implemented in cellHandles.js.
            const sx = e.clientX, sy = e.clientY;
            function onMove(mv) {
                if (Math.abs(mv.clientX - sx) <= DRAG_THRESHOLD_PX &&
                    Math.abs(mv.clientY - sy) <= DRAG_THRESHOLD_PX) return;
                $(document).off('.rulercorner');
                if (typeof window.beginSelectionMove === 'function') window.beginSelectionMove(mv);
            }
            $(document).on('mousemove.rulercorner', onMove)
                       .one('mouseup.rulercorner', () => $(document).off('.rulercorner'));
        });

        // ── Caret: open the row/column action menu ───────────────────────────
        $wrap.on('mousedown.ruler', '.ruler-menu-caret', function (e) {
            e.preventDefault();
            e.stopPropagation();
        });
        // Left-click INSERTS (the + is a +, and it does the common thing with
        // no menu in the way); right-click opens the full row/column menu.
        // It used to open the menu on left-click, which made the one-gesture
        // insert a three-gesture one for the operation people repeat most.
        $wrap.on('click.ruler', '.ruler-menu-caret', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const rowAttr = $(this).attr('data-row');
            const axis = rowAttr != null ? 'row' : 'col';
            const idx = parseInt(axis === 'row' ? rowAttr : $(this).attr('data-col'), 10);
            window.currentTable = table;
            // Select the target first: addRow/addColumn read window.selectedCells.
            // A held multi-selection containing idx survives, so + on one of
            // three selected rows inserts three rows.
            if (axis === 'row') _preserveOrSelectRow($wrap, table, idx);
            else                _preserveOrSelectCol($wrap, table, idx);
            _closeHeaderMenu();
            const fn = axis === 'row' ? window.addRow : window.addColumn;
            if (typeof fn === 'function') fn();
            if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
        });

        $wrap.on('contextmenu.ruler', '.ruler-menu-caret', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const rowAttr = $(this).attr('data-row');
            const axis = rowAttr != null ? 'row' : 'col';
            const idx = parseInt(axis === 'row' ? rowAttr : $(this).attr('data-col'), 10);
            _openHeaderMenu($wrap, table, axis, idx, this);
        });

        // ── Row ruler: right-click → the ROW action menu ─────────────────────
        // Anywhere on the segment, not just on the little + — the whole segment
        // IS the row handle, so that is the target the pointer expects.
        //
        // This used to open the generic #cellContextMenu, which meant a
        // right-click on a row number offered cell actions and the row actions
        // were reachable only by hitting the 14px caret. The row/column menu is
        // the point of right-clicking a ruler.
        //
        // cellBeingEdited is still pointed at the row's first cell because the
        // shared clipboard ops in the menu read it.
        $wrap.find('.table-ide-row-ruler').on('contextmenu.ruler', '.ruler-seg', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const rowIdx = parseInt($(this).attr('data-row'), 10);
            _preserveOrSelectRow($wrap, table, rowIdx);
            window.cellBeingEdited = table.rows[rowIdx] ? table.rows[rowIdx].cells[0] : null;
            _openHeaderMenuAt($wrap, table, 'row', rowIdx, e.clientX, e.clientY);
        });

        // ── Col ruler: right-click → the COLUMN action menu ──────────────────
        // See the row handler above for why this is not the cell menu.
        $wrap.find('.table-ide-col-ruler-vp').on('contextmenu.ruler', '.ruler-seg', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const colIdx = parseInt($(this).attr('data-col'), 10);
            _preserveOrSelectCol($wrap, table, colIdx);
            const m2 = new window.VisualGridMapper(table);
            const firstCell = m2.getCellsInColumn(colIdx)[0] || null;
            window.cellBeingEdited = firstCell;
            _openHeaderMenuAt($wrap, table, 'col', colIdx, e.clientX, e.clientY);
        });

        // Ruler highlight on cell click
        $table.off('click.ruler mousedown.ruler').on('click.ruler mousedown.ruler', 'td, th', function () {
            requestAnimationFrame(() => {
                if (typeof window.highlightRuler === 'function') {
                    window.highlightRuler(table, window.selectedCells);
                }
            });
        });

        // ── Row ruler: mousedown → watch for movement threshold ──────────────────
        // If mouse moves > DRAG_THRESHOLD_PX before mouseup  → reorder drag
        // If mouseup without threshold crossed               → select (shift extends)
        $wrap.find('.table-ide-row-ruler').on('mousedown', '.ruler-seg', function (e) {
            // A press that started on a resize grip is a resize, not a
            // row/column select-or-reorder. Both handlers are delegated from
            // this same container and this one calls stopPropagation, so
            // without this the grip never sees its own mousedown.
            if ($(e.target).hasClass('ruler-grip')) return;

            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const rowIdx  = parseInt($(this).attr('data-row'), 10);

            // A single press selects. It does NOT arm a reorder.
            //
            // Selecting a row and dragging a row are the same opening gesture,
            // so a press that wandered a few pixels past the threshold -- which
            // is most presses -- silently reordered the table instead of
            // selecting it. Reorder is destructive and select is not, so the
            // ambiguity only ever resolved the wrong way.
            //
            // e.detail is the click count the browser already tracks: the
            // second mousedown of a double-click reads 2. Requiring it makes
            // double-click-then-drag the only way into a reorder, matching the
            // selection-move gesture in cellHandles.js.
            if (e.detail < 2) {
                // Select on press, then SWEEP: dragging across segments extends
                // the selection, the same gesture as dragging across cells
                // (see the mousemove.cell handler in core/tableIde.js).
                //
                // This used to return here with no move listener, so a drag
                // across the strip did nothing at all — the press selected one
                // row and the rest of the gesture was dropped on the floor.
                //
                // Extending from the press index rather than from the segment
                // under the cursor is what makes the sweep reversible: drag
                // down then back up and the band shrinks instead of stranding
                // the rows you already passed.
                _handleRulerRowClick($wrap, table, rowIdx, e);
                _beginRulerSweep($wrap, table, 'row', rowIdx, e);
                return;
            }

            const startY  = e.clientY;
            let   dragging = false;

            function onMove(mv) {
                if (!dragging && Math.abs(mv.clientY - startY) > DRAG_THRESHOLD_PX) {
                    dragging = true;
                    $(document).off('mousemove.rulerrowintent mouseup.rulerrowintent');
                    _startRulerRowDrag($wrap, table, rowIdx, mv);
                }
            }
            function onUp() {
                $(document).off('mousemove.rulerrowintent mouseup.rulerrowintent');
            }
            $(document).on('mousemove.rulerrowintent', onMove)
                       .one('mouseup.rulerrowintent', onUp);
        });

        // ── Col ruler: same threshold pattern ────────────────────────────────────
        $wrap.find('.table-ide-col-ruler-vp').on('mousedown', '.ruler-seg', function (e) {
            // A press that started on a resize grip is a resize, not a
            // row/column select-or-reorder. Both handlers are delegated from
            // this same container and this one calls stopPropagation, so
            // without this the grip never sees its own mousedown.
            if ($(e.target).hasClass('ruler-grip')) return;

            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const colIdx  = parseInt($(this).attr('data-col'), 10);

            // Single press selects, never reorders. See the row handler above
            // for why the reorder is gated behind the second press.
            if (e.detail < 2) {
                // Select on press, then sweep. See the row handler above.
                _handleRulerColClick($wrap, table, colIdx, e);
                _beginRulerSweep($wrap, table, 'col', colIdx, e);
                return;
            }

            const startX  = e.clientX;
            let   dragging = false;

            function onMove(mv) {
                if (!dragging && Math.abs(mv.clientX - startX) > DRAG_THRESHOLD_PX) {
                    dragging = true;
                    $(document).off('mousemove.rulercolintent mouseup.rulercolintent');
                    _startRulerColDrag($wrap, table, colIdx, mv);
                }
            }
            function onUp() {
                $(document).off('mousemove.rulercolintent mouseup.rulercolintent');
            }
            $(document).on('mousemove.rulercolintent', onMove)
                       .one('mouseup.rulercolintent', onUp);
        });

        // ── ResizeObserver + window resize: rebuild ruler if table changes size ─
        if (table._tableIdeRulerObs) {
            table._tableIdeRulerObs.disconnect();
        }
        if (table._tableIdeResizeHandler) {
            window.removeEventListener('resize', table._tableIdeResizeHandler);
        }

        function _scheduleRulerRebuild() {
            if (table._tableIdeRulerRebuilding) return;
            clearTimeout(table._tableIdeRulerTimer);
            table._tableIdeRulerTimer = setTimeout(() => {
                const $w = $(table).closest('.table-ide-ruler-wrap');
                if (!$w.length) return;
                const mapper2 = new window.VisualGridMapper(table);
                const liveRows = Array.from(table.rows).filter(r => !r.classList.contains('table-ide-drag-row') && !r.classList.contains('drop-indicator-row')).length;
                const segRows  = $w.find('.table-ide-row-ruler .ruler-seg').length;
                const segCols  = $w.find('.table-ide-col-ruler .ruler-seg').length;
                if (liveRows === segRows && mapper2.maxCols === segCols) {
                    _syncRulerSegments($w[0], table);
                    scheduleGeometrySync(table);
                } else {
                    table._tableIdeRulerRebuilding = true;
                    renderTableRulers(table);
                    table._tableIdeRulerRebuilding = false;
                }
            }, 60);
        }

        if (window.ResizeObserver) {
            const ro = new ResizeObserver(_scheduleRulerRebuild);
            ro.observe(table);
            table._tableIdeRulerObs = ro;
        }

        // Fallback: window resize covers container reflows the ResizeObserver may miss
        table._tableIdeResizeHandler = _scheduleRulerRebuild;
        window.addEventListener('resize', table._tableIdeResizeHandler, { passive: true });

        // ── MutationObserver: immediately rebuild on row/cell add or remove ───
        // ResizeObserver only fires after a layout pass; direct DOM mutations
        // (deleteRows, deleteColumns, undo) can remove rows without a resize if
        // the table width stays the same — leaving ghost segments in the ruler.
        if (window.MutationObserver) {
            const mo = new MutationObserver(mutations => {
                if (table._tableIdeRulerRebuilding) return;
                const structural = mutations.some(m =>
                    m.type === 'childList' &&
                    (m.addedNodes.length > 0 || m.removedNodes.length > 0)
                );
                if (!structural) return;

                // Count mismatch → rebuild ruler immediately (no debounce)
                const $w = $(table).closest('.table-ide-ruler-wrap');
                if (!$w.length) return;
                const liveRows = Array.from(table.rows).filter(r =>
                    !r.classList.contains('table-ide-drag-row') &&
                    !r.classList.contains('drop-indicator-row')
                ).length;
                const mapper3 = new window.VisualGridMapper(table);
                const segRows = $w.find('.table-ide-row-ruler .ruler-seg').length;
                const segCols = $w.find('.table-ide-col-ruler .ruler-seg').length;
                if (liveRows !== segRows || mapper3.maxCols !== segCols) {
                    mo.disconnect();
                    table._tableIdeRulerRebuilding = true;
                    renderTableRulers(table);
                    table._tableIdeRulerRebuilding = false;
                }
            });
            mo.observe(table, { childList: true, subtree: true });
            table._tableIdeStructObs = mo;
        }
    }

    // ── Highlight ruler segments matching the current selection ───────────────
    function highlightRuler(table, cells) {
        const $wrap = $(table).closest('.table-ide-ruler-wrap');
        if (!$wrap.length) return;

        $wrap.find('.ruler-seg.ruler-active').removeClass('ruler-active');
        if (!cells || cells.length === 0) return;

        const mapper     = new VisualGridMapper(table);
        const activeRows = new Set();
        const activeCols = new Set();

        cells.forEach(cell => {
            const pos = mapper.getVisualPosition(cell);
            if (!pos) return;
            for (let r = pos.startRow; r < pos.startRow + pos.rowspan; r++) activeRows.add(r);
            for (let c = pos.startCol; c < pos.startCol + pos.colspan; c++) activeCols.add(c);
        });

        activeRows.forEach(r => $wrap.find(`.ruler-seg[data-row="${r}"]`).addClass('ruler-active'));
        activeCols.forEach(c => $wrap.find(`.ruler-seg[data-col="${c}"]`).addClass('ruler-active'));
    }

    // ── Remove ruler and restore table to its original parent ─────────────────
    function destroyRulers(table) {
        if (table._tableIdeRulerObs) {
            table._tableIdeRulerObs.disconnect();
            delete table._tableIdeRulerObs;
        }
        if (table._tableIdeStructObs) {
            table._tableIdeStructObs.disconnect();
            delete table._tableIdeStructObs;
        }
        if (table._tableIdeResizeHandler) {
            window.removeEventListener('resize', table._tableIdeResizeHandler);
            delete table._tableIdeResizeHandler;
        }
        clearTimeout(table._tableIdeRulerTimer);
        const $table = $(table);
        const $wrap  = $table.closest('.table-ide-ruler-wrap');
        if ($wrap.length) {
            $wrap.before($table);
            $wrap.remove();
        }
    }

    return { renderTableRulers, highlightRuler, destroyRulers, releaseSizing, colLabel, scheduleGeometrySync };
})();

window.renderTableRulers = window.tableRuler.renderTableRulers;
window.scheduleTableGeometrySync = window.tableRuler.scheduleGeometrySync;
window.highlightRuler    = window.tableRuler.highlightRuler;
window.destroyRulers     = window.tableRuler.destroyRulers;
window.releaseTableSizing = window.tableRuler.releaseSizing;
window.tableIdeColLabel      = window.tableRuler.colLabel;
