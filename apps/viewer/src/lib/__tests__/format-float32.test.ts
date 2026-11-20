import { expect, it } from 'vitest';
import { formatFloat32 } from '../format-float32.js';

it.each([
  [0.4963705241680145, '0.49637052'],
  [0.3760976493358612, '0.37609765'],
  [Math.fround(95.02922), '95.02922'],
  [Math.fround(-0.1), '-0.1'],
  [0, '0'],
  [-0, '-0'],
  [2 ** -149, '1e-45'],
  [2 ** -96, '1.2621775e-29'],
  [Math.fround(1.40129846e-43), '1.4e-43'],
  [Math.fround(3.40282347e38), '3.4028235e+38'],
])('round trips %s as %s', (value, expected) => {
  const text = formatFloat32(value);
  expect(text).toBe(expected);
  expect(Math.fround(Number(text))).toBe(value);
});
