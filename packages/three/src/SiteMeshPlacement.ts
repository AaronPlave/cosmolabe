import * as THREE from 'three';

/** A local reconstruction is display context until independent registration and
 * coverage evidence justify physical queries. No local query override exists. */
export interface SiteMeshRegistration {
  version: string;
  bodyFixedFrame: string;
  /** Column-major affine transform: source local metres -> body-fixed km,
   * before the viewer's Z-up -> Y-up conversion. Includes the 0.001 scale. */
  bodyFixedKmFromLocalMeters: number[];
  status: 'estimated' | 'controlled';
  provenance: string;
  /** Absolute body-fixed accuracy, not relative fit precision. null = unknown. */
  uncertaintyKm: number | null;
}

export interface SiteMeshConfig {
  name: string;
  url: string;
  sourceVersion: string;
  registration: SiteMeshRegistration;
  /** Source-local bounding box in metres; a display envelope, not a mask of
   * scientifically trusted ground or a guarantee of loaded triangle coverage. */
  coverage: { min: number[]; max: number[] };
  physicalQueryPolicy: 'visual-only';
  /** Composite reconstructed pixels over the globe on the near hemisphere.
   * The globe still owns picking, clearance, navigation and measurements. */
  overlapPolicy: 'composite';
  /** Draw order for coincident reconstructions; ordinary tile depth still applies. */
  priority?: number;
  errorTarget?: number;
  maxCacheBytes?: number;
}

/** Validate before starting requests. Accept rigid, metre-scale transforms only;
 * a mesh must never be stretched, mirrored, or re-fit to the terrain at runtime. */
export function siteMeshPlacement(config: SiteMeshConfig): THREE.Matrix4 {
  const fail = (message: string): never => { throw new Error(`Site mesh ${config.name}: ${message}`); };
  if (!config.sourceVersion || !config.registration?.version || !config.registration.bodyFixedFrame
      || !config.registration.provenance) fail('source and registration provenance/version are required');
  if (!['estimated', 'controlled'].includes(config.registration.status)) fail('unknown registration status');
  const uncertainty = config.registration.uncertaintyKm;
  if (uncertainty !== null && (!Number.isFinite(uncertainty) || uncertainty < 0)) fail('invalid absolute uncertainty');
  if (config.physicalQueryPolicy !== 'visual-only' || config.overlapPolicy !== 'composite') fail('unsupported surface ownership policy');
  const values = config.registration.bodyFixedKmFromLocalMeters;
  if (!Array.isArray(values) || values.length !== 16 || !values.every(Number.isFinite)) fail('expected a finite 4x4 transform');
  if (values[3] !== 0 || values[7] !== 0 || values[11] !== 0 || values[15] !== 1) fail('expected an affine transform');
  const matrix = new THREE.Matrix4().fromArray(values);
  const axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  matrix.extractBasis(axes[0], axes[1], axes[2]);
  if (axes.some(a => Math.abs(a.length() - 0.001) > 1e-12)
      || axes.some((a, i) => axes.some((b, j) => i !== j && Math.abs(a.dot(b)) > 1e-15))
      || Math.abs(matrix.determinant() - 1e-9) > 1e-18) fail('expected a rigid right-handed metres-to-km transform');
  const { min, max } = config.coverage ?? {};
  if (!Array.isArray(min) || !Array.isArray(max) || min.length !== 3 || max.length !== 3
      || ![...min, ...max].every(Number.isFinite) || min.some((v, i) => v >= max[i])) fail('expected a nonempty local coverage box');
  if (config.priority != null && !Number.isFinite(config.priority)) fail('invalid priority');
  if (config.errorTarget != null && (!Number.isFinite(config.errorTarget) || config.errorTarget <= 0)) fail('invalid error target');
  if (config.maxCacheBytes != null && (!Number.isFinite(config.maxCacheBytes) || config.maxCacheBytes <= 0)) fail('invalid cache budget');
  return new THREE.Matrix4().makeRotationX(-Math.PI / 2).multiply(matrix);
}
