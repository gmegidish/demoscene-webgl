// Port of Demo.TextEffect: a message starts as a seeded shuffle of its letters, then adjacent pairs
// swap back into place one at a time (every swapSpeed ms), each swap animated with a smoothstep
// slide and a catmull-rom "pop" in scale. Glyphs come from the rns_serial SpriteFont.
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT } from '../engine.js';
import { DotNetRandom } from '../dotnetRandom.js';

const FONT = 'rns_serial';
const CHAR_STEP = 54;
const SHUFFLE_SEED = 1337;

const GLYPH_FS = /* glsl */ `
  uniform sampler2D map;
  uniform vec4 uUvRect; // u0, v0 (bottom), u1, v1 (top)
  uniform vec4 uColor;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(map, mix(uUvRect.xy, uUvRect.zw, vUv)) * uColor;
  }`;

function smoothStep(a, b, amount) {
  const x = Math.min(1, Math.max(0, amount));
  return a + (b - a) * (x * x * (3 - 2 * x));
}

function catmullRom(p1, p2, p3, p4, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p2 + (p3 - p1) * t + (2 * p1 - 5 * p2 + 4 * p3 - p4) * t2 + (3 * p2 - p1 - 3 * p3 + p4) * t3);
}

function swap(arr, i, j) {
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

class TextEffect extends DemoEffect {
  async load() {
    const [font, sheet] = await Promise.all([
      fetch(`../assets/fonts/${FONT}.json`).then((r) => r.json()),
      this.ctx.loadTexture(FONT),
    ]);
    this.font = font;
    this.sheet = sheet;
    this.material = this.ctx.createQuadMaterial(GLYPH_FS, {
      map: { value: sheet },
      uUvRect: { value: new THREE.Vector4() },
      uColor: { value: new THREE.Vector4(1, 1, 1, 1) },
    }, THREE.NormalBlending);
    this.goal = [];
    this.reset();
  }

  reset() {
    super.reset();
    this.startPos = { x: 40, y: 460 };
    this.setMessage('empty text');
    this.init(0);
    this.swapSpeed = 250;
  }

  init(time) {
    super.init(time);
    this.lastTime = time;
    // The original calls setMessage(goal.ToString()) on a char[], which yields this literal.
    this.setMessage('System.Char[]');
  }

  setMessage(text) {
    this.goal = [...text];
    this.current = [...text];
    this.swaps = this.shuffle(this.current);
    this.timeDelta = 0;
    this.curPos = 0;
  }

  /** Applies maxSwaps random adjacent swaps (each index once) and returns them in order. */
  shuffle(chars) {
    const maxSwaps = chars.length - 1;
    const remaining = Array.from({ length: maxSwaps }, (_, i) => i);
    const random = new DotNetRandom(SHUFFLE_SEED);
    const swaps = [];
    for (let i = 0; i < maxSwaps; i++) {
      const [k] = remaining.splice(random.next(remaining.length), 1);
      swap(chars, k, k + 1);
      swaps.push(k);
    }
    return swaps;
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    switch (ev.type) {
      case 'TextMessage':
        this.setMessage(ev.s);
        this.lastTime = ev.time;
        break;
      case 'TextSpeed':
        this.swapSpeed = Math.trunc(ev.p[0]);
        break;
      case 'TextPos':
        this.startPos = { x: ev.p[0] * WIDTH, y: ev.p[1] * HEIGHT };
        break;
    }
  }

  /** Undoes the next shuffle swap whenever swapSpeed ms have accumulated; the last one stays mid-air at t=1. */
  advanceSwaps(time) {
    this.timeDelta += time - this.lastTime;
    this.lastTime = time;
    if (this.timeDelta <= this.swapSpeed) {
      return;
    }
    if (this.curPos < this.swaps.length - 1) {
      this.timeDelta -= this.swapSpeed;
      const k = this.swaps[this.swaps.length - 1 - this.curPos];
      swap(this.current, k, k + 1);
      this.curPos++;
    } else {
      this.timeDelta = this.swapSpeed;
    }
  }

  layout() {
    const offsets = this.current.map((_, i) => i * CHAR_STEP);
    const scales = this.current.map(() => 1);
    if (this.swaps.length === 0) {
      return { offsets, scales };
    }
    const t = this.timeDelta / this.swapSpeed;
    const k = this.swaps[this.swaps.length - 1 - this.curPos];
    offsets[k] = smoothStep(k * CHAR_STEP, (k + 1) * CHAR_STEP, t);
    offsets[k + 1] = smoothStep((k + 1) * CHAR_STEP, k * CHAR_STEP, t);
    scales[k] = catmullRom(1, 1, 1.6, 1, t * 1.55);
    scales[k + 1] = catmullRom(1, 1, 0.4, 1, t * 1.55);
    return { offsets, scales };
  }

  /** SpriteBatch.DrawString of one character with origin (27, 27) and uniform scale. */
  drawChar(char, x, y, scale) {
    const index = this.font.characterMap[char];
    if (index === undefined) {
      return;
    }
    const [gx, gy, gw, gh] = this.font.glyphs[index];
    const [cx, cy] = this.font.cropping[index];
    const origin = CHAR_STEP / 2;
    const { width, height } = this.sheet.image;
    // Sheet is loaded with flipY, so image row y maps to v = 1 - y / height.
    this.material.uniforms.uUvRect.value.set(gx / width, 1 - (gy + gh) / height, (gx + gw) / width, 1 - gy / height);
    this.ctx.drawQuad(this.material, this.ctx.backBuffer, {
      x: x + (cx - origin) * scale,
      y: y + (cy - origin) * scale,
      w: gw * scale,
      h: gh * scale,
    });
  }

  render(time) {
    this.advanceSwaps(time);
    const { offsets, scales } = this.layout();
    this.current.forEach((char, i) => {
      this.drawChar(char, this.startPos.x + offsets[i], this.startPos.y, scales[i]);
    });
  }
}

export default (ctx) => new TextEffect(ctx);
