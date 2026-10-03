// Bit-exact port of .NET's seeded System.Random (Knuth subtractive generator),
// so procedural geometry matches the original demo.
const MBIG = 2147483647;
const MSEED = 161803398;

export class DotNetRandom {
  constructor(seed) {
    const seedArray = new Array(56).fill(0);
    let mj = MSEED - Math.abs(seed);
    seedArray[55] = mj;
    let mk = 1;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      seedArray[ii] = mk;
      mk = mj - mk;
      if (mk < 0) {
        mk += MBIG;
      }
      mj = seedArray[ii];
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        seedArray[i] -= seedArray[1 + ((i + 30) % 55)];
        if (seedArray[i] < 0) {
          seedArray[i] += MBIG;
        }
      }
    }
    this.seedArray = seedArray;
    this.inext = 0;
    this.inextp = 21;
  }

  internalSample() {
    if (++this.inext >= 56) {
      this.inext = 1;
    }
    if (++this.inextp >= 56) {
      this.inextp = 1;
    }
    let ret = this.seedArray[this.inext] - this.seedArray[this.inextp];
    if (ret === MBIG) {
      ret--;
    }
    if (ret < 0) {
      ret += MBIG;
    }
    this.seedArray[this.inext] = ret;
    return ret;
  }

  nextDouble() {
    return this.internalSample() * (1 / MBIG);
  }

  next(maxValue) {
    return Math.floor(this.nextDouble() * maxValue);
  }
}
