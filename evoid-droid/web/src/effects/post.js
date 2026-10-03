// Full-screen effects: GlowEffect (stock XNA Bloom sample), FlashEffect, ImageEffect, ChangeImageEffect.
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT, clamp01 } from '../engine.js';

// [threshold, blurAmount, bloomIntensity, baseIntensity, bloomSaturation, baseSaturation]
const BLOOM_PRESETS = [
  [0.25, 4, 1.25, 1, 1, 1], // Default
  [0, 3, 1, 1, 1, 1], // Soft
  [0.5, 8, 2, 1, 0, 1], // Desaturated
  [0.25, 4, 2, 1, 2, 0], // Saturated
  [0, 2, 1, 0.1, 1, 1], // Blurry
  [0.5, 2, 1, 1, 1, 1], // Subtle
  [0, 3, 1, 1, 2.5, 1], // Soft (oversaturated)
];
const BLUR_SAMPLES = 15;

const BLOOM_EXTRACT_FS = /* glsl */ `
  uniform sampler2D map;
  uniform float BloomThreshold;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(map, vUv);
    gl_FragColor = clamp((c - BloomThreshold) / (1.0 - BloomThreshold), 0.0, 1.0);
  }`;

const GAUSSIAN_BLUR_FS = /* glsl */ `
  uniform sampler2D map;
  uniform float SampleWeights[${BLUR_SAMPLES}];
  uniform vec2 SampleOffsets[${BLUR_SAMPLES}];
  varying vec2 vUv;
  void main() {
    vec4 c = vec4(0.0);
    for (int i = 0; i < ${BLUR_SAMPLES}; i++) {
      c += texture2D(map, vUv + SampleOffsets[i]) * SampleWeights[i];
    }
    gl_FragColor = c;
  }`;

const BLOOM_COMBINE_FS = /* glsl */ `
  uniform sampler2D map;      // bloom
  uniform sampler2D baseMap;  // resolved scene
  uniform float BloomIntensity, BaseIntensity, BloomSaturation, BaseSaturation;
  varying vec2 vUv;
  vec4 adjustSaturation(vec4 c, float s) {
    float grey = dot(c.rgb, vec3(0.3, 0.59, 0.11));
    return mix(vec4(grey), c, s);
  }
  void main() {
    vec4 bloom = adjustSaturation(texture2D(map, vUv), BloomSaturation) * BloomIntensity;
    vec4 base = adjustSaturation(texture2D(baseMap, vUv), BaseSaturation) * BaseIntensity;
    base *= (1.0 - clamp(bloom, 0.0, 1.0));
    gl_FragColor = base + bloom;
  }`;

export class GlowEffect extends DemoEffect {
  async load() {
    const ctx = this.ctx;
    this.rt1 = ctx.createTarget(WIDTH / 2, HEIGHT / 2, false);
    this.rt2 = ctx.createTarget(WIDTH / 2, HEIGHT / 2, false);
    this.extract = ctx.createQuadMaterial(BLOOM_EXTRACT_FS, { map: { value: null }, BloomThreshold: { value: 0 } });
    this.blur = ctx.createQuadMaterial(GAUSSIAN_BLUR_FS, {
      map: { value: null },
      SampleWeights: { value: new Array(BLUR_SAMPLES).fill(0) },
      SampleOffsets: { value: Array.from({ length: BLUR_SAMPLES }, () => new THREE.Vector2()) },
    });
    this.combine = ctx.createQuadMaterial(BLOOM_COMBINE_FS, {
      map: { value: null },
      baseMap: { value: null },
      BloomIntensity: { value: 1 },
      BaseIntensity: { value: 1 },
      BloomSaturation: { value: 1 },
      BaseSaturation: { value: 1 },
    });
    this.reset();
  }

  reset() {
    super.reset();
    this.preset = BLOOM_PRESETS[4];
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    if (ev.type === 'GlowPreset') {
      this.preset = BLOOM_PRESETS[ev.p[0]];
    }
  }

  setBlurParameters(dx, dy) {
    const blurAmount = this.preset[1];
    const gaussian = (n) => (1 / Math.sqrt(2 * Math.PI * blurAmount)) * Math.exp(-(n * n) / (2 * blurAmount * blurAmount));
    const weights = this.blur.uniforms.SampleWeights.value;
    const offsets = this.blur.uniforms.SampleOffsets.value;
    weights[0] = gaussian(0);
    offsets[0].set(0, 0);
    let total = weights[0];
    for (let i = 0; i < Math.floor(BLUR_SAMPLES / 2); i++) {
      const w = gaussian(i + 1);
      weights[i * 2 + 1] = weights[i * 2 + 2] = w;
      total += w * 2;
      const o = i * 2 + 1.5;
      offsets[i * 2 + 1].set(dx * o, dy * o);
      offsets[i * 2 + 2].set(-dx * o, -dy * o);
    }
    for (let i = 0; i < BLUR_SAMPLES; i++) {
      weights[i] /= total;
    }
  }

  render() {
    const ctx = this.ctx;
    const [threshold, , bloomIntensity, baseIntensity, bloomSaturation, baseSaturation] = this.preset;
    const scene = ctx.resolveBackBuffer();

    this.extract.uniforms.map.value = scene;
    this.extract.uniforms.BloomThreshold.value = threshold;
    ctx.drawQuad(this.extract, this.rt1);

    this.setBlurParameters(1 / this.rt1.width, 0);
    this.blur.uniforms.map.value = this.rt1.texture;
    ctx.drawQuad(this.blur, this.rt2);
    this.setBlurParameters(0, 1 / this.rt1.height);
    this.blur.uniforms.map.value = this.rt2.texture;
    ctx.drawQuad(this.blur, this.rt1);

    const u = this.combine.uniforms;
    u.map.value = this.rt1.texture;
    u.baseMap.value = scene;
    u.BloomIntensity.value = bloomIntensity;
    u.BaseIntensity.value = baseIntensity;
    u.BloomSaturation.value = bloomSaturation;
    u.BaseSaturation.value = baseSaturation;
    ctx.drawQuad(this.combine);
  }
}

/** Solid-colour overlay whose alpha fades over `duration`, or follows an interpolator. */
export class FlashEffect extends DemoEffect {
  async load() {
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.needsUpdate = true;
    this.white = white;
    this.reset();
  }

  reset() {
    super.reset();
    this.color = [1, 1, 1, 1];
    this.duration = 100;
    this.fadeIn = false;
    this.interpolator = null;
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    switch (ev.type) {
      case 'FlashDuration':
        this.duration = ev.p[0];
        break;
      case 'FlashFadeDirection':
        this.fadeIn = ev.p[0] === 1;
        break;
      case 'FlashColor':
        this.color = [...ev.p];
        break;
      case 'SetInterpolator':
        this.interpolator = ev.obj;
        break;
    }
  }

  render(time) {
    const elapsed = time - this.startTime;
    let amount;
    if (this.interpolator) {
      amount = this.interpolator.getValue(elapsed);
    } else {
      const f = elapsed / this.duration;
      amount = this.fadeIn ? f : 1 - f;
    }
    const [r, g, b, a] = this.color;
    this.ctx.drawSprite(this.white, null, [r, g, b, clamp01(a * amount)]);
  }
}

/** Draws one of a fixed set of textures (selected by SetTexture) over a rect. */
export class ImageEffect extends DemoEffect {
  constructor(ctx, textureNames) {
    super(ctx);
    this.textureNames = textureNames;
    this.textures = new Map();
  }

  async load() {
    await Promise.all(this.textureNames.map(async (name) => {
      this.textures.set(name, await this.ctx.loadTexture(name));
    }));
    this.reset();
  }

  reset() {
    super.reset();
    this.rect = null;
    this.blend = 'alpha';
    this.current = null;
    this.interpolator = null;
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    switch (ev.type) {
      case 'ImageRect': {
        const [x, y, w, h] = ev.p;
        // The original scales height by viewport *width* too; kept as-is.
        this.rect = { x: WIDTH * x, y: HEIGHT * y, w: WIDTH * w, h: WIDTH * h };
        break;
      }
      case 'ImageBlend':
        if (ev.s === 'Additive') {
          this.blend = 'additive';
        }
        break;
      case 'SetInterpolator':
        this.interpolator = ev.obj;
        break;
      case 'SetTexture':
        this.current = this.textures.get(ev.s) ?? null;
        break;
    }
  }

  render(time) {
    if (!this.current) {
      return;
    }
    const alpha = this.interpolator ? this.interpolator.getValue(time - this.startTime) : 1;
    this.ctx.drawSprite(this.current, this.rect, [1, 1, 1, alpha], this.blend);
  }
}

// ChangeImage techniques. Parameter names are from ChangeImage.xnb; the bodies are reconstructions.
const CHANGE_IMAGE_FS = /* glsl */ `
  uniform sampler2D fromMap;
  uniform sampler2D toMap;
  uniform float fT;
  uniform float fCount;
  uniform vec2 fSwipeDir;
  uniform vec2 fRTDimensions;
  uniform int technique; // 0 Circles, 1 ZoomFrom, 2 ZoomTo
  varying vec2 vUv;
  void main() {
    vec4 to = texture2D(toMap, vUv);
    if (technique == 1) {
      // ZoomFrom samples the old frame with a point sampler: blocky pixelation into the new image.
      float block = 1.0 + floor(fT * fT * 96.0);
      vec2 px = (floor(vUv * fRTDimensions / block) + 0.5) * block / fRTDimensions;
      gl_FragColor = mix(texture2D(fromMap, px), to, fT * fT);
    } else if (technique == 2) {
      vec2 zoomed = 0.5 + (vUv - 0.5) * (1.0 - 0.5 * (1.0 - fT));
      gl_FragColor = mix(texture2D(fromMap, vUv), texture2D(toMap, zoomed), fT);
    } else {
      vec2 aspect = vec2(fRTDimensions.x / fRTDimensions.y, 1.0);
      vec2 cell = fract(vUv * aspect * fCount) - 0.5;
      float sweep = dot(vUv - 0.5, fSwipeDir) * 0.5;
      float radius = clamp(fT * 1.6 - 0.3 + sweep, 0.0, 1.0) * 0.75;
      gl_FragColor = length(cell) < radius ? to : texture2D(fromMap, vUv);
    }
  }`;

/** Transition from the current frame to a fixed image; `t` advances at fadeSpeed per second. */
export class ChangeImageEffect extends DemoEffect {
  constructor(ctx, imageName) {
    super(ctx);
    this.imageName = imageName;
  }

  async load() {
    const image = await this.ctx.loadTexture(this.imageName);
    this.material = this.ctx.createQuadMaterial(CHANGE_IMAGE_FS, {
      fromMap: { value: null },
      toMap: { value: image },
      fT: { value: 0 },
      fCount: { value: 16 },
      fSwipeDir: { value: new THREE.Vector2(1, 0) },
      fRTDimensions: { value: new THREE.Vector2(WIDTH, HEIGHT) },
      technique: { value: 0 },
    });
    this.reset();
  }

  reset() {
    super.reset();
    this.isFadingIn = true;
    this.t = 0;
    this.fadeSpeed = 0.5;
    if (this.material) {
      this.material.uniforms.technique.value = 0;
    }
  }

  init(time) {
    super.init(time);
    this.lastTime = time;
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    const u = this.material.uniforms;
    switch (ev.type) {
      case 'FadeIn':
        this.isFadingIn = true;
        break;
      case 'FadeOut':
        this.isFadingIn = false;
        break;
      case 'FadeSpeed':
        this.fadeSpeed = ev.p[0];
        break;
      case 'FadeDirection':
        u.fSwipeDir.value.set(ev.p[0], ev.p[1]);
        break;
      case 'FadeType':
        u.technique.value = Math.floor(ev.p[0] + 0.5);
        break;
      case 'FadeAlpha':
        this.t = ev.p[0];
        break;
    }
  }

  render(time) {
    const step = (time - this.lastTime) * 0.001 * this.fadeSpeed;
    this.t = clamp01(this.t + (this.isFadingIn ? step : -step));
    this.lastTime = time;
    const u = this.material.uniforms;
    u.fT.value = this.t;
    u.fromMap.value = this.ctx.resolveBackBuffer();
    this.ctx.drawQuad(this.material);
  }
}
