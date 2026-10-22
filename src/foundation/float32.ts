/**
 * `d` as a float32 no deeper than it: a depth rounded deeper would read
 * safer than the chart (invariant 1).
 */
export function float32AtMost(d: number): number {
  const f = Math.fround(d);
  if (f <= d || !Number.isFinite(d)) {
    return f;
  }
  if (f === 0) {
    // The negative float32 nearest zero.
    return -1.401298464324817e-45;
  }
  const buf = new Float32Array([f]);
  const bits = new Int32Array(buf.buffer);
  bits[0] = (bits[0] as number) + (f > 0 ? -1 : 1);
  return buf[0] as number;
}
