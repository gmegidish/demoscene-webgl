// Port of Demo.EdgeDetectEffect ("EdgeDetectColour" technique): fades the frame towards its own
// colour-preserving edge image. Parameter names/defaults from EdgeDetect.xnb; the body is a reconstruction.
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT, clamp01 } from '../engine.js';

const EDGE_DETECT_COLOUR_FS = /* glsl */ `
  uniform sampler2D base_Tex;
  uniform vec2 fRTDimensions;
  uniform float fEdgeWidth;
  uniform float fEdgeFactor;
  uniform float fAlpha;
  varying vec2 vUv;
  float luma(vec2 offset) {
    return dot(texture2D(base_Tex, vUv + offset * fEdgeWidth / fRTDimensions).rgb, vec3(0.3, 0.59, 0.11));
  }
  void main() {
    // Sobel on luminance
    float tl = luma(vec2(-1.0, 1.0)), t = luma(vec2(0.0, 1.0)), tr = luma(vec2(1.0, 1.0));
    float l = luma(vec2(-1.0, 0.0)), r = luma(vec2(1.0, 0.0));
    float bl = luma(vec2(-1.0, -1.0)), b = luma(vec2(0.0, -1.0)), br = luma(vec2(1.0, -1.0));
    float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
    float edge = clamp(length(vec2(gx, gy)) * fEdgeFactor, 0.0, 1.0);
    vec4 base = texture2D(base_Tex, vUv);
    // ponytail: "colour" edges = the frame's own colour where edges are, black elsewhere
    gl_FragColor = mix(base, vec4(base.rgb * edge, 1.0), fAlpha);
  }`;

class EdgeDetectEffect extends DemoEffect {
  async load() {
    this.material = this.ctx.createQuadMaterial(EDGE_DETECT_COLOUR_FS, {
      base_Tex: { value: null },
      fRTDimensions: { value: new THREE.Vector2(WIDTH, HEIGHT) },
      fEdgeWidth: { value: 1.5 },
      fEdgeFactor: { value: 1.5 },
      fAlpha: { value: 0 },
    });
    this.reset();
  }

  reset() {
    super.reset();
    this.alpha = 0;
    this.fadeSpeed = -1;
  }

  init(time) {
    super.init(time);
    this.lastTime = time;
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    switch (ev.type) {
      case 'FadeIn':
        this.fadeSpeed = Math.abs(this.fadeSpeed);
        break;
      case 'FadeOut':
        this.fadeSpeed = -Math.abs(this.fadeSpeed);
        break;
      case 'FadeSpeed':
        this.fadeSpeed = Math.sign(this.fadeSpeed) * Math.abs(ev.p[0]);
        if (this.fadeSpeed === 0) {
          this.fadeSpeed = ev.p[0];
        }
        break;
      case 'FadeAlpha':
        this.alpha = ev.p[0];
        break;
    }
  }

  render(time) {
    this.alpha = clamp01(this.alpha + this.fadeSpeed * (time - this.lastTime) * 0.001);
    this.lastTime = time;
    const u = this.material.uniforms;
    u.base_Tex.value = this.ctx.resolveBackBuffer();
    u.fAlpha.value = this.alpha;
    this.ctx.drawQuad(this.material);
  }
}

export default (ctx) => new EdgeDetectEffect(ctx);
