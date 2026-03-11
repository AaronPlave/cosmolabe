import type { Vec3, OrbitalElements, IlluminationAngles, SubPoint, SurfaceIntercept, AberrationCorrection } from './types.js';

export interface SpiceGeometry {
  sincpt(
    method: string, target: string, et: number, fixref: string,
    abcorr: AberrationCorrection, observer: string,
    dref: string, dvec: Vec3
  ): SurfaceIntercept;

  subpnt(
    method: string, target: string, et: number, fixref: string,
    abcorr: AberrationCorrection, observer: string
  ): SubPoint;

  subslr(
    method: string, target: string, et: number, fixref: string,
    abcorr: AberrationCorrection, observer: string
  ): SubPoint;

  ilumin(
    method: string, target: string, et: number, fixref: string,
    abcorr: AberrationCorrection, observer: string, spoint: Vec3
  ): IlluminationAngles;

  oscelt(state: [number, number, number, number, number, number], et: number, mu: number): OrbitalElements;

  conics(elements: OrbitalElements, et: number): [number, number, number, number, number, number];

  bodvcd(bodyId: number, item: string): number[];
  bodvrd(body: string, item: string): number[];
  bodc2n(code: number): string | null;
  bodn2c(name: string): number | null;
}
