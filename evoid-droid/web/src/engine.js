// Port of the XNA demo framework: DemoEffect, Timeline and the render helpers the effects share.
import * as THREE from 'three';

export const WIDTH = 1280;
export const HEIGHT = 720;
const ASSETS = '../assets/';

export function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

const FULLSCREEN_VS = /* glsl */ `
  uniform vec4 uRect; // x0, y0, x1, y1 in NDC
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(mix(uRect.xy, uRect.zw, uv), 0.0, 1.0);
  }`;

const SPRITE_FS = /* glsl */ `
  uniform sampler2D map;
  uniform vec4 uColor;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D(map, vUv) * uColor; }`;

/** Shared GPU state: the 1280x720 "back buffer", a resolve copy of it, and quad helpers. */
export class Context {
  constructor(canvas) {
    THREE.ColorManagement.enabled = false;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setSize(WIDTH, HEIGHT, false);
    this.renderer.autoClear = false;
    this.backBuffer = this.createTarget(WIDTH, HEIGHT, true);
    this.resolveTarget = this.createTarget(WIDTH, HEIGHT, false);
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.Camera();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.spriteMaterials = {
      alpha: this.createSpriteMaterial(THREE.NormalBlending),
      additive: this.createSpriteMaterial(THREE.AdditiveBlending),
      opaque: this.createSpriteMaterial(THREE.NoBlending),
    };
    this.textureLoader = new THREE.TextureLoader();
    this.textures = new Map();
  }

  createTarget(width, height, depthBuffer) {
    return new THREE.WebGLRenderTarget(width, height, {
      depthBuffer,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
  }

  createSpriteMaterial(blending) {
    return this.createQuadMaterial(SPRITE_FS, { map: { value: null }, uColor: { value: new THREE.Vector4(1, 1, 1, 1) } }, blending);
  }

  /** Material for a screen-space quad; the fragment shader receives `vUv`. */
  createQuadMaterial(fragmentShader, uniforms, blending = THREE.NoBlending) {
    return new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VS,
      fragmentShader,
      uniforms: { uRect: { value: new THREE.Vector4(-1, -1, 1, 1) }, ...uniforms },
      blending,
      transparent: blending !== THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });
  }

  async loadTexture(name, { repeat = false } = {}) {
    if (!name) {
      return null;
    }
    if (!this.textures.has(name)) {
      this.textures.set(name, this.textureLoader.loadAsync(`${ASSETS}textures/${name}.png`).then((tex) => {
        tex.colorSpace = THREE.NoColorSpace;
        if (repeat) {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        }
        return tex;
      }));
    }
    return this.textures.get(name);
  }

  /** Draw `material` as a quad covering pixel rect (top-left origin, like SpriteBatch) of `target`. */
  drawQuad(material, target = this.backBuffer, rect = null) {
    const w = target ? target.width : WIDTH;
    const h = target ? target.height : HEIGHT;
    const r = rect ?? { x: 0, y: 0, w, h };
    material.uniforms.uRect.value.set(
      (r.x / w) * 2 - 1, 1 - ((r.y + r.h) / h) * 2,
      ((r.x + r.w) / w) * 2 - 1, 1 - (r.y / h) * 2,
    );
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /** SpriteBatch.Draw equivalent. `color` is [r, g, b, a]. */
  drawSprite(texture, rect, color = [1, 1, 1, 1], blend = 'alpha', target = this.backBuffer) {
    const mat = this.spriteMaterials[blend];
    mat.uniforms.map.value = texture;
    mat.uniforms.uColor.value.set(...color);
    this.drawQuad(mat, target, rect);
  }

  /** GraphicsDevice.ResolveBackBuffer: snapshot the back buffer into a texture. */
  resolveBackBuffer() {
    this.drawSprite(this.backBuffer.texture, null, [1, 1, 1, 1], 'opaque', this.resolveTarget);
    return this.resolveTarget.texture;
  }

  renderScene(scene, camera) {
    this.renderer.setRenderTarget(this.backBuffer);
    this.renderer.render(scene, camera);
  }

  beginFrame() {
    this.renderer.setRenderTarget(this.backBuffer);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, true, true);
  }

  present() {
    this.drawSprite(this.backBuffer.texture, null, [1, 1, 1, 1], 'opaque', null);
  }
}

/** Base class mirroring Demo.DemoEffect. */
export class DemoEffect {
  constructor(ctx) {
    this.ctx = ctx;
    this.isActive = false;
    this.startTime = 0;
    this.speed = 0;
  }

  async load() {}

  reset() {
    this.isActive = false;
  }

  init(time) {
    this.startTime = time;
  }

  render(_time) {}

  handleEvent(ev) {
    switch (ev.type) {
      case 'Begin':
        this.isActive = true;
        break;
      case 'End':
        this.isActive = false;
        break;
      case 'Init':
        this.init(ev.time);
        break;
      case 'InitAndBegin':
        this.init(ev.time);
        this.isActive = true;
        break;
      case 'Speed':
        this.speed = ev.p[0];
        break;
    }
  }
}

/** Placeholder for scenes not ported yet: swallows its events, draws nothing. */
export class PendingEffect extends DemoEffect {}

/** Port of Demo.Timeline: fires events in time order, then renders every effect in registration order. */
export class Timeline {
  constructor(effects, events) {
    this.effects = effects; // Map preserves insertion order, like the C# Dictionary did
    this.events = [...events].sort((a, b) => a.time - b.time);
    this.currentEvent = 0;
    this.lastTime = 0;
    this.finished = false;
  }

  async load() {
    await Promise.all([...this.effects.values()].map((e) => e.load()));
  }

  reset() {
    for (const effect of this.effects.values()) {
      effect.reset();
    }
    this.currentEvent = 0;
    this.finished = false;
  }

  updateEvents(time) {
    if (time < this.lastTime) {
      this.reset();
    }
    this.lastTime = time;
    while (this.currentEvent < this.events.length && time >= this.events[this.currentEvent].time) {
      const ev = this.events[this.currentEvent++];
      if (ev.type === 'StopDemo') {
        this.finished = true;
        return;
      }
      const effect = this.effects.get(ev.eff);
      if (!effect) {
        throw new Error(`could not find effect "${ev.eff}" from event`);
      }
      effect.handleEvent(ev);
    }
  }

  render(time) {
    this.updateEvents(time);
    for (const effect of this.effects.values()) {
      if (effect.isActive) {
        effect.render(time);
      }
    }
  }
}
