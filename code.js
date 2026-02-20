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
        figma.showUI(__html__, { width: 420, height: 640 });
        figma.ui.onmessage = async (msg) => {
            try {
                if (msg.type === 'scan')
                    await this.scan();
                else if (msg.type === 'apply')
                    await this.apply(msg.items);
                else if (msg.type === 'strip')
                    await this.strip();
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
        const matches = [];
        const stats = { nodesScanned: 0, propsChecked: 0, alreadyBound: 0, orphaned: 0, noMatch: 0, matched: 0 };
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
        if ('children' in node) {
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
        // ── Stroke weight (only if node has visible strokes) ──
        if ('strokes' in node && node.strokes !== figma.mixed) {
            const strokes = node.strokes;
            const hasVisibleStrokes = Array.isArray(strokes) && strokes.length > 0 &&
                strokes.some((s) => s.visible !== false);
            if (hasVisibleStrokes && 'strokeWeight' in node && typeof node.strokeWeight === 'number') {
                await this.checkField(node, 'strokeWeight', node.strokeWeight, out, stats);
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
                        const colorVar = await this.resolveVar(fill.boundVariables.color.id);
                        if (colorVar) {
                            stats.alreadyBound++;
                            continue;
                        }
                        stats.orphaned++; // Orphaned — fall through to rebind
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
                    stats.propsChecked++;
                    if ((_c = stroke.boundVariables) === null || _c === void 0 ? void 0 : _c.color) {
                        const colorVar = await this.resolveVar(stroke.boundVariables.color.id);
                        if (colorVar) {
                            stats.alreadyBound++;
                            continue;
                        }
                        stats.orphaned++; // Orphaned — fall through to rebind
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
        // Check if already bound to a variable
        const bindState = await this.checkBinding(node, field);
        if (bindState === 'bound') {
            stats.alreadyBound++;
            return;
        }
        if (bindState === 'orphan') {
            stats.orphaned++;
            // Fall through — orphaned bindings should be rebindable
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
    /** Check if a property is already bound to a resolvable variable.
     *  Returns 'bound' if live, 'orphan' if bound but unresolvable, 'free' if unbound. */
    async checkBinding(node, field) {
        var _a;
        const bv = node.boundVariables;
        if (!bv)
            return 'free';
        const val = bv[field];
        if (val === undefined || val === null)
            return 'free';
        // Extract the variable ID from the binding
        let varId;
        if (Array.isArray(val)) {
            if (val.length === 0)
                return 'free';
            varId = (_a = val[0]) === null || _a === void 0 ? void 0 : _a.id;
        }
        else if (typeof val === 'object' && val.id) {
            varId = val.id;
        }
        if (!varId)
            return 'bound'; // Can't determine, assume live
        // Try to resolve — if it fails, it's an orphan
        try {
            const variable = await figma.variables.getVariableByIdAsync(varId);
            return variable ? 'bound' : 'orphan';
        }
        catch (_b) {
            return 'orphan';
        }
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
                // ── Fill color binding ──
                if (item.field.startsWith('fill:')) {
                    const fillIndex = parseInt(item.field.split(':')[1]);
                    const fills = [...node.fills];
                    fills[fillIndex] = figma.variables.setBoundVariableForPaint(fills[fillIndex], 'color', variable);
                    node.fills = fills;
                    console.log('[TokenApplicator] ✓', label);
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
        figma.ui.postMessage({ type: 'applied', ok, fail, errors, categoryStats: catStats });
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
        const onStrip = (cat) => {
            stripped++;
            catStats[cat] = (catStats[cat] || 0) + 1;
        };
        for (const node of sel) {
            await this.walkStrip(node, 0, onStrip);
        }
        console.log('[TokenApplicator] Stripped', stripped, 'bindings:', JSON.stringify(catStats));
        figma.ui.postMessage({ type: 'stripped', stripped, categoryStats: catStats });
    }
    async walkStrip(node, depth, onStrip) {
        if (depth > 100)
            return;
        await this.stripNode(node, onStrip);
        if ('children' in node) {
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
                try {
                    node.setBoundVariable(field, null);
                    onStrip(FIELD_CATEGORY[field]);
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
                    try {
                        node.setBoundVariable(field, null);
                        onStrip('Typography');
                    }
                    catch (_c) {
                        try {
                            const t = node;
                            t.setRangeBoundVariable(0, t.characters.length, field, null);
                            onStrip('Typography');
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
                        newFills[i] = figma.variables.setBoundVariableForPaint(fill, 'color', null);
                        changed = true;
                        onStrip('Color');
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
                        newStrokes[i] = figma.variables.setBoundVariableForPaint(stroke, 'color', null);
                        changed = true;
                        onStrip('Color');
                    }
                }
                if (changed)
                    node.strokes = newStrokes;
            }
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
