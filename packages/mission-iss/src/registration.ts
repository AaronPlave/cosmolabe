/**
 * The ISS mission plugin's registration with the host's trusted mission-plugin
 * list (see `installMissionPlugins` in `@cosmolabe/three`). The host discovers
 * each mission package's `src/registration.ts` at build time; the catalog carries
 * only data, never a module reference.
 */
import type { MissionPluginRegistration } from '@cosmolabe/three';
import { IssArticulationPlugin, usesIssModel } from './plugin.js';

const registration: MissionPluginRegistration = {
  id: 'iss-articulation',
  /** Only a scene that draws the NASA ISS model gets the plugin. */
  appliesTo: (universe) => universe.getAllBodies().some(usesIssModel),
  create: () => new IssArticulationPlugin(),
};

export default registration;
