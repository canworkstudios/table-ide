// js/components/tableHistory.js
// Per-table, per-sheet history. Each (sheetId, tableId) pair gets its own
// 50-state stack, so operations on one table never crowd out another.

const MAX_PER_SLOT = 50;

// Map<string, {history: string[], currentIndex: number}>
// Key: `${sheetId}::${tableId}`
const _slots = new Map();

let _isRestoring = false;

function _slotKey(sheetId, tableId) {
    return `${sheetId ?? 'default'}::${tableId ?? 'default'}`;
}

function _getSlot(key) {
    if (!_slots.has(key)) {
        _slots.set(key, { history: [], currentIndex: -1 });
    }
    return _slots.get(key);
}

function _currentKey() {
    // On the all-sheets canvas the table's own sheet is authoritative; the
    // active sheet only follows clicks, and a programmatic selection can land
    // on a table in another sheet.
    const own = window.currentTable && window.currentTable.closest
        ? window.currentTable.closest('[data-sheet-id]') : null;
    const sheetId = (own && own.dataset.sheetId) || (window.activeSheetId ?? 'default');
    const tableId = window.currentTable
        ? ($(window.currentTable).attr('data-table-ide-id') ?? 'default')
        : 'default';
    return _slotKey(sheetId, tableId);
}

// ------------------------------------------------------------------
// Public API (mirrors old TableHistoryManager surface)
// ------------------------------------------------------------------

function saveCurrentState() {
    if (_isRestoring) return;
    if (!window.currentTable) return;

    const tableHtml = window.currentTable.outerHTML;
    if (!tableHtml || tableHtml.trim() === '') return;

    const key = _currentKey();
    const slot = _getSlot(key);

    if (slot.currentIndex >= 0 && slot.history[slot.currentIndex] === tableHtml) return;

    // Truncate any redo tail
    slot.history = slot.history.slice(0, slot.currentIndex + 1);
    slot.history.push(tableHtml);

    if (slot.history.length > MAX_PER_SLOT) {
        slot.history.shift();
    } else {
        slot.currentIndex++;
    }

    _updateButtons(key);
}

function performUndo() {
    if (!window.currentTable) return;
    const key = _currentKey();
    const slot = _getSlot(key);

    if (slot.currentIndex <= 0) {
        $.toast({ heading: 'Info', text: 'Nothing to undo', icon: 'info', loader: false, stack: false, position: 'top-right', hideAfter: 2000 });
        return;
    }

    slot.currentIndex--;
    _restoreSlot(key, slot);

    $.toast({ heading: 'Undo', text: 'Action undone', icon: 'info', loader: false, stack: false, position: 'top-right', hideAfter: 2000 });
}

function performRedo() {
    if (!window.currentTable) return;
    const key = _currentKey();
    const slot = _getSlot(key);

    if (slot.currentIndex >= slot.history.length - 1) {
        $.toast({ heading: 'Info', text: 'Nothing to redo', icon: 'info', loader: false, stack: false, position: 'top-right', hideAfter: 2000 });
        return;
    }

    slot.currentIndex++;
    _restoreSlot(key, slot);

    $.toast({ heading: 'Redo', text: 'Action redone', icon: 'info', loader: false, stack: false, position: 'top-right', hideAfter: 2000 });
}

function _restoreSlot(key, slot) {
    _isRestoring = true;

    const tableHtml = slot.history[slot.currentIndex];
    const tableId = window.currentTable
        ? $(window.currentTable).attr('data-table-ide-id')
        : null;

    // Replace just the target table in-place. The ruler wrap is rebuilt by
    // setupTableInteraction — we only need to swap the <table> element.
    const $target = tableId
        ? $(`#tableContainer table[data-table-ide-id="${tableId}"]`)
        : $(`#tableContainer table`).first();

    if ($target.length) {
        $target.replaceWith(tableHtml);
        // Re-resolve currentTable after replacement
        window.currentTable = tableId
            ? $(`#tableContainer table[data-table-ide-id="${tableId}"]`)[0]
            : $(`#tableContainer table`)[0];
    } else {
        // Fallback: table not found (deleted?), do nothing
        _isRestoring = false;
        return;
    }

    if (typeof window.initializeAllFeatures === 'function') window.initializeAllFeatures();
    if (typeof window.setupTableInteraction === 'function') window.setupTableInteraction();

    _isRestoring = false;
    _updateButtons(key);
}

function _updateButtons(key) {
    const slot = _getSlot(key);
    const canUndo = slot.currentIndex > 0;
    const canRedo = slot.currentIndex < slot.history.length - 1;

    const undoCount = slot.currentIndex;
    const redoCount = slot.history.length - slot.currentIndex - 1;

    if (slot.currentIndex !== -1) $('.undoState').text(`${undoCount}`);
    if (slot.currentIndex === -1) $('.redoState').text(`${redoCount}`);

    $('.undoHistory').prop('disabled', !canUndo).css('opacity', canUndo ? '1' : '0.5');
    $('.redoHistory').prop('disabled', !canRedo).css('opacity', canRedo ? '1' : '0.5');
}

// Clear history for a specific table slot (e.g. on sheet delete or table reset)
function clearTableHistory(sheetId, tableId) {
    const key = _slotKey(sheetId, tableId);
    _slots.delete(key);
    _updateButtons(_currentKey());
}

// Clear all slots for a sheet (called when a sheet is deleted)
function clearSheetHistory(sheetId) {
    for (const key of _slots.keys()) {
        if (key.startsWith(`${sheetId}::`)) _slots.delete(key);
    }
    _updateButtons(_currentKey());
}

// Legacy shim: gated node editor calls window.historyManager.saveState/isRestoring
window.historyManager = {
    get isRestoring() { return _isRestoring; },
    set isRestoring(v) { _isRestoring = v; },
    saveState() {},  // node editor is gated; no-op keeps it from crashing
    clear() { _slots.clear(); _updateButtons(_currentKey()); }
};

// Call after switching sheets or tables to reflect the new slot's undo/redo state
function syncHistoryButtons() {
    _updateButtons(_currentKey());
}

window.saveCurrentState = saveCurrentState;
window.performUndo = performUndo;
window.performRedo = performRedo;
window.clearTableHistory = clearTableHistory;
window.clearSheetHistory = clearSheetHistory;
window.syncHistoryButtons = syncHistoryButtons;
