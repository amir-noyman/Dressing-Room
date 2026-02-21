/// <reference types="@figma/plugin-typings" />
// ─── Constants ──────────────────────────────────────────────────
const FIELD_LABEL = {
    itemSpacing: 'Gap',
    counterAxisSpacing: 'Cross-axis gap',
    paddingLeft: 'Padding left',
    paddingRight: 'Padding right',
    paddingTop: 'Padding top',
    paddingBottom: 'Padding bottom',
    topLeftRadius: 'Top-left radius',
    topRightRadius: 'Top-right radius',
    bottomLeftRadius: 'Bottom-left radius',
    bottomRightRadius: 'Bottom-right radius',
    strokeWeight: 'Stroke weight',
    fontSize: 'Font size',
    fontFamily: 'Font family',
    lineHeight: 'Line height',
    letterSpacing: 'Letter spacing',
};
const FIELD_CATEGORY = {
    itemSpacing: 'Spacing',
    counterAxisSpacing: 'Spacing',
    paddingLeft: 'Spacing',
    paddingRight: 'Spacing',
    paddingTop: 'Spacing',
    paddingBottom: 'Spacing',
    topLeftRadius: 'Radius',
    topRightRadius: 'Radius',
    bottomLeftRadius: 'Radius',
    bottomRightRadius: 'Radius',
    strokeWeight: 'Borders',
    fontSize: 'Typography',
    fontFamily: 'Typography',
    lineHeight: 'Typography',
    letterSpacing: 'Typography',
};
// Text-specific fields that need setRangeBoundVariable as fallback
const TEXT_FIELDS = new Set([
    'fontFamily', 'fontSize', 'fontStyle', 'fontWeight',
    'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent',
]);
// ─── Main Plugin Class ─────────────────────────────────────────
class TokenApplicator {
    constructor() {
        // Cache: variable ID → resolved info (avoids repeated async lookups)
        this.varCache = new Map();
        // Cache: collection ID → name
        this.colCache = new Map();
        // Undo stack (last action only)
        this.undoStack = [];
        this.undoAction = null;
        figma.showUI(__html__, { width: 420, height: 640 });
        figma.ui.onmessage = async (msg) => {
            try {
                if (msg.type === 'scan')
                    await this.scan();
                else if (msg.type === 'apply')
                    await this.apply(msg.items);
                else if (msg.type === 'strip')
                    await this.strip();
                else if (msg.type === 'undo')
                    await this.undo();
                else if (msg.type === 'open-url')
                    figma.openExternal(msg.url);
                else if (msg.type === 'close')
                    figma.closePlugin();
            }
            catch (err) {
                console.error('[TokenApplicator] Error:', err);
                figma.ui.postMessage({ type: 'error', message: String(err) });
            }
        };
        // Pre-cache local collection names, then signal ready
        this.init();
    }
    async init() {
        try {
            const cols = await figma.variables.getLocalVariableCollectionsAsync();
            for (const c of cols)
                this.colCache.set(c.id, c.name);
            console.log('[TokenApplicator] Cached', cols.length, 'local collections');
        }
        catch (e) {
            console.log('[TokenApplicator] Could not cache collections:', e);
        }
        // Also try to cache library collection names
        try {
            const libCols = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
            console.log('[TokenApplicator] Found', libCols.length, 'library collections:', libCols.map(c => c.name).join(', '));
        }
        catch (e) {
            console.log('[TokenApplicator] Library collections not available:', e);
        }
        figma.ui.postMessage({ type: 'ready' });
    }
    // ─── Resolve a VariableAlias to display info ──────────────────
    /** Resolve a variable ID to its name, collection, and value. */
    async resolveVar(id) {
        if (this.varCache.has(id))
            return this.varCache.get(id);
        try {
            const v = await figma.variables.getVariableByIdAsync(id);
            if (!v) {
                this.varCache.set(id, null);
                return null;
            }
            // Get collection name
            let colName = this.colCache.get(v.variableCollectionId);
            if (!colName) {
                try {
                    const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
                    colName = col ? col.name : 'Library';
                    this.colCache.set(v.variableCollectionId, colName);
                }
                catch (_a) {
                    colName = 'Library';
                }
            }
            // Resolve value
            const modeId = Object.keys(v.valuesByMode)[0];
            let val = modeId ? v.valuesByMode[modeId] : null;
            // Follow alias chain
            let depth = 0;
            while (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && depth < 10) {
                const next = await figma.variables.getVariableByIdAsync(val.id);
                if (!next)
                    break;
                const nextMode = Object.keys(next.valuesByMode)[0];
                if (!nextMode)
                    break;
                val = next.valuesByMode[nextMode];
                depth++;
            }
            let resolved;
            if (typeof val === 'number' || typeof val === 'string') {
                resolved = val;
            }
            else if (val && typeof val === 'object' && 'r' in val && 'g' in val && 'b' in val) {
                resolved = this.rgbaToHex(val);
            }
            else {
                resolved = 0;
            }
            const info = { name: v.name, collection: colName, value: resolved };
            this.varCache.set(id, info);
            return info;
        }
        catch (_b) {
            this.varCache.set(id, null);
            return null;
        }
    }
    // ─── Scan selected nodes ──────────────────────────────────────
    async scan() {
        var _a;
        const sel = figma.currentPage.selection;
        if (sel.length === 0) {
            figma.ui.postMessage({ type: 'error', message: 'Select at least one element to scan.' });
            return;
        }
        figma.ui.postMessage({ type: 'scanning' });
        // Clear variable cache so stale null entries don't cause false re-detections
        this.varCache.clear();
        const matches = [];
        const stats = { nodesScanned: 0, propsChecked: 0, alreadyBound: 0, noMatch: 0, matched: 0 };
        for (const node of sel) {
            await this.walk(node, matches, stats, 0);
        }
        console.log('[TokenApplicator] Scan complete:', JSON.stringify(stats));
        console.log('[TokenApplicator] Matches:', matches.length);
        for (const m of matches) {
            console.log('  →', m.nodeName, '|', m.field, ':', m.rawValue, '→', ((_a = m.candidates[0]) === null || _a === void 0 ? void 0 : _a.name) || '(none)');
        }
        figma.ui.postMessage({ type: 'results', matches, total: matches.length, stats });
    }
    async walk(node, out, stats, depth) {
        if (depth > 100)
            return;
        await this.inspect(node, out, stats);
        // Don't walk into instance children — their properties can't be rebound
        if ('children' in node && node.type !== 'INSTANCE') {
            for (const child of node.children) {
                await this.walk(child, out, stats, depth + 1);
            }
        }
    }
    async inspect(node, out, stats) {
        var _a, _b, _c, _d;
        stats.nodesScanned++;
        // ── Auto-layout spacing & padding ──
        if ('layoutMode' in node) {
            const f = node;
            if (f.layoutMode !== 'NONE') {
                await this.checkField(f, 'itemSpacing', f.itemSpacing, out, stats);
                if ('counterAxisSpacing' in f) {
                    await this.checkField(f, 'counterAxisSpacing', f.counterAxisSpacing, out, stats);
                }
                await this.checkField(f, 'paddingLeft', f.paddingLeft, out, stats);
                await this.checkField(f, 'paddingRight', f.paddingRight, out, stats);
                await this.checkField(f, 'paddingTop', f.paddingTop, out, stats);
                await this.checkField(f, 'paddingBottom', f.paddingBottom, out, stats);
            }
        }
        // ── Corner radius (individual corners only — "cornerRadius" is not bindable) ──
        if ('cornerRadius' in node) {
            const n = node;
            if (typeof n.topLeftRadius === 'number')
                await this.checkField(n, 'topLeftRadius', n.topLeftRadius, out, stats);
            if (typeof n.topRightRadius === 'number')
                await this.checkField(n, 'topRightRadius', n.topRightRadius, out, stats);
            if (typeof n.bottomLeftRadius === 'number')
                await this.checkField(n, 'bottomLeftRadius', n.bottomLeftRadius, out, stats);
            if (typeof n.bottomRightRadius === 'number')
                await this.checkField(n, 'bottomRightRadius', n.bottomRightRadius, out, stats);
        }
        // ── Stroke weight (only if node has genuinely visible strokes) ──
        if ('strokes' in node && node.strokes !== figma.mixed) {
            const strokes = node.strokes;
            const hasRealStroke = Array.isArray(strokes) && strokes.length > 0 &&
                strokes.some((s) => {
                    if (s.visible === false)
                        return false;
                    if (s.type !== 'SOLID')
                        return false;
                    if (typeof s.opacity === 'number' && s.opacity === 0)
                        return false;
                    // Check the color isn't fully transparent
                    if (s.color && s.color.r === 0 && s.color.g === 0 && s.color.b === 0 && s.color.a === 0)
                        return false;
                    return true;
                });
            const sw = node.strokeWeight;
            if (hasRealStroke && typeof sw === 'number' && sw > 0) {
                await this.checkField(node, 'strokeWeight', sw, out, stats);
            }
        }
        // ── Text properties ──
        if (node.type === 'TEXT') {
            const t = node;
            if (typeof t.fontSize === 'number') {
                await this.checkField(t, 'fontSize', t.fontSize, out, stats);
            }
            if (t.fontName !== figma.mixed) {
                await this.checkField(t, 'fontFamily', t.fontName.family, out, stats);
            }
            if (t.lineHeight !== figma.mixed) {
                const lh = t.lineHeight;
                if (lh.unit === 'PIXELS') {
                    await this.checkField(t, 'lineHeight', lh.value, out, stats);
                }
            }
            if (t.letterSpacing !== figma.mixed) {
                const ls = t.letterSpacing;
                if (ls.unit === 'PIXELS' && ls.value !== 0) {
                    await this.checkField(t, 'letterSpacing', ls.value, out, stats);
                }
            }
        }
        // ── Fill colors ──
        if ('fills' in node && node.fills !== figma.mixed) {
            const fills = node.fills;
            if (Array.isArray(fills)) {
                const inferred = node.inferredVariables;
                for (let i = 0; i < fills.length; i++) {
                    const fill = fills[i];
                    if (fill.type !== 'SOLID' || fill.visible === false)
                        continue;
                    stats.propsChecked++;
                    if ((_a = fill.boundVariables) === null || _a === void 0 ? void 0 : _a.color) {
                        stats.alreadyBound++;
                        continue;
                    }
                    const fillAliases = (_b = inferred === null || inferred === void 0 ? void 0 : inferred.fills) === null || _b === void 0 ? void 0 : _b[i];
                    if (fillAliases && Array.isArray(fillAliases) && fillAliases.length > 0) {
                        // Take first candidate only — multiple tokens can resolve to same color
                        const alias = fillAliases[0];
                        const info = await this.resolveVar(alias.id);
                        if (info) {
                            stats.matched++;
                            out.push({
                                nodeId: node.id, nodeName: node.name,
                                field: 'fill:' + i,
                                rawValue: this.rgbaToHex(fill.color),
                                category: 'Color',
                                candidates: [{ id: alias.id, name: info.name, collection: info.collection, value: info.value, confidence: 2 }],
                            });
                            continue;
                        }
                    }
                    stats.noMatch++;
                }
            }
        }
        // ── Stroke colors (only if visible strokes exist) ──
        if ('strokes' in node && node.strokes !== figma.mixed) {
            const strokes = node.strokes;
            if (Array.isArray(strokes)) {
                const inferred = node.inferredVariables;
                for (let i = 0; i < strokes.length; i++) {
                    const stroke = strokes[i];
                    if (stroke.type !== 'SOLID' || stroke.visible === false)
                        continue;
                    if (typeof stroke.opacity === 'number' && stroke.opacity === 0)
                        continue;
                    stats.propsChecked++;
                    if ((_c = stroke.boundVariables) === null || _c === void 0 ? void 0 : _c.color) {
                        stats.alreadyBound++;
                        continue;
                    }
                    const strokeAliases = (_d = inferred === null || inferred === void 0 ? void 0 : inferred.strokes) === null || _d === void 0 ? void 0 : _d[i];
                    if (strokeAliases && Array.isArray(strokeAliases) && strokeAliases.length > 0) {
                        const alias = strokeAliases[0];
                        const info = await this.resolveVar(alias.id);
                        if (info) {
                            stats.matched++;
                            out.push({
                                nodeId: node.id, nodeName: node.name,
                                field: 'stroke:' + i,
                                rawValue: this.rgbaToHex(stroke.color),
                                category: 'Color',
                                candidates: [{ id: alias.id, name: info.name, collection: info.collection, value: info.value, confidence: 2 }],
                            });
                            continue;
                        }
                    }
                    stats.noMatch++;
                }
            }
        }
    }
    /**
     * Check a single property for matching variables.
     * Uses Figma's inferredVariables as the primary matching mechanism,
     * which automatically includes both local and library variables.
     */
    async checkField(node, field, value, out, stats) {
        stats.propsChecked++;
        // Skip zero/empty values
        if (value === 0 || value === '' || value === undefined || value === null)
            return;
        // Check if already bound to a variable — any binding means skip
        if (this.isBoundToVariable(node, field)) {
            stats.alreadyBound++;
            return;
        }
        // Use Figma's inferredVariables — this knows about ALL accessible variables
        // (local + library) without us having to load them manually.
        const inferred = node.inferredVariables;
        let aliases;
        if (inferred) {
            aliases = inferred[field];
        }
        if (aliases && Array.isArray(aliases) && aliases.length > 0) {
            // Resolve each inferred variable alias to display info
            const candidates = [];
            for (const alias of aliases) {
                const info = await this.resolveVar(alias.id);
                if (info) {
                    candidates.push({
                        id: alias.id,
                        name: info.name,
                        collection: info.collection,
                        value: info.value,
                        confidence: 2,
                    });
                }
            }
            if (candidates.length > 0) {
                stats.matched++;
                out.push({
                    nodeId: node.id,
                    nodeName: node.name,
                    field,
                    rawValue: value,
                    category: FIELD_CATEGORY[field] || 'Other',
                    candidates,
                });
                return;
            }
        }
        // No inferred variables found
        stats.noMatch++;
    }
    /** Check if a property is already bound to any variable. */
    isBoundToVariable(node, field) {
        const bv = node.boundVariables;
        if (!bv)
            return false;
        const val = bv[field];
        if (val === undefined || val === null)
            return false;
        if (Array.isArray(val))
            return val.length > 0;
        return true;
    }
    /** Synchronous check for strip — just checks if any binding exists (orphan or not). */
    isBound(node, field) {
        const bv = node.boundVariables;
        if (!bv)
            return false;
        const val = bv[field];
        if (val === undefined || val === null)
            return false;
        if (Array.isArray(val))
            return val.length > 0;
        return true;
    }
    // ─── Helpers ─────────────────────────────────────────────────
    /** Convert Figma RGBA (0-1 range) to hex string. */
    rgbaToHex(color) {
        const r = Math.round(color.r * 255);
        const g = Math.round(color.g * 255);
        const b = Math.round(color.b * 255);
        return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
    }
    /** Get human-readable label for a field (handles dynamic fill:/stroke: fields). */
    getFieldLabel(field, node) {
        if (FIELD_LABEL[field])
            return FIELD_LABEL[field];
        if (field.startsWith('fill:'))
            return (node === null || node === void 0 ? void 0 : node.type) === 'TEXT' ? 'Text color' : 'Fill color';
        if (field.startsWith('stroke:'))
            return 'Stroke color';
        return field;
    }
    /** Get category for a field (handles dynamic fill:/stroke: fields). */
    getFieldCategory(field) {
        if (FIELD_CATEGORY[field])
            return FIELD_CATEGORY[field];
        if (field.startsWith('fill:') || field.startsWith('stroke:'))
            return 'Color';
        return 'Other';
    }
    // ─── Apply variable bindings ──────────────────────────────────
    async apply(items) {
        let ok = 0;
        let fail = 0;
        const errors = [];
        const catStats = {};
        const trackOk = (field) => {
            const cat = this.getFieldCategory(field);
            if (!catStats[cat])
                catStats[cat] = { ok: 0, fail: 0 };
            catStats[cat].ok++;
        };
        const trackFail = (field) => {
            const cat = this.getFieldCategory(field);
            if (!catStats[cat])
                catStats[cat] = { ok: 0, fail: 0 };
            catStats[cat].fail++;
        };
        console.log('[TokenApplicator] Applying', items.length, 'bindings...');
        const undoEntries = [];
        for (const item of items) {
            const node = await figma.getNodeByIdAsync(item.nodeId);
            const label = this.getFieldLabel(item.field, node);
            try {
                if (!node) {
                    errors.push(label + ': Node not found');
                    trackFail(item.field);
                    fail++;
                    continue;
                }
                const variable = await figma.variables.getVariableByIdAsync(item.variableId);
                if (!variable) {
                    errors.push(label + ': Variable not found');
                    trackFail(item.field);
                    fail++;
                    continue;
                }
                console.log('[TokenApplicator] Binding', label, 'on "' + node.name + '" →', variable.name);
                // Capture previous binding for undo
                const prevVarId = this.getPreviousBinding(node, item.field);
                // ── Fill color binding ──
                if (item.field.startsWith('fill:')) {
                    const fillIndex = parseInt(item.field.split(':')[1]);
                    const fills = [...node.fills];
                    fills[fillIndex] = figma.variables.setBoundVariableForPaint(fills[fillIndex], 'color', variable);
                    node.fills = fills;
                    console.log('[TokenApplicator] ✓', label);
                    undoEntries.push({ nodeId: item.nodeId, field: item.field, previousVarId: prevVarId });
                    trackOk(item.field);
                    ok++;
                    continue;
                }
                // ── Stroke color binding ──
                if (item.field.startsWith('stroke:')) {
                    const strokeIndex = parseInt(item.field.split(':')[1]);
                    const strokes = [...node.strokes];
                    strokes[strokeIndex] = figma.variables.setBoundVariableForPaint(strokes[strokeIndex], 'color', variable);
                    node.strokes = strokes;
                    console.log('[TokenApplicator] ✓', label);
                    undoEntries.push({ nodeId: item.nodeId, field: item.field, previousVarId: prevVarId });
                    trackOk(item.field);
                    ok++;
                    continue;
                }
                // Text nodes: load fonts before modifying
                if (node.type === 'TEXT') {
                    await this.loadFonts(node);
                }
                // For text-specific fields, try node-level first, fall back to range-based
                if (node.type === 'TEXT' && TEXT_FIELDS.has(item.field)) {
                    try {
                        node.setBoundVariable(item.field, variable);
                    }
                    catch (e) {
                        console.log('[TokenApplicator] Fallback to setRangeBoundVariable for', item.field);
                        const t = node;
                        t.setRangeBoundVariable(0, t.characters.length, item.field, variable);
                    }
                }
                else {
                    node.setBoundVariable(item.field, variable);
                }
                console.log('[TokenApplicator] ✓', label);
                undoEntries.push({ nodeId: item.nodeId, field: item.field, previousVarId: prevVarId });
                trackOk(item.field);
                ok++;
            }
            catch (err) {
                console.error('[TokenApplicator] ✗', label, '-', err);
                errors.push(label + ': ' + String(err));
                trackFail(item.field);
                fail++;
            }
        }
        console.log('[TokenApplicator] Done: ok=' + ok + ', fail=' + fail);
        if (undoEntries.length > 0) {
            this.undoStack = undoEntries;
            this.undoAction = 'apply';
        }
        figma.ui.postMessage({ type: 'applied', ok, fail, errors, categoryStats: catStats, canUndo: undoEntries.length > 0 });
    }
    // ─── Strip variable bindings ─────────────────────────────────
    async strip() {
        const sel = figma.currentPage.selection;
        if (sel.length === 0) {
            figma.ui.postMessage({ type: 'error', message: 'Select at least one element to strip.' });
            return;
        }
        figma.ui.postMessage({ type: 'stripping' });
        let stripped = 0;
        const catStats = {};
        const undoEntries = [];
        const onStrip = (cat, entry) => {
            stripped++;
            catStats[cat] = (catStats[cat] || 0) + 1;
            undoEntries.push(entry);
        };
        for (const node of sel) {
            await this.walkStrip(node, 0, onStrip);
        }
        if (undoEntries.length > 0) {
            this.undoStack = undoEntries;
            this.undoAction = 'strip';
        }
        console.log('[TokenApplicator] Stripped', stripped, 'bindings:', JSON.stringify(catStats));
        figma.ui.postMessage({ type: 'stripped', stripped, categoryStats: catStats, canUndo: undoEntries.length > 0 });
    }
    async walkStrip(node, depth, onStrip) {
        if (depth > 100)
            return;
        await this.stripNode(node, onStrip);
        // Don't walk into instance children — their properties can't be stripped
        if ('children' in node && node.type !== 'INSTANCE') {
            for (const child of node.children) {
                await this.walkStrip(child, depth + 1, onStrip);
            }
        }
    }
    async stripNode(node, onStrip) {
        var _a, _b;
        // Strip scalar fields (spacing, radius, stroke weight)
        const scalarFields = Object.keys(FIELD_CATEGORY).filter(f => !TEXT_FIELDS.has(f));
        for (const field of scalarFields) {
            if (this.isBound(node, field)) {
                const prevVarId = this.getPreviousBinding(node, field);
                try {
                    node.setBoundVariable(field, null);
                    onStrip(FIELD_CATEGORY[field], { nodeId: node.id, field, previousVarId: prevVarId });
                }
                catch (e) {
                    console.log('[TokenApplicator] Strip failed for', field, ':', e);
                }
            }
        }
        // Strip text fields
        if (node.type === 'TEXT') {
            await this.loadFonts(node);
            const textFields = ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing'];
            for (const field of textFields) {
                if (this.isBound(node, field)) {
                    const prevVarId = this.getPreviousBinding(node, field);
                    try {
                        node.setBoundVariable(field, null);
                        onStrip('Typography', { nodeId: node.id, field, previousVarId: prevVarId });
                    }
                    catch (_c) {
                        try {
                            const t = node;
                            t.setRangeBoundVariable(0, t.characters.length, field, null);
                            onStrip('Typography', { nodeId: node.id, field, previousVarId: prevVarId });
                        }
                        catch (e2) {
                            console.log('[TokenApplicator] Strip text failed for', field, ':', e2);
                        }
                    }
                }
            }
        }
        // Strip fill colors
        if ('fills' in node && node.fills !== figma.mixed) {
            const fills = node.fills;
            if (Array.isArray(fills)) {
                let changed = false;
                const newFills = [...fills];
                for (let i = 0; i < fills.length; i++) {
                    const fill = fills[i];
                    if (fill.type === 'SOLID' && ((_a = fill.boundVariables) === null || _a === void 0 ? void 0 : _a.color)) {
                        const prevVarId = fill.boundVariables.color.id || null;
                        newFills[i] = figma.variables.setBoundVariableForPaint(fill, 'color', null);
                        changed = true;
                        onStrip('Color', { nodeId: node.id, field: 'fill:' + i, previousVarId: prevVarId });
                    }
                }
                if (changed)
                    node.fills = newFills;
            }
        }
        // Strip stroke colors
        if ('strokes' in node && node.strokes !== figma.mixed) {
            const strokes = node.strokes;
            if (Array.isArray(strokes)) {
                let changed = false;
                const newStrokes = [...strokes];
                for (let i = 0; i < strokes.length; i++) {
                    const stroke = strokes[i];
                    if (stroke.type === 'SOLID' && ((_b = stroke.boundVariables) === null || _b === void 0 ? void 0 : _b.color)) {
                        const prevVarId = stroke.boundVariables.color.id || null;
                        newStrokes[i] = figma.variables.setBoundVariableForPaint(stroke, 'color', null);
                        changed = true;
                        onStrip('Color', { nodeId: node.id, field: 'stroke:' + i, previousVarId: prevVarId });
                    }
                }
                if (changed)
                    node.strokes = newStrokes;
            }
        }
    }
    /** Get the current variable binding ID for a field, or null if unbound. */
    getPreviousBinding(node, field) {
        var _a, _b, _c, _d, _e;
        if (field.startsWith('fill:')) {
            const idx = parseInt(field.split(':')[1]);
            const fills = node.fills;
            if (Array.isArray(fills) && ((_b = (_a = fills[idx]) === null || _a === void 0 ? void 0 : _a.boundVariables) === null || _b === void 0 ? void 0 : _b.color)) {
                return fills[idx].boundVariables.color.id || null;
            }
            return null;
        }
        if (field.startsWith('stroke:')) {
            const idx = parseInt(field.split(':')[1]);
            const strokes = node.strokes;
            if (Array.isArray(strokes) && ((_d = (_c = strokes[idx]) === null || _c === void 0 ? void 0 : _c.boundVariables) === null || _d === void 0 ? void 0 : _d.color)) {
                return strokes[idx].boundVariables.color.id || null;
            }
            return null;
        }
        const bv = node.boundVariables;
        if (!bv)
            return null;
        const val = bv[field];
        if (!val)
            return null;
        if (Array.isArray(val))
            return val.length > 0 ? ((_e = val[0]) === null || _e === void 0 ? void 0 : _e.id) || null : null;
        return val.id || null;
    }
    // ─── Undo last action ──────────────────────────────────────────
    async undo() {
        if (this.undoStack.length === 0) {
            figma.ui.postMessage({ type: 'error', message: 'Nothing to undo.' });
            return;
        }
        const action = this.undoAction;
        const entries = this.undoStack;
        this.undoStack = [];
        this.undoAction = null;
        let ok = 0;
        let fail = 0;
        for (const entry of entries) {
            try {
                const node = await figma.getNodeByIdAsync(entry.nodeId);
                if (!node) {
                    fail++;
                    continue;
                }
                if (action === 'apply') {
                    // Undo apply: restore previous binding (or unbind if was free)
                    if (entry.previousVarId) {
                        const variable = await figma.variables.getVariableByIdAsync(entry.previousVarId);
                        if (variable) {
                            await this.bindField(node, entry.field, variable);
                        }
                        else {
                            await this.unbindField(node, entry.field);
                        }
                    }
                    else {
                        await this.unbindField(node, entry.field);
                    }
                    ok++;
                }
                else if (action === 'strip') {
                    // Undo strip: re-bind the previously bound variable
                    if (entry.previousVarId) {
                        const variable = await figma.variables.getVariableByIdAsync(entry.previousVarId);
                        if (variable) {
                            await this.bindField(node, entry.field, variable);
                            ok++;
                        }
                        else {
                            fail++;
                        }
                    }
                    else {
                        fail++;
                    }
                }
            }
            catch (err) {
                console.error('[TokenApplicator] Undo failed for', entry.field, ':', err);
                fail++;
            }
        }
        console.log('[TokenApplicator] Undo complete: ok=' + ok + ', fail=' + fail);
        figma.ui.postMessage({ type: 'undone', ok, fail, total: entries.length });
    }
    /** Bind a variable to a field on a node. */
    async bindField(node, field, variable) {
        if (field.startsWith('fill:')) {
            const idx = parseInt(field.split(':')[1]);
            const fills = [...node.fills];
            fills[idx] = figma.variables.setBoundVariableForPaint(fills[idx], 'color', variable);
            node.fills = fills;
            return;
        }
        if (field.startsWith('stroke:')) {
            const idx = parseInt(field.split(':')[1]);
            const strokes = [...node.strokes];
            strokes[idx] = figma.variables.setBoundVariableForPaint(strokes[idx], 'color', variable);
            node.strokes = strokes;
            return;
        }
        if (node.type === 'TEXT')
            await this.loadFonts(node);
        if (node.type === 'TEXT' && TEXT_FIELDS.has(field)) {
            try {
                node.setBoundVariable(field, variable);
            }
            catch (_a) {
                const t = node;
                t.setRangeBoundVariable(0, t.characters.length, field, variable);
            }
        }
        else {
            node.setBoundVariable(field, variable);
        }
    }
    /** Unbind a variable from a field on a node. */
    async unbindField(node, field) {
        if (field.startsWith('fill:')) {
            const idx = parseInt(field.split(':')[1]);
            const fills = [...node.fills];
            fills[idx] = figma.variables.setBoundVariableForPaint(fills[idx], 'color', null);
            node.fills = fills;
            return;
        }
        if (field.startsWith('stroke:')) {
            const idx = parseInt(field.split(':')[1]);
            const strokes = [...node.strokes];
            strokes[idx] = figma.variables.setBoundVariableForPaint(strokes[idx], 'color', null);
            node.strokes = strokes;
            return;
        }
        if (node.type === 'TEXT')
            await this.loadFonts(node);
        if (node.type === 'TEXT' && TEXT_FIELDS.has(field)) {
            try {
                node.setBoundVariable(field, null);
            }
            catch (_a) {
                const t = node;
                t.setRangeBoundVariable(0, t.characters.length, field, null);
            }
        }
        else {
            node.setBoundVariable(field, null);
        }
    }
    /** Load all fonts used in a text node so properties can be modified. */
    async loadFonts(t) {
        if (t.fontName !== figma.mixed) {
            await figma.loadFontAsync(t.fontName);
        }
        else {
            const loaded = new Set();
            for (let i = 0; i < t.characters.length; i++) {
                const fn = t.getRangeFontName(i, i + 1);
                const key = fn.family + '|' + fn.style;
                if (!loaded.has(key)) {
                    loaded.add(key);
                    await figma.loadFontAsync(fn);
                }
            }
        }
    }
}
// ─── Start ──────────────────────────────────────────────────────
new TokenApplicator();
