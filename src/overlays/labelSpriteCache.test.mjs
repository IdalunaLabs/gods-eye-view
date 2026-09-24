import assert from 'node:assert/strict';
import test from 'node:test';

import { setDetectionStyle } from '../data/detection.js';
import {
  LABEL_SPRITE_BYTE_BUDGET,
  LABEL_SPRITE_CACHE_LIMIT,
  LABEL_SPRITE_MAX_CSS_WIDTH,
  blitLabelSprite,
  configureLabelSpriteCache,
  drawLabelGlyphRun,
  getLabelSpriteCacheStats,
  invalidateLabelSpriteCache,
  resetLabelSpriteFrameCounters,
  setLabelSpriteCanvasFactory,
  setLabelSpriteDpr,
  setLabelSpritesEnabled,
} from './labelSpriteCache.js';
import {
  clearWorldOverlayTextMeasureCache,
  paintDetectionCallout,
  paintLabel,
} from './worldOverlayDraw.js';

const FONT = '500 10px "JetBrains Mono", monospace';
const FILL = 'rgba(232, 240, 244, 0.96)';

function resetSprites() {
  setLabelSpriteCanvasFactory(null);
  setLabelSpritesEnabled(true);
  setLabelSpriteDpr(1);
  configureLabelSpriteCache({
    entryLimit: LABEL_SPRITE_CACHE_LIMIT,
    byteBudget: LABEL_SPRITE_BYTE_BUDGET,
    maxCssWidth: LABEL_SPRITE_MAX_CSS_WIDTH,
  });
  invalidateLabelSpriteCache();
  resetLabelSpriteFrameCounters();
}

function snapshot(ctx, text, x, y) {
  return {
    text,
    font: ctx.font,
    fill: ctx.fillStyle,
    stroke: ctx.strokeStyle,
    lineWidth: ctx.lineWidth,
    align: ctx.textAlign,
    baseline: ctx.textBaseline,
    letterSpacing: ctx.letterSpacing,
    globalAlpha: ctx.globalAlpha,
    x,
    y,
  };
}

function recordingContext() {
  const events = [];
  const ctx = {
    events,
    globalAlpha: 1,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    letterSpacing: '0px',
    lineWidth: 1,
    lineJoin: 'miter',
    measureText(text) {
      return { width: String(text).length * 6 };
    },
    setTransform() {},
    save() {},
    restore() {},
    fillText(text, x, y) {
      events.push(['fillText', snapshot(this, text, x, y)]);
    },
    strokeText(text, x, y) {
      events.push(['strokeText', snapshot(this, text, x, y)]);
    },
    drawImage(_image, x, y, w, h) {
      events.push(['drawImage', x, y, w, h, this.globalAlpha]);
    },
  };
  return ctx;
}

function factoryFrom(store) {
  return (width, height) => {
    const context = recordingContext();
    const canvas = { width, height };
    store.push({ canvas, context });
    return { canvas, context };
  };
}

function styleTuple(event) {
  const state = event[1];
  return {
    text: state.text,
    font: state.font,
    fill: state.fill,
    stroke: state.stroke,
    lineWidth: state.lineWidth,
    align: state.align,
    baseline: state.baseline,
    letterSpacing: state.letterSpacing,
  };
}

test('cache keys follow text, font, fill, stroke, spacing, align, baseline, and DPR', () => {
  resetSprites();
  const store = [];
  setLabelSpriteCanvasFactory(factoryFrom(store));
  const ctx = recordingContext();
  const paint = (text, fill, extra = {}) => {
    resetLabelSpriteFrameCounters();
    blitLabelSprite(
      ctx,
      text,
      4,
      8,
      fill,
      extra.font || FONT,
      extra.baseline || 'alphabetic',
      extra.align || 'left',
      extra.strokeWidth || 0,
      extra.stroke || '',
      extra.letterSpacing || '0px',
    );
  };
  paint('UAL123', FILL);
  paint('UAL123', FILL);
  assert.equal(getLabelSpriteCacheStats().entries, 1);
  assert.equal(getLabelSpriteCacheStats().spriteRasters, 0);
  paint('UAL124', FILL);
  paint('UAL123', 'rgba(255, 216, 128, 0.95)');
  paint('UAL123', FILL, { font: '600 13px "JetBrains Mono", monospace' });
  paint('UAL123', FILL, { align: 'center' });
  paint('UAL123', FILL, { baseline: 'top' });
  paint('UAL123', FILL, { letterSpacing: '1px' });
  paint('UAL123', FILL, { strokeWidth: 2, stroke: '#05080c' });
  assert.equal(getLabelSpriteCacheStats().entries, 8);
  setLabelSpriteDpr(2);
  paint('UAL123', FILL);
  assert.equal(
    getLabelSpriteCacheStats().entries,
    1,
    'a DPR change drops the cache',
  );
  assert.ok(store.at(-1).canvas.width > store[0].canvas.width);
});

test('LRU evicts the least recently used sprite by count and by bytes', () => {
  resetSprites();
  const store = [];
  setLabelSpriteCanvasFactory(factoryFrom(store));
  const ctx = recordingContext();
  const paint = (text) => {
    blitLabelSprite(ctx, text, 1, 2, FILL, FONT, 'top', 'left');
  };
  configureLabelSpriteCache({
    entryLimit: 2,
    byteBudget: LABEL_SPRITE_BYTE_BUDGET,
  });
  paint('AAAA');
  paint('BBBB');
  paint('AAAA');
  paint('CCCC');
  assert.equal(getLabelSpriteCacheStats().entries, 2);
  invalidateLabelSpriteCache();
  resetLabelSpriteFrameCounters();
  store.length = 0;
  paint('AAAA');
  const oneSprite = getLabelSpriteCacheStats().bytes;
  assert.ok(oneSprite > 0);
  configureLabelSpriteCache({ entryLimit: 8, byteBudget: oneSprite });
  resetLabelSpriteFrameCounters();
  paint('BBBB');
  assert.equal(getLabelSpriteCacheStats().entries, 1);
  assert.equal(getLabelSpriteCacheStats().bytes, oneSprite);
  resetLabelSpriteFrameCounters();
  paint('AAAA');
  assert.equal(
    getLabelSpriteCacheStats().spriteRasters,
    1,
    'the evicted glyph is rebuilt',
  );
});

test('recency protects a sprite that was drawn again', () => {
  resetSprites();
  setLabelSpriteCanvasFactory(factoryFrom([]));
  configureLabelSpriteCache({ entryLimit: 2 });
  const ctx = recordingContext();
  const paint = (text) =>
    blitLabelSprite(ctx, text, 0, 0, FILL, FONT, 'top', 'left');
  paint('AAAA');
  paint('BBBB');
  paint('AAAA');
  paint('CCCC');
  resetLabelSpriteFrameCounters();
  paint('AAAA');
  assert.equal(getLabelSpriteCacheStats().spriteRasters, 0);
  resetLabelSpriteFrameCounters();
  paint('BBBB');
  assert.equal(getLabelSpriteCacheStats().spriteRasters, 1);
});

test('visual preset and font availability changes drop cached sprites', () => {
  resetSprites();
  setLabelSpriteCanvasFactory(factoryFrom([]));
  const ctx = recordingContext();
  blitLabelSprite(ctx, 'PRESET', 0, 0, FILL, FONT, 'top', 'left');
  assert.equal(getLabelSpriteCacheStats().entries, 1);
  setDetectionStyle('surveillance');
  assert.equal(getLabelSpriteCacheStats().entries, 0);
  blitLabelSprite(ctx, 'PRESET', 0, 0, FILL, FONT, 'top', 'left');
  assert.equal(getLabelSpriteCacheStats().entries, 1);
  clearWorldOverlayTextMeasureCache();
  assert.equal(getLabelSpriteCacheStats().entries, 0);
  setDetectionStyle('normal');
});

test('sprites fall back to direct text when no canvas surface exists', () => {
  resetSprites();
  const previousDocument = globalThis.document;
  const previousOffscreen = globalThis.OffscreenCanvas;
  delete globalThis.document;
  delete globalThis.OffscreenCanvas;
  try {
    const ctx = recordingContext();
    blitLabelSprite(ctx, 'DIRECT', 3, 4, FILL, FONT, 'top', 'left');
    assert.equal(getLabelSpriteCacheStats().textDraws, 1);
    assert.equal(getLabelSpriteCacheStats().spriteBlits, 0);
    assert.equal(getLabelSpriteCacheStats().entries, 0);
    assert.equal(ctx.events.filter(([name]) => name === 'fillText').length, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousOffscreen === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previousOffscreen;
  }
});

test('a detached element canvas is used when OffscreenCanvas is missing', () => {
  resetSprites();
  const previousDocument = globalThis.document;
  const previousOffscreen = globalThis.OffscreenCanvas;
  delete globalThis.OffscreenCanvas;
  const created = [];
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        getContext() {
          return recordingContext();
        },
      };
      created.push(canvas);
      return canvas;
    },
  };
  try {
    const ctx = recordingContext();
    blitLabelSprite(ctx, 'DOM', 2, 2, FILL, FONT, 'alphabetic', 'left');
    assert.equal(created.length, 1);
    assert.equal(getLabelSpriteCacheStats().spriteBlits, 1);
    assert.equal(getLabelSpriteCacheStats().textDraws, 0);
    assert.ok(created[0].width > 0);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousOffscreen === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previousOffscreen;
  }
});

test('OffscreenCanvas wins over a detached element canvas', () => {
  resetSprites();
  const previousDocument = globalThis.document;
  const previousOffscreen = globalThis.OffscreenCanvas;
  let elementCanvases = 0;
  let offscreenCanvases = 0;
  globalThis.document = {
    createElement() {
      elementCanvases++;
      return { width: 0, height: 0, getContext: () => recordingContext() };
    },
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      offscreenCanvases++;
      this.width = width;
      this.height = height;
    }

    getContext() {
      return recordingContext();
    }
  };
  try {
    blitLabelSprite(recordingContext(), 'OFF', 1, 1, FILL, FONT, 'top', 'left');
    assert.equal(offscreenCanvases, 1);
    assert.equal(elementCanvases, 0);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousOffscreen === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previousOffscreen;
  }
});

test('raster time applies the same glyph styling sequence as the direct path', () => {
  resetSprites();
  const direct = recordingContext();
  setLabelSpritesEnabled(false);
  blitLabelSprite(
    direct,
    'HALO',
    12,
    18,
    FILL,
    FONT,
    'alphabetic',
    'center',
    3,
    '#05080c',
    '0.5px',
  );
  const directEvents = direct.events.map(([name]) => name);
  assert.deepEqual(directEvents, ['strokeText', 'fillText']);
  const directStroke = styleTuple(direct.events[0]);
  const directFill = styleTuple(direct.events[1]);
  assert.equal(directStroke.stroke, '#05080c');
  assert.equal(directStroke.lineWidth, 3);
  assert.equal(directFill.fill, FILL);
  assert.equal(directFill.font, FONT);
  assert.equal(directFill.align, 'center');
  assert.equal(directFill.baseline, 'alphabetic');
  assert.equal(directFill.letterSpacing, '0.5px');
  assert.ok(
    direct.events[0][0] === 'strokeText' && direct.events[1][0] === 'fillText',
  );

  setLabelSpritesEnabled(true);
  invalidateLabelSpriteCache();
  const store = [];
  setLabelSpriteCanvasFactory(factoryFrom(store));
  const dest = recordingContext();
  dest.globalAlpha = 0.55;
  blitLabelSprite(
    dest,
    'HALO',
    12.4,
    18.6,
    FILL,
    FONT,
    'alphabetic',
    'center',
    3,
    '#05080c',
    '0.5px',
  );
  assert.deepEqual(styleTuple(store[0].context.events[0]), directStroke);
  assert.deepEqual(styleTuple(store[0].context.events[1]), directFill);
  assert.equal(store[0].context.events[0][1].globalAlpha, 1);
  assert.equal(dest.events.filter(([name]) => name === 'fillText').length, 0);
  assert.equal(dest.events[0][0], 'drawImage');
  assert.equal(dest.events[0][5], 0.55);
  const again = recordingContext();
  again.globalAlpha = 0.55;
  blitLabelSprite(
    again,
    'HALO',
    12.4,
    18.6,
    FILL,
    FONT,
    'alphabetic',
    'center',
    3,
    '#05080c',
    '0.5px',
  );
  assert.deepEqual(again.events[0], dest.events[0]);
});

test('drawLabelGlyphRun is the sequence the rasterizer replays', () => {
  const ctx = recordingContext();
  drawLabelGlyphRun(ctx, 'SEQ', 1, 2, FILL, FONT, 'top', 'left', 0, '', '0px');
  assert.deepEqual(
    ctx.events.map(([name]) => name),
    ['fillText'],
  );
  assert.equal(ctx.events[0][1].font, FONT);
  assert.equal(ctx.events[0][1].fill, FILL);
  assert.equal(ctx.events[0][1].align, 'left');
  assert.equal(ctx.events[0][1].baseline, 'top');
});

test('detection callouts keep fill, font, and alpha while blitting', () => {
  resetSprites();
  const callout = {
    x: 20,
    y: 30,
    w: 80,
    h: 18,
    primaryX: 27,
    microX: 70,
    baseline: 42,
    leadFromX: 60,
    leadFromY: 60,
    leadToX: 60,
    leadToY: 48,
    plate: 'rgba(2, 18, 26, 0.52)',
    accent: '#22e0ff',
    label: 'rgba(200, 250, 255, 0.97)',
    primary: 'JA23NF',
    micro: 'FL017',
    font: '10px JetBrains Mono, monospace',
    microFont: '9px JetBrains Mono, monospace',
  };
  setLabelSpritesEnabled(false);
  const direct = recordingContext();
  direct.roundRect = () => {};
  direct.beginPath = () => {};
  direct.fill = () => {};
  direct.stroke = () => {};
  direct.moveTo = () => {};
  direct.lineTo = () => {};
  direct.save = () => {};
  direct.restore = () => {};
  paintDetectionCallout(direct, callout, 0.8);
  const glyphTuple = (event) => {
    const state = event[1];
    return {
      text: state.text,
      font: state.font,
      fill: state.fill,
      align: state.align,
      baseline: state.baseline,
      letterSpacing: state.letterSpacing,
    };
  };
  const directText = direct.events
    .filter(([name]) => name === 'fillText')
    .map(glyphTuple);

  setLabelSpritesEnabled(true);
  invalidateLabelSpriteCache();
  const store = [];
  setLabelSpriteCanvasFactory(factoryFrom(store));
  const dest = recordingContext();
  dest.roundRect = () => {};
  dest.beginPath = () => {};
  dest.fill = () => {};
  dest.stroke = () => {};
  dest.moveTo = () => {};
  dest.lineTo = () => {};
  paintDetectionCallout(dest, callout, 0.8);
  const rasterText = store.flatMap((surface) =>
    surface.context.events
      .filter(([name]) => name === 'fillText')
      .map(glyphTuple),
  );
  assert.deepEqual(rasterText, directText);
  assert.equal(dest.events.filter(([name]) => name === 'fillText').length, 0);
  const blits = dest.events.filter(([name]) => name === 'drawImage');
  assert.equal(blits.length, 2);
  assert.equal(blits[0][5], 0.8);
  assert.ok(Math.abs(blits[1][5] - 0.64) < 1e-12);
  assert.ok(
    store.every((surface) =>
      surface.context.events.every((event) => event[1].globalAlpha === 1),
    ),
  );
});

test('very long strings skip the sprite and draw directly', () => {
  resetSprites();
  configureLabelSpriteCache({ maxCssWidth: 24 });
  setLabelSpriteCanvasFactory(factoryFrom([]));
  const ctx = recordingContext();
  blitLabelSprite(ctx, 'X'.repeat(40), 0, 0, FILL, FONT, 'top', 'left');
  assert.equal(getLabelSpriteCacheStats().entries, 0);
  assert.equal(getLabelSpriteCacheStats().textDraws, 1);
  assert.equal(getLabelSpriteCacheStats().spriteBlits, 0);
});

test('sub-pixel blit positions stay on the same device pixel', () => {
  resetSprites();
  setLabelSpriteCanvasFactory(factoryFrom([]));
  setLabelSpriteDpr(2);
  const first = recordingContext();
  const second = recordingContext();
  blitLabelSprite(first, 'PIX', 10.2, 4.4, FILL, FONT, 'top', 'left');
  blitLabelSprite(second, 'PIX', 10.2, 4.4, FILL, FONT, 'top', 'left');
  assert.deepEqual(second.events[0].slice(0, 5), first.events[0].slice(0, 5));
  const shifted = recordingContext();
  blitLabelSprite(shifted, 'PIX', 10.7, 4.4, FILL, FONT, 'top', 'left');
  assert.notEqual(shifted.events[0][1], first.events[0][1]);
});

test('a synthetic 5000-label frame blits cached glyphs instead of redrawing text', () => {
  resetSprites();
  configureLabelSpriteCache({
    entryLimit: 8192,
    byteBudget: LABEL_SPRITE_BYTE_BUDGET,
  });
  const labels = Array.from({ length: 5000 }, (_value, index) => `L${index}`);
  const placement = {
    corner: 'above',
    rect: { x: 12, y: 14, w: 80, h: 18 },
    leadFromX: 40,
    leadFromY: 40,
    leadToX: 40,
    leadToY: 32,
    leaderOffset: 0,
    paintScale: 1,
  };
  const entry = { title: labels[0], variant: 'label', accent: '#6be8ff' };
  function benchContext() {
    return {
      globalAlpha: 1,
      font: '',
      fillStyle: '',
      strokeStyle: '',
      textAlign: 'start',
      textBaseline: 'top',
      letterSpacing: '0px',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      measureText(text) {
        return { width: String(text).length * 6 };
      },
      save() {},
      restore() {},
      beginPath() {},
      roundRect() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fill() {},
      fillRect() {},
      fillText() {},
      strokeText() {},
      drawImage() {},
      setTransform() {},
    };
  }
  const paintFrame = (ctx) => {
    resetLabelSpriteFrameCounters();
    for (let i = 0; i < labels.length; i++) {
      entry.title = labels[i];
      paintLabel(ctx, entry, placement, 1);
    }
    return getLabelSpriteCacheStats();
  };
  setLabelSpritesEnabled(false);
  const directStarted = performance.now();
  let directStats = null;
  for (let frame = 0; frame < 4; frame++)
    directStats = paintFrame(benchContext());
  const directMsPerFrame = (performance.now() - directStarted) / 4;

  setLabelSpritesEnabled(true);
  setLabelSpriteCanvasFactory((width, height) => ({
    canvas: { width, height },
    context: benchContext(),
  }));
  invalidateLabelSpriteCache();
  const coldStarted = performance.now();
  const coldStats = paintFrame(benchContext());
  const coldMs = performance.now() - coldStarted;
  const warmStarted = performance.now();
  let warmStats = null;
  for (let frame = 0; frame < 4; frame++)
    warmStats = paintFrame(benchContext());
  const warmMsPerFrame = (performance.now() - warmStarted) / 4;

  assert.equal(directStats.textDraws, 5000);
  assert.equal(directStats.spriteBlits, 0);
  assert.equal(coldStats.textDraws, 0);
  assert.equal(coldStats.spriteBlits, 5000);
  assert.equal(coldStats.spriteRasters, 5000);
  assert.equal(warmStats.textDraws, 0);
  assert.equal(warmStats.spriteBlits, 5000);
  assert.equal(warmStats.spriteRasters, 0);
  assert.equal(warmStats.entries, 5000);
  console.log(
    JSON.stringify({
      labels: 5000,
      directTextDraws: directStats.textDraws,
      directSpriteBlits: directStats.spriteBlits,
      directMsPerFrame,
      coldTextDraws: coldStats.textDraws,
      coldSpriteBlits: coldStats.spriteBlits,
      coldSpriteRasters: coldStats.spriteRasters,
      coldMs,
      warmTextDraws: warmStats.textDraws,
      warmSpriteBlits: warmStats.spriteBlits,
      warmSpriteRasters: warmStats.spriteRasters,
      warmMsPerFrame,
      spriteBytes: warmStats.bytes,
    }),
  );
});
