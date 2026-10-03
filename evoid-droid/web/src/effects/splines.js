// Port of Demo.SplineEffect: five random-walk Catmull-Rom tubes that grow over time,
// a cloud of additive point sprites, and the two title logos.
// Shader bodies are reconstructions (the originals are compiled Xbox 360 microcode);
// parameter names and default values come from Content/Effects/Spline.xnb and Particle.xnb.
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT, clamp01 } from '../engine.js';
import { DotNetRandom } from '../dotnetRandom.js';

const SPLINE_COUNT = 5;
const CONTROL_POINTS = 400;
const VERTS_PER_SEGMENT = 16;
const MAX_VERTS = CONTROL_POINTS * VERTS_PER_SEGMENT;
const CIRCLE_POINTS = 6;
const CIRCLE_RADIUS = 0.03;
const PARTICLE_COUNT = 5000;
const PARTICLE_RADIUS = 100;
const DEMO_LOGO_IN = 31000;
const GROUP_LOGO_IN = 34000;
const LOGO_FADE = 2000;
const COLOURS = [
  [1, 0.5, 0.5, 1],
  [0.39, 0.27, 0.39, 1],
  [0.77, 0.3, 0.39, 1],
  [1, 0.66, 0.75, 1],
  [0.73, 0.55, 0.73, 1],
];
const ROTATION_AXIS = [-0.2, 0.3, 1];

const SPLINE_VS = /* glsl */ `
  attribute vec3 centre;
  attribute float tval;
  uniform float fT;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec2 vUv;
  void main() {
    // Segments beyond fT collapse onto the spline centre, so the tube "grows" along its path.
    vec3 p = tval > fT ? centre : position;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vViewPos = mv.xyz;
    vNormal = normalMatrix * normal;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }`;

const SPLINE_FS = /* glsl */ `
  uniform sampler2D base_Tex;
  uniform vec4 fColour;
  uniform vec3 fAmbient;
  uniform vec3 fSpecular;
  uniform vec3 fDiffuse;
  uniform float fSpecularPower;
  uniform vec3 fLightPosition;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec2 vUv;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 l = normalize(fLightPosition - vViewPos);
    vec3 v = normalize(-vViewPos);
    float diffuse = max(dot(n, l), 0.0);
    float specular = pow(max(dot(reflect(-l, n), v), 0.0), fSpecularPower);
    vec3 base = texture2D(base_Tex, vUv).rgb * fColour.rgb;
    vec3 lit = base * (fAmbient + fDiffuse * diffuse) + fSpecular * specular;
    gl_FragColor = vec4(lit, fColour.a);
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

/** XNA Matrix.CreateFromAxisAngle, which does not normalise the axis (the demo passes an unnormalised one). */
function xnaAxisAngle([x, y, z], angle) {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z;
  // XNA is row-vector, three.js is column-vector: set() takes the transpose of the XNA matrix.
  return new THREE.Matrix4().set(
    xx + c * (1 - xx), xy - c * xy - s * z, xz - c * xz + s * y, 0,
    xy - c * xy + s * z, yy + c * (1 - yy), yz - c * yz - s * x, 0,
    xz - c * xz - s * y, yz - c * yz + s * x, zz + c * (1 - zz), 0,
    0, 0, 0, 1,
  );
}

function catmullRom(p1, p2, p3, p4, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p2 + (p3 - p1) * t + (2 * p1 - 5 * p2 + 4 * p3 - p4) * t2 + (3 * p2 - p1 - 3 * p3 + p4) * t3);
}

/** Port of Demo.Spline.getValue: closed Catmull-Rom through all control points. */
function splineValue(points, f) {
  const count = points.length;
  const x = f * count;
  const i = Math.floor(x);
  const frac = x - i;
  const [a, b, c, d] = [(i + count - 1) % count, i % count, (i + 1) % count, (i + 2) % count].map((k) => points[k]);
  return new THREE.Vector3(
    catmullRom(a.x, b.x, c.x, d.x, frac),
    catmullRom(a.y, b.y, c.y, d.y, frac),
    catmullRom(a.z, b.z, c.z, d.z, frac),
  );
}

function randomUnitStep(random) {
  return new THREE.Vector3(random.nextDouble() * 2 - 1, random.nextDouble() * 2 - 1, random.nextDouble() * 2 - 1).normalize();
}

/** Builds one tube exactly like SplineEffect.loadContent: parallel-transport frames, 6-sided rings. */
function buildTubeGeometry(random) {
  const controlPoints = [new THREE.Vector3()];
  for (let j = 1; j < CONTROL_POINTS; j++) {
    controlPoints.push(randomUnitStep(random).add(controlPoints[j - 1]));
  }
  const path = Array.from({ length: MAX_VERTS }, (_, j) => splineValue(controlPoints, j / MAX_VERTS));

  const ring = CIRCLE_POINTS + 1;
  const vertexCount = ring * (MAX_VERTS + 1);
  const position = new Float32Array(vertexCount * 3);
  const centre = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const tval = new Float32Array(vertexCount);

  let up = new THREE.Vector3(0, 1, 0);
  for (let j = 0; j < MAX_VERTS; j++) {
    const p = path[j];
    const tangent = path[(j + 1) % MAX_VERTS].clone().sub(path[(j + MAX_VERTS - 1) % MAX_VERTS]).normalize();
    up = up.clone().sub(tangent.clone().multiplyScalar(up.dot(tangent) / tangent.lengthSq())).normalize();
    const side = new THREE.Vector3().crossVectors(tangent, up);
    for (let k = 0; k <= CIRCLE_POINTS; k++) {
      const angle = (k / CIRCLE_POINTS) * Math.PI * 2;
      const offset = up.clone().multiplyScalar(CIRCLE_RADIUS * Math.sin(angle))
        .add(side.clone().multiplyScalar(CIRCLE_RADIUS * Math.cos(angle)));
      const v = j * ring + k;
      p.clone().add(offset).toArray(position, v * 3);
      offset.toArray(normal, v * 3);
      p.toArray(centre, v * 3);
      uv[v * 2] = k / CIRCLE_POINTS;
      uv[v * 2 + 1] = j;
      tval[v] = j / VERTS_PER_SEGMENT;
    }
  }
  // Closing ring duplicates the first one, with the end-of-path texture coordinate and T.
  for (let k = 0; k <= CIRCLE_POINTS; k++) {
    const src = k;
    const dst = MAX_VERTS * ring + k;
    position.copyWithin(dst * 3, src * 3, src * 3 + 3);
    normal.copyWithin(dst * 3, src * 3, src * 3 + 3);
    centre.copyWithin(dst * 3, src * 3, src * 3 + 3);
    uv[dst * 2] = uv[src * 2];
    uv[dst * 2 + 1] = MAX_VERTS;
    tval[dst] = MAX_VERTS / VERTS_PER_SEGMENT;
  }

  const indices = new Uint32Array(MAX_VERTS * CIRCLE_POINTS * 6);
  let n = 0;
  for (let j = 0; j < MAX_VERTS; j++) {
    for (let k = 0; k < CIRCLE_POINTS; k++) {
      const a = k + j * ring;
      const b = k + 1 + j * ring;
      const c = k + 1 + (j + 1) * ring;
      const d = k + (j + 1) * ring;
      indices.set([a, b, c, c, d, a], n);
      n += 6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('centre', new THREE.BufferAttribute(centre, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('tval', new THREE.BufferAttribute(tval, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

function buildParticleGeometry(random) {
  const position = new Float32Array(PARTICLE_COUNT * 3);
  const color = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    let p;
    do {
      p = new THREE.Vector3(random.nextDouble() * 2 - 1, random.nextDouble() * 2 - 1, random.nextDouble() * 2 - 1);
    } while (p.lengthSq() > 1);
    p.multiplyScalar(PARTICLE_RADIUS).toArray(position, i * 3);
    const grey = (random.next(128) + 128) / 255;
    color.set([grey, grey, grey], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return geometry;
}

export class SplineEffect extends DemoEffect {
  async load() {
    const [walls, particle, groupLogo, demoLogo] = await Promise.all([
      this.ctx.loadTexture('textures/deferredWalls', { repeat: true }),
      this.ctx.loadTexture('textures/particle'),
      this.ctx.loadTexture('textures/logo_excessprocess'),
      this.ctx.loadTexture('textures/logo_evoiddroid'),
    ]);
    this.groupLogo = groupLogo;
    this.demoLogo = demoLogo;

    // Same seed and call order as the original, so these are the demo's actual splines and stars.
    const random = new DotNetRandom(1339);
    this.tubes = new THREE.Group();
    this.tubes.matrixAutoUpdate = false;
    this.tubeMaterials = COLOURS.map((colour) => new THREE.ShaderMaterial({
      vertexShader: SPLINE_VS,
      fragmentShader: SPLINE_FS,
      side: THREE.BackSide, // XNA CullMode.CullCounterClockwiseFace keeps the opposite winding to GL's default
      uniforms: {
        fT: { value: 0 },
        base_Tex: { value: walls },
        fColour: { value: new THREE.Vector4(...colour) },
        fAmbient: { value: new THREE.Vector3(0, 0, 0) },
        fSpecular: { value: new THREE.Vector3(2, 1.92, 1.44) },
        fDiffuse: { value: new THREE.Vector3(1, 1, 1) },
        fSpecularPower: { value: 256 },
        fLightPosition: { value: new THREE.Vector3(-785, 423, 453) },
      },
    }));
    for (let i = 0; i < SPLINE_COUNT; i++) {
      const mesh = new THREE.Mesh(buildTubeGeometry(random), this.tubeMaterials[i]);
      mesh.frustumCulled = false;
      this.tubes.add(mesh);
    }

    this.particles = new THREE.Points(buildParticleGeometry(random), new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      uniforms: { particle_Tex: { value: particle }, fParticleSize: { value: 256 } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }));
    this.particles.matrixAutoUpdate = false;
    this.particles.frustumCulled = false;

    this.scene = new THREE.Scene();
    this.scene.add(this.tubes, this.particles);
    this.camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 1, 1000);
  }

  render(time) {
    const elapsed = time - this.startTime;
    const t = elapsed / 3000;
    const distance = 3 + 2 * t;
    this.camera.position.set(0.4 * distance, 0.2 * distance, distance);
    this.camera.lookAt(0.4 * distance, 0.2 * distance, 0);

    this.tubes.matrix.copy(xnaAxisAngle(ROTATION_AXIS, t * 0.25));
    this.particles.matrix.copy(xnaAxisAngle(ROTATION_AXIS, t * 0.0625));
    for (const mat of this.tubeMaterials) {
      mat.uniforms.fT.value = elapsed * 0.007;
    }
    this.ctx.renderScene(this.scene, this.camera);

    const rect = { x: WIDTH / 4, y: (3 * HEIGHT) / 8, w: WIDTH / 2, h: HEIGHT / 4 };
    this.ctx.drawSprite(this.demoLogo, rect, [1, 1, 1, clamp01((elapsed - DEMO_LOGO_IN) / LOGO_FADE)]);
    this.ctx.drawSprite(this.groupLogo, rect, [1, 1, 1, clamp01((elapsed - GROUP_LOGO_IN) / LOGO_FADE)]);
  }
}
