/** Metadata-only migration; does not rebuild trajectories or terrain. */
import { readFileSync, writeFileSync } from 'node:fs';
import { ingenuityActivities, moonfallActivities, curiosityActivities } from './mission-activities.mjs';
import { replaceRootProperty } from './catalog-activity-metadata.mjs';
const root = new URL('../apps/viewer/test-catalogs/', import.meta.url);
for (const [name, records] of [
  ['ingenuity-jezero.json', ingenuityActivities(JSON.parse(readFileSync(new URL('data/ingenuity/flights_index.json', root))))],
  ['moonfall-shackleton.json', moonfallActivities()],
  ['msl-dingo-gap.json', curiosityActivities()],
]) {
  const url = new URL(name, root);
  // Preserve original numeric spellings, compact arcs, and unrelated formatting.
  let text = readFileSync(url, 'utf8').replace(/,?\s*"timelineLabel":\s*"[^"]*"/g, '');
  text = replaceRootProperty(text, 'activities', records);
  writeFileSync(url, text);
}
