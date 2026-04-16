/**
 * Initialize a CesiumJS Viewer with globe imagery, day/night lighting,
 * atmosphere, and starfield.
 *
 * Ported from is-timeline's CesiumGlobe.svelte (RA-231/Intelligent-Space).
 */

import { patchCesiumWorkers } from './util/workerPatch.js';

/** Named imagery presets. */
export type ImageryPreset = 'natural-earth' | 'blue-marble' | 'esri-world-imagery';

/** Options for globe setup. */
export interface GlobeSetupOptions {
  /** Imagery preset or custom tile URL template. Default: 'natural-earth'. */
  imagery?: ImageryPreset | string;
  /** Enable Black Marble night lights overlay. Default: false. */
  nightImagery?: boolean;
  /** Night lights tile URL template (if nightImagery is a custom URL). */
  nightImageryUrl?: string;
  /** Enable day/night lighting cycle. Default: true. */
  lighting?: boolean;
  /** Show atmosphere glow. Default: true. */
  atmosphere?: boolean;
  /** Dark base color for unlit globe. Default: '#1a1a2e'. */
  baseColor?: string;
  /** Show Cesium animation widget (clock). Default: false. */
  animation?: boolean;
  /** Show Cesium timeline widget. Default: false. */
  timeline?: boolean;
}

/**
 * Create a Cesium Viewer with globe rendering configured.
 *
 * @param container HTML element or element ID to render into
 * @param Cesium The CesiumJS namespace (import * as Cesium from 'cesium')
 * @param options Globe configuration
 * @returns The created Cesium.Viewer
 */
export function createGlobeViewer(
  container: HTMLElement | string,
  Cesium: any,
  options: GlobeSetupOptions = {},
): any /* Cesium.Viewer */ {
  const {
    imagery = 'natural-earth',
    nightImagery = false,
    lighting = true,
    atmosphere = true,
    baseColor = '#1a1a2e',
    animation = false,
    timeline = false,
  } = options;

  // Patch Worker constructor for ESM module workers (Cesium 1.139+)
  patchCesiumWorkers();

  const viewer = new Cesium.Viewer(container, {
    animation,
    timeline,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    navigationHelpButton: false,
    scene3DOnly: true,
    baseLayer: false, // we'll add our own imagery
    msaaSamples: 4,
  });

  const globe = viewer.scene.globe;

  // Dark base color for areas without imagery
  globe.baseColor = Cesium.Color.fromCssColorString(baseColor);

  // Day/night lighting
  globe.enableLighting = lighting;

  // Atmosphere
  viewer.scene.skyAtmosphere.show = atmosphere;
  globe.showGroundAtmosphere = atmosphere;


  // Add day imagery
  addImageryLayer(viewer, Cesium, imagery, { isDayLayer: true });

  // Add night imagery overlay
  if (nightImagery) {
    const nightUrl = options.nightImageryUrl ?? getPresetNightUrl(imagery);
    if (nightUrl) {
      addImageryLayer(viewer, Cesium, nightUrl, {
        isDayLayer: false,
        dayAlpha: 0.0,
        nightAlpha: 1.0,
      });
    }
  }

  return viewer;
}

interface ImageryLayerOptions {
  isDayLayer: boolean;
  dayAlpha?: number;
  nightAlpha?: number;
}

function addImageryLayer(
  viewer: any,
  Cesium: any,
  imagerySource: ImageryPreset | string,
  layerOptions: ImageryLayerOptions,
): void {
  let provider: any;

  if (imagerySource === 'esri-world-imagery') {
    // ESRI World Imagery — high-res satellite tiles, free without API key
    // Attribution required: displayed via Cesium Credit
    provider = new Cesium.UrlTemplateImageryProvider({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
      credit: new Cesium.Credit(
        'Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      ),
    });
  } else if (imagerySource === 'natural-earth') {
    // Cesium's bundled NaturalEarthII: TMS geodetic, levels 0-2, JPEG
    // The tiles are at Assets/Textures/NaturalEarthII/{z}/{x}/{y}.jpg
    // TMS uses reverseY (y=0 at bottom), so we use {reverseY}
    const baseUrl = Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII');
    provider = new Cesium.UrlTemplateImageryProvider({
      url: `${baseUrl}/{z}/{x}/{reverseY}.jpg`,
      minimumLevel: 0,
      maximumLevel: 2,
      tilingScheme: new Cesium.GeographicTilingScheme(),
    });
  } else {
    const url = imagerySource === 'blue-marble'
      ? '/tiles/day/{z}/{x}/{reverseY}.png'
      : imagerySource;

    provider = new Cesium.UrlTemplateImageryProvider({
      url,
      minimumLevel: 0,
      maximumLevel: 5,
    });
  }

  const layer = viewer.imageryLayers.addImageryProvider(provider);

  if (!layerOptions.isDayLayer) {
    layer.dayAlpha = layerOptions.dayAlpha ?? 1.0;
    layer.nightAlpha = layerOptions.nightAlpha ?? 1.0;
  }
}

function getPresetNightUrl(daySource: ImageryPreset | string): string | undefined {
  if (daySource === 'blue-marble') {
    return '/tiles/night/{z}/{x}/{reverseY}.png';
  }
  return undefined;
}
