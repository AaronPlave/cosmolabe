/** Normal Surface Layers stack shared by LRO and the MoonFall generator (#147). */
export function lunarOpticalImagery() {
  return [
    {
      type: 'cube', id: 'wac', name: 'Moon · WAC context',
      description: 'LROC global morphology mosaic, June 2013 edition, 100 m/px; source images acquired November 2009–February 2011. Original acquisition shading retained; the context beneath NAC and missing observations.',
      attribution: 'LROC team / USGS Astrogeology / ASU', resolutionMeters: 100,
      url: 'data/moon-imagery-cube-wac/imagery.json',
    },
    {
      type: 'cube', id: 'nac', name: 'Moon · NAC south-pole detail',
      description: 'The original deployed controlled south-pole NAC source, 1 m/px, independently switchable. Original display pixels and acquisition shading retained; nodata is transparent to WAC. DE421 mean-Earth coordinates; absolute registration accuracy is unknown.',
      attribution: 'LROC team / USGS Astrogeology / ASU', resolutionMeters: 1,
      url: 'data/moon-imagery-cube-nac-independent/imagery.json',
    },
    {
      type: 'cube', id: 'psr-nac', name: 'PSR observations · stretched / indirectly lit',
      description: 'NAC_POLE_PSR_SOUTH_STRETCH v1.1: actual long-exposure NAC observations, 2012–2017, in reflected indirect light. A 10 m projected grid with elongated native footprints (10–40 m by 1–4 m). Arbitrary stretched display values, not calibrated reflectance or sunlight at the simulation time. Uncontrolled mosaic; absolute registration accuracy unknown. Missing and saturated observations remain transparent.',
      attribution: '2012–2017 · indirect light · NASA/LROC/ASU', resolutionMeters: 10,
      url: 'data/moon-imagery-cube-psr-nac-stretch/imagery.json',
      visible: false, illumination: 'baked', bounds: [-180, -90, 180, -80],
    },
  ];
}
