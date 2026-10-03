// GLSL reconstructions of the liquid scene's effects. Parameter names and defaults come from
// DeferData.xnb, Blur.xnb, DeferredLighting.xnb, Glass.xnb and SkinnedModel.xnb; bodies are rebuilt.
import { SKINNING_GLSL } from '../../modelLoader.js';

/** View depth is stored as -viewZ / DEPTH_SCALE so fMaxDepthDiff (0.03) means 0.3 world units. */
export const DEPTH_SCALE = 10;

// DeferData: RenderPosition / RenderNormal for instanced particle spheres.
const DEFER_VS = /* glsl */ `
  varying vec3 vViewNormal;
  varying float vDepth;
  void main() {
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vViewNormal = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
    vDepth = -mv.z / ${DEPTH_SCALE}.0;
    gl_Position = projectionMatrix * mv;
  }`;

export const DEFER_POSITION = {
  vertexShader: DEFER_VS,
  fragmentShader: /* glsl */ `
    varying float vDepth;
    void main() { gl_FragColor = vec4(vec3(vDepth), 1.0); }`,
};

export const DEFER_NORMAL = {
  vertexShader: DEFER_VS,
  fragmentShader: /* glsl */ `
    varying vec3 vViewNormal;
    void main() { gl_FragColor = vec4(normalize(vViewNormal) * 0.5 + 0.5, 1.0); }`,
};

// Blur: separable, depth-aware (samples whose depth differs by more than fMaxDepthDiff are skipped).
export const BLUR_FS = /* glsl */ `
  uniform sampler2D base_Tex;
  uniform sampler2D depth_Tex;
  uniform vec2 fViewportDimensions;
  uniform float fBlurriness;
  uniform float fMaxDepthDiff;
  uniform vec2 uDirection;
  varying vec2 vUv;
  const float WEIGHTS[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  void main() {
    float centreDepth = texture2D(depth_Tex, vUv).r;
    // ponytail: tap spacing tuned by eye (2 px at viewport scale) so the beads merge into one surface
    vec2 stepUv = uDirection * fBlurriness * 2.0 / fViewportDimensions;
    vec4 sum = texture2D(base_Tex, vUv) * WEIGHTS[0];
    float total = WEIGHTS[0];
    for (int i = 1; i < 5; i++) {
      for (int s = -1; s <= 1; s += 2) {
        vec2 uv = vUv + stepUv * float(i * s);
        if (abs(texture2D(depth_Tex, uv).r - centreDepth) < fMaxDepthDiff) {
          sum += texture2D(base_Tex, uv) * WEIGHTS[i];
          total += WEIGHTS[i];
        }
      }
    }
    gl_FragColor = sum / total;
  }`;

// DeferredLighting / PhongLights: shades the blurred normal + depth buffers as one smooth liquid surface.
export const LIGHTING_FS = /* glsl */ `
  uniform sampler2D normal_Tex;
  uniform sampler2D position_Tex;
  uniform mat4 matView;
  uniform mat4 projectionInverse;
  uniform vec3 fLightDir;
  uniform vec3 fDiffuse;
  uniform vec3 fAmbient;
  uniform vec3 fColour;
  uniform vec3 fSpecular;
  uniform float fSpecularPower;
  varying vec2 vUv;
  void main() {
    float depth = texture2D(position_Tex, vUv).r;
    vec3 encoded = texture2D(normal_Tex, vUv).rgb * 2.0 - 1.0;
    // ponytail: empty pixels hold depth 0 and the grey (zero) normal; clip them instead of a stencil.
    if (depth <= 0.001 || length(encoded) < 0.35) {
      discard;
    }
    vec3 n = normalize(encoded);
    vec4 ray = projectionInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 viewPos = ray.xyz / ray.w;
    viewPos *= (depth * ${DEPTH_SCALE}.0) / -viewPos.z;
    vec3 l = normalize(mat3(matView) * fLightDir);
    vec3 v = normalize(-viewPos);
    float diffuse = max(dot(n, l), 0.0);
    float specular = pow(max(dot(reflect(-l, n), v), 0.0), fSpecularPower);
    gl_FragColor = vec4(fColour * (fAmbient + fDiffuse * diffuse) + fSpecular * specular, 1.0);
  }`;

// Glass: environment reflection + refraction through the cube map rendered from the ball's centre.
export const GLASS = {
  vertexShader: /* glsl */ `
    uniform mat4 matWorldViewInverse;
    uniform mat4 matWorld;
    varying vec3 vReflect;
    varying vec3 vRefract;
    varying float vFresnel;
    void main() {
      vec3 eye = (matWorldViewInverse * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      vec3 n = normalize(position);
      vec3 view = normalize(position - eye);
      float facing = dot(view, n) > 0.0 ? -1.0 : 1.0; // inner faces see the inside of the shell
      n *= facing;
      vReflect = mat3(matWorld) * reflect(view, n);
      vRefract = mat3(matWorld) * refract(view, n, 0.9);
      vFresnel = pow(1.0 - abs(dot(view, n)), 3.0);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform samplerCube env_Tex;
    varying vec3 vReflect;
    varying vec3 vRefract;
    varying float vFresnel;
    void main() {
      vec3 reflected = textureCube(env_Tex, vReflect).rgb;
      vec3 refracted = textureCube(env_Tex, vRefract).rgb;
      // ponytail: blend weights tuned by eye; the original glass pass's render states are unknown
      gl_FragColor = vec4(mix(refracted, reflected, vFresnel), mix(0.25, 0.9, vFresnel));
    }`,
};

// BasicEffect with EnableDefaultLighting (the textured backdrop sphere).
export const BASIC_DEFAULT_LIT = {
  vertexShader: /* glsl */ `
    varying vec3 vWorldNormal;
    varying vec3 vWorldPos;
    varying vec2 vUv;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorldPos = world.xyz;
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
      vUv = uv;
      gl_Position = projectionMatrix * viewMatrix * world;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D map;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPos;
    varying vec2 vUv;
    const vec3 AMBIENT = vec3(0.05333332, 0.09882354, 0.1819608);
    const vec3 DIR[3] = vec3[3](vec3(-0.5265408, -0.5735765, -0.6275069), vec3(0.7198464, 0.3420201, 0.6040227), vec3(0.4545195, -0.7660444, 0.3227891));
    const vec3 DIFF[3] = vec3[3](vec3(1.0, 0.9607844, 0.8078432), vec3(0.9647059, 0.7607844, 0.4078432), vec3(0.3231373, 0.3607844, 0.3937255));
    const vec3 SPEC[3] = vec3[3](vec3(1.0, 0.9607844, 0.8078432), vec3(0.0), vec3(0.3231373, 0.3607844, 0.3937255));
    void main() {
      vec3 n = normalize(vWorldNormal);
      vec3 v = normalize(cameraPosition - vWorldPos);
      vec3 diffuse = AMBIENT;
      vec3 specular = vec3(0.0);
      for (int i = 0; i < 3; i++) {
        vec3 l = -DIR[i];
        diffuse += max(dot(n, l), 0.0) * DIFF[i];
        specular += pow(max(dot(n, normalize(l + v)), 0.0), 16.0) * SPEC[i];
      }
      gl_FragColor = vec4(texture2D(map, vec2(vUv.x, 1.0 - vUv.y)) /* XNA UVs: v=0 at image top */.rgb * diffuse + specular, 1.0);
    }`,
};

// XNA SkinnedModel sample effect (two directional lights + ambient, per-vertex).
export const SKINNED_MODEL = {
  vertexShader: /* glsl */ `
    ${SKINNING_GLSL}
    varying vec2 vUv;
    varying vec3 vLighting;
    const vec3 LIGHT1_DIR = normalize(vec3(1.0, 1.0, -2.0));
    const vec3 LIGHT1_COLOR = vec3(0.9, 0.8, 0.7);
    const vec3 LIGHT2_DIR = normalize(vec3(-1.0, -1.0, 1.0));
    const vec3 LIGHT2_COLOR = vec3(0.1, 0.3, 0.8);
    const vec3 AMBIENT = vec3(0.2);
    void main() {
      mat4 skin = skinMatrix();
      vec4 world = skin * vec4(position, 1.0);
      vec3 n = normalize(mat3(skin) * normal);
      vLighting = clamp(dot(n, -LIGHT1_DIR), 0.0, 1.0) * LIGHT1_COLOR
                + clamp(dot(n, -LIGHT2_DIR), 0.0, 1.0) * LIGHT2_COLOR + AMBIENT;
      vUv = uv;
      gl_Position = projectionMatrix * viewMatrix * world;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D map;
    varying vec2 vUv;
    varying vec3 vLighting;
    void main() {
      vec4 c = texture2D(map, vec2(vUv.x, 1.0 - vUv.y)) /* XNA UVs: v=0 at image top */;
      gl_FragColor = vec4(c.rgb * vLighting, c.a);
    }`,
};
