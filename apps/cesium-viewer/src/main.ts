/**
 * SpiceCraft Cesium Viewer — Demo app for @spicecraft/cesium.
 *
 * Shows ISS orbit rendered live on a CesiumJS globe using SpiceCraft's
 * CesiumRenderer, TrajectoryTrail, and CameraManager.
 */

import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  Universe,
  CatalogLoader,
  Body,
  FixedPointTrajectory,
  TLETrajectory,
} from "@spicecraft/core";
import { dateToEt } from "@spicecraft/cesium-adapter";
import { CesiumRenderer } from "@spicecraft/cesium";
import { ISSLiveClient } from "./iss-live.js";
import { ISSCommClient } from "./iss-comm.js";
import { computeLvlhQuaternion, composeAttitude } from "./lvlh.js";
import { TelemetryPanel } from "./telemetry-panel.js";
import { CommLinks } from "./comm-links.js";
import { shadowFraction, eclipseColor } from "./eclipse.js";

// ── Demo catalog ──────────────────────────────────────────────────────

const ISS_CATALOG = {
  name: "ISS Demo",
  items: [
    {
      name: "Earth",
      class: "planet",
      trajectory: { type: "FixedPoint", position: [0, 0, 0] },
    },
    {
      name: "ISS",
      center: "Earth",
      class: "spacecraft",
      trajectory: {
        type: "TLE",
        line1:
          "1 25544U 98067A   26090.13309952  .00011434  00000+0  21777-3 0  9998",
        line2:
          "2 25544  51.6341 326.3497 0006202 253.7499 106.2807 15.48671303559657",
      },
      trajectoryPlot: {
        color: "#00ff88",
        trailDuration: 2700,
        leadDuration: 2700,
      },
    },
  ],
};

// ── Ground stations ───────────────────────────────────────────────────

const GROUND_STATIONS = [
  // NASA Near Space Network — direct ground stations & TDRS terminals
  { name: "White Sands (WSGT)", lat: 32.501, lon: -106.609, group: "NASA" },
  { name: "White Sands (STGT)", lat: 32.542, lon: -106.612, group: "NASA" },
  { name: "Guam (GRGT)", lat: 13.615, lon: 144.856, group: "NASA" },
  { name: "Wallops", lat: 37.94, lon: -75.466, group: "NASA" },
  { name: "Fairbanks (ASF)", lat: 64.859, lon: -147.858, group: "NASA" },
  { name: "Kennedy (KUS)", lat: 28.597, lon: -80.683, group: "NASA" },
  { name: "Ponce de Leon", lat: 29.067, lon: -80.913, group: "NASA" },
  { name: "McMurdo", lat: -77.85, lon: 166.667, group: "NASA" },

  // KSAT (Kongsberg) — NSN partner
  { name: "SvalSat, Svalbard", lat: 78.23, lon: 15.408, group: "KSAT" },
  { name: "TrollSat, Antarctica", lat: -72.017, lon: 2.533, group: "KSAT" },
  { name: "KSAT Singapore", lat: 1.392, lon: 103.835, group: "KSAT" },

  // SSC (Swedish Space Corp) — NSN partner
  { name: "Esrange, Kiruna", lat: 67.884, lon: 21.061, group: "SSC" },
  { name: "Santiago", lat: -33.148, lon: -70.668, group: "SSC" },
  { name: "North Pole, Alaska", lat: 64.805, lon: -147.504, group: "SSC" },
  { name: "Dongara, Australia", lat: -29.046, lon: 115.349, group: "SSC" },
  { name: "South Point, Hawaii", lat: 19.014, lon: -155.663, group: "SSC" },

  // SANSA (South Africa) — NSN partner
  { name: "Hartebeesthoek", lat: -25.887, lon: 27.708, group: "SANSA" },

  // Roscosmos — Russian ground network
  { name: "TsUP, Korolev", lat: 55.913, lon: 37.81, group: "Roscosmos" },
  { name: "Shelkovo", lat: 55.9, lon: 38.0, group: "Roscosmos" },
  { name: "Bear Lakes", lat: 55.866, lon: 37.955, group: "Roscosmos" },
  { name: "Yeniseysk", lat: 58.5, lon: 92.3, group: "Roscosmos" },
  { name: "Kolpashevo", lat: 58.3, lon: 82.9, group: "Roscosmos" },
  { name: "Ulan-Ude", lat: 51.9, lon: 108.0, group: "Roscosmos" },
  { name: "Ussuriysk", lat: 44.0, lon: 131.8, group: "Roscosmos" },
  { name: "Yelizovo, Kamchatka", lat: 53.1, lon: 158.4, group: "Roscosmos" },

  // ESA / DLR — European ground network & Columbus Control
  { name: "Weilheim, Germany", lat: 47.88, lon: 11.08, group: "ESA" },
  { name: "Redu, Belgium", lat: 50.003, lon: 5.146, group: "ESA" },
  { name: "Harwell, UK", lat: 51.571, lon: -1.315, group: "ESA" },
  { name: "COL-CC, Oberpfaffenhofen", lat: 48.074, lon: 11.262, group: "ESA" },

  // JAXA — Japanese ground network
  { name: "Tsukuba (TKSC)", lat: 36.068, lon: 140.127, group: "JAXA" },
  { name: "Katsuura", lat: 35.15, lon: 140.32, group: "JAXA" },
];

// GEO relay satellites — TLE-propagated orbits
const RELAY_SATELLITES = [
  // NASA TDRS — primary ISS comm relay (~85% orbit coverage)
  {
    name: "TDRS-6",
    group: "TDRS",
    line1:
      "1 22314U 93003B   26091.23604097 -.00000303  00000+0  00000+0 0  9991",
    line2:
      "2 22314  14.1819 357.6301 0005088 183.9956  47.0688  1.00268644121632",
  },
  {
    name: "TDRS-7",
    group: "TDRS",
    line1:
      "1 23613U 95035B   26090.80308350 -.00000247  00000+0  00000+0 0  9993",
    line2:
      "2 23613  13.4097 348.7212 0009264  54.7626 163.8330  1.00269293112470",
  },
  {
    name: "TDRS-8",
    group: "TDRS",
    line1:
      "1 26388U 00034A   26090.81623036 -.00000201  00000+0  00000+0 0  9992",
    line2:
      "2 26388  12.5633  31.9677 0005899 327.9257 208.0281  1.00271278 94404",
  },
  {
    name: "TDRS-10",
    group: "TDRS",
    line1:
      "1 27566U 02055A   26090.84331733 -.00000041  00000+0  00000+0 0  9991",
    line2:
      "2 27566   9.9369  43.6228 0014132 251.9208 290.6254  0.98860301 85430",
  },
  {
    name: "TDRS-11",
    group: "TDRS",
    line1:
      "1 39070U 13004A   26091.14681985  .00000071  00000+0  00000+0 0  9993",
    line2:
      "2 39070   3.4082  29.8761 0004458 355.3377  42.7116  1.00272185 45922",
  },
  {
    name: "TDRS-12",
    group: "TDRS",
    line1:
      "1 39504U 14004A   26091.09766965 -.00000279  00000+0  00000+0 0  9993",
    line2:
      "2 39504   3.9032  17.7576 0003107 258.7074 267.0578  1.00278619 43508",
  },
  {
    name: "TDRS-13",
    group: "TDRS",
    line1:
      "1 42915U 17047A   26090.99280713 -.00000110  00000+0  00000+0 0  9997",
    line2:
      "2 42915   3.4351   0.7807 0011690  97.1603  77.3446  1.00272116 31571",
  },

  // Roscosmos Luch — Russian segment relay
  {
    name: "Luch-5A",
    group: "Luch",
    line1:
      "1 37951U 11074B   26090.71526794 -.00000055  00000+0  00000+0 0  9995",
    line2:
      "2 37951   8.5585  74.9327 0003205 277.9494 260.6370  1.00270446 52276",
  },
  {
    name: "Luch-5B",
    group: "Luch",
    line1:
      "1 38977U 12061A   26091.17810664 -.00000142  00000+0  00000+0 0  9991",
    line2:
      "2 38977  10.3198  50.6312 0002850 227.5667 319.1211  1.00273551 48830",
  },
  {
    name: "Luch-5V",
    group: "Luch",
    line1:
      "1 40258U 14058A   26090.55675395 -.00000008  00000+0  00000+0 0  9996",
    line2:
      "2 40258   1.6930  83.6499 0002079 227.7220 164.4157  0.99109956 40201",
  },

  // ESA EDRS — Columbus module Ka-band relay (EDRS-A hosted on Eutelsat 9B)
  {
    name: "EDRS-A",
    group: "EDRS",
    line1:
      "1 41310U 16005A   26089.75704333  .00000046  00000+0  00000+0 0  9996",
    line2:
      "2 41310   0.0655  67.5520 0004065 274.4423 127.6654  1.00273573 37338",
  },
  {
    name: "EDRS-C",
    group: "EDRS",
    line1:
      "1 44475U 19049A   26091.20294634 -.00000272  00000+0  00000+0 0  9995",
    line2:
      "2 44475   0.0290 129.4672 0001317 239.5493  36.1090  1.00272286 24435",
  },
];

const RELAY_GROUPS = new Set(["TDRS", "Luch", "EDRS"]);

const NETWORK_COLORS: Record<string, string> = {
  NASA: "#00ccff", // blue
  KSAT: "#bb66ff", // purple
  SSC: "#66ff66", // green
  SANSA: "#ffaa00", // orange
  Roscosmos: "#ff4444", // red
  ESA: "#ffdd00", // yellow
  JAXA: "#ff88cc", // pink
  TDRS: "#00ffff", // cyan
  Luch: "#ff6644", // orange-red
  EDRS: "#ffee55", // gold
};

// ── Main ──────────────────────────────────────────────────────────────

const statusEl = document.getElementById("status")!;

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
      parentName: "Earth",
      classification: "other",
      trajectory: new FixedPointTrajectory([0, 0, 0]),
      geometryData: { lat: gs.lat, lon: gs.lon, alt: 0, group: gs.group },
    });
    universe.addBody(body);
  }

  // Add GEO relay satellites (TLE-propagated orbits)
  for (const sat of RELAY_SATELLITES) {
    const body = new Body({
      name: sat.name,
      parentName: "Earth",
      classification: "spacecraft",
      trajectoryFrame: "equatorial",
      trajectory: new TLETrajectory({ line1: sat.line1, line2: sat.line2 }),
      geometryData: { group: sat.group },
    });
    universe.addBody(body);
  }

  // Create the renderer
  const renderer = new CesiumRenderer("cesiumContainer", universe, Cesium, {
    imagery: "esri-world-imagery",
    lighting: true,
    atmosphere: true,
    animation: true,
    timeline: true,
    entityDefaults: {
      color: "#00ff88",
      pointSize: 12,
      pulseOnEvent: true,
    },
    bodyStyles: {
      ISS: {
        color: "#00ff88",
        pointSize: 14,
        modelUri: "/models/ISS_stationary.glb",
        modelScale: 1,
        modelMinimumPixelSize: 32,
        modelSwitchDistance: 1_000_000,
        modelHpr: [0, 180, 0], // Pitch 180° to flip model -Z (Cupola) toward nadir
      },
      // Relay satellites — colored by constellation, smaller points
      ...Object.fromEntries(
        RELAY_SATELLITES.map((sat) => [
          sat.name,
          {
            color: NETWORK_COLORS[sat.group] ?? "#aaaaaa",
            pointSize: 8,
          },
        ]),
      ),
    },
    trailFilter: (body) => {
      // Skip orbit trails for GEO relay sats — they barely move relative to Earth
      const geo = body.geometryData as Record<string, unknown> | undefined;
      const group = geo?.group as string | undefined;
      return !group || !RELAY_GROUPS.has(group);
    },
    trailDefaults: {
      trailDuration: 2700,
      leadDuration: 2700,
      color: "#00ff88",
    },
    surfacePointDefaults: {
      groupColors: NETWORK_COLORS,
      pointSize: 8,
    },
  });

  renderer.viewer.scene.globe.nightFadeOutDistance = 0
  renderer.viewer.scene.globe.nightFadeInDistance = 1
  renderer.viewer.scene.globe.lightingFadeOutDistance = 0;
  renderer.viewer.scene.globe.lightingFadeInDistance = 1;
  renderer.viewer.scene.globe.atmosphereLightIntensity = 0;
  renderer.viewer.shadows = true;
  renderer.viewer.terrainShadows = Cesium.ShadowMode.DISABLED;
  renderer.viewer.shadowMap.softShadows = true;
  renderer.viewer.shadowMap.size = 2048;
  renderer.viewer.shadowMap.darkness = 0.7;
  renderer.viewer.scene.globe.showSpecularHighlights = false;

  // Harsh space lighting — mostly just the sun, near-zero ambient
  renderer.viewer.scene.light = new Cesium.SunLight({ intensity: 3.0 });

  // View Earth from space
  renderer.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(0, 20, 20_000_000),
    duration: 0,
  });

  // ── Body list UI ──────────────────────────────────────────────────
  buildBodyList(renderer, universe);

  // ── Feature modules ────────────────────────────────────────────────
  const issBody = universe.getBody("ISS");
  const issEntity = renderer.getBodyEntity("ISS");

  // Near-zero ambient IBL on the ISS model — in vacuum, the only fill light
  // is Earthshine (~5% of direct sun). This gives the harsh lit/shadow
  // contrast visible in real ISS photography.
  if (issEntity?.entity.model) {
    issEntity.entity.model.imageBasedLightingFactor = new Cesium.Cartesian2(0.05, 0.05);
  }

  // 1. Telemetry panel
  const telemetryPanel = new TelemetryPanel(document.body, Cesium);


  // 3. Comm links — geometric line-of-sight visibility
  const issComm = new ISSCommClient();
  issComm.connect();

  const commLinks = new CommLinks(
    renderer.viewer,
    Cesium,
    'ISS',
    RELAY_SATELLITES.map((s) => ({ name: s.name, group: s.group })),
    GROUND_STATIONS,
    NETWORK_COLORS,
  );

  const commStatusEl = document.getElementById("comm-status")!;

  // ── Animation — driven by Cesium's clock.onTick ─────────────────
  renderer.viewer.clock.onTick.addEventListener((clock: any) => {
    const jsDate = Cesium.JulianDate.toDate(clock.currentTime);
    const et = dateToEt(jsDate);
    renderer.setTime(et);

    // Compute ISS state once per tick for all feature modules
    if (issBody) {
      try {
        const state = issBody.trajectory.stateAt(et);
        const posEci = state.position;
        const velEci = state.velocity;

        // Eclipse shadow — dim model when ISS is in Earth's shadow
        if (issEntity?.entity.model) {
          const sunEci =
            Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
              clock.currentTime,
            );
          const shadow = shadowFraction(
            posEci[0], posEci[1], posEci[2],
            sunEci.x * 0.001, sunEci.y * 0.001, sunEci.z * 0.001,
          );
          const [r, g, b] = eclipseColor(shadow);
          issEntity.entity.model.color = new Cesium.Color(r, g, b, 1);
        }

        telemetryPanel.update(posEci, velEci, clock.currentTime);
        commLinks.update(clock.currentTime);

        // Update comm status bar
        const liveTag =
          issComm.connected && issComm.status.signalAcquired
            ? ' <span class="active">AOS</span>'
            : "";
        commStatusEl.innerHTML = `RELAY ${commLinks.visibleRelays}${liveTag} · STATIONS ${commLinks.visibleStations}`;
      } catch {
        /* TLE propagation may fail far from epoch */
      }
    }
  });

  // ── ISS Live Attitude ─────────────────────────────────────────────
  // Connect to NASA's Lightstreamer feed for real-time ISS attitude

  if (issBody && issEntity) {
    const KM_TO_M = 1000;
    let lastLiveAttitude: [number, number, number, number] | null = null;

    // Helper: compute LVLH orientation from position/velocity at given ET
    function computeOrientationAtEt(et: number): Cesium.Quaternion | null {
      try {
        const state = issBody!.trajectory.stateAt(et);
        const posEci = new Cesium.Cartesian3(
          state.position[0] * KM_TO_M,
          state.position[1] * KM_TO_M,
          state.position[2] * KM_TO_M,
        );
        const velEci = new Cesium.Cartesian3(
          state.velocity[0] * KM_TO_M,
          state.velocity[1] * KM_TO_M,
          state.velocity[2] * KM_TO_M,
        );
        const lvlhQuat = computeLvlhQuaternion(posEci, velEci);

        if (lastLiveAttitude) {
          // Compose LVLH frame with live body attitude
          return composeAttitude(lvlhQuat, lastLiveAttitude);
        }
        // No live data yet — use pure LVLH (nadir-pointing, velocity-forward)
        return lvlhQuat;
      } catch {
        return null;
      }
    }

    const liveEl = document.getElementById("live-indicator")!;

    // Store live attitude from Lightstreamer (but don't apply directly)
    const issLive = new ISSLiveClient((attitude) => {
      lastLiveAttitude = attitude.quaternion;
    });
    issLive.connect();

    // Apply orientation on each clock tick — uses live attitude only when near real-time
    renderer.viewer.clock.onTick.addEventListener((clock: any) => {
      const jsDate = Cesium.JulianDate.toDate(clock.currentTime);
      const et = dateToEt(jsDate);
      const nowEt = dateToEt(new Date());

      // Only use live attitude if clock is within 60 seconds of real-time
      const isRealTime = Math.abs(et - nowEt) < 60;
      const isLive =
        isRealTime && lastLiveAttitude !== null && issLive.connected;
      const savedAttitude = lastLiveAttitude;

      if (!isRealTime) {
        lastLiveAttitude = null;
      }

      const orientation = computeOrientationAtEt(et);
      if (orientation) {
        // The LVLH quaternion is in ECI (inertial), but Cesium entity.orientation
        // is always in ECEF (fixed). Apply ICRF→Fixed rotation to convert.
        const icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(
          clock.currentTime,
        );
        let orientFixed = orientation;
        if (icrfToFixed) {
          const icrfToFixedQ =
            Cesium.Quaternion.fromRotationMatrix(icrfToFixed);
          orientFixed = Cesium.Quaternion.multiply(
            icrfToFixedQ,
            orientation,
            new Cesium.Quaternion(),
          );
        }

        // Compose with mesh rotation offset to align model axes
        const meshQ = issEntity!.meshRotation;
        const finalQ = Cesium.Quaternion.multiply(
          orientFixed,
          meshQ,
          new Cesium.Quaternion(),
        );
        issEntity!.entity.orientation = finalQ;
      }

      if (!isRealTime) {
        lastLiveAttitude = savedAttitude;
      }

      // Update LIVE indicator
      liveEl.style.display = "flex";
      if (isLive) {
        liveEl.className = "connected";
        liveEl.innerHTML =
          '<span class="dot"></span><span class="text">LIVE ATTITUDE</span>';
      } else if (issLive.connected) {
        liveEl.className = "";
        liveEl.innerHTML =
          '<span class="dot" style="background:#666;animation:none"></span><span class="text" style="color:#666">LVLH (scrubbing)</span>';
      } else {
        liveEl.className = "";
        liveEl.innerHTML =
          '<span class="dot"></span><span class="text">CONNECTING...</span>';
      }
    });

    statusEl.textContent = `ISS + ${GROUND_STATIONS.length} ground stations + ${RELAY_SATELLITES.length} relay sats — live orbit + attitude`;
  } else {
    statusEl.textContent = `ISS + ${GROUND_STATIONS.length} ground stations + ${RELAY_SATELLITES.length} relay sats — live orbit`;
  }

  window.addEventListener("beforeunload", () => {
    telemetryPanel.dispose();
    commLinks.dispose();
    issComm.disconnect();
    renderer.dispose();
    universe.dispose();
  });
}

// ── Body list panel ─────────────────────────────────────────────────

function buildBodyList(renderer: CesiumRenderer, universe: Universe): void {
  const panel = document.getElementById("body-list")!;
  if (!panel) return;

  const bodies = universe.getAllBodies();

  // Group: spacecraft (ISS + relays), ground stations (surface)
  const spacecraft = bodies.filter((b) => b.classification === "spacecraft");
  const stations = bodies.filter((b) => {
    const geo = b.geometryData as Record<string, unknown> | undefined;
    return geo?.lat != null;
  });

  function addSection(title: string, items: Body[]): void {
    if (items.length === 0) return;
    const header = document.createElement("div");
    header.textContent = title;
    header.style.cssText =
      "color: #888; font-size: 10px; margin-top: 6px; text-transform: uppercase; letter-spacing: 1px;";
    panel.appendChild(header);

    for (const body of items) {
      const btn = document.createElement("button");
      btn.textContent = body.name;
      const geo = body.geometryData as Record<string, unknown> | undefined;
      const group = geo?.group as string | undefined;
      const color = group ? (NETWORK_COLORS[group] ?? "#aaa") : "#00ff88";
      btn.style.cssText = `
        display: block; width: 100%; text-align: left;
        background: none; border: none; color: ${color};
        padding: 3px 0; cursor: pointer; font: 12px monospace;
      `;
      btn.addEventListener("click", () => {
        renderer.focusBody(body.name);
      });
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "rgba(255,255,255,0.1)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "none";
      });
      panel.appendChild(btn);
    }
  }

  addSection("Spacecraft", spacecraft);
  addSection("Ground Stations", stations);
}

start().catch((err) => {
  statusEl.textContent = `Error: ${err.message}`;
  console.error(err);
});
