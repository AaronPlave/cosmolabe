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
