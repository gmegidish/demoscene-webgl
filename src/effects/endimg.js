// Port of Demo.EndImageEffect: the closing painting. The background layer starts blurred and pulls
// into focus over 4 s (two separable blur passes per frame), then foreground, light rays and logo
// are composited on top. Parameter names/defaults come from Blur.xnb and EndImage.xnb; the
// shader bodies are reconstructions.
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT, clamp01 } from '../engine.js';

const ZOOM_SPEED = 0.25;
const BLUR_TAPS = 4; // each side

const BLUR_FS = /* glsl */ `
  uniform sampler2D base_Tex;
  uniform vec2 fViewportDimensions;
  uniform float fBlurriness;
  uniform vec2 direction;
  varying vec2 vUv;
  void main() {
    vec2 step = direction * fBlurriness / fViewportDimensions;
    vec4 sum = vec4(0.0);
    float total = 0.0;
    for (int i = -${BLUR_TAPS}; i <= ${BLUR_TAPS}; i++) {
      float w = exp(-float(i * i) / 8.0);
      sum += texture2D(base_Tex, vUv + step * float(i)) * w;
      total += w;
    }
    gl_FragColor = sum / total;
  }`;

const END_IMAGE_FS = /* glsl */ `
  uniform sampler2D backMap;
  uniform sampler2D foreMap;
  uniform sampler2D lightMap;
  uniform sampler2D logoMap;
  uniform float fT;
  uniform vec2 fMinLogo;
  uniform vec2 fMaxLogo;
  varying vec2 vUv;
  void main() {
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y); // D3D top-left texture space, as the original quad used
    vec2 gl = vec2(uv.x, 1.0 - uv.y);
    vec3 col = texture2D(backMap, vUv).rgb;
    vec4 fore = texture2D(foreMap, gl);
    col = mix(col, fore.rgb, fore.a);
    // ponytail: light-ray shimmer speed and strength chosen by eye
    vec4 light = texture2D(lightMap, gl);
    col += light.rgb * light.a * (0.7 + 0.3 * sin(fT * 10.0)) * clamp(fT, 0.0, 1.0);
    vec2 logoUv = (uv - fMinLogo) / (fMaxLogo - fMinLogo);
    if (all(greaterThanEqual(logoUv, vec2(0.0))) && all(lessThanEqual(logoUv, vec2(1.0)))) {
      vec4 logo = texture2D(logoMap, vec2(logoUv.x, 1.0 - logoUv.y));
      col = mix(col, logo.rgb, logo.a * clamp(fT - 0.5, 0.0, 1.0));
    }
    gl_FragColor = vec4(col, 1.0);
  }`;

export class EndImageEffect extends DemoEffect {
  async load() {
    const ctx = this.ctx;
    const [fore, back, light, logo] = await Promise.all(
      ['endpic_1280_fore', 'endpic_1280_back', 'endpic_1280_light', 'logo_evoiddroid'].map((n) => ctx.loadTexture(`textures/${n}`)),
    );
    this.background = back;
    this.blurred = [ctx.createTarget(WIDTH, HEIGHT, false), ctx.createTarget(WIDTH, HEIGHT, false)];
    this.blurMaterial = ctx.createQuadMaterial(BLUR_FS, {
      base_Tex: { value: null },
      fViewportDimensions: { value: new THREE.Vector2(WIDTH, HEIGHT) },
      fBlurriness: { value: 1 },
      direction: { value: new THREE.Vector2(1, 0) },
    });
    this.endMaterial = ctx.createQuadMaterial(END_IMAGE_FS, {
      backMap: { value: this.blurred[1].texture },
      foreMap: { value: fore },
      lightMap: { value: light },
      logoMap: { value: logo },
      fT: { value: 1 },
      fMinLogo: { value: new THREE.Vector2(0.039, 0.729) },
      fMaxLogo: { value: new THREE.Vector2(0.641, 0.938) },
    });
  }

  /** Horizontal into blurred[0], vertical into blurred[1]; strength fades to 0 as t reaches 1. */
  blur(texture, t) {
    const u = this.blurMaterial.uniforms;
    u.fBlurriness.value = 4 * (1 - clamp01(t));
    u.base_Tex.value = texture;
    u.direction.value.set(1, 0);
    this.ctx.drawQuad(this.blurMaterial, this.blurred[0]);
    u.base_Tex.value = this.blurred[0].texture;
    u.direction.value.set(0, 1);
    this.ctx.drawQuad(this.blurMaterial, this.blurred[1]);
  }

  render(time) {
    const t = (time - this.startTime) * 0.001 * ZOOM_SPEED;
    this.blur(this.background, t);
    this.blur(this.blurred[1].texture, t);
    this.endMaterial.uniforms.fT.value = t;
    this.ctx.drawQuad(this.endMaterial);
  }
}

export default (ctx) => new EndImageEffect(ctx);
