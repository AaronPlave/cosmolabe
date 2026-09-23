# Catalog sources and indexes

A viewer deployment tells the welcome screen which catalogs to offer through
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
      "group": "Mission"
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

- **Each source** has an `id` (unique), a `name` (display, defaults to `id`),
  and an `indexUrl`. A relative `indexUrl` resolves against the viewer's base
  URL (`VITE_BASE`).
- **`[]`** means no sources. The welcome screen then shows only the file drop
  target. This suits a bare viewer or an embed.
- **Unset** is the same as `[]`. The viewer never assumes a source exists,
  Examples included. `npm run dev` lists the repository's examples because
  `apps/viewer/.env.development` configures them. Vite reads that file only
  for the dev server, so production builds don't see it. Override it locally
  in `.env.development.local`.
- **`VITE_ALLOW_CATALOG_SOURCE_PARAM=true`** lets a visitor add more sources
  at runtime with `?source=<indexUrl>` (the parameter can repeat). It is off
  by default, because whether to accept arbitrary external sources is a
  choice for each deployment to make.

Typical setups:

| Deployment | `VITE_CATALOG_SOURCES` |
|---|---|
| Public Cosmolabe site | `[{"id":"examples","name":"Examples","indexUrl":"index.json"}]` (see `.github/workflows/deploy-pages.yml`) |
| Mission | That mission's source(s) only |
| Controlled / multi-team | Mission sources plus shared or reference sources |
| Bare viewer / embed | `[]` |

## Listed is not the same as served

Sources control which catalogs the welcome screen **lists**. They don't
control which files a build **serves**. The viewer's Vite `publicDir` is
`apps/viewer/test-catalogs/`, so every build ships the repository examples,
including a mission build whose only source is the mission's own. Anyone who
knows a path can still load those examples, for example with
`?catalog=cassini-soi`.

You can't fix this by switching `publicDir` off for a mission build. The same
directory holds assets the viewer itself needs, such as the star catalog
`stars.bin`. Keeping the examples out of a build first needs the app's own
assets separated from the example content.

## Failure isolation

The viewer fetches every source concurrently and shows each one as soon as it
settles. A source that can't be fetched, isn't JSON, or fails validation shows
its error under its own name. The other sources, dropped files and folders,
and `?catalog=<name>` keep working.

## Direct loading is independent

Sources only change what the welcome screen lists. These still work with any
source configuration, including `[]`:

- `?catalog=<name>` loads `<name>.json` relative to the viewer. The
  visual-regression harness uses this.
- Dropping a catalog folder or files onto the viewer, or browsing for them.

## The repository examples

The example catalogs stay at their existing paths in
`apps/viewer/test-catalogs/`, and tests keep loading them directly.
`test-catalogs/index.json` is the Examples index and refers to those same
files. A unit test (`apps/viewer/src/lib/__tests__/catalog-sources.test.ts`)
checks that every entry resolves to a catalog file that exists. When you add
an example catalog, add an entry for it there.
