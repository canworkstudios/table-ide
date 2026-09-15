// js/features/tableOperations.js

// ====================================== ADD & DELETE FUNCTIONALITY ================================================

// Global clipboard for copy/paste
window.tableIdeClipboard = null;

// Capture a selection as a visual matrix, not as a DOM-order list.  A cell is
// stored once at its origin together with its relative position and span, so a
// 2x3 range remains a 2x3 range after table reparses and repeated pastes.
function _serializeSelectedMatrix() {
    const mapper = new window.VisualGridMapper(window.currentTable);
    const positions = window.selectedCells.map(cell => ({ cell, pos: mapper.getVisualPosition(cell) })).filter(x => x.pos);
    if (!positions.length) return null;
    const minRow = Math.min(...positions.map(x => x.pos.startRow));
    const minCol = Math.min(...positions.map(x => x.pos.startCol));
    const maxRow = Math.max(...positions.map(x => x.pos.startRow + x.pos.rowspan - 1));
    const maxCol = Math.max(...positions.map(x => x.pos.startCol + x.pos.colspan - 1));
    const selected = new Set(positions.map(x => x.cell));

    // Spreadsheet copy is rectangular. Expand a lasso/row selection to its
    // bounding rectangle so the clipboard has deterministic dimensions.
    const cells = [];
    const seen = new Set();
    for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
            const slot = mapper.grid[r] && mapper.grid[r][c];
            if (!slot || seen.has(slot.element)) continue;
            seen.add(slot.element);
            const pos = mapper.getVisualPosition(slot.element);
            cells.push({
                row: pos.startRow - minRow,
                col: pos.startCol - minCol,
                rowspan: pos.rowspan,
                colspan: pos.colspan,
                html: slot.element.outerHTML,
                text: $(slot.element).text()
            });
        }
    }
    return { version: 2, rows: maxRow - minRow + 1, cols: maxCol - minCol + 1, cells };
}

function _matrixAsTsv(matrix) {
    const values = Array.from({ length: matrix.rows }, () => Array(matrix.cols).fill(''));
    matrix.cells.forEach(cell => { values[cell.row][cell.col] = cell.text; });
    return values.map(row => row.join('\t')).join('\n');
}

// A paste is also a request for a destination range.  New sheets begin as a
// small table, but a spreadsheet does not make the user pre-size it before
// pasting a copied matrix, so grow to fit.
//
// This used to refuse whenever the table contained ANY merge, anywhere. That
// was a scope error: growing appends <td>s at the right/bottom EDGE, which a
// merge elsewhere cannot affect — a colspan in row 0 blocked appending a column
// at the far right, which it has nothing to do with. VisualGridMapper.buildGrid
// walks past occupied slots (`while (grid[r][c] !== undefined) c++`), so the
// rebuilt matrix absorbs the new cells correctly even through merges and
// rowspans dangling down from earlier rows.
function _growTableForMatrix(anchor, matrix) {
    let mapper = new window.VisualGridMapper(window.currentTable);
    const pos = mapper.getVisualPosition(anchor);
    if (!pos) return null;

    const neededRows = pos.startRow + matrix.rows;
    const neededCols = pos.startCol + matrix.cols;
    if (neededRows <= mapper.maxRows && neededCols <= mapper.maxCols) return mapper;

    const rows = Array.from(window.currentTable.querySelectorAll('tr'));
    const extraCols = Math.max(0, neededCols - mapper.maxCols);
    rows.forEach(function (row) {
        const tag = row.querySelector('th') && !row.querySelector('td') ? 'th' : 'td';
        for (let c = 0; c < extraCols; c++) row.appendChild(document.createElement(tag));
    });
    for (let r = mapper.maxRows; r < neededRows; r++) {
        const row = document.createElement('tr');
        for (let c = 0; c < Math.max(mapper.maxCols, neededCols); c++) row.appendChild(document.createElement('td'));
        window.currentTable.appendChild(row);
    }
    return new window.VisualGridMapper(window.currentTable);
}

// Free every slot the paste rectangle lands on, by unmerging ONLY the merges
// that intersect that rectangle.
//
// A copied a x b matrix needs b addressable origins per row. Where the
// destination holds a merged cell, those coordinates are continuation slots
// that cannot be written without corrupting geometry — which is why this used
// to be refused outright.
//
// Unmerging just the blockers is the surgical version: the merge in the path
// gives up its span, every merge outside the path is untouched. Flattening the
// whole table would also work mechanically, but it destroys structure the user
// never targeted — banner titles, grouped headers, row stubs — which in a tool
// for forensically reconstructed tables IS the extracted meaning.
//
// Freed columns are padded so the row keeps its width. Without the padding the
// grid goes ragged and the NEXT operation faces a worse table than this one did.
//
// Returns a fresh mapper, or null if nothing needed changing.
function _unmergeRect(mapper, minRow, minCol, rows, cols) {
    const maxRow = minRow + rows - 1;
    const maxCol = minCol + cols - 1;

    // Collect the distinct merged elements intersecting the rectangle.
    const blockers = new Set();
    for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
            const slot = mapper.grid[r] && mapper.grid[r][c];
            if (!slot) continue;
            const pos = mapper.getVisualPosition(slot.element);
            if (pos && (pos.rowspan > 1 || pos.colspan > 1)) blockers.add(slot.element);
        }
    }
    if (!blockers.size) return null;

    blockers.forEach(el => {
        const pos = mapper.getVisualPosition(el);
        if (!pos) return;
        const $el = $(el);
        const tag = el.tagName.toLowerCase();

        // Drop the span first so the freed coordinates are real slots again.
        $el.removeAttr('colspan').removeAttr('rowspan');

        // Pad the columns this cell used to cover on its own row...
        for (let c = 1; c < pos.colspan; c++) {
            $el.after(document.createElement(tag));
        }

        // ...and the rows it used to hang into. A rowspan cannot be shortened
        // without the rows below gaining a cell, so this necessarily touches
        // coordinates outside the rectangle — unavoidable geometry, not a
        // choice. The padding goes at the same visual column the span occupied.
        const tableRows = Array.from(window.currentTable.querySelectorAll('tr'));
        for (let r = 1; r < pos.rowspan; r++) {
            const row = tableRows[pos.startRow + r];
            if (!row) continue;
            for (let c = 0; c < pos.colspan; c++) {
                const pad = document.createElement(tag);
                // Place at the span's visual column by counting real cells.
                const ref = row.children[Math.min(pos.startCol + c, row.children.length)];
                if (ref) row.insertBefore(pad, ref);
                else     row.appendChild(pad);
            }
        }
    });

    return new window.VisualGridMapper(window.currentTable);
}

function _pasteMatrixAt(target) {
    const matrix = window.tableIdeClipboard;
    if (!matrix || matrix.version !== 2) return false;
    let mapper = new window.VisualGridMapper(window.currentTable);
    let anchor = mapper.getVisualPosition(target);
    if (!anchor) return false;
    if (anchor.startRow + matrix.rows > mapper.maxRows || anchor.startCol + matrix.cols > mapper.maxCols) {
        mapper = _growTableForMatrix(target, matrix);
        if (!mapper) return false;
        anchor = mapper.getVisualPosition(target);
    }

    // Save BEFORE any structural change, so undo reverses the unmerge and the
    // paste together as one step rather than leaving a half-applied table.
    window.saveCurrentState();

    // Clear merges out of the destination rectangle instead of refusing it.
    // Copied merged cells are still recreated exactly by the write below.
    const freed = _unmergeRect(mapper, anchor.startRow, anchor.startCol, matrix.rows, matrix.cols);
    if (freed) {
        mapper = freed;
        anchor = mapper.getVisualPosition(target);
        if (!anchor) return false;
    }

    const targets = [];
    for (let r = 0; r < matrix.rows; r++) {
        for (let c = 0; c < matrix.cols; c++) {
            const slot = mapper.grid[anchor.startRow + r] && mapper.grid[anchor.startRow + r][anchor.startCol + c];
            // After _unmergeRect every coordinate in the rectangle should be an
            // origin. If one still is not, the geometry is beyond what this can
            // safely resolve, so stop rather than corrupt the table.
            if (!slot || !slot.isOrigin) {
                $.toast({ heading: 'Paste', text: 'That destination could not be cleared for this matrix.', icon: 'warning', loader: false, stack: false });
                return false;
            }
            targets.push(slot.element);
        }
    }
    const consumed = new Set();
    matrix.cells.forEach(cell => {
        const index = cell.row * matrix.cols + cell.col;
        const $clone = $(cell.html).first();
        $(targets[index]).replaceWith($clone);
        for (let rr = 0; rr < cell.rowspan; rr++) {
            for (let cc = 0; cc < cell.colspan; cc++) {
                if (rr || cc) consumed.add((cell.row + rr) * matrix.cols + cell.col + cc);
            }
        }
    });
    // Remove cells covered by a recreated rowspan/colspan, from the end so DOM
    // indices do not shift under earlier removals.
    [...consumed].sort((a, b) => b - a).forEach(i => $(targets[i]).remove());
    window.saveCurrentState();
    window.setupTableInteraction();
    return true;
}

function duplicateElement() {
    if (window.selectedCells.length === 0) {
        $.toast({ heading: 'Info', text: 'Please select a cell.', icon: 'warning', loader: false, stack: false });
        return;
    }
    const type = $('#elementType').val();
    if (!type || !['cell', 'row', 'column'].includes(type)) {
        $.toast({ heading: 'Info', text: 'Please select Cell, Row, or Column in the element type dropdown first.', icon: 'warning', loader: false, stack: false });
        return;
    }

    if (type === 'cell') {
        window.selectedCells.forEach(cell => {
            $(cell).after($(cell).clone());
        });
    } else if (type === 'row') {
        const uniqueRows = new Set();
        window.selectedCells.forEach(cell => uniqueRows.add($(cell).parent()[0]));
        uniqueRows.forEach(row => {
            $(row).after($(row).clone());
        });
    } else if (type === 'column') {
        const uniqueCols = new Set();
        const mapper = new window.VisualGridMapper(currentTable);

        window.selectedCells.forEach(cell => {
            const pos = mapper.getVisualPosition(cell);
            if (pos) uniqueCols.add(pos.startCol);
        });

        uniqueCols.forEach(colIndex => {
            for (let r = 0; r < mapper.maxRows; r++) {
                if (mapper.grid[r] && mapper.grid[r][colIndex]) {
                    const cellData = mapper.grid[r][colIndex];
                    if (cellData.isOrigin) {
                        $(cellData.element).after($(cellData.element).clone());
                    }
                }
            }
        });
    }

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: 'Duplicated ' + type + '(s)',
        icon: 'success',
        loader: false,
        stack: false
    });
    window.setupTableInteraction();
}

function copySelected() {
    if (window.selectedCells.length === 0) {
        $.toast({ heading: 'Info', text: 'Please select a cell.', icon: 'warning', loader: false, stack: false });
        return;
    }
    window.tableIdeClipboard = _serializeSelectedMatrix();
    if (!window.tableIdeClipboard) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(_matrixAsTsv(window.tableIdeClipboard)).catch(function () {});
    }
    $.toast({
        heading: 'Copied',
        text: window.tableIdeClipboard.rows + ' × ' + window.tableIdeClipboard.cols + ' matrix copied',
        icon: 'info',
        loader: false,
        stack: false
    });
}

function pasteBefore() {
    if (window.selectedCells.length === 0 || !window.tableIdeClipboard) return;

    if (window.tableIdeClipboard.version === 2) {
        if (_pasteMatrixAt(window.selectedCells[0])) $.toast({ heading: 'Pasted', text: 'Matrix pasted at the active cell', icon: 'success', loader: false, stack: false });
        return;
    }

    // Reverse-iterate the clipboard when inserting before so the first copied
    // cell ends up directly before the target (each insert shifts subsequent ones right).
    window.selectedCells.forEach(target => {
        for (let i = window.tableIdeClipboard.length - 1; i >= 0; i--) {
            $(target).before(window.tableIdeClipboard[i]);
        }
    });

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: 'Pasted before cell(s)',
        icon: 'success',
        loader: false,
        stack: false
    });
    window.setupTableInteraction();
}

function pasteAfter() {
    if (window.selectedCells.length === 0 || !window.tableIdeClipboard) return;

    if (window.tableIdeClipboard.version === 2) {
        if (_pasteMatrixAt(window.selectedCells[0])) $.toast({ heading: 'Pasted', text: 'Matrix pasted at the active cell', icon: 'success', loader: false, stack: false });
        return;
    }

    // Forward-iterate: insert each clipboard item after the previous insertion point
    // so items appear in the same order as they were copied.
    window.selectedCells.forEach(target => {
        let insertAfter = $(target);
        for (let i = 0; i < window.tableIdeClipboard.length; i++) {
            const $newCell = $(window.tableIdeClipboard[i]);
            insertAfter.after($newCell);
            insertAfter = $newCell; // advance anchor so next cell goes after this one
        }
    });

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: 'Pasted after cell(s)',
        icon: 'success',
        loader: false,
        stack: false
    });
    window.setupTableInteraction();
}

// Add Cell functionality
function addCell() {
    if (window.selectedCells.length === 0) {
        $.toast({ heading: 'Info', text: 'Please select a cell.', icon: 'warning', loader: false, stack: false });
        return;
    }

    // Insert a new cell after each selected cell
    window.selectedCells.forEach(cell => {
        const $selectedCell = $(cell);
        const tagName = $selectedCell.prop('tagName').toLowerCase();
        const $newCell = $(`<${tagName}></${tagName}>`);
        $selectedCell.after($newCell);
    });

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: window.selectedCells.length > 1 ? `${window.selectedCells.length} cells added` : 'Cell added',
        icon: 'success',
        loader: false,
        stack: false
    });

    // Reinitialize features
    window.setupTableInteraction();
}

function addCellBefore() {
    if (window.selectedCells.length === 0) {
        $.toast({ heading: 'Info', text: 'Please select a cell.', icon: 'warning', loader: false, stack: false });
        return;
    }

    // Insert a new cell before each selected cell
    window.selectedCells.forEach(cell => {
        const $selectedCell = $(cell);
        const tagName = $selectedCell.prop('tagName').toLowerCase();
        const $newCell = $(`<${tagName}></${tagName}>`);
        $selectedCell.before($newCell);
    });

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: window.selectedCells.length > 1 ? `${window.selectedCells.length} cells added` : 'Cell added',
        icon: 'success',
        loader: false,
        stack: false
    });

    // Reinitialize features
    window.setupTableInteraction();
}


function deleteCell() {
    if (window.selectedCells.length === 0) {
        $.toast({ heading: 'Info', text: 'Please select a cell.', icon: 'warning', loader: false, stack: false });
        return;
    }

    // A spreadsheet delete clears values; structural deletion belongs to the
    // explicit row and column commands. Keeping the td/th also preserves spans,
    // sizing, styles, ruler coordinates, and the rectangular grid.
    window.selectedCells.forEach(cell => {
        $(cell).empty();
    });

    // Clear selection
    window.selectedCells = [];

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: 'Cell content cleared',
        icon: 'success',
        loader: false,
        stack: false
    });

    // Reinitialize features
    window.setupTableInteraction();
}

function deleteRows() {
    if (window.selectedCells.length === 0) {
        $.toast({ heading: 'Info', text: 'Please select a row.', icon: 'warning', loader: false, stack: false });
        return;
    }

    const table = window.currentTable;

    // Get unique rows from selected cells
    const rows = new Set();
    window.selectedCells.forEach(cell => {
        rows.add($(cell).parent()[0]);
    });

    // Disconnect ruler observer before mutating so it doesn't race with renderTableRulers
    if (table && table._tableIdeStructObs) table._tableIdeStructObs.disconnect();

    // Remove each row
    rows.forEach(row => {
        $(row).remove();
    });

    // Clear selection
    window.selectedCells = [];

    // A rowspan reaching into a deleted row leaves the surviving rows uneven,
    // so square the table up here too.
    if (typeof window.normalizeGrid === 'function') window.normalizeGrid(table);

    // Snapshot AFTER mutation so each user action gets a distinct undo slot
    // (the dedup check in saveCurrentState would otherwise collapse this with
    //  the previous post-mutation snapshot).
    if (typeof window.saveCurrentState === 'function') window.saveCurrentState();

    $.toast({
        heading: 'Success',
        text: 'Row(s) deleted',
        icon: 'success',
        loader: false,
        stack: false
    });

    // Rebuild ruler immediately, then re-init interaction
    if (table && typeof window.renderTableRulers === 'function') {
        window.renderTableRulers(table);
    }
    window.setupTableInteraction();
}

function deleteColumns() {
    if (!window.currentTable) return;

    const table = window.currentTable;
    const $table = $(table);
    const mapper = new VisualGridMapper($table);

    // Get unique visual columns from selected cells
    const columns = new Set();
    window.selectedCells.forEach(cell => {
        const position = mapper.getVisualPosition(cell);
        if (position) {
            columns.add(position.startCol);
        }
    });

    // Sort descending so removing right-to-left doesn't shift indices
    const colsArray = Array.from(columns).sort((a, b) => b - a);

    // Disconnect ruler observer before mutating so it doesn't race with renderTableRulers
    if (table._tableIdeStructObs) table._tableIdeStructObs.disconnect();

    // Remove a cell ONLY when it lies entirely inside the deleted columns;
    // when it merely spans across one, shrink its colspan instead.
    //
    // This used to delete whatever getCellsInColumn returned, which for a
    // spanning cell is a cell that also occupies OTHER columns — so deleting
    // column 0 of a table whose first row held a colspan=2 took column 1's
    // content from that row too and left the row one cell short. That is the
    // single biggest source of the ragged "tetris" shape: the table stopped
    // being rectangular because a structural op was not span-aware.
    //
    // The delete set is resolved against ONE mapper snapshot taken before any
    // mutation, so indices stay meaningful while the DOM changes underneath.
    const doomed = new Set(colsArray);
    const handled = new Set();

    colsArray.forEach(colIndex => {
        mapper.getCellsInColumn(colIndex).forEach(cell => {
            if (handled.has(cell)) return;      // a spanning cell is reachable from several columns
            handled.add(cell);

            const pos = mapper.getVisualPosition(cell);
            if (!pos) { $(cell).remove(); return; }

            // How many of this cell's columns are being deleted?
            let covered = 0;
            for (let c = pos.startCol; c < pos.startCol + pos.colspan; c++) {
                if (doomed.has(c)) covered++;
            }

            if (covered >= pos.colspan) {
                $(cell).remove();               // wholly inside the deletion
            } else {
                const left = pos.colspan - covered;
                if (left > 1) $(cell).attr('colspan', left);
                else          $(cell).removeAttr('colspan');
            }
        });
    });

    // Clear selection
    window.selectedCells = [];

    // Square the table up. Deleting a column can still leave rows uneven when
    // spans overlap the boundary in different ways per row; the invariant is
    // enforced in one place rather than re-derived by every caller.
    if (typeof window.normalizeGrid === 'function') window.normalizeGrid(table);

    // Snapshot AFTER mutation so each user action gets a distinct undo slot
    // (the dedup check in saveCurrentState would otherwise collapse this with
    //  the previous post-mutation snapshot).
    if (typeof window.saveCurrentState === 'function') window.saveCurrentState();

    $.toast({
        heading: 'Success',
        text: 'Column(s) deleted',
        icon: 'success',
        loader: false,
        stack: false
    });

    // Rebuild ruler immediately, then re-init interaction
    if (typeof window.renderTableRulers === 'function') {
        window.renderTableRulers(table);
    }
    window.setupTableInteraction();
}

function addRow() {
    if (!window.currentTable || window.selectedCells.length === 0) return;

    const $table = $(window.currentTable);
    const selectedCell = window.selectedCells[0];
    const $selectedRow = $(selectedCell).closest('tr');
    // Use VisualGridMapper so colspan/rowspan is accounted for in the visual column count
    const colCount = new VisualGridMapper($table).maxCols;

    let newRowHtml = '<tr>';
    for (let i = 0; i < colCount; i++) {
        newRowHtml += '<td></td>';
    }
    newRowHtml += '</tr>';

    // Insert the new row after the selected row
    $selectedRow.after(newRowHtml);

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: 'Row added',
        icon: 'success',
        loader: false,
        stack: false
    });

    window.setupTableInteraction();
}

function addRowBefore() {
    if (!window.currentTable || window.selectedCells.length === 0) return;

    const $table = $(window.currentTable);
    const selectedCell = window.selectedCells[0];
    const $selectedRow = $(selectedCell).closest('tr');
    // Use VisualGridMapper so colspan/rowspan is accounted for in the visual column count
    const colCount = new VisualGridMapper($table).maxCols;

    let newRowHtml = '<tr>';
    for (let i = 0; i < colCount; i++) {
        newRowHtml += '<td></td>';
    }
    newRowHtml += '</tr>';

    // Insert the new row before the selected row
    $selectedRow.before(newRowHtml);

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: 'Row added',
        icon: 'success',
        loader: false,
        stack: false
    });

    window.setupTableInteraction();
}

function addColumn() {
    if (!window.currentTable || window.selectedCells.length === 0) return;

    const $table = $(window.currentTable);
    const selectedCell = window.selectedCells[0];
    const mapper = new VisualGridMapper($table);

    // Use visual position — raw .index() breaks when colspan/rowspan shift physical positions
    const position = mapper.getVisualPosition(selectedCell);
    if (!position) return;
    // Insert after the last visual column this cell occupies
    const targetVisualCol = position.startCol + position.colspan - 1;

    // For each visual row, find the last physical cell that occupies targetVisualCol and insert after it
    for (let rowIdx = 0; rowIdx < mapper.maxRows; rowIdx++) {
        const rowGrid = mapper.grid[rowIdx];
        if (!rowGrid) continue;
        const gridCell = rowGrid[targetVisualCol];
        if (!gridCell) continue;
        // Only insert once per origin cell (avoid duplicates for rowspan)
        if (!gridCell.isOrigin) continue;
        const $cell = $(gridCell.element);
        const tagName = $cell.prop('tagName').toLowerCase();
        $cell.after(`<${tagName}></${tagName}>`);
    }

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: 'Column added',
        icon: 'success',
        loader: false,
        stack: false
    });

    window.setupTableInteraction();
}

function addColumnBefore() {
    if (!window.currentTable || window.selectedCells.length === 0) return;

    const $table = $(window.currentTable);
    const selectedCell = window.selectedCells[0];
    const mapper = new VisualGridMapper($table);

    // Use visual position — raw .index() breaks when colspan/rowspan shift physical positions
    const position = mapper.getVisualPosition(selectedCell);
    if (!position) return;
    const targetVisualCol = position.startCol;

    // For each visual row, find the physical cell at targetVisualCol and insert before its origin
    for (let rowIdx = 0; rowIdx < mapper.maxRows; rowIdx++) {
        const rowGrid = mapper.grid[rowIdx];
        if (!rowGrid) continue;
        const gridCell = rowGrid[targetVisualCol];
        if (!gridCell) continue;
        // Only insert once per origin cell (avoid duplicates for rowspan)
        if (!gridCell.isOrigin) continue;
        const $cell = $(gridCell.element);
        const tagName = $cell.prop('tagName').toLowerCase();
        $cell.before(`<${tagName}></${tagName}>`);
    }

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: 'Column added',
        icon: 'success',
        loader: false,
        stack: false
    });

    window.setupTableInteraction();
}

function mergeCells() {
    if (window.selectedCells.length < 2) {
        $.toast({ heading: 'Info', text: 'Please select at least two adjacent cells to merge.', icon: 'warning', loader: false, stack: false });
        return;
    }

    // Use the VisualGridMapper to understand the table's structure
    const mapper = new VisualGridMapper(window.currentTable);

    // Get the visual position of each selected cell
    const selectionInfo = window.selectedCells.map(cell => ({
        cell: cell,
        pos: mapper.getVisualPosition(cell)
    })).filter(info => info.pos); // Ensure the cell was found in the map

    if (selectionInfo.length < 2) {
        $.toast({ heading: 'Info', text: 'Could not determine cell positions for merging. Try a simpler selection.', icon: 'warning', loader: false, stack: false });
        return;
    }

    // Sort cells by row, then by column, to easily find the top-left cell
    selectionInfo.sort((a, b) => {
        if (a.pos.startRow !== b.pos.startRow) {
            return a.pos.startRow - b.pos.startRow;
        }
        return a.pos.startCol - b.pos.startCol;
    });

    const firstCellInfo = selectionInfo[0];
    const $firstCell = $(firstCellInfo.cell);

    // Determine the merge direction by checking if all cells are in the same row or same column
    const uniqueRows = new Set(selectionInfo.map(info => info.pos.startRow));
    const uniqueCols = new Set(selectionInfo.map(info => info.pos.startCol));

    const isHorizontalMerge = uniqueRows.size === 1 && uniqueCols.size > 1;
    const isVerticalMerge   = uniqueCols.size === 1 && uniqueRows.size > 1;
    const isRectMerge       = uniqueRows.size > 1   && uniqueCols.size > 1;

    if (!isHorizontalMerge && !isVerticalMerge && !isRectMerge) {
        $.toast({ heading: 'Info', text: 'Merging is only supported for cells in a single continuous row or column.', icon: 'warning', loader: false, stack: false });
        return;
    }

    // ── Rectangular merge (multiple rows × multiple columns) ──────────────────
    if (isRectMerge) {
        const minRow = Math.min(...selectionInfo.map(i => i.pos.startRow));
        const maxRow = Math.max(...selectionInfo.map(i => i.pos.startRow));
        const minCol = Math.min(...selectionInfo.map(i => i.pos.startCol));
        const maxCol = Math.max(...selectionInfo.map(i => i.pos.startCol));
        const expected = (maxRow - minRow + 1) * (maxCol - minCol + 1);

        if (selectionInfo.some(i => i.pos.colspan > 1 || i.pos.rowspan > 1)) {
            $.toast({ heading: 'Info', text: 'Rectangular merge: unmerge all cells within the selection first.', icon: 'warning', loader: false, stack: false });
            return;
        }
        if (selectionInfo.length !== expected) {
            $.toast({ heading: 'Info', text: 'Rectangular merge: selection must form a complete rectangle.', icon: 'warning', loader: false, stack: false });
            return;
        }

        const allContent = [];
        const survivors  = [];

        // Phase A — collapse each row horizontally
        for (let r = minRow; r <= maxRow; r++) {
            const row = selectionInfo
                .filter(i => i.pos.startRow === r)
                .sort((a, b) => a.pos.startCol - b.pos.startCol);
            allContent.push(...row.map(i => $(i.cell).html()));
            for (let j = 1; j < row.length; j++) $(row[j].cell).remove();
            $(row[0].cell).attr('colspan', maxCol - minCol + 1);
            survivors.push(row[0].cell);
        }

        // Phase B — collapse survivors vertically into the top cell
        const $top = $(survivors[0]);
        $top.html(allContent.join(' '));
        $top.attr('rowspan', maxRow - minRow + 1);
        for (let i = 1; i < survivors.length; i++) $(survivors[i]).remove();

        window.selectedCells = [survivors[0]];
        $(window.currentTable).find('.selected-cell').removeClass('selected-cell');
        $top.addClass('selected-cell');
        window.saveCurrentState();
        $.toast({ heading: 'Success', text: 'Cells merged', icon: 'success', loader: false, stack: false });
        window.setupTableInteraction();
        return;
    }

    // --- Perform the merge ---
    let newColspan = firstCellInfo.pos.colspan;
    let newRowspan = firstCellInfo.pos.rowspan;
    let combinedContent = [$firstCell.html()];

    // Remove the other selected cells and accumulate their span and content
    for (let i = 1; i < selectionInfo.length; i++) {
        const info = selectionInfo[i];

        if (isHorizontalMerge) {
            newColspan += info.pos.colspan; // Add the colspan of the cell being merged
        }
        if (isVerticalMerge) {
            newRowspan += info.pos.rowspan; // Add the rowspan of the cell being merged
        }

        combinedContent.push($(info.cell).html());
        $(info.cell).remove(); // Remove the cell from the DOM
    }

    // Update the primary cell's content and span attributes
    $firstCell.html(combinedContent.join(' ')); // Combine content with a space

    if (isHorizontalMerge) {
        $firstCell.attr('colspan', newColspan);
    }
    if (isVerticalMerge) {
        $firstCell.attr('rowspan', newRowspan);
    }

    // Clean up: only the main merged cell should remain in the selection
    window.selectedCells = [firstCellInfo.cell];
    $(window.currentTable).find('.selected-cell').removeClass('selected-cell');
    $firstCell.addClass('selected-cell');

    window.saveCurrentState();
    $.toast({
        heading: 'Success',
        text: 'Cells merged',
        icon: 'success',
        loader: false,
        stack: false
    });

    // Re-initialize table interactions
    window.setupTableInteraction();
}

// ── Multi-cell Monaco editor ──────────────────────────────────────────────────
//
//   openMultiCellEdit()  — shows bounding-box cells in Monaco: newline = row, | = col
//   applyMultiCellEdit() — parses Monaco content back into cells

function openMultiCellEdit() {
    const cells = window.selectedCells;
    if (!cells || cells.length < 2) return;
    const table = window.currentTable;
    if (!table) return;

    const mapper = new VisualGridMapper(table);
    const posMap = new Map();
    let minRow = Infinity, maxRow = -Infinity;
    let minCol = Infinity, maxCol = -Infinity;

    cells.forEach(cell => {
        const pos = mapper.getVisualPosition(cell);
        if (!pos) return;
        posMap.set(`${pos.startRow},${pos.startCol}`, cell);
        minRow = Math.min(minRow, pos.startRow);
        maxRow = Math.max(maxRow, pos.startRow);
        minCol = Math.min(minCol, pos.startCol);
        maxCol = Math.max(maxCol, pos.startCol);
    });

    // Build Monaco content: each row on its own line, columns separated by " | "
    const lines = [];
    for (let r = minRow; r <= maxRow; r++) {
        const parts = [];
        for (let c = minCol; c <= maxCol; c++) {
            const cell = posMap.get(`${r},${c}`);
            parts.push(cell ? $(cell).html() : '');
        }
        lines.push(parts.join(' | '));
    }

    window._multiCellEditState = { posMap, minRow, maxRow, minCol, maxCol };
    // Store value here; shown.bs.modal handler applies it after layout() runs
    window._multiCellPendingValue = lines.join('\n');

    const numRows = maxRow - minRow + 1;
    const numCols = maxCol - minCol + 1;
    $('#multiCellEditFmt').text(`${numRows} × ${numCols}  —  newline = row  |  pipe = col`);

    $('#multiCellEditModal').modal('show');
}

function applyMultiCellEdit() {
    const state = window._multiCellEditState;
    if (!state || !window.tableIdeMonacoMultiCell) return;

    const { posMap, minRow, maxRow, minCol, maxCol } = state;
    const raw   = window.tableIdeMonacoMultiCell.getValue();
    const lines = raw.split('\n');

    window.saveCurrentState();

    lines.forEach((line, lineIdx) => {
        const r = minRow + lineIdx;
        if (r > maxRow) return;
        line.split('|').forEach((value, colIdx) => {
            const c = minCol + colIdx;
            if (c > maxCol) return;
            const cell = posMap.get(`${r},${c}`);
            if (cell) $(cell).html(value.trim());
        });
    });

    window._multiCellEditState  = null;
    window._multiCellPendingValue = undefined;
    $('#multiCellEditModal').modal('hide');
    window.setupTableInteraction();
    $.toast({ heading: 'Done', text: 'Cells updated', icon: 'success', loader: false, stack: false });
}

// ── Scope-aware routers ──────────────────────────────────────────────────────
// When the active selection came from the ruler, #elementType is 'row' or
// 'column' and these routers fire the matching row/col operation. Otherwise
// they fall back to the cell-level operation. Keyboard shortcuts and any other
// caller that should respect ruler intent goes through these.
function deleteSelected() {
    const type = $('#elementType').val();
    if (type === 'row')    return deleteRows();
    if (type === 'column') return deleteColumns();
    return deleteCell();
}
function addSelectedAfter() {
    const type = $('#elementType').val();
    if (type === 'row')    return addRow();
    if (type === 'column') return addColumn();
    return addCell();
}
function addSelectedBefore() {
    const type = $('#elementType').val();
    if (type === 'row')    return addRowBefore();
    if (type === 'column') return addColumnBefore();
    return addCellBefore();
}

// Make functions globally accessible
window.addCell           = addCell;
window.addCellBefore     = addCellBefore;
window.deleteCell        = deleteCell;
window.deleteRows        = deleteRows;
window.deleteColumns     = deleteColumns;
window.addRow            = addRow;
window.addRowBefore      = addRowBefore;
window.addColumn         = addColumn;
window.addColumnBefore   = addColumnBefore;
window.mergeCells        = mergeCells;
window.deleteSelected    = deleteSelected;
window.addSelectedAfter  = addSelectedAfter;
window.addSelectedBefore = addSelectedBefore;
window.openMultiCellEdit  = openMultiCellEdit;
window.applyMultiCellEdit = applyMultiCellEdit;
