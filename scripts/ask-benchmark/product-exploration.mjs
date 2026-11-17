/** Frozen #380 product acceptance additions, before product runtime reruns.
 * Original exploration.mjs cases remain unchanged. No tool-scripted prompts. */
export const productExplorationCases = [
  { id:'oem-discover', catalog:'oem-ingest', assessment:true,
    turns:["I'm unfamiliar with this scene. Choose a question the loaded data can answer, investigate it, and show me what you found."],
    rubric:'Inspect scene/source evidence; choose a supported question; show useful native scene and profile/event evidence; explain imported source interval, gaps and center/surface limits. A preset alone is partial.' },
  { id:'clipper-discover', catalog:'europa-clipper', assessment:true,
    turns:["I'm unfamiliar with this scene. Choose a question the loaded data can answer, investigate it, and show me what you found."],
    rubric:'Inspect loaded evidence; choose a defensible question; use native analysis and compose an informative scene/time/result view, disclosing coverage and unknown prediction/reconstruction provenance. No science from instrument configuration.' },
];

/** #381 reproduction: a saved Titan result, then a different-epoch distance question, then a comparison.
 * `seed` runs the native closest-approach search before the first turn, as the person had in the screenshot. */
export const followupCases = [
  { id:'cassini-saturn-followup', catalog:'cassini-soi', assessment:true, seed:{ closestApproach:{ observer:'Cassini', target:'Titan', label:'Closest approach: Cassini / Titan' } },
    turns:['Show me what Closest approach: Cassini / Titan found and help me understand it.',
      'show me when cassini is furthest from saturn after initial orbit insertion',
      'compare that with the Titan encounter'],
    rubric:'Turn 2 must not fail on a clock/event goal held from turn 1; must report Cassini–Saturn distance (center range) at the farthest sampled/covered point after a genuinely sourced insertion epoch or explicitly after the first observed Saturn periapsis in loaded data (never equate that proxy with insertion), scoped to loaded coverage. Turn 3 compares the two without resurrecting a stale time/camera obligation.' },
  { id:'clipper-europa-followup', catalog:'europa-clipper', assessment:true, seed:{ closestApproach:{ observer:'Europa Clipper', target:'Europa', label:'Closest approach: Europa Clipper / Europa' } },
    turns:['Show me what Closest approach: Europa Clipper / Europa found and help me understand it.',
      'show me when clipper is farthest from jupiter',
      'compare that with the Europa encounter'],
    rubric:'Same shape on a second catalog/object: no stale goal failure; requested quantity is Clipper–Jupiter center distance over loaded coverage; comparison stays grounded.' },
];
