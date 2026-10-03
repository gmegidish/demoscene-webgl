// Port of Demo.RobotScene: the skinned robot running down five tunnel segments, lit by a VSM spot light
// that follows it, rendered through FullScreen (HDR tonemap + depth of field) with five manual cameras.
import * as THREE from 'three';
import { DemoEffect, WIDTH, HEIGHT } from '../engine.js';
import { loadModel, materialTextureName, AnimationPlayer } from '../modelLoader.js';
import { getVSM, pointCamera } from './vsm.js';
import { getFullScreen, DOF, TONEMAPPING } from './fullscreen.js';

const TUNNEL_SEGMENT = 111.83;
const TUNNEL_COPIES = 5;
const RUN_SPEED = 20; // units per second along +Z
const START_POS = new THREE.Vector3(0, -2.7, 0);
const LIGHT_FOV = 60;

const State = { Standing: 0, Running: 1, Jumping: 2, Slamming: 3 };

function smoothStep(a, b, t) {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return a + (b - a) * x * x * (3 - 2 * x);
}

function smoothStepVec(a, b, t) {
  return new THREE.Vector3(smoothStep(a.x, b.x, t), smoothStep(a.y, b.y, t), smoothStep(a.z, b.z, t));
}

function placed(mesh, matrix) {
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix);
  mesh.matrixWorldNeedsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

/** One THREE.Mesh per model part, all sharing `materialFor(part)`. */
function partMeshes(model, materialFor, meshFilter = () => true) {
  return model.meshes.filter(meshFilter).flatMap((mesh) => mesh.parts.map((part) => new THREE.Mesh(part.geometry, materialFor(part))));
}

class RobotScene extends DemoEffect {
  constructor(ctx) {
    super(ctx);
    this.cams = Array.from({ length: 5 }, () => ({ pos: new THREE.Vector3(0, 0, 1), target: new THREE.Vector3() }));
    this.currentCam = 1;
    this.state = State.Standing;
    this.robotPos = START_POS.clone();
    this.animTime = 0;
  }

  async load() {
    const ctx = this.ctx;
    this.vsm = getVSM(ctx);
    this.fs = getFullScreen(ctx);
    const [robot, tunnel] = await Promise.all([loadModel('robotanim'), loadModel('tunnel'), this.vsm.load()]);
    this.player = new AnimationPlayer(robot.skinning);
    this.player.startClip(robot.skinning.clips['Take 001']);
    this.bones = { value: this.player.skinArray };
    const maxBones = robot.skinning.bindPose.length;

    const robotTex = await ctx.loadTexture(materialTextureName('robotanim', robot.meshes[0].parts[0].material));
    const tunnelTextures = new Map();
    for (const mesh of tunnel.meshes.slice(1)) {
      for (const part of mesh.parts) {
        tunnelTextures.set(part, await ctx.loadTexture(materialTextureName('tunnel', part.material), { repeat: true }));
      }
    }

    const vsm = this.vsm;
    const skin = { skinned: true, maxBones, bones: this.bones };
    this.depthScene = new THREE.Scene();
    this.colorScene = new THREE.Scene();
    const robotDepth = partMeshes(robot, () => vsm.createMaterial('writedepth', skin));
    const robotColor = partMeshes(robot, () => vsm.createMaterial('vsm', { ...skin, map: robotTex }));
    this.robotMeshes = [...robotDepth, ...robotColor];
    this.depthScene.add(...robotDepth);
    this.colorScene.add(...robotColor);

    // The original skips tunnel mesh 0 (a stray pipe) and ignores bone transforms: world = translation only.
    const isTunnelBody = (mesh) => mesh !== tunnel.meshes[0];
    for (let i = 0; i < TUNNEL_COPIES; i++) {
      const world = new THREE.Matrix4().makeTranslation(0, 0, TUNNEL_SEGMENT * i);
      const depthMat = vsm.createMaterial('writedepth');
      partMeshes(tunnel, () => depthMat, isTunnelBody).forEach((m) => this.depthScene.add(placed(m, world)));
      partMeshes(tunnel, (part) => vsm.createMaterial('vsm', { map: tunnelTextures.get(part) }), isTunnelBody)
        .forEach((m) => this.colorScene.add(placed(m, world)));
    }

    this.camera = new THREE.PerspectiveCamera(90, WIDTH / HEIGHT, 0.1, 1000);
  }

  reset() {
    super.reset();
    this.state = State.Standing;
    this.currentCam = 1;
  }

  init(time) {
    super.init(time);
    this.lastTime = time;
    this.animTime = 0;
    this.robotPos = START_POS.clone();
  }

  handleEvent(ev) {
    super.handleEvent(ev);
    switch (ev.type) {
      case 'RobotAnim':
        this.state = ev.p[0];
        break;
      case 'SelectCamera':
        this.currentCam = ev.p[0];
        break;
    }
  }

  /** Port of the animTime state machine (milliseconds). */
  advanceAnimation(dt) {
    switch (this.state) {
      case State.Running:
        this.animTime += dt;
        if (this.animTime > 1000) {
          this.animTime -= 1000;
        }
        break;
      case State.Standing:
        this.animTime = 0;
        break;
      case State.Jumping:
        this.animTime += dt;
        if (this.animTime > 292 && this.animTime < 1083) {
          this.animTime += 791;
        }
        if (this.animTime > 1708) {
          this.animTime -= 1408;
          this.state = State.Running;
        }
        break;
      case State.Slamming:
        this.animTime += dt;
        if (this.animTime > 292 && this.animTime < 1083) {
          this.animTime += 791;
        }
        if (this.animTime > 2500) {
          this.animTime = 2500;
        }
        break;
    }
  }

  updateCameras(t) {
    const p = this.robotPos;
    const off = (x, y, z) => p.clone().add(new THREE.Vector3(x, y, z));
    const c = this.cams;
    c[0].pos = off(0, -2, 5);
    c[0].target = off(0, 2, 0);
    c[1].pos = new THREE.Vector3(3, -2, 66);
    c[1].target = off(0, 5, 1);
    c[2].pos = smoothStepVec(new THREE.Vector3(0, 0, 100), off(0, 0, 6), t * 0.1);
    c[2].target = off(0, 3, 0);
    c[3].pos = off(0, 3, -4);
    c[3].target = off(0, 2, 0);
    c[4].pos = off(Math.sin(t * 1.4) * 2, 3 + Math.sin(t + 0.3) * 3, 7);
    c[4].target = off(0, 1, 0);
  }

  render(time) {
    const t = ((time - this.startTime) / 1000) * this.speed;
    const dt = time - this.lastTime;
    this.lastTime = time;
    this.advanceAnimation(dt);
    this.player.update(this.animTime / 1000, false, new THREE.Matrix4());
    if (this.state !== State.Standing) {
      this.robotPos.z += RUN_SPEED * 0.001 * dt;
    }
    this.updateCameras(t);

    const robotWorld = new THREE.Matrix4().makeTranslation(this.robotPos.x, this.robotPos.y, this.robotPos.z);
    this.robotMeshes.forEach((m) => placed(m, robotWorld));

    const cam = this.cams[this.currentCam];
    pointCamera(this.camera, cam.pos, cam.target);
    const focus = cam.target.distanceTo(cam.pos);
    this.fs.setFocus(focus, focus);
    this.fs.setFlags(DOF | TONEMAPPING);
    this.vsm.setLight(this.robotPos.clone().add(new THREE.Vector3(5, 4, 5)), this.robotPos, LIGHT_FOV);
    this.vsm.setCamera(this.camera);

    this.vsm.renderDepth(this.depthScene);
    const target = this.fs.beginFrame();
    this.ctx.renderer.setRenderTarget(target);
    this.ctx.renderer.render(this.colorScene, this.camera);
    this.fs.endFrame();
  }
}

export default (ctx) => new RobotScene(ctx);
