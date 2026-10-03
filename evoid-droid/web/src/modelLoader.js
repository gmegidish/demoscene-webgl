// Loads models converted by tools/xnb_models.py and ports the XNA SkinnedModel sample's AnimationPlayer.
//
// Matrix convention: XNA matrices are row-major and row-vector (v * M). Their 16 floats read as a
// column-major array ARE the equivalent three.js (column-vector) matrix, so Matrix4.fromArray() needs
// no transpose. XNA `A * B` (apply A, then B) becomes `new Matrix4().multiplyMatrices(B, A)`.
import * as THREE from 'three';

const ASSETS = '../assets/';

/** XNA `a * b`: transform by a, then by b. */
export function xnaMul(a, b) {
  return new THREE.Matrix4().multiplyMatrices(b, a);
}

function attribute(bin, desc, itemSize) {
  const array = desc.type === 'f32'
    ? new Float32Array(bin, desc.offset, desc.count)
    : new Uint32Array(bin, desc.offset, desc.count);
  return new THREE.BufferAttribute(array, itemSize);
}

// Converter attribute names -> three.js attribute names
const ATTRIBUTE_NAMES = {
  position: 'position',
  normal: 'normal',
  uv: 'uv',
  uv1: 'uv',
  blendIndices: 'skinIndex',
  blendWeight: 'skinWeight',
  tangent: 'tangent',
  binormal: 'binormal',
  color: 'color',
};

/**
 * @returns {Promise<{
 *   bones: {name: string, transform: THREE.Matrix4, parent: number}[],
 *   meshes: {name: string, parentBone: number, parts: {geometry: THREE.BufferGeometry, material: object|null}[]}[],
 *   skinning: null | {clips: Object<string, {duration: number, keyframes: [number, number, THREE.Matrix4][]}>,
 *                     bindPose: THREE.Matrix4[], inverseBindPose: THREE.Matrix4[], hierarchy: number[]},
 *   absoluteBoneTransforms: () => THREE.Matrix4[],
 * }>}
 */
export async function loadModel(name) {
  const [json, bin] = await Promise.all([
    fetch(`${ASSETS}models/${name}.json`).then((r) => r.json()),
    fetch(`${ASSETS}models/${name}.bin`).then((r) => r.arrayBuffer()),
  ]);
  const bones = json.bones.map((b) => ({ name: b.name, parent: b.parent, transform: new THREE.Matrix4().fromArray(b.transform) }));
  const meshes = json.meshes.map((mesh) => ({
    name: mesh.name,
    parentBone: mesh.parentBone,
    parts: mesh.parts.map((part) => {
      const geometry = new THREE.BufferGeometry();
      for (const [key, desc] of Object.entries(part.attributes)) {
        geometry.setAttribute(ATTRIBUTE_NAMES[key] ?? key, attribute(bin, desc, part.sizes[key]));
      }
      geometry.setIndex(attribute(bin, part.indices, 1));
      return { geometry, material: part.material };
    }),
  }));
  const s = json.skinning;
  const skinning = s && {
    clips: Object.fromEntries(Object.entries(s.clips).map(([clipName, clip]) => [clipName, {
      duration: clip.duration,
      keyframes: clip.keyframes.map(([bone, time, m]) => [bone, time, new THREE.Matrix4().fromArray(m)]),
    }])),
    bindPose: s.bindPose.map((m) => new THREE.Matrix4().fromArray(m)),
    inverseBindPose: s.inverseBindPose.map((m) => new THREE.Matrix4().fromArray(m)),
    hierarchy: s.hierarchy,
  };
  /** Model.CopyAbsoluteBoneTransformsTo */
  function absoluteBoneTransforms() {
    const out = [];
    bones.forEach((bone, i) => {
      out[i] = bone.parent >= 0 ? xnaMul(bone.transform, out[bone.parent]) : bone.transform.clone();
    });
    return out;
  }
  return { bones, meshes, skinning, absoluteBoneTransforms };
}

/**
 * Texture referenced by a BasicEffect ("claws2.fbm\\Box87CompleteMap~0") or a SkinnedModel
 * EffectMaterial ({parameters: {Texture: {external: "..."}}}), resolved to the converted PNG name.
 */
export function materialTextureName(modelName, material) {
  const ref = material?.texture || material?.parameters?.Texture?.external;
  if (!ref) {
    return null;
  }
  const file = ref.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
  const folder = ref.includes('.fbm') ? ref.replace(/\\/g, '/').split('/').slice(-2, -1)[0] : `${modelName}.fbm`;
  return `Models/${folder}/${file}`;
}

/** Port of SkinnedModel.AnimationPlayer. Times are in seconds. */
export class AnimationPlayer {
  constructor(skinning) {
    this.skinning = skinning;
    const n = skinning.bindPose.length;
    this.boneTransforms = Array.from({ length: n }, () => new THREE.Matrix4());
    this.worldTransforms = Array.from({ length: n }, () => new THREE.Matrix4());
    this.skinTransforms = Array.from({ length: n }, () => new THREE.Matrix4());
    /** Packed skin matrices, ready for a `uniform mat4 bones[N]`. */
    this.skinArray = new Float32Array(n * 16);
    this.clip = null;
  }

  startClip(clip) {
    this.clip = clip;
    this.currentTime = 0;
    this.currentKeyframe = 0;
    this.skinning.bindPose.forEach((m, i) => this.boneTransforms[i].copy(m));
  }

  update(time, relativeToCurrentTime, rootTransform) {
    this.updateBoneTransforms(time, relativeToCurrentTime);
    this.updateWorldTransforms(rootTransform);
    this.updateSkinTransforms();
  }

  updateBoneTransforms(time, relativeToCurrentTime) {
    const { duration, keyframes } = this.clip;
    let t = time;
    if (relativeToCurrentTime) {
      t += this.currentTime;
      while (t >= duration) {
        t -= duration;
      }
    }
    if (t >= duration) {
      t = duration - 0.001;
    }
    t = Math.max(0, t);
    if (t < this.currentTime) {
      this.currentKeyframe = 0;
      this.skinning.bindPose.forEach((m, i) => this.boneTransforms[i].copy(m));
    }
    this.currentTime = t;
    while (this.currentKeyframe < keyframes.length) {
      const [bone, keyTime, transform] = keyframes[this.currentKeyframe];
      if (keyTime > t) {
        break;
      }
      this.boneTransforms[bone].copy(transform);
      this.currentKeyframe++;
    }
  }

  updateWorldTransforms(rootTransform) {
    const { hierarchy } = this.skinning;
    this.worldTransforms[0].multiplyMatrices(rootTransform, this.boneTransforms[0]);
    for (let i = 1; i < this.worldTransforms.length; i++) {
      this.worldTransforms[i].multiplyMatrices(this.worldTransforms[hierarchy[i]], this.boneTransforms[i]);
    }
  }

  updateSkinTransforms() {
    const { inverseBindPose } = this.skinning;
    for (let i = 0; i < this.skinTransforms.length; i++) {
      this.skinTransforms[i].multiplyMatrices(this.worldTransforms[i], inverseBindPose[i]);
      this.skinTransforms[i].toArray(this.skinArray, i * 16);
    }
  }
}

/**
 * GLSL for SkinnedModel-style 4-bone skinning. Declare `uniform mat4 bones[MAX_BONES]` via the
 * define, then call `skinMatrix()` in the vertex shader; position/normal are in model space.
 */
export const SKINNING_GLSL = /* glsl */ `
  attribute vec4 skinIndex;
  attribute vec4 skinWeight;
  uniform mat4 bones[MAX_BONES];
  mat4 skinMatrix() {
    return bones[int(skinIndex.x)] * skinWeight.x + bones[int(skinIndex.y)] * skinWeight.y
         + bones[int(skinIndex.z)] * skinWeight.z + bones[int(skinIndex.w)] * skinWeight.w;
  }`;
