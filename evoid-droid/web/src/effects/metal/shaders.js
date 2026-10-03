// GLSL reconstructions of the shaders LiquidBoidScene uses. Parameter names follow the .xnb
// parameter tables; bodies are inferred from how the C# drives them.

/** Linear view depth is stored scaled into [0, 1]-ish, matching fMaxDepthDiff = 0.03 being "close". */
export const DEPTH_SCALE = 0.1;

// DeferData.fx — RenderPosition / RenderNormal (G-buffer passes over the boid spheres).
export const DEFER_VS = /* glsl */ `
  varying vec3 vViewNormal;
  varying float vDepth;
  void main() {
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vViewNormal = normalize(mat3(modelViewMatrix * instanceMatrix) * normal);
    vDepth = -mv.z * ${DEPTH_SCALE};
    gl_Position = projectionMatrix * mv;
  }`;

export const RENDER_POSITION_FS = /* glsl */ `
  varying float vDepth;
  void main() { gl_FragColor = vec4(vDepth, vDepth, vDepth, 1.0); }`;

export const RENDER_NORMAL_FS = /* glsl */ `
  varying vec3 vViewNormal;
  void main() { gl_FragColor = vec4(normalize(vViewNormal) * 0.5 + 0.5, 1.0); }`;

// Blur.fx — BlurHorizontal/Vertical and the depth-aware BlurSameDepth* variants.
export const BLUR_FS = /* glsl */ `
  uniform sampler2D base_Tex;
  uniform sampler2D depth_Tex;
  uniform vec2 fViewportDimensions;
  uniform float fBlurriness;
  uniform float fMaxDepthDiff;
  uniform vec2 uDirection;
  uniform bool uSameDepth;
  varying vec2 vUv;
  const float WEIGHTS[4] = float[4](0.2270, 0.1945, 0.1216, 0.0541);
  void main() {
    float centreDepth = texture2D(depth_Tex, vUv).r;
    vec2 stepUv = uDirection * fBlurriness / fViewportDimensions;
    vec4 sum = vec4(0.0);
    float total = 0.0;
    for (int i = -3; i <= 3; i++) {
      vec2 uv = vUv + stepUv * float(i);
      float w = WEIGHTS[abs(i)];
      if (uSameDepth && abs(texture2D(depth_Tex, uv).r - centreDepth) > fMaxDepthDiff) {
        w = 0.0;
      }
      sum += texture2D(base_Tex, uv) * w;
      total += w;
    }
    gl_FragColor = sum / max(total, 1e-4);
  }`;

// DeferredLighting.fx — EnvLights: mirror reflection of the environment cube map.
export const ENV_LIGHTS_FS = /* glsl */ `
  uniform sampler2D normal_Tex;
  uniform sampler2D position_Tex;
  uniform samplerCube env_Tex;
  uniform mat4 matViewInverse;
  uniform mat4 uProjectionInverse;
  uniform vec3 fColour;
  varying vec2 vUv;
  void main() {
    vec4 position = texture2D(position_Tex, vUv);
    if (position.a < 0.5) {
      discard;
    }
    vec3 n = normalize(texture2D(normal_Tex, vUv).xyz * 2.0 - 1.0);
    // ponytail: view ray rebuilt from the projection; the original only had the G-buffer to go on
    vec4 farPoint = uProjectionInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 viewRay = normalize(farPoint.xyz / farPoint.w);
    vec3 r = reflect(viewRay, n);
    vec3 worldR = (matViewInverse * vec4(r, 0.0)).xyz;
    gl_FragColor = vec4(textureCube(env_Tex, worldR).rgb * fColour, 1.0);
  }`;

// Cubes.fx (technique "Spline") — bump-mapped, cube-map-reflective floor, lit in view space.
export const FLOOR_VS = /* glsl */ `
  attribute vec3 tangent;
  attribute vec3 binormal;
  varying vec2 vUv;
  varying vec3 vViewPos;
  varying mat3 vTbn;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    vTbn = mat3(normalize(normalMatrix * tangent), normalize(normalMatrix * binormal), normalize(normalMatrix * normal));
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }`;

export const FLOOR_FS = /* glsl */ `
  uniform sampler2D bump_Tex;
  uniform samplerCube reflection_Tex;
  uniform vec4 fColour;
  uniform vec4 fAmbient;
  uniform vec4 fDiffuse;
  uniform vec4 fSpecular;
  uniform float fSpecularPower;
  uniform vec3 fLightPosition;
  varying vec2 vUv;
  varying vec3 vViewPos;
  varying mat3 vTbn;
  void main() {
    vec3 n = normalize(vTbn * (texture2D(bump_Tex, vUv).xyz * 2.0 - 1.0));
    vec3 v = normalize(vViewPos);
    vec3 l = normalize(fLightPosition - vViewPos);
    float diffuse = max(dot(n, l), 0.0);
    float specular = pow(max(dot(reflect(v, n), l), 0.0), fSpecularPower);
    // The parameter table has no inverse view, so the reflection is looked up in view space.
    vec3 reflection = textureCube(reflection_Tex, reflect(v, n)).rgb;
    vec3 lit = fColour.rgb * (fAmbient.rgb + fDiffuse.rgb * diffuse) + fSpecular.rgb * specular;
    // ponytail: reflection strength guessed; fColour is black so the floor is reflection + highlight
    gl_FragColor = vec4(lit + reflection * 0.5, 1.0);
  }`;

// BasicEffect with EnableDefaultLighting() (XNA's three-light rig), evaluated per pixel.
export const BASIC_VS = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

export const BASIC_FS = /* glsl */ `
  uniform sampler2D map;
  uniform bool hasMap;
  uniform vec3 diffuseColor;
  uniform vec3 specularColor;
  uniform float specularPower;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  const vec3 AMBIENT = vec3(0.05333332, 0.09882354, 0.1819608);
  const vec3 DIRS[3] = vec3[3](vec3(-0.5265408, -0.5735765, -0.6275069), vec3(0.7198464, 0.3420201, 0.6040227), vec3(0.4545195, -0.7660444, 0.4545195));
  const vec3 DIFFUSE[3] = vec3[3](vec3(1.0, 0.9607844, 0.8078432), vec3(0.9647059, 0.7607844, 0.4078432), vec3(0.3231373, 0.3607844, 0.3937255));
  const vec3 SPECULAR[3] = vec3[3](vec3(1.0, 0.9607844, 0.8078432), vec3(0.0), vec3(0.3231373, 0.3607844, 0.3937255));
  void main() {
    vec3 n = normalize(vWorldNormal);
    vec3 toEye = normalize(cameraPosition - vWorldPos);
    vec3 diffuse = vec3(0.0);
    vec3 specular = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      vec3 l = -DIRS[i];
      float ndl = max(dot(n, l), 0.0);
      diffuse += DIFFUSE[i] * ndl;
      specular += SPECULAR[i] * pow(max(dot(normalize(l + toEye), n), 0.0), specularPower) * step(0.0, ndl);
    }
    // XNA UVs have v = 0 at the image top; loadTexture flips Y.
    vec3 base = hasMap ? texture2D(map, vec2(vUv.x, 1.0 - vUv.y)).rgb : vec3(1.0);
    gl_FragColor = vec4(base * diffuseColor * (diffuse + AMBIENT) + specular * specularColor, 1.0);
  }`;
