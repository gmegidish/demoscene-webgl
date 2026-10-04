// Port of Demo.SineInterpolation: cosine-eased keyframes, clamped at both ends.
export class SineInterpolation {
  constructor() {
    this.times = [];
    this.values = [];
  }

  addPoint(time, value) {
    this.times.push(time);
    this.values.push(value);
  }

  getValue(time) {
    const { times, values } = this;
    if (time <= times[0]) {
      return values[0];
    }
    if (time >= times[times.length - 1]) {
      return values[values.length - 1];
    }
    let i = 0;
    while (times[i + 1] < time) {
      i++;
    }
    const f = 0.5 - 0.5 * Math.cos((Math.PI * (time - times[i])) / (times[i + 1] - times[i]));
    return values[i] + (values[i + 1] - values[i]) * f;
  }
}
