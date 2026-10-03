// Port of LiquidBoidScene's 2D boid flock (updateBoids) and its "EXP" letter obstacles.
import { DotNetRandom } from '../../dotnetRandom.js';

export const BOID_COUNT = 300;
const SEED = 7;
const SAFE_DIST = 0.21;
const NEIGHBOUR_DISTANCE = 0.8;
const OBSTACLE_RAD = 0.4;
const MAX_SPEED = 0.05;
const TIME_STEP = 0.05;
const START_SPREAD = 6;
const CYLINDER_RADIUS = 0.1;

/** The 12 capsules spelling E, X, P that the flock flows around: [x0, y0, x1, y1]. */
function letterObstacles() {
  const e = -2.7;
  const p = 0.2;
  const cylinders = [
    [e, -1, e + 0.0001, 1], [e, -1, e + 1, -1], [e, 1, e + 1, 1], [e, 0, e + 0.5, 0],
    [p + 2, -1, p + 2.00001, 1], [p + 2, -1, p + 2.7, -1], [p + 2, 0, p + 2.7, 0], [p + 2.7, -1, p + 2.95, -0.75],
    [p + 2.7, 0, p + 2.95, -0.25], [p + 2.95, -0.25, p + 2.950001, -0.75],
    [-0.5, -0.5, 0.5, 0.5], [0.5, -0.5, -0.5, 0.5],
  ];
  return cylinders.map(([x0, y0, x1, y1]) => ({ x0, y0, dx: x1 - x0, dy: y1 - y0, radius: CYLINDER_RADIUS }));
}

export class BoidFlock {
  constructor() {
    this.px = new Float64Array(BOID_COUNT);
    this.py = new Float64Array(BOID_COUNT);
    this.vx = new Float64Array(BOID_COUNT);
    this.vy = new Float64Array(BOID_COUNT);
    this.obstacles = letterObstacles();
    this.reset();
  }

  /** LiquidBoidScene.reset: Random(7) scattered over [-6, 6]^2, at rest. */
  reset() {
    const random = new DotNetRandom(SEED);
    const randFloat = () => random.nextDouble() * 2 - 1;
    for (let i = 0; i < BOID_COUNT; i++) {
      this.px[i] = randFloat() * START_SPREAD;
      this.py[i] = randFloat() * START_SPREAD;
      this.vx[i] = 0;
      this.vy[i] = 0;
    }
  }

  /** Repulsion from the closest point on each capsule, as in updateBoids. */
  addObstacleAvoidance(i, steer) {
    const radSq = OBSTACLE_RAD * OBSTACLE_RAD;
    for (const c of this.obstacles) {
      const lenSq = c.dx * c.dx + c.dy * c.dy;
      const t = Math.min(1, Math.max(0, (c.dx * (this.px[i] - c.x0) + c.dy * (this.py[i] - c.y0)) / lenSq));
      const ox = c.x0 + t * c.dx - this.px[i];
      const oy = c.y0 + t * c.dy - this.py[i];
      const distSq = ox * ox + oy * oy;
      if (distSq < radSq && distSq > 0) {
        const len = Math.sqrt(distSq);
        const k = (radSq - distSq) / radSq;
        steer[0] -= (ox / len) * k;
        steer[1] -= (oy / len) * k;
      }
    }
  }

  /**
   * Weighted rule blend: rules are added in priority order until their summed
   * magnitude reaches 1, with the last one truncated (the C# accumulation loop).
   */
  static blendRules(rules) {
    let sx = 0;
    let sy = 0;
    let total = 0;
    for (let k = 0; k < rules.length && total < 1; k++) {
      let [rx, ry] = rules[k];
      const len = Math.hypot(rx, ry);
      if (total + len > 1) {
        const scale = (1 - total) / len;
        rx *= scale;
        ry *= scale;
      }
      sx += rx;
      sy += ry;
      total += len;
    }
    return [sx, sy];
  }

  /** One updateBoids() call. `scatter` is BoidState.GoAway; target is the wandering attractor. */
  step(targetX, targetY, scatter) {
    const { px, py, vx, vy } = this;
    const safeSq = SAFE_DIST * SAFE_DIST;
    const neighbourSq = NEIGHBOUR_DISTANCE * NEIGHBOUR_DISTANCE;
    for (let i = 0; i < BOID_COUNT; i++) {
      const separation = [0, 0];
      let avgVx = 0, avgVy = 0, avgPx = 0, avgPy = 0, neighbours = 0;
      for (let j = 0; j < BOID_COUNT; j++) {
        const dx = px[j] - px[i];
        const dy = py[j] - py[i];
        const distSq = dx * dx + dy * dy;
        if (j !== i && distSq < safeSq && distSq > 0) {
          const len = Math.sqrt(distSq);
          const k = (safeSq - distSq) / safeSq;
          separation[0] -= (dx / len) * k;
          separation[1] -= (dy / len) * k;
        }
        if (distSq < neighbourSq) {
          avgVx += vx[j];
          avgVy += vy[j];
          avgPx += px[j];
          avgPy += py[j];
          neighbours++;
        }
      }
      this.addObstacleAvoidance(i, separation);
      avgVx /= neighbours;
      avgVy /= neighbours;
      avgPx /= neighbours;
      avgPy /= neighbours;
      const sign = scatter ? -1 : 1;
      const [ax, ay] = BoidFlock.blendRules([
        separation,
        [sign * (avgVx - vx[i]) * 0.4, sign * (avgVy - vy[i]) * 0.4],
        [sign * (avgPx - px[i]) * 0.3, sign * (avgPy - py[i]) * 0.3],
        [(targetX - px[i]) * 0.003, (targetY - py[i]) * 0.003],
      ]);
      vx[i] += ax * TIME_STEP;
      vy[i] += ay * TIME_STEP;
      const speed = Math.hypot(vx[i], vy[i]);
      if (speed > MAX_SPEED) {
        vx[i] *= MAX_SPEED / speed;
        vy[i] *= MAX_SPEED / speed;
      }
    }
    for (let i = 0; i < BOID_COUNT; i++) {
      px[i] += vx[i];
      py[i] += vy[i];
    }
  }
}
