# Mission activity metadata

Activities are versioned metadata, independent of bodies, trajectory samples, lines, terrain and GPU loading. They use the existing simulation clock, event inspector and TimelineDock. No service is involved.

```json
{
  "activities": [{
    "version": 1, "id": "mission:lander:descent:1",
    "name": "Authored descent", "kind": "descent",
    "vehicle": "Lander", "body": "Moon", "mission": "Example",
    "temporality": "interval", "timeSystem": "UTC",
    "start": "2028-12-15T10:00:00Z", "end": "2028-12-15T10:07:10Z",
    "provenance": {
      "source": "mission-demo/schedule", "version": "1",
      "authority": "authored", "timing": "exact",
      "limitations": "Authored example, not observed or predicted flight operations."
    }
  }]
}
```

`kind` is flight, drive, hop, descent, landing, phase or other. `temporality: instant` requires equal start/end; intervals require end > start. Both edges of an instant seek its one epoch. ET inputs require finite numeric seconds past J2000 TDB and `timeSystem: ET`. UTC inputs require ISO timestamps ending in Z; the catalog loader uses furnished SPICE `str2et`, otherwise core's shared UTC/ET conversion. The returned records always contain ET bounds. The fallback has the same documented approximation as the existing simulation clock; metadata is not a clock calibration.

`enabled: false` retains records for discovery but disables selection, seeking and previous/next participation.

Stable IDs must be unique across loaded providers/catalogs. Required provenance is source URL/identifier, version, authority (observed/authored/estimated/inferred), timing (exact/estimated/bounded), and explicit limitations. Optional `uncertaintySeconds` is nonnegative. Optional mission/site/parent/group and `references` (trajectory, sourceSegment, location, viewpoint, objects) describe associations; no reference is required or implicitly executed. The vehicle/body IDs may precede the objects they name. A sourceSegment is a reference, not a request to load geometry.

Missing metadata means operations are unknown. An explicitly supplied empty list means no activities in that metadata, **not verified vehicle inactivity**. Gaps likewise say nothing about unrecorded operations. A bounded record is a discovery window, not a duration of motion; the UI labels this distinction. There is no extrapolation beyond records.

## Provider/importer recipe

Use inline catalog `activities`, or import external records in process and call `parseMissionActivities(specs, optionalUtcToEt)` then `universe.activities.replace(providerId, records)`. Validation is atomic. The store validates again, copies/freezes records, rejects collisions, publishes sorted immutable records and notifies `subscribe()` listeners. Replace the same owner to remove obsolete IDs; replace with an empty list to unload it. Universe disposal clears all records. Viewer subscriptions dispose when the renderer is unbound. No fetch or per-frame importer runs. Catalog `require` can compose an activity-only catalog with scene catalogs using the existing loader.

Deriving records from trajectories is appropriate only when the source explicitly establishes semantic identity and actual bounds. Never turn generic arcs, parked intervals, pose changes or line visibility into operations. Importers should version their semantic mapping and describe estimated clocks or coarse date bounds.

## Navigation and presentation

Order is start ET, end ET, then stable ID (codepoint order). Previous/next steps relative to a selected record within the filter, including ties and overlaps. Without a selected record in the filter, next means start strictly after the clock; previous means the last start at/before it. No wrapping. Selection does not seek, pause playback, alter the camera or change trajectories. Seeking uses an explicit edge and does not select or move the camera. UI chooser and previous/next actions compose selection, pause, seek and a fitted window with 10% padding (minimum 1 second). Window independently applies the same fit. Selection clears prior event body highlights and synchronizes scene annotations without changing time or camera.

Expanded lanes group by vehicle and semantic kind. Up to four rows separate overlaps; dense windows use at most 200 representative marks per lane, with counts. Clicking an aggregate zooms into its time bin without selecting a representative or changing the clock. Exact records remain available in the chooser and host API. The chooser renders the first 200 matches and a search field for larger series. Compact mode uses one combined chooser. Labels carry only activity, date and (when needed) vehicle; complete times, source, limitations and advanced ET are in the inspector’s expandable Details. Bounded discovery windows use a faint band with a low edge accent, distinct from filled operational intervals; the inspector states that drive duration is unknown. Per-frame playhead work uses cached range geometry and binary navigation; imports, sorting, overlap assignment and density binning are record/window-change work.

## Built-in source audit

- Ingenuity: all 72 entries from the pinned `data/ingenuity/flights_index.json`. Original MMGIS event epochs are unchanged. Observed horizontal maps coexist with estimated 3D reconstruction; approximate J2000 interpretation and uncalibrated clock drift remain explicit. These bounds are not certified telemetry.
- MoonFall: 12 named hops and 12 landing milestones, across Polaris A–D, from the existing authored `scripts/moonfall-schedule.mjs`. The schedule and waypoint geometry are preserved. **The repository generator explicitly says these are not the mission's plan. No mission-provided operational schedule was established.** These are the catalog demo’s explicitly authored mission activities, using its existing named sortie schedule rather than arbitrary curve segments. An audited mission-provided operational schedule would be needed before representing actual or predicted flight operations. They also exercise analytic waypoints and instant milestones.
- Curiosity: two genuine drive reports: Dingo Gap crossing (Sol 535 / February 6, 2014) and the 41.1 m westward drive (Sol 538 / February 9). [NASA's February 11 release](https://www.nasa.gov/missions/mars-science-laboratory/curiosity-rover/nasas-curiosity-drives-on-after-crossing-martian-dune/) establishes operations and dates, **not exact start/end times**. Curated UTC discovery windows extend one day before/after each reported date to accommodate the unspecified time zone. Actual duration and exact operational timestamps remain unknown; SPICE poses are not used to invent them. Terrain and localization work stay in #247/#295.
- `fixtures/mission-activities.json`: synthetic concurrent flight and rover drive, plus manual descent and landing with no associated trajectory or scene object. This is explicitly not real mission data.

Run `node scripts/build-mission-activities.mjs` for a metadata-only refresh. It never rebuilds terrain or trajectories. MoonFall's generator consumes the same authored schedule and importer. Refresh the metadata after regenerating Ingenuity source indexes.

## Migration

`trajectoryPlot.timelineLabel` remains schema-compatible but is deprecated and no longer discovers runtime activities. The old `trajectory-timeline.ts` functions are migration helpers only. There is deliberately no silent fallback that fabricates activities for a catalog without records. Third-party catalogs should add explicit records; existing trajectory evaluation and rendering are unchanged. No removal date is imposed until external consumers have migrated.
