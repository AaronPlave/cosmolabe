/**
 * "Copy coordinates" on a right-clicked surface point (#190): what reaches
 * the clipboard is a pair the Navigate field reads back to the same place.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseCoordinatePair } from '@cosmolabe/core';
import type { SurfacePoint } from '@cosmolabe/three';
import { compactTargetCoordinates, copySurfacePointCoordinates } from '../surface-coordinates';

const R = 1560.8; // Europa
const pick = (latDeg: number, lonDeg: number) => {
  const phi = latDeg * Math.PI / 180, lam = lonDeg * Math.PI / 180;
  return {
    bodyName: 'Europa', source: 'ellipsoid', latDeg, lonDeg, latitudeKind: 'planetocentric',
    bodyFixedPositionKm: [R * Math.cos(phi) * Math.cos(lam), R * Math.cos(phi) * Math.sin(lam), R * Math.sin(phi)],
    hit: { heightKm: 0, datum: { referenceShape: { kind: 'sphere', radiusKm: R }, verticalDatum: 'reference-sphere', heightConvention: 'radial', origin: 'body-shape' } },
    resolution: { surfaceKm: 0.03, latDeg: 0.001, lonDeg: 0.001 },
  } as unknown as SurfacePoint;
};

describe('copySurfacePointCoordinates', () => {
  it('writes a lettered pair to the clipboard that pastes back to the point', async () => {
    const writeText = vi.fn(async (_: string) => {});
    const text = await copySurfacePointCoordinates(pick(18.4447, -30.25), { writeText });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toBe('18.445° N, 30.250° W');
    expect(text).toBe('18.445° N, 30.250° W');
    const read = parseCoordinatePair(writeText.mock.calls[0][0], { order: 'lat-lon', direction: 'east' });
    expect(read).toMatchObject({ ok: true });
    if (read.ok) {
      expect(read.latDeg).toBeCloseTo(18.445, 6);
      expect(read.lonDeg).toBeCloseTo(-30.25, 6);
    }
  });

  it('reports a refused clipboard instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeText = vi.fn(async () => { throw new Error('NotAllowedError'); });
    await expect(copySurfacePointCoordinates(pick(0, 0), { writeText })).resolves.toBeNull();
    await expect(copySurfacePointCoordinates(pick(0, 0), undefined)).resolves.toBeNull();
    warn.mockRestore();
  });
});


describe('compact target coordinates', () => {
  it('bounds HUD precision and keeps both hemispheres with intuitive longitude', () => {
    expect(compactTargetCoordinates(-15.123123000, 214.23423456789)).toBe('15.1231° S, 145.7658° W');
    expect(compactTargetCoordinates(-15.123123000, 214.23423456789, 2)).toBe('15.12° S, 145.77° W');
    expect(compactTargetCoordinates(90, -360)).toBe('90.0000° N, 0.0000° E');
  });
});
