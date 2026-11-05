/** Exact reviewed public values from the shipped MoonFall/Ingenuity catalogs and
 * pinned lunar surface manifests. Never derive this set from loaded catalogs:
 * custom catalogs and runtime resource paths are untrusted. New revisions need review.
 */
import type { AgentMetadataPolicy } from '@cosmolabe/control';

const PUBLIC_METADATA = new Set<string>([
  "3846907d293e9e5d0b0243cefc2ed446335e6624772cf6194930ac3c70c24395",
  "Caltech Murray Lab / Esri",
  "Mars 2020 Jezero CTX orthomosaic",
  "Mars 2020 Jezero HiRISE orthomosaic",
  "Murray Lab CTX V01 global mosaic; nominal original 5 m, available service grid 5.0876 m at equator; original response gaps remain transparent",
  "NASA Trek / USGS Viking MDIM 2.1",
  "NASA/USGS Mars 2020 TRN CTX soc_008",
  "NASA/USGS Mars 2020 TRN HiRISE soc_006",
  "Viking MDIM 2.1 color mosaic; nominal original 232 m, available service grid 325.61 m at equator",
  "ctx-global",
  "cube",
  "jezero-ctx",
  "jezero-hirise",
  "terrain-3846907d293e9e5d0b0243ce",
  "viking",

  "Authored catalog demonstration; not mission-provided operational plans, observations or predicted flight operations. UTC epochs from the existing demo; no coordinates or lunar frames changed.",
  "LRO LROC WAC global mosaic, 100 m (June 2013; LROC team, USGS Astrogeology); LRO LROC NAC South Pole controlled mosaic, 1 m (USGS control network, LROC team mosaic; released Nov 2025; PDS LRO-L-LROC-5-RDR-V1.0, doi:10.17189/1520341)",
  "Original MMGIS event epochs retained as approximate J2000 seconds; clock drift uncalibrated. Observed horizontal path with estimated 3D playback, not precise flight telemetry.",
  "authored",
  "authored-sorties-v1",
  "cosmolabe:cube-gnomonic-1/IAU_MOON",
  "cube-fused-79895697c6b6-g3-m12-b6747ec9d",
  "cube-imagery-composite-3f34a19541af7710",
  "estimated",
  "exact",
  "height-grid",
  "https://mars.nasa.gov/maps/location/?mission=M20",
  "imagery",
  "lroc-wac-global-100m+lroc-nac-south-pole-1m (scripts/terrain/cube_imagery.py composite)",
  "moon-lola-118m+south-pole-lola-10m-residual (scripts/build-moon-terrain/cube.sh)",
  "pinned-MMGIS-flights-index-v1",
  "scripts/moonfall-schedule.mjs"
]);

export const builtInAgentMetadata: AgentMetadataPolicy = {
  publicValue: value => PUBLIC_METADATA.has(value),
};
