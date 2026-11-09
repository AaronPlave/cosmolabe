# Mission plugins

A mission plugin is an ordinary renderer plugin (`RendererPlugin`: lifecycle hooks plus the structured `ui` slots such
as `infoSections`) that adds something specific to one mission's scene. It is **trusted host code**, never catalog code:
a catalog is data, names no module, and loads fine without the plugin (#296).

## How the viewer installs them

1. A mission lives in its own package, `packages/mission-<name>/`, outside `@cosmolabe/core`, `@cosmolabe/three` and the
   viewer app. Example: [`packages/mission-iss`](../packages/mission-iss/README.md).
2. It exports a registration from `src/registration.ts` (type `MissionPluginRegistration` in `@cosmolabe/three`):
   - `id`: stable name;
   - `appliesTo(universe)`: does this loaded scene have what the plugin works on (for ISS, a body drawing the ISS model)?
   - `create()`: a fresh plugin for one scene.
3. `apps/viewer/src/lib/mission-plugins.ts` finds every `packages/mission-*/src/registration.ts` at build time and, right after
   the scene's renderer is built (`loader.ts`), calls `installMissionPlugins`. It installs only the registrations whose
   `appliesTo` accepts the scene, so an unrelated catalog never inherits a plugin. A registration that throws disables only itself.
4. The renderer owns the plugin from `renderer.use`. Scene teardown disposes plugins (the renderer and the universe both
   do, so `dispose()` must be idempotent). A new scene gets a new plugin; nothing is kept across catalogs.

The viewer names no mission. Adding a mission means adding a package, not editing viewer code.

## Embedding hosts

The embeddable workspace uses the same loader, so it installs the same built-in plugins for catalogs that apply. A host that
builds its own `UniverseRenderer` registers the same plugin itself:

```ts
import { registration } from '@cosmolabe/mission-iss';
const universe = /* loaded as usual */;
if (registration.appliesTo(universe)) renderer.use(registration.create());
```

Three things stay separate: scene data (the catalog), trusted executable host code (the plugin), and user-supplied
catalogs (which can only supply data).
