import type { Body } from '@spicecraft/core';

/** Model metadata extracted from a SpiceCraft Body for use in Cesium. */
export interface CesiumModelInfo {
  /** URI to the glTF/GLB model file */
  uri: string;
  /** Scale factor to apply to the model (meters) */
  scale: number;
  /** Orientation offset quaternion [w, x, y, z] in equatorial frame, or undefined if none */
  meshRotation?: [number, number, number, number];
}

/**
 * Extract Cesium-compatible model information from a SpiceCraft Body.
 *
 * Returns undefined if the body has no mesh geometry or uses an unsupported
 * format (e.g. .cmod).
 *
 * @param body The SpiceCraft body to extract model info from
 * @param resolveUri Optional function to resolve model source paths to URIs
 */
export function getModelInfo(
  body: Body,
  resolveUri?: (source: string) => string | undefined,
): CesiumModelInfo | undefined {
  if (body.geometryType !== 'Mesh') return undefined;

  const geo = body.geometryData as Record<string, unknown> | undefined;
  if (!geo) return undefined;

  const source = geo.source as string | undefined;
  if (!source) return undefined;

  // Check for supported formats (glTF/GLB). CMOD is not supported in Cesium.
  const ext = source.split('.').pop()?.toLowerCase();
  if (ext === 'cmod') return undefined;
  if (ext !== 'glb' && ext !== 'gltf') return undefined;

  const uri = resolveUri ? resolveUri(source) : source;
  if (!uri) return undefined;

  // Size in km → scale in meters. The "size" field represents the target
  // diameter, but without knowing the model's bounding box at this stage,
  // we pass it through as a scale hint. Cesium's Model can apply scale
  // via modelMatrix or the scale property.
  const sizeKm = (geo.size as number) ?? (geo.scale as number) ?? 1;
  const scale = sizeKm * 1000; // km to meters

  const meshRot = geo.meshRotation as number[] | undefined;
  const meshRotation = meshRot && meshRot.length >= 4
    ? [meshRot[0], meshRot[1], meshRot[2], meshRot[3]] as [number, number, number, number]
    : undefined;

  return { uri, scale, meshRotation };
}
