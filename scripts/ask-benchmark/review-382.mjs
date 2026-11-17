/** Focused natural-language acceptance requested in PR #382. */
export const review382Cases = [
  { id: 'clipper-boundary-maximum', catalog: 'europa-clipper', assessment: true,
    turns: ['Show me when Europa Clipper is farthest from Jupiter between 2030-01-01 and 2030-01-02.'],
    rubric: 'A monotonic interval selects the largest evaluated coverage boundary, reports range and UTC, distinguishes it from a turning point, and discloses step/coverage limits. Inspect native selected result and epoch.' },
  { id: 'ingenuity-belva', catalog: 'ingenuity-jezero', assessment: true,
    turns: ['What is the current distance from Ingenuity to Belva crater’s mapped reference point?', 'When was Ingenuity closest to that mapped point?'],
    rubric: 'Current distance uses the shared mapped-point numerical read, epoch, frame/datum, unknown accuracy and point/rim distinction. Closest-time is separate and unsupported: no invented numbers, accuracy or time minimum.' },
];
