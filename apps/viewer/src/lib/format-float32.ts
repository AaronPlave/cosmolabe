/** Shortest significant decimal representation of a finite Float32 sample. */
export function formatFloat32(value: number): string {
  if (Object.is(value, -0)) return '-0';
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  for (let digits = 1; digits <= 9; digits++) {
    const nearest = Number(magnitude.toPrecision(digits));
    if (Math.fround(nearest) === magnitude) return sign + nearest.toString();

    // At a power of two the neighbouring floats can be spaced unevenly.
    // Try the decimal on the other side before adding a significant digit.
    const exponent = Number(magnitude.toExponential().split('e')[1]) - digits + 1;
    const coefficient = Math.round(nearest / 10 ** exponent);
    const alternate = Number(`${coefficient + (nearest < magnitude ? 1 : -1)}e${exponent}`);
    if (Math.fround(alternate) === magnitude) return sign + alternate.toString();
  }
  return value.toString();
}
