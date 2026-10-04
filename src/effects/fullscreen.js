// Port of Demo.FullScreen (the static Demo.fs): HDR target -> adaptive tonemap -> depth of field.
// Techniques (txtr, downsample, intensity, tonemap, dof, adjustcolours) and parameter names come from
// Content/Effects/fullscreen.xnb; shader bodies are reconstructions.
import * as THREE from 'three';
import { WIDTH, HEIGHT } from '../engine.js';

export const DOF = 1;
export const TONEMAPPING = 2;

const COPY_FS = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D(map, vUv); }`;

// Downsample: four taps at (-level, -level), (1+level, -level), ... texels, as set in Downsample().
const DOWNSAMPLE_FS = /* glsl */ `
  uniform sampler2D map;
  uniform vec2 texel;
  uniform float level;
  varying vec2 vUv;
  void main() {
    float a = -level;
    float b = 1.0 + level;
    gl_FragColor = 0.25 * (texture2D(map, vUv + vec2(a, a) * texel) + texture2D(map, vUv + vec2(b, a) * texel)
                         + texture2D(map, vUv + vec2(b, b) * texel) + texture2D(map, vUv + vec2(a, b) * texel));
  }`;

// ponytail: grid size and adaptation rate guessed ("num"/"numi" in the original select the grid)
const INTENSITY_FS = /* glsl */ `
  uniform sampler2D tdiffuse;
  uniform sampler2D told;
  varying vec2 vUv;
  void main() {
    float sum = 0.0;
    for (int y = 0; y < 8; y++) {
      for (int x = 0; x < 8; x++) {
        vec3 c = texture2D(tdiffuse, (vec2(x, y) + 0.5) / 8.0).rgb;
        sum += dot(c, vec3(0.3, 0.59, 0.11));
      }
    }
    float current = sum / 64.0;
    float old = texture2D(told, vec2(0.5)).r;
    gl_FragColor = vec4(vec3(mix(old, current, 0.08)), 1.0);
  }`;

const TONEMAP_FS = /* glsl */ `
  uniform sampler2D tdiffuse;
  uniform sampler2D tintense;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tdiffuse, vUv).rgb;
    float avg = max(texture2D(tintense, vec2(0.5)).r, 0.05);
    vec3 m = c * (0.5 / avg);
    gl_FragColor = vec4(m * (1.0 + m / 4.0) / (1.0 + m), 1.0);
  }`;

const DOF_FS = /* glsl */ `
  uniform sampler2D raw;
  uniform sampler2D blur;
  uniform sampler2D depth;
  uniform float focaldist;
  uniform float focalrange;
  varying vec2 vUv;
  void main() {
    float d = texture2D(depth, vUv).a;
    float f = clamp(abs(d - focaldist) / focalrange, 0.0, 1.0);
    gl_FragColor = vec4(mix(texture2D(raw, vUv).rgb, texture2D(blur, vUv).rgb, f), 1.0);
  }`;

// adjustcolours with the defaults the demo leaves in place (contrast 1, saturation 1, no fade) is a copy.
const ADJUST_FS = COPY_FS;

function floatTarget(width, height, depthBuffer) {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer,
  });
}

class FullScreen {
  constructor(ctx) {
    this.ctx = ctx;
    this.flags = 1;
    this.hdr = floatTarget(WIDTH, HEIGHT, true);
    this.ldr = ctx.createTarget(WIDTH, HEIGHT, false);
    this.dofblur = ctx.createTarget(WIDTH / 2, HEIGHT / 2, false);
    this.blur0 = ctx.createTarget(WIDTH / 4, HEIGHT / 4, false);
    this.blur1 = ctx.createTarget(WIDTH / 4, HEIGHT / 4, false);
    this.intensity = [floatTarget(1, 1, false), floatTarget(1, 1, false)];
    this.current = 0;
    this.materials = {
      copy: ctx.createQuadMaterial(COPY_FS, { map: { value: null } }),
      downsample: ctx.createQuadMaterial(DOWNSAMPLE_FS, { map: { value: null }, texel: { value: new THREE.Vector2() }, level: { value: 0 } }),
      intensity: ctx.createQuadMaterial(INTENSITY_FS, { tdiffuse: { value: null }, told: { value: null } }),
      tonemap: ctx.createQuadMaterial(TONEMAP_FS, { tdiffuse: { value: null }, tintense: { value: null } }),
      dof: ctx.createQuadMaterial(DOF_FS, {
        raw: { value: null }, blur: { value: null }, depth: { value: null },
        focaldist: { value: 18 }, focalrange: { value: 10 },
      }),
      adjust: ctx.createQuadMaterial(ADJUST_FS, { map: { value: null } }),
    };
    this.clearIntensity();
  }

  clearIntensity() {
    const { renderer } = this.ctx;
    for (const target of this.intensity) {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, false, false);
    }
  }

  setFlags(flags) {
    this.flags = flags;
  }

  setFocus(dist, range) {
    this.materials.dof.uniforms.focaldist.value = dist;
    this.materials.dof.uniforms.focalrange.value = range;
  }

  on(flag) {
    return (this.flags & flag) !== 0;
  }

  /** Returns the target the scene should be drawn into (cleared to black like the original). */
  beginFrame() {
    if (!this.on(DOF | TONEMAPPING)) {
      return this.ctx.backBuffer;
    }
    const { renderer } = this.ctx;
    renderer.setRenderTarget(this.hdr);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    return this.hdr;
  }

  draw(name, uniforms, target) {
    const mat = this.materials[name];
    for (const [key, value] of Object.entries(uniforms)) {
      mat.uniforms[key].value = value;
    }
    this.ctx.drawQuad(mat, target);
  }

  downsample(src, dst, level) {
    this.draw('downsample', { map: src.texture, texel: new THREE.Vector2(1 / src.width, 1 / src.height), level }, dst);
  }

  /** Composite the frame into the demo back buffer. */
  endFrame() {
    let frame;
    if (this.on(TONEMAPPING)) {
      const next = this.intensity[this.current];
      const old = this.intensity[1 - this.current];
      this.draw('intensity', { tdiffuse: this.hdr.texture, told: old.texture }, next);
      this.draw('tonemap', { tdiffuse: this.hdr.texture, tintense: next.texture }, this.ldr);
      this.current = 1 - this.current;
      frame = this.ldr;
    } else if (this.on(DOF)) {
      this.draw('copy', { map: this.hdr.texture }, this.ldr);
      frame = this.ldr;
    } else {
      this.ctx.resolveBackBuffer();
      frame = this.ctx.resolveTarget;
    }
    if (!this.on(DOF)) {
      this.draw('adjust', { map: frame.texture }, this.ctx.backBuffer);
      return;
    }
    this.draw('copy', { map: frame.texture }, this.dofblur);
    this.draw('copy', { map: this.dofblur.texture }, this.blur0);
    this.downsample(this.blur0, this.blur1, 0);
    this.downsample(this.blur1, this.blur0, 1);
    this.draw('dof', { raw: frame.texture, blur: this.blur0.texture, depth: this.hdr.texture }, this.ctx.backBuffer);
  }
}

let shared = null;

/** The demo keeps one FullScreen for all scenes (Demo.fs). */
export function getFullScreen(ctx) {
  shared ??= new FullScreen(ctx);
  return shared;
}
