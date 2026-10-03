// Port of Demo.LiquidEffect (4:12–4:48): 400 SPH particles sloshing in a glass ball held by the
// animated robot. Liquid = particle spheres rendered to depth/normal buffers, depth-aware blurred
// into one surface, then lit; the glass reflects/refracts a cube map rendered from its centre.
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT } from '../engine.js';
import { loadModel, materialTextureName, AnimationPlayer } from '../modelLoader.js';
import { DotNetRandom } from '../dotnetRandom.js';
import { ParticlePhysics } from './liquid/sph.js';
import { DEFER_POSITION, DEFER_NORMAL, BLUR_FS, LIGHTING_FS, GLASS, BASIC_DEFAULT_LIT, SKINNED_MODEL } from './liquid/shaders.js';

const PARTICLE_COUNT = 400;
const PARTICLE_RADIUS = 0.1;
const TIME_STEP = 0.01;
const GLASS_RADIUS = 1.5;
const GRAVITY = 25;
const PUSH_DURATION = 2000;
const WARMUP_STEPS = 90;
const NORMAL_BLUR_PASSES = 4;
// ponytail: the original steps physics and animation once per rendered frame. We assume the Xbox
// ran this heavy scene at 30 fps and step at that fixed rate so speed doesn't depend on the display.
const ORIGINAL_FRAME_MS = 1000 / 30;
const MAX_STEPS_PER_FRAME = 4;
const ENVIRONMENT_RENDERS_PER_FRAME = 7; // 6 cube faces + main view, each advancing the animation
const ANIMATION_RATE = 0.05;

/** Sphere mesh exactly as LiquidEffect builds it (slices x sectors, seam duplicated). */
function buildSphereGeometry(slices, sectors) {
  const ring = slices + 1;
  const position = [], normal = [], uv = [];
  for (let j = 0; j <= sectors; j++) {
    const phi = (Math.PI * 2 * (j % sectors)) / sectors;
    for (let i = 0; i <= slices; i++) {
      const theta = (Math.PI * i) / slices;
      const p = [Math.sin(theta) * Math.cos(phi), -Math.cos(theta), Math.sin(theta) * -Math.sin(phi)];
      position.push(...p);
      normal.push(...p);
      uv.push(j / sectors, 1 - i / slices);
    }
  }
  const index = [];
  for (let j = 0; j < sectors; j++) {
    for (let i = 0; i < slices; i++) {
      const a = i + j * ring, b = i + 1 + j * ring, c = i + 1 + (j + 1) * ring, d = i + (j + 1) * ring;
      index.push(a, b, c, c, d, a);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

function floatTarget(width, height) {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
}

/** Camera driven by explicit XNA-style view/projection matrices. */
function matrixCamera() {
  const camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = false;
  return camera;
}

function setCamera(camera, view, projection) {
  camera.matrix.copy(view).invert();
  camera.matrixWorldNeedsUpdate = true;
  camera.updateMatrixWorld(true);
  camera.projectionMatrix.copy(projection);
  camera.projectionMatrixInverse.copy(projection).invert();
}

/** Seeds the particles on a grid one layer high and lets them settle, as loadContent does. */
function createPhysics() {
  const physics = new ParticlePhysics(PARTICLE_RADIUS, PARTICLE_COUNT);
  physics.spheres.push([0, 0, 0, -GLASS_RADIUS]);
  const random = new DotNetRandom(Date.now() & 0x7fffffff); // original uses an unseeded Random
  let x = -0.95, y = -0.95, z = -0.95;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    physics.position.set([x, y, z], i * 3);
    physics.mass[i] = 0.01 * (random.nextDouble() * 0.1 + 1);
    physics.particleRadius[i] = PARTICLE_RADIUS * (random.nextDouble() * 0.2 + 0.8);
    x = Math.fround(x + 0.1);
    if (x >= 1) {
      x = -0.95;
      z = Math.fround(z + 0.1);
      if (z >= 1) {
        z = -0.95;
        y = Math.fround(y + 0.1);
      }
    }
  }
  for (let step = 0; step < WARMUP_STEPS; step++) {
    physics.applyVelocity(TIME_STEP);
    physics.applySPH(TIME_STEP);
    physics.applyCollisions();
    physics.addVelocity(0, -GRAVITY * TIME_STEP, 0);
  }
  return physics;
}

class LiquidEffect extends DemoEffect {
  async load() {
    const ctx = this.ctx;
    const [model, backdrop] = await Promise.all([loadModel('magicball_anim'), ctx.loadTexture('textures/fullscreen2')]);
    this.physics = createPhysics();
    this.player = new AnimationPlayer(model.skinning);
    this.player.startClip(model.skinning.clips['Take 001']);
    this.player.update(0, true, new THREE.Matrix4());

    this.environment = new THREE.Scene();
    this.environment.add(this.createBackdrop(backdrop), await this.createRobot(model));
    this.particles = this.createParticles();
    this.deferScene = new THREE.Scene();
    this.deferScene.add(this.particles);
    this.glass = this.createGlass();
    this.glassScene = new THREE.Scene();
    this.glassScene.add(this.glass);

    this.rtDepth = floatTarget(WIDTH, HEIGHT);
    this.rtBlurredDepth = floatTarget(WIDTH, HEIGHT);
    this.rtNormal = floatTarget(WIDTH / 2, HEIGHT / 2);
    this.rtBlurred = floatTarget(WIDTH / 2, HEIGHT / 2);
    this.cubeTarget = new THREE.WebGLCubeRenderTarget(512);
    this.cubeCamera = new THREE.CubeCamera(0.1, 100, this.cubeTarget);
    this.glass.material.uniforms.env_Tex.value = this.cubeTarget.texture;
    this.camera = matrixCamera();
    this.blurMaterial = ctx.createQuadMaterial(BLUR_FS, {
      base_Tex: { value: null },
      depth_Tex: { value: null },
      fViewportDimensions: { value: new THREE.Vector2(WIDTH, HEIGHT) },
      fBlurriness: { value: 1 },
      fMaxDepthDiff: { value: 0.03 },
      uDirection: { value: new THREE.Vector2() },
    });
    this.lightingMaterial = ctx.createQuadMaterial(LIGHTING_FS, {
      normal_Tex: { value: this.rtNormal.texture },
      position_Tex: { value: this.rtDepth.texture },
      matView: { value: new THREE.Matrix4() },
      projectionInverse: { value: new THREE.Matrix4() },
      fLightDir: { value: new THREE.Vector3(0.57735, 0.57735, 0.57735) },
      fDiffuse: { value: new THREE.Vector3(0.25, 0.25, 0.25) },
      fAmbient: { value: new THREE.Vector3(0.25, 0.25, 0.25) },
      fColour: { value: new THREE.Vector3(1, 0, 0) },
      fSpecular: { value: new THREE.Vector3(0.75, 0.75, 0.75) },
      fSpecularPower: { value: 64 },
    });
    this.reset();
  }

  createBackdrop(texture) {
    const mesh = new THREE.Mesh(buildSphereGeometry(6, 12), new THREE.ShaderMaterial({
      ...BASIC_DEFAULT_LIT,
      uniforms: { map: { value: texture } },
      side: THREE.DoubleSide,
    }));
    mesh.scale.setScalar(30);
    mesh.frustumCulled = false;
    return mesh;
  }

  async createRobot(model) {
    const group = new THREE.Group();
    for (const mesh of model.meshes) {
      for (const part of mesh.parts) {
        const texture = await this.ctx.loadTexture(materialTextureName('magicball_anim', part.material));
        const robot = new THREE.Mesh(part.geometry, new THREE.ShaderMaterial({
          ...SKINNED_MODEL,
          defines: { MAX_BONES: this.player.skinTransforms.length },
          uniforms: { map: { value: texture }, bones: { value: this.player.skinTransforms } },
          side: THREE.BackSide,
        }));
        robot.frustumCulled = false;
        group.add(robot);
      }
    }
    return group;
  }

  createParticles() {
    const mesh = new THREE.InstancedMesh(buildSphereGeometry(6, 12), new THREE.ShaderMaterial({ ...DEFER_POSITION, side: THREE.BackSide }), PARTICLE_COUNT);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    this.deferMaterials = {
      position: mesh.material,
      normal: new THREE.ShaderMaterial({ ...DEFER_NORMAL, side: THREE.BackSide }),
    };
    return mesh;
  }

  createGlass() {
    const mesh = new THREE.Mesh(buildSphereGeometry(32, 64), new THREE.ShaderMaterial({
      ...GLASS,
      uniforms: { env_Tex: { value: null }, matWorldViewInverse: { value: new THREE.Matrix4() }, matWorld: { value: new THREE.Matrix4() } },
      transparent: true,
      depthWrite: false,
    }));
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    return mesh;
  }

  reset() {
    super.reset();
    this.isAnimating = false;
    this.glassFloatingTime = 0;
    this.isShaking = false;
    this.startShakeTime = 0;
    this.shakeDuration = 1;
    this.shakeAmplitude = 0.5;
    this.shakeFrequency = 10;
  }

  init(time) {
    super.init(time);
    this.lastTime = 0;
    this.stepClock = time;
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    switch (ev.type) {
      case 'StartAnimation':
        this.isAnimating = true;
        this.startAnimTime = ev.time;
        break;
      case 'StopAnimation':
        this.isAnimating = false;
        break;
      case 'ShakeStart':
        this.isShaking = true;
        this.startShakeTime = ev.time;
        this.shakeDuration = ev.p[0];
        break;
    }
  }

  /** One original frame: SPH step, then the push (during an animation burst) or gravity. */
  stepSimulation(time) {
    const physics = this.physics;
    physics.applyVelocity(TIME_STEP);
    physics.applySPH(TIME_STEP);
    physics.applyCollisions();
    if (this.isAnimating && time - this.startAnimTime < PUSH_DURATION) {
      physics.addVelocity(GRAVITY * TIME_STEP, 0, 0);
    } else {
      physics.addVelocity(0, -GRAVITY * TIME_STEP, 0);
    }
    // Each environment render advances the clip by (int)(frameDelta * 0.05) ms.
    const perRender = this.isAnimating ? Math.floor(ORIGINAL_FRAME_MS * ANIMATION_RATE) : 0;
    this.player.update((perRender * ENVIRONMENT_RENDERS_PER_FRAME) / 1000, true, new THREE.Matrix4());
  }

  advance(time) {
    if (time < this.stepClock) {
      this.stepClock = time;
    }
    let steps = 0;
    while (this.stepClock + ORIGINAL_FRAME_MS <= time && steps < MAX_STEPS_PER_FRAME) {
      this.stepClock += ORIGINAL_FRAME_MS;
      this.stepSimulation(time);
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) {
      this.stepClock = time;
    }
  }

  /** XNA: val3 = RotY(0.1 sin(t * 0.0005)) * LookAt((0, 0.3, 4), 0, Up), plus the shake on M42. */
  viewMatrix(time, elapsed) {
    const lookAt = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0.3, 4), new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    lookAt.setPosition(0, 0.3, 4);
    const view = lookAt.invert().multiply(new THREE.Matrix4().makeRotationY(0.1 * Math.sin(elapsed * 0.0005)));
    if (this.isShaking) {
      const f = (time - this.startShakeTime) / this.shakeDuration;
      if (f > 1) {
        this.isShaking = false;
      } else {
        view.elements[13] += this.shakeAmplitude * f * f * Math.sin((time - this.startShakeTime) * this.shakeFrequency);
      }
    }
    return view;
  }

  updateParticleMatrices() {
    const m = new THREE.Matrix4();
    const p = this.physics.position;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      m.makeScale(PARTICLE_RADIUS, PARTICLE_RADIUS, PARTICLE_RADIUS).setPosition(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      this.particles.setMatrixAt(i, m);
    }
    this.particles.instanceMatrix.needsUpdate = true;
  }

  renderTo(target, scene, camera, clearColor) {
    const renderer = this.ctx.renderer;
    renderer.setRenderTarget(target);
    renderer.setClearColor(clearColor, 1);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
  }

  blurPass(source, depth, target, direction) {
    const u = this.blurMaterial.uniforms;
    u.base_Tex.value = source.texture;
    u.depth_Tex.value = depth.texture;
    u.uDirection.value.set(...direction);
    this.ctx.drawQuad(this.blurMaterial, target);
  }

  renderLiquidBuffers() {
    this.particles.material = this.deferMaterials.position;
    this.renderTo(this.rtDepth, this.deferScene, this.camera, 0x000000);
    this.particles.material = this.deferMaterials.normal;
    this.renderTo(this.rtNormal, this.deferScene, this.camera, 0x808080);
    for (let i = 0; i < NORMAL_BLUR_PASSES; i++) {
      this.blurPass(this.rtNormal, this.rtDepth, this.rtBlurred, [1, 0]);
      this.blurPass(this.rtBlurred, this.rtDepth, this.rtNormal, [0, 1]);
    }
    this.blurPass(this.rtDepth, this.rtDepth, this.rtBlurredDepth, [1, 0]);
    this.blurPass(this.rtBlurredDepth, this.rtBlurredDepth, this.rtDepth, [0, 1]);
  }

  drawGlass(side, world, view) {
    const u = this.glass.material.uniforms;
    this.glass.matrix.copy(world);
    this.glass.matrixWorldNeedsUpdate = true;
    this.glass.material.side = side;
    u.matWorld.value.copy(world);
    u.matWorldViewInverse.value.multiplyMatrices(view, world).invert();
    this.ctx.renderer.render(this.glassScene, this.camera);
  }

  render(time) {
    const ctx = this.ctx;
    const elapsed = time - this.startTime;
    this.advance(time);
    if (this.isAnimating) {
      this.glassFloatingTime += elapsed - this.lastTime;
    }
    const float = new THREE.Matrix4().makeTranslation(0, 0.05 * Math.sin(this.glassFloatingTime * 0.003), 0);
    const spin = new THREE.Matrix4().makeRotationY(elapsed * 0.0005);
    const view = this.viewMatrix(time, elapsed);
    const projection = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(1), WIDTH / HEIGHT, 0.1, 100).projectionMatrix;
    setCamera(this.camera, view, projection);

    // Liquid buffers: particles live in the spinning, floating frame of the glass.
    this.particles.matrix.multiplyMatrices(float, spin);
    this.particles.matrixWorldNeedsUpdate = true;
    this.updateParticleMatrices();
    this.renderLiquidBuffers();

    this.cubeCamera.update(ctx.renderer, this.environment);

    this.renderTo(ctx.backBuffer, this.environment, this.camera, 0x808080);
    const glassWorld = new THREE.Matrix4().multiplyMatrices(float, new THREE.Matrix4().makeScale(GLASS_RADIUS, GLASS_RADIUS, GLASS_RADIUS));
    // XNA CullClockwiseFace (inner shell) first, then the liquid, then the outer shell.
    this.drawGlass(THREE.FrontSide, glassWorld, view);
    const u = this.lightingMaterial.uniforms;
    u.matView.value.copy(view);
    u.projectionInverse.value.copy(projection).invert();
    ctx.drawQuad(this.lightingMaterial);
    ctx.renderer.setRenderTarget(ctx.backBuffer);
    this.drawGlass(THREE.BackSide, glassWorld, view);
    this.lastTime = elapsed;
  }
}

export default (ctx) => new LiquidEffect(ctx);
