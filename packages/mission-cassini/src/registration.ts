/**
 * The Cassini mission plugin's registration with the host's trusted
 * mission-plugin list (see `installMissionPlugins` in `@cosmolabe/three`). The
 * host discovers each mission package's `src/registration.ts` at build time;
 * the catalog carries only data, never a module reference.
 */
import type { MissionPluginRegistration } from '@cosmolabe/three';
import { CassiniMissionPlugin, hasCassiniObservations } from './plugin.js';

const registration: MissionPluginRegistration = {
  id: 'cassini-observations',
  /** Only a scene with observations taken by a sensor on Cassini gets the plugin. */
  appliesTo: (universe) => hasCassiniObservations(universe),
  create: () => new CassiniMissionPlugin(),
};

export default registration;
