import { parseGeographicGeoJson } from '@cosmolabe/core';

self.onmessage = (event: MessageEvent<Parameters<typeof parseGeographicGeoJson>>) => {
  try { self.postMessage({ layer: parseGeographicGeoJson(...event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
