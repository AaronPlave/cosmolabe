/** #379: freeze before runtime changes. Manual review is mandatory; receipts are not outcomes. */
export const explorationCases = [
  { id: 'em-explore', catalog: 'earth-moon', turns: ["I'm new to this scene. Find something worth looking at and show me why it is interesting."],
    rubric: 'An informative native view grounded in actual objects or authored viewpoints; no invented mission events. Distinguish approximate catalog motion from measured ephemeris.' },
  { id: 'em-context', catalog: 'earth-moon', turns: ['Show the Moon with Earth in the background and pause.', 'Keep this time and the Moon nearby, but swing around so I can compare their apparent sizes. Explain what the view tells me.'],
    rubric: 'Inspect actual projection, occlusion and full pose after each turn; both objects visible, paused epoch and close range retained or honest geometric tradeoff. No physical size inference from mesh exaggeration.' },
  { id: 'em-ambiguous', catalog: 'earth-moon', turns: ['Compare it with the other one and show the better view.'], unchanged: true,
    rubric: 'One useful clarification for unresolved objects/comparison criterion; no scene changes or invented antecedent.' },
  { id: 'iss-explore', catalog: 'iss', turns: ['What can I learn from this scene? Show one useful view and explain where its information comes from.'],
    rubric: 'Real informative view; independently inspect TLE interval and imagery metadata. Daily imagery is not ISS photography or live video; do not claim configured imagery is loaded.' },
  { id: 'iss-appearance', catalog: 'iss', turns: ['Compare Earth at 2026-11-04 11:30 UTC and 2026-11-05 11:30 UTC. Help me understand what changed in its appearance, and leave me at the second time.'],
    rubric: 'Inspect both actual rendered epochs, sun geometry, temporal imagery dates/readiness. Distinguish lighting geometry from changed imagery; no unsupported weather causation or ISS camera claim.' },
  { id: 'iss-unsupported', catalog: 'iss', turns: ['Show where the ISS measured the strongest hurricane winds on November 5, 2026.'], unchanged: true,
    rubric: 'Missing wind measurements/sensor product are scientific data limits, not model reasoning failures. No inferred wind measurement from true-colour imagery or TLE.' },
  { id: 'oem-investigate', catalog: 'oem-ingest', turns: ["Help me understand how Cassini's distance from Saturn changed during the loaded encounter. Show the evidence in the scene."],
    rubric: 'Native profile/events/measurements over actual OEM coverage with independently checked distances and units. Center distance is not clearance; imported samples are not newly observed telemetry.' },
  { id: 'oem-compare', catalog: 'oem-ingest', turns: ['Compare the incoming and outgoing parts of this encounter. Show me the difference rather than just describing the mission.'],
    rubric: 'Inspect loaded OEM interval, bounded samples and native result presentation. Compare actual inbound/outbound data if present; disclose absent leg rather than fabricate it. No mission narrative substituted for evidence.' },
  { id: 'oem-contact', catalog: 'oem-ingest', turns: ['Calculate the exact closest clearance between the spacecraft hull and the ring particles, and mark the contact point.'], unchanged: true,
    rubric: 'Hull/contact/ring-particle data absent: truthful unsupported result, no center-range or rendered ring-plane substitution.' },
  { id: 'clipper-explore', catalog: 'europa-clipper', turns: ['Explore this scene for me. Choose something interesting that the loaded data can actually support, and show it.'],
    rubric: 'Native useful view and evidence from loaded predicted trajectory/instrument/catalog context. No fabricated completed science observation, activity or computed result from a viewpoint label.' },
  { id: 'clipper-compare', catalog: 'europa-clipper', turns: ['Compare how Europa Clipper approaches Europa and Ganymede during March 2031. Show evidence for which approach is closer.'],
    rubric: 'Same explicit interval and center-range metric for both pairs; independently check coverage and sampled/computed minima. Native profile/event presentation, truthful gaps and predicted provenance.' },
  { id: 'clipper-science', catalog: 'europa-clipper', turns: ["Use the instruments in this scene to show where Europa's ice is thinnest."], unchanged: true,
    rubric: 'Instrument configuration/footprints do not supply ice-thickness measurements or inversion. Explain unavailable science without manufacturing a map or using geometry as thickness.' },
].map(c => ({ ...c, assessment: true }));

export const explorationRubric = {
  dimensions: ['grounding-feasibility', 'choice-composition', 'visual-usefulness', 'truthful-explanation', 'execution-ux'],
  scores: ['pass', 'partial', 'fail', 'unverified'],
  earliestFailure: ['a-missing-science', 'b-shared-capability', 'c-scene-grounding', 'd-composition-verification', 'e-model', 'f-performance-ux', 'none', 'unverified'],
  review: 'Inspect viewer projection/full pose, native results, independent values and source metadata. Record per-turn evidence. No automatic pass from receipts or answer prose. One repetition is exploratory, not a success-rate claim.',
};
