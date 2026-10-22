// ===================================================================================
// NODE PALETTE; "Add Node" flyout — lets users drop operator nodes onto the canvas
// ===================================================================================

window.nodePaletteOpen = false;

function initNodePalette() {
    const btn     = document.getElementById('neAddNode');
    const palette = document.getElementById('nePalette');
    if (!btn || !palette) return;

    window.GxPointer.onPress(btn, function (e) {
        e.stopPropagation();
        if (window.nodePaletteOpen) _closePalette();
        else _openPalette();
    });

    // Close on outside click
    document.addEventListener('click', function (e) {
        if (window.nodePaletteOpen && !palette.contains(e.target) && e.target !== btn) {
            _closePalette();
        }
    });

    // Build palette buttons from NodeTypes registry
    _buildPalette(palette);
}

function _openPalette() {
    const palette = document.getElementById('nePalette');
    if (!palette) return;
    window.nodePaletteOpen = true;
    palette.style.display  = 'block';
    document.getElementById('neAddNode').classList.add('active');
}

function _closePalette() {
    const palette = document.getElementById('nePalette');
    if (!palette) return;
    window.nodePaletteOpen = false;
    palette.style.display  = 'none';
    const btn = document.getElementById('neAddNode');
    if (btn) btn.classList.remove('active');
}

function _buildPalette(palette) {
    // Order is the palette order. Whether an entry is Pro-locked comes from the
    // type registry's `pro` slug, so tiering is declared in one place rather
    // than duplicated as hardcoded markup here.
    const operatorTypes = ['filter', 'condition', 'vlookup', 'formula', 'join', 'append', 'diff', 'api'];
    palette.innerHTML = '';

    const heading = document.createElement('div');
    heading.className   = 'ne-palette-heading';
    heading.textContent = 'Add Operator Node';
    palette.appendChild(heading);

    operatorTypes.forEach(type => {
        const def  = window.NodeTypes.get(type);
        const icon = `<span class="ne-palette-icon" style="background:${def.color}">${def.icon}</span>`;

        if (def.pro) {
            // Locked: the interceptor swallows the click and opens the waitlist.
            const wrap = document.createElement('div');
            wrap.className = 'ne-palette-item gx-pro-locked';
            wrap.style.position = 'relative';
            wrap.innerHTML = `
        ${icon}
        <span class="ne-palette-info"><strong>${def.label} <span class="gx-pro-badge">PRO</span></strong><em>${def.description}</em></span>
        <div class="gx-pro-interceptor" data-pro-feature="${def.pro}"></div>`;
            palette.appendChild(wrap);
            return;
        }

        const btn = document.createElement('button');
        btn.className = 'ne-palette-item';
        btn.innerHTML = `${icon}<span class="ne-palette-info"><strong>${def.label}</strong><em>${def.description}</em></span>`;
        window.GxPointer.onPress(btn, function () {
            _placeOperatorNode(type);
            _closePalette();
        });
        palette.appendChild(btn);
    });
}

function _placeOperatorNode(type) {
    if (!window.nodeEditorEnabled) return;
    const def = window.NodeTypes.get(type);

    // The palette renders Pro types as locked, but placement is also reachable
    // from restored state and the MCP verb surface — so the gate is enforced
    // here too rather than trusted to the UI that happens to call it.
    if (def.pro) {
        if (typeof window.openProWaitlist === 'function') window.openProWaitlist(def.pro);
        return;
    }

    // Place near canvas center
    const viewport = document.querySelector('.tf-canvas-viewport') || document.getElementById('nodeEditorViewport');
    const vp       = window.NodeGraph.viewport;
    const cx = viewport ? viewport.clientWidth  / 2 : 400;
    const cy = viewport ? viewport.clientHeight / 2 : 300;

    // Convert center screen → canvas space
    const canvasX = (cx - vp.x) / vp.zoom;
    const canvasY = (cy - vp.y) / vp.zoom;

    // Offset slightly so multiple additions don't stack exactly
    const offset = Object.keys(window.NodeGraph.nodes).length * 20;

    const label   = def.label + ' ' + (Object.values(window.NodeGraph.nodes).filter(n => n.nodeType === type).length + 1);
    const config  = window.NodeTypes.defaultConfig(type);
    const headers = window.NodeTypes.defaultHeaders(type) || [];
    const nodeId  = window.nodeGraphManager.addNode(label, canvasX + offset, canvasY + offset, headers, type, config);

    if (typeof renderNodeDom === 'function') renderNodeDom(nodeId);
    window.nodeGraphManager.selectNode(nodeId);
    if (typeof window.nodeInteractionManager._updateSelectionVisuals === 'function') {
        window.nodeInteractionManager._updateSelectionVisuals();
    }
    window.nodeCanvasRenderer.markStaticDirty();
    if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();

    $.toast({
        heading:   'Node Editor',
        text:      `Added ${def.label} node`,
        icon:      'success',
        loader:    false, stack: false, hideAfter: 2000
    });
}

window.nodePaletteInit = initNodePalette;
