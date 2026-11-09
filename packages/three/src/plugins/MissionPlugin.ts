import type { Universe } from '@cosmolabe/core';
import type { RendererPlugin } from './RendererPlugin.js';

/**
 * A trusted, built-in mission plugin the host offers to every scene it loads.
 *
 * This is host-owned association, not catalog code: the catalog stays data and
 * never names or loads a module. A scene gets the plugin only when
 * `appliesTo(universe)` says the loaded scene has what the plugin needs, so an
 * unrelated catalog never receives it.
 */
export interface MissionPluginRegistration {
  /** Stable identifier; a second registration with the same id is ignored. */
  readonly id: string;
  /** Does this loaded scene have what the plugin works on? Called once per scene, before `create`. */
  appliesTo(universe: Universe): boolean;
  /** A fresh plugin for one scene; the renderer owns its lifetime from `use`. */
  create(): RendererPlugin;
}

/**
 * Install each applicable registration on `renderer`. A registration that
 * throws (or is malformed) disables only itself: it is reported and skipped,
 * and the scene loads normally. Returns the ids installed.
 */
export function installMissionPlugins(
  renderer: { use(plugin: RendererPlugin): void },
  universe: Universe,
  registrations: readonly MissionPluginRegistration[],
): string[] {
  const installed: string[] = [];
  const seen = new Set<string>();
  for (const registration of registrations) {
    const id = registration?.id;
    try {
      if (typeof id !== 'string' || !id || typeof registration.appliesTo !== 'function' || typeof registration.create !== 'function') {
        throw new Error('registration needs an id, appliesTo and create');
      }
      if (seen.has(id)) continue;
      seen.add(id);
      if (!registration.appliesTo(universe)) continue;
      renderer.use(registration.create());
      installed.push(id);
    } catch (error) {
      console.warn(`[Cosmolabe] mission plugin ${typeof id === 'string' ? id : '(unnamed)'} not installed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return installed;
}
