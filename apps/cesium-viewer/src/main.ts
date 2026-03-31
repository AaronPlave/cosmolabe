/**
 * SpiceCraft Cesium Viewer — Demo app for @spicecraft/cesium.
 *
 * Shows ISS orbit rendered live on a CesiumJS globe using SpiceCraft's
 * CesiumRenderer, TrajectoryTrail, and CameraManager.
 */

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { Universe, CatalogLoader, Body, FixedPointTrajectory } from '@spicecraft/core';
import { dateToEt } from '@spicecraft/cesium-adapter';
import { CesiumRenderer } from '@spicecraft/cesium';

// ── Demo catalog ──────────────────────────────────────────────────────

const ISS_CATALOG = {
  name: 'ISS Demo',
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
        line1: '1 25544U 98067A   26090.13309952  .00011434  00000+0  21777-3 0  9998',
        line2: '2 25544  51.6341 326.3497 0006202 253.7499 106.2807 15.48671303559657',
      },
      trajectoryPlot: { color: '#00ff88', trailDuration: 2700, leadDuration: 2700 },
    },
  ],
};

// ── Ground stations ───────────────────────────────────────────────────

const GROUND_STATIONS = [
  { name: 'Goldstone',   lat: 35.4267, lon: -116.8900, group: 'DSN' },
  { name: 'Madrid',      lat: 40.4314, lon: -4.2481,   group: 'DSN' },
  { name: 'Canberra',    lat: -35.4014, lon: 148.9817, group: 'DSN' },
  { name: 'Kourou',      lat: 5.2361,  lon: -52.7686,  group: 'ESTRACK' },
  { name: 'Svalbard',    lat: 78.2306, lon: 15.3900,   group: 'KSAT' },
  { name: 'Wallops',     lat: 37.9402, lon: -75.4664,  group: 'NEN' },
];

const NETWORK_COLORS: Record<string, string> = {
  DSN: '#00ffff',
  ESTRACK: '#ffbf00',
  KSAT: '#bb66ff',
  NEN: '#66ccff',
};

// ── Main ──────────────────────────────────────────────────────────────

const statusEl = document.getElementById('status')!;

async function start(): Promise<void> {
  // Load catalog
  const universe = new Universe();
  const loader = new CatalogLoader();
  const result = loader.load(ISS_CATALOG as any);
  for (const body of result.bodies) {
    universe.addBody(body);
  }

  // Add ground stations as bodies
  for (const gs of GROUND_STATIONS) {
    const body = new Body({
      name: gs.name,
      parentName: 'Earth',
      classification: 'other',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
      geometryData: { lat: gs.lat, lon: gs.lon, alt: 0, group: gs.group },
    });
    universe.addBody(body);
  }

  // Create the renderer
  const renderer = new CesiumRenderer(
    'cesiumContainer',
    universe,
    Cesium,
    {
      lighting: true,
      atmosphere: true,
      animation: true,
      timeline: true,
      entityDefaults: {
        color: '#00ff88',
        pointSize: 12,
        pulseOnEvent: true,
      },
      bodyStyles: {
        ISS: { color: '#00ff88', pointSize: 14 },
      },
      trailDefaults: {
        trailDuration: 2700,
        leadDuration: 2700,
        color: '#00ff88',
      },
      surfacePointDefaults: {
        groupColors: NETWORK_COLORS,
        pointSize: 8,
      },
    },
  );

  // View Earth from space
  renderer.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(0, 20, 20_000_000),
    duration: 0,
  });

  // ── Body list UI ──────────────────────────────────────────────────
  buildBodyList(renderer, universe);

  // ── Animation — driven by Cesium's clock.onTick ─────────────────
  // Using onTick instead of requestAnimationFrame so position updates
  // are in sync with Cesium's render loop (avoids trackedEntity oscillation).
  renderer.viewer.clock.onTick.addEventListener((clock: any) => {
    const jsDate = Cesium.JulianDate.toDate(clock.currentTime);
    const et = dateToEt(jsDate);
    renderer.setTime(et);
  });

  statusEl.textContent = `ISS + ${GROUND_STATIONS.length} ground stations — live orbit`;

  window.addEventListener('beforeunload', () => {
    renderer.dispose();
    universe.dispose();
  });
}

// ── Body list panel ─────────────────────────────────────────────────

function buildBodyList(renderer: CesiumRenderer, universe: Universe): void {
  const panel = document.getElementById('body-list')!;
  if (!panel) return;

  const bodies = universe.getAllBodies();

  // Group: spacecraft first, then ground stations
  const spacecraft = bodies.filter(b => b.classification === 'spacecraft');
  const stations = bodies.filter(b => {
    const geo = b.geometryData as Record<string, unknown> | undefined;
    return geo?.lat != null;
  });

  function addSection(title: string, items: Body[]): void {
    if (items.length === 0) return;
    const header = document.createElement('div');
    header.textContent = title;
    header.style.cssText = 'color: #888; font-size: 10px; margin-top: 6px; text-transform: uppercase; letter-spacing: 1px;';
    panel.appendChild(header);

    for (const body of items) {
      const btn = document.createElement('button');
      btn.textContent = body.name;
      const geo = body.geometryData as Record<string, unknown> | undefined;
      const group = geo?.group as string | undefined;
      const color = group ? (NETWORK_COLORS[group] ?? '#aaa') : '#00ff88';
      btn.style.cssText = `
        display: block; width: 100%; text-align: left;
        background: none; border: none; color: ${color};
        padding: 3px 0; cursor: pointer; font: 12px monospace;
      `;
      btn.addEventListener('click', () => {
        renderer.focusBody(body.name);
      });
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.1)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
      panel.appendChild(btn);
    }
  }

  addSection('Spacecraft', spacecraft);
  addSection('Ground Stations', stations);
}

start().catch((err) => {
  statusEl.textContent = `Error: ${err.message}`;
  console.error(err);
});
