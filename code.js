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
    fontSize: 'Font size',
    fontFamily: 'Font family',
    fontWeight: 'Font weight',
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
    fontSize: 'Typography',
    fontFamily: 'Typography',
    fontWeight: 'Typography',
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
        // Pre-loaded map of ALL local variable IDs → resolved info
        // Built once per scan using only getLocalVariablesAsync (never getVariableByIdAsync)
        // to avoid triggering mode duplication on library variable collections.
        this.localVarMap = new Map();
        // Cache: collection ID → name
        this.colCache = new Map();
        // Cache: all available color variables for manual matching fallback
        this.colorVarCache = null;
        // Cache: all available FLOAT and STRING variables for manual matching fallback
        this.floatVarCache = null;
        this.stringVarCache = null;
        // Cache: available text styles for text style matching
        this.textStyleCache = null;
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
        figma.ui.postMessage({ type: 'ready' });
    }
    // ─── Resolve a VariableAlias to display info ──────────────────
    /**
     * Resolve a variable ID to its name, collection, and value.
     * Uses ONLY the pre-built localVarMap — never calls getVariableByIdAsync,
     * because that API triggers mode duplication on library variable collections.
     */
    async resolveVar(id) {
        if (this.varCache.has(id))
            return this.varCache.get(id);
        // Look up in local variable map (built during scan from getLocalVariablesAsync)
        const local = this.localVarMap.get(id);
        if (local) {
            this.varCache.set(id, local);
            return local;
        }
        // Not a local variable — this is a library variable from inferredVariables.
        // We deliberately skip it to avoid triggering mode duplication.
        this.varCache.set(id, null);
        return null;
    }
    /**
     * Pre-load ALL local variables into localVarMap in a single pass.
     * Resolves alias chains ONLY through other local variables (never calls getVariableByIdAsync).
     * Also pre-builds colorVarCache, floatVarCache, and stringVarCache for manual matching.
     */
    async buildLocalVarMap() {
        this.localVarMap.clear();
        // First pass: load all local variables into a temporary map
        const allVars = new Map();
        for (const type of ['COLOR', 'FLOAT', 'STRING']) {
            try {
                const vars = await figma.variables.getLocalVariablesAsync(type);
                for (const v of vars)
                    allVars.set(v.id, v);
            }
            catch (e) {
                console.log('[TokenApplicator] Error loading local', type, 'variables:', e);
            }
        }
        // Pre-build typed caches
        const colors = [];
        const floats = [];
        const strings = [];
        // Second pass: resolve values (alias chains followed ONLY through local variables)
        for (const [id, v] of allVars) {
            const colName = this.colCache.get(v.variableCollectionId) || 'Local';
            const modeId = Object.keys(v.valuesByMode)[0];
            if (!modeId)
                continue;
            let val = v.valuesByMode[modeId];
            // Follow alias chain ONLY through local variables
            let depth = 0;
            while (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && depth < 10) {
                const next = allVars.get(val.id);
                if (!next)
                    break; // Target is not local — stop resolving
                const nextMode = Object.keys(next.valuesByMode)[0];
                if (!nextMode)
                    break;
                val = next.valuesByMode[nextMode];
                depth++;
            }
            // Skip z-index variables — not applicable to visual properties
            const nameLower = v.name.toLowerCase();
            if (nameLower.includes('z-index') || nameLower.includes('z_index') || nameLower.includes('zindex'))
                continue;
            // Store resolved value in appropriate caches
            if (typeof val === 'number') {
                this.localVarMap.set(id, { name: v.name, collection: colName, value: val });
                if (v.resolvedType === 'FLOAT') {
                    floats.push({ id, name: v.name, collection: colName, value: val });
                }
            }
            else if (typeof val === 'string') {
                this.localVarMap.set(id, { name: v.name, collection: colName, value: val });
                if (v.resolvedType === 'STRING') {
                    strings.push({ id, name: v.name, collection: colName, value: val });
                }
            }
            else if (val && typeof val === 'object' && 'r' in val && 'g' in val && 'b' in val) {
                const hex = this.rgbaToHex(val);
                this.localVarMap.set(id, { name: v.name, collection: colName, value: hex });
                if (v.resolvedType === 'COLOR') {
                    colors.push({ id, name: v.name, collection: colName, r: val.r, g: val.g, b: val.b });
                }
            }
        }
        this.colorVarCache = colors;
        this.floatVarCache = floats;
        this.stringVarCache = strings;
        console.log('[TokenApplicator] Built local var map:', this.localVarMap.size, 'variables (' +
            colors.length + ' color, ' + floats.length + ' float, ' + strings.length + ' string)');
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
        // Clear caches so stale entries don't cause false re-detections
        this.varCache.clear();
        this.colorVarCache = null;
        this.floatVarCache = null;
        this.stringVarCache = null;
        this.textStyleCache = null;
        // Pre-load ALL local variables in one pass — this builds localVarMap
        // and all typed caches WITHOUT calling getVariableByIdAsync (which
        // triggers mode duplication on library variable collections).
        await this.buildLocalVarMap();
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
        if ('children' in node) {
            for (const child of node.children) {
                await this.walk(child, out, stats, depth + 1);
            }
        }
    }
    async inspect(node, out, stats) {
        var _a, _b, _c, _d, _e, _f;
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
        // Note: strokeWeight scanning disabled — bindings don't reliably persist
        // on component variants and instances, causing phantom re-detections.
        // ── Text properties ──
        // Each field is wrapped in its own try/catch so a failure in one
        // (e.g. fontFamily) doesn't prevent detection of the others.
        if (node.type === 'TEXT') {
            const t = node;
            try {
                if (typeof t.fontSize === 'number') {
                    await this.checkField(t, 'fontSize', t.fontSize, out, stats);
                }
            }
            catch (e) {
                console.log('[TokenApplicator] Error checking fontSize:', e);
            }
            try {
                if (t.fontName !== figma.mixed) {
                    await this.checkField(t, 'fontFamily', t.fontName.family, out, stats);
                }
            }
            catch (e) {
                console.log('[TokenApplicator] Error checking fontFamily:', e);
            }
            try {
                const fw = t.fontWeight;
                if (fw !== undefined && fw !== figma.mixed && typeof fw === 'number') {
                    await this.checkField(t, 'fontWeight', fw, out, stats);
                }
            }
            catch (e) {
                console.log('[TokenApplicator] Error checking fontWeight:', e);
            }
            try {
                if (t.lineHeight !== figma.mixed) {
                    const lh = t.lineHeight;
                    if (lh.unit === 'PIXELS') {
                        await this.checkField(t, 'lineHeight', lh.value, out, stats);
                    }
                }
            }
            catch (e) {
                console.log('[TokenApplicator] Error checking lineHeight:', e);
            }
            try {
                if (t.letterSpacing !== figma.mixed) {
                    const ls = t.letterSpacing;
                    if (ls.unit === 'PIXELS' && ls.value !== 0) {
                        await this.checkField(t, 'letterSpacing', ls.value, out, stats);
                    }
                }
            }
            catch (e) {
                console.log('[TokenApplicator] Error checking letterSpacing:', e);
            }
            // ── Text style matching ──
            // If the node has no text style applied, try to match its properties to one
            try {
                const styleId = t.textStyleId;
                const hasStyle = styleId && styleId !== '' && styleId !== figma.mixed;
                if (!hasStyle) {
                    const match = await this.findTextStyleMatch(t);
                    if (match) {
                        stats.propsChecked++;
                        stats.matched++;
                        out.push({
                            nodeId: t.id,
                            nodeName: t.name,
                            field: 'textStyle',
                            rawValue: match.description,
                            category: 'Text Style',
                            candidates: [{
                                    id: match.id + '|' + match.key,
                                    name: match.name,
                                    collection: 'Text Styles',
                                    value: match.description,
                                    confidence: 3, // highest confidence — full style match
                                }],
                        });
                    }
                }
            }
            catch (e) {
                console.log('[TokenApplicator] Error checking text style:', e);
            }
            // ── Text fill color ──
            // Handled here (not in generic fill check) because text fills
            // are often figma.mixed even when all characters share the same color.
            try {
                let textFills = null;
                if (t.fills !== figma.mixed) {
                    textFills = t.fills;
                }
                else {
                    // Mixed fills — sample first character to get its fill
                    if (t.characters.length > 0) {
                        const rangeFills = t.getRangeFills(0, 1);
                        if (rangeFills !== figma.mixed && Array.isArray(rangeFills)) {
                            textFills = rangeFills;
                        }
                    }
                }
                console.log('[TokenApplicator] TEXT "' + t.name + '" fills:', textFills ? JSON.stringify(textFills.map((f) => { var _a; return ({ type: f.type, color: f.color ? this.rgbaToHex(f.color) : '?', bound: !!((_a = f.boundVariables) === null || _a === void 0 ? void 0 : _a.color) }); })) : 'null');
                if (textFills && Array.isArray(textFills)) {
                    const inferred = t.inferredVariables;
                    for (let i = 0; i < textFills.length; i++) {
                        const fill = textFills[i];
                        if (fill.type !== 'SOLID' || fill.visible === false)
                            continue;
                        stats.propsChecked++;
                        if ((_a = fill.boundVariables) === null || _a === void 0 ? void 0 : _a.color) {
                            stats.alreadyBound++;
                            continue;
                        }
                        let found = false;
                        // Primary: use Figma's inferredVariables
                        const fillAliases = (_b = inferred === null || inferred === void 0 ? void 0 : inferred.fills) === null || _b === void 0 ? void 0 : _b[i];
                        if (fillAliases && Array.isArray(fillAliases) && fillAliases.length > 0) {
                            const alias = fillAliases[0];
                            const info = await this.resolveVar(alias.id);
                            if (info) {
                                stats.matched++;
                                out.push({
                                    nodeId: t.id, nodeName: t.name,
                                    field: 'fill:' + i,
                                    rawValue: this.rgbaToHex(fill.color),
                                    category: 'Color',
                                    candidates: [{ id: alias.id, name: info.name, collection: info.collection, value: info.value, confidence: 2 }],
                                });
                                found = true;
                            }
                        }
                        // Fallback: manual color variable search
                        if (!found) {
                            console.log('[TokenApplicator] inferredVariables missed text fill, trying manual match for', this.rgbaToHex(fill.color));
                            const manualCandidates = await this.findColorMatch(fill.color);
                            console.log('[TokenApplicator] Manual match found', manualCandidates.length, 'candidates');
                            if (manualCandidates.length > 0) {
                                stats.matched++;
                                out.push({
                                    nodeId: t.id, nodeName: t.name,
                                    field: 'fill:' + i,
                                    rawValue: this.rgbaToHex(fill.color),
                                    category: 'Color',
                                    candidates: manualCandidates,
                                });
                                found = true;
                            }
                        }
                        if (!found)
                            stats.noMatch++;
                    }
                }
            }
            catch (e) {
                console.log('[TokenApplicator] Error checking text fill color:', e);
            }
        }
        // ── Fill colors (non-text nodes) ──
        if (node.type !== 'TEXT' && 'fills' in node && node.fills !== figma.mixed) {
            const fills = node.fills;
            if (Array.isArray(fills)) {
                const inferred = node.inferredVariables;
                for (let i = 0; i < fills.length; i++) {
                    const fill = fills[i];
                    if (fill.type !== 'SOLID' || fill.visible === false)
                        continue;
                    stats.propsChecked++;
                    if ((_c = fill.boundVariables) === null || _c === void 0 ? void 0 : _c.color) {
                        stats.alreadyBound++;
                        continue;
                    }
                    let found = false;
                    // Primary: use Figma's inferredVariables
                    const fillAliases = (_d = inferred === null || inferred === void 0 ? void 0 : inferred.fills) === null || _d === void 0 ? void 0 : _d[i];
                    if (fillAliases && Array.isArray(fillAliases) && fillAliases.length > 0) {
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
                            found = true;
                        }
                    }
                    // Fallback: manual color variable search
                    if (!found) {
                        const manualCandidates = await this.findColorMatch(fill.color);
                        if (manualCandidates.length > 0) {
                            stats.matched++;
                            out.push({
                                nodeId: node.id, nodeName: node.name,
                                field: 'fill:' + i,
                                rawValue: this.rgbaToHex(fill.color),
                                category: 'Color',
                                candidates: manualCandidates,
                            });
                            found = true;
                        }
                    }
                    if (!found)
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
                    if ((_e = stroke.boundVariables) === null || _e === void 0 ? void 0 : _e.color) {
                        stats.alreadyBound++;
                        continue;
                    }
                    let found = false;
                    // Primary: use Figma's inferredVariables
                    const strokeAliases = (_f = inferred === null || inferred === void 0 ? void 0 : inferred.strokes) === null || _f === void 0 ? void 0 : _f[i];
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
                            found = true;
                        }
                    }
                    // Fallback: manual color variable search
                    if (!found) {
                        const manualCandidates = await this.findColorMatch(stroke.color);
                        if (manualCandidates.length > 0) {
                            stats.matched++;
                            out.push({
                                nodeId: node.id, nodeName: node.name,
                                field: 'stroke:' + i,
                                rawValue: this.rgbaToHex(stroke.color),
                                category: 'Color',
                                candidates: manualCandidates,
                            });
                            found = true;
                        }
                    }
                    if (!found)
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
        // Fallback: manual variable search when inferredVariables fails
        let manualCandidates = [];
        if (typeof value === 'string') {
            manualCandidates = await this.findStringMatch(value);
        }
        else if (typeof value === 'number') {
            manualCandidates = await this.findFloatMatch(value);
        }
        if (manualCandidates.length > 0) {
            console.log('[TokenApplicator] Manual match for', field, '=', value, '→', manualCandidates.map(c => c.name).join(', '));
            stats.matched++;
            out.push({
                nodeId: node.id,
                nodeName: node.name,
                field,
                rawValue: value,
                category: FIELD_CATEGORY[field] || 'Other',
                candidates: manualCandidates,
            });
            return;
        }
        // No match found at all
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
    /** Get pre-loaded color variables for manual matching.
     *  Built by buildLocalVarMap() — no getVariableByIdAsync calls. */
    async getColorVariables() {
        if (!this.colorVarCache)
            await this.buildLocalVarMap();
        return this.colorVarCache;
    }
    /** Check if two colors match (Figma uses 0-1 range, tolerance handles rounding). */
    colorsMatch(a, b) {
        // Tolerance of ~1/255 to handle rounding differences
        const tol = 0.005;
        return Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;
    }
    /** Manual fallback: find color variables matching a given RGB color. */
    async findColorMatch(color) {
        const colorVars = await this.getColorVariables();
        const candidates = [];
        for (const cv of colorVars) {
            if (this.colorsMatch(color, cv)) {
                candidates.push({
                    id: cv.id,
                    name: cv.name,
                    collection: cv.collection,
                    value: this.rgbaToHex(cv),
                    confidence: 1, // lower than inferredVariables (confidence: 2)
                });
            }
        }
        return candidates;
    }
    /** Get pre-loaded string variables for manual matching.
     *  Built by buildLocalVarMap() — no getVariableByIdAsync calls. */
    async getStringVariables() {
        if (!this.stringVarCache)
            await this.buildLocalVarMap();
        return this.stringVarCache;
    }
    /** Get pre-loaded float variables for manual matching.
     *  Built by buildLocalVarMap() — no getVariableByIdAsync calls. */
    async getFloatVariables() {
        if (!this.floatVarCache)
            await this.buildLocalVarMap();
        return this.floatVarCache;
    }
    /** Manual fallback: find STRING variables matching a given value. */
    async findStringMatch(value) {
        const stringVars = await this.getStringVariables();
        const candidates = [];
        const lower = value.toLowerCase();
        for (const sv of stringVars) {
            if (sv.value.toLowerCase() === lower) {
                candidates.push({
                    id: sv.id,
                    name: sv.name,
                    collection: sv.collection,
                    value: sv.value,
                    confidence: 1,
                });
            }
        }
        return candidates;
    }
    /** Manual fallback: find FLOAT variables matching a given numeric value. */
    async findFloatMatch(value) {
        const floatVars = await this.getFloatVariables();
        const candidates = [];
        const tol = 0.01; // tolerance for floating point comparison
        for (const fv of floatVars) {
            if (Math.abs(fv.value - value) < tol) {
                candidates.push({
                    id: fv.id,
                    name: fv.name,
                    collection: fv.collection,
                    value: fv.value,
                    confidence: 1,
                });
            }
        }
        return candidates;
    }
    /** Load all available text styles (local) for text style matching. */
    async getTextStyles() {
        if (this.textStyleCache)
            return this.textStyleCache;
        const result = [];
        const seenIds = new Set();
        /** Extract text style properties into our cache format. */
        const extract = (style) => {
            if (seenIds.has(style.id))
                return;
            seenIds.add(style.id);
            let lh = null;
            if (style.lineHeight && style.lineHeight.unit === 'PIXELS') {
                lh = { unit: 'PIXELS', value: style.lineHeight.value };
            }
            else if (style.lineHeight && style.lineHeight.unit === 'PERCENT') {
                lh = { unit: 'PERCENT', value: style.lineHeight.value };
            }
            let ls = null;
            if (style.letterSpacing && style.letterSpacing.unit === 'PIXELS') {
                ls = { unit: 'PIXELS', value: style.letterSpacing.value };
            }
            else if (style.letterSpacing && style.letterSpacing.unit === 'PERCENT') {
                ls = { unit: 'PERCENT', value: style.letterSpacing.value };
            }
            result.push({
                id: style.id,
                key: style.key,
                name: style.name,
                fontFamily: style.fontName.family,
                fontStyle: style.fontName.style,
                fontSize: style.fontSize,
                lineHeight: lh,
                letterSpacing: ls,
            });
        };
        // 1. Local text styles (defined in this file)
        try {
            const localStyles = await figma.getLocalTextStylesAsync();
            for (const style of localStyles)
                extract(style);
        }
        catch (e) {
            console.log('[TokenApplicator] Error loading local text styles:', e);
        }
        console.log('[TokenApplicator] Cached', result.length, 'local text styles');
        this.textStyleCache = result;
        return result;
    }
    /** Find a text style matching the given text node properties. */
    async findTextStyleMatch(t) {
        if (t.fontName === figma.mixed || t.fontSize === figma.mixed)
            return null;
        const font = t.fontName;
        const size = t.fontSize;
        const styles = await this.getTextStyles();
        if (!styles || styles.length === 0) {
            console.log('[TokenApplicator] No text styles available to match against');
            return null;
        }
        console.log('[TokenApplicator] Matching text: family="' + font.family + '" style="' + font.style + '" size=' + size);
        console.log('[TokenApplicator] Available text styles (' + styles.length + '):');
        for (const s of styles) {
            console.log('  "' + s.name + '": family="' + s.fontFamily + '" style="' + s.fontStyle + '" size=' + s.fontSize);
        }
        for (const style of styles) {
            // Must match: font family (case-insensitive), font style (case-insensitive), font size
            if (style.fontFamily.toLowerCase() !== font.family.toLowerCase())
                continue;
            if (style.fontStyle.toLowerCase() !== font.style.toLowerCase())
                continue;
            if (Math.abs(style.fontSize - size) > 0.5)
                continue;
            const desc = font.family + ' ' + font.style + ' ' + size + 'px';
            console.log('[TokenApplicator] ✓ Matched text style: "' + style.name + '" (id=' + style.id + ', key=' + style.key + ')');
            return { id: style.id, key: style.key, name: style.name, description: desc };
        }
        console.log('[TokenApplicator] No text style matched');
        return null;
    }
    /** Get human-readable label for a field (handles dynamic fill:/stroke: fields). */
    getFieldLabel(field, node) {
        if (field === 'textStyle')
            return 'Text style';
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
        if (field === 'textStyle')
            return 'Text Style';
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
                // ── Text style application (uses style ID, not variable ID) ──
                if (item.field === 'textStyle') {
                    if (node.type !== 'TEXT') {
                        errors.push(label + ': Not a text node');
                        trackFail(item.field);
                        fail++;
                        continue;
                    }
                    const t = node;
                    await this.loadFonts(t);
                    const prevStyleId = (typeof t.textStyleId === 'string' && t.textStyleId) ? t.textStyleId : null;
                    // Decode style ID from the encoded candidate ID
                    const styleId = item.variableId.split('|')[0];
                    console.log('[TokenApplicator] Applying text style on "' + t.name + '" → id="' + styleId + '"');
                    let styleApplied = false;
                    // Approach 1: direct style ID assignment
                    try {
                        t.textStyleId = styleId;
                        if (t.textStyleId === styleId) {
                            styleApplied = true;
                        }
                        else {
                            console.log('[TokenApplicator] textStyleId did not stick, got:', t.textStyleId);
                        }
                    }
                    catch (e1) {
                        console.log('[TokenApplicator] Direct textStyleId failed:', e1);
                    }
                    // Approach 2: range-based
                    if (!styleApplied) {
                        try {
                            t.setRangeTextStyleId(0, t.characters.length, styleId);
                            styleApplied = true;
                        }
                        catch (e2) {
                            console.log('[TokenApplicator] setRangeTextStyleId also failed:', e2);
                        }
                    }
                    if (styleApplied) {
                        console.log('[TokenApplicator] ✓', label);
                        undoEntries.push({ nodeId: item.nodeId, field: 'textStyle', previousVarId: prevStyleId });
                        trackOk(item.field);
                        ok++;
                    }
                    else {
                        errors.push(label + ': Could not apply text style');
                        trackFail(item.field);
                        fail++;
                    }
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
        // Strip text style
        if (node.type === 'TEXT') {
            const t = node;
            const styleId = typeof t.textStyleId === 'string' ? t.textStyleId : '';
            if (styleId) {
                try {
                    await this.loadFonts(t);
                    t.textStyleId = '';
                    onStrip('Text Style', { nodeId: node.id, field: 'textStyle', previousVarId: styleId });
                }
                catch (e) {
                    console.log('[TokenApplicator] Strip text style failed:', e);
                }
            }
        }
        // Strip text fields
        if (node.type === 'TEXT') {
            await this.loadFonts(node);
            const textFields = ['fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing'];
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
                // Text style undo — uses style ID, not variable ID
                if (entry.field === 'textStyle' && node.type === 'TEXT') {
                    const t = node;
                    await this.loadFonts(t);
                    if (action === 'apply') {
                        // Undo apply: restore previous style (or remove style)
                        t.textStyleId = entry.previousVarId || '';
                    }
                    else if (action === 'strip') {
                        // Undo strip: re-apply the style
                        if (entry.previousVarId)
                            t.textStyleId = entry.previousVarId;
                    }
                    ok++;
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
