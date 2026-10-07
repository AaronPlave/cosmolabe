# Catalog sources and indexes

A viewer deployment tells the home screen and the catalog browser which catalogs to offer through
zero or more **catalog sources**. Each source points at an **index**: a small,
versioned JSON file listing catalogs by name. The entries point at ordinary
[catalog JSON](catalog-format.md). Nothing about the catalogs changes.

The index is only for discovery. It is not a scene format, and loading an
entry is the same as loading that catalog directly. A catalog's dependencies
still come from its own `require` array. The index names the top-level
choices, and the catalogs own their dependency graph. An entry's models,
textures and kernels resolve against the catalog file itself, not the index
(see [asset paths](catalog-format.md#asset-paths)).

> **Cosmographia.** Cosmographia has no equivalent layer: it opens individual
> catalog files (*File → Open Catalog…* or the command line) and composes them
> with `require`. Sources and indexes are a Cosmolabe addition on top of that.
> A Cosmographia catalog listed in an index loads exactly as it would if opened
> directly.

## Index format (version 1)

```json
{
  "version": 1,
  "name": "Europa Clipper",
  "description": "Mission catalogs",
  "catalogs": [
    {
      "id": "baseline",
      "name": "Baseline mission",
      "catalog": "./baseline.json",
      "description": "Jupiter science phase, 2031",
      "group": "Mission",
      "featured": true
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Format version. This viewer reads `1` and rejects any other value. |
| `name` | no | Display name for the index. |
| `description` | no | One-line description. |
| `catalogs` | yes | The entries, in display order. |
| `catalogs[].id` | yes | Identifier, unique within the index. |
| `catalogs[].catalog` | yes | URL of the entry-point catalog. **Relative URLs resolve against the index's own URL**, the same way a catalog's relative paths resolve against the catalog's URL. |
| `catalogs[].name` | no | Display name. Defaults to `id`. |
| `catalogs[].description` | no | One-line description shown under the name. |
| `catalogs[].group` | no | Heading to list the entry under. Groups appear in the order they first occur. |
| `catalogs[].featured` | no | `true` lists the entry in the home screen's short "start with" list. With no featured entries in any source, the home screen lists the first few entries instead. |
| `catalogs[].script` | no | URL of a [viewer script](scripting.md) the script console opens and runs once the catalog has loaded — a scripted tour. Resolves like `catalog`. An invalid URL drops the script, not the entry. |

If the index as a whole is invalid (not an object, missing or unsupported
`version`, no `catalogs` array), that source reports an error. A single bad
entry (missing `id` or `catalog`, or a duplicate `id`) is skipped and logged
as a warning, and the rest of the index still loads.

## Configuring a deployment

Sources are set at build time through environment variables (see
`apps/viewer/.env.example` and `apps/viewer/src/lib/deployment.ts`):

```sh
VITE_CATALOG_SOURCES='[
  { "id": "mission", "name": "Europa Clipper", "indexUrl": "/catalogs/index.json" },
  { "id": "shared",  "name": "Shared",         "indexUrl": "/shared/index.json" }
]'
```

- **Each source** has an `id` (unique, and without `/`, since
  `?entry=<sourceId>/<entryId>` links split on the first one), a `name`
  (display, defaults to `id`),
  and an `indexUrl`. A relative `indexUrl` resolves against the viewer's base
  URL (`VITE_BASE`).
- **`[]`** means no sources. The home screen and the browser then offer only
  *Open local catalog…* and the file drop target. This suits a bare viewer or
  an embed.
- **Unset** is the same as `[]`. The viewer never assumes a source exists,
  Examples included. `npm run dev` lists the repository's examples because
  `apps/viewer/.env.development` configures them. Vite reads that file only
  for the dev server, so production builds don't see it. Override it locally
  in `.env.development.local`.
- **`VITE_ALLOW_CATALOG_SOURCE_PARAM=true`** lets a visitor add more sources
  at runtime with `?source=<indexUrl>` (the parameter can repeat). It is off
  by default, because whether to accept arbitrary external sources is a
  choice for each deployment to make. The same setting enables *Add catalog
  source…* in the catalog browser, which records the source as another `?source=`.
  A `?source=` source's id is `url-<n>`, from its position among the
  `source` parameters, so a source added at runtime keeps its id, and
  `?entry=` links into it keep working, across a reload.

Typical setups:

| Deployment | `VITE_CATALOG_SOURCES` |
|---|---|
| Public Cosmolabe site | `[{"id":"examples","name":"Examples","indexUrl":"test-catalogs/index.json"}]` (see `.github/workflows/deploy-pages.yml`) |
| Mission | That mission's source(s) only |
| Controlled / multi-team | Mission sources plus shared or reference sources |
| Bare viewer / embed | `[]` |

## Listed is not the same as served

Sources control which catalogs the viewer **lists**. They don't control which
files a build **serves**. Viewer-owned static assets live in
`apps/viewer/public/`; repository examples stay separate in
`apps/viewer/test-catalogs/` and are served under `/test-catalogs/` during
development. A production build includes examples only when
`VITE_BUNDLE_TEST_CATALOGS=1` is set. The public Pages build opts in; mission
and bare-viewer builds do not implicitly ship repository examples. This is
independent of `VITE_CATALOG_SOURCES`, which controls only what the UI lists.

The examples source URL is the relative `test-catalogs/index.json`, so it
resolves under the configured viewer base path on GitHub Pages and in local
development. Directly loading an example uses that same namespace, for example
`?catalog=test-catalogs/cassini-soi`.

## Where the catalogs appear

- **Home screen** (no scene up): a short list — featured entries, or the first
  few — plus *Browse …* for the full list and *Open local catalog…*. With one
  source the action is named after it (*Browse examples*); with several it is
  *Browse catalogs*. Browse stays available whenever a source exists, even if
  all entries fit in *Start with* or a source fails. With none there is nothing
  to browse.
- **Catalog browser**: one overlay with the full list, grouped, with each
  entry's description. It opens from the home screen's *Browse …* and, with a
  scene up, from the folder button at the top of the rail, `O`, or *Open
  catalog…* in the command palette. It also offers *Open local catalog…*, and
  *Add catalog source…* where `VITE_ALLOW_CATALOG_SOURCE_PARAM` permits it.
  Opening it leaves the home screen or the current scene alone underneath;
  choosing a catalog replaces the scene through the normal load. Desktop uses
  a large shared overlay; phones use a full-screen sheet.

The rail's *Catalog* tool is a different thing: it browses the bodies of the
catalog that is loaded, not the catalogs a deployment offers.

The sparse technical Home uses a renderer-backed animated Saturn backdrop,
with canonical Builtin rotation and frame behavior. Simulation time runs at
100× from 80 minutes before Dione's shadow mid-transit to 160 minutes after,
then resets (a 144-second presentation window). The fixed camera preserves
the diagonal rings and ring shadow. Home rendering pauses while the document
is hidden and releases the canvas before a real catalog scene takes over.

## Catalogs in the URL

Choosing a catalog adds a browser history entry, so back and forward move
between catalogs:

- A catalog served from the viewer's own origin is written as
  `?catalog=<path>` (for example `?catalog=test-catalogs/cassini-soi`), the same deep link
  the viewer has always read.
- A catalog on another origin is written as `?entry=<sourceId>/<entryId>`. It
  resolves only against a source the deployment configured, so a link can't
  point the viewer at an arbitrary catalog URL.
- A scene opened from local files has no URL; the catalog parameter is removed.
  Going back to a URL with no catalog parameter leaves the scene as it is.
- Back or Forward during a load is not dropped. The load finishes without
  adding a history entry, and then the scene follows the URL the user
  navigated to.
- An `?entry=` link waits only for the source it names, so a slow or broken
  source elsewhere doesn't hold it up.

## Failure isolation

The viewer fetches every source concurrently and shows each one as soon as it
settles. A source that can't be fetched, isn't JSON, or fails validation shows
its error under its own name. The other sources, dropped files and folders,
and `?catalog=<name>` keep working.

## Direct loading is independent

Sources only change what the viewer lists. These still work with any
source configuration, including `[]`:

- `?catalog=<name>` loads `<name>.json` relative to the viewer. Repository
  examples use the `test-catalogs/` prefix. The
  visual-regression harness uses this.
- Dropping a catalog folder or files onto the viewer, or browsing for them.

## The repository examples

The example catalogs stay at their existing paths in
`apps/viewer/test-catalogs/`, and tests keep loading them directly.
`test-catalogs/index.json` is served at `/test-catalogs/index.json` and refers
to those same files. A unit test (`apps/viewer/src/lib/__tests__/catalog-sources.test.ts`)
checks that every entry resolves to a catalog file that exists. When you add
an example catalog, add an entry for it there.
