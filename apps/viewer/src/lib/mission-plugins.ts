/**
 * The host's trusted, built-in mission plugins (#296).
 *
 * Every `packages/mission-<name>/src/registration.ts` in this repository is
 * discovered here at build time and offered to each scene the viewer loads;
 * `installMissionPlugins` installs only the ones whose `appliesTo` accepts the
 * loaded scene. Nothing here names a mission, and a catalog never names or
 * loads code: it is data the plugin looks at. A host that does not include a
 * mission package still loads the same catalog as ordinary data.
 */
import type { Universe } from '@cosmolabe/core';
import { installMissionPlugins, type MissionPluginRegistration, type UniverseRenderer } from '@cosmolabe/three';

const discovered = import.meta.glob<{ default: MissionPluginRegistration }>(
  '../../../../packages/mission-*/src/registration.ts',
  { eager: true },
);

const builtIn: readonly MissionPluginRegistration[] = Object.values(discovered).map((module) => module.default);

/** Install the trusted mission plugins that apply to this scene on its renderer; returns their ids. */
export function installBuiltInMissionPlugins(renderer: UniverseRenderer, universe: Universe, registrations: readonly MissionPluginRegistration[] = builtIn): string[] {
  return installMissionPlugins(renderer, universe, registrations);
}
