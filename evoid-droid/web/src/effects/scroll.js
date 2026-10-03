// Port of Demo.ScrollerEffect: six-layer parallax night scroller with the skinned robot walking
// between the back four and front two layers, all bouncing on ShakeStart events.
// The robot uses the stock XNA SkinnedModel sample shader (both lights are set to black here,
// so only AmbientColor (0.2, 0.2, 0.3) contributes).
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT } from '../engine.js';
import { loadModel, materialTextureName, AnimationPlayer, SKINNING_GLSL, xnaMul } from '../modelLoader.js';

const LAYERS = [
  ['background', 0.3],
  ['moon', 0.01],
  ['stars', 0.1],
  ['middle', 0.6],
  ['foreground', 0.8],
  ['foreground2', 1.3],
];
const BACK_LAYER_COUNT = 4;
const MOON = 1;
const ANIM_LOOP_MS = 1000;
const AMBIENT = [0.2, 0.2, 0.3];

const ROBOT_VS = /* glsl */ `
  ${SKINNING_GLSL}
  uniform mat4 View;
  uniform mat4 Projection;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = Projection * View * skinMatrix() * vec4(position, 1.0);
  }`;

const ROBOT_FS = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 AmbientColor;
  varying vec2 vUv;
  void main() {
    // Model UVs are top-left origin (D3D); textures are loaded flipped for GL.
    gl_FragColor = texture2D(map, vec2(vUv.x, 1.0 - vUv.y)) * vec4(AmbientColor, 1.0);
  }`;

/** XNA Matrix.CreateLookAt, as a three.js (column-vector) matrix. */
function lookAt(eye, target, up) {
  const camera = new THREE.Matrix4().lookAt(eye, target, up).setPosition(eye);
  return camera.invert();
}

export class ScrollerEffect extends DemoEffect {
  async load() {
    this.layers = await Promise.all(LAYERS.map(async ([name, speed]) => ({
      texture: await this.ctx.loadTexture(`textures/Parallax/${name}`),
      speed,
    })));
    const model = await loadModel('robotanim');
    this.player = new AnimationPlayer(model.skinning);
    this.player.startClip(model.skinning.clips['Take 001']);
    this.material = await this.createRobotMaterial(model);
    this.scene = new THREE.Scene();
    for (const mesh of model.meshes) {
      for (const part of mesh.parts) {
        const robot = new THREE.Mesh(part.geometry, this.material);
        robot.frustumCulled = false;
        this.scene.add(robot);
      }
    }
    this.camera = new THREE.Camera();
    this.reset();
  }

  async createRobotMaterial(model) {
    const material = model.meshes[0].parts[0].material;
    return new THREE.ShaderMaterial({
      vertexShader: ROBOT_VS,
      fragmentShader: ROBOT_FS,
      defines: { MAX_BONES: model.skinning.bindPose.length },
      uniforms: {
        bones: { value: this.player.skinTransforms },
        View: { value: new THREE.Matrix4() },
        Projection: { value: new THREE.Matrix4() },
        AmbientColor: { value: new THREE.Vector3(...AMBIENT) },
        map: { value: await this.ctx.loadTexture(materialTextureName('robotanim', material)) },
      },
      // Drawn right after a SpriteBatch, which leaves depth testing off and CCW culling on.
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
    });
  }

  reset() {
    super.reset();
    this.isShaking = false;
    this.shakeSpeed = 2;
    this.shakeAmplitude = 20;
  }

  init(time) {
    super.init(time);
    this.lastTime = time;
    this.animTime = 0;
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    if (ev.type === 'ShakeStart') {
      this.startShakeTime = ev.time;
      this.isShaking = true;
    }
  }

  /** Damped bounce: 5 oscillations decaying over 1/shakeSpeed seconds. */
  shakeOffset(time) {
    if (!this.isShaking) {
      return 0;
    }
    const f = Math.min(1, ((time - this.startShakeTime) / 1000) * this.shakeSpeed);
    return (0.5 + 0.5 * Math.cos(f * 5 * Math.PI * 2)) * (1 - f * f) * this.shakeAmplitude;
  }

  /** Each layer tiles horizontally; x wraps into (-tileWidth, 0]. */
  drawLayer(layer, scroll, y, copies) {
    const { image } = layer.texture;
    const scale = HEIGHT / image.height;
    const tile = image.width * scale;
    let x = -layer.speed * scroll;
    while (x <= -tile) {
      x += tile;
    }
    for (let i = 0; i < copies; i++) {
      this.ctx.drawSprite(layer.texture, { x: x + i * tile, y, w: tile, h: image.height * scale });
    }
  }

  updateRobot(time, shake) {
    // ponytail: original truncates per-frame ms to int, kept for identical pacing
    this.animTime += Math.trunc((time - this.lastTime) * 0.5);
    if (this.animTime > ANIM_LOOP_MS) {
      this.animTime -= ANIM_LOOP_MS;
    }
    this.lastTime = time;
    this.player.update(this.animTime / 1000, false, new THREE.Matrix4());
    const view = lookAt(new THREE.Vector3(-90, 0, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    const tilt = new THREE.Matrix4().makeRotationX(-0.42 - shake * 0.001);
    this.material.uniforms.View.value.copy(xnaMul(view, tilt));
    this.material.uniforms.Projection.value.copy(
      new THREE.PerspectiveCamera(90, WIDTH / HEIGHT, 0.1, 1000).projectionMatrix,
    );
  }

  render(time) {
    const scroll = (time - this.startTime) / 10;
    const shake = this.shakeOffset(time);
    this.layers.slice(0, BACK_LAYER_COUNT).forEach((layer, i) => {
      this.drawLayer(layer, scroll, i === 0 ? 0 : shake * layer.speed, i === MOON ? 1 : 3);
    });
    this.updateRobot(time, shake);
    this.ctx.renderScene(this.scene, this.camera);
    for (const layer of this.layers.slice(BACK_LAYER_COUNT)) {
      this.drawLayer(layer, scroll, shake * layer.speed, 3);
    }
  }
}

export default (ctx) => new ScrollerEffect(ctx);
