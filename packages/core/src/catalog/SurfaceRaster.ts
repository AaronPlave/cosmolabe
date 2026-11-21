/** Independently enabled, body-fixed scientific layers. The manifest supplies
 * the source grid and provenance. Catalog styling does not change its values. */
export interface SurfaceRasterDefinition {
  id: string;
  name: string;
  body: string;
  source: string;
  description: string;
  quantity: string;
  unit: string;
  opacity: number;
  /** Planetocentric coordinates of a valid sample in the body's fixed frame. */
  observation?: { latDeg: number; lonDeg: number };
  colorScale: { value: number; color: string }[];
}
