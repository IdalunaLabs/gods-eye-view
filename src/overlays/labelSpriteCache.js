/**
 * @module labelSpriteCache
 * Rasterize each unique label glyph once and blit it with drawImage.
 * The cache key is text, font, fill, stroke colour, stroke width,
 * letter spacing, alignment, baseline, and device pixel ratio. Alpha stays
 * on the destination context so a fade does not mint a new sprite.
 */

/** Default cap on cached glyph sprites. */
export const LABEL_SPRITE_CACHE_LIMIT = 2048;
/** Default decoded-bitmap budget, about 64 MB of RGBA8. */
export const LABEL_SPRITE_BYTE_BUDGET = 64 * 1024 * 1024;
/** CSS-pixel width above which a string is drawn directly. */
export const LABEL_SPRITE_MAX_CSS_WIDTH = 512;

const MAX_DEVICE_EDGE = 4096;
const DEFAULT_SPACING = '0px';

/** @type {Map<string, Map<any, any>>} */
const _buckets = new Map();
const _live = [];
let _count = 0;
let _bytes = 0;
let _clock = 0;
let _enabled = true;
let _dpr = 1;
let _entryLimit = LABEL_SPRITE_CACHE_LIMIT;
let _byteBudget = LABEL_SPRITE_BYTE_BUDGET;
let _maxCssWidth = LABEL_SPRITE_MAX_CSS_WIDTH;
/** @type {((width: number, height: number) => {canvas: object, context: CanvasRenderingContext2D}|null)|null} */
let _factory = null;
let _frameTextDraws = 0;
let _frameBlits = 0;
let _frameRasters = 0;

/**
 * Replace the sprite canvas constructor. Tests inject a stub; production
 * uses OffscreenCanvas, then a detached element canvas.
 * @param {Function|null} factory
 */
export function setLabelSpriteCanvasFactory(factory) {
  _factory = typeof factory === 'function' ? factory : null;
}

/**
 * Turn glyph caching on or off. The overlay draw path defaults to on.
 * Dev builds also expose this as `window.__gevWorldOverlay.setLabelSpritesEnabled`.
 * @param {boolean} enabled
 */
export function setLabelSpritesEnabled(enabled) {
  _enabled = enabled === true;
}

/** @returns {boolean} Whether new text draws consult the sprite cache. */
export function labelSpritesEnabled() {
  return _enabled;
}

/**
 * Set the device pixel ratio used to rasterize sprites.
 * A change drops the cache so glyphs are rebuilt at the new scale.
 * @param {number} dpr
 */
export function setLabelSpriteDpr(dpr) {
  const next = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  if (next === _dpr) return;
  _dpr = next;
  invalidateLabelSpriteCache();
}

/**
 * Change the LRU caps. Oversized entries are evicted immediately.
 * @param {{entryLimit?: number, byteBudget?: number, maxCssWidth?: number}} [options]
 */
export function configureLabelSpriteCache({
  entryLimit = _entryLimit,
  byteBudget = _byteBudget,
  maxCssWidth = _maxCssWidth,
} = {}) {
  if (entryLimit >= 1) _entryLimit = Math.floor(entryLimit);
  if (byteBudget >= 1) _byteBudget = Math.floor(byteBudget);
  if (maxCssWidth >= 8) _maxCssWidth = Math.floor(maxCssWidth);
  while (_count > _entryLimit || (_count > 0 && _bytes > _byteBudget)) {
    if (!evictOldest()) break;
  }
}

/** Drop every cached sprite. Called on font loads and visual-preset changes. */
export function invalidateLabelSpriteCache() {
  _buckets.clear();
  _live.length = 0;
  _count = 0;
  _bytes = 0;
  _clock = 0;
}

/** Zero the per-frame text and blit counters. */
export function resetLabelSpriteFrameCounters() {
  _frameTextDraws = 0;
  _frameBlits = 0;
  _frameRasters = 0;
}

/**
 * Copy this frame's glyph counters onto an existing diagnostics object.
 * @param {object} target
 */
export function publishLabelSpriteFrameStats(target) {
  target.textDraws = _frameTextDraws;
  target.spriteBlits = _frameBlits;
  target.spriteRasters = _frameRasters;
}

/** @returns {object} Cache occupancy and the current frame counters. */
export function getLabelSpriteCacheStats() {
  return {
    entries: _count,
    bytes: _bytes,
    entryLimit: _entryLimit,
    byteBudget: _byteBudget,
    maxCssWidth: _maxCssWidth,
    enabled: _enabled,
    dpr: _dpr,
    textDraws: _frameTextDraws,
    spriteBlits: _frameBlits,
    spriteRasters: _frameRasters,
  };
}

/**
 * Paint one label string. Cache hits blit a sprite; misses rasterize once.
 * With the cache disabled, or for a string wider than the sprite cap, this
 * issues the same fill (and optional stroke) the direct path uses.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {string} fill
 * @param {string} font
 * @param {string} baseline
 * @param {string} align
 * @param {number} [strokeWidth=0]
 * @param {string} [stroke='']
 * @param {string} [letterSpacing='0px']
 */
export function blitLabelSprite(
  ctx,
  text,
  x,
  y,
  fill,
  font,
  baseline,
  align,
  strokeWidth = 0,
  stroke = '',
  letterSpacing = DEFAULT_SPACING,
) {
  if (!text) return;
  const strokeW = strokeWidth > 0 ? strokeWidth : 0;
  const strokeColor = strokeW > 0 && stroke ? stroke : '';
  const spacing = letterSpacing || DEFAULT_SPACING;
  const base = baseline || 'alphabetic';
  const alignment = align || 'start';
  const paintFill = fill || '';
  const paintFont = font || '';
  if (!_enabled) {
    drawDirect(
      ctx,
      text,
      x,
      y,
      paintFill,
      paintFont,
      base,
      alignment,
      strokeW,
      strokeColor,
      spacing,
    );
    return;
  }
  const dpr = _dpr;
  const entry = findEntry(
    paintFont,
    paintFill,
    strokeColor,
    strokeW,
    spacing,
    alignment,
    base,
    dpr,
    text,
  );
  if (entry) {
    entry.usedAt = ++_clock;
    blitEntry(ctx, entry, x, y, dpr);
    return;
  }
  rasterize(
    ctx,
    text,
    x,
    y,
    paintFill,
    paintFont,
    base,
    alignment,
    strokeW,
    strokeColor,
    spacing,
    dpr,
  );
}

/**
 * Apply the glyph styling sequence shared by the direct path and the
 * sprite rasterizer: fill, font, align, baseline, spacing, then
 * strokeText (when a halo width is set) and fillText.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {string} fill
 * @param {string} font
 * @param {string} baseline
 * @param {string} align
 * @param {number} strokeWidth
 * @param {string} stroke
 * @param {string} letterSpacing
 */
export function drawLabelGlyphRun(
  ctx,
  text,
  x,
  y,
  fill,
  font,
  baseline,
  align,
  strokeWidth,
  stroke,
  letterSpacing,
) {
  ctx.fillStyle = fill;
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.letterSpacing = letterSpacing;
  if (strokeWidth > 0) {
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = stroke;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
  }
  ctx.fillText(text, x, y);
}

function drawDirect(
  ctx,
  text,
  x,
  y,
  fill,
  font,
  baseline,
  align,
  strokeWidth,
  stroke,
  letterSpacing,
) {
  drawLabelGlyphRun(
    ctx,
    text,
    x,
    y,
    fill,
    font,
    baseline,
    align,
    strokeWidth,
    stroke,
    letterSpacing,
  );
  _frameTextDraws += strokeWidth > 0 ? 2 : 1;
}

function blitEntry(ctx, entry, x, y, dpr) {
  ctx.drawImage(
    entry.canvas,
    roundDevice(x - entry.originX, dpr),
    roundDevice(y - entry.originY, dpr),
    entry.drawW,
    entry.drawH,
  );
  _frameBlits++;
}

function roundDevice(value, dpr) {
  return Math.round(value * dpr) / dpr;
}

function findEntry(
  font,
  fill,
  stroke,
  strokeWidth,
  spacing,
  align,
  baseline,
  dpr,
  text,
) {
  const byFill = _buckets.get(font);
  if (!byFill) return null;
  const byStroke = byFill.get(fill);
  if (!byStroke) return null;
  const byWidth = byStroke.get(stroke);
  if (!byWidth) return null;
  const bySpacing = byWidth.get(strokeWidth);
  if (!bySpacing) return null;
  const byAlign = bySpacing.get(spacing);
  if (!byAlign) return null;
  const byBaseline = byAlign.get(align);
  if (!byBaseline) return null;
  const byDpr = byBaseline.get(baseline);
  if (!byDpr) return null;
  const byText = byDpr.get(dpr);
  if (!byText) return null;
  return byText.get(text) || null;
}

function rasterize(
  ctx,
  text,
  x,
  y,
  fill,
  font,
  baseline,
  align,
  strokeWidth,
  stroke,
  spacing,
  dpr,
) {
  const measured = measureGlyph(ctx, text, font);
  if (!measured) {
    drawDirect(
      ctx,
      text,
      x,
      y,
      fill,
      font,
      baseline,
      align,
      strokeWidth,
      stroke,
      spacing,
    );
    return;
  }
  const box = glyphBox(
    measured.width,
    measured.ascent,
    measured.descent,
    align,
    baseline,
    strokeWidth,
  );
  const deviceW = Math.max(1, Math.ceil(box.cssWidth * dpr));
  const deviceH = Math.max(1, Math.ceil(box.cssHeight * dpr));
  const bytes = deviceW * deviceH * 4;
  if (
    box.cssWidth > _maxCssWidth ||
    deviceW > MAX_DEVICE_EDGE ||
    deviceH > MAX_DEVICE_EDGE ||
    bytes > _byteBudget
  ) {
    drawDirect(
      ctx,
      text,
      x,
      y,
      fill,
      font,
      baseline,
      align,
      strokeWidth,
      stroke,
      spacing,
    );
    return;
  }
  const surface = createSpriteSurface(deviceW, deviceH);
  if (!surface?.context) {
    drawDirect(
      ctx,
      text,
      x,
      y,
      fill,
      font,
      baseline,
      align,
      strokeWidth,
      stroke,
      spacing,
    );
    return;
  }
  const previousAlpha = surface.context.globalAlpha;
  if (typeof surface.context.setTransform === 'function') {
    surface.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  surface.context.globalAlpha = 1;
  drawLabelGlyphRun(
    surface.context,
    text,
    box.originX,
    box.originY,
    fill,
    font,
    baseline,
    align,
    strokeWidth,
    stroke,
    spacing,
  );
  if (previousAlpha !== undefined) surface.context.globalAlpha = previousAlpha;
  while (_count >= _entryLimit && _count > 0) {
    if (!evictOldest()) break;
  }
  while (_bytes + bytes > _byteBudget && _count > 0) {
    if (!evictOldest()) break;
  }
  const slot = ensureSlot(
    font,
    fill,
    stroke,
    strokeWidth,
    spacing,
    align,
    baseline,
    dpr,
  );
  const entry = {
    canvas: surface.canvas,
    originX: box.originX,
    originY: box.originY,
    drawW: deviceW / dpr,
    drawH: deviceH / dpr,
    bytes,
    maps: slot.maps,
    keys: slot.keys,
    text,
    usedAt: 0,
    index: 0,
  };
  slot.textMap.set(text, entry);
  entry.index = _live.length;
  entry.usedAt = ++_clock;
  _live.push(entry);
  _count++;
  _bytes += bytes;
  _frameRasters++;
  blitEntry(ctx, entry, x, y, dpr);
}

function measureGlyph(ctx, text, font) {
  let metrics = null;
  try {
    ctx.font = font;
    metrics = ctx.measureText(text);
  } catch {
    return null;
  }
  const width = Number(metrics?.width) || 0;
  if (!(width > 0)) return null;
  const size = fontPixelSize(font);
  let ascent = Number(metrics?.fontBoundingBoxAscent);
  let descent = Number(metrics?.fontBoundingBoxDescent);
  if (!(ascent > 0)) ascent = Number(metrics?.actualBoundingBoxAscent);
  if (!(descent > 0)) descent = Number(metrics?.actualBoundingBoxDescent);
  if (!(ascent > 0)) ascent = size * 0.8;
  if (!(descent > 0)) descent = Math.max(1, size * 0.25);
  return { width, ascent, descent };
}

function fontPixelSize(font) {
  const match = /(?:^|\s)(\d+(?:\.\d+)?)px\b/.exec(String(font || ''));
  const size = match ? Number(match[1]) : 0;
  return size > 0 ? size : 12;
}

function glyphBox(width, ascent, descent, align, baseline, strokeWidth) {
  const pad = (strokeWidth > 0 ? strokeWidth : 0) + 1;
  let left = 0;
  if (align === 'center') left = -width / 2;
  else if (align === 'right' || align === 'end') left = -width;
  const em = ascent + descent;
  let top = -ascent;
  if (baseline === 'top') top = 0;
  else if (baseline === 'middle') top = -em / 2;
  else if (baseline === 'bottom') top = -em;
  else if (baseline === 'hanging') top = -ascent * 0.8;
  return {
    cssWidth: Math.max(1, width + pad * 2),
    cssHeight: Math.max(1, em + pad * 2),
    originX: pad - left,
    originY: pad - top,
  };
}

function createSpriteSurface(deviceW, deviceH) {
  if (_factory) {
    const created = _factory(deviceW, deviceH);
    if (created?.canvas && created.context) return created;
    return null;
  }
  if (typeof OffscreenCanvas === 'function') {
    try {
      const canvas = new OffscreenCanvas(deviceW, deviceH);
      const context = readContext(canvas);
      if (context) return { canvas, context };
    } catch {
      // Fall through to a detached element canvas.
    }
  }
  if (
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function'
  ) {
    const canvas = document.createElement('canvas');
    canvas.width = deviceW;
    canvas.height = deviceH;
    const context = readContext(canvas);
    if (context) return { canvas, context };
  }
  return null;
}

function readContext(canvas) {
  if (typeof canvas.getContext !== 'function') return null;
  try {
    return canvas.getContext('2d', { alpha: true }) || canvas.getContext('2d');
  } catch {
    try {
      return canvas.getContext('2d');
    } catch {
      return null;
    }
  }
}

function ensureSlot(
  font,
  fill,
  stroke,
  strokeWidth,
  spacing,
  align,
  baseline,
  dpr,
) {
  const maps = [];
  const keys = [font, fill, stroke, strokeWidth, spacing, align, baseline, dpr];
  let map = _buckets;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let next = map.get(key);
    if (!next) {
      next = new Map();
      map.set(key, next);
    }
    maps.push(next);
    map = next;
  }
  return { textMap: map, maps, keys };
}

function evictOldest() {
  const count = _live.length;
  if (count === 0) return false;
  let oldestIndex = 0;
  let oldestAt = _live[0].usedAt;
  for (let i = 1; i < count; i++) {
    const usedAt = _live[i].usedAt;
    if (usedAt < oldestAt) {
      oldestAt = usedAt;
      oldestIndex = i;
    }
  }
  const entry = _live[oldestIndex];
  unlink(entry);
  const last = _live.pop();
  if (oldestIndex < _live.length) {
    _live[oldestIndex] = last;
    last.index = oldestIndex;
  }
  _count--;
  _bytes -= entry.bytes;
  if (_bytes < 0) _bytes = 0;
  return true;
}

function unlink(entry) {
  const maps = entry.maps;
  const keys = entry.keys;
  maps[maps.length - 1].delete(entry.text);
  for (let i = maps.length - 1; i > 0; i--) {
    if (maps[i].size !== 0) return;
    maps[i - 1].delete(keys[i]);
  }
  if (maps[0].size === 0) _buckets.delete(keys[0]);
}
