// Port of Demo.LiquidBoidScene ("metal", 3:53.9–4:12.2): a 300-boid flock rendered as overlapping
// spheres into a depth/normal G-buffer, blurred into a liquid-metal blob that reflects the skybox,
// flowing around the 3D "EXP" letters over a bump-mapped mirror floor.
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT } from '../engine.js';
import { loadModel, materialTextureName, xnaMul } from '../modelLoader.js';
import { BoidFlock, BOID_COUNT } from './metal/boids.js';
import {
  DEFER_VS, RENDER_POSITION_FS, RENDER_NORMAL_FS, BLUR_FS, ENV_LIGHTS_FS,
  FLOOR_VS, FLOOR_FS, BASIC_VS, BASIC_FS,
} from './metal/shaders.js';

// updateBoids() ran once per rendered frame, and this scene (O(n^2) flock, 2x300 sphere passes,
// 5 blurs) ran at ~30 fps on the Xbox. At 60 steps/s the flock outruns the attractor's 5.4-unit
// orbit and leaves the letters; at 30 it sloshes through E-x-P as in the original video.
const SIM_HZ = 30;
const SPHERE_RADIUS = 0.24;
const SPHERE_SLICES = 8;
const SPHERE_SECTORS = 16;
const NORMAL_BLUR_PASSES = 4;
const FLOOR_SCALE = 150;
const FLOOR_TILING = 200;
const CUBE_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

/** The 153-vertex sphere from loadContent (9 rings x 17 meridians, seam duplicated). */
function buildSphereGeometry() {
  const ring = SPHERE_SLICES + 1;
  const position = new Float32Array(ring * (SPHERE_SECTORS + 1) * 3);
  for (let j = 0; j <= SPHERE_SECTORS; j++) {
    const a = (Math.PI * 2 * (j % SPHERE_SECTORS)) / SPHERE_SECTORS;
    for (let i = 0; i <= SPHERE_SLICES; i++) {
      const r = Math.sin((Math.PI * i) / SPHERE_SLICES);
      const y = -Math.cos((Math.PI * i) / SPHERE_SLICES);
      position.set([r * Math.cos(a), y, -r * Math.sin(a)], (i + ring * j) * 3);
    }
  }
  const indices = [];
  for (let j = 0; j < SPHERE_SECTORS; j++) {
    for (let i = 0; i < SPHERE_SLICES; i++) {
      const a = i + j * ring;
      const b = i + 1 + j * ring;
      const c = i + 1 + (j + 1) * ring;
      const d = i + (j + 1) * ring;
      indices.push(a, b, c, c, d, a);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(position.slice(), 3));
  geometry.setIndex(indices);
  return geometry;
}

/** drawQuad(): unit quad in XY with a tangent frame, UVs tiled. */
function buildFloorGeometry() {
  const corners = [[-1, -1], [-1, 1], [1, 1], [1, -1]];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap(([x, y]) => [x, y, 0]), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(corners.flatMap(([x, y]) => [(0.5 + 0.5 * x) * FLOOR_TILING, (0.5 - 0.5 * y) * FLOOR_TILING]), 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(corners.flatMap(() => [0, 0, 1]), 3));
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(corners.flatMap(() => [1, 0, 0]), 3));
  geometry.setAttribute('binormal', new THREE.Float32BufferAttribute(corners.flatMap(() => [0, -1, 0]), 3));
  geometry.setIndex([0, 1, 2, 2, 3, 0]);
  return geometry;
}

function loadCubeTexture(name) {
  const loader = new THREE.CubeTextureLoader();
  return loader.loadAsync(CUBE_FACES.map((f) => `assets/textures/textures/${name}_${f}.png`)).then((tex) => {
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  });
}

function floatTarget(width, height) {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });
}

class LiquidBoidScene extends DemoEffect {
  async load() {
    const ctx = this.ctx;
    const [model, bump, skybox] = await Promise.all([
      loadModel('exp'),
      ctx.loadTexture('textures/CubeNormals', { repeat: true }),
      loadCubeTexture('skybox'),
    ]);
    this.flock = new BoidFlock();
    this.camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(1), WIDTH / HEIGHT, 0.1, 100);

    this.rtDepth = floatTarget(WIDTH, HEIGHT);
    this.rtBlurredDepth = floatTarget(WIDTH, HEIGHT);
    this.rtNormal = floatTarget(WIDTH / 2, HEIGHT / 2);
    this.rtBlurred = floatTarget(WIDTH / 2, HEIGHT / 2);

    this.spheres = this.createSpheres();
    this.gbufferScene = new THREE.Scene().add(this.spheres);
    this.positionMaterial = this.deferMaterial(RENDER_POSITION_FS);
    this.normalMaterial = this.deferMaterial(RENDER_NORMAL_FS);

    this.blurMaterial = ctx.createQuadMaterial(BLUR_FS, {
      base_Tex: { value: null },
      depth_Tex: { value: null },
      fViewportDimensions: { value: new THREE.Vector2(WIDTH, HEIGHT) },
      fBlurriness: { value: 1 },
      fMaxDepthDiff: { value: 0.03 },
      uDirection: { value: new THREE.Vector2(1, 0) },
      uSameDepth: { value: true },
    });
    this.lightingMaterial = ctx.createQuadMaterial(ENV_LIGHTS_FS, {
      normal_Tex: { value: this.rtNormal.texture },
      position_Tex: { value: this.rtDepth.texture },
      env_Tex: { value: skybox },
      matViewInverse: { value: new THREE.Matrix4() },
      uProjectionInverse: { value: new THREE.Matrix4() },
      fColour: { value: new THREE.Vector3(1, 1, 1) },
    });

    this.mainScene = new THREE.Scene();
    this.mainScene.add(this.createFloor(bump, skybox));
    this.letters = await this.createLetters(model);
    this.lettersScene = new THREE.Scene().add(this.letters);
    this.reset();
  }

  createSpheres() {
    const mesh = new THREE.InstancedMesh(buildSphereGeometry(), null, BOID_COUNT);
    mesh.frustumCulled = false;
    return mesh;
  }

  deferMaterial(fragmentShader) {
    // XNA CullCounterClockwiseFace keeps the opposite winding to GL's default.
    return new THREE.ShaderMaterial({ vertexShader: DEFER_VS, fragmentShader, side: THREE.BackSide });
  }

  createFloor(bump, skybox) {
    const material = new THREE.ShaderMaterial({
      vertexShader: FLOOR_VS,
      fragmentShader: FLOOR_FS,
      side: THREE.DoubleSide,
      uniforms: {
        bump_Tex: { value: bump },
        reflection_Tex: { value: skybox },
        fColour: { value: new THREE.Vector4(0, 0, 0, 1) },
        // Defaults from Cubes.xnb (each value record precedes its parameter name).
        fAmbient: { value: new THREE.Vector4(0, 0, 0, 0) },
        fDiffuse: { value: new THREE.Vector4(1, 1, 1, 1) },
        fSpecular: { value: new THREE.Vector4(1, 0.96, 0.72, 1) },
        fSpecularPower: { value: 256 },
        fLightPosition: { value: new THREE.Vector3(-785, 423, 453) },
      },
    });
    const floor = new THREE.Mesh(buildFloorGeometry(), material);
    floor.matrixAutoUpdate = false;
    // Scale(150) * RotationX(-pi/2) * Translation(0, -0.5, 0)
    floor.matrix = xnaMul(xnaMul(new THREE.Matrix4().makeScale(FLOOR_SCALE, FLOOR_SCALE, FLOOR_SCALE),
      new THREE.Matrix4().makeRotationX(-Math.PI / 2)), new THREE.Matrix4().makeTranslation(0, -0.5, 0));
    floor.frustumCulled = false;
    return floor;
  }

  async createLetters(model) {
    const group = new THREE.Group();
    const bones = model.absoluteBoneTransforms();
    // bones * Scale(1.65) * RotationY(-pi/2) * RotationX(-pi/2) * Translation(0.02, 0, 0)
    const placement = [
      new THREE.Matrix4().makeScale(1.65, 1.65, 1.65),
      new THREE.Matrix4().makeRotationY(-Math.PI / 2),
      new THREE.Matrix4().makeRotationX(-Math.PI / 2),
      new THREE.Matrix4().makeTranslation(0.02, 0, 0),
    ];
    for (const mesh of model.meshes) {
      const world = placement.reduce((m, next) => xnaMul(m, next), bones[mesh.parentBone].clone());
      for (const part of mesh.parts) {
        const textureName = materialTextureName('exp', part.material);
        const map = textureName ? await this.ctx.loadTexture(textureName) : null;
        const material = new THREE.ShaderMaterial({
          vertexShader: BASIC_VS,
          fragmentShader: BASIC_FS,
          side: THREE.BackSide,
          uniforms: {
            map: { value: map },
            hasMap: { value: Boolean(map) },
            diffuseColor: { value: new THREE.Vector3(...part.material.diffuse) },
            specularColor: { value: new THREE.Vector3(...part.material.specular) },
            specularPower: { value: part.material.specularPower },
          },
        });
        const object = new THREE.Mesh(part.geometry, material);
        object.matrixAutoUpdate = false;
        object.matrix.copy(world);
        object.frustumCulled = false;
        group.add(object);
      }
    }
    return group;
  }

  reset() {
    super.reset();
    this.scatterAt = Infinity;
  }

  init(time) {
    super.init(time);
    // Boids only move while the scene is active, so restarting from reset() state at init is equivalent.
    this.flock.reset();
    this.stepsDone = 0;
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    if (ev.type === 'BoidsBehaviour') {
      this.scatterAt = ev.p[0] === 1 ? ev.time : Infinity;
    }
  }

  /** The wandering attractor the flock follows (targetPos in render()). */
  static targetAt(seconds) {
    const t = seconds * 0.4;
    return [Math.sin(t + 0.1) * 1.8 * 3, Math.cos(t * 1.5 + 0.3) * 1.8 * 3];
  }

  /** Advance the flock one fixed step per 1/60 s of scene time (catches up after a seek). */
  simulate(elapsedMs) {
    const target = Math.floor((elapsedMs / 1000) * SIM_HZ);
    while (this.stepsDone < target) {
      this.stepsDone++;
      const stepMs = (this.stepsDone * 1000) / SIM_HZ;
      const [tx, ty] = LiquidBoidScene.targetAt(stepMs / 1000);
      this.flock.step(tx, ty, this.startTime + stepMs >= this.scatterAt);
    }
  }

  updateCamera(seconds) {
    const t = seconds * 0.4;
    const radius = Math.sin(2 * t) * 3 + 3;
    const angle = Math.sin(-t);
    this.camera.position.set(Math.sin(angle) * radius, 7 + Math.sin(t) * 0.5, Math.cos(angle) * radius);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
  }

  /** Boid (x, y) lives in the plane rotated by RotationX(pi/2): world (x, 0, y). */
  updateSphereInstances() {
    const m = new THREE.Matrix4();
    const { px, py } = this.flock;
    for (let i = 0; i < BOID_COUNT; i++) {
      m.makeScale(SPHERE_RADIUS, SPHERE_RADIUS, SPHERE_RADIUS).setPosition(px[i], 0, py[i]);
      this.spheres.setMatrixAt(i, m);
    }
    this.spheres.instanceMatrix.needsUpdate = true;
  }

  renderGBuffer(target, material, clear) {
    const renderer = this.ctx.renderer;
    this.spheres.material = material;
    renderer.setRenderTarget(target);
    renderer.setClearColor(clear, clear === 0 ? 0 : 1);
    renderer.clear(true, true, true);
    renderer.render(this.gbufferScene, this.camera);
  }

  blurPass(source, target, direction, sameDepth) {
    const u = this.blurMaterial.uniforms;
    u.base_Tex.value = source.texture;
    // Plain blurs ignore depth_Tex; bind the source so rtDepth is never sampled while it is the target.
    u.depth_Tex.value = sameDepth ? this.rtDepth.texture : source.texture;
    u.uDirection.value.set(...direction);
    u.uSameDepth.value = sameDepth;
    // ponytail: original passed full-res dimensions even for the half-res normal buffer; stepping one
    // source texel instead gives the merged liquid look. Revisit if the real Blur.fx tap layout is recovered.
    u.fViewportDimensions.value.set(source.width, source.height);
    this.ctx.drawQuad(this.blurMaterial, target);
  }

  render(time) {
    const elapsed = time - this.startTime;
    this.simulate(elapsed);
    this.updateCamera(elapsed / 1000);
    this.updateSphereInstances();

    this.renderGBuffer(this.rtDepth, this.positionMaterial, 0x000000);
    this.renderGBuffer(this.rtNormal, this.normalMaterial, 0x808080);
    for (let i = 0; i < NORMAL_BLUR_PASSES; i++) {
      this.blurPass(this.rtNormal, this.rtBlurred, [1, 0], true);
      this.blurPass(this.rtBlurred, this.rtNormal, [0, 1], true);
    }
    this.blurPass(this.rtDepth, this.rtBlurredDepth, [1, 0], false);
    this.blurPass(this.rtBlurredDepth, this.rtDepth, [0, 1], false);

    const renderer = this.ctx.renderer;
    renderer.setRenderTarget(this.ctx.backBuffer);
    renderer.setClearColor(0x6495ed, 1); // Color.CornflowerBlue
    renderer.clear(true, true, true);
    this.ctx.renderScene(this.mainScene, this.camera);
    // The original drew the letters last, but the blob quad had already written depth 0.5
    // (in front of everything), so blobs always cover the letters: draw letters first.
    this.ctx.renderScene(this.lettersScene, this.camera);

    const u = this.lightingMaterial.uniforms;
    u.matViewInverse.value.copy(this.camera.matrixWorld);
    u.uProjectionInverse.value.copy(this.camera.projectionMatrixInverse);
    this.ctx.drawQuad(this.lightingMaterial);
  }
}

export default (ctx) => new LiquidBoidScene(ctx);
