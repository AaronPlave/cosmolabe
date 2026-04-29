import type { Universe, Body } from '@cosmolabe/core';
import { etToIso, etIntervalToIso } from './TimeConversions.js';
import { positionForCesium, quaternionEclipticToEquatorial } from './CoordinateTransforms.js';
import { getModelInfo, type CesiumModelInfo } from './ModelAdapter.js';

/** Options for CZML export. */
export interface CzmlExportOptions {
  /** Start epoch in ET (seconds past J2000). Defaults to universe time range start. */
  startEt?: number;
  /** End epoch in ET. Defaults to universe time range end. */
  endEt?: number;
  /** Sample interval in seconds. Default 60. */
  sampleInterval?: number;
  /** Reference body name — positions are relative to this body's center.
   *  Default: the root body (usually "Sun"). For Earth-centric views, set to "Earth". */
  centerBody?: string;
  /** Resolve model source paths to URIs for Cesium. */
  modelResolver?: (source: string) => string | undefined;
  /** Include trajectory path visualization. Default true. */
  showPaths?: boolean;
  /** Include labels. Default true. */
  showLabels?: boolean;
}

/** A single CZML packet (loosely typed — CZML is a JSON format). */
export type CzmlPacket = Record<string, unknown>;

/**
 * Export a Cosmolabe Universe to CZML format.
 *
 * CZML is Cesium's native time-dynamic JSON format. Loading the output
 * into a Cesium Viewer via `Cesium.CzmlDataSource.load(czml)` gives you
 * Cesium's built-in interpolation, timeline, and entity management.
 *
 * Positions are sampled at the configured interval and output in the
 * ICRF (≈J2000 equatorial) reference frame in meters — Cesium's native
 * inertial frame.
 */
export function exportToCzml(
  universe: Universe,
  options: CzmlExportOptions = {},
): CzmlPacket[] {
  const timeRange = universe.getTimeRange();
  const startEt = options.startEt ?? timeRange?.[0] ?? 0;
  const endEt = options.endEt ?? timeRange?.[1] ?? 86400;
  const interval = options.sampleInterval ?? 60;
  const centerBody = options.centerBody;
  const showPaths = options.showPaths ?? true;
  const showLabels = options.showLabels ?? true;

  const packets: CzmlPacket[] = [];

  // Document packet (required first element in CZML)
  packets.push({
    id: 'document',
    name: 'Cosmolabe Export',
    version: '1.0',
    clock: {
      interval: etIntervalToIso(startEt, endEt),
      currentTime: etToIso(startEt),
      multiplier: 1,
      range: 'LOOP_STOP',
      step: 'SYSTEM_CLOCK_MULTIPLIER',
    },
  });

  // Export each body
  const bodies = universe.getAllBodies();
  for (const body of bodies) {
    const packet = exportBody(universe, body, startEt, endEt, interval, centerBody, options.modelResolver, showPaths, showLabels);
    if (packet) packets.push(packet);
  }

  return packets;
}

function exportBody(
  universe: Universe,
  body: Body,
  startEt: number,
  endEt: number,
  interval: number,
  centerBody: string | undefined,
  modelResolver: ((source: string) => string | undefined) | undefined,
  showPaths: boolean,
  showLabels: boolean,
): CzmlPacket | null {
  // Sample positions
  const positions = samplePositions(universe, body, startEt, endEt, interval, centerBody);
  if (!positions) return null;

  const packet: CzmlPacket = {
    id: body.name,
    name: body.name,
    availability: etIntervalToIso(startEt, endEt),
  };

  // Position (sampled, ICRF reference frame)
  packet.position = {
    referenceFrame: 'INERTIAL',
    epoch: etToIso(startEt),
    cartesian: positions,
    interpolationAlgorithm: 'LAGRANGE',
    interpolationDegree: 5,
  };

  // Orientation (sampled)
  if (body.rotation) {
    const orientations = sampleOrientations(body, startEt, endEt, interval);
    if (orientations) {
      packet.orientation = {
        epoch: etToIso(startEt),
        unitQuaternion: orientations,
        interpolationAlgorithm: 'LINEAR',
      };
    }
  }

  // Model (glTF/GLB)
  const modelInfo = getModelInfo(body, modelResolver);
  if (modelInfo) {
    packet.model = buildModelPacket(modelInfo);
  }

  // Point — always shown as a fallback at distance (or when model hasn't loaded yet)
  const color = getBodyColor(body);
  packet.point = {
    pixelSize: body.classification === 'star' ? 8 : body.classification === 'planet' ? 6 : 4,
    color: { rgba: color },
  };

  // Label
  if (showLabels) {
    packet.label = {
      text: body.name,
      font: '12px sans-serif',
      fillColor: { rgba: [255, 255, 255, 200] },
      outlineColor: { rgba: [0, 0, 0, 200] },
      outlineWidth: 2,
      style: 'FILL_AND_OUTLINE',
      horizontalOrigin: 'LEFT',
      pixelOffset: { cartesian2: [8, 0] },
      show: true,
    };
  }

  // Trajectory path
  if (showPaths && body.classification !== 'star') {
    const plot = body.trajectoryPlot;
    const color = plot?.color
      ? [...hexToRgba(plot.color).slice(0, 3), 180]
      : [128, 128, 255, 180];
    packet.path = {
      show: true,
      width: 1,
      material: {
        solidColor: { color: { rgba: color } },
      },
      leadTime: 0,
      trailTime: endEt - startEt,
    };
  }

  return packet;
}

/**
 * Sample a body's position at regular intervals, returning a flat array
 * for CZML's cartesian format: [t0, x0, y0, z0, t1, x1, y1, z1, ...]
 * where t is seconds since epoch.
 */
function samplePositions(
  universe: Universe,
  body: Body,
  startEt: number,
  endEt: number,
  interval: number,
  centerBody: string | undefined,
): number[] | null {
  const samples: number[] = [];
  let hasValidSample = false;

  for (let et = startEt; et <= endEt; et += interval) {
    const absPos = universe.absolutePositionOf(body.name, et);

    let pos: [number, number, number];
    if (centerBody) {
      const centerPos = universe.absolutePositionOf(centerBody, et);
      pos = [
        absPos[0] - centerPos[0],
        absPos[1] - centerPos[1],
        absPos[2] - centerPos[2],
      ];
    } else {
      pos = absPos;
    }

    if (isNaN(pos[0])) continue;

    // If body's trajectory is already in equatorial frame (e.g. TLE/TEME),
    // just convert km→meters. Otherwise, rotate from ecliptic to equatorial.
    const isEquatorial = body.trajectoryFrame === 'equatorial';
    const cesiumPos: [number, number, number] = isEquatorial
      ? [pos[0] * 1000, pos[1] * 1000, pos[2] * 1000]
      : positionForCesium(pos);
    samples.push(et - startEt, cesiumPos[0], cesiumPos[1], cesiumPos[2]);
    hasValidSample = true;
  }

  return hasValidSample ? samples : null;
}

/**
 * Sample a body's orientation at regular intervals, returning a flat array
 * for CZML's unitQuaternion format: [t0, x0, y0, z0, w0, ...]
 * Note: CZML quaternion order is (x, y, z, w), not Cosmolabe's (w, x, y, z).
 */
function sampleOrientations(
  body: Body,
  startEt: number,
  endEt: number,
  interval: number,
): number[] | null {
  const samples: number[] = [];
  let hasValidSample = false;

  for (let et = startEt; et <= endEt; et += interval) {
    const q = body.rotationAt(et);
    if (!q || isNaN(q[0])) continue;

    // For ecliptic-frame bodies, rotate quaternion to equatorial.
    // For equatorial-frame bodies (TLE), use as-is.
    const outQ = body.trajectoryFrame === 'equatorial'
      ? q
      : quaternionEclipticToEquatorial(q);

    // CZML quaternion order: x, y, z, w (not w, x, y, z)
    samples.push(et - startEt, outQ[1], outQ[2], outQ[3], outQ[0]);
    hasValidSample = true;
  }

  return hasValidSample ? samples : null;
}

function buildModelPacket(info: CesiumModelInfo): Record<string, unknown> {
  const packet: Record<string, unknown> = {
    gltf: info.uri,
    scale: info.scale,
    minimumPixelSize: 0,
  };
  if (info.meshRotation) {
    const [w, x, y, z] = info.meshRotation;
    // CZML nodeTransformations would go here for mesh rotation,
    // but for simplicity we note that the orientation property
    // on the entity already composes with the body attitude.
    packet.nodeTransformations = {
      meshRotation: {
        rotation: { unitQuaternion: [x, y, z, w] },
      },
    };
  }
  return packet;
}

/** Parse a hex color string like "#ff8800" to an RGBA array. */
function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
    255,
  ];
}

function getBodyColor(body: Body): [number, number, number, number] {
  const plot = body.trajectoryPlot;
  if (plot?.color) return hexToRgba(plot.color);

  // Default colors by classification
  switch (body.classification) {
    case 'star': return [255, 255, 200, 255];
    case 'planet': return [180, 180, 255, 255];
    case 'moon': return [200, 200, 200, 255];
    case 'spacecraft': return [100, 255, 100, 255];
    default: return [180, 180, 180, 255];
  }
}
