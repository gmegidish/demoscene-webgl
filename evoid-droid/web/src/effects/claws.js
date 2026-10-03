// Port of Demo.EigilScene ("claws"): the claws2 model with three swinging bones, lit like XNA's
// BasicEffect.EnableDefaultLighting(), seen from the Demo.Camera rigs (spline / manual + shake).
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT } from '../engine.js';
import { loadModel, materialTextureName, xnaMul } from '../modelLoader.js';

const ANIMATED_BONES = ['Box11', 'Mesh09', 'ChamferCyl02'];
const ORBIT_RADIUS = 2000;

// BasicEffect.EnableDefaultLighting() rig (world-space directions the light travels).
const LIGHT_DIRS = [
  [-0.5265408, -0.5735765, -0.6275069],
  [0.7198464, 0.3420201, 0.6040227],
  [0.4545195, -0.7660444, 0.4545195],
];
const LIGHT_DIFFUSE = [[1, 0.9607844, 0.8078432], [0.9647059, 0.7607844, 0.4078432], [0.3231373, 0.3607844, 0.3937255]];
const LIGHT_SPECULAR = [[1, 0.9607844, 0.8078432], [0, 0, 0], [0.3231373, 0.3607844, 0.3937255]];
const AMBIENT = [0.05333332, 0.09882354, 0.1819608];

// XNA 1.x BasicEffect lights per vertex; the pixel shader just modulates the texture.
const BASIC_VS = /* glsl */ `
  uniform vec3 diffuseColor;
  uniform vec3 emissiveColor;
  uniform vec3 specularColor;
  uniform float specularPower;
  uniform vec3 lightDir[3];
  uniform vec3 lightDiffuse[3];
  uniform vec3 lightSpecular[3];
  uniform vec3 ambient;
  varying vec3 vDiffuse;
  varying vec3 vSpecular;
  varying vec2 vUv;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * normal);
    vec3 eye = normalize(cameraPosition - world.xyz);
    vec3 diffuse = vec3(0.0);
    vec3 specular = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      vec3 l = -lightDir[i];
      float ndl = max(dot(n, l), 0.0);
      diffuse += lightDiffuse[i] * ndl;
      specular += lightSpecular[i] * (ndl > 0.0 ? pow(max(dot(n, normalize(l + eye)), 0.0), specularPower) : 0.0);
    }
    vDiffuse = diffuse * diffuseColor + emissiveColor + ambient * diffuseColor;
    vSpecular = specular * specularColor;
    vUv = vec2(uv.x, 1.0 - uv.y); // XNA v=0 is the image top
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const BASIC_FS = /* glsl */ `
  uniform sampler2D map;
  varying vec3 vDiffuse;
  varying vec3 vSpecular;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(map, vUv).rgb * vDiffuse + vSpecular, 1.0);
  }`;

function toVec3s(list) {
  return list.map((v) => new THREE.Vector3(...v));
}

/** BasicEffect with default lighting and TextureEnabled = true. */
export function createBasicEffectMaterial(material, texture, side = THREE.FrontSide) {
  return new THREE.ShaderMaterial({
    vertexShader: BASIC_VS,
    fragmentShader: BASIC_FS,
    side,
    uniforms: {
      map: { value: texture },
      diffuseColor: { value: new THREE.Vector3(...material.diffuse) },
      emissiveColor: { value: new THREE.Vector3(...material.emissive) },
      specularColor: { value: new THREE.Vector3(...material.specular) },
      specularPower: { value: material.specularPower },
      lightDir: { value: toVec3s(LIGHT_DIRS) },
      lightDiffuse: { value: toVec3s(LIGHT_DIFFUSE) },
      lightSpecular: { value: toVec3s(LIGHT_SPECULAR) },
      ambient: { value: new THREE.Vector3(...AMBIENT) },
    },
  });
}

function catmullRom(p1, p2, p3, p4, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p2 + (p3 - p1) * t + (2 * p1 - 5 * p2 + 4 * p3 - p4) * t2 + (3 * p2 - p1 - 3 * p3 + p4) * t3);
}

/** Demo.Spline.getValue: closed Catmull-Rom through the points, f in [0,1) per loop. */
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

/** Port of Demo.Camera (Target mode without target spline = look at origin; Manual = pos/target set externally). */
export class DemoCamera {
  constructor({ positions = [], manual = false, speed = 1, isLooping = false, shakeAmplitude = 1, shakeSpeed = 1 } = {}) {
    this.positions = positions.map((p) => new THREE.Vector3(...p));
    this.manual = manual;
    this.speed = speed;
    this.isLooping = isLooping;
    this.shakeAmplitude = shakeAmplitude;
    this.shakeSpeed = shakeSpeed;
    this.reset();
  }

  reset() {
    this.isShaking = false;
    this.pos = new THREE.Vector3(0, 0, 1);
    this.target = new THREE.Vector3();
  }

  init(time) {
    this.startTime = time;
    this.pos = new THREE.Vector3(0, 0, 1);
    this.target = new THREE.Vector3();
  }

  startShake(time) {
    this.startShakeTime = time;
    this.isShaking = true;
  }

  shakeOffset(time) {
    if (!this.isShaking) {
      return 0;
    }
    const s = Math.min(1, ((time - this.startShakeTime) / 1000) * this.shakeSpeed);
    return Math.cos(s * 5 * Math.PI * 2) * (1 - s * s) * this.shakeAmplitude;
  }

  /** Positions `camera` like Matrix.CreateLookAt(pos, target, Up) with M42 += shake. */
  apply(camera, time) {
    let t = ((time - this.startTime) / 1000) * this.speed;
    if (!this.isLooping && t > 1) {
      t = 1;
    }
    if (!this.manual) {
      this.pos = this.positions.length > 0 ? splineValue(this.positions, t) : new THREE.Vector3(0, 0, -1);
      this.target = new THREE.Vector3();
    }
    camera.position.copy(this.pos);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.target);
    camera.updateMatrix(); // matrixAutoUpdate is off so the shaken matrixWorld below survives render()
    const view = camera.matrix.clone().invert();
    view.elements[13] += this.shakeOffset(time);
    camera.matrixWorld.copy(view.invert());
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  }
}

function scaled(points, k) {
  return points.map(([x, y, z]) => [x * k, y * k, z * k]);
}

/** TextureEnabled with no texture bound: D3D samples zero, leaving only specular highlights. */
function blackTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

function rotationZ(angle) {
  return new THREE.Matrix4().makeRotationZ(angle);
}

class ClawsEffect extends DemoEffect {
  async load() {
    this.model = await loadModel('claws2');
    this.originalTransforms = this.model.bones.map((b) => b.transform.clone());
    this.animatedBones = ANIMATED_BONES.map((name) => {
      const index = this.model.bones.findIndex((b) => b.name === name);
      if (index < 0) {
        throw new Error(`bone not found: ${name}`);
      }
      return index;
    });

    this.scene = new THREE.Scene();
    this.meshes = [];
    const black = blackTexture();
    for (const mesh of this.model.meshes) {
      for (const part of mesh.parts) {
        const textureName = materialTextureName('claws2', part.material);
        const texture = textureName ? await this.ctx.loadTexture(textureName, { repeat: true }) : black;
        // XNA CullCounterClockwiseFace; the model's outward faces wind clockwise, i.e. GL back faces.
        const object = new THREE.Mesh(part.geometry, createBasicEffectMaterial(part.material, texture, THREE.BackSide));
        object.matrixAutoUpdate = false;
        object.frustumCulled = false;
        object.userData.parentBone = mesh.parentBone;
        this.scene.add(object);
        this.meshes.push(object);
      }
    }

    this.camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 1, 10000);
    this.camera.matrixAutoUpdate = false;
    this.cams = [
      new DemoCamera({
        positions: scaled([[0, 0, -1000], [500, 0, -500], [-100, 100, -700], [200, 200, -200], [0, 100, -200], [0, 0, -200]], 2),
        speed: 0.05, isLooping: true, shakeAmplitude: 30, shakeSpeed: 1.2,
      }),
      new DemoCamera({ manual: true, shakeAmplitude: 30, shakeSpeed: 1.8 }),
      new DemoCamera({ manual: true, shakeAmplitude: 30, shakeSpeed: 1.8 }),
      new DemoCamera({
        positions: scaled([[0, -400, -100], [200, -400, -500], [100, -600, -700], [0, -400, -400], [400, -400, -600],
          [0, -600, 200], [300, -800, 400], [200, -1200, 0]], 3),
        speed: 0.05, isLooping: true, shakeAmplitude: 30, shakeSpeed: 1.2,
      }),
    ];
    this.currentCam = this.cams[0];
  }

  reset() {
    super.reset();
    for (const cam of this.cams ?? []) {
      cam.reset();
    }
    if (this.cams) {
      this.currentCam = this.cams[0];
    }
  }

  init(time) {
    super.init(time);
    for (const cam of this.cams) {
      cam.init(time);
    }
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    switch (ev.type) {
      case 'ShakeStart':
        this.currentCam.startShake(ev.time);
        break;
      case 'SelectCamera':
        this.currentCam = this.cams[Math.trunc(ev.p[0])];
        break;
      case 'InitCamera':
        this.currentCam.init(ev.time);
        break;
    }
  }

  animateBones(t) {
    const swings = [Math.sin(t * 2), Math.cos(t * 5), Math.cos(t * 2 + Math.PI / 4)];
    this.animatedBones.forEach((bone, i) => {
      this.model.bones[bone].transform = xnaMul(rotationZ(swings[i] * 0.6), this.originalTransforms[bone]);
    });
  }

  updateCameras(t) {
    const r = ORBIT_RADIUS;
    this.cams[1].pos = new THREE.Vector3(Math.sin(t) * r, r / 8 + Math.sin(t) * r * 0.4, Math.cos(t) * r);
    this.cams[1].target = new THREE.Vector3(0, -300, 0);
    this.cams[2].pos = new THREE.Vector3(Math.sin(t) * r, r / 4 + Math.sin(t) * r * 0.5, Math.cos(t) * r);
  }

  render(time) {
    const t = ((time - this.startTime) / 1000) * 0.4;
    this.animateBones(t);
    this.updateCameras(t);
    this.currentCam.apply(this.camera, time);
    const absolute = this.model.absoluteBoneTransforms();
    for (const object of this.meshes) {
      object.matrix.copy(absolute[object.userData.parentBone]);
      object.matrixWorld.copy(object.matrix);
    }
    this.ctx.renderScene(this.scene, this.camera);
  }
}

export default (ctx) => new ClawsEffect(ctx);
