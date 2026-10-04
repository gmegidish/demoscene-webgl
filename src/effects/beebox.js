// Port of Demo.BeeEffect: a skybox, a 150x150 field of random-height bump-mapped reflective cubes
// (some of which fade on/off in orange), and a swarm of 37 skinned bees flying along random splines.
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT } from '../engine.js';
import { loadModel, AnimationPlayer, xnaMul } from '../modelLoader.js';
import { DotNetRandom } from '../dotnetRandom.js';
import { getVSM, pointCamera } from './vsm.js';

const GRID_SIZE = 150;
const INNER_OFFSET = 50;
const INNER_SIZE = 50;
const LIGHT_CUBE_INV_PROB = 5;
const SWITCH_ON_TIME = 4000;
const SWITCH_OFF_TIME = 1000;
const BEE_COUNT = 37;
const BEE_PATH_POINTS = 32;
const BEE_SPEED = 7e-5; // path fraction per ms
const BEE_SCALE = 0.3;
const VERTS_PER_CELL = 12;

const SKYBOX_FS = /* glsl */ `
  uniform samplerCube skybox_Tex;
  uniform mat4 matProjectionInverse;
  uniform mat4 matViewInverse;
  varying vec2 vUv;
  void main() {
    vec4 view = matProjectionInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = mat3(matViewInverse) * (view.xyz / view.w);
    gl_FragColor = textureCube(skybox_Tex, dir);
  }`;

// Cubes.xnb is the RenderMonkey "Spline" template plus bump_Tex and reflection_Tex.
// Defaults from the effect: fSpecular (1, .96, .72), fSpecularPower 256, fLightPosition (-785, 423, 453).
const CUBES_VS = /* glsl */ `
  attribute vec3 tangent;
  attribute vec3 binormal;
  attribute float luminance;
  varying vec3 vViewPos;
  varying vec3 vN;
  varying vec3 vT;
  varying vec3 vB;
  varying vec2 vUv;
  varying float vLuminance;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    vN = mat3(modelViewMatrix) * normal;
    vT = mat3(modelViewMatrix) * tangent;
    vB = mat3(modelViewMatrix) * binormal;
    vUv = vec2(uv.x, 1.0 - uv.y); // XNA UVs start at the image top; loadTexture flips Y
    vLuminance = luminance;
    gl_Position = projectionMatrix * mv;
  }`;

const CUBES_FS = /* glsl */ `
  uniform sampler2D bump_Tex;
  uniform samplerCube reflection_Tex;
  uniform vec4 fAmbient;
  uniform vec4 fDiffuse;
  uniform vec3 fSpecular;
  uniform float fSpecularPower;
  uniform vec3 fLightPosition;
  uniform bool lightCubes;
  varying vec3 vViewPos;
  varying vec3 vN;
  varying vec3 vT;
  varying vec3 vB;
  varying vec2 vUv;
  varying float vLuminance;
  void main() {
    vec3 bump = texture2D(bump_Tex, vUv).xyz * 2.0 - 1.0;
    vec3 n = normalize(normalize(vT) * bump.x + normalize(vB) * bump.y + normalize(vN) * bump.z);
    vec3 l = normalize(fLightPosition - vViewPos);
    vec3 v = normalize(-vViewPos);
    float diffuse = max(dot(n, l), 0.0);
    float spec = pow(max(dot(reflect(-l, n), v), 0.0), fSpecularPower);
    vec3 r = transpose(mat3(viewMatrix)) * reflect(-v, n);
    vec3 env = textureCube(reflection_Tex, r).rgb;
    // ponytail: reflection weight guessed; shader body is not recoverable
    vec3 ambient = lightCubes ? vec3(0.9, 0.5, 0.0) * vLuminance : fAmbient.rgb;
    vec3 color = ambient + fDiffuse.rgb * diffuse + env * 0.35 + fSpecular * spec;
    gl_FragColor = vec4(color, 1.0);
  }`;

/** .NET Random.Next(min, max). */
function nextRange(random, min, max) {
  return Math.floor(random.nextDouble() * (max - min)) + min;
}

/** Writable struct-of-arrays for VertexPositionTBNTexture. */
class TbnVertices {
  constructor(count) {
    this.position = new Float32Array(count * 3);
    this.normal = new Float32Array(count * 3);
    this.tangent = new Float32Array(count * 3);
    this.binormal = new Float32Array(count * 3);
    this.uv = new Float32Array(count * 2);
  }

  set(i, pos, uv) {
    this.position.set(pos, i * 3);
    this.uv.set(uv, i * 2);
  }

  setFrame(i, normal, tangent, binormal) {
    this.normal.set(normal, i * 3);
    this.tangent.set(tangent, i * 3);
    this.binormal.set(binormal, i * 3);
  }

  copy(dst, dstIndex, srcIndex) {
    for (const key of ['position', 'normal', 'tangent', 'binormal']) {
      dst[key].set(this[key].subarray(srcIndex * 3, srcIndex * 3 + 3), dstIndex * 3);
    }
    dst.uv.set(this.uv.subarray(srcIndex * 2, srcIndex * 2 + 2), dstIndex * 2);
  }

  geometry(indices, vertexCount) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.position.subarray(0, vertexCount * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.normal.subarray(0, vertexCount * 3), 3));
    g.setAttribute('tangent', new THREE.BufferAttribute(this.tangent.subarray(0, vertexCount * 3), 3));
    g.setAttribute('binormal', new THREE.BufferAttribute(this.binormal.subarray(0, vertexCount * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.subarray(0, vertexCount * 2), 2));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    return g;
  }
}

const UP = [0, 1, 0];
const X = [1, 0, 0];
const NEG_X = [-1, 0, 0];
const Z = [0, 0, 1];
const NEG_Z = [0, 0, -1];
const NEG_Y = [0, -1, 0];

/** Port of the cube-field construction in BeeEffect.loadContent: top, +X side and +Z side per cell. */
function buildCubeField(heights) {
  const verts = new TbnVertices(GRID_SIZE * GRID_SIZE * VERTS_PER_CELL);
  const indices = [];
  let n = 0;
  const quad = (base) => indices.push(base, base + 1, base + 2, base + 2, base + 3, base);
  for (let j = 0; j < GRID_SIZE; j++) {
    const z = j - 75;
    for (let i = 0; i < GRID_SIZE; i++) {
      const x = i - 75;
      const h = heights[i][j];
      verts.set(n, [x, h, z + 1], [0, 1]);
      verts.set(n + 1, [x, h, z], [0, 0]);
      verts.set(n + 2, [x + 1, h, z], [1, 0]);
      verts.set(n + 3, [x + 1, h, z + 1], [1, 1]);
      for (let k = 0; k < 4; k++) {
        verts.setFrame(n + k, UP, X, NEG_Z);
      }
      quad(n);
      n += 4;

      const hx = heights[i + 1][j];
      const dx = h - hx;
      verts.set(n, [x + 1, h, z + 1], dx > 0 ? [0, 1] : [dx, 1]);
      verts.set(n + 1, [x + 1, h, z], dx > 0 ? [0, 0] : [dx, 0]);
      verts.set(n + 2, [x + 1, hx, z], dx > 0 ? [dx, 0] : [0, 0]);
      verts.set(n + 3, [x + 1, hx, z + 1], dx > 0 ? [dx, 1] : [0, 1]);
      for (let k = 0; k < 4; k++) {
        verts.setFrame(n + k, dx > 0 ? X : NEG_X, dx > 0 ? NEG_Y : UP, NEG_Z);
      }
      quad(n);
      n += 4;

      const hz = heights[i][j + 1];
      const dz = h - hz;
      verts.set(n, [x, hz, z + 1], dz > 0 ? [0, dz] : [0, 0]);
      verts.set(n + 1, [x, h, z + 1], dz > 0 ? [0, 0] : [0, dz]);
      verts.set(n + 2, [x + 1, h, z + 1], dz > 0 ? [1, 0] : [1, dz]);
      verts.set(n + 3, [x + 1, hz, z + 1], dz > 0 ? [1, dz] : [1, 0]);
      for (let k = 0; k < 4; k++) {
        verts.setFrame(n + k, dz > 0 ? Z : NEG_Z, X, dz > 0 ? UP : NEG_Y);
      }
      quad(n);
      n += 4;
      if (j < GRID_SIZE - 1 && i < GRID_SIZE - 1) {
        indices.push(n - 1, n - 2, n - 5, n - 5, n + 8, n - 1);
      }
    }
  }
  return { verts, geometry: verts.geometry(new Uint32Array(indices), n) };
}

/**
 * The orange "light cubes": copies of a cell's top plus whichever side faces stand above a neighbour,
 * merged into one mesh with a per-vertex luminance the original passed as fAmbient per draw.
 */
function buildLightCubes(heights, field, random) {
  const cubes = [];
  const out = new TbnVertices(INNER_SIZE * INNER_SIZE * 20);
  const indices = [];
  let n = 0;
  for (let j = 0; j < INNER_SIZE; j++) {
    for (let i = 0; i < INNER_SIZE; i++) {
      if (random.next(LIGHT_CUBE_INV_PROB) !== 0) {
        continue;
      }
      const I = i + INNER_OFFSET;
      const J = j + INNER_OFFSET;
      const h = heights[I][J];
      const isOn = random.next(2) === 0;
      const cell = VERTS_PER_CELL * (I + J * GRID_SIZE);
      const faces = [cell];
      if (h > heights[I + 1][J]) {
        faces.push(cell + 4);
      }
      if (h > heights[I][J + 1]) {
        faces.push(cell + 8);
      }
      if (h > heights[I - 1][J]) {
        faces.push(cell - 8);
      }
      if (h > heights[I][J - 1]) {
        faces.push(cell - GRID_SIZE * VERTS_PER_CELL + 8);
      }
      const first = n;
      for (const face of faces) {
        for (let k = 0; k < 4; k++) {
          field.copy(out, n + k, face + k);
        }
        indices.push(n, n + 1, n + 2, n + 2, n + 3, n);
        n += 4;
      }
      cubes.push({ isOn, switchTime: -10000, first, count: n - first });
    }
  }
  const geometry = out.geometry(new Uint32Array(indices), n);
  geometry.setAttribute('luminance', new THREE.BufferAttribute(new Float32Array(n), 1));
  return { cubes, geometry };
}

/** CubeData.Switch: retimes so a fade that is in progress reverses smoothly. */
function switchCube(cube, time, on) {
  if (cube.isOn === on) {
    return;
  }
  cube.isOn = on;
  const since = time - cube.switchTime;
  if (on) {
    cube.switchTime = since < SWITCH_OFF_TIME ? time - ((SWITCH_OFF_TIME - since) * SWITCH_ON_TIME) / SWITCH_OFF_TIME : time;
  } else {
    cube.switchTime = since < SWITCH_ON_TIME ? time - ((SWITCH_ON_TIME - since) * SWITCH_OFF_TIME) / SWITCH_ON_TIME : time;
  }
}

function cubeLuminance(cube, time) {
  const since = time - cube.switchTime;
  if (cube.isOn) {
    return since > SWITCH_ON_TIME ? 1 : since / SWITCH_ON_TIME;
  }
  return since > SWITCH_OFF_TIME ? 0 : 1 - since / SWITCH_OFF_TIME;
}

/** Closed Catmull-Rom through all points (Demo.Spline.getValue). */
function splineValue(points, f) {
  const count = points.length;
  const x = f * count;
  const i = Math.floor(x);
  const t = x - i;
  const [p1, p2, p3, p4] = [(i + count - 1) % count, i % count, (i + 1) % count, (i + 2) % count].map((k) => points[((k % count) + count) % count]);
  const cr = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  return new THREE.Vector3(cr(p1.x, p2.x, p3.x, p4.x), cr(p1.y, p2.y, p3.y, p4.y), cr(p1.z, p2.z, p3.z, p4.z));
}

/** Seed 1338: the same 37 flight paths and start offsets as the original. */
function buildBeePaths() {
  const random = new DotNetRandom(1338);
  const paths = [];
  const positions = [];
  for (let i = 0; i < BEE_COUNT; i++) {
    const points = [];
    let p = new THREE.Vector3(-90 + i * 9, 26, -335);
    while (points.length < BEE_PATH_POINTS) {
      const dx = nextRange(random, -5, 5);
      const dy = nextRange(random, -1, 3);
      const dz = nextRange(random, 14, 20);
      p = p.clone().add(new THREE.Vector3(dx, dy, dz));
      points.push(p);
    }
    positions.push(random.next(100) / 100);
    paths.push(points);
  }
  return { paths, positions };
}

/** getBeeMatrix: orient along the flight direction, Y kept up. */
function beeMatrix(pos, target) {
  const dir = target.clone().sub(pos).normalize();
  const up = new THREE.Vector3(0, 1, 0).sub(dir.clone().multiplyScalar(dir.y)).normalize();
  const side = new THREE.Vector3().crossVectors(dir, up);
  return new THREE.Matrix4().fromArray([
    -side.x, -side.y, -side.z, 0,
    up.x, up.y, up.z, 0,
    dir.x, dir.y, dir.z, 0,
    pos.x, pos.y, pos.z, 1,
  ]);
}

function randomHeights() {
  // The original uses an unseeded Random here, so every run differs; Math.random is equivalent.
  const heights = Array.from({ length: GRID_SIZE + 1 }, () => new Float32Array(GRID_SIZE + 1));
  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
      heights[i][j] = 0.3 / (Math.random() + 0.1);
    }
  }
  return heights;
}

class MathRandom {
  next(max) {
    return Math.floor(Math.random() * max);
  }
}

class BeeEffect extends DemoEffect {
  async load() {
    const ctx = this.ctx;
    this.vsm = getVSM(ctx);
    this.random = new MathRandom();
    const loader = new THREE.CubeTextureLoader().setPath('assets/textures/textures/');
    const [bump, skybox, bee] = await Promise.all([
      ctx.loadTexture('textures/CubeNormals', { repeat: true }),
      loader.loadAsync(['skybox_px.png', 'skybox_nx.png', 'skybox_py.png', 'skybox_ny.png', 'skybox_pz.png', 'skybox_nz.png']),
      loadModel('bee_anim'),
      this.vsm.load(),
    ]);
    skybox.colorSpace = THREE.NoColorSpace;

    this.skyboxMaterial = ctx.createQuadMaterial(SKYBOX_FS, {
      skybox_Tex: { value: skybox },
      matProjectionInverse: { value: new THREE.Matrix4() },
      matViewInverse: { value: new THREE.Matrix4() },
    });

    const heights = randomHeights();
    const field = buildCubeField(heights);
    const light = buildLightCubes(heights, field.verts, this.random);
    this.lightCubes = light.cubes;
    this.lightGeometry = light.geometry;
    const cubeMaterial = (lightCubes) => new THREE.ShaderMaterial({
      vertexShader: CUBES_VS,
      fragmentShader: CUBES_FS,
      side: THREE.BackSide,
      uniforms: {
        bump_Tex: { value: bump },
        reflection_Tex: { value: skybox },
        fAmbient: { value: new THREE.Vector4(0, 0, 0, 1) },
        fDiffuse: { value: new THREE.Vector4(0.1, 0.1, 0.3, 1) },
        fSpecular: { value: new THREE.Vector3(1, 0.96, 0.72) },
        fSpecularPower: { value: 256 },
        fLightPosition: { value: new THREE.Vector3(-785, 423, 453) },
        lightCubes: { value: lightCubes },
      },
    });
    field.geometry.setAttribute('luminance', new THREE.BufferAttribute(new Float32Array(field.geometry.attributes.position.count), 1));
    this.scene = new THREE.Scene();
    const fieldMesh = new THREE.Mesh(field.geometry, cubeMaterial(false));
    // Same vertices drawn again with LessEqual depth, so the orange tint lands exactly on the base cubes.
    const lightMesh = new THREE.Mesh(this.lightGeometry, cubeMaterial(true));
    fieldMesh.frustumCulled = lightMesh.frustumCulled = false;
    lightMesh.renderOrder = 1;
    this.scene.add(fieldMesh, lightMesh);

    this.player = new AnimationPlayer(bee.skinning);
    this.player.startClip(bee.skinning.clips['Take 001']);
    const bones = { value: this.player.skinArray };
    // skin_noshadows samples tex_tdiffuse, which BeginNormal points at the (empty) blurred shadow map,
    // so the bees render as dark silhouettes; kept for fidelity.
    const beeMaterial = this.vsm.createMaterial('skin_noshadows', {
      skinned: true, maxBones: bee.skinning.bindPose.length, bones,
    });
    const beeParts = bee.meshes.flatMap((mesh) => mesh.parts);
    const { paths, positions } = buildBeePaths();
    this.beePaths = paths;
    this.beePositions = positions;
    this.bees = paths.map(() => {
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      for (const part of beeParts) {
        const mesh = new THREE.Mesh(part.geometry, beeMaterial);
        mesh.frustumCulled = false;
        group.add(mesh);
      }
      group.renderOrder = 2;
      this.scene.add(group);
      return group;
    });

    this.camera = new THREE.PerspectiveCamera(90, WIDTH / HEIGHT, 0.1, 1000);
    this.reset();
  }

  reset() {
    super.reset();
    for (const cube of this.lightCubes ?? []) {
      cube.isOn = this.random.next(2) === 0;
      cube.switchTime = -10000;
    }
  }

  init(time) {
    super.init(time);
    this.lastTime = time;
  }

  updateLightCubes(time) {
    const cube = this.lightCubes[this.random.next(this.lightCubes.length)];
    switchCube(cube, time, this.random.next(2) === 0);
    const attr = this.lightGeometry.attributes.luminance;
    for (const c of this.lightCubes) {
      attr.array.fill(cubeLuminance(c, time), c.first, c.first + c.count);
    }
    attr.needsUpdate = true;
  }

  updateBees(dt) {
    const scale = new THREE.Matrix4().makeScale(BEE_SCALE, BEE_SCALE, BEE_SCALE);
    this.bees.forEach((group, k) => {
      this.beePositions[k] += dt * BEE_SPEED;
      const f = this.beePositions[k];
      const visible = f < (BEE_PATH_POINTS - 1) / BEE_PATH_POINTS;
      group.visible = visible;
      if (visible) {
        const pos = splineValue(this.beePaths[k], f);
        const target = splineValue(this.beePaths[k], f + 0.001);
        // XNA `beeMatrix * scale`: the scale also shrinks the path itself toward the origin.
        group.matrix.copy(xnaMul(beeMatrix(pos, target), scale));
        group.matrixWorldNeedsUpdate = true;
      }
      if (f > 1) {
        this.beePositions[k]--;
      }
    });
  }

  render(time) {
    const t = (time - this.startTime) / 1000;
    const dt = time - this.lastTime;
    this.lastTime = time;
    pointCamera(this.camera, new THREE.Vector3(Math.sin(t / 4) * 8, 4, 16), new THREE.Vector3(0, 3, 0));

    this.vsm.renderDepth(null);
    const sky = this.skyboxMaterial.uniforms;
    sky.matProjectionInverse.value.copy(this.camera.projectionMatrixInverse);
    sky.matViewInverse.value.copy(this.camera.matrixWorld);
    this.ctx.drawQuad(this.skyboxMaterial);

    this.updateLightCubes(time);
    this.player.update(dt / 1000, true, new THREE.Matrix4());
    this.updateBees(dt);
    this.vsm.setLight(new THREE.Vector3(100, 100, 100), new THREE.Vector3(), 90);
    this.vsm.setCamera(this.camera);
    this.ctx.renderer.setRenderTarget(this.ctx.backBuffer);
    this.ctx.renderer.clearDepth();
    this.ctx.renderScene(this.scene, this.camera);
  }
}

export default (ctx) => new BeeEffect(ctx);
