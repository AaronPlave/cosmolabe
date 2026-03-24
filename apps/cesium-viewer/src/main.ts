/**
 * SpiceCraft Cesium Viewer — Example app demonstrating @spicecraft/cesium-adapter.
 *
 * Shows how to:
 * 1. Load a SpiceCraft catalog (same JSON format as the Three.js viewer)
 * 2. Export it to CZML via the cesium-adapter
 * 3. Load the CZML into a CesiumJS Viewer
 *
 * This is a reference implementation — users integrate the adapter into
 * whatever Cesium setup they already have.
 */

import {
  Viewer,
  CzmlDataSource,
  OpenStreetMapImageryProvider,
  Cartesian3,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { Universe, CatalogLoader } from '@spicecraft/core';
import { exportToCzml } from '@spicecraft/cesium-adapter';

// Inline demo catalogs (no SPICE kernels needed — uses Keplerian/TLE trajectories)
const DEMO_CATALOGS: Record<string, object> = {
  iss: {
    name: 'ISS',
    items: [
      {
        name: 'Earth',
        class: 'planet',
        trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
      },
      {
        name: 'ISS',
        center: 'Earth',
        class: 'spacecraft',
        trajectory: {
          type: 'TLE',
          line1: '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9005',
          line2: '2 25544  51.6400 200.0000 0001234  90.0000 270.0000 15.49560000400000',
        },
        geometry: {
          type: 'Mesh',
          source: 'ISS_stationary.glb',
          size: 0.1, // ~100 meters
        },
        trajectoryPlot: { color: '#ff0000' },
      },
    ],
  },
};

const statusEl = document.getElementById('status')!;

async function start(): Promise<void> {
  // No Cesium Ion token required. Uses OpenStreetMap imagery (free, no account needed).
  const viewer = new Viewer('cesiumContainer', {
    animation: true,
    timeline: true,
    fullscreenButton: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: true,
    navigationHelpButton: false,
    infoBox: false,
    imageryProvider: false as any,
  });


  viewer.imageryLayers.addImageryProvider(
    new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
  );

  // Load ISS catalog
  const universe = new Universe();
  const loader = new CatalogLoader();
  const result = loader.load(DEMO_CATALOGS.iss as any);
  for (const body of result.bodies) {
    universe.addBody(body);
  }

  // Export to CZML centered on Earth
  const timeRange = universe.getTimeRange();
  let startEt = timeRange?.[0] ?? 0;
  let endEt = timeRange?.[1] ?? startEt + 86400 * 7;
  const maxDuration = 86400 * 7;
  if (endEt - startEt > maxDuration) {
    const mid = (startEt + endEt) / 2;
    startEt = mid - maxDuration / 2;
    endEt = mid + maxDuration / 2;
  }

  const NASA_MODELS: Record<string, string> = {
    'ISS_stationary.glb': 'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/i/ISS_stationary.glb',
  };

  const czml = exportToCzml(universe, {
    startEt,
    endEt,
    sampleInterval: 60,
    centerBody: 'Earth',
    showPaths: true,
    showLabels: true,
    modelResolver: (source) => NASA_MODELS[source] ?? source,
  });

  const dataSource = await CzmlDataSource.load(czml);
  viewer.dataSources.add(dataSource);

  // View Earth from 30,000 km
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(0, 0, 30_000_000),
  });

  statusEl.textContent = `ISS: ${Math.round((endEt - startEt) / 86400)} days of orbit data`;
  universe.dispose();
}

start().catch((err) => {
  statusEl.textContent = `Error: ${err.message}`;
  console.error(err);
});
