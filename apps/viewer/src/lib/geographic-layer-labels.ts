/**
 * Plain-language status for a geographic layer, shared by the layer list and
 * the layer view: its swatch, where its data comes from, and whether its import
 * left anything out.
 */
import type { GeographicLayer } from '@cosmolabe/core';

export function layerSwatch(layer: GeographicLayer): string {
  return layer.definition.display?.color ?? '#59c5dd';
}

/** Where the data comes from, in task words. */
export function layerOrigin(layer: GeographicLayer): { label: string; title: string } {
  return layer.ownership === 'catalog'
    ? { label: 'From the catalog', title: 'Published with the catalog; it is never modified here.' }
    : { label: 'Opened from a file', title: 'Opened from a local file for this session; it is never modified here.' };
}

/** Whether the import left features out or noted problems, for a small status dot. */
export function layerIssue(layer: GeographicLayer): { tone: 'warn' | 'error'; title: string } | null {
  const errors = layer.diagnostics.filter((d) => d.severity === 'error').length;
  if (layer.skippedFeatures > 0) return { tone: 'warn', title: `${layer.skippedFeatures} features could not be read and are not shown; see About this layer` };
  if (errors) return { tone: 'error', title: `${errors} import errors; see About this layer` };
  return layer.diagnostics.length ? { tone: 'warn', title: 'Import notes; see About this layer' } : null;
}

const GEOMETRY_LABELS: Record<string, string> = {
  Point: 'Point', MultiPoint: 'Points', LineString: 'Line', MultiLineString: 'Lines', Polygon: 'Area', MultiPolygon: 'Areas',
};
/** A geometry type in plain words: "Line" rather than "LineString". */
export function geometryLabel(type: string): string {
  return GEOMETRY_LABELS[type] ?? type;
}
