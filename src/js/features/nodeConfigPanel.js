// ===================================================================================
// NODE CONFIG PANEL; Per-type configuration UI sliding in from the right
// ===================================================================================

window.nodeConfigPanel = (function () {

    let _currentNodeId = null;
    let _excludedCols  = new Set();   // column labels deselected in the schema preview

    // ── Public ─────────────────────────────────────────────────────────────────

    function open(nodeId) {
        // Source columns come from the live tables, so refresh them first.
        if (window.CanvasGraph) window.CanvasGraph.syncTableNodes();
        const node = window.NodeGraph.nodes[nodeId];
        if (!node) return;

        _currentNodeId = nodeId;
        _excludedCols  = new Set(node.config?.excludedCols || []);
        const panel = _getPanel();

        _render(panel, node);
        panel.style.display = 'flex';
        requestAnimationFrame(() => panel.classList.add('ne-config-open'));
    }

    function close() {
        _currentNodeId = null;
        const panel = _getPanel();
        panel.classList.remove('ne-config-open');
        setTimeout(() => { panel.style.display = 'none'; }, 220);
    }

    function init() {
        const panel = _getPanel();
        // Close button
        window.GxPointer.onPress(panel, function (e) {
            if (e.target.closest('.ne-config-close')) close();
        });
        // Click outside closes
        document.addEventListener('pointerdown', function (e) {
            if (_currentNodeId && panel.style.display !== 'none' && !panel.contains(e.target)) {
                const nodeEl = e.target.closest('[data-node-id]');
                const configBtn = e.target.closest('.ne-node-config-btn');
                if (!nodeEl && !configBtn) close();
            }
        });
    }

    // ── Render ─────────────────────────────────────────────────────────────────

    function _render(panel, node) {
        const def = window.NodeTypes.get(node.nodeType);
        panel.innerHTML = `
            <div class="ne-config-header">
                <span style="background:${def.color}" class="ne-config-type-icon">${def.icon}</span>
                <strong>${def.label}: ${_esc(node.label)}</strong>
                <button class="ne-config-close" title="Close">✕</button>
            </div>
            <div class="ne-config-body" id="neConfigBody"></div>
            <div class="ne-config-footer">
                <button class="btn btn-sm btn-primary" id="neConfigSave">Save</button>
                <button class="btn btn-sm btn-outline-secondary ne-config-close">Cancel</button>
            </div>`;

        const body = panel.querySelector('#neConfigBody');
        const renderers = { filter: _renderFilter, condition: _renderCondition, vlookup: _renderVlookup, formula: _renderFormula, join: _renderJoin, diff: _renderDiff, api: _renderApi, append: _renderAppend };
        const renderer  = renderers[node.nodeType];
        if (renderer) renderer(body, node);
        else body.innerHTML = '<p style="color:var(--t-text-muted);padding:12px;">No configuration for this node type.</p>';

        // Output schema preview — shows the resulting column list before RUN,
        // recomputed live as the config controls change.
        const preview = document.createElement('div');
        preview.className = 'ne-config-field ne-schema-preview';
        body.appendChild(preview);
        _updateSchemaPreview(body, node);
        body.addEventListener('change', () => _updateSchemaPreview(body, node));
        body.addEventListener('input',  () => _updateSchemaPreview(body, node));

        window.GxPointer.onPress(panel.querySelector('#neConfigSave'), () => _save(node));
    }

    // ── Append config ──────────────────────────────────────────────────────────

    function _appendSources(node) {
        return Object.values(window.NodeGraph.wires)
            .filter(w => w.targetNodeId === node.id && w.targetPortId === 'append-in')
            .map(w => window.NodeGraph.nodes[w.sourceNodeId])
            .filter(Boolean);
    }

    function _renderAppend(body, node) {
        const srcs = _appendSources(node);
        const on = node.config?.sourceColumn !== false;
        body.innerHTML = `
            <div class="ne-config-field">
                <label>Tables, in stacking order</label>
                ${srcs.length
                    ? `<ol class="ne-config-list">${srcs.map(s => `<li>${_esc(s.label)}</li>`).join('')}</ol>`
                    : '<div class="ne-config-hint">Nothing connected yet.</div>'}
                <div class="ne-config-hint">Order follows the order the wires were connected.</div>
            </div>
            <div class="ne-config-field">
                <label><input type="checkbox" id="cfgAppendSource" ${on ? 'checked' : ''}> Add a Source column naming each row's table</label>
            </div>`;
    }

    // ── Filter config ──────────────────────────────────────────────────────────

    function _renderFilter(body, node) {
        _renderRowTest(body, node, {
            columnLabel: 'Column to filter',
            footer: ''
        });
    }

    // ── Condition config (PRO: node-condition) ─────────────────────────────────
    //
    //  Same row test as filter — reusing the renderer keeps the operator list
    //  from drifting between the two. Only the framing differs: filter discards
    //  the rows that fail, condition routes them out a second port.

    function _renderCondition(body, node) {
        _renderRowTest(body, node, {
            columnLabel: 'Column to test',
            footer: `
            <div class="ne-config-field">
                <div class="ne-config-hint">
                    Outputs two tables: <strong>Match</strong> for rows passing the test,
                    <strong>No Match</strong> for the rest. Nothing is discarded.
                </div>
            </div>`
        });
    }

    // Shared column/operator/value editor. Both filter and condition write the
    // same three config keys, so they share one set of field ids.
    function _renderRowTest(body, node, opts) {
        // Collect all input columns from wired source nodes
        const portOptions = _getInputPortOptions(node);
        const cfg = node.config || {};

        body.innerHTML = `
            <div class="ne-config-field">
                <label>${opts.columnLabel}</label>
                <select id="cfgFilterColumn">
                    <option value="">— select column —</option>
                    ${portOptions.map(p => `<option value="${_esc(p.portId)}" ${cfg.column === p.portId ? 'selected' : ''}>${_esc(p.label)}</option>`).join('')}
                </select>
            </div>
            <div class="ne-config-field">
                <label>Operator</label>
                <select id="cfgFilterOp">
                    ${['eq','ne','gt','lt','gte','lte','contains','regex'].map(op =>
                        `<option value="${op}" ${cfg.operator === op ? 'selected' : ''}>${_opLabel(op)}</option>`
                    ).join('')}
                </select>
            </div>
            <div class="ne-config-field">
                <label>Value</label>
                <input type="text" id="cfgFilterValue" value="${_esc(cfg.value || '')}" placeholder="e.g. 100  or  ^A">
            </div>${opts.footer || ''}`;
    }

    // ── VLookup config ─────────────────────────────────────────────────────────

    function _renderVlookup(body, node) {
        const inPorts   = _getInputPortOptions(node);
        const allNodes  = Object.values(window.NodeGraph.nodes).filter(n => n.id !== node.id);
        const cfg = node.config || {};

        body.innerHTML = `
            <div class="ne-config-field">
                <label>Key column (incoming)</label>
                <select id="cfgVlKeyPort">
                    <option value="">— select —</option>
                    ${inPorts.map(p => `<option value="${_esc(p.portId)}" ${cfg.keyPort === p.portId ? 'selected':''}>${_esc(p.label)}</option>`).join('')}
                </select>
            </div>
            <div class="ne-config-field">
                <label>Reference node</label>
                <select id="cfgVlRefNode">
                    <option value="">— select node —</option>
                    ${allNodes.map(n => `<option value="${n.id}" ${cfg.refNodeId === n.id ? 'selected':''}>${_esc(n.label)}</option>`).join('')}
                </select>
            </div>
            <div class="ne-config-field">
                <label>Ref key column</label>
                <select id="cfgVlRefKey">
                    <option value="">— select —</option>
                    ${_portOptsForNode(cfg.refNodeId, cfg.refKeyPort)}
                </select>
            </div>
            <div class="ne-config-field">
                <label>Ref value column</label>
                <select id="cfgVlRefVal">
                    <option value="">— select —</option>
                    ${_portOptsForNode(cfg.refNodeId, cfg.refValuePort)}
                </select>
            </div>
            <div class="ne-config-field">
                <label>Output column label</label>
                <input type="text" id="cfgVlOutputLabel" value="${_esc(cfg.outputLabel || 'Lookup Result')}" placeholder="Lookup Result">
            </div>`;

        // Refresh ref columns when ref node changes
        const refNodeSel = body.querySelector('#cfgVlRefNode');
        if (refNodeSel) {
            refNodeSel.addEventListener('change', function () {
                body.querySelector('#cfgVlRefKey').innerHTML = '<option value="">— select —</option>' + _portOptsForNode(this.value, '');
                body.querySelector('#cfgVlRefVal').innerHTML = '<option value="">— select —</option>' + _portOptsForNode(this.value, '');
            });
        }
    }

    // ── Formula config ─────────────────────────────────────────────────────────

    function _renderFormula(body, node) {
        const inPorts = _getInputPortOptions(node);
        const cfg = node.config || {};
        // Use the same compact, scrollable pill strip as the class panel.
        // Every input column stays available, so a formula can reference any
        // combination instead of being limited to one selected field.
        const colHints = inPorts.map(p => `<span class="tf-class-pill ne-formula-col" role="button" tabindex="0" data-column="${_esc(p.label)}">${_esc(p.label)}</span>`).join('');

        body.innerHTML = `
            <div class="ne-config-field">
                <label>Expression</label>
                <input type="text" id="cfgFormulaExpr" value="${_esc(cfg.expression || '')}"
                    placeholder="e.g. $Price * $Qty" style="font-family:monospace;">
                ${colHints ? `<div class="ne-config-hint"><span>Insert columns:</span><div class="tf-class-pills ne-formula-cols">${colHints}</div></div>` : ''}
                <div class="ne-config-error" id="cfgFormulaError" style="display:none;"></div>
            </div>
            <div class="ne-config-field">
                <label>Output column label</label>
                <input type="text" id="cfgFormulaOutputLabel" value="${_esc(cfg.outputLabel || 'Result')}" placeholder="Result">
            </div>`;

        body.querySelector('#cfgFormulaExpr').addEventListener('input', function () {
            const err = window.nodeFormulaParser.validate(this.value);
            const errEl = body.querySelector('#cfgFormulaError');
            if (err) { errEl.textContent = err; errEl.style.display = 'block'; }
            else     { errEl.style.display = 'none'; }
        });
        // Delegated on the strip, so the listener count does not scale with the
        // column count and pills re-rendered later stay live.
        const exprInput = body.querySelector('#cfgFormulaExpr');
        function insertColumnReference(pill) {
            const name  = pill.dataset.column || '';
            const token = /^[A-Za-z0-9_]+$/.test(name) ? '$' + name : '${' + name.replace(/}/g, '\\}') + '}';
            const start = exprInput.selectionStart == null ? exprInput.value.length : exprInput.selectionStart;
            const end   = exprInput.selectionEnd == null ? start : exprInput.selectionEnd;
            exprInput.value = exprInput.value.slice(0, start) + token + exprInput.value.slice(end);
            exprInput.setSelectionRange(start + token.length, start + token.length);
            exprInput.focus();
            exprInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const strip = body.querySelector('.ne-formula-cols');
        if (strip) {
            strip.addEventListener('click', function (e) {
                const pill = e.target.closest('.ne-formula-col');
                if (pill) insertColumnReference(pill);
            });
            strip.addEventListener('keydown', function (e) {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const pill = e.target.closest('.ne-formula-col');
                if (!pill) return;
                e.preventDefault();
                insertColumnReference(pill);
            });
        }
    }

    // ── Join config ────────────────────────────────────────────────────────────

    // ── Diff config ──────────────────────────────────────────────
    //
    //  Reuses the join helpers: both nodes resolve two NAMED inputs rather than
    //  the flat blended input map, so the same lookup answers "what is wired to
    //  this side".

    function _renderDiff(body, node) {
        const cfg         = node.config || {};
        const beforeCols  = _getJoinSourceCols(node, 'diff-in-before');
        const afterCols   = _getJoinSourceCols(node, 'diff-in-after');
        const beforeLabel = _getJoinSourceLabel(node, 'diff-in-before');
        const afterLabel  = _getJoinSourceLabel(node, 'diff-in-after');

        // Only columns present on BOTH sides can identify a row across versions.
        const keyable = (beforeCols || []).filter(
            c => (afterCols || []).some(a => a.label === c.label)
        );

        body.innerHTML = `
            <div class="ne-config-field">
                <label>Wired versions</label>
                <div class="ne-join-wire-status">
                    <span class="ne-join-side ${beforeCols ? 'ne-join-connected' : 'ne-join-missing'}">◀ Before: ${beforeLabel || 'not connected'}</span>
                    <span class="ne-join-side ${afterCols ? 'ne-join-connected' : 'ne-join-missing'}">After: ${afterLabel || 'not connected'} ▶</span>
                </div>
            </div>
            <div class="ne-config-field">
                <label>Identity column</label>
                <select id="cfgDiffKey">
                    <option value="">— select —</option>
                    ${keyable.map(c => `<option value="${_esc(c.portId)}" ${cfg.keyColumn === c.portId ? 'selected' : ''}>${_esc(c.label)}</option>`).join('')}
                </select>
                <div class="ne-config-hint">
                    ${keyable.length
                        ? 'The column that identifies the same row across both versions — an id or account number, not a value that changes.'
                        : 'Wire both versions first. Only columns present in both can identify a row.'}
                </div>
            </div>
            <div class="ne-config-field">
                <div class="ne-config-hint">
                    Outputs three tables: <strong>Added</strong>, <strong>Removed</strong> and
                    <strong>Modified</strong>. Wire any port under a heading to carry that table onward.
                </div>
            </div>`;
    }

    function _renderJoin(body, node) {
        const cfg       = node.config || {};
        const mode      = cfg.mode || 'stack';
        const leftCols  = _getJoinSourceCols(node, 'join-in-left');
        const rightCols = _getJoinSourceCols(node, 'join-in-right');
        const needsKey  = ['inner', 'left', 'right', 'outer'].includes(mode);

        const leftLabel  = _getJoinSourceLabel(node, 'join-in-left');
        const rightLabel = _getJoinSourceLabel(node, 'join-in-right');

        const modeOptions = [
            { value: 'stack',   label: 'Stack rows',           hint: 'Append all rows from Right below Left — columns matched by name' },
            { value: 'lateral', label: 'Paste columns',        hint: 'Add Right columns alongside Left columns, aligned by row position' },
            { value: 'inner',   label: 'Inner Join',           hint: 'Keep only rows where the key exists in both tables' },
            { value: 'left',    label: 'Left Join',            hint: 'Keep all rows from Left; Right columns blank where no match' },
            { value: 'right',   label: 'Right Join',           hint: 'Keep all rows from Right; Left columns blank where no match' },
            { value: 'outer',   label: 'Full Outer Join',      hint: 'Keep all rows from both tables; blanks on either side where no match' }
        ];

        body.innerHTML = `
            <div class="ne-config-field">
                <label>Wired tables</label>
                <div class="ne-join-wire-status">
                    <span class="ne-join-side ${leftCols ? 'ne-join-connected' : 'ne-join-missing'}">◀ Left: ${leftLabel || 'not connected'}</span>
                    <span class="ne-join-side ${rightCols ? 'ne-join-connected' : 'ne-join-missing'}">Right: ${rightLabel || 'not connected'} ▶</span>
                </div>
            </div>
            <div class="ne-config-field">
                <label>Join mode</label>
                <select id="cfgJoinMode">
                    ${modeOptions.map(o => `<option value="${o.value}" ${mode === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
                </select>
                <div class="ne-config-hint" id="cfgJoinModeHint">${modeOptions.find(o => o.value === mode)?.hint || ''}</div>
            </div>
            <div id="cfgJoinKeyFields" style="${needsKey ? '' : 'display:none;'}">
                <div class="ne-config-field">
                    <label>Left key column <span class="ne-config-hint-inline">(${leftLabel || 'Left Table'})</span></label>
                    <select id="cfgJoinLeftKey">
                        <option value="">— select —</option>
                        ${(leftCols || []).map(c => `<option value="${_esc(c.portId)}" ${cfg.leftKey === c.portId ? 'selected' : ''}>${_esc(c.label)}</option>`).join('')}
                    </select>
                </div>
                <div class="ne-config-field">
                    <label>Right key column <span class="ne-config-hint-inline">(${rightLabel || 'Right Table'})</span></label>
                    <select id="cfgJoinRightKey">
                        <option value="">— select —</option>
                        ${(rightCols || []).map(c => `<option value="${_esc(c.portId)}" ${cfg.rightKey === c.portId ? 'selected' : ''}>${_esc(c.label)}</option>`).join('')}
                    </select>
                </div>
            </div>`;

        // Show/hide key fields and update hint when mode changes
        body.querySelector('#cfgJoinMode').addEventListener('change', function () {
            const isKey = ['inner', 'left', 'right', 'outer'].includes(this.value);
            body.querySelector('#cfgJoinKeyFields').style.display = isKey ? '' : 'none';
            const opt = modeOptions.find(o => o.value === this.value);
            body.querySelector('#cfgJoinModeHint').textContent = opt ? opt.hint : '';
        });
    }

    // Returns columns from the source node wired to the given fixed port (join-in-left / join-in-right)
    function _getJoinSourceCols(node, fixedPortId) {
        const wire = Object.values(window.NodeGraph.wires || {}).find(
            w => w.targetNodeId === node.id && w.targetPortId === fixedPortId
        );
        if (!wire) return null;
        const src = window.NodeGraph.nodes[wire.sourceNodeId];
        if (!src) return null;
        return src.headers.filter(h => h.direction !== 'in').map(h => ({ portId: h.portId, label: h.label }));
    }

    function _getJoinSourceLabel(node, fixedPortId) {
        const wire = Object.values(window.NodeGraph.wires || {}).find(
            w => w.targetNodeId === node.id && w.targetPortId === fixedPortId
        );
        if (!wire) return null;
        const src = window.NodeGraph.nodes[wire.sourceNodeId];
        return src ? src.label : null;
    }

    // ── API config ─────────────────────────────────────────────────────────────

    function _renderApi(body, node) {
        const cfg = node.config || {};
        body.innerHTML = `
            <div class="ne-config-field">
                <label>URL</label>
                <input type="url" id="cfgApiUrl" value="${_esc(cfg.url || '')}" placeholder="https://api.example.com/data">
            </div>
            <div class="ne-config-field">
                <label>Method</label>
                <select id="cfgApiMethod">
                    ${['GET','POST'].map(m => `<option ${cfg.method === m ? 'selected' : ''}>${m}</option>`).join('')}
                </select>
            </div>
            <div class="ne-config-field">
                <label>JSON path <span class="ne-config-hint-inline">(e.g. data.items)</span></label>
                <input type="text" id="cfgApiJsonPath" value="${_esc(cfg.jsonPath || '')}" placeholder="optional dot-path">
            </div>
            <div class="ne-config-field">
                <label>Request headers <span class="ne-config-hint-inline">(JSON object)</span></label>
                <textarea id="cfgApiHeaders" rows="3" style="font-family:monospace;font-size:11px;">${_esc(cfg.headers ? JSON.stringify(cfg.headers, null, 2) : '{}')}</textarea>
            </div>`;
    }

    // ── Save ───────────────────────────────────────────────────────────────────

    function _save(node) {
        const panel = _getPanel();
        const get   = id => { const el = panel.querySelector('#' + id); return el ? el.value : ''; };

        switch (node.nodeType) {
            case 'filter':
            case 'condition':
                node.config = { column: get('cfgFilterColumn'), operator: get('cfgFilterOp'), value: get('cfgFilterValue') };
                break;
            case 'vlookup':
                node.config = { keyPort: get('cfgVlKeyPort'), refNodeId: get('cfgVlRefNode'), refKeyPort: get('cfgVlRefKey'), refValuePort: get('cfgVlRefVal'), outputLabel: get('cfgVlOutputLabel') || 'Lookup Result' };
                break;
            case 'formula': {
                const expr = get('cfgFormulaExpr');
                const err  = window.nodeFormulaParser.validate(expr);
                if (err) {
                    $.toast({ heading: 'Formula Error', text: err, icon: 'error', loader: false, stack: false });
                    return;
                }
                node.config = { expression: expr, outputLabel: get('cfgFormulaOutputLabel') || 'Result' };
                break;
            }
            case 'diff': {
                // Three tables leave this node, so a single column list would
                // misdescribe it. Name the outputs instead.
                const b = (_getJoinSourceCols(node, 'diff-in-before') || []).map(c => c.label);
                const a = (_getJoinSourceCols(node, 'diff-in-after')  || []).map(c => c.label);
                if (b.length && a.length) {
                    cols = [...new Set([...a, 'Changed Columns'])];
                    note = 'Three outputs: Added and Modified carry After columns, Removed carries Before columns.';
                } else {
                    note = 'Wire both Before and After to see the output shape.';
                }
                break;
            }
            case 'api': {
                let headers = {};
                try { headers = JSON.parse(get('cfgApiHeaders') || '{}'); } catch (_) {}
                node.config = { url: get('cfgApiUrl'), method: get('cfgApiMethod') || 'GET', jsonPath: get('cfgApiJsonPath'), headers };
                break;
            }
            case 'join':
                node.config = { mode: get('cfgJoinMode') || 'stack', leftKey: get('cfgJoinLeftKey'), rightKey: get('cfgJoinRightKey') };
                break;
            case 'append': {
                const cb = panel.querySelector('#cfgAppendSource');
                node.config = { sourceColumn: !!(cb && cb.checked) };
                break;
            }
            case 'diff':
                node.config = { keyColumn: get('cfgDiffKey') };
                break;
        }

        // Persist chip selection from the schema preview
        node.config = node.config || {};
        node.config.excludedCols = [..._excludedCols];

        if (typeof renderNodeDom === 'function') renderNodeDom(node.id);
        window.nodeCanvasRenderer.markStaticDirty();
        if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();

        close();
        $.toast({ heading: 'Node Editor', text: 'Configuration saved', icon: 'success', loader: false, stack: false, hideAfter: 1800 });
    }

    // ── Output schema preview ──────────────────────────────────────────────────
    // Predicts the node's output column list from its inputs + the LIVE values
    // of the config controls (falling back to node.config where no control exists).

    function _updateSchemaPreview(body, node) {
        const box = body.querySelector('.ne-schema-preview');
        if (!box) return;
        const val = id => { const el = body.querySelector('#' + id); return el ? el.value : null; };

        const inLabels = _getInputPortOptions(node).map(p => p.label);
        let cols = null, note = '';

        switch (node.nodeType) {
            case 'filter':
                cols = inLabels;
                note = 'Same columns, fewer rows.';
                break;
            case 'condition':
                cols = inLabels;
                note = 'Two outputs: Match and No Match. Same columns, rows split between them.';
                break;
            case 'vlookup':
                cols = [...inLabels, (val('cfgVlOutputLabel') || node.config?.outputLabel || 'Lookup Result')];
                break;
            case 'formula':
                cols = [...inLabels, (val('cfgFormulaOutputLabel') || node.config?.outputLabel || 'Result')];
                break;
            case 'join': {
                const left  = (_getJoinSourceCols(node, 'join-in-left')  || []).map(c => c.label);
                const right = (_getJoinSourceCols(node, 'join-in-right') || []).map(c => c.label);
                const mode  = val('cfgJoinMode') || node.config?.mode || 'stack';
                if (mode === 'stack') {
                    cols = [...new Set([...left, ...right])];
                } else if (mode === 'lateral') {
                    cols = [...left, ...right];
                } else {
                    const leftSet = new Set(left);
                    cols = [...left, ...right.map(l => leftSet.has(l) ? l + ' (right)' : l)];
                }
                break;
            }
            case 'api':
                note = 'Columns are determined by the API response at run time.';
                break;
            case 'append': {
                const labels = [];
                _appendSources(node).forEach(s => s.headers.filter(h => h.direction !== 'in')
                    .forEach(h => { if (!labels.includes(h.label)) labels.push(h.label); }));
                const cb = body.querySelector('#cfgAppendSource');
                const withSource = cb ? cb.checked : node.config?.sourceColumn !== false;
                cols = withSource ? [labels.includes('Source') ? 'Source Table' : 'Source', ...labels] : labels;
                note = 'Rows from every table, one after another. A table missing a column gets blanks there.';
                break;
            }
        }

        if (!cols && !note) { box.innerHTML = ''; return; }
        box.innerHTML = `
            <label>Output columns <span class="ne-config-hint-inline">(click to include/exclude)</span></label>
            ${cols && cols.length
                ? `<div class="ne-schema-cols">${cols.map(l =>
                      `<span class="ne-schema-col${_excludedCols.has(l) ? ' ne-schema-col-off' : ''}" data-col-label="${_esc(l)}">${_esc(l)}</span>`
                  ).join('')}</div>`
                : (cols ? '<div class="ne-config-hint">No input columns connected yet.</div>' : '')}
            ${note ? `<div class="ne-config-hint">${note}</div>` : ''}`;

        // Click a chip to toggle the column in/out of this node's output
        box.querySelectorAll('.ne-schema-col').forEach(chip => {
            window.GxPointer.onPress(chip, function () {
                const label = chip.dataset.colLabel;
                if (_excludedCols.has(label)) _excludedCols.delete(label);
                else                          _excludedCols.add(label);
                chip.classList.toggle('ne-schema-col-off');
            });
        });
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    function _getPanel() {
        return document.getElementById('neConfigPanel');
    }

    // Collect { portId, label } pairs from every source node wired into this node.
    // portId is the SOURCE column's portId — matching what nodeExecutor._buildInputMap keys by.
    function _getInputPortOptions(node) {
        const wires = Object.values(window.NodeGraph.wires || {}).filter(w => w.targetNodeId === node.id);
        const opts  = [];
        const seen  = new Set();

        wires.forEach(w => {
            if (seen.has(w.sourceNodeId)) return;
            seen.add(w.sourceNodeId);
            const src = window.NodeGraph.nodes[w.sourceNodeId];
            if (!src) return;
            src.headers
                .filter(h => h.direction !== 'in')
                .forEach(h => {
                    if (!opts.find(o => o.portId === h.portId)) {
                        opts.push({ portId: h.portId, label: h.label, sourceNodeId: w.sourceNodeId });
                    }
                });
        });
        return opts;
    }

    function _portOptsForNode(refNodeId, selectedPortId) {
        if (!refNodeId) return '';
        const refNode = window.NodeGraph.nodes[refNodeId];
        if (!refNode) return '';
        return refNode.headers.map(h =>
            `<option value="${_esc(h.portId)}" ${selectedPortId === h.portId ? 'selected' : ''}>${_esc(h.label)}</option>`
        ).join('');
    }

    function _opLabel(op) {
        return { eq: '= equals', ne: '≠ not equals', gt: '> greater than', lt: '< less than', gte: '≥ ≥', lte: '≤ ≤', contains: 'contains', regex: 'matches regex' }[op] || op;
    }

    function _esc(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    return { open, close, init };
})();
