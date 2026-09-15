// ===================================================================================
// 1. THE VISUAL GRID MAPPER
// ===================================================================================
class VisualGridMapper {
    constructor(table) {
        this.table = table instanceof jQuery ? table[0] : table;
        this.grid = [];
        this.cellMap = new Map();
        this.buildGrid();
    }

    buildGrid() {
        const $table = $(this.table);
        const rows = $table.find('tr');
        let maxCols = 0;

        rows.each((rowIndex, row) => {
            this.grid[rowIndex] = this.grid[rowIndex] || [];
        });

        rows.each((rowIndex, row) => {
            let colIndex = 0;
            $(row).find('td, th').each((cellIndex, cell) => {
                const $cell = $(cell);
                const colspan = parseInt($cell.attr('colspan') || 1);
                const rowspan = parseInt($cell.attr('rowspan') || 1);

                while (this.grid[rowIndex][colIndex] !== undefined) {
                    colIndex++;
                }

                this.cellMap.set(cell, {
                    rowspan: rowspan,
                    colspan: colspan,
                    content: $cell.html(),
                    isHeader: $cell.is('th'),
                    startRow: rowIndex,
                    startCol: colIndex
                });

                for (let r = 0; r < rowspan; r++) {
                    this.grid[rowIndex + r] = this.grid[rowIndex + r] || [];
                    for (let c = 0; c < colspan; c++) {
                        this.grid[rowIndex + r][colIndex + c] = {
                            element: cell,
                            isOrigin: (r === 0 && c === 0)
                        };
                    }
                }

                colIndex += colspan;
            });

            maxCols = Math.max(maxCols, colIndex);
        });

        this.maxCols = maxCols;
        this.maxRows = this.grid.length;
    }

    getCellsInRow(rowIndex) {
        const cells = new Set();
        if (this.grid[rowIndex]) {
            this.grid[rowIndex].forEach(gridCell => {
                if (gridCell) {
                    cells.add(gridCell.element);
                }
            });
        }
        return Array.from(cells);
    }

    getCellsInColumn(colIndex) {
        const cells = new Set();
        this.grid.forEach(row => {
            if (row && row[colIndex]) {
                cells.add(row[colIndex].element);
            }
        });
        return Array.from(cells);
    }

    getVisualPosition(cell) {
        return this.cellMap.get(cell);
    }
}

// Make VisualGridMapper globally accessible
window.VisualGridMapper = VisualGridMapper;

/**
 * Is this cell actually on screen?
 *
 * The grid is the table's STRUCTURE, and structure outlives visibility: an
 * sp-* column that the active tab does not show is still a full column of
 * cells in every row, still in `grid`, still returned by getCellsInRow. Any
 * code that walks the grid and forgets to ask this question ends up selecting
 * cells nobody can see, drawing a selection box around them (a display:none
 * cell measures 0×0, so the box snaps to the viewport corner), or writing into
 * a column that belongs to a different tab.
 *
 * getClientRects() is the honest test — it is empty for display:none and for a
 * cell inside a collapsed accordion group alike, which are exactly the two ways
 * a cell disappears here.
 */
window.isCellVisible = function (cell) {
    return !!(cell && cell.getClientRects && cell.getClientRects().length > 0);
};

/**
 * normalizeGrid — the rectangular-grid invariant.
 *
 * An HTML table is a FLOW of cells: a row holds however many <td>s you gave it,
 * and removing one makes the rest shift left. A spreadsheet is a COORDINATE
 * GRID: every row has the same number of addressable slots whether or not
 * anything is in them. Table IDE presents a sheet, so the grid model has to be
 * the authoritative one and the DOM has to be made to agree with it.
 *
 * That is all this does: find the widest row (in VISUAL columns, spans counted)
 * and pad every short row with empty cells until the table is rectangular.
 * Run it after any structural mutation and raggedness stops being possible
 * rather than being something each operation has to remember not to cause.
 *
 * Deliberately NOT done here:
 *   • No fixed R x C canvas, no phantom columns out to some letter. These
 *     tables come from extracted documents — a 4-column table IS 4 columns, and
 *     padding it to 26 would invent structure the source never had, which the
 *     export and the provenance trail would then have to carry.
 *   • Rows are never TRIMMED, only padded. A row wider than the rest means a
 *     real cell exists out there; silently deleting it to square the table
 *     would destroy content, and losing data is worse than a ragged edge.
 *
 * Padding cells inherit the row's own tag so a <thead> row stays all <th>.
 *
 * Returns the number of cells added (0 when the table was already rectangular),
 * so callers can skip a re-render when nothing moved.
 */
window.normalizeGrid = function (table) {
    const el = table instanceof jQuery ? table[0] : table;
    if (!el) return 0;

    const mapper = new window.VisualGridMapper(el);
    if (!mapper.maxRows || !mapper.maxCols) return 0;

    // Structural rows only — the drag/drop scaffolding rows are not table rows
    // and padding them would put stray cells in the middle of a gesture.
    const rows = Array.from(el.rows).filter(r =>
        !r.classList.contains('table-ide-drag-row') &&
        !r.classList.contains('drop-indicator-row')
    );

    let added = 0;
    rows.forEach((row, i) => {
        // Count VISUAL occupancy, not row.cells.length: one colspan=3 cell
        // fills three columns, and a rowspan from an earlier row fills this
        // row's slot without contributing a cell to it at all.
        const occupied = (mapper.grid[i] || []).filter(Boolean).length;
        const missing  = mapper.maxCols - occupied;
        if (missing <= 0) return;

        const tag = row.querySelector('td') ? 'td'
                  : row.querySelector('th') ? 'th'
                  : (row.parentNode && row.parentNode.tagName === 'THEAD' ? 'th' : 'td');
        for (let n = 0; n < missing; n++) {
            row.appendChild(document.createElement(tag));
            added++;
        }
    });

    return added;
};
