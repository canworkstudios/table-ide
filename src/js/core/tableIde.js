// js/core/tableIde.js

$(function () {
    // =================== GLOBAL VARIABLES ===================
    window.selectedCells = [];
    window.currentTable = null;
    // Selection lifecycle for keyboard+mouse range selection.
    // - anchor: fixed start of a range (first click/selection)
    // - head: moving end of a range (mouse drag end or arrow-nav target)
    window.selectionAnchorCell = null;
    window.selectionHeadCell = null;
    window.crosshairEnabled = false;
    window.cellBeingEdited = null;
    window.originalContent = null;
    window.dragDropEnabled = false;
    window.popperInstance = null;
    window.hideTimeout = null;
    window.lastParsedHtml = null;
    window.labModeEnabled = false;
    window.nodeEditorEnabled = false;
    // True while a table cell has been most recently clicked/interacted with.
    // Used to gate copy/paste shortcuts without relying on document.activeElement
    // (which stays on Monaco's textarea after clicking a cell).
    window.tableHasFocus = false;
    // =================== CLEANUP FUNCTION ===================
    function cleanupEventHandlers() {
        $(document).off('.cell .cellEditor .hideMenu .accordion .sp_selector');
        $('#tableContainer').off('.cell .drag');
    }

    // Make cleanupEventHandlers globally accessible
    window.cleanupEventHandlers = cleanupEventHandlers;

    // =================== INITIALIZATION ===================
    function initializeAllFeatures() {
        cleanupEventHandlers();
        initAccordions();
        initCrosshair();
        initSpSelectors();
        headerAccordion();

        const $firstPanel = $('.panel').first();
        if ($firstPanel.length) {
            $firstPanel.show();
            $firstPanel.find('.sp-option').first().trigger('click.sp_selector');
        }
    }

    // Make initializeAllFeatures globally accessible
    window.initializeAllFeatures = initializeAllFeatures;

    // =================== TABLE INTERACTION ===================
    function setupTableInteraction() {
        const $container = $('#tableContainer');
        let isSelecting = false;
        let startCell = null;
        let endCell = null;
        let lastSelectedCell = null;

        // Clear previous event handlers on container
        $container.off('mousedown.cell mousemove.cell selectstart.cell contextmenu.cell dblclick.cell');

        // Mouse down - start selection; also update currentTable to the clicked table
        $container.on('mousedown.cell', 'td, th', function (e) {
            e.preventDefault();
            e.stopPropagation();

            // Update active table to whichever table was clicked
            const clickedTable = $(this).closest('table')[0];
            if (clickedTable && clickedTable !== window.currentTable) {
                // Clear selection from previous table
                if (window.currentTable) {
                    $(window.currentTable).find('.selected-cell').removeClass('selected-cell');
                }
                window.currentTable = clickedTable;
                window.selectedCells = [];
                window.selectionAnchorCell = null;
                window.selectionHeadCell = null;
                if (typeof window.syncHistoryButtons === 'function') window.syncHistoryButtons();
            }

            // Mark table as the active interaction context.
            // stopPropagation() on this handler prevents the document-level
            // mousedown (which clears the flag) from firing on the same click.
            window.tableHasFocus = true;

            const $table = $(window.currentTable);

            if (e.button === 0) { // Left mouse button only
                if (e.ctrlKey || e.metaKey) {
                    // Toggle individual cell selection with Ctrl/Cmd
                    $(this).toggleClass('selected-cell');
                    if ($(this).hasClass('selected-cell')) {
                        if (!window.selectedCells.includes(this)) {
                            window.selectedCells.push(this);
                        }
                    } else {
                        window.selectedCells = window.selectedCells.filter(cell => cell !== this);
                    }
                    lastSelectedCell = this;
                    // Keep keyboard "active cell" aligned with latest mouse action.
                    if (window.selectedCells.length === 0) {
                        window.selectionAnchorCell = null;
                        window.selectionHeadCell = null;
                    } else {
                        window.selectionHeadCell = this;
                        // If we don't have an anchor yet, establish one.
                        if (!window.selectionAnchorCell) {
                            window.selectionAnchorCell = this;
                        }
                    }
                } else if (e.shiftKey && lastSelectedCell) {
                    // Shift+Click for range selection
                    endCell = this;
                    if (!window.selectionAnchorCell) {
                        window.selectionAnchorCell = lastSelectedCell;
                    }
                    window.selectionHeadCell = endCell;
                    selectRange(window.selectionAnchorCell, window.selectionHeadCell);
                    lastSelectedCell = endCell;
                } else {
                    // Start new selection
                    isSelecting = true;
                    startCell = this;
                    endCell = this;
                    window.selectionAnchorCell = startCell;
                    window.selectionHeadCell = startCell;

                    // Clear previous selection
                    $table.find('.selected-cell').removeClass('selected-cell');
                    window.selectedCells = [];

                    // Select starting cell
                    $(this).addClass('selected-cell');
                    window.selectedCells.push(this);
                    lastSelectedCell = this;
                }
                // Any direct cell interaction scopes the element type to cell
                $('#elementType').val('cell');
                if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
                if (typeof window.populateStylesPanel === 'function') window.populateStylesPanel();
            }
        });

        // Mouse move - extend selection during drag
        $container.on('mousemove.cell', 'td, th', function (e) {
            if (isSelecting) {
                endCell = this;
                window.selectionHeadCell = endCell;
                selectRange(window.selectionAnchorCell || startCell, window.selectionHeadCell);
            }
        });

        // Mouse up - end selection
        $(document).on('mouseup.cell', function () {
            if (isSelecting) {
                isSelecting = false;
                if (endCell) {
                    lastSelectedCell = endCell;
                    window.selectionHeadCell = endCell;
                }
                // Drag-select always scopes to cell granularity
                $('#elementType').val('cell');
                // (Draw mode operates via the Draw Canvas panel, not via cell selection)
                if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
                if (typeof window.populateStylesPanel === 'function') window.populateStylesPanel();
            }
        });

        // Prevent text selection during drag
        $container.on('selectstart.cell', function (e) {
            if (isSelecting) {
                e.preventDefault();
            }
        });

        // Helper function to select a range of cells
        function selectRange(start, end) {
            if (!start || !end || !window.currentTable) return;

            const $table = $(window.currentTable);
            const mapper = new VisualGridMapper($table);
            const startPos = mapper.getVisualPosition(start);
            const endPos = mapper.getVisualPosition(end);

            if (!startPos || !endPos) return;

            // Clear previous selection
            $table.find('.selected-cell').removeClass('selected-cell');
            window.selectedCells = [];

            // Determine the rectangle boundaries
            const minRow = Math.min(startPos.startRow, endPos.startRow);
            const maxRow = Math.max(startPos.startRow + startPos.rowspan - 1, endPos.startRow + endPos.rowspan - 1);
            const minCol = Math.min(startPos.startCol, endPos.startCol);
            const maxCol = Math.max(startPos.startCol + startPos.colspan - 1, endPos.startCol + endPos.colspan - 1);

            // Select all cells in the rectangle.
            //
            // A column the active sp- tab does not show is skipped: it is still
            // in the grid, so without this a range that merely spans across it
            // picks up cells the user cannot see — which then get cleared by
            // Delete, filled by a drag, and counted in the selection box.
            for (let r = minRow; r <= maxRow; r++) {
                for (let c = minCol; c <= maxCol; c++) {
                    if (mapper.grid[r] && mapper.grid[r][c]) {
                        const cell = mapper.grid[r][c].element;
                        if (mapper.grid[r][c].isOrigin && window.isCellVisible(cell)) {
                            $(cell).addClass('selected-cell');
                            if (!window.selectedCells.includes(cell)) {
                                window.selectedCells.push(cell);
                            }
                        }
                    }
                }
            }
        }


        // ── Spreadsheet cell model ────────────────────────────────────────────
        // Numbers and Sheets both split the selection in two: a RANGE that is
        // tinted, and one ACTIVE cell inside it that typing lands in. Everything
        // below keeps those two in sync, because without the second one there is
        // no answer to "where does this keystroke go?" once a range is selected.

        function activeCell() {
            const head = window.selectionHeadCell;
            if (head && window.selectedCells.includes(head)) return head;
            return window.selectedCells[0] || null;
        }

        function syncActiveCell() {
            $('#tableContainer .tf-active-cell').removeClass('tf-active-cell');
            const cell = activeCell();
            if (cell) $(cell).addClass('tf-active-cell');
        }
        window.syncActiveCell = syncActiveCell;

        /** The next visible cell `dr` rows / `dc` cols away, skipping hidden ones. */
        function neighbourCell(cell, dr, dc) {
            if (!cell || !window.currentTable || (!dr && !dc)) return null;
            const mapper = new VisualGridMapper($(window.currentTable));
            const pos = mapper.getVisualPosition(cell);
            if (!pos) return null;
            const grid = mapper.grid || [];
            // Step from the far edge of a merged cell so a 3-wide header does not
            // walk back into itself on every Tab.
            let r = dr > 0 ? pos.startRow + pos.rowspan - 1 : pos.startRow;
            let c = dc > 0 ? pos.startCol + pos.colspan - 1 : pos.startCol;
            for (let guard = 0; guard < 500; guard++) {
                r += dr; c += dc;
                const slot = grid[r] && grid[r][c];
                if (!slot) return null;
                const el = slot.element;
                // A cell inside a collapsed group or an inactive sp-* column has
                // no box; landing on it would put the caret somewhere invisible.
                if (el !== cell && window.isCellVisible(el)) return el;
            }
            return null;
        }

        /** Make `cell` the active cell — replacing the range, or extending it. */
        function focusCell(cell, extend) {
            if (!cell || !window.currentTable) return;
            const $table = $(window.currentTable);
            if (extend) {
                if (!window.selectionAnchorCell) window.selectionAnchorCell = activeCell() || cell;
                window.selectionHeadCell = cell;
                selectRange(window.selectionAnchorCell, window.selectionHeadCell);
            } else {
                $table.find('.selected-cell').removeClass('selected-cell');
                window.selectedCells = [cell];
                $(cell).addClass('selected-cell');
                window.selectionAnchorCell = cell;
                window.selectionHeadCell = cell;
            }
            lastSelectedCell = cell;
            window.tableHasFocus = true;
            syncActiveCell();
            cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
            if (typeof window.highlightRuler === 'function') window.highlightRuler(window.currentTable, window.selectedCells);
            if (typeof window.populateStylesPanel === 'function') window.populateStylesPanel();
        }
        window.focusCell = focusCell;

        /**
         * Open the inline editor on a cell.
         *
         * `seed` is what a type-to-edit keystroke already produced: in a sheet
         * you do not double-click first, you just start typing and the old value
         * is gone. Passing it here is what makes that one gesture instead of two.
         */
        function beginCellEdit(cell, seed) {
            if (!cell) return;
            if (typeof window.saveCurrentState === 'function') window.saveCurrentState();

            const $cell = $(cell);
            window.cellBeingEdited = cell;
            window.originalContent = $cell.html();

            const existing = $('<div>').html($cell.html()).text();
            const $input = $('<textarea>')
                .addClass('inline-cell-editor')
                .val(seed != null ? seed : existing)
                .css({
                    width: $cell.innerWidth(),
                    height: $cell.innerHeight(),
                    margin: 0,
                    padding: 0,
                    resize: 'none',
                    'box-sizing': 'border-box',
                });

            $('.inline-cell-editor').remove();
            $cell.empty().append($input);
            $input.focus();
            // Type-to-edit leaves the caret after the seed character; an explicit
            // edit (dblclick / Enter / F2) selects the value so it can be replaced.
            if (seed == null) $input.select();
            else $input[0].setSelectionRange($input.val().length, $input.val().length);

            $input.off('click.preventSave').on('click.preventSave', function (ev) { ev.stopPropagation(); });
        }
        window.beginCellEdit = beginCellEdit;

        /** Write the editor's value back into its cell and close it. */
        function commitCellEdit() {
            const $editor = $('.inline-cell-editor');
            if (!$editor.length) return null;
            const $cell = $editor.closest('td, th');
            $cell.html($('<div>').text($editor.val()).html());
            $editor.remove();
            window.cellBeingEdited = null;
            window.originalContent = null;
            return $cell[0] || null;
        }
        window.commitCellEdit = commitCellEdit;

        /** Empty every selected cell — Delete in a sheet clears, it does not remove. */
        function clearSelectedCells() {
            if (!window.selectedCells.length) return;
            if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
            window.selectedCells.forEach(c => { c.innerHTML = ''; });
            if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
        }
        window.clearSelectedCells = clearSelectedCells;

        // Mobile long-press support
        let pressTimer;
        $container.on('touchstart.cell', 'td, th', function (e) {
            const self = this;
            const touch = e.originalEvent.touches[0];
            // Store touch position for context menu
            const touchX = touch.clientX;
            const touchY = touch.clientY;

            pressTimer = window.setTimeout(function () {
                const event = $.Event('contextmenu', {
                    clientX: touchX,
                    clientY: touchY,
                    originalEvent: e.originalEvent
                });
                $(self).trigger(event);
            }, 600); // 600ms for long press
        }).on('touchend.cell touchmove.cell', function () {
            clearTimeout(pressTimer);
        });

        // Context menu for cells
        $container.on('contextmenu.cell', 'td, th', function (e) {
            e.preventDefault();
            const $menu = $('#cellContextMenu');

            // Show first so outerWidth/Height are accurate
            $menu.show();

            const menuW = $menu.outerWidth();
            const menuH = $menu.outerHeight();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const pad = 8; // viewport edge clearance

            // Viewport-relative for position:fixed
            let x = e.clientX;
            let y = e.clientY;

            // On mobile, if it's very narrow, we might want it centered or bottom-aligned
            // but for now let's just ensure it's within bounds.
            if (vw <= 767) {
                // If it's a mobile touch, we might want to center it a bit better or show as bottom sheet
                // The user said: "contextMenu cannot be opened and edited"
                // Let's position it near the touch but ensure it doesn't overflow
                if (x + menuW > vw) x = vw - menuW - pad;
                if (y + menuH > vh) y = vh - menuH - pad;
                if (x < pad) x = pad;
                if (y < pad) y = pad;
            } else {
                // Desktop flip logic
                if (x + menuW + pad > vw) x = Math.max(pad, x - menuW);
                if (y + menuH + pad > vh) y = Math.max(pad, vh - menuH - pad);
                if (y < pad) y = pad;
            }

            $menu.css({
                top: y + 'px',
                left: x + 'px',
                display: 'grid',
                position: 'fixed' // Ensure it's relative to viewport
            });

            window.cellBeingEdited = this;
        });


        // Hide context menus when clicking elsewhere
        $(document).on('click.hideMenu', function () {
            $('#cellContextMenu, #tabContextMenu').hide();
        });

        // Right-click context menu — shared handler for sp-option tabs and accordion headings
        function showTabContextMenu(e, target) {
            e.preventDefault();
            e.stopPropagation();
            window._tabCtxTarget = target;
            const $menu = $('#tabContextMenu');
            $menu.show();
            const menuW = $menu.outerWidth(), menuH = $menu.outerHeight();
            const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
            let x = e.clientX, y = e.clientY;
            if (x + menuW + pad > vw) x = Math.max(pad, x - menuW);
            if (y + menuH + pad > vh) y = Math.max(pad, vh - menuH - pad);
            $menu.css({ top: y + 'px', left: x + 'px', display: 'grid', position: 'fixed' });
        }

        $container.off('contextmenu.spOption').on('contextmenu.spOption', '.sp-option', function (e) {
            showTabContextMenu(e, this);
        });

        $container.off('contextmenu.accordionHeading').on('contextmenu.accordionHeading', 'button.accordion', function (e) {
            showTabContextMenu(e, this);
        });

        // Returns true only when the active context is a table cell.
        // Uses window.tableHasFocus (set on cell mousedown / cleared on outside
        // mousedown) as the primary signal.  document.activeElement is unreliable
        // here because clicking a td/th inside a contenteditable div does not move
        // focus away from Monaco's last-focussed textarea.
        function isTableContext() {
            if (!window.currentTable || !window.tableHasFocus) return false;
            if ($('.inline-cell-editor').length) return false;
            // Secondary rejection: if something that can receive text input is
            // currently active, don't steal its Ctrl shortcuts.
            const active = document.activeElement;
            if (active && $(active).is('input, textarea, select, [contenteditable="true"]')) return false;
            return true;
        }

        $(document).off('keydown').on('keydown', function (e) {
            if (e.repeat) return;

            // The inline editor has its own key handling (commit and move) and
            // is bound to this same document node, so which of the two runs
            // first is an artefact of bind order — not something to depend on.
            // A keystroke aimed at the editor is the editor's, full stop;
            // without this, Tab moved two cells and Enter re-opened the editor
            // on the cell it had just moved to.
            if ($(e.target).hasClass('inline-cell-editor')) return;

            // Alt+D — toggle drag-and-drop (global, works outside table context)
            if (e.altKey && !e.shiftKey && e.code === 'KeyD') {
                if (!$(e.target).is('input, textarea, select, [contenteditable="true"]')) {
                    e.preventDefault();
                    $('#toggleDragDrop').trigger('click');
                    return;
                }
            }

            // Arrow-key table navigation (keyboard-first fallback included).
            if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
                // Don't hijack arrows while typing in editors/inputs.
                const typingTarget = $(e.target).is('input, textarea, select, [contenteditable="true"]');
                if (typingTarget || $('.inline-cell-editor').length) return;

                // Resolve active table if needed.
                if (!window.currentTable) {
                    window.currentTable = $('#tableContainer table')[0] || null;
                }
                if (!window.currentTable) return;

                const $table = $(window.currentTable);
                const mapper = new VisualGridMapper($table);
                const grid = mapper.grid || [];
                if (!grid.length) return;

                let currentCell = window.selectionHeadCell || window.selectedCells[window.selectedCells.length - 1];
                if (!currentCell) {
                    // Keyboard-only start: focus first available visual cell.
                    const firstVisual = grid[0] && grid[0][0] ? grid[0][0].element : null;
                    if (!firstVisual) return;
                    $table.find('.selected-cell').removeClass('selected-cell');
                    window.selectedCells = [firstVisual];
                    $(firstVisual).addClass('selected-cell');
                    currentCell = firstVisual;
                    window.selectionAnchorCell = firstVisual;
                    window.selectionHeadCell = firstVisual;
                }

                // neighbourCell walks past hidden cells rather than landing on
                // one: pressing → at the last visible column of a tab used to
                // move the selection into the next sp- column, where it simply
                // vanished — still selected, nowhere on screen.
                const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
                const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
                const targetCell = neighbourCell(currentCell, dr, dc);
                if (!targetCell) return;

                e.preventDefault();
                focusCell(targetCell, e.shiftKey);
                return;
            }

            const key = e.key.toLowerCase();
            const ctrl = e.ctrlKey || e.metaKey;

            // ── Spreadsheet keys ──────────────────────────────────────────────
            // Tab / Enter / type-to-edit, the three gestures that separate a
            // sheet from a table you have to reach for the mouse to change.
            // Only when a cell is the active context and nothing is being typed
            // into yet — the editor's own handler takes over from there.
            if (isTableContext()) {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const cell = activeCell();
                    if (cell) focusCell(neighbourCell(cell, 0, e.shiftKey ? -1 : 1), false);
                    return;
                }
                if (e.key === 'Enter' && !ctrl && !e.altKey) {
                    e.preventDefault();
                    beginCellEdit(activeCell());
                    return;
                }
                if (e.key === 'F2') {
                    e.preventDefault();
                    beginCellEdit(activeCell());
                    return;
                }
                // A printable key replaces the cell's value, the way it does in
                // Numbers and Sheets. Modifier combinations fall through to the
                // shortcuts below.
                if (e.key.length === 1 && !ctrl && !e.altKey) {
                    const cell = activeCell();
                    if (cell) {
                        e.preventDefault();
                        beginCellEdit(cell, e.key);
                        return;
                    }
                }
            }

            if ((key === 'delete' || key === 'backspace') && !e.altKey && !e.shiftKey) {
                // Delete/Backspace → clear the selected cells' contents.
                // Structural removal is Shift+Delete (and the toolbar buttons):
                // in a sheet, Delete empties a cell, it does not collapse the
                // grid around it.
                if (!isTableContext()) return;
                e.preventDefault();
                clearSelectedCells();
            } else if ((key === 'insert' || (ctrl && key === 'enter')) && !e.shiftKey && !e.repeat) {
                // Insert or Ctrl/Cmd+Enter → scope-aware Add After
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof addSelectedAfter === 'function') addSelectedAfter();
            } else if ((key === 'insert' || (ctrl && key === 'enter')) && e.shiftKey && !e.repeat) {
                // Shift+Insert or Shift+Ctrl/Cmd+Enter → scope-aware Add Before
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof addSelectedBefore === 'function') addSelectedBefore();
            } else if ((key === 'delete' || key === 'backspace') && e.shiftKey && !e.altKey) {
                // Shift+Delete/Backspace → scope-aware delete (same routing as plain Delete)
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof deleteSelected === 'function') deleteSelected();
            } else if (ctrl && key === 'a') {
                // Ctrl+A → Select all cells
                if (!isTableContext()) return;
                e.preventDefault();
                const $table = $(window.currentTable);
                const mapper = new VisualGridMapper($table);
                $table.find('.selected-cell').removeClass('selected-cell');
                window.selectedCells = [];
                mapper.cellMap.forEach((info, cell) => {
                    if (!window.isCellVisible(cell)) return;
                    $(cell).addClass('selected-cell');
                    window.selectedCells.push(cell);
                });
                window.selectionAnchorCell = window.selectedCells[0] || null;
                window.selectionHeadCell = window.selectedCells[0] || null;
                if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
            } else if (ctrl && !e.shiftKey && key === 'c') {
                // Ctrl/Cmd+C → Copy selected cells (only in table context; falls through to system copy otherwise)
                if (!isTableContext() || window.selectedCells.length === 0) return;
                e.preventDefault();
                if (typeof copySelected === 'function') copySelected();
            } else if (ctrl && e.shiftKey && key === 'v') {
                // Ctrl+Shift+V → Paste Before
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof pasteBefore === 'function') pasteBefore();
            } else if (ctrl && !e.shiftKey && key === 'v') {
                // Ctrl+V → Paste After
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof pasteAfter === 'function') pasteAfter();
            } else if (e.altKey && e.shiftKey && e.code === 'KeyW') {
                // Alt/Option+Shift+W → Merge (e.code avoids Mac Option producing Unicode chars)
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof mergeCells === 'function') mergeCells();
            } else if (e.altKey && e.shiftKey && e.code === 'KeyT') {
                // Alt/Option+Shift+T → Text Split modal
                if (!isTableContext()) return;
                e.preventDefault();
                $('#textSplitModal').modal('show');
            } else if (e.altKey && e.shiftKey && e.code === 'KeyX') {
                // Alt/Option+Shift+X → Apply text split
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof applyTextSplit === 'function') applyTextSplit();
            } else if (ctrl && key === 'z' && !e.shiftKey) {
                e.preventDefault();
                performUndo();
            }
            // Ctrl+Y or Ctrl+Shift+Z for redo
            else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
                e.preventDefault();
                performRedo();
            }
        });

        // Clear table focus when the user clicks anywhere outside the table container.
        // The td/th mousedown calls stopPropagation(), so this won't fire on cell clicks.
        $(document).off('mousedown.tableFocus').on('mousedown.tableFocus', function (e) {
            if (!$(e.target).closest('#tableContainer').length) {
                window.tableHasFocus = false;
            }
        });

        // Double click to edit cell
        $container.off('dblclick.cell').on('dblclick.cell', 'td, th', function (e) {
            beginCellEdit(this);
            e.stopPropagation();
        });

        // Double click to rename tab labels — overlay input, never nest inside button
        $container.off('dblclick.tabLabel').on('dblclick.tabLabel', '.sp-option', function (e) {
            //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

            e.stopPropagation();
            const $btn = $(this);
            if ($btn.find('.tab-label-editor').length) return;

            const originalText = $btn.text().trim();
            const btnOffset = $btn.offset();
            const containerOffset = $container.offset();

            const $input = $('<input type="text">')
                .addClass('tab-label-editor')
                .val(originalText)
                .css({
                    position: 'absolute',
                    top: btnOffset.top - containerOffset.top,
                    left: btnOffset.left - containerOffset.left,
                    width: $btn.outerWidth(),
                    height: $btn.outerHeight(),
                    zIndex: 1000,
                    fontSize: $btn.css('font-size'),
                    textAlign: 'center',
                    boxSizing: 'border-box',
                    padding: '0 4px'
                });

            $container.css('position', 'relative').append($input);
            $input.focus().select();

            function commit() {
                const val = $input.val().trim() || originalText;
                $btn.text(val);
                $input.remove();
                window.saveCurrentState();
            }

            $input.on('blur', commit).on('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { $input.remove(); }
            });
        });

        // Double click to rename accordion table headings
        $container.off('dblclick.tableHeading').on('dblclick.tableHeading', 'button.accordion', function (e) {
            //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

            e.stopPropagation();
            const $btn = $(this);
            const $label = $btn.find('b');
            if (!$label.length) return;

            const originalText = $label.text().trim();
            const btnOffset = $btn.offset();
            const containerOffset = $container.offset();

            const $input = $('<input type="text">')
                .addClass('tab-label-editor')
                .val(originalText)
                .css({
                    position: 'absolute',
                    top: btnOffset.top - containerOffset.top,
                    left: btnOffset.left - containerOffset.left,
                    width: $btn.outerWidth(),
                    height: $btn.outerHeight(),
                    zIndex: 1000,
                    fontSize: $btn.css('font-size'),
                    fontWeight: 'bold',
                    boxSizing: 'border-box',
                    padding: '0 8px'
                });

            $container.css('position', 'relative').append($input);
            $input.focus().select();

            function commit() {
                const val = $input.val().trim() || originalText;
                $label.text(val);
                $input.remove();
                window.saveCurrentState();
            }

            $input.on('blur', commit).on('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { $input.remove(); }
            });
        });

        // Click elsewhere to save
        $(document).off('click.cell').on('click.cell', function (e) {
            if (!window.cellBeingEdited) return;
            const $editor = $('.inline-cell-editor');
            if ($editor.length === 0) return;
            if ($(e.target).closest(window.cellBeingEdited).length) {
                return;
            }
            commitCellEdit();
        });

        // ── In-editor keys ────────────────────────────────────────────────────
        // Commit and move: Enter down, Shift+Enter up, Tab right, Shift+Tab
        // left. Committing without moving strands the user in the cell they
        // just finished and makes filling a column a mouse job.
        //
        // Alt/Ctrl+Enter inserts a newline instead — a cell that can hold two
        // lines needs some way to say so.
        $(document).off('keydown.cellEditor').on('keydown.cellEditor', '.inline-cell-editor', function (e) {
            const ctrl = e.ctrlKey || e.metaKey;

            if (e.key === 'Enter' && !ctrl && !e.altKey) {
                e.preventDefault();
                const cell = commitCellEdit();
                if (cell) focusCell(neighbourCell(cell, e.shiftKey ? -1 : 1, 0) || cell, false);
                return;
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                const cell = commitCellEdit();
                if (cell) focusCell(neighbourCell(cell, 0, e.shiftKey ? -1 : 1) || cell, false);
                return;
            }
            if (e.key === 'Escape' && window.cellBeingEdited) {
                e.preventDefault();
                const cell = window.cellBeingEdited;
                $(cell).html(window.originalContent);
                $('.inline-cell-editor').remove();
                window.cellBeingEdited = null;
                window.originalContent = null;
                focusCell(cell, false);
            }
        });

        // Rebuild rulers after any structural table operation
        if (typeof window.renderTableRulers === 'function') {
            requestAnimationFrame(() => {
                $('#tableContainer table.tablecoil').each(function () {
                    window.renderTableRulers(this);
                });
            });
        }

        // Wire always-on dblclick+drag cell swap (activates toggle automatically on first use)
        if (typeof window.setupCellDrag === 'function') {
            $('#tableContainer table.tablecoil').each(function () {
                window.setupCellDrag(this);
            });
        }
    }

    // Make setupTableInteraction globally accessible
    window.setupTableInteraction = setupTableInteraction;

    // =================== BEFORE/AFTER CELL OPTIONS (FIXED FOR POPPER V1) ===================
    const toolboxButtons = ['.addCell', '.addRow', '.addColumn', '.pasteCell'];

    toolboxButtons.forEach(selector => {
        const buttons = document.querySelectorAll(selector);
        const cellOptions = document.querySelector('.cell-options');

        if (!cellOptions) return;

        buttons.forEach(button => {
            if (!button) return;

            let popperInstance = null;
            let hideTimeout = null;

            const showCellOptions = (triggerElement) => {
                // Clear any pending hide
                if (hideTimeout) {
                    clearTimeout(hideTimeout);
                    hideTimeout = null;
                }

                cellOptions.style.display = 'block';

                // Destroy existing instance
                if (popperInstance) {
                    popperInstance.destroy();
                }

                // FIXED: Use Popper v1.x API (compatible with Bootstrap 4.1.3)
                // Popper v1.x uses 'new Popper()' not 'Popper.createPopper()'
                if (typeof Popper !== 'undefined') {
                    popperInstance = new Popper(triggerElement, cellOptions, {
                        placement: 'top',
                    });
                } else {
                    // Fallback if Popper is not available
                    const rect = triggerElement.getBoundingClientRect();
                    cellOptions.style.position = 'absolute';
                    cellOptions.style.top = (rect.top - cellOptions.offsetHeight - 10) + 'px';
                    cellOptions.style.left = rect.left + 'px';
                }

                // Setup click handlers
                const beforeCell = cellOptions.querySelector('.beforeCell');
                const afterCell = cellOptions.querySelector('.afterCell');

                // Remove previous listeners
                const newBeforeCell = beforeCell.cloneNode(true);
                const newAfterCell = afterCell.cloneNode(true);
                beforeCell.replaceWith(newBeforeCell);
                afterCell.replaceWith(newAfterCell);

                // Get fresh references
                const finalBeforeCell = cellOptions.querySelector('.beforeCell');
                const finalAfterCell = cellOptions.querySelector('.afterCell');

                // Add new listeners based on which button was hovered
                if (selector === '.addCell') {
                    finalBeforeCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addCellBefore === 'function') addCellBefore();
                        hideCellOptions();
                    };
                    finalAfterCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addCell === 'function') addCell();
                        hideCellOptions();
                    };
                } else if (selector === '.addRow') {
                    finalBeforeCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addRowBefore === 'function') addRowBefore();
                        hideCellOptions();
                    };
                    finalAfterCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addRow === 'function') addRow();
                        hideCellOptions();
                    };
                } else if (selector === '.addColumn') {
                    finalBeforeCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addColumnBefore === 'function') addColumnBefore();
                        hideCellOptions();
                    };
                    finalAfterCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addColumn === 'function') addColumn();
                        hideCellOptions();
                    };
                } else if (selector === '.pasteCell') {
                    finalBeforeCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof pasteBefore === 'function') pasteBefore();
                        hideCellOptions();
                    };
                    finalAfterCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof pasteAfter === 'function') pasteAfter();
                        hideCellOptions();
                    };
                }
            };

            const hideCellOptions = () => {
                hideTimeout = setTimeout(() => {
                    if (popperInstance) {
                        popperInstance.destroy();
                        popperInstance = null;
                    }
                    cellOptions.style.display = 'none';
                }, 200);
            };

            button.addEventListener('mouseenter', (e) => {
                showCellOptions(e.currentTarget);
            });

            cellOptions.addEventListener('mouseenter', () => {
                if (hideTimeout) {
                    clearTimeout(hideTimeout);
                    hideTimeout = null;
                }
            });

            cellOptions.addEventListener('mouseleave', () => {
                hideCellOptions();
            });
        });
    });

    // =================== EVENT HANDLERS ===================
    $('#generateTabs').on('click', function () {
        if ($('#tableContainer table').length > 0) {
            if (typeof generateTabs === 'function') generateTabs();
        } else {
            $.toast({ heading: 'Info', text: 'Please parse a table first', icon: 'warning', loader: false, stack: false });
        }
    });

    $('.undoHistory').on('click', function () {
        if ($('#tableContainer table').length > 0) {
            performUndo();
        } else {
            $.toast({ heading: 'Info', text: 'Please parse input', icon: 'warning', loader: false, stack: false });
        }
    });
    $('.redoHistory').on('click', function () {
        if ($('#tableContainer table').length > 0) {
            performRedo();
        } else {
            $.toast({ heading: 'Info', text: 'Please parse input', icon: 'warning', loader: false, stack: false });
        }
    });

    $('#toggleDragDrop').on('click', function () {
        window.dragDropEnabled = !window.dragDropEnabled;

        if (window.dragDropEnabled) {
            $(this).text('Enabled').css({ 'background-color': 'lightgreen', 'color': 'white' });
            if (typeof enableDragDrop === 'function') enableDragDrop();
        } else {
            $(this).text('Disabled').css({ 'border': '1px solid #999999', 'background-color': '#cccccc', 'color': '#666666' });
            if (typeof disableDragDrop === 'function') disableDragDrop();
        }
        // Sync toolbar switch
        $('#dragDropSwitch').prop('checked', window.dragDropEnabled);
    });

    $('.applyTextSplit').on('click', function () {
        if (typeof applyTextSplit === 'function') applyTextSplit();
    });

    $('.transposeTable').on('click', function () {
        if (typeof transposeTable === 'function') transposeTable();
    });

    $('.transposeSelection').on('click', function () {
        if (typeof transposeSelection === 'function') transposeSelection();
    });

    $('.toggleCrosshair').on('click', function () {
        if (typeof toggleCrosshair === 'function') toggleCrosshair();
    });

    $('.applyStyle').on('click', function () {
        if (typeof applyStyle === 'function') applyStyle();
    });

    $('.duplicateElement').on('click', function () {
        if (typeof duplicateElement === 'function') duplicateElement();
    });

    $('.copyCell').on('click', function () {
        if (typeof copySelected === 'function') copySelected();
    });

    // Table Operations - Delete Operations
    $('.deleteCell').on('click', function () {
        if (window.selectedCells.length === 0) {
            $.toast({ heading: 'Info', text: 'Please select at least one cell to delete.', icon: 'warning', loader: false, stack: false });
            return;
        }
        if (typeof deleteCell === 'function') deleteCell();
    });

    $('.deleteRow').on('click', function () {
        if (window.selectedCells.length === 0) {
            $.toast({ heading: 'Info', text: 'Please select at least one cell to delete its row.', icon: 'warning', loader: false, stack: false });
            return;
        }
        if (typeof deleteRows === 'function') deleteRows();
    });

    $('.deleteColumn').on('click', function () {
        if (window.selectedCells.length === 0) {
            $.toast({ heading: 'Info', text: 'Please select at least one cell to delete its column.', icon: 'warning', loader: false, stack: false });
            return;
        }
        if (typeof deleteColumns === 'function') deleteColumns();
    });

    $('.mergeCells').on('click', function () {
        if (typeof mergeCells === 'function') mergeCells();
    });

    $('#applyClassId').on('click', function () {
        if (typeof applyClassId === 'function') applyClassId();
    });

    $('#basic-addon1').on('click', function () {
        $(this).toggleClass('sp-active');
    });

    $('#generateCode').on('click', function () {
        if (typeof generateCode === 'function') generateCode();
    });

    $('#copyInput').on('click', function () {
        if (typeof copyInput === 'function') copyInput();
    });

    $('.editCell').on('click', function () {
        // Multi-cell: open Monaco editor with TSV representation of the selection
        if (window.selectedCells && window.selectedCells.length > 1) {
            if (typeof window.openMultiCellEdit === 'function') window.openMultiCellEdit();
            return;
        }
        // Single-cell: original textarea modal
        if (!window.cellBeingEdited) return;
        const content = $(window.cellBeingEdited).html();
        $('#cellContent').val(content);
        $('#editCellModal').modal('show');
    });

    $('#applyMultiCellEdit').on('click', function () {
        if (typeof window.applyMultiCellEdit === 'function') window.applyMultiCellEdit();
    });

    // ── Tab context menu actions ──────────────────────────────────────────────
    // ── Tab context menu actions ──────────────────────────────────────────────
    // Both sp-option buttons and accordion headings share these handlers;
    // branch on the target's class to apply the right operation.

    function _isAccordionTarget() {
        return $(window._tabCtxTarget).hasClass('accordion');
    }

    function _makeAccordionPair(label) {
        const $acc = $('<button>').addClass('accordion active').html(`<b>${label}</b>`);
        const $panel = $('<div>').addClass('panel').html('<div class="sp-selector"></div>');
        return { $acc, $panel };
    }

    $('#tabCtxRename').on('click', function () {
        const $btn = $(window._tabCtxTarget);
        if ($btn.length) $btn.trigger('dblclick'); // reuse existing inline-rename flow for both types
        $('#tabContextMenu').hide();
    });

    $('#tabCtxAddAfter').on('click', function () {
        const $btn = $(window._tabCtxTarget);
        if (!$btn.length) return;
        window.saveCurrentState();

        if (_isAccordionTarget()) {
            const tableCount = $('#tableContainer .accordion').length + 1;
            const { $acc, $panel } = _makeAccordionPair(`Table ${tableCount}`);
            // Insert after accordion + its panel sibling
            $btn.next('.panel').after($panel).after($acc);
            window.setupTableInteraction();
        } else {
            const $selector = $btn.closest('.sp-selector');
            const nextVal   = $selector.find('.sp-option').length + 1;
            $btn.after(
                $('<button>').addClass('sp-option')
                    .attr({ 'data-value': nextVal, 'data-panel': $btn.data('panel') })
                    .text(nextVal)
            );
        }
        $('#tabContextMenu').hide();
    });

    $('#tabCtxAddBefore').on('click', function () {
        const $btn = $(window._tabCtxTarget);
        if (!$btn.length) return;
        window.saveCurrentState();

        if (_isAccordionTarget()) {
            const tableCount = $('#tableContainer .accordion').length + 1;
            const { $acc, $panel } = _makeAccordionPair(`Table ${tableCount}`);
            $btn.before($panel).before($acc);
            window.setupTableInteraction();
        } else {
            const $selector = $btn.closest('.sp-selector');
            const nextVal   = $selector.find('.sp-option').length + 1;
            $btn.before(
                $('<button>').addClass('sp-option')
                    .attr({ 'data-value': nextVal, 'data-panel': $btn.data('panel') })
                    .text(nextVal)
            );
        }
        $('#tabContextMenu').hide();
    });

    $('#tabCtxDelete').on('click', function () {
        const $btn = $(window._tabCtxTarget);
        if (!$btn.length) return;

        if (_isAccordionTarget()) {
            if ($('#tableContainer .accordion').length <= 1) {
                $.toast({ heading: 'Info', text: 'Cannot delete the only table section.', icon: 'warning', loader: false, stack: false });
                $('#tabContextMenu').hide();
                return;
            }
            window.saveCurrentState();
            $btn.next('.panel').remove();
            $btn.remove();
            window.setupTableInteraction();
        } else {
            const $selector = $btn.closest('.sp-selector');
            if ($selector.find('.sp-option').length <= 1) {
                $.toast({ heading: 'Info', text: 'Cannot delete the only tab.', icon: 'warning', loader: false, stack: false });
                $('#tabContextMenu').hide();
                return;
            }
            window.saveCurrentState();
            $btn.remove();
        }
        $('#tabContextMenu').hide();
    });

    $('#saveCellContent').on('click', function () {
        if (!window.cellBeingEdited) return;

        const newContent = $('#cellContent').val();
        window.saveCurrentState();
        $(window.cellBeingEdited).html(newContent);

        $('#editCellModal').modal('hide');
        window.cellBeingEdited = null;
    });

    $('.textSplit').on('click', function () {
        if (window.selectedCells.length === 0) {
            $.toast({ heading: 'Info', text: 'Please select exactly one cell to split.', icon: 'warning', loader: false, stack: false });
            return;
        }
        $('#textSplitModal').modal('show');
    });

    // =================== PANEL TOGGLES ===================
    // The collapse itself is CSS (width -> 0 with a transition; see the
    // desktop block in tableIdeUI.css). All this has to do is stamp the width
    // the panel had before it starts closing, because the panel's own
    // children are held at that width while it narrows -- otherwise they
    // reflow on every frame and the panel looks like it is falling apart
    // rather than sliding shut. The right panel is user-resizable, so the
    // number cannot be a constant in the stylesheet.
    function _togglePanel($panel, $btn, showTitle, hideTitle) {
        const willHide = !$panel.hasClass('panel-hidden');
        if (willHide) {
            $panel[0].style.setProperty('--gx-panel-w', $panel.outerWidth() + 'px');
        }
        $panel.toggleClass('panel-hidden', willHide);
        $btn.attr('title', willHide ? showTitle : hideTitle);
        $btn.toggleClass('active', !willHide);
        const syncVisibleTables = function () {
            $('#tableContainer table.tablecoil').each(function () {
                if (typeof window.scheduleTableGeometrySync === 'function') window.scheduleTableGeometrySync(this);
            });
        };
        syncVisibleTables();
        // Follow every painted frame of the width transition. The table may
        // keep the same intrinsic size while its viewport position changes,
        // which means observing the table alone cannot move a fixed overlay.
        const started = performance.now();
        (function followPanelTransition(now) {
            syncVisibleTables();
            if (now - started < 280) requestAnimationFrame(followPanelTransition);
        })(started);
    }

    $('#toggleLeftPanel').on('click', function () {
        _togglePanel($('.table-ide-left-panel'), $(this), 'Show Tools Panel', 'Hide Tools Panel');
    });

    $('#toggleRightPanel').on('click', function () {
        _togglePanel($('.table-ide-right-panel'), $(this), 'Show Code Panel', 'Hide Code Panel');
    });

    // =================== LEFT PANEL SECTION ACCORDION ===================
    // Section headers rendered as <button> collapse/expand the body that follows them.
    $('.table-ide-left-panel').on('click', 'button.left-section-header', function () {
        $(this).toggleClass('collapsed')
            .next('.left-section-body').toggleClass('collapsed');
    });

    // =================== RIGHT PANEL RESIZE ===================
    (function () {
        var $handle = $('.right-panel-resize-handle');
        var $panel = $('.table-ide-right-panel');
        if (!$handle.length || !$panel.length) return;

        var startX, startWidth;

        $handle.on('mousedown', function (e) {
            e.preventDefault();
            startX = e.clientX;
            startWidth = $panel.outerWidth();
            $handle.addClass('dragging');
            $('body').css({ cursor: 'col-resize', 'user-select': 'none' });

            $(document).on('mousemove.rightResize', function (e) {
                var delta = startX - e.clientX;
                var newWidth = Math.min(600, Math.max(220, startWidth + delta));
                $panel.css('width', newWidth + 'px');
                $('#tableContainer table.tablecoil').each(function () {
                    if (typeof window.scheduleTableGeometrySync === 'function') window.scheduleTableGeometrySync(this);
                });
            });

            $(document).on('mouseup.rightResize', function () {
                $handle.removeClass('dragging');
                $('body').css({ cursor: '', 'user-select': '' });
                $(document).off('mousemove.rightResize mouseup.rightResize');
            });
        });
    })();

    // =================== LAB MODE TOGGLE ===================
    $('#labModeToggle').on('click', function () {
        if (typeof toggleLab === 'function') toggleLab();
    });

    // =================== NODE EDITOR TOGGLE ===================
    // (initNodeEditor wires the button; this disables it from selectToolToggle context)

    // Select tool toggle (visual only; normal mode indicator)
    $('#selectToolToggle').on('click', function () {
        if (window.labModeEnabled && typeof disableLab === 'function') {
            disableLab();
        }
        if (window.nodeEditorEnabled && typeof disableNodeEditor === 'function') {
            disableNodeEditor();
        }
        $(this).addClass('active');
    });

    // =================== DRAG & DROP SWITCH (toolbar) ===================
    $('#dragDropSwitch').on('change', function () {
        window.dragDropEnabled = $(this).prop('checked');
        if (window.dragDropEnabled) {
            if (typeof enableDragDrop === 'function') enableDragDrop();
            $('#toggleDragDrop').text('Enabled').css({ 'background-color': 'lightgreen', 'color': 'white' });
        } else {
            if (typeof disableDragDrop === 'function') disableDragDrop();
            $('#toggleDragDrop').text('Toggle Drag & Drop').css({ 'border': '1px solid #999999', 'background-color': '#cccccc', 'color': '#666666' });
        }
    });

    // =================== DECOUPLED TAB COUNT ===================
    // Changing #buttonIndex only updates the tab buttons; never re-renders the table
    $('#buttonIndex').on('change', function () {
        let count = Math.min(100, Math.max(1, parseInt($(this).val()) || 1));
        $(this).val(count);

        const $panel = $('#tableContainer .panel');
        if ($panel.length === 0) return;

        let tabsHtml = '<div class="sp-selector">\n';
        for (let i = 1; i <= count; i++) {
            tabsHtml += `<button class="sp-option" data-value="${i}" data-panel="0">${i}</button>\n`;
        }
        tabsHtml += '</div>';

        const $existing = $panel.find('.sp-selector');
        if ($existing.length) {
            $existing.replaceWith(tabsHtml);
        } else {
            $panel.prepend(tabsHtml);
        }
    });

    // =================== FILE LOAD BUTTON ===================
    $('#loadFileBtn').on('click', function () {
        $('#fileInput').val('').trigger('click');
    });

    $('#fileInput').on('change', function () {
        const file = this.files[0];
        if (file && typeof handleFileLoad === 'function') {
            handleFileLoad(file);
        }
    });

    // =================== INPUT MODAL OPEN ===================
    $('#inputModalBtn').on('click', function () {
        $('#inputModal').modal('show');
        // Trigger Monaco layout refresh after modal becomes visible
        setTimeout(function () {
            if (window.tableIdeMonacoInput) {
                window.tableIdeMonacoInput.layout();
            }
        }, 200);
    });

    // =================== PARSE INSIDE MODAL ===================
    $('#parseInputModal').on('click', function () {
        if (typeof parseInput === 'function') parseInput();
    });

    // =================== LAB CANVAS INIT ===================
    if (typeof initLabCanvas === 'function') initLabCanvas();

    // =================== NODE EDITOR INIT ===================
    if (typeof initNodeEditor === 'function') initNodeEditor();

    // Initialize
    initializeAllFeatures();

    // =================== VS CODE EXTENSION BOOT ===================
    // When opened via the Ginexys VS Code extension, the extension injects
    // window.__GINEXYS_INITIAL_FILE__ before </body>. Route its content
    // through the existing parser chain so no parsing logic is duplicated.
    function _gxLoadFile(gif) {
        var _extTypeMap = {
            '.csv':  'csv',
            '.tsv':  'csv',
            '.md':   'markdown',
            '.sql':  'sql',
            '.json': 'json',
            '.html': 'html',
        };
        var _inputType = _extTypeMap[gif.ext] || 'csv';
        $('#inputType').val(_inputType);
        // .val() does NOT fire 'change', and the Monaco language switch is
        // bound to that event — so without this the editor keeps whatever
        // language it was created with. Cosmetic for parsing (parseInput reads
        // #inputType directly), but an .html file otherwise opens with
        // plaintext highlighting, which reads as "it didn't recognise this".
        $('#inputType').trigger('change');
        if (window.tableIdeMonacoInput) {
            window.tableIdeMonacoInput.setValue(gif.content);
        } else {
            // Monaco is created later, inside an async require([...]) callback.
            // Write the fallback textarea; the Monaco init block seeds itself
            // from it, so the content survives the boundary instead of being
            // stranded in a hidden element while an empty editor becomes the
            // source of truth. See the seeding comment in index.html.
            $('#tableInput').val(gif.content);
        }
        if (typeof parseInput === 'function') parseInput();
    }

    if (window.__GINEXYS_INITIAL_FILE__) {
        _gxLoadFile(window.__GINEXYS_INITIAL_FILE__);
    }

    // ── VS Code: binary .xlsx open + reload ─────────────────────────────────
    // xlsx can't ride the text __GINEXYS_INITIAL_FILE__ route; the XlsxEditor
    // extension provider sends base64 bytes instead. Public MIT: this is shape
    // (decode a file format the user opened), not gate — exactly the split the
    // pdf tool applies to its own ginexys:pdf-bytes handler.
    function _gxLoadXlsxFromBase64(base64, sheetName) {
        var bytes;
        try {
            var bin = atob(base64);
            bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } catch (err) {
            console.error('[GX] xlsx base64 decode failed:', err);
            return;
        }
        parseXlsxInput(bytes)
            .then(function (tableHtml) {
                if (!tableHtml) return;
                if (typeof addSheet === 'function') {
                    // Reloads replace, they don't stack: a watcher-fired second
                    // `ginexys:xlsx-bytes` lands after the first load's sheets
                    // are already in the tabs bar.
                    if (window.sheets && window.sheets.length) {
                        window.sheets = [];
                        window.activeSheetId = null;
                        window.lastParsedHtml = null;
                        if (typeof renderSheetTabs === 'function') renderSheetTabs();
                    }
                    addSheet(sheetName || 'Sheet 1', tableHtml);
                } else {
                    window.lastParsedHtml = tableHtml;
                    generateTabs(tableHtml);
                    window.currentTable = $('#tableContainer table')[0];
                    initializeAllFeatures();
                    setupTableInteraction();
                    window.saveCurrentState();
                }
            })
            .catch(function (err) {
                console.error('[GX] xlsx parse failed:', err);
                if (typeof showToast === 'function') {
                    showToast('Could not parse this .xlsx file.', 'error');
                }
            });
    }

    window.addEventListener('message', function (e) {
        if (e.data?.type !== 'ginexys:xlsx-bytes') return;
        var payload = e.data.payload || {};
        _gxLoadXlsxFromBase64(
            payload.buffer || '',
            payload.fileName ? payload.fileName.replace(/\.[^/.]+$/, '') : 'Sheet 1'
        );
    });

    // Announce ready ONLY after the listener above exists — the xlsx provider
    // answers this by posting the file's bytes, so getting it out before the
    // listener lands would drop the reply with no error anywhere (same race the
    // pdf tool documents for its own pdf-ready). Embedded-only: the browser
    // shell has no host waiting on this channel.
    if (window.CwsBridge?.isEmbedded) {
        window.CwsBridge.send('ginexys:tafne-xlsx-ready', {});
    }

    // ── Save back to the VS Code document ────────────────────────────────────
    // TableIdeEditorProvider has always handled a `ginexys:save` message, but
    // nothing in the tool ever sent one — so edits made here never reached the
    // file. Serialise the current tables in the OPEN FILE's format (not the
    // export dropdown's, which is a separate user choice) and hand it back.
    function _gxSerializeForHost(ext) {
        var $tables = $('#tableContainer table');
        if (!$tables.length) { return null; }
        switch ((ext || '').toLowerCase()) {
            case '.md':
                return typeof exportAsMarkdown === 'function' ? exportAsMarkdown($tables) : null;
            case '.sql':
                return typeof exportAsSql === 'function' ? exportAsSql($tables) : null;
            case '.json':
                return typeof exportAsJson === 'function' ? exportAsJson($tables) : null;
            case '.html':
                return typeof exportAsHtml === 'function' ? exportAsHtml() : null;
            case '.csv':
            case '.tsv':
            default:
                // exportAsCsv takes ONE table element, unlike the others.
                return typeof exportAsCsv === 'function'
                    ? exportAsCsv(window.currentTable || $tables[0]) : null;
        }
    }

    // Keep the native VS Code text document and this visual table surface on
    // one document model. Table operations mark the source document dirty as
    // they happen; Ctrl/Cmd+S remains the explicit disk-save boundary.
    var _gxHostEditTimer = null;
    var _gxApplyingHostUpdate = false;

    function _gxSendToHost(type) {
        if (!window.CwsBridge?.isEmbedded) { return false; }
        var ext = (window.__GINEXYS_INITIAL_FILE__ || {}).ext || '.csv';
        var content;
        try { content = _gxSerializeForHost(ext); } catch (err) {
            console.error('[GX] serialise for host failed:', err);
            content = null;
        }
        if (typeof content !== 'string') { return false; }
        window.CwsBridge.send(type, { content: content });
        return true;
    }

    window.__gxSaveToHost = function () {
        clearTimeout(_gxHostEditTimer);
        var ok = _gxSendToHost('ginexys:save');
        if (typeof showToast === 'function') {
            showToast(ok ? 'Saved to file' : 'Nothing to save yet', ok ? 'success' : 'error');
        }
        return ok;
    };

    // saveCurrentState is the common commit point for table mutations. Mirror
    // those mutations into VS Code without writing the file on every click.
    // Host-originated re-parses set _gxApplyingHostUpdate to prevent a loop.
    if (window.CwsBridge?.isEmbedded && typeof window.saveCurrentState === 'function') {
        var _gxOriginalSaveCurrentState = window.saveCurrentState;
        window.saveCurrentState = function () {
            var result = _gxOriginalSaveCurrentState.apply(this, arguments);
            if (!_gxApplyingHostUpdate) {
                clearTimeout(_gxHostEditTimer);
                _gxHostEditTimer = setTimeout(function () {
                    _gxSendToHost('ginexys:edit');
                }, 150);
            }
            return result;
        };
    }

    // Ctrl/Cmd+S inside the webview saves to the real file. VS Code's own save
    // keybinding does not reach a custom editor's webview, so without this there
    // is no way to write from the tool at all.
    if (window.CwsBridge?.isEmbedded) {
        window.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                window.__gxSaveToHost();
            }
        });
    }


    // AI layer: OCR-transcribed table arrives from the OS shell's AI panel
    // (win-ipc-panel AI view → backend /api/v1/ai/ocr → CSV). New sheet per import.
    window.addEventListener('message', function (e) {
        if (e.origin !== window.location.origin) { return; }
        if (e.data?.type !== 'gx:ai-ocr-table' || typeof e.data.csv !== 'string') { return; }
        if (typeof parseCsvInput !== 'function' || typeof addSheet !== 'function') { return; }
        var rawHtml;
        try { rawHtml = parseCsvInput(e.data.csv.trim()); } catch (err) { return; }
        if (!rawHtml) { return; }
        addSheet(e.data.name ? 'OCR — ' + e.data.name : 'OCR import', rawHtml);
    });

    // AI layer: content requests + validated op application from the OS shell.
    // gx:ai-get-context → reply with the active table as grid + TSV text.
    // gx:ai-apply-ops   → execute ops the backend verifier accepted (user confirmed
    // them in the shell's mini modal). Structural ops only; unknown ops are skipped.
    window.addEventListener('message', function (e) {
        if (e.origin !== window.location.origin || !e.data) { return; }

        if (e.data.type === 'gx:ai-get-context') {
            var ctxTable = window.currentTable || $('#tableContainer table')[0];
            var grid = null, text = '';
            if (ctxTable) {
                grid = Array.from(ctxTable.rows, function (row) {
                    return Array.from(row.cells, function (cell) { return cell.innerText.trim(); });
                });
                text = grid.map(function (r) { return r.join('\t'); }).join('\n');
            }
            // Sheet list + active sheet + mode so the AI can resolve @Sheet and
            // /mode references the user types in the prompt. Sheets already carry
            // stable ids (sheet-N); dims are read from each sheet's html.
            var sheets = (window.sheets || []).map(function (s) {
                var dims = '';
                try {
                    var tmp = document.createElement('div');
                    tmp.innerHTML = s.rawHtml || s.containerHtml || '';
                    var t = tmp.querySelector('table');
                    if (t) dims = t.rows.length + '×' + ((t.rows[0] && t.rows[0].cells.length) || 0);
                } catch (_) { /* dims best-effort */ }
                return { id: s.id, name: s.name, dims: dims };
            });
            var mode = window.labModeEnabled ? 'lab'
                : window.nodeEditorEnabled ? 'node' : 'table';
            e.source.postMessage({
                type: 'gx:ai-context',
                requestId: e.data.requestId,
                payload: {
                    text: text, grid: grid,
                    sheets: sheets, activeSheet: window.activeSheetId, mode: mode,
                },
            }, e.origin);
            return;
        }

        if (e.data.type === 'gx:ai-apply-ops' && Array.isArray(e.data.ops)) {
            // create_table
            var createOp = null;
            for (var ci = 0; ci < e.data.ops.length; ci++) {
                if (e.data.ops[ci].op === 'create_table') { createOp = e.data.ops[ci]; break; }
            }
            if (createOp) {
                if (typeof window.createNewTable === 'function') {
                    window.createNewTable(createOp.rows, createOp.cols);
                }
            }
            var table = window.currentTable || $('#tableContainer table')[0];
            if (!table) { return; }
            var skipped = 0;
            e.data.ops.forEach(function (op) {
                if (op.op === 'create_table') return;
                try {
                    var rows = table.rows;
                    var cols = rows[0] ? rows[0].cells.length : 0;
                    if (op.op === 'set_cell' && rows[op.row] && rows[op.row].cells[op.col]) {
                        rows[op.row].cells[op.col].innerText = op.text;
                    } else if (op.op === 'add_row') {
                        var tr = table.insertRow(Math.min(op.index, rows.length));
                        for (var i = 0; i < cols; i++) { tr.insertCell(-1); }
                    } else if (op.op === 'delete_row' && rows[op.index]) {
                        table.deleteRow(op.index);
                    } else if (op.op === 'add_column') {
                        Array.prototype.forEach.call(rows, function (row) {
                            row.insertCell(Math.min(op.index, row.cells.length));
                        });
                    } else if (op.op === 'delete_column') {
                        Array.prototype.forEach.call(rows, function (row) {
                            if (row.cells[op.index]) { row.deleteCell(op.index); }
                        });
                    } else if (op.op === 'merge_cells') {
                        var sr = Math.max(0, op.start_row), sc = Math.max(0, op.start_col);
                        var er = Math.min(rows.length - 1, op.end_row), ec = Math.min(cols - 1, op.end_col);
                        if (sr >= er && sc >= ec) { skipped++; return; }
                        var anchor = rows[sr].cells[sc];
                        var rowSpan = er - sr + 1, colSpan = ec - sc + 1;
                        for (var r = sr; r <= er; r++) {
                            for (var c = sc; c <= ec; c++) {
                                if (r === sr && c === sc) continue;
                                var cell = rows[r].cells[sc];
                                if (cell) cell.remove();
                            }
                        }
                        anchor.rowSpan = rowSpan;
                        anchor.colSpan = colSpan;
                    } else if (op.op === 'move_row') {
                        var fromR = op.from_index, toR = op.to_index;
                        if (fromR === toR || fromR < 0 || fromR >= rows.length || toR < 0) { skipped++; return; }
                        var targetIdx = Math.min(toR, rows.length - 1);
                        var movedRow = table.rows[fromR];
                        if (!movedRow) { skipped++; return; }
                        var newRow = movedRow.cloneNode(true);
                        table.deleteRow(fromR);
                        var insertAt = targetIdx > fromR ? targetIdx - 1 : targetIdx;
                        var refRow = table.rows[insertAt];
                        if (refRow) {
                            refRow.parentNode.insertBefore(newRow, refRow);
                        } else {
                            table.appendChild(newRow);
                        }
                    } else if (op.op === 'move_column') {
                        var fromC = op.from_index, toC = op.to_index;
                        if (fromC === toC || fromC < 0 || fromC >= cols || toC < 0) { skipped++; return; }
                        var targetC = Math.min(toC, cols - 1);
                        Array.prototype.forEach.call(rows, function (row) {
                            if (!row.cells[fromC]) return;
                            var cell = row.cells[fromC];
                            var cellHtml = cell.innerHTML;
                            cell.remove();
                            var insertAt = targetC > fromC ? targetC - 1 : targetC;
                            var ref = row.cells[insertAt];
                            if (ref) {
                                ref.insertAdjacentHTML('beforebegin', '<td>' + cellHtml + '</td>');
                            } else {
                                row.insertCell(-1).innerHTML = cellHtml;
                            }
                        });
                    } else {
                        skipped++;
                    }
                } catch (err) { skipped++; }
            });
            if (typeof window.saveCurrentState === 'function') { window.saveCurrentState(); }
            if (typeof showToast === 'function') {
                showToast('AI ops applied' + (skipped ? ' (' + skipped + ' skipped)' : ''), 'success');
            }
        }
    });

    // Live sync from VS Code text editor → table re-render.
    // Updates sheets in-place so we never call addSheet() on every keystroke
    // (which would create thousands of tabs).
    if (window.CwsBridge?.isEmbedded) {
        // Preview → source: every HTML element that came from the opened file
        // carries its original character range. Clicking it reveals that range
        // in the native VS Code editor.
        document.addEventListener('click', function (e) {
            var el = e.target?.closest?.('[data-gx-source-start][data-gx-source-end]');
            if (!el || !el.closest('#tableContainer')) return;
            var start = Number(el.getAttribute('data-gx-source-start'));
            var end = Number(el.getAttribute('data-gx-source-end'));
            if (!Number.isInteger(start) || !Number.isInteger(end)) return;
            window.CwsBridge.send('ginexys:reveal-source', { start: start, end: end });
        });

        var _gxHostHandlers = {
            'ginexys:document-changed': function (payload) {
                _gxApplyingHostUpdate = true;
                try {
                    ginexysUpdateSheets(payload.sheets);
                } finally {
                    _gxApplyingHostUpdate = false;
                }
            },

            // Refresh ranges after a visual edit changed source length. Browser
            // parsers may insert implicit elements such as <tbody>, so match by
            // tag in order and skip elements that have no source token.
            'ginexys:source-ranges': function (payload) {
                var elements = Array.from(document.querySelectorAll('#tableContainer table, #tableContainer table *'));
                elements.forEach(function (el) {
                    el.removeAttribute('data-gx-source-start');
                    el.removeAttribute('data-gx-source-end');
                });
                var cursor = 0;
                (payload?.ranges || []).forEach(function (range) {
                    var tag = String(range.tag || '').toLowerCase();
                    while (cursor < elements.length && elements[cursor].tagName.toLowerCase() !== tag) cursor++;
                    if (cursor >= elements.length) return;
                    elements[cursor].setAttribute('data-gx-source-start', String(range.start));
                    elements[cursor].setAttribute('data-gx-source-end', String(range.end));
                    cursor++;
                });
            },

            // Source → preview: highlight the smallest mapped element containing
            // the native editor's cursor/selection and bring it into view.
            'ginexys:select-source': function (payload) {
                document.querySelectorAll('.gx-vscode-source-selected').forEach(function (el) {
                    el.classList.remove('gx-vscode-source-selected');
                });
                (payload?.selections || []).forEach(function (selection) {
                    var best = null, bestSpan = Infinity;
                    document.querySelectorAll('#tableContainer [data-gx-source-start][data-gx-source-end]').forEach(function (el) {
                        var start = Number(el.getAttribute('data-gx-source-start'));
                        var end = Number(el.getAttribute('data-gx-source-end'));
                        if (start <= selection.start && selection.end <= end && end - start < bestSpan) {
                            best = el;
                            bestSpan = end - start;
                        }
                    });
                    if (best) {
                        best.classList.add('gx-vscode-source-selected');
                        best.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                    }
                });
            }
        };

        window.addEventListener('message', function (e) {
            _gxHostHandlers[e.data?.type]?.(e.data.payload || {});
        });

        if (!document.getElementById('gx-vscode-source-style')) {
            var sourceStyle = document.createElement('style');
            sourceStyle.id = 'gx-vscode-source-style';
            sourceStyle.textContent = '.gx-vscode-source-selected{outline:2px solid #007acc!important;outline-offset:2px!important}';
            document.head.appendChild(sourceStyle);
        }
    }

    function ginexysUpdateSheets(sheetsData) {
        if (!sheetsData || !sheetsData.length) { return; }

        var parsers = {
            'csv':      typeof parseCsvInput      === 'function' ? parseCsvInput      : null,
            'html':     typeof parseHtmlInput     === 'function' ? parseHtmlInput     : null,
            'json':     typeof parseJsonInput     === 'function' ? parseJsonInput     : null,
            'markdown': typeof parseMarkdownInput === 'function' ? parseMarkdownInput : null,
            'sql':      typeof parseSqlInput      === 'function' ? parseSqlInput      : null,
            'text':     typeof parseTextInput     === 'function' ? parseTextInput     : null,
        };

        sheetsData.forEach(function (data, i) {
            var parser = parsers[data.format] || parsers['csv'];
            if (!parser || !data.content.trim()) { return; }

            var rawHtml;
            try { rawHtml = parser(data.content.trim()); } catch (err) { return; }
            if (!rawHtml) { return; }

            if (i < window.sheets.length) {
                // Patch existing sheet — no new tab created
                var sheet = window.sheets[i];
                sheet.name   = data.name || sheet.name;
                sheet.rawHtml = rawHtml;
                sheet.containerHtml = null; // force re-render on next activate

                if (sheet.id === window.activeSheetId) {
                    window.lastParsedHtml = rawHtml;
                    if (typeof generateTabs === 'function')         { generateTabs(rawHtml); }
                    window.currentTable = $('#tableContainer table')[0] || null;
                    if (typeof initializeAllFeatures === 'function') { initializeAllFeatures(); }
                    if (typeof setupTableInteraction === 'function') { setupTableInteraction(); }
                    if (typeof window.saveCurrentState === 'function') { window.saveCurrentState(); }
                    if (typeof renderSheetTabs === 'function')       { renderSheetTabs(); }
                }
            } else {
                // Extra sheet from new fenced block — push directly, skip addSheet()
                if (window.activeSheetId !== null && typeof _saveActiveSheetState === 'function') {
                    _saveActiveSheetState();
                }
                var id = 'sheet-' + (++window._sheetCounter);
                window.sheets.push({ id: id, name: data.name || ('Sheet ' + window._sheetCounter), rawHtml: rawHtml, containerHtml: null });
                window.lastParsedHtml = rawHtml;
                if (typeof renderSheetTabs === 'function') { renderSheetTabs(); }
            }
        });

        // Remove sheets that no longer have a corresponding fenced block
        while (window.sheets.length > sheetsData.length) {
            var last = window.sheets[window.sheets.length - 1];
            if (last.id !== window.activeSheetId && typeof deleteSheet === 'function') {
                deleteSheet(last.id);
            } else {
                break; // active sheet is the last one — leave it
            }
        }
    }

    // Mode routing: switch to the requested mode after the tool finishes initializing.
    // Source priority: __GINEXYS_INITIAL_MODE__ (VS Code extension injects) > ?view= (web OS deep link).
    // Accepted slugs: 'node-editor' (alias: 'node'), 'lab' (alias: 'lab-mode'),
    // 'equation' (aliases: 'equation-mode', 'math'), 'table' / 'table-mode' /
    // 'draw' / 'draw-mode' (no-op — default).
    var _viewQuery = new URLSearchParams(location.search).get('view');
    var _viewAlias = { 'node': 'node-editor', 'lab-mode': 'lab', 'table-mode': 'table', 'draw-mode': 'draw',
                       'equation-mode': 'equation', 'math': 'equation' };
    if (!window.__GINEXYS_INITIAL_MODE__ && _viewQuery) {
        window.__GINEXYS_INITIAL_MODE__ = _viewAlias[_viewQuery] || _viewQuery;
    }
    if (window.__GINEXYS_INITIAL_MODE__) {
        var _mode = window.__GINEXYS_INITIAL_MODE__;
        setTimeout(function () {
            if (_mode === 'node-editor' && typeof enableNodeEditor === 'function') {
                enableNodeEditor();
            } else if (_mode === 'lab' && typeof toggleLab === 'function') {
                if (!window.labModeEnabled) toggleLab();
            } else if (_mode === 'equation' && typeof enableEquationEditor === 'function') {
                enableEquationEditor();
            }
        }, 150);
    }
});
