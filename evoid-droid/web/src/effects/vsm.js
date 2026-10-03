// Port of Demo.VSM (the static Demo.vsm): variance shadow maps from a perspective spot light whose
// "lightmap" cookie is projected onto the scene. Technique names follow Content/Effects/vsm.xnb
// (writedepth, writedepth_skin, vsm, vsm_skin, skin_noshadows); the GLSL bodies are reconstructions.
import * as THREE from 'three';
import { SKINNING_GLSL } from '../modelLoader.js';

const SHADOW_SIZE = 512;
// ponytail: depth normalisation and light levels are guesses; the shader's constants were not recoverable
const DEPTH_RANGE = 200;
const AMBIENT = 0.18;
const LIGHT = 1.0;
const SPECULAR = 0.35;

const VS = /* glsl */ `
  #ifdef SKINNED
  ${SKINNING_GLSL}
  #endif
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vViewDepth;
  void main() {
    vec4 p = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef SKINNED
    mat4 skin = skinMatrix();
    p = skin * p;
    n = mat3(skin) * n;
    #endif
    vec4 world = modelMatrix * p;
    vWorldPos = world.xyz;
    vNormal = mat3(modelMatrix) * n;
    #ifdef HAS_UV
    vUv = vec2(uv.x, 1.0 - uv.y); // XNA UVs start at the image top; loadTexture flips Y
    #else
    vUv = vec2(0.0);
    #endif
    vec4 view = viewMatrix * world;
    vViewDepth = -view.z;
    gl_Position = projectionMatrix * view;
  }`;

const DEPTH_FS = /* glsl */ `
  uniform vec3 lightPos;
  varying vec3 vWorldPos;
  void main() {
    float d = length(vWorldPos - lightPos) / ${DEPTH_RANGE.toFixed(1)};
    gl_FragColor = vec4(d, d * d, 0.0, 1.0);
  }`;

const LIT_FS = /* glsl */ `
  uniform sampler2D tdiffuse;
  uniform sampler2D shadowmap;
  uniform sampler2D lightmap;
  uniform mat4 lightViewProj;
  uniform vec3 lightPos;
  uniform vec3 campos;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vViewDepth;

  float chebyshev(vec2 moments, float d) {
    if (d <= moments.x) {
      return 1.0;
    }
    float variance = max(moments.y - moments.x * moments.x, 0.00002);
    float delta = d - moments.x;
    return smoothstep(0.2, 1.0, variance / (variance + delta * delta));
  }

  void main() {
    vec3 n = normalize(vNormal);
    vec3 toLight = lightPos - vWorldPos;
    float dist = length(toLight);
    vec3 l = toLight / dist;
    vec4 lp = lightViewProj * vec4(vWorldPos, 1.0);
    vec2 luv = lp.xy / lp.w * 0.5 + 0.5;
    float cookie = lp.w > 0.0 ? texture2D(lightmap, luv).r : 0.0;
    float shadow = 1.0;
    #ifdef SHADOWS
    shadow = chebyshev(texture2D(shadowmap, luv).rg, dist / ${DEPTH_RANGE.toFixed(1)});
    #endif
    float diffuse = max(dot(n, l), 0.0);
    vec3 v = normalize(campos - vWorldPos);
    float spec = pow(max(dot(reflect(-l, n), v), 0.0), 32.0);
    #ifdef NO_DIFFUSE_TEXTURE
    vec3 albedo = vec3(0.0);
    #else
    vec3 albedo = texture2D(tdiffuse, vUv).rgb;
    #endif
    float lit = cookie * shadow;
    vec3 color = albedo * (${AMBIENT.toFixed(2)} + ${LIGHT.toFixed(2)} * diffuse * lit) + ${SPECULAR.toFixed(2)} * spec * lit;
    gl_FragColor = vec4(color, vViewDepth); // alpha carries view depth for FullScreen's depth of field
  }`;

// Original blur: 4 diagonal + 4 axis taps at 1.1 texels (pixel shader constants 0..3) around the centre.
const BLUR_FS = /* glsl */ `
  uniform sampler2D map;
  uniform vec2 texel;
  varying vec2 vUv;
  void main() {
    vec2 o = texel * 1.1;
    vec4 c = texture2D(map, vUv);
    c += texture2D(map, vUv + vec2(-o.x, -o.y)) + texture2D(map, vUv + vec2(o.x, o.y));
    c += texture2D(map, vUv + vec2(-o.x, o.y)) + texture2D(map, vUv + vec2(o.x, -o.y));
    c += texture2D(map, vUv + vec2(-o.x, 0.0)) + texture2D(map, vUv + vec2(o.x, 0.0));
    c += texture2D(map, vUv + vec2(0.0, -o.y)) + texture2D(map, vUv + vec2(0.0, o.y));
    gl_FragColor = c / 9.0;
  }`;

function createShadowTarget() {
  return new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer: true,
  });
}

/** Matrix.CreateLookAt(pos, target, Vector3.Up) applied to a three.js camera. */
export function pointCamera(camera, pos, target) {
  camera.position.copy(pos);
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
}

class VSM {
  constructor(ctx) {
    this.ctx = ctx;
    this.shadowmap = createShadowTarget();
    this.bshadowmap = createShadowTarget();
    this.lightCamera = new THREE.PerspectiveCamera(60, 1, 1, 10000);
    this.uniforms = {
      lightPos: { value: new THREE.Vector3() },
      lightViewProj: { value: new THREE.Matrix4() },
      campos: { value: new THREE.Vector3() },
      shadowmap: { value: this.bshadowmap.texture },
      lightmap: { value: null },
    };
    this.blur = ctx.createQuadMaterial(BLUR_FS, { map: { value: null }, texel: { value: new THREE.Vector2(1 / SHADOW_SIZE, 1 / SHADOW_SIZE) } });
  }

  async load() {
    this.lightmapPromise ??= this.ctx.loadTexture('textures/lightmap').then((tex) => {
      this.uniforms.lightmap.value = tex;
    });
    await this.lightmapPromise;
  }

  /** Original converts degrees with pi = 3.1415 and uses a square frustum. */
  setLight(pos, target, fovDegrees) {
    const cam = this.lightCamera;
    cam.fov = THREE.MathUtils.radToDeg((fovDegrees * 3.1415) / 180);
    pointCamera(cam, pos, target);
    this.uniforms.lightPos.value.copy(pos);
    this.uniforms.lightViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }

  /**
   * SetCamera(view, proj) takes `campos` from the view matrix's translation row (M41..M43), which is
   * not the eye position; kept for fidelity since it only steers the specular highlight.
   */
  setCamera(camera) {
    const e = camera.matrixWorldInverse.elements;
    this.uniforms.campos.value.set(e[12], e[13], e[14]);
  }

  /** BeginDepth + draw + EndDepth: render light-space moments, then blur three times. */
  renderDepth(scene) {
    const { renderer } = this.ctx;
    renderer.setRenderTarget(this.shadowmap);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    if (scene) {
      renderer.render(scene, this.lightCamera);
    }
    this.blurInto(this.shadowmap, this.bshadowmap);
    this.blurInto(this.bshadowmap, this.shadowmap);
    this.blurInto(this.shadowmap, this.bshadowmap);
  }

  blurInto(src, dst) {
    this.blur.uniforms.map.value = src.texture;
    this.ctx.drawQuad(this.blur, dst);
  }

  /**
   * @param {'writedepth'|'vsm'|'skin_noshadows'} technique
   * @param {{skinned?: boolean, maxBones?: number, bones?: {value: Float32Array}, map?: THREE.Texture|null,
   *          hasUv?: boolean, side?: THREE.Side}} options
   */
  createMaterial(technique, { skinned = false, maxBones = 1, bones = null, map = null, hasUv = true, side = THREE.BackSide } = {}) {
    const defines = {};
    if (skinned) {
      defines.SKINNED = '';
      defines.MAX_BONES = maxBones;
    }
    if (hasUv) {
      defines.HAS_UV = '';
    }
    if (technique === 'vsm') {
      defines.SHADOWS = '';
    }
    if (technique !== 'writedepth' && !map) {
      defines.NO_DIFFUSE_TEXTURE = '';
    }
    const uniforms = {
      ...this.uniforms,
      tdiffuse: { value: map },
      ...(skinned ? { bones } : {}),
    };
    return new THREE.ShaderMaterial({
      defines,
      uniforms,
      vertexShader: VS,
      fragmentShader: technique === 'writedepth' ? DEPTH_FS : LIT_FS,
      side,
    });
  }
}

let shared = null;

/** The demo keeps one VSM for all scenes (Demo.vsm). */
export function getVSM(ctx) {
  shared ??= new VSM(ctx);
  return shared;
}
