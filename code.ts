/// <reference types="@figma/plugin-typings" />

/* ================================================================ */
/* DRESSING ROOM                                                     */
/* Scans selected Figma nodes for raw (untokenized) values and      */
/* suggests matching variables to bind — works with both local and  */
/* library variables via Figma's inferredVariables API.              */
/*                                                                  */
/* Supports: spacing, padding, corner radius, stroke weight,        */
/* font family, font size, line height, letter spacing,             */
/* fill colors, stroke colors, text colors.                         */
/* ================================================================ */

// ─── Types ──────────────────────────────────────────────────────

interface Match {
  nodeId: string;
  nodeName: string;
  field: string;
  rawValue: number | string;
  category: string;
  candidates: Candidate[];
}

interface Candidate {
  id: string;
  name: string;
  collection: string;
  value: number | string;
  confidence: number;
}

interface ApplyItem {
  nodeId: string;
  field: string;
  variableId: string;
}

interface ScanStats {
  nodesScanned: number;
  propsChecked: number;
  alreadyBound: number;
  orphaned: number;
  noMatch: number;
  matched: number;
}

// ─── Constants ──────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
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

const FIELD_CATEGORY: Record<string, string> = {
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
  // Cache: variable ID → resolved info (avoids repeated async lookups)
  private varCache = new Map<string, { name: string; collection: string; value: number | string } | null>();
  // Cache: collection ID → name
  private colCache = new Map<string, string>();

  constructor() {
    figma.showUI(__html__, { width: 420, height: 640 });

    figma.ui.onmessage = async (msg: any) => {
      try {
        if (msg.type === 'scan') await this.scan();
        else if (msg.type === 'apply') await this.apply(msg.items as ApplyItem[]);
        else if (msg.type === 'strip') await this.strip();
        else if (msg.type === 'open-url') figma.openExternal(msg.url);
        else if (msg.type === 'close') figma.closePlugin();
      } catch (err) {
        console.error('[TokenApplicator] Error:', err);
        figma.ui.postMessage({ type: 'error', message: String(err) });
      }
    };

    // Pre-cache local collection names, then signal ready
    this.init();
  }

  private async init(): Promise<void> {
    try {
      const cols = await figma.variables.getLocalVariableCollectionsAsync();
      for (const c of cols) this.colCache.set(c.id, c.name);
      console.log('[TokenApplicator] Cached', cols.length, 'local collections');
    } catch (e) {
      console.log('[TokenApplicator] Could not cache collections:', e);
    }

    // Also try to cache library collection names
    try {
      const libCols = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      console.log('[TokenApplicator] Found', libCols.length, 'library collections:', libCols.map(c => c.name).join(', '));
    } catch (e) {
      console.log('[TokenApplicator] Library collections not available:', e);
    }

    figma.ui.postMessage({ type: 'ready' });
  }

  // ─── Resolve a VariableAlias to display info ──────────────────

  /** Resolve a variable ID to its name, collection, and value. */
  private async resolveVar(id: string): Promise<{ name: string; collection: string; value: number | string } | null> {
    if (this.varCache.has(id)) return this.varCache.get(id)!;

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
        } catch {
          colName = 'Library';
        }
      }

      // Resolve value
      const modeId = Object.keys(v.valuesByMode)[0];
      let val: any = modeId ? v.valuesByMode[modeId] : null;

      // Follow alias chain
      let depth = 0;
      while (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && depth < 10) {
        const next = await figma.variables.getVariableByIdAsync(val.id);
        if (!next) break;
        const nextMode = Object.keys(next.valuesByMode)[0];
        if (!nextMode) break;
        val = next.valuesByMode[nextMode];
        depth++;
      }

      let resolved: number | string;
      if (typeof val === 'number' || typeof val === 'string') {
        resolved = val;
      } else if (val && typeof val === 'object' && 'r' in val && 'g' in val && 'b' in val) {
        resolved = this.rgbaToHex(val as { r: number; g: number; b: number });
      } else {
        resolved = 0;
      }

      const info = { name: v.name, collection: colName, value: resolved };
      this.varCache.set(id, info);
      return info;
    } catch {
      this.varCache.set(id, null);
      return null;
    }
  }

  // ─── Scan selected nodes ──────────────────────────────────────

  private async scan(): Promise<void> {
    const sel = figma.currentPage.selection;
    if (sel.length === 0) {
      figma.ui.postMessage({ type: 'error', message: 'Select at least one element to scan.' });
      return;
    }

    figma.ui.postMessage({ type: 'scanning' });

    const matches: Match[] = [];
    const stats: ScanStats = { nodesScanned: 0, propsChecked: 0, alreadyBound: 0, orphaned: 0, noMatch: 0, matched: 0 };

    for (const node of sel) {
      await this.walk(node, matches, stats, 0);
    }

    console.log('[TokenApplicator] Scan complete:', JSON.stringify(stats));
    console.log('[TokenApplicator] Matches:', matches.length);
    for (const m of matches) {
      console.log('  →', m.nodeName, '|', m.field, ':', m.rawValue, '→', m.candidates[0]?.name || '(none)');
    }

    figma.ui.postMessage({ type: 'results', matches, total: matches.length, stats });
  }

  private async walk(node: SceneNode, out: Match[], stats: ScanStats, depth: number): Promise<void> {
    if (depth > 100) return;
    await this.inspect(node, out, stats);
    if ('children' in node) {
      for (const child of (node as any).children) {
        await this.walk(child as SceneNode, out, stats, depth + 1);
      }
    }
  }

  private async inspect(node: SceneNode, out: Match[], stats: ScanStats): Promise<void> {
    stats.nodesScanned++;

    // ── Auto-layout spacing & padding ──
    if ('layoutMode' in node) {
      const f = node as FrameNode;
      if (f.layoutMode !== 'NONE') {
        await this.checkField(f, 'itemSpacing', f.itemSpacing, out, stats);
        if ('counterAxisSpacing' in f) {
          await this.checkField(f, 'counterAxisSpacing', (f as any).counterAxisSpacing, out, stats);
        }
        await this.checkField(f, 'paddingLeft', f.paddingLeft, out, stats);
        await this.checkField(f, 'paddingRight', f.paddingRight, out, stats);
        await this.checkField(f, 'paddingTop', f.paddingTop, out, stats);
        await this.checkField(f, 'paddingBottom', f.paddingBottom, out, stats);
      }
    }

    // ── Corner radius (individual corners only — "cornerRadius" is not bindable) ──
    if ('cornerRadius' in node) {
      const n = node as any;
      if (typeof n.topLeftRadius === 'number') await this.checkField(n, 'topLeftRadius', n.topLeftRadius, out, stats);
      if (typeof n.topRightRadius === 'number') await this.checkField(n, 'topRightRadius', n.topRightRadius, out, stats);
      if (typeof n.bottomLeftRadius === 'number') await this.checkField(n, 'bottomLeftRadius', n.bottomLeftRadius, out, stats);
      if (typeof n.bottomRightRadius === 'number') await this.checkField(n, 'bottomRightRadius', n.bottomRightRadius, out, stats);
    }

    // ── Stroke weight (only if node has visible strokes) ──
    if ('strokes' in node && (node as any).strokes !== figma.mixed) {
      const strokes = (node as any).strokes as readonly Paint[];
      const hasVisibleStrokes = Array.isArray(strokes) && strokes.length > 0 &&
        strokes.some((s: any) => s.visible !== false);
      if (hasVisibleStrokes && 'strokeWeight' in node && typeof (node as any).strokeWeight === 'number') {
        await this.checkField(node, 'strokeWeight', (node as any).strokeWeight, out, stats);
      }
    }

    // ── Text properties ──
    if (node.type === 'TEXT') {
      const t = node as TextNode;

      if (typeof t.fontSize === 'number') {
        await this.checkField(t, 'fontSize', t.fontSize, out, stats);
      }
      if (t.fontName !== figma.mixed) {
        await this.checkField(t, 'fontFamily', (t.fontName as FontName).family, out, stats);
      }
      if (t.lineHeight !== figma.mixed) {
        const lh = t.lineHeight as LineHeight;
        if (lh.unit === 'PIXELS') {
          await this.checkField(t, 'lineHeight', lh.value, out, stats);
        }
      }
      if (t.letterSpacing !== figma.mixed) {
        const ls = t.letterSpacing as LetterSpacing;
        if (ls.unit === 'PIXELS' && ls.value !== 0) {
          await this.checkField(t, 'letterSpacing', ls.value, out, stats);
        }
      }
    }

    // ── Fill colors ──
    if ('fills' in node && (node as any).fills !== figma.mixed) {
      const fills = (node as any).fills as readonly Paint[];
      if (Array.isArray(fills)) {
        const inferred = (node as any).inferredVariables;
        for (let i = 0; i < fills.length; i++) {
          const fill = fills[i] as any;
          if (fill.type !== 'SOLID' || fill.visible === false) continue;
          stats.propsChecked++;
          if (fill.boundVariables?.color) {
            const colorVar = await this.resolveVar(fill.boundVariables.color.id);
            if (colorVar) { stats.alreadyBound++; continue; }
            stats.orphaned++; // Orphaned — fall through to rebind
          }

          const fillAliases = inferred?.fills?.[i];
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
    if ('strokes' in node && (node as any).strokes !== figma.mixed) {
      const strokes = (node as any).strokes as readonly Paint[];
      if (Array.isArray(strokes)) {
        const inferred = (node as any).inferredVariables;
        for (let i = 0; i < strokes.length; i++) {
          const stroke = strokes[i] as any;
          if (stroke.type !== 'SOLID' || stroke.visible === false) continue;
          stats.propsChecked++;
          if (stroke.boundVariables?.color) {
            const colorVar = await this.resolveVar(stroke.boundVariables.color.id);
            if (colorVar) { stats.alreadyBound++; continue; }
            stats.orphaned++; // Orphaned — fall through to rebind
          }

          const strokeAliases = inferred?.strokes?.[i];
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
  private async checkField(
    node: SceneNode,
    field: string,
    value: number | string,
    out: Match[],
    stats: ScanStats
  ): Promise<void> {
    stats.propsChecked++;

    // Skip zero/empty values
    if (value === 0 || value === '' || value === undefined || value === null) return;

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
    const inferred = (node as any).inferredVariables;
    let aliases: any[] | undefined;

    if (inferred) {
      aliases = inferred[field];
    }

    if (aliases && Array.isArray(aliases) && aliases.length > 0) {
      // Resolve each inferred variable alias to display info
      const candidates: Candidate[] = [];
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
  private async checkBinding(node: SceneNode, field: string): Promise<'bound' | 'orphan' | 'free'> {
    const bv = node.boundVariables;
    if (!bv) return 'free';
    const val = (bv as any)[field];
    if (val === undefined || val === null) return 'free';

    // Extract the variable ID from the binding
    let varId: string | undefined;
    if (Array.isArray(val)) {
      if (val.length === 0) return 'free';
      varId = val[0]?.id;
    } else if (typeof val === 'object' && val.id) {
      varId = val.id;
    }

    if (!varId) return 'bound'; // Can't determine, assume live

    // Try to resolve — if it fails, it's an orphan
    try {
      const variable = await figma.variables.getVariableByIdAsync(varId);
      return variable ? 'bound' : 'orphan';
    } catch {
      return 'orphan';
    }
  }

  /** Synchronous check for strip — just checks if any binding exists (orphan or not). */
  private isBound(node: SceneNode, field: string): boolean {
    const bv = node.boundVariables;
    if (!bv) return false;
    const val = (bv as any)[field];
    if (val === undefined || val === null) return false;
    if (Array.isArray(val)) return val.length > 0;
    return true;
  }

  // ─── Helpers ─────────────────────────────────────────────────

  /** Convert Figma RGBA (0-1 range) to hex string. */
  private rgbaToHex(color: { r: number; g: number; b: number }): string {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
  }

  /** Get human-readable label for a field (handles dynamic fill:/stroke: fields). */
  private getFieldLabel(field: string, node?: SceneNode | null): string {
    if (FIELD_LABEL[field]) return FIELD_LABEL[field];
    if (field.startsWith('fill:')) return node?.type === 'TEXT' ? 'Text color' : 'Fill color';
    if (field.startsWith('stroke:')) return 'Stroke color';
    return field;
  }

  /** Get category for a field (handles dynamic fill:/stroke: fields). */
  private getFieldCategory(field: string): string {
    if (FIELD_CATEGORY[field]) return FIELD_CATEGORY[field];
    if (field.startsWith('fill:') || field.startsWith('stroke:')) return 'Color';
    return 'Other';
  }

  // ─── Apply variable bindings ──────────────────────────────────

  private async apply(items: ApplyItem[]): Promise<void> {
    let ok = 0;
    let fail = 0;
    const errors: string[] = [];
    const catStats: Record<string, { ok: number; fail: number }> = {};

    const trackOk = (field: string) => {
      const cat = this.getFieldCategory(field);
      if (!catStats[cat]) catStats[cat] = { ok: 0, fail: 0 };
      catStats[cat].ok++;
    };
    const trackFail = (field: string) => {
      const cat = this.getFieldCategory(field);
      if (!catStats[cat]) catStats[cat] = { ok: 0, fail: 0 };
      catStats[cat].fail++;
    };

    console.log('[TokenApplicator] Applying', items.length, 'bindings...');

    for (const item of items) {
      const node = await figma.getNodeByIdAsync(item.nodeId) as SceneNode | null;
      const label = this.getFieldLabel(item.field, node);

      try {
        if (!node) {
          errors.push(label + ': Node not found');
          trackFail(item.field); fail++;
          continue;
        }

        const variable = await figma.variables.getVariableByIdAsync(item.variableId);
        if (!variable) {
          errors.push(label + ': Variable not found');
          trackFail(item.field); fail++;
          continue;
        }

        console.log('[TokenApplicator] Binding', label, 'on "' + node.name + '" →', variable.name);

        // ── Fill color binding ──
        if (item.field.startsWith('fill:')) {
          const fillIndex = parseInt(item.field.split(':')[1]);
          const fills = [...((node as any).fills as Paint[])];
          fills[fillIndex] = figma.variables.setBoundVariableForPaint(
            fills[fillIndex] as SolidPaint, 'color', variable
          );
          (node as any).fills = fills;
          console.log('[TokenApplicator] ✓', label);
          trackOk(item.field); ok++;
          continue;
        }

        // ── Stroke color binding ──
        if (item.field.startsWith('stroke:')) {
          const strokeIndex = parseInt(item.field.split(':')[1]);
          const strokes = [...((node as any).strokes as Paint[])];
          strokes[strokeIndex] = figma.variables.setBoundVariableForPaint(
            strokes[strokeIndex] as SolidPaint, 'color', variable
          );
          (node as any).strokes = strokes;
          console.log('[TokenApplicator] ✓', label);
          trackOk(item.field); ok++;
          continue;
        }

        // Text nodes: load fonts before modifying
        if (node.type === 'TEXT') {
          await this.loadFonts(node as TextNode);
        }

        // For text-specific fields, try node-level first, fall back to range-based
        if (node.type === 'TEXT' && TEXT_FIELDS.has(item.field)) {
          try {
            node.setBoundVariable(item.field as any, variable);
          } catch (e) {
            console.log('[TokenApplicator] Fallback to setRangeBoundVariable for', item.field);
            const t = node as TextNode;
            t.setRangeBoundVariable(0, t.characters.length, item.field as VariableBindableTextField, variable);
          }
        } else {
          node.setBoundVariable(item.field as VariableBindableNodeField, variable);
        }

        console.log('[TokenApplicator] ✓', label);
        trackOk(item.field); ok++;

      } catch (err) {
        console.error('[TokenApplicator] ✗', label, '-', err);
        errors.push(label + ': ' + String(err));
        trackFail(item.field); fail++;
      }
    }

    console.log('[TokenApplicator] Done: ok=' + ok + ', fail=' + fail);
    figma.ui.postMessage({ type: 'applied', ok, fail, errors, categoryStats: catStats });
  }

  // ─── Strip variable bindings ─────────────────────────────────

  private async strip(): Promise<void> {
    const sel = figma.currentPage.selection;
    if (sel.length === 0) {
      figma.ui.postMessage({ type: 'error', message: 'Select at least one element to strip.' });
      return;
    }

    figma.ui.postMessage({ type: 'stripping' });

    let stripped = 0;
    const catStats: Record<string, number> = {};

    const onStrip = (cat: string) => {
      stripped++;
      catStats[cat] = (catStats[cat] || 0) + 1;
    };

    for (const node of sel) {
      await this.walkStrip(node, 0, onStrip);
    }

    console.log('[TokenApplicator] Stripped', stripped, 'bindings:', JSON.stringify(catStats));
    figma.ui.postMessage({ type: 'stripped', stripped, categoryStats: catStats });
  }

  private async walkStrip(node: SceneNode, depth: number, onStrip: (cat: string) => void): Promise<void> {
    if (depth > 100) return;
    await this.stripNode(node, onStrip);
    if ('children' in node) {
      for (const child of (node as any).children) {
        await this.walkStrip(child as SceneNode, depth + 1, onStrip);
      }
    }
  }

  private async stripNode(node: SceneNode, onStrip: (cat: string) => void): Promise<void> {
    // Strip scalar fields (spacing, radius, stroke weight)
    const scalarFields = Object.keys(FIELD_CATEGORY).filter(f => !TEXT_FIELDS.has(f));
    for (const field of scalarFields) {
      if (this.isBound(node, field)) {
        try {
          node.setBoundVariable(field as VariableBindableNodeField, null);
          onStrip(FIELD_CATEGORY[field]);
        } catch (e) {
          console.log('[TokenApplicator] Strip failed for', field, ':', e);
        }
      }
    }

    // Strip text fields
    if (node.type === 'TEXT') {
      await this.loadFonts(node as TextNode);
      const textFields = ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing'];
      for (const field of textFields) {
        if (this.isBound(node, field)) {
          try {
            node.setBoundVariable(field as any, null);
            onStrip('Typography');
          } catch {
            try {
              const t = node as TextNode;
              t.setRangeBoundVariable(0, t.characters.length, field as VariableBindableTextField, null as any);
              onStrip('Typography');
            } catch (e2) {
              console.log('[TokenApplicator] Strip text failed for', field, ':', e2);
            }
          }
        }
      }
    }

    // Strip fill colors
    if ('fills' in node && (node as any).fills !== figma.mixed) {
      const fills = (node as any).fills as Paint[];
      if (Array.isArray(fills)) {
        let changed = false;
        const newFills = [...fills];
        for (let i = 0; i < fills.length; i++) {
          const fill = fills[i] as any;
          if (fill.type === 'SOLID' && fill.boundVariables?.color) {
            newFills[i] = figma.variables.setBoundVariableForPaint(fill as SolidPaint, 'color', null);
            changed = true;
            onStrip('Color');
          }
        }
        if (changed) (node as any).fills = newFills;
      }
    }

    // Strip stroke colors
    if ('strokes' in node && (node as any).strokes !== figma.mixed) {
      const strokes = (node as any).strokes as Paint[];
      if (Array.isArray(strokes)) {
        let changed = false;
        const newStrokes = [...strokes];
        for (let i = 0; i < strokes.length; i++) {
          const stroke = strokes[i] as any;
          if (stroke.type === 'SOLID' && stroke.boundVariables?.color) {
            newStrokes[i] = figma.variables.setBoundVariableForPaint(stroke as SolidPaint, 'color', null);
            changed = true;
            onStrip('Color');
          }
        }
        if (changed) (node as any).strokes = newStrokes;
      }
    }
  }

  /** Load all fonts used in a text node so properties can be modified. */
  private async loadFonts(t: TextNode): Promise<void> {
    if (t.fontName !== figma.mixed) {
      await figma.loadFontAsync(t.fontName as FontName);
    } else {
      const loaded = new Set<string>();
      for (let i = 0; i < t.characters.length; i++) {
        const fn = t.getRangeFontName(i, i + 1) as FontName;
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
