// Port of Demo.ParticlePhysics with Poly6 / Spiky / Viscosity kernels (Müller-style SPH),
// laid out in typed arrays. Only sphere colliders are ported: the liquid scene uses a single one.
const IDEAL_GAS_CONST = 10;
const VISCOSITY = 0.4;
const GRID_OFFSET = 512; // keeps cell coordinates positive for the integer hash

const sqr = (x) => x * x;
const cube = (x) => x * x * x;

function poly6(r2, h) {
  if (r2 >= h * h) {
    return 0;
  }
  return (315 / (Math.PI * 64 * cube(cube(h)))) * cube(h * h - r2);
}

/** Spiky kernel gradient magnitude factor: gradient = factor * r. */
function spikyGradientFactor(r2, h) {
  if (r2 >= h * h) {
    return 0;
  }
  const len = Math.sqrt(r2);
  return ((-45 / (Math.PI * sqr(cube(h)))) * sqr(h - len)) / len;
}

function viscosityLaplacian(r2, h) {
  if (r2 >= h * h) {
    return 0;
  }
  return (45 / (Math.PI * sqr(cube(h)))) * (h - Math.sqrt(r2));
}

export class ParticlePhysics {
  constructor(h, count) {
    this.radius = h;
    this.count = count;
    this.position = new Float64Array(count * 3);
    this.velocity = new Float64Array(count * 3);
    this.mass = new Float64Array(count);
    this.particleRadius = new Float64Array(count).fill(h);
    this.density = new Float64Array(count);
    this.force = new Float64Array(count * 3);
    this.cell = new Int32Array(count * 3);
    this.grid = new Map();
    this.neighbours = Array.from({ length: count }, () => []);
    this.spheres = []; // [x, y, z, w]; w < 0 keeps particles inside
    this.elasticity = 0;
  }

  applyVelocity(dt) {
    const { position, velocity } = this;
    for (let i = 0; i < position.length; i++) {
      position[i] += dt * velocity[i];
    }
  }

  addVelocity(dx, dy, dz) {
    const v = this.velocity;
    for (let i = 0; i < this.count; i++) {
      v[i * 3] += dx;
      v[i * 3 + 1] += dy;
      v[i * 3 + 2] += dz;
    }
  }

  cellKey(x, y, z) {
    return ((x - 524288 + GRID_OFFSET) * 1024 + (y - 524288 + GRID_OFFSET)) * 1024 + (z - 524288 + GRID_OFFSET);
  }

  updateGrid() {
    this.grid.clear();
    const { position, cell, radius } = this;
    for (let i = 0; i < this.count; i++) {
      for (let a = 0; a < 3; a++) {
        cell[i * 3 + a] = Math.trunc(position[i * 3 + a] / radius + 524288);
      }
      const key = this.cellKey(cell[i * 3], cell[i * 3 + 1], cell[i * 3 + 2]);
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  findNeighbours() {
    const { position, cell, particleRadius } = this;
    for (let i = 0; i < this.count; i++) {
      const list = this.neighbours[i];
      list.length = 0;
      const [cx, cy, cz] = [cell[i * 3], cell[i * 3 + 1], cell[i * 3 + 2]];
      for (let x = cx - 1; x <= cx + 1; x++) {
        for (let y = cy - 1; y <= cy + 1; y++) {
          for (let z = cz - 1; z <= cz + 1; z++) {
            const bucket = this.grid.get(this.cellKey(x, y, z));
            if (!bucket) {
              continue;
            }
            for (const m of bucket) {
              const rx = position[i * 3] - position[m * 3];
              const ry = position[i * 3 + 1] - position[m * 3 + 1];
              const rz = position[i * 3 + 2] - position[m * 3 + 2];
              if (rx * rx + ry * ry + rz * rz < sqr(particleRadius[m])) {
                list.push(m);
              }
            }
          }
        }
      }
    }
  }

  applySPH(dt) {
    this.updateGrid();
    this.findNeighbours();
    const { position: p, velocity: v, mass, density, force, particleRadius: h } = this;
    for (let i = 0; i < this.count; i++) {
      let d = 0;
      for (const m of this.neighbours[i]) {
        const r2 = sqr(p[i * 3] - p[m * 3]) + sqr(p[i * 3 + 1] - p[m * 3 + 1]) + sqr(p[i * 3 + 2] - p[m * 3 + 2]);
        d += mass[m] * poly6(r2, h[m]);
      }
      density[i] = d;
    }
    for (let i = 0; i < this.count; i++) {
      let fx = 0, fy = 0, fz = 0;
      for (const m of this.neighbours[i]) {
        const rx = p[i * 3] - p[m * 3], ry = p[i * 3 + 1] - p[m * 3 + 1], rz = p[i * 3 + 2] - p[m * 3 + 2];
        const r2 = rx * rx + ry * ry + rz * rz;
        if (i !== m) {
          // Pressure term as in the original: -m * k * gradW (no density/pressure scaling).
          const g = mass[m] * IDEAL_GAS_CONST * spikyGradientFactor(r2, h[m]);
          fx -= g * rx;
          fy -= g * ry;
          fz -= g * rz;
        }
        const visc = (VISCOSITY * mass[m] * viscosityLaplacian(r2, h[m])) / density[m];
        fx -= visc * (v[i * 3] - v[m * 3]);
        fy -= visc * (v[i * 3 + 1] - v[m * 3 + 1]);
        fz -= visc * (v[i * 3 + 2] - v[m * 3 + 2]);
      }
      force[i * 3] = fx;
      force[i * 3 + 1] = fy;
      force[i * 3 + 2] = fz;
    }
    for (let i = 0; i < this.count; i++) {
      const k = dt / density[i];
      v[i * 3] += force[i * 3] * k;
      v[i * 3 + 1] += force[i * 3 + 1] * k;
      v[i * 3 + 2] += force[i * 3 + 2] * k;
    }
  }

  applyCollisions() {
    for (let i = 0; i < this.count; i++) {
      for (const sphere of this.spheres) {
        this.collideSphere(i, sphere);
      }
    }
  }

  /** Sphere with w > 0 pushes particles out, w < 0 keeps them inside. */
  collideSphere(i, [sx, sy, sz, w]) {
    const { position: p, velocity: v } = this;
    let nx = p[i * 3] - sx, ny = p[i * 3 + 1] - sy, nz = p[i * 3 + 2] - sz;
    const reach = this.particleRadius[i] + w;
    const d2 = nx * nx + ny * ny + nz * nz;
    if ((w > 0 && d2 > reach * reach) || (w < 0 && d2 < reach * reach)) {
      return;
    }
    const len = Math.sqrt(d2) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const dist = Math.abs(reach);
    p[i * 3] = sx + nx * dist;
    p[i * 3 + 1] = sy + ny * dist;
    p[i * 3 + 2] = sz + nz * dist;
    const vn = v[i * 3] * nx + v[i * 3 + 1] * ny + v[i * 3 + 2] * nz;
    if (vn * w < 0) {
      const k = (1 + this.elasticity) * vn;
      v[i * 3] = 0.9999 * (v[i * 3] - k * nx);
      v[i * 3 + 1] = 0.9999 * (v[i * 3 + 1] - k * ny);
      v[i * 3 + 2] = 0.9999 * (v[i * 3 + 2] - k * nz);
    }
  }
}
