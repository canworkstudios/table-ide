// ===================================================================================
// NODE EXECUTOR; Topological sort + execution loop
//   1. Kahn's algorithm — detects cycles, returns ordered node list
//   2. async run() — processes each operator node in order, writes output to CellStore
//   3. Handlers: filter, vlookup, formula, api
// ===================================================================================

window.nodeExecutor = (function () {

    // ── Topological sort (Kahn's algorithm) ────────────────────────────────────

    function _topoSort(nodes, wires) {
        // Build adjacency + in-degree
        const ids      = Object.keys(nodes);
        const inDeg    = {};
        const adjOut   = {};   // nodeId → [nodeId, ...]

        ids.forEach(id => { inDeg[id] = 0; adjOut[id] = []; });

        Object.values(wires).forEach(w => {
            if (!nodes[w.sourceNodeId] || !nodes[w.targetNodeId]) return;
            adjOut[w.sourceNodeId].push(w.targetNodeId);
            inDeg[w.targetNodeId]++;
        });

        // Queue: nodes with no incoming edges
        const queue   = ids.filter(id => inDeg[id] === 0);
        const ordered = [];

        while (queue.length) {
            const cur = queue.shift();
            ordered.push(cur);
            adjOut[cur].forEach(next => {
                inDeg[next]--;
                if (inDeg[next] === 0) queue.push(next);
            });
        }

        const cycleNodes = ids.filter(id => !ordered.includes(id));
        return { ordered, cycleNodes };
    }

    // ── Input map builder ─────────────────────────────────────────────────────
    //
    //   inputMap: { sourcePortId → { label, values: string[], sourceNodeId } }
    //
    //   For every wire pointing at nodeId, we walk the ENTIRE source node's
    //   output headers — not just the wired column. This means wiring ANY
    //   column from Table A to an operator gives the operator all of Table A's
    //   columns. Keying by source portId means cfg.column / cfg.keyPort etc.
    //   can reference source columns directly.

    function _buildInputMap(nodeId) {
        const inputMap = {};
        const seen     = new Set();

        Object.values(window.NodeGraph.wires).forEach(w => {
            if (w.targetNodeId !== nodeId) return;
            if (seen.has(w.sourceNodeId)) return;
            seen.add(w.sourceNodeId);

            _readSourcePort(w.sourceNodeId, w.sourcePortId).forEach(col => {
                inputMap[col.portId] = {
                    label:        col.label,
                    values:       col.values,
                    sourceNodeId: w.sourceNodeId
                };
            });
        });

        return inputMap;
    }

    // ── Port-aware source read ────────────────────────────────────────────────
    //
    //   Returns the columns a wire carries out of `sourceNodeId`.
    //
    //   A node may declare several named OUTPUT GROUPS (see `outputGroup` on a
    //   header). A wire leaving a grouped output carries only that group's
    //   columns — which is what makes one node able to emit `added`, `removed`
    //   and `modified` down three different wires. `sourcePortId` is the port
    //   the wire physically leaves from; its header's `outputGroup` selects the
    //   group. A node with no groups declared behaves exactly as before: every
    //   non-`in` column travels together, so existing graphs are unaffected.

    function _readSourcePort(sourceNodeId, sourcePortId) {
        const csm = window.cellStoreManager;
        const src = window.NodeGraph.nodes[sourceNodeId];
        if (!src) return [];

        const outHeaders = src.headers.filter(h => h.direction !== 'in');

        // Which group does this wire leave from? Ports carry an '-out' suffix on
        // the rendered element, so match the bare portId too.
        const bare  = String(sourcePortId || '').replace(/-out$/, '');
        const from  = outHeaders.find(h => h.portId === bare);
        const group = from && from.outputGroup;

        const carried = group
            ? outHeaders.filter(h => h.outputGroup === group)
            : outHeaders.filter(h => !h.outputGroup);

        // A wire drawn from an ungrouped port on a node that only has grouped
        // outputs would otherwise carry nothing — fall back to everything.
        const cols = carried.length ? carried : outHeaders;

        return cols.map(h => ({
            portId: h.portId,
            label:  h.label,
            // Columnar path: operator output stored as h.values (no CellStore lookup)
            // CellStore path: source/table node data stored via h.cellIds
            values: h.values
                ? h.values
                : (h.cellIds || []).map(id => {
                    const cell = csm.get(id);
                    return cell ? cell.value : '';
                })
        }));
    }

    // ── Write output back to a node ───────────────────────────────────────────
    //
    //   outputCols: [{ label, values: string[], direction: 'out' }]

    // ── Stable output port ids ────────────────────────────────────────────────
    //
    //   Output ports MUST keep the same id across runs. They used to be minted
    //   with crypto.randomUUID() on every write, so any wire leaving an operator
    //   node referenced a port id that no longer existed the moment that node
    //   re-executed — the downstream node then reported "no input connected".
    //   Chaining operator to operator was rare enough for this to go unnoticed;
    //   branching makes it unavoidable.
    //
    //   Deriving the id from nodeId + output group + column label keeps a wire
    //   valid as long as the column it points at still exists, and lets a
    //   renamed or dropped column correctly invalidate its wire.

    function _outPortId(node, group, label) {
        const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return node.id + ':' + (group || 'out') + ':' + (slug || 'col');
    }

    function _writeOutput(node, outputCols) {
        const csm = window.cellStoreManager;

        // Drop columns the user deselected in the config panel's schema preview
        const excluded = new Set(node.config?.excludedCols || []);
        if (excluded.size) outputCols = outputCols.filter(c => !excluded.has(c.label));

        // Release any old CellStore refs (only source/table headers use cellIds)
        node.headers.forEach(h => {
            if (h.cellIds && h.cellIds.length > 0) {
                h.cellIds.forEach(id => csm.release(id));
            }
        });

        // Keep the structural 'in' ports. They are the anchor an incoming wire
        // renders against, so dropping them leaves every inbound connection
        // unpaintable after the first run (_writeJoinOutput always did this).
        const structuralIn = node.headers.filter(h => h.direction === 'in');

        // Write operator output as columnar string arrays — zero CellStore allocation
        node.headers = structuralIn.concat(outputCols.map(col => ({
            portId:    _outPortId(node, col.outputGroup, col.label),
            label:     col.label,
            values:    col.values.map(v => String(v)),  // plain array, no CellStore
            cellIds:   [],                               // kept for structural compat
            direction: col.direction || 'out',
            outputGroup: col.outputGroup || null
        })));
    }

    // ── Multi-output write ────────────────────────────────────────────────────
    //
    //   groups: [{ name, label, columns: [{ label, values }] }]
    //
    //   Writes several NAMED OUTPUTS onto one node. Each group's columns are
    //   tagged with `outputGroup`, and `_readSourcePort` uses that tag to decide
    //   what a wire leaving a given port carries. This is the mechanism behind
    //   branching: a Diff node emits added/removed/modified, and three wires
    //   leave it carrying three different tables.
    //
    //   Preserved from _writeOutput: excludedCols filtering and CellStore
    //   release, so a multi-output node behaves like any other on those paths.

    function _writeOutputGroups(node, groups) {
        const csm = window.cellStoreManager;
        const excluded = new Set(node.config?.excludedCols || []);

        node.headers.forEach(h => {
            if (h.cellIds && h.cellIds.length > 0) h.cellIds.forEach(id => csm.release(id));
        });

        const headers = node.headers.filter(h => h.direction === 'in');
        groups.forEach(g => {
            g.columns
                .filter(c => !excluded.has(c.label))
                .forEach(col => {
                    headers.push({
                        portId:      _outPortId(node, g.name, col.label),
                        label:       col.label,
                        values:      col.values.map(v => String(v)),
                        cellIds:     [],
                        direction:   'out',
                        outputGroup: g.name,
                        groupLabel:  g.label || g.name
                    });
                });
        });
        node.headers = headers;
    }

    // ── Handlers ──────────────────────────────────────────────────────────────

    // filter — keep rows matching (config.column, config.operator, config.value)
    function _handleFilter(node, inputMap) {
        const cfg = node.config || {};
        if (!cfg.column || !inputMap[cfg.column]) {
            throw new Error('Filter: no column selected or no input connected');
        }

        const masterCol = inputMap[cfg.column];
        const allPorts  = Object.keys(inputMap);
        const numRows   = masterCol.values.length;
        const keepIdx   = [];

        for (let r = 0; r < numRows; r++) {
            if (_testRow(masterCol.values[r], cfg.operator, cfg.value)) {
                keepIdx.push(r);
            }
        }

        const outputCols = allPorts.map(portId => {
            const col = inputMap[portId];
            return { label: col.label, values: keepIdx.map(i => col.values[i] || ''), direction: 'out' };
        });

        _writeOutput(node, outputCols);
    }

    function _testRow(val, op, cmp) {
        const vf = parseFloat(val), cf = parseFloat(cmp);
        const numOk = !isNaN(vf) && !isNaN(cf);
        switch (op) {
            case 'eq':       return numOk ? vf === cf : String(val) === String(cmp);
            case 'ne':       return numOk ? vf !== cf : String(val) !== String(cmp);
            case 'gt':       return numOk ? vf > cf : String(val) > String(cmp);
            case 'lt':       return numOk ? vf < cf : String(val) < String(cmp);
            case 'gte':      return numOk ? vf >= cf : String(val) >= String(cmp);
            case 'lte':      return numOk ? vf <= cf : String(val) <= String(cmp);
            case 'contains': return String(val).includes(String(cmp));
            case 'regex':    try { return new RegExp(cmp).test(val); } catch (_) { return false; }
            default:         return true;
        }
    }

    // vlookup — enrich with a column from a reference node by matching keys
    function _handleVlookup(node, inputMap) {
        const cfg = node.config || {};
        if (!cfg.keyPort || !cfg.refNodeId || !cfg.refKeyPort || !cfg.refValuePort) {
            throw new Error('VLookup: incomplete configuration');
        }

        const keyCol = inputMap[cfg.keyPort];
        if (!keyCol) throw new Error('VLookup: key column not connected');

        const refNode     = window.NodeGraph.nodes[cfg.refNodeId];
        if (!refNode) throw new Error('VLookup: reference node not found');

        const csm         = window.cellStoreManager;
        const refKeyHeader = refNode.headers.find(h => h.portId === cfg.refKeyPort);
        const refValHeader = refNode.headers.find(h => h.portId === cfg.refValuePort);
        if (!refKeyHeader || !refValHeader) throw new Error('VLookup: reference columns not found');

        // Columnar path (reference node is an operator output) or CellStore path (table node)
        const _headerVals = h => h.values
            ? h.values
            : (h.cellIds || []).map(id => { const c = csm.get(id); return c ? c.value : ''; });
        const refKeys   = _headerVals(refKeyHeader);
        const refValues = _headerVals(refValHeader);

        // Build lookup map
        const lookupMap = {};
        refKeys.forEach((k, i) => { lookupMap[k] = refValues[i]; });

        // Pass through all input columns + add the looked-up column
        const outputCols = Object.entries(inputMap).map(([, col]) => ({
            label: col.label, values: col.values, direction: 'out'
        }));
        outputCols.push({
            label:     cfg.outputLabel || 'Lookup Result',
            values:    keyCol.values.map(k => lookupMap[k] !== undefined ? lookupMap[k] : ''),
            direction: 'out'
        });

        _writeOutput(node, outputCols);
    }

    // formula — add a computed column per row
    function _handleFormula(node, inputMap) {
        const cfg = node.config || {};
        if (!cfg.expression) throw new Error('Formula: no expression configured');

        const numRows    = Math.max(...Object.values(inputMap).map(c => c.values.length), 0);
        const outputVals = [];

        for (let r = 0; r < numRows; r++) {
            const rowCtx = {};
            Object.values(inputMap).forEach(col => {
                rowCtx['$' + col.label] = col.values[r] || '';
            });
            outputVals.push(window.nodeFormulaParser.evaluate(cfg.expression, rowCtx));
        }

        // Pass through all input columns + add the computed column
        const outputCols = Object.entries(inputMap).map(([, col]) => ({
            label: col.label, values: col.values, direction: 'out'
        }));
        outputCols.push({
            label:     cfg.outputLabel || 'Result',
            values:    outputVals,
            direction: 'out'
        });

        _writeOutput(node, outputCols);
    }

    // join — combine two source tables in various ways
    function _handleJoin(node) {
        const cfg = node.config || {};
        const mode = cfg.mode || 'stack';

        // Resolve both source tables from the fixed structural ports
        const leftData  = _readNamedInput(node, 'join-in-left');
        const rightData = _readNamedInput(node, 'join-in-right');

        if (!leftData && !rightData) {
            throw new Error('Join: connect at least one table');
        }

        // Modes that don't need a key
        if (mode === 'stack') {
            _writeJoinOutput(node, _joinStack(leftData, rightData));
            return;
        }
        if (mode === 'lateral') {
            _writeJoinOutput(node, _joinLateral(leftData, rightData));
            return;
        }

        // Key-based modes
        if (!leftData)  throw new Error('Join: Left Table not connected');
        if (!rightData) throw new Error('Join: Right Table not connected');
        if (!cfg.leftKey)  throw new Error('Join: Left key column not configured');
        if (!cfg.rightKey) throw new Error('Join: Right key column not configured');

        const leftKeyCol  = leftData.find(c => c.portId === cfg.leftKey);
        const rightKeyCol = rightData.find(c => c.portId === cfg.rightKey);

        if (!leftKeyCol)  throw new Error('Join: Left key column not found in source');
        if (!rightKeyCol) throw new Error('Join: Right key column not found in source');

        switch (mode) {
            case 'inner': _writeJoinOutput(node, _joinInner(leftData, rightData, leftKeyCol, rightKeyCol)); break;
            case 'left':  _writeJoinOutput(node, _joinLeft (leftData, rightData, leftKeyCol, rightKeyCol)); break;
            case 'right': _writeJoinOutput(node, _joinRight(leftData, rightData, leftKeyCol, rightKeyCol)); break;
            case 'outer': _writeJoinOutput(node, _joinOuter(leftData, rightData, leftKeyCol, rightKeyCol)); break;
            default: throw new Error('Join: unknown mode ' + mode);
        }
    }

    // ── Named-input read ──────────────────────────────────────────────────────
    //
    //   Returns the columns arriving at one NAMED INPUT PORT, or null when
    //   nothing is wired there. This is what lets a node take several distinct
    //   inputs that must not be merged — join's Left/Right, and diff's
    //   Before/After — instead of the flat `_buildInputMap` blend.
    //
    //   Join used to hand-roll this against its own fixed port ids. Keeping it
    //   general means the next multi-input node declares two headers and calls
    //   this, rather than copying the lookup.

    function _readNamedInput(node, inputPortId) {
        const wire = Object.values(window.NodeGraph.wires).find(
            w => w.targetNodeId === node.id && w.targetPortId === inputPortId
        );
        if (!wire) return null;
        const cols = _readSourcePort(wire.sourceNodeId, wire.sourcePortId);
        return cols.length ? cols : null;
    }

    // ── condition — route rows down a Match / No Match branch ─────────────────
    //
    //   PRO (node-condition). The same test as filter, but nothing is discarded:
    //   rows that fail the test leave through the second output instead of being
    //   dropped. That is the whole difference between filtering and routing, and
    //   it is only expressible now that a node can carry more than one output.
    //
    //   Reuses _testRow so the operator vocabulary cannot drift from filter's.

    function _handleCondition(node, inputMap) {
        const cfg = node.config || {};
        if (!cfg.column || !inputMap[cfg.column]) {
            throw new Error('Condition: no column selected or no input connected');
        }

        const testCol  = inputMap[cfg.column];
        const allPorts = Object.keys(inputMap);
        const numRows  = allPorts.reduce((m, p) => Math.max(m, inputMap[p].values.length), 0);

        const matchIdx = [], elseIdx = [];
        for (let r = 0; r < numRows; r++) {
            (_testRow(testCol.values[r], cfg.operator, cfg.value) ? matchIdx : elseIdx).push(r);
        }

        const pick = idx => allPorts.map(p => ({
            label:  inputMap[p].label,
            values: idx.map(i => inputMap[p].values[i] ?? '')
        }));

        _writeOutputGroups(node, [
            { name: 'match', label: 'Match',    columns: pick(matchIdx) },
            { name: 'else',  label: 'No Match', columns: pick(elseIdx) }
        ]);
    }

    // ── diff — compare two table versions into three named outputs ────────────
    //
    //   Rows are identified by a key column, matched by LABEL across the two
    //   inputs (the two sides are different nodes, so port ids never match).
    //   added    — key present in After but not Before
    //   removed  — key present in Before but not After
    //   modified — key in both, but at least one shared column differs
    //
    //   Modified rows are emitted in their After state, plus a `Changed Columns`
    //   column naming what differs. Reporting WHICH fields moved is the whole
    //   point of a diff over a plain anti-join.

    function _handleDiff(node) {
        const cfg    = node.config || {};
        const before = _readNamedInput(node, 'diff-in-before');
        const after  = _readNamedInput(node, 'diff-in-after');

        if (!before) throw new Error('Diff: Before input not connected');
        if (!after)  throw new Error('Diff: After input not connected');
        if (!cfg.keyColumn) throw new Error('Diff: key column not configured');

        const keyBefore = before.find(c => c.portId === cfg.keyColumn);
        if (!keyBefore) throw new Error('Diff: key column not found in Before input');
        const keyAfter = after.find(c => c.label === keyBefore.label);
        if (!keyAfter) throw new Error(`Diff: After input has no "${keyBefore.label}" column to match on`);

        // Columns compared for modification: shared by label, minus the key.
        const sharedLabels = before
            .map(c => c.label)
            .filter(l => l !== keyBefore.label && after.some(c => c.label === l));

        const rowsOf = (cols, keyCol) => {
            const n = cols.reduce((m, c) => Math.max(m, c.values.length), 0);
            const byKey = new Map();
            for (let r = 0; r < n; r++) {
                const k = String(keyCol.values[r] ?? '');
                if (k === '') continue;             // unkeyed rows cannot be matched
                if (!byKey.has(k)) byKey.set(k, r); // first occurrence wins
            }
            return { n, byKey };
        };

        const B = rowsOf(before, keyBefore);
        const A = rowsOf(after,  keyAfter);

        const addedIdx = [], removedIdx = [], modifiedIdx = [], changedCols = [];

        A.byKey.forEach((ai, k) => {
            if (!B.byKey.has(k)) { addedIdx.push(ai); return; }
            const bi = B.byKey.get(k);
            const diffs = sharedLabels.filter(label => {
                const bc = before.find(c => c.label === label);
                const ac = after.find(c => c.label === label);
                return String(bc.values[bi] ?? '') !== String(ac.values[ai] ?? '');
            });
            if (diffs.length) { modifiedIdx.push(ai); changedCols.push(diffs.join(', ')); }
        });

        B.byKey.forEach((bi, k) => { if (!A.byKey.has(k)) removedIdx.push(bi); });

        const pick = (cols, idx) => cols.map(c => ({
            label:  c.label,
            values: idx.map(i => c.values[i] ?? '')
        }));

        _writeOutputGroups(node, [
            { name: 'added',    label: 'Added',    columns: pick(after,  addedIdx) },
            { name: 'removed',  label: 'Removed',  columns: pick(before, removedIdx) },
            { name: 'modified', label: 'Modified', columns: pick(after, modifiedIdx)
                .concat([{ label: 'Changed Columns', values: changedCols }]) }
        ]);
    }

    // ── append — stack every wired table, columns matched by label ────────────
    //
    //   Reads each wire into append-in separately, in the order the wires were
    //   made, so the output order is the order the user connected (or that
    //   Combine connected) them. Columns are the union of labels in first-seen
    //   order; a table missing a column contributes blanks for it.

    function _handleAppend(node) {
        const wires = Object.values(window.NodeGraph.wires).filter(
            w => w.targetNodeId === node.id && w.targetPortId === 'append-in'
        );
        if (!wires.length) throw new Error('Append: connect at least one table');

        const withSource = node.config?.sourceColumn !== false;
        const labels = [];
        const parts = wires.map(w => {
            const cols = _readSourcePort(w.sourceNodeId, w.sourcePortId);
            cols.forEach(c => { if (!labels.includes(c.label)) labels.push(c.label); });
            const src = window.NodeGraph.nodes[w.sourceNodeId];
            return { cols, name: src ? src.label : '', rows: cols.reduce((m, c) => Math.max(m, c.values.length), 0) };
        });

        const out = labels.map(label => ({
            label,
            values: parts.flatMap(p => {
                const col = p.cols.find(c => c.label === label);
                return col ? col.values.concat(Array(p.rows - col.values.length).fill('')) : Array(p.rows).fill('');
            })
        }));
        if (withSource) {
            const srcLabel = labels.includes('Source') ? 'Source Table' : 'Source';
            out.unshift({ label: srcLabel, values: parts.flatMap(p => Array(p.rows).fill(p.name)) });
        }
        _writeJoinOutput(node, out);
    }

    // ── Join mode implementations ──────────────────────────────────────────────

    // Stack: append all rows, columns matched by name — mismatched columns get blanks
    function _joinStack(left, right) {
        left  = left  || [];
        right = right || [];
        const allLabels = [...new Set([...left.map(c => c.label), ...right.map(c => c.label)])];
        return allLabels.map(label => {
            const lCol = left.find(c => c.label === label);
            const rCol = right.find(c => c.label === label);
            return {
                label,
                values: [...(lCol ? lCol.values : Array(left[0]?.values.length || 0).fill('')),
                         ...(rCol ? rCol.values : Array(right[0]?.values.length || 0).fill(''))]
            };
        });
    }

    // Lateral: put Right columns alongside Left columns, aligned by row index
    function _joinLateral(left, right) {
        left  = left  || [];
        right = right || [];
        const lLen = left[0]?.values.length  || 0;
        const rLen = right[0]?.values.length || 0;
        const maxRows = Math.max(lLen, rLen);
        const _pad = (col, len) => ({ ...col, values: col.values.concat(Array(len - col.values.length).fill('')) });
        return [
            ...left.map(c  => _pad(c, maxRows)),
            ...right.map(c => _pad(c, maxRows))
        ];
    }

    // Inner: only rows where leftKey == rightKey
    function _joinInner(left, right, leftKeyCol, rightKeyCol) {
        const rightIdx = _buildIndex(rightKeyCol.values);
        const outputCols = _initOutputCols(left, right);
        leftKeyCol.values.forEach((lKey, lRow) => {
            const rRows = rightIdx[lKey];
            if (!rRows) return;
            rRows.forEach(rRow => _appendRow(outputCols, left, right, lRow, rRow));
        });
        return outputCols;
    }

    // Left: all Left rows, Right columns blank where no match
    function _joinLeft(left, right, leftKeyCol, rightKeyCol) {
        const rightIdx   = _buildIndex(rightKeyCol.values);
        const outputCols = _initOutputCols(left, right);
        leftKeyCol.values.forEach((lKey, lRow) => {
            const rRows = rightIdx[lKey];
            if (rRows) rRows.forEach(rRow => _appendRow(outputCols, left, right, lRow, rRow));
            else       _appendRow(outputCols, left, right, lRow, null);
        });
        return outputCols;
    }

    // Right: all Right rows, Left columns blank where no match
    function _joinRight(left, right, leftKeyCol, rightKeyCol) {
        const leftIdx    = _buildIndex(leftKeyCol.values);
        const outputCols = _initOutputCols(left, right);
        rightKeyCol.values.forEach((rKey, rRow) => {
            const lRows = leftIdx[rKey];
            if (lRows) lRows.forEach(lRow => _appendRow(outputCols, left, right, lRow, rRow));
            else       _appendRow(outputCols, left, right, null, rRow);
        });
        return outputCols;
    }

    // Full Outer: all rows from both, blanks on whichever side has no match
    function _joinOuter(left, right, leftKeyCol, rightKeyCol) {
        const rightIdx      = _buildIndex(rightKeyCol.values);
        const matchedRRight = new Set();
        const outputCols    = _initOutputCols(left, right);

        leftKeyCol.values.forEach((lKey, lRow) => {
            const rRows = rightIdx[lKey];
            if (rRows) {
                rRows.forEach(rRow => { _appendRow(outputCols, left, right, lRow, rRow); matchedRRight.add(rRow); });
            } else {
                _appendRow(outputCols, left, right, lRow, null);
            }
        });
        // Right rows with no Left match
        rightKeyCol.values.forEach((_, rRow) => {
            if (!matchedRRight.has(rRow)) _appendRow(outputCols, left, right, null, rRow);
        });
        return outputCols;
    }

    // Build value → [rowIndex, ...] index from a column's values array
    function _buildIndex(values) {
        const idx = {};
        values.forEach((v, i) => { if (!idx[v]) idx[v] = []; idx[v].push(i); });
        return idx;
    }

    // Create output column stubs — all Left columns then all Right columns
    // Right columns are prefixed if a same-named column exists in Left (avoids clobbering)
    function _initOutputCols(left, right) {
        const leftLabels = new Set((left || []).map(c => c.label));
        const out = [
            ...(left  || []).map(c => ({ label: c.label, values: [] })),
            ...(right || []).map(c => ({ label: leftLabels.has(c.label) ? c.label + ' (right)' : c.label, values: [] }))
        ];
        return out;
    }

    // Append one merged row — lRow or rRow can be null (means blank that side)
    function _appendRow(outputCols, left, right, lRow, rRow) {
        const lLen = (left  || []).length;
        left = left || [];
        right = right || [];
        outputCols.forEach((col, colIdx) => {
            if (colIdx < lLen) {
                col.values.push(lRow !== null ? (left[colIdx].values[lRow]  ?? '') : '');
            } else {
                const rColIdx = colIdx - lLen;
                col.values.push(rRow !== null ? (right[rColIdx].values[rRow] ?? '') : '');
            }
        });
    }

    // Write join output — keeps structural 'in' ports, replaces previous 'out' columns
    function _writeJoinOutput(node, outputCols) {
        const csm = window.cellStoreManager;

        // Drop columns the user deselected in the config panel's schema preview
        const excluded = new Set(node.config?.excludedCols || []);
        if (excluded.size) outputCols = outputCols.filter(c => !excluded.has(c.label));
        // Release any previous output-only CellStore refs
        node.headers
            .filter(h => h.direction === 'out')
            .forEach(h => { if (h.cellIds && h.cellIds.length > 0) h.cellIds.forEach(id => csm.release(id)); });
        // Keep only structural 'in' ports
        node.headers = node.headers.filter(h => h.direction === 'in');
        // Append new output columns as columnar arrays — zero CellStore allocation
        outputCols.forEach(col => {
            node.headers.push({
                portId:    _outPortId(node, null, col.label),
                label:     col.label,
                values:    col.values.map(v => String(v)),  // plain array, no CellStore
                cellIds:   [],
                direction: 'out'
            });
        });
    }

    // api — fetch JSON, traverse jsonPath, expose fields as output columns
    async function _handleApi(node) {
        const cfg = node.config || {};
        if (!cfg.url) throw new Error('API: no URL configured');

        let headersObj = {};
        if (cfg.headers && typeof cfg.headers === 'object') headersObj = cfg.headers;

        let response;
        try {
            response = await fetch(cfg.url, {
                method:  cfg.method || 'GET',
                headers: headersObj
            });
        } catch (networkErr) {
            // Network error, CORS block, or DNS failure
            throw new Error(`API: Network error — ${networkErr.message}. Check the URL and that the server allows cross-origin requests (CORS).`);
        }

        if (!response.ok) throw new Error(`API: HTTP ${response.status} ${response.statusText}`);

        let data;
        try {
            data = await response.json();
        } catch (_) {
            throw new Error('API: Response is not valid JSON');
        }

        // Traverse jsonPath (e.g. 'data.items')
        if (cfg.jsonPath) {
            const parts = cfg.jsonPath.split('.');
            for (const part of parts) {
                if (data == null || typeof data !== 'object') break;
                data = data[part];
            }
        }

        // Normalise to array of objects
        if (!Array.isArray(data)) {
            data = typeof data === 'object' && data !== null ? [data] : [];
        }

        if (data.length === 0) {
            _writeOutput(node, []);
            return;
        }

        // Collect all unique keys across all rows
        const keys = [];
        data.forEach(row => {
            if (typeof row !== 'object' || row === null) return;
            Object.keys(row).forEach(k => { if (!keys.includes(k)) keys.push(k); });
        });

        const outputCols = keys.map(k => ({
            label:     k,
            values:    data.map(row => (row && row[k] !== undefined) ? String(row[k]) : ''),
            direction: 'out'
        }));

        _writeOutput(node, outputCols);
    }

    // ── Run ───────────────────────────────────────────────────────────────────

    async function run() {
        // Table nodes read their columns from the live tables on the canvas,
        // so pick up any edit made since the last run.
        if (window.CanvasGraph) window.CanvasGraph.syncTableNodes();
        const nodes = window.NodeGraph.nodes;
        const wires = window.NodeGraph.wires;

        // Mark all operator nodes as 'running' and flush a repaint before heavy work
        Object.values(nodes).forEach(n => {
            if (window.NodeTypes.isOperator(n.nodeType)) {
                n.execState = 'running';
                n.execError = null;
                if (typeof renderNodeDom === 'function') renderNodeDom(n.id);
            }
        });
        window.nodeCanvasRenderer.markStaticDirty();

        // Yield once so the browser can paint the 'running' badges before we block
        await new Promise(r => setTimeout(r, 0));

        let doneCount  = 0;
        let errorCount = 0;

        try {
            const { ordered, cycleNodes } = _topoSort(nodes, wires);

            // Mark cycle nodes immediately
            cycleNodes.forEach(id => {
                const n = nodes[id];
                if (!n) return;
                n.execState = 'error';
                n.execError = 'Cycle detected';
                if (typeof renderNodeDom === 'function') renderNodeDom(n.id);
            });
            errorCount += cycleNodes.length;

            // ── Yielded execution loop ─────────────────────────────────────────
            // Between each operator node we yield (setTimeout 0) so the browser
            // event loop can repaint, handle input, and avoid "frozen" appearance.
            for (const nodeId of ordered) {
                const node = nodes[nodeId];
                if (!node) continue;
                if (!window.NodeTypes.isOperator(node.nodeType)) continue;

                try {
                    const inputMap = _buildInputMap(nodeId);
                    switch (node.nodeType) {
                        case 'filter':  _handleFilter(node, inputMap);  break;
                        case 'vlookup': _handleVlookup(node, inputMap); break;
                        case 'formula': _handleFormula(node, inputMap); break;
                        case 'api':     await _handleApi(node);         break;
                        case 'join':    _handleJoin(node);              break;
                        case 'append':  _handleAppend(node);            break;
                        case 'diff':    _handleDiff(node);              break;
                        case 'condition': _handleCondition(node, inputMap); break;
                        default: break;
                    }
                    node.execState = 'done';
                    doneCount++;
                } catch (err) {
                    node.execState = 'error';
                    node.execError = err.message || 'Unknown error';
                    errorCount++;
                }

                // Re-render this node's card to show done/error badge…
                if (typeof renderNodeDom === 'function') renderNodeDom(nodeId);
                // …then yield to the browser so the repaint actually happens
                await new Promise(r => setTimeout(r, 0));
            }
        } catch (fatalErr) {
            Object.values(nodes).forEach(n => {
                if (n.execState === 'running') {
                    n.execState = 'error';
                    n.execError = 'Run aborted: ' + (fatalErr.message || 'Unknown error');
                    if (typeof renderNodeDom === 'function') renderNodeDom(n.id);
                    errorCount++;
                }
            });
        }

        // Single canvas redraw + state save after the whole loop
        window.nodeCanvasRenderer.markStaticDirty();
        if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();

        const summary = errorCount > 0
            ? `Run complete: ${doneCount} succeeded, ${errorCount} failed`
            : `Run complete: ${doneCount} node${doneCount !== 1 ? 's' : ''} processed`;

        $.toast({
            heading: 'Node Editor',
            text:    summary,
            icon:    errorCount > 0 ? 'warning' : 'success',
            loader:  false, stack: false
        });
    }

    // Reset all exec states back to idle (use after a failed/stuck run)
    function resetRunState() {
        Object.values(window.NodeGraph.nodes).forEach(n => {
            n.execState = 'idle';
            n.execError = null;
            if (typeof renderNodeDom === 'function') renderNodeDom(n.id);
        });
        window.nodeCanvasRenderer.markStaticDirty();
        $.toast({ heading: 'Node Editor', text: 'Run state reset', icon: 'info', loader: false, stack: false, hideAfter: 1500 });
    }

    return { run, resetRunState };
})();
