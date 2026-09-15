import { describe, expect, it } from 'vitest';
import { coverageWindow, practicalSearchWindow } from '../event-finder.svelte';

function coverage(start: number, end: number) {
  return {
    bodn2c: (_name: string) => 399,
    spkcov: (_id: number) => [{ start, end }],
  };
}

describe('event finder coverage window', () => {
  it('insets defaults that touch SPK edges for GF derivative probes', () => {
    expect(coverageWindow(
      coverage(0, 100),
      { observer: 'EARTH', target: 'MOON' },
      { start: 0, end: 100 },
    )).toEqual({ start: 3, end: 97 });
  });

  it('does not narrow a catalog window already inside SPK coverage', () => {
    expect(coverageWindow(
      coverage(0, 100),
      { observer: 'EARTH', target: 'MOON' },
      { start: 10, end: 90 },
    )).toEqual({ start: 10, end: 90 });
  });

  it('uses the tightest shared boundary before applying the inset', () => {
    const fake = {
      bodn2c: (name: string) => name === 'EARTH' ? 399 : 301,
      spkcov: (id: number) => id === 399
        ? [{ start: 0, end: 100 }]
        : [{ start: 20, end: 80 }],
    };

    expect(coverageWindow(
      fake,
      { observer: 'EARTH', target: 'MOON' },
      { start: 0, end: 100 },
    )).toEqual({ start: 23, end: 77 });
  });
});

describe('event finder practical default window', () => {
  const year = 365.25 * 86_400;

  it('centers a two-year default on the current time inside a long catalog', () => {
    expect(practicalSearchWindow({ start: -100 * year, end: 100 * year }, 10)).toEqual({
      start: 10 - year,
      end: 10 + year,
    });
  });

  it('clamps the default at either catalog edge', () => {
    expect(practicalSearchWindow({ start: 0, end: 10 * year }, 0)).toEqual({
      start: 0,
      end: 2 * year,
    });
    expect(practicalSearchWindow({ start: 0, end: 10 * year }, 10 * year)).toEqual({
      start: 8 * year,
      end: 10 * year,
    });
  });

  it('leaves a shorter catalog span unchanged', () => {
    expect(practicalSearchWindow({ start: 10, end: 20 }, 15)).toEqual({ start: 10, end: 20 });
  });

  it('supports a smaller kind-specific practical span', () => {
    const day = 86_400;
    expect(practicalSearchWindow({ start: 0, end: 365 * day }, 180 * day, 90 * day)).toEqual({
      start: 135 * day,
      end: 225 * day,
    });
  });
});
