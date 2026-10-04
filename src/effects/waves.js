// Port of Demo.WaveEffect: a GPU wave-equation water surface around a ring island, disturbed by a
// spinning spike ball. Per frame: simulate heights (3 ping-pong targets), stamp the cross-section of
// every object at the water plane via stencil parity ("Drop"), derive a normal map ("Bump"), render a
// mirrored reflection, then draw sky, water and objects.
// Shader parameter names and defaults come from Wave/Drop/Bump/Water/Skybox/fixedFunc.xnb; the shader
// bodies are reconstructions (originals are Xbox 360 microcode).
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT } from '../engine.js';
import { loadModel, materialTextureName } from '../modelLoader.js';

const SIM_SIZE = 1024;
const NEAR_Z = 0.01;
const FAR_Z = 100;
const FOV = 1.2; // radians, vertical
const SIM_STEP_MS = 1000 / 60;
const MAX_SIM_STEPS = 4;
const CORNFLOWER_BLUE = 0x6495ed;
const SKY_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

// --- Camera (port of Demo.Camera, without the shake that this scene never uses) -----------------

function catmullRom(p1, p2, p3, p4, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p2 + (p3 - p1) * t + (2 * p1 - 5 * p2 + 4 * p3 - p4) * t2 + (3 * p2 - p1 - 3 * p3 + p4) * t3);
}

function closedSplineValue(points, f) {
  const count = points.length;
  const x = f * count;
  const i = Math.floor(x);
  const frac = x - i;
  const [a, b, c, d] = [i + count - 1, i, i + 1, i + 2].map((k) => points[((k % count) + count) % count]);
  return new THREE.Vector3(
    catmullRom(a.x, b.x, c.x, d.x, frac),
    catmullRom(a.y, b.y, c.y, d.y, frac),
    catmullRom(a.z, b.z, c.z, d.z, frac),
  );
}

class SplineCamera {
  constructor(positions, targets, speed) {
    this.positions = positions.map((p) => new THREE.Vector3(...p));
    this.targets = targets.map((p) => new THREE.Vector3(...p));
    this.speed = speed;
    this.startTime = 0;
  }

  init(time) {
    this.startTime = time;
  }

  /** XNA Matrix.CreateLookAt as a three.js view matrix; the camera loops along its splines. */
  viewMatrix(time) {
    const f = ((time - this.startTime) / 1000) * this.speed;
    const eye = closedSplineValue(this.positions, f);
    const target = this.targets.length > 0 ? closedSplineValue(this.targets, f) : new THREE.Vector3();
    const world = new THREE.Matrix4().lookAt(eye, target, new THREE.Vector3(0, 1, 0)).setPosition(eye);
    return world.invert();
  }
}

function createCameras() {
  return [
    new SplineCamera(
      [[0, 0.1, 2], [0, 0.05, 0.5], [0.1, 0.05, 0.25], [0.25, 0.05, 0], [0, 0.05, -0.25], [-0.25, 0.05, 0]],
      [[0, 0, 1.5], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
      0.05,
    ),
    new SplineCamera([[0, 0.3, 0.5], [0.5, 0.2, 0], [0, 0.1, -0.5], [-0.5, 0.2, 0]], [], 0.01),
  ];
}

/** A camera driven by explicit view/projection matrices (three.js recomputes nothing). */
function createMatrixCamera() {
  const camera = new THREE.Camera();
  camera.matrixAutoUpdate = false;
  return camera;
}

function setCameraMatrices(camera, view, projection) {
  camera.matrix.copy(view).invert();
  camera.updateMatrixWorld(true);
  camera.projectionMatrix.copy(projection);
  camera.projectionMatrixInverse.copy(projection).invert();
}

// --- Shaders --------------------------------------------------------------------------------------

const WAVE_FS = /* glsl */ `
  uniform sampler2D previous_Tex;
  uniform sampler2D current_Tex;
  uniform sampler2D depth_Tex;
  uniform float fCourant;
  uniform float fDamping;
  uniform float fDepthOffset;
  uniform vec2 fRTDimensions;
  varying vec2 vUv;
  void main() {
    vec2 texel = 1.0 / fRTDimensions;
    float h = texture2D(current_Tex, vUv).r;
    float neighbours = texture2D(current_Tex, vUv + vec2(texel.x, 0.0)).r + texture2D(current_Tex, vUv - vec2(texel.x, 0.0)).r
                     + texture2D(current_Tex, vUv + vec2(0.0, texel.y)).r + texture2D(current_Tex, vUv - vec2(0.0, texel.y)).r;
    float next = (2.0 * h - texture2D(previous_Tex, vUv).r + fCourant * (neighbours - 4.0 * h)) * (1.0 - fDamping);
    // ponytail: shoreline rule guessed — the island (dark in the depth map) is a fixed boundary once it rises above fDepthOffset
    float land = step(texture2D(depth_Tex, vUv).r, fDepthOffset);
    gl_FragColor = vec4(next * (1.0 - land), 0.0, 0.0, 1.0);
  }`;

const DROP_FS = /* glsl */ `
  uniform float fWaveHeight;
  void main() { gl_FragColor = vec4(fWaveHeight, 0.0, 0.0, 1.0); }`;

const BUMP_FS = /* glsl */ `
  uniform sampler2D current_Tex;
  uniform vec2 fRTDimensions;
  varying vec2 vUv;
  void main() {
    vec2 texel = 1.0 / fRTDimensions;
    float du = texture2D(current_Tex, vUv + vec2(texel.x, 0.0)).r - texture2D(current_Tex, vUv - vec2(texel.x, 0.0)).r;
    float dv = texture2D(current_Tex, vUv + vec2(0.0, texel.y)).r - texture2D(current_Tex, vUv - vec2(0.0, texel.y)).r;
    // World x follows +u, world z follows -v. ponytail: slope scale chosen by eye
    gl_FragColor = vec4(normalize(vec3(-du, 0.08, dv)), 1.0);
  }`;

const SKYBOX_FS = /* glsl */ `
  uniform samplerCube skybox_Tex;
  uniform mat4 matProjectionInverse;
  uniform mat4 matViewInverse;
  varying vec2 vUv;
  void main() {
    vec4 viewDir = matProjectionInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = (matViewInverse * vec4(viewDir.xyz / viewDir.w, 0.0)).xyz;
    gl_FragColor = textureCube(skybox_Tex, dir);
  }`;

const WATER_VS = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vViewPos;
  void main() {
    vUv = vec2(uv.x, 1.0 - uv.y); // D3D texcoords -> GL
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const WATER_FS = /* glsl */ `
  uniform sampler2D bump_Tex;
  uniform sampler2D reflection_Tex;
  uniform sampler2D damping_Tex;
  uniform vec2 fRTDimensions;
  uniform vec4 fAmbient;
  uniform vec4 fSpecular;
  uniform vec4 fDiffuse;
  uniform vec4 fWaterColour;
  uniform float fSpecularPower;
  uniform vec3 fLightPosition;
  uniform mat3 viewRotation;
  varying vec2 vUv;
  varying vec3 vViewPos;
  void main() {
    float damping = texture2D(damping_Tex, clamp(vUv, 0.0, 1.0)).r;
    vec3 bump = texture2D(bump_Tex, clamp(vUv, 0.0, 1.0)).xyz;
    vec3 worldNormal = normalize(mix(vec3(0.0, 1.0, 0.0), bump, damping));
    vec3 n = normalize(viewRotation * worldNormal);
    vec3 v = normalize(-vViewPos);
    vec3 l = normalize(fLightPosition - vViewPos);
    // ponytail: reflection distortion and fresnel weights chosen by eye
    vec2 screen = gl_FragCoord.xy / fRTDimensions + worldNormal.xz * 0.05;
    vec3 reflection = texture2D(reflection_Tex, screen).rgb;
    float fresnel = 0.25 + 0.75 * pow(1.0 - max(dot(n, v), 0.0), 3.0);
    float diffuse = max(dot(n, l), 0.0);
    float specular = pow(max(dot(reflect(-l, n), v), 0.0), fSpecularPower);
    vec3 colour = mix(fWaterColour.rgb, reflection, fresnel) + fAmbient.rgb + fDiffuse.rgb * diffuse + fSpecular.rgb * specular;
    gl_FragColor = vec4(colour, 1.0);
  }`;

// Shared by the landscape (fixedFunc.fx "Textured") and the spike ball (BasicEffect, default lighting).
const OBJECT_VS = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vWorldNormal = mat3(modelMatrix) * normal;
    vUv = vec2(uv.x, 1.0 - uv.y);
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const CLIP_GLSL = /* glsl */ `
  uniform bool clipBelowWater;
  void clipToWater(vec3 worldPos) {
    if (clipBelowWater && worldPos.y < 0.0) {
      discard;
    }
  }`;

const FIXED_FUNC_FS = /* glsl */ `
  ${CLIP_GLSL}
  uniform sampler2D texturemap;
  uniform vec3 ambient;
  uniform vec3 diffuse;
  uniform vec3 specular;
  uniform float specularPower;
  uniform vec4 colour;
  uniform vec3 lightDir;
  uniform float texScale;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  void main() {
    clipToWater(vWorldPos);
    vec3 n = normalize(vWorldNormal);
    vec3 l = normalize(lightDir);
    vec3 v = normalize(cameraPosition - vWorldPos);
    float ndl = max(dot(n, l), 0.0);
    float spec = pow(max(dot(reflect(-l, n), v), 0.0), specularPower);
    vec3 tex = texture2D(texturemap, vUv * texScale).rgb;
    gl_FragColor = vec4(tex * (ambient + diffuse * ndl) * colour.rgb + specular * spec, colour.a);
  }`;

// XNA BasicEffect.EnableDefaultLighting(), evaluated per pixel.
const BASIC_EFFECT_FS = /* glsl */ `
  ${CLIP_GLSL}
  uniform vec3 diffuseColor;
  uniform vec3 emissiveColor;
  uniform vec3 specularColor;
  uniform float specularPower;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  const vec3 AMBIENT = vec3(0.05333332, 0.09882354, 0.1819608);
  const vec3 DIR0 = vec3(-0.5265408, -0.5735765, -0.6275069);
  const vec3 DIF0 = vec3(1.0, 0.9607844, 0.8078432);
  const vec3 SPC0 = vec3(1.0, 0.9607844, 0.8078432);
  const vec3 DIR1 = vec3(0.7198464, 0.3420201, 0.6040227);
  const vec3 DIF1 = vec3(0.9647059, 0.7607844, 0.4078432);
  const vec3 DIR2 = vec3(0.4545195, -0.7660444, 0.4545195);
  const vec3 DIF2 = vec3(0.3231373, 0.3607844, 0.3937255);
  const vec3 SPC2 = vec3(0.3231373, 0.3607844, 0.3937255);
  vec3 light(vec3 n, vec3 v, vec3 dir, vec3 dif, vec3 spc, inout vec3 specSum) {
    vec3 l = -dir;
    float ndl = max(dot(n, l), 0.0);
    vec3 h = normalize(l + v);
    specSum += spc * (ndl > 0.0 ? pow(max(dot(n, h), 0.0), specularPower) : 0.0);
    return dif * ndl;
  }
  void main() {
    clipToWater(vWorldPos);
    vec3 n = normalize(vWorldNormal);
    vec3 v = normalize(cameraPosition - vWorldPos);
    vec3 spec = vec3(0.0);
    vec3 dif = light(n, v, DIR0, DIF0, SPC0, spec) + light(n, v, DIR1, DIF1, vec3(0.0), spec) + light(n, v, DIR2, DIF2, SPC2, spec);
    gl_FragColor = vec4(diffuseColor * (dif + AMBIENT) + emissiveColor + specularColor * spec, 1.0);
  }`;

const PLAIN_VS = /* glsl */ `
  void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// --- Geometry -------------------------------------------------------------------------------------

/** WaveEffect's 8-vertex surface: the simulated [-1,1] quad plus a skirt out to +-64. */
function buildWaterSurface() {
  const corners = [[-1, 1], [-1, -1], [1, -1], [1, 1], [-64, 64], [-64, -64], [64, -64], [64, 64]];
  const position = new Float32Array(corners.flatMap(([x, z]) => [x, 0, z]));
  const uv = new Float32Array(corners.flatMap(([x, z]) => [0.5 + 0.5 * x, 0.5 + 0.5 * z]));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex([0, 1, 2, 2, 3, 0, 4, 5, 1, 4, 1, 0, 4, 0, 3, 4, 3, 7, 6, 7, 3, 6, 3, 2, 6, 2, 1, 6, 1, 5]);
  return geometry;
}

/** One THREE.Mesh per model part, positioned by its bone; returns a group whose matrix is the XNA world. */
function buildModelGroup(model, material) {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const bones = model.absoluteBoneTransforms();
  for (const mesh of model.meshes) {
    for (const part of mesh.parts) {
      const m = new THREE.Mesh(part.geometry, material);
      m.matrixAutoUpdate = false;
      m.matrix.copy(bones[mesh.parentBone]);
      m.frustumCulled = false;
      group.add(m);
    }
  }
  return group;
}

function createHeightTarget(ctx) {
  const target = new THREE.WebGLRenderTarget(SIM_SIZE, SIM_SIZE, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: true,
    generateMipmaps: false,
  });
  ctx.renderer.setRenderTarget(target);
  ctx.renderer.setClearColor(0x000000, 1);
  ctx.renderer.clear(true, true, true);
  return target;
}

async function loadCubeTexture(name) {
  const urls = SKY_FACES.map((face) => `assets/textures/textures/${name}_${face}.png`);
  const texture = await new THREE.CubeTextureLoader().loadAsync(urls);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

function stencilMaterial(side, zPass) {
  return new THREE.ShaderMaterial({
    vertexShader: PLAIN_VS,
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
    side,
    colorWrite: false,
    depthTest: false,
    depthWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: zPass,
  });
}

// --- Effect ---------------------------------------------------------------------------------------

class WaveEffect extends DemoEffect {
  async load() {
    const ctx = this.ctx;
    const [sky, depth, damping, landscapeTex, ball, landscape] = await Promise.all([
      loadCubeTexture('skybox'),
      ctx.loadTexture('textures/depth'),
      ctx.loadTexture('textures/damping'),
      ctx.loadTexture('textures/landscape', { repeat: true }),
      loadModel('abstract2'),
      loadModel('scene'),
    ]);
    this.heights = [0, 1, 2].map(() => createHeightTarget(ctx));
    this.bump = new THREE.WebGLRenderTarget(SIM_SIZE, SIM_SIZE, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: true,
    });
    this.reflection = ctx.createTarget(WIDTH, HEIGHT, true);
    this.createSimulationMaterials(depth);
    this.createSceneMaterials(sky, damping, landscapeTex);
    this.createScenes(ball, landscape);
    this.cameras = createCameras();
    this.camera = createMatrixCamera();
    this.dropCamera = createMatrixCamera();
    setCameraMatrices(
      this.dropCamera,
      new THREE.Matrix4().makeRotationX(Math.PI / 2),
      new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 100).projectionMatrix,
    );
    this.projection = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(FOV), WIDTH / HEIGHT, NEAR_Z, FAR_Z).projectionMatrix;
    this.reset();
  }

  createSimulationMaterials(depth) {
    const dims = new THREE.Vector2(SIM_SIZE, SIM_SIZE);
    this.waveMaterial = this.ctx.createQuadMaterial(WAVE_FS, {
      previous_Tex: { value: null },
      current_Tex: { value: null },
      depth_Tex: { value: depth },
      fCourant: { value: 0.2 },
      fDamping: { value: 0.003 },
      fDepthOffset: { value: 0 },
      fRTDimensions: { value: dims },
    });
    this.dropMaterial = this.ctx.createQuadMaterial(DROP_FS, { fWaveHeight: { value: 0.125 } });
    Object.assign(this.dropMaterial, {
      stencilWrite: true,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilRef: 0,
      stencilZPass: THREE.KeepStencilOp,
    });
    this.bumpMaterial = this.ctx.createQuadMaterial(BUMP_FS, { current_Tex: { value: null }, fRTDimensions: { value: dims } });
    // Two-sided stencil (XNA TwoSidedStencilMode): count entries minus exits below the water plane.
    this.stencilFront = stencilMaterial(THREE.FrontSide, THREE.IncrementWrapStencilOp);
    this.stencilBack = stencilMaterial(THREE.BackSide, THREE.DecrementWrapStencilOp);
  }

  createSceneMaterials(sky, damping, landscapeTex) {
    this.skyboxMaterial = this.ctx.createQuadMaterial(SKYBOX_FS, {
      skybox_Tex: { value: sky },
      matProjectionInverse: { value: new THREE.Matrix4() },
      matViewInverse: { value: new THREE.Matrix4() },
    });
    this.waterMaterial = new THREE.ShaderMaterial({
      vertexShader: WATER_VS,
      fragmentShader: WATER_FS,
      side: THREE.DoubleSide,
      uniforms: {
        bump_Tex: { value: this.bump.texture },
        reflection_Tex: { value: this.reflection.texture },
        damping_Tex: { value: damping },
        fRTDimensions: { value: new THREE.Vector2(WIDTH, HEIGHT) },
        fAmbient: { value: new THREE.Vector4(0, 0, 0, 0) },
        fSpecular: { value: new THREE.Vector4(1, 0.96, 0.72, 1) },
        fDiffuse: { value: new THREE.Vector4(0, 0, 0, 0) },
        fWaterColour: { value: new THREE.Vector4(0, 0.11, 0.12, 1) },
        fSpecularPower: { value: 256 },
        fLightPosition: { value: new THREE.Vector3(-785, 423, 453) },
        viewRotation: { value: new THREE.Matrix3() },
      },
    });
    this.landscapeMaterial = new THREE.ShaderMaterial({
      vertexShader: OBJECT_VS,
      fragmentShader: FIXED_FUNC_FS,
      uniforms: {
        clipBelowWater: { value: false },
        texturemap: { value: landscapeTex },
        ambient: { value: new THREE.Vector3(0.2, 0.2, 0.2) },
        diffuse: { value: new THREE.Vector3(0.5, 0.4, 0.4) },
        specular: { value: new THREE.Vector3(0.5, 0.4, 0.4) },
        specularPower: { value: 64 },
        colour: { value: new THREE.Vector4(1, 1, 1, 1) },
        lightDir: { value: new THREE.Vector3(-785, 423, 453) },
        texScale: { value: 8 },
      },
    });
    this.ballMaterial = new THREE.ShaderMaterial({
      vertexShader: OBJECT_VS,
      fragmentShader: BASIC_EFFECT_FS,
      uniforms: {
        clipBelowWater: { value: false },
        diffuseColor: { value: new THREE.Vector3(0.2, 0.1, 0.1) },
        emissiveColor: { value: new THREE.Vector3(0, 0, 0) },
        specularColor: { value: new THREE.Vector3(1, 1, 1) },
        specularPower: { value: 16 },
      },
    });
  }

  createScenes(ball, landscape) {
    this.landscape = buildModelGroup(landscape, this.landscapeMaterial);
    this.ball = buildModelGroup(ball, this.ballMaterial);
    this.objects = new THREE.Scene();
    this.objects.add(this.landscape, this.ball);
    const water = new THREE.Mesh(buildWaterSurface(), this.waterMaterial);
    water.frustumCulled = false;
    this.waterScene = new THREE.Scene();
    this.waterScene.add(water);
  }

  reset() {
    super.reset();
    if (!this.heights) {
      return;
    }
    for (const target of this.heights) {
      this.ctx.renderer.setRenderTarget(target);
      this.ctx.renderer.setClearColor(0x000000, 1);
      this.ctx.renderer.clear(true, true, true);
    }
    this.currentWave = 0;
    this.landHeight = 0;
    this.landSpeed = 1;
    this.landHeightTarget = 0;
    this.lastTime = 0;
    this.simTime = 0;
    this.currentCamera = 0;
  }

  init(time) {
    super.init(time);
    this.lastTime = time;
    this.simTime = time;
    for (const camera of this.cameras) {
      camera.init(time);
    }
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    switch (ev.type) {
      case 'WavesLandHeightTarget':
        this.landHeightTarget = ev.p[0];
        break;
      case 'WavesLandHeight':
        this.landHeight = ev.p[0];
        break;
      case 'WavesLandSpeed':
        this.landSpeed = ev.p[0];
        break;
      case 'SelectCamera':
        this.currentCamera = Math.floor(ev.p[0] + 0.5);
        break;
    }
  }

  /** WaveEffect.renderObjects: island (sunk by landHeight) and the bobbing spike ball. Times in ms. */
  placeObjects(t) {
    // XNA: bone * T(0, (h-1)*16, 0) * S(1/127)
    this.landscape.matrix.makeScale(1 / 127, 1 / 127, 1 / 127)
      .multiply(new THREE.Matrix4().makeTranslation(0, (this.landHeight - 1) * 16, 0));
    // XNA: S(0.1) * Rx * Ry * Rz * T
    this.ball.matrix.makeTranslation(0, 0.18 - 0.05 * Math.sin(t * 0.0002), 0)
      .multiply(new THREE.Matrix4().makeRotationZ(t * 0.00025))
      .multiply(new THREE.Matrix4().makeRotationY(t * 0.0002))
      .multiply(new THREE.Matrix4().makeRotationX(t * 0.00015))
      .multiply(new THREE.Matrix4().makeScale(0.1, 0.1, 0.1));
    this.landscape.updateMatrixWorld(true);
    this.ball.updateMatrixWorld(true);
  }

  updateLandHeight(time) {
    const step = (time - this.lastTime) * Math.abs(this.landSpeed) * 0.001;
    if (this.landHeight > this.landHeightTarget) {
      this.landHeight = Math.max(this.landHeightTarget, this.landHeight - step);
    } else if (this.landHeight < this.landHeightTarget) {
      this.landHeight = Math.min(this.landHeightTarget, this.landHeight + step);
    }
    this.lastTime = time;
  }

  simulateStep(t) {
    const { ctx, heights } = this;
    const renderer = ctx.renderer;
    const n = heights.length;
    this.waveMaterial.uniforms.previous_Tex.value = heights[(this.currentWave + n - 1) % n].texture;
    this.waveMaterial.uniforms.current_Tex.value = heights[this.currentWave].texture;
    this.waveMaterial.uniforms.fDepthOffset.value = this.landHeight;
    this.currentWave = (this.currentWave + 1) % n;
    const target = heights[this.currentWave];
    ctx.drawQuad(this.waveMaterial, target);

    // Stamp object cross-sections at y = 0 (top-down ortho view of everything below the water).
    renderer.setRenderTarget(target);
    renderer.clear(false, false, true);
    this.placeObjects(t);
    for (const material of [this.stencilFront, this.stencilBack]) {
      this.objects.overrideMaterial = material;
      renderer.render(this.objects, this.dropCamera);
    }
    this.objects.overrideMaterial = null;
    ctx.drawQuad(this.dropMaterial, target);
  }

  /** Fixed 60 Hz steps: the original advanced the simulation once per (60 Hz) frame. */
  simulateWaves(time) {
    let steps = 0;
    while (this.simTime + SIM_STEP_MS <= time && steps < MAX_SIM_STEPS) {
      this.simTime += SIM_STEP_MS;
      this.simulateStep(this.simTime - this.startTime);
      steps++;
    }
    if (steps === MAX_SIM_STEPS) {
      this.simTime = time;
    }
    this.bumpMaterial.uniforms.current_Tex.value = this.heights[this.currentWave].texture;
    this.ctx.drawQuad(this.bumpMaterial, this.bump);
  }

  drawSkybox(target, view) {
    const u = this.skyboxMaterial.uniforms;
    u.matProjectionInverse.value.copy(this.projection).invert();
    u.matViewInverse.value.copy(view).invert();
    this.ctx.drawQuad(this.skyboxMaterial, target);
  }

  renderObjects(target, view, { mirrored }) {
    const side = mirrored ? THREE.DoubleSide : THREE.BackSide;
    for (const material of [this.landscapeMaterial, this.ballMaterial]) {
      material.side = side;
      material.uniforms.clipBelowWater.value = mirrored;
    }
    setCameraMatrices(this.camera, view, this.projection);
    this.ctx.renderer.setRenderTarget(target);
    this.ctx.renderer.render(this.objects, this.camera);
  }

  renderReflection(view) {
    // XNA: Matrix.CreateReflection(y = 0) * view
    const mirroredView = view.clone().multiply(new THREE.Matrix4().makeScale(1, -1, 1));
    const renderer = this.ctx.renderer;
    renderer.setRenderTarget(this.reflection);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    this.drawSkybox(this.reflection, mirroredView);
    this.renderObjects(this.reflection, mirroredView, { mirrored: true });
  }

  renderSurface(view) {
    const target = this.ctx.backBuffer;
    const renderer = this.ctx.renderer;
    renderer.setRenderTarget(target);
    renderer.setClearColor(CORNFLOWER_BLUE, 1);
    renderer.clear(true, true, true);
    this.drawSkybox(target, view);
    this.waterMaterial.uniforms.viewRotation.value.setFromMatrix4(view);
    setCameraMatrices(this.camera, view, this.projection);
    renderer.setRenderTarget(target);
    renderer.render(this.waterScene, this.camera);
  }

  render(time) {
    this.updateLandHeight(time);
    const view = this.cameras[this.currentCamera].viewMatrix(time);
    this.simulateWaves(time);
    this.placeObjects(time - this.startTime);
    this.renderReflection(view);
    this.renderSurface(view);
    this.renderObjects(this.ctx.backBuffer, view, { mirrored: false });
  }
}

export default (ctx) => new WaveEffect(ctx);
