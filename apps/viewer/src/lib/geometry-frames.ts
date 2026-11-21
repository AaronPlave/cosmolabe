import { frameAvailability, type Universe } from '@cosmolabe/core';

/** Discover names in text kernels; resolution remains the frame registry's job.
 * Only data sections count: kernel documentation often contains example frames.
 */
export function textKernelFrameNames(bytes: ArrayBuffer): string[] {
  const text = new TextDecoder().decode(bytes);
  if (!/^KPL\//.test(text)) return [];
  const names = new Set<string>();
  for (const section of text.split(/\\begindata/i).slice(1)) {
    const data = section.split(/\\begintext/i)[0];
    for (const match of data.matchAll(/\bFRAME_-?\d+_NAME\s*=\s*(?:\(\s*)?'([^']+)'/gi)) names.add(match[1]);
  }
  return [...names].sort();
}

export const FRAME_GROUPS = ['Inertial frames', 'Body / catalog attitude', 'SPICE / mission frames'] as const;
const COMMON_INERTIAL = ['J2000', 'ECLIPJ2000', 'ICRF', 'GALACTIC'];
export function geometryFrameOptions(universe: Universe, missionFrames: readonly string[], et: number, originBody?: string) {
  const options = new Map<string, { name: string; label: string; group: typeof FRAME_GROUPS[number] }>();
  for (const def of universe.frames.definitions()) options.set(def.name, {
    name: def.name, label: def.name, group: def.isStatic && def.kind === 'inertial' ? FRAME_GROUPS[0] : FRAME_GROUPS[1],
  });
  // Keep the standard SPICE spelling visible even when the registry treats it as an alias.
  options.set('J2000', { name: 'J2000', label: 'J2000', group: FRAME_GROUPS[0] });
  for (const name of missionFrames) options.set(name, { name, label: name, group: FRAME_GROUPS[2] });
  for (const body of universe.getAllBodies().filter(body => body.rotation)) {
    const name = universe.frames.bodyFixedFrameFor(body.name);
    options.set(name, { name, label: `${body.name} body axes (catalog attitude)`, group: FRAME_GROUPS[1] });
  }
  return [...options.values()].map(option => ({ ...option, availability: frameAvailability(universe, option.name, et) }))
    .filter(option => option.availability !== 'unknown').sort((a, b) => {
      const rank = (option: typeof a) => option.group === FRAME_GROUPS[0]
        ? (COMMON_INERTIAL.includes(option.name) ? COMMON_INERTIAL.indexOf(option.name) : COMMON_INERTIAL.length)
        : originBody && option.name === universe.frames.bodyFixedFrameFor(originBody) ? -1 : 0;
      return FRAME_GROUPS.indexOf(a.group) - FRAME_GROUPS.indexOf(b.group) || rank(a) - rank(b) || a.label.localeCompare(b.label);
    });
}
