// ====================================== CREATE NEW TABLE ============================================
// Lets the user draw a new empty table onto the current sheet. A drag/hover grid picker (like the
// "insert table" control in a word processor) sets the dimensions; the table is then appended to
// #tableContainer as its own card with a fresh data-table-ide-id, so a sheet can hold many tables.
(function () {
    const MAX_R = 12, MAX_C = 10;
    let $pop = null;

    // A drawn table joins the active sheet, so it is named after that sheet
    // (t-<sheet>-new, t-<sheet>-new-2, …) and checked against every sheet's
    // ids, not only the tables on screen.
    function nextTableIdeId() {
        const sheet = (window.sheets || []).find(s => s.id === window.activeSheetId);
        const slug = window.tableIdSlug ? window.tableIdSlug(sheet && sheet.name) : 'sheet';
        if (window.allocTableId) return window.allocTableId(`t-${slug}-new`);
        let n = 0;
        while ($(`#tableContainer table[data-table-ide-id="t-${slug}-new-${n}"]`).length) n++;
        return `t-${slug}-new-${n}`;
    }

    function buildTableHtml(rows, cols, tableId) {
        let html = `<table class="tablecoil crosshair-table" data-table-ide-id="${tableId}">`;
        html += '<thead><tr>';
        for (let c = 0; c < cols; c++) html += `<th>Column ${c + 1}</th>`;
        html += '</tr></thead><tbody>';
        for (let r = 0; r < rows; r++) {
            html += '<tr>';
            for (let c = 0; c < cols; c++) html += '<td></td>';
            html += '</tr>';
        }
        html += '</tbody></table>';
        return html;
    }

    function createNewTable(rows, cols) {
        rows = Math.max(1, Math.min(rows, 200));
        cols = Math.max(1, Math.min(cols, 60));

        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();

        const tableId = nextTableIdeId();
        const tableCount = $('#tableContainer .accordion').length + 1;
        const tableHtml = buildTableHtml(rows, cols, tableId);

        const block =
            `<button class="accordion active"><b>Table ${tableCount}</b></button>` +
            `<div class="panel"><div class="sp-selector"></div>${tableHtml}</div>`;

        const clean = window.DOMPurify
            ? window.DOMPurify.sanitize(block, { ALLOW_DATA_ATTR: true })
            : block;

        $('#tableContainer').append(clean);

        const newTable = $(`#tableContainer table[data-table-ide-id="${tableId}"]`)[0];
        window.currentTable = newTable;

        // .panel starts display:none (accordion collapsed). A freshly drawn table must be
        // visible, so open its panel — otherwise the card renders with no table inside.
        $(newTable).closest('.panel').show();

        // On the canvas a new table has to be wrapped and placed before it is
        // measured, or the ruler sizes a card that is still in document flow.
        if (window.TableCanvas && window.TableCanvas.isEnabled()) window.TableCanvas.refresh();

        if (typeof window.setupTableInteraction === 'function') window.setupTableInteraction();
        if (typeof window.renderTableRulers === 'function') {
            requestAnimationFrame(() => window.renderTableRulers(newTable));
        }

        if (!(window.TableCanvas && window.TableCanvas.isEnabled())) {
            newTable.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        $.toast({ heading: 'New table', text: `${rows} × ${cols} table added`, icon: 'success', loader: false, stack: false });
    }
    window.createNewTable = createNewTable;

    // ── Grid picker popover ───────────────────────────────────────────────────
    function buildPopover() {
        if ($pop && document.body.contains($pop[0])) return $pop;
        let cells = '';
        for (let r = 0; r < MAX_R; r++) {
            for (let c = 0; c < MAX_C; c++) {
                cells += `<div class="tf-grid-cell" data-r="${r}" data-c="${c}"></div>`;
            }
        }
        $pop = $(
            '<div class="tf-newtable-pop" style="display:none;">' +
                `<div class="tf-grid" style="grid-template-columns:repeat(${MAX_C},14px);">${cells}</div>` +
                '<div class="tf-grid-label">Drag to size</div>' +
            '</div>'
        );
        $('body').append($pop);

        const $label = $pop.find('.tf-grid-label');

        $pop.on('mousemove', '.tf-grid-cell', function () {
            const r = +$(this).data('r'), c = +$(this).data('c');
            $pop.find('.tf-grid-cell').each(function () {
                const rr = +$(this).data('r'), cc = +$(this).data('c');
                $(this).toggleClass('on', rr <= r && cc <= c);
            });
            $label.text(`${r + 1} × ${c + 1}`);
        });

        $pop.on('click', '.tf-grid-cell', function () {
            const r = +$(this).data('r'), c = +$(this).data('c');
            hidePopover();
            createNewTable(r + 1, c + 1);
        });

        return $pop;
    }

    function showPopover(anchorEl) {
        buildPopover();
        const rect = anchorEl.getBoundingClientRect();
        $pop.css({ display: 'block', visibility: 'hidden' });
        const pw = $pop.outerWidth();
        let left = rect.left;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        $pop.css({ left: Math.max(8, left) + 'px', top: (rect.bottom + 6) + 'px', visibility: 'visible' });
        $pop.find('.tf-grid-cell').removeClass('on');
        $pop.find('.tf-grid-label').text('Drag to size');

        setTimeout(() => {
            $(document).on('mousedown.tfnewtable', function (e) {
                if (!$(e.target).closest('.tf-newtable-pop, .newTableBtn').length) hidePopover();
            });
        }, 0);
    }

    function hidePopover() {
        if ($pop) $pop.hide();
        $(document).off('mousedown.tfnewtable');
    }

    $(function () {
        $(document).on('click', '.newTableBtn', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if ($pop && $pop.is(':visible')) { hidePopover(); return; }
            showPopover(this);
        });
    });
})();
