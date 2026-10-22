// ===================================================================================
// NODE TYPES; Type registry — colors, icons, default config, default port directions
// ===================================================================================

window.NodeTypes = {

    // ── Registry ──────────────────────────────────────────────────────────────
    //
    //  table    — data source (loaded from sheet, no computation)
    //  filter   — keep rows matching a condition
    //  vlookup  — enrich rows by matching a key against another node's column
    //  formula  — add a computed column using an expression
    //  api      — fetch external JSON and expose fields as output columns
    //  join     — combine two tables (stack, lateral paste, or key-based joins)
    //  append   — stack ANY number of tables into one, columns matched by name

    types: {
        table: {
            label:       'Table',
            color:       '#1a73e8',
            cssVar:      '--ne-type-table',
            icon:        '⊞',
            description: 'Data source from an imported sheet',
            defaultConfig: {},
            defaultPorts: 'inout'     // all headers are in+out
        },
        filter: {
            label:       'Filter',
            color:       '#f59e0b',
            cssVar:      '--ne-type-filter',
            icon:        '⊟',
            description: 'Keep rows matching a condition',
            defaultConfig: {
                column:   '',        // source portId of column to test
                operator: 'eq',      // eq | ne | gt | lt | gte | lte | contains | regex
                value:    ''
            },
            defaultPorts: 'in',
            defaultHeaders: [
                { label: 'Input Table', portId: 'filter-input', direction: 'in', cellIds: [] }
            ]
        },
        vlookup: {
            label:       'VLookup',
            color:       '#8b5cf6',
            cssVar:      '--ne-type-vlookup',
            icon:        '⇄',
            description: 'Match keys and pull values from another node',
            defaultConfig: {
                keyPort:      '',    // source portId of key column in incoming data
                refNodeId:    '',    // nodeId of reference table
                refKeyPort:   '',    // portId of key column in reference table
                refValuePort: '',    // portId of value column to pull
                outputLabel:  'Lookup Result'
            },
            defaultPorts: 'in',
            defaultHeaders: [
                { label: 'Input Table', portId: 'vlookup-input', direction: 'in', cellIds: [] }
            ]
        },
        formula: {
            label:       'Formula',
            color:       '#10b981',
            cssVar:      '--ne-type-formula',
            icon:        'ƒ',
            description: 'Add a computed column with an expression',
            defaultConfig: {
                expression:  '',     // e.g. '$Price * $Qty'
                outputLabel: 'Result'
            },
            defaultPorts: 'in',
            defaultHeaders: [
                { label: 'Input Table', portId: 'formula-input', direction: 'in', cellIds: [] }
            ]
        },
        api: {
            label:       'API',
            color:       '#ef4444',
            cssVar:      '--ne-type-api',
            icon:        '⇡',
            description: 'Fetch JSON from a URL and map fields to columns',
            defaultConfig: {
                url:      '',
                method:   'GET',
                jsonPath: '',        // dot-path into response e.g. 'data.items'
                headers:  {}
            },
            defaultPorts: 'out',
            defaultHeaders: [
                { label: 'Input Table', portId: 'api-input', direction: 'in', cellIds: [] }
            ]
        },
        condition: {
            label:       'Condition',
            color:       '#7c3aed',
            cssVar:      '--ne-type-condition',
            icon:        '⑂',
            description: 'Route rows through If/Else branches',
            // PRO. The engine is real; placement stays gated until Pro ships.
            pro:         'node-condition',
            defaultConfig: {
                column:   '',        // portId of the column to test
                operator: 'eq',      // same operator vocabulary as filter
                value:    ''
            },
            defaultPorts: 'in',
            defaultHeaders: [
                { label: 'Input Table', portId: 'condition-input', direction: 'in', cellIds: [] }
            ]
        },
        diff: {
            label:       'Diff',
            color:       '#d946ef',
            cssVar:      '--ne-type-diff',
            icon:        '≠',
            description: 'Compare two versions of a table into added / removed / modified',
            defaultConfig: {
                keyColumn: ''        // portId of the identity column in the BEFORE input
            },
            defaultPorts: 'in',
            // Two named inputs, resolved by _readNamedInput (not the flat input map)
            defaultHeaders: [
                { label: 'Before', portId: 'diff-in-before', direction: 'in', cellIds: [] },
                { label: 'After',  portId: 'diff-in-after',  direction: 'in', cellIds: [] }
            ]
        },
        join: {
            label:       'Join',
            color:       '#0ea5e9',
            cssVar:      '--ne-type-join',
            icon:        '⋈',
            description: 'Combine two tables by key or position',
            defaultConfig: {
                mode:      'stack',  // stack | lateral | inner | left | right | outer
                leftKey:   '',       // portId of key column in left source (key modes only)
                rightKey:  ''        // portId of key column in right source (key modes only)
            },
            defaultPorts: 'in',
            // These two ports are always present on a join node (permanent structure)
            defaultHeaders: [
                { label: 'Left Table',  portId: 'join-in-left',  direction: 'in', cellIds: [] },
                { label: 'Right Table', portId: 'join-in-right', direction: 'in', cellIds: [] }
            ]
        },
        // Join takes exactly two inputs, so combining ten tables meant nine
        // chained joins. Append takes every wire into its one input port, in
        // the order they were connected. This is what "Combine" builds.
        append: {
            label:       'Append',
            color:       '#14b8a6',
            cssVar:      '--ne-type-append',
            icon:        '⊕',
            description: 'Stack every connected table into one, columns matched by name',
            defaultConfig: {
                sourceColumn: true   // add a Source column naming each row's table
            },
            defaultPorts: 'in',
            defaultHeaders: [
                { label: 'Tables', portId: 'append-in', direction: 'in', cellIds: [] }
            ]
        }
    },

    // ── Helpers ────────────────────────────────────────────────────────────────

    get(type) {
        return this.types[type] || this.types.table;
    },

    color(type) {
        return (this.types[type] || this.types.table).color;
    },

    icon(type) {
        return (this.types[type] || this.types.table).icon;
    },

    defaultConfig(type) {
        const t = this.types[type];
        return t ? JSON.parse(JSON.stringify(t.defaultConfig)) : {};
    },

    // Returns a deep copy of defaultHeaders (if any) for types that need fixed structural ports
    defaultHeaders(type) {
        const t = this.types[type];
        return t && t.defaultHeaders ? JSON.parse(JSON.stringify(t.defaultHeaders)) : null;
    },

    isOperator(type) {
        return type && type !== 'table';
    }
};
