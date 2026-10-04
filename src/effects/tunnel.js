// Port of Demo.DeferredEffect ("tunnel", 1:07-1:31.5): a square shaft with crossed bars and spheres,
// lit by 640 falling point lights that bounce off the geometry. Deferred shading: a G-buffer pass
// (view-space position, bumped normal, colour), an ambient pass, then one additive light volume per light.
// Shader bodies are reconstructions from DeferData/DeferAmbient/DeferLights.xnb parameter names and defaults.
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT } from '../engine.js';

const LIGHT_COUNT = 640;
const COLLISION_RADIUS = 0.01;
const SHAFT_HALF_LENGTH = 64;
const LIGHT_FALL_HEIGHT = 12;
const GRAVITY = 1;
const VELOCITY_DECAY = 0.5;
const ELASTICITY = 0.5;
const PARTICLE_SIZE = 16;
// Defaults stored in DeferAmbient.xnb / DeferLights.xnb (record precedes each parameter name)
const AMBIENT = 0.2;
const SPECULAR_COLOUR = 0.75;
const SPECULAR_POWER = 64;
// ponytail: physics step clamped so seeking doesn't teleport every light out of the shaft
const MAX_STEP_SECONDS = 0.1;

const CAMERA_HEIGHT_STEP = 2.6666667;
const CAMERAS = [
  {
    speed: 1 / 6,
    points: [[0, 0.25, 0.75], [0.53025, 0.25, 0.53025], [0.75, 0.25, 0], [0.53025, 0.25, -0.53025],
      [0, 0.25, -0.75], [-0.53025, 0.25, -0.53025], [-0.75, 0.25, 0], [-0.53025, 0.25, 0.53025]],
  },
  {
    speed: 1 / 45,
    points: [[0, 0, 0.75], [0, 1, 0.53025], [0.75, 2, 0], [0.53025, 3, 0], [0, 4, -0.75], [-0.53025, 4.5, -0.53025],
      [-0.75, 4, -0.75], [-0.5, 3, 0], [-0.75, 2, 0], [0, 1, 0.75], [0.75, 0, 0], [0, -1, 0.75], [0.75, -2, 0],
      [0.75, -3, 0], [0, -4, -0.75], [-0.53025, -4.5, -0.53025], [-0.75, -4, 0], [-0.5, -3, 0], [0, -2, 0.25],
      [0, -1, 0.75]].map(([x, y, z]) => [x, y * CAMERA_HEIGHT_STEP, z]),
  },
];

// ---------------------------------------------------------------- shaders

const GBUFFER_VS = /* glsl */ `
  attribute vec3 tangent;
  attribute vec3 binormal;
  varying vec3 vViewPos;
  varying vec3 vNormal;
  varying vec3 vTangent;
  varying vec3 vBinormal;
  varying vec2 vUv;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    vNormal = normalMatrix * normal;
    vTangent = normalMatrix * tangent;
    vBinormal = normalMatrix * binormal;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }`;

// DeferData's RenderPosition / RenderBump / RenderColour techniques, merged into one MRT pass.
const GBUFFER_FS = /* glsl */ `
  precision highp float;
  uniform sampler2D base_Tex;
  uniform sampler2D bump_Tex;
  in vec3 vViewPos;
  in vec3 vNormal;
  in vec3 vTangent;
  in vec3 vBinormal;
  in vec2 vUv;
  layout(location = 0) out vec4 gPosition;
  layout(location = 1) out vec4 gNormal;
  layout(location = 2) out vec4 gColour;
  void main() {
    vec3 bump = texture(bump_Tex, vUv).xyz * 2.0 - 1.0;
    vec3 n = normalize(normalize(vTangent) * bump.x + normalize(vBinormal) * bump.y + normalize(vNormal) * bump.z);
    gPosition = vec4(vViewPos, 1.0);
    gNormal = vec4(n, 1.0);
    gColour = texture(base_Tex, vUv);
  }`;

const AMBIENT_FS = /* glsl */ `
  uniform sampler2D base_Tex;
  uniform float fAmbient;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(base_Tex, vUv).rgb * fAmbient, 1.0);
  }`;

const LIGHT_VS = /* glsl */ `
  attribute vec3 lightPosition;
  attribute vec3 lightColour;
  attribute float lightRadius;
  varying vec3 vLightViewPos;
  varying vec3 vLightColour;
  varying float vRadius;
  void main() {
    vLightViewPos = (viewMatrix * vec4(lightPosition, 1.0)).xyz;
    vLightColour = lightColour;
    vRadius = lightRadius;
    gl_Position = projectionMatrix * viewMatrix * vec4(position * lightRadius + lightPosition, 1.0);
  }`;

const LIGHT_FS = /* glsl */ `
  uniform sampler2D positionMap;
  uniform sampler2D normalMap;
  uniform sampler2D colourMap;
  uniform vec2 fViewportDimensions;
  uniform vec3 fSpecular;
  uniform float fSpecularPower;
  varying vec3 vLightViewPos;
  varying vec3 vLightColour;
  varying float vRadius;
  void main() {
    vec2 uv = gl_FragCoord.xy / fViewportDimensions;
    vec4 position = texture2D(positionMap, uv);
    if (position.w == 0.0) {
      discard;
    }
    vec3 n = normalize(texture2D(normalMap, uv).xyz);
    vec3 toLight = vLightViewPos - position.xyz;
    float dist = length(toLight);
    vec3 l = toLight / dist;
    // ponytail: falloff curve guessed (linear to fRadius); the compiled shader's exact curve is unknown
    float attenuation = clamp(1.0 - dist / vRadius, 0.0, 1.0);
    float diffuse = max(dot(n, l), 0.0);
    vec3 h = normalize(l + normalize(-position.xyz));
    vec3 specular = fSpecular * pow(max(dot(n, h), 0.0), fSpecularPower);
    vec3 colour = texture2D(colourMap, uv).rgb;
    gl_FragColor = vec4(vLightColour * attenuation * (colour * diffuse + specular), 1.0);
  }`;

const PARTICLE_VS = /* glsl */ `
  attribute vec3 color;
  uniform float fParticleSize;
  varying vec3 vColor;
  void main() {
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = fParticleSize / gl_Position.w;
  }`;

const PARTICLE_FS = /* glsl */ `
  uniform sampler2D particle_Tex;
  varying vec3 vColor;
  void main() {
    gl_FragColor = texture2D(particle_Tex, gl_PointCoord) * vec4(vColor, 1.0);
  }`;

// ---------------------------------------------------------------- geometry (VertexPositionTBNTexture)

function tbnGeometry(verts, indices) {
  const g = new THREE.BufferGeometry();
  const flat = (key, size) => new THREE.Float32BufferAttribute(verts.flatMap((v) => v[key].slice(0, size)), size);
  g.setAttribute('position', flat('position', 3));
  g.setAttribute('normal', flat('normal', 3));
  g.setAttribute('tangent', flat('tangent', 3));
  g.setAttribute('binormal', flat('binormal', 3));
  g.setAttribute('uv', flat('uv', 2));
  g.setIndex(indices);
  return g;
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** 16 sectors x 8 slices unit sphere. Binormals copy the C#, which crosses the j=0 meridian's vectors. */
function buildSphere() {
  const verts = new Array(153);
  for (let i = 0; i <= 8; i++) {
    const position = [Math.sin((Math.PI * i) / 8), -Math.cos((Math.PI * i) / 8), 0];
    const tangent = [0, 0, -1];
    verts[i] = { position, normal: position, tangent, binormal: cross(position, tangent), uv: [0, 1 - i / 8] };
    verts[i + 144] = { ...verts[i], uv: [1, 1 - i / 8] };
  }
  for (let j = 1; j < 16; j++) {
    const a = (Math.PI * 2 * j) / 16;
    for (let i = 0; i <= 8; i++) {
      const base = verts[i];
      const position = [base.position[0] * Math.cos(a), base.position[1], base.position[0] * -Math.sin(a)];
      const tangent = [-Math.sin(a), 0, Math.cos(a)];
      verts[i + 9 * j] = { position, normal: position, tangent, binormal: cross(base.normal, base.tangent), uv: [j / 16, 1 - i / 8] };
    }
  }
  const indices = [];
  for (let j = 0; j < 16; j++) {
    for (let i = 0; i < 8; i++) {
      indices.push(i + j * 9, i + 1 + j * 9, i + 1 + (j + 1) * 9, i + 1 + (j + 1) * 9, i + (j + 1) * 9, i + j * 9);
    }
  }
  return tbnGeometry(verts, indices);
}

/** Four inward-facing 2 x 128 quads; each is the previous rotated 90 degrees about Y. */
function buildWalls() {
  const first = [
    { position: [-1, -SHAFT_HALF_LENGTH, -1], uv: [0, 64] },
    { position: [-1, SHAFT_HALF_LENGTH, -1], uv: [0, 0] },
    { position: [1, SHAFT_HALF_LENGTH, -1], uv: [1, 0] },
    { position: [1, -SHAFT_HALF_LENGTH, -1], uv: [1, 64] },
  ].map((v) => ({ ...v, normal: [0, 0, 1], tangent: [1, 0, 0], binormal: [0, 1, 0] }));
  const rotate = ([x, y, z]) => [-z, y, x]; // row-vector transform by the C# matrix (0,0,1 / 0,1,0 / -1,0,0)
  const verts = [...first];
  for (let i = 1; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const p = verts[(i - 1) * 4 + j];
      verts.push({ position: rotate(p.position), normal: rotate(p.normal), tangent: rotate(p.tangent), binormal: rotate(p.binormal), uv: p.uv });
    }
  }
  const indices = [];
  for (let i = 0; i < 4; i++) {
    indices.push(i * 4, 1 + i * 4, 2 + i * 4, 2 + i * 4, 3 + i * 4, i * 4);
  }
  return tbnGeometry(verts, indices);
}

/** Unit-radius, unit-height open cylinder along +Y. */
function buildCylinder() {
  const verts = [];
  for (let j = 0; j <= 16; j++) {
    const a = (Math.PI * 2 * j) / 16;
    for (let i = 0; i <= 1; i++) {
      const normal = [Math.cos(a), 0, -Math.sin(a)];
      verts.push({ position: [Math.cos(a), i, -Math.sin(a)], normal, tangent: [-Math.sin(a), 0, Math.cos(a)], binormal: [0, -1, 0], uv: [j / 16, 1 - i] });
    }
  }
  const indices = [];
  for (let j = 0; j < 16; j++) {
    indices.push(j * 2, 1 + j * 2, 1 + (j + 1) * 2, 1 + (j + 1) * 2, (j + 1) * 2, j * 2);
  }
  return tbnGeometry(verts, indices);
}

// ---------------------------------------------------------------- collision world (ParticlePhysics subset)

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

class BBox {
  constructor() {
    this.spheres = []; // {centre, radius}
    this.planes = []; // arrays of Vector4 (normal, w)
    this.cylinders = []; // {start, end, radius}
    this.children = [];
    this.min = v3(0, 0, 0);
    this.max = v3(0, 0, 0);
  }

  expand() {
    this.min.setScalar(Number.MAX_VALUE);
    this.max.setScalar(-Number.MAX_VALUE);
    const grow = (p) => {
      this.min.min(p);
      this.max.max(p);
    };
    for (const child of this.children) {
      child.expand();
      grow(child.min);
      grow(child.max);
    }
    for (const s of this.spheres) {
      grow(s.centre.clone().subScalar(s.radius));
      grow(s.centre.clone().addScalar(s.radius));
    }
    for (const c of this.cylinders) {
      grow(c.start.clone().min(c.end).subScalar(c.radius));
      grow(c.start.clone().max(c.end).addScalar(c.radius));
    }
  }

  allSpheres() {
    return [...this.children.flatMap((c) => c.allSpheres()), ...this.spheres];
  }

  allCylinders() {
    return [...this.children.flatMap((c) => c.allCylinders()), ...this.cylinders];
  }
}

function addCrosses(power, top, bottom) {
  const box = new BBox();
  if (power > 1) {
    const third = top * 0.667 + bottom * 0.333;
    const twoThirds = top * 0.333 + bottom * 0.667;
    box.children.push(addCrosses(power - 1, top, third), addCrosses(power - 1, third, twoThirds), addCrosses(power - 1, twoThirds, bottom));
    return box;
  }
  const cyl = (a, b, at) => ({ start: v3(...a).add(at), end: v3(...b).add(at), radius: 0.1 });
  let at = v3(0, top * 0.5 + bottom * 0.5, 0);
  box.spheres.push({ centre: at.clone(), radius: 0.25 });
  box.cylinders.push(cyl([1, 0, -1], [-1, 0, 1], at), cyl([-1, 0, -1], [1, 0, 1], at));
  at = v3(0, top * 0.833 + bottom * 0.167, 0);
  box.cylinders.push(cyl([-1, 0, -0.5], [1, 0, -0.5], at), cyl([-1, 0, 0.5], [1, 0, 0.5], at));
  at = v3(0, top * 0.167 + bottom * 0.833, 0);
  box.cylinders.push(cyl([-0.5, 0, -1], [-0.5, 0, 1], at), cyl([0.5, 0, -1], [0.5, 0, 1], at));
  return box;
}

function buildCollisionWorld() {
  const root = new BBox();
  root.planes.push([new THREE.Vector4(1, 0, 0, 1)], [new THREE.Vector4(-1, 0, 0, 1)], [new THREE.Vector4(0, 0, 1, 1)], [new THREE.Vector4(0, 0, -1, 1)]);
  root.children.push(addCrosses(2, -LIGHT_FALL_HEIGHT, LIGHT_FALL_HEIGHT));
  root.expand();
  return root;
}

function bounce(p, normal) {
  const d = p.velocity.dot(normal);
  p.velocity.addScaledVector(normal, -(1 + ELASTICITY) * d).multiplyScalar(0.9999);
}

/** Port of ParticlePhysics.ApplyCollinsionsInBBox (sic) for one particle. */
function collide(p, box) {
  const r = COLLISION_RADIUS;
  const pos = p.position;
  if (pos.x > box.max.x + r || pos.y > box.max.y + r || pos.z > box.max.z + r
    || pos.x < box.min.x - r || pos.y < box.min.y - r || pos.z < box.min.z - r) {
    return;
  }
  for (const s of box.spheres) {
    const offset = pos.clone().sub(s.centre);
    const reach = r + s.radius;
    if (offset.lengthSq() <= reach * reach) {
      offset.normalize();
      pos.copy(s.centre).addScaledVector(offset, reach);
      if (p.velocity.dot(offset) < 0) {
        bounce(p, offset);
      }
    }
  }
  for (const group of box.planes) {
    let deepest = -1;
    let hit = null;
    for (const plane of group) {
      const d = plane.x * pos.x + plane.y * pos.y + plane.z * pos.z + plane.w - r;
      if (d > 0) {
        hit = null;
        break;
      }
      if (d > deepest) {
        hit = plane;
        deepest = d;
      }
    }
    if (hit) {
      const normal = v3(hit.x, hit.y, hit.z);
      pos.addScaledVector(normal, -deepest);
      if (p.velocity.dot(normal) < 0) {
        bounce(p, normal);
      }
    }
  }
  for (const c of box.cylinders) {
    const reach = r + c.radius;
    const axis = c.end.clone().sub(c.start);
    const t = THREE.MathUtils.clamp(axis.dot(pos.clone().sub(c.start)) / axis.dot(axis), 0, 1);
    const closest = c.start.clone().addScaledVector(axis, t);
    const offset = pos.clone().sub(closest);
    if (offset.lengthSq() <= reach * reach) {
      offset.normalize();
      pos.copy(closest).addScaledVector(offset, reach);
      if (p.velocity.dot(offset) < 0) {
        bounce(p, offset);
      }
    }
  }
  for (const child of box.children) {
    collide(p, child);
  }
}

// ---------------------------------------------------------------- camera (Demo.Camera, Target mode at origin)

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
  return [0, 1, 2].map((axis) => catmullRom(a[axis], b[axis], c[axis], d[axis], frac));
}

// ---------------------------------------------------------------- effect

function randomRange(scale) {
  return (Math.random() - 0.5) * 2 * scale;
}

function lightColour() {
  const hue = Math.random();
  const saturation = Math.sqrt(Math.random());
  const tint = [THREE.MathUtils.lerp(1, 0.25, hue), THREE.MathUtils.lerp(0.5, 0.25, hue), THREE.MathUtils.lerp(0.25, 1, hue)];
  return tint.map((c) => THREE.MathUtils.lerp(1, c, saturation) * 2);
}

/** Lights fade out over the top and bottom 6 units of the 24-unit fall. */
function fadeByHeight(y) {
  if (y > LIGHT_FALL_HEIGHT / 2) {
    return ((LIGHT_FALL_HEIGHT - y) * 2) / LIGHT_FALL_HEIGHT;
  }
  if (y < -LIGHT_FALL_HEIGHT / 2) {
    return ((LIGHT_FALL_HEIGHT + y) * 2) / LIGHT_FALL_HEIGHT;
  }
  return 1;
}

class TunnelEffect extends DemoEffect {
  async load() {
    const ctx = this.ctx;
    const [walls, bump, particle] = await Promise.all([
      ctx.loadTexture('textures/deferredWalls', { repeat: true }),
      ctx.loadTexture('textures/deferredWallsBump', { repeat: true }),
      ctx.loadTexture('textures/particle'),
    ]);
    this.world = buildCollisionWorld();
    this.camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(1.2), WIDTH / HEIGHT, 0.01, 128);
    this.gbuffer = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, {
      count: 3,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.buildWorldScene(walls, bump);
    this.buildLightScene();
    this.buildParticleScene(particle);
    this.particles = Array.from({ length: LIGHT_COUNT }, () => ({ position: v3(0, 0, 0), velocity: v3(0, 0, 0), colour: [1, 1, 1], radius: 0.3 }));
    this.reset();
  }

  buildWorldScene(walls, bump) {
    this.gbufferMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: GBUFFER_VS,
      fragmentShader: GBUFFER_FS,
      side: THREE.BackSide,
      uniforms: { base_Tex: { value: walls }, bump_Tex: { value: bump } },
    });
    this.ambientMaterial = new THREE.ShaderMaterial({
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: AMBIENT_FS,
      side: THREE.BackSide,
      uniforms: { base_Tex: { value: walls }, fAmbient: { value: AMBIENT } },
    });
    this.worldScene = new THREE.Scene();
    this.worldScene.add(new THREE.Mesh(buildWalls()));
    const sphere = buildSphere();
    for (const s of this.world.allSpheres()) {
      const mesh = new THREE.Mesh(sphere);
      mesh.position.copy(s.centre);
      mesh.scale.setScalar(s.radius);
      this.worldScene.add(mesh);
    }
    const cylinder = buildCylinder();
    for (const c of this.world.allCylinders()) {
      this.worldScene.add(this.cylinderMesh(cylinder, c));
    }
  }

  /** The C# builds a basis whose X/Z axes have length `radius` and Y spans start -> end. */
  cylinderMesh(geometry, c) {
    const axis = c.end.clone().sub(c.start);
    const up = v3(0, 1, 0).addScaledVector(axis, -axis.y / axis.dot(axis)).normalize().multiplyScalar(c.radius);
    const side = axis.clone().normalize().cross(up);
    const mesh = new THREE.Mesh(geometry);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeBasis(side, axis, up).setPosition(c.start);
    return mesh;
  }

  buildLightScene() {
    const sphere = buildSphere();
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = sphere.index;
    geometry.setAttribute('position', sphere.getAttribute('position'));
    this.lightPositions = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_COUNT * 3), 3);
    this.lightColours = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_COUNT * 3), 3);
    this.lightRadii = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_COUNT), 1);
    geometry.setAttribute('lightPosition', this.lightPositions);
    geometry.setAttribute('lightColour', this.lightColours);
    geometry.setAttribute('lightRadius', this.lightRadii);
    geometry.instanceCount = LIGHT_COUNT;
    const material = new THREE.ShaderMaterial({
      vertexShader: LIGHT_VS,
      fragmentShader: LIGHT_FS,
      // Far faces only: each covered pixel is shaded exactly once, whether the camera is inside the volume or not.
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        positionMap: { value: this.gbuffer.textures[0] },
        normalMap: { value: this.gbuffer.textures[1] },
        colourMap: { value: this.gbuffer.textures[2] },
        fViewportDimensions: { value: new THREE.Vector2(WIDTH, HEIGHT) },
        fSpecular: { value: new THREE.Vector3().setScalar(SPECULAR_COLOUR) },
        fSpecularPower: { value: SPECULAR_POWER },
      },
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.lightScene = new THREE.Scene();
    this.lightScene.add(mesh);
  }

  buildParticleScene(texture) {
    const geometry = new THREE.BufferGeometry();
    this.spritePositions = new THREE.BufferAttribute(new Float32Array(LIGHT_COUNT * 3), 3);
    this.spriteColours = new THREE.BufferAttribute(new Float32Array(LIGHT_COUNT * 3), 3);
    geometry.setAttribute('position', this.spritePositions);
    geometry.setAttribute('color', this.spriteColours);
    const points = new THREE.Points(geometry, new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      uniforms: { particle_Tex: { value: texture }, fParticleSize: { value: PARTICLE_SIZE } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }));
    points.frustumCulled = false;
    this.particleScene = new THREE.Scene();
    this.particleScene.add(points);
  }

  reset() {
    super.reset();
    for (const p of this.particles ?? []) {
      p.position.set(randomRange(1), randomRange(LIGHT_FALL_HEIGHT), randomRange(1));
      p.velocity.set(0, 0, 0);
      p.colour = lightColour();
      p.radius = Math.random() * 0.1 + 0.3;
    }
    this.lastTime = 0;
    this.currentCamera = 1;
  }

  init(time) {
    super.init(time);
    this.lastTime = time;
    this.cameraStart = time;
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    if (ev.type === 'SelectCamera') {
      this.currentCamera = Math.floor(ev.p[0] + 0.5);
    }
  }

  stepPhysics(dt) {
    for (const p of this.particles) {
      p.position.addScaledVector(p.velocity, dt);
      if (p.position.y < -LIGHT_FALL_HEIGHT) {
        p.position.set(randomRange(1), LIGHT_FALL_HEIGHT, randomRange(1));
        p.velocity.set(0, 0, 0);
      }
      p.velocity.y -= GRAVITY * dt;
      p.velocity.multiplyScalar(Math.exp(-dt * VELOCITY_DECAY));
    }
    for (const p of this.particles) {
      collide(p, this.world);
    }
  }

  updateCamera(time) {
    const { speed, points } = CAMERAS[this.currentCamera];
    const f = ((time - this.cameraStart) / 1000) * speed;
    this.camera.position.fromArray(closedSplineValue(points, f));
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
  }

  uploadLights() {
    this.particles.forEach((p, i) => {
      const fade = fadeByHeight(p.position.y);
      const colour = p.colour.map((c) => c * fade);
      p.position.toArray(this.lightPositions.array, i * 3);
      this.lightColours.array.set(colour, i * 3);
      this.lightRadii.array[i] = p.radius;
      p.position.toArray(this.spritePositions.array, i * 3);
      this.spriteColours.array.set(colour.map((c) => THREE.MathUtils.clamp(c, 0, 1)), i * 3); // XNA Color clamps
    });
    for (const attr of [this.lightPositions, this.lightColours, this.lightRadii, this.spritePositions, this.spriteColours]) {
      attr.needsUpdate = true;
    }
  }

  render(time) {
    const dt = Math.min(Math.max((time - this.lastTime) * 0.001, 0), MAX_STEP_SECONDS);
    this.lastTime = time;
    this.stepPhysics(dt);
    this.updateCamera(time);
    this.uploadLights();

    const renderer = this.ctx.renderer;
    renderer.setRenderTarget(this.gbuffer);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    this.worldScene.overrideMaterial = this.gbufferMaterial;
    renderer.render(this.worldScene, this.camera);
    renderer.setClearColor(0x000000, 1);

    this.worldScene.overrideMaterial = this.ambientMaterial;
    this.ctx.renderScene(this.worldScene, this.camera);
    this.ctx.renderScene(this.lightScene, this.camera);
    this.ctx.renderScene(this.particleScene, this.camera);
  }
}

export default (ctx) => new TunnelEffect(ctx);
