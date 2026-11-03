/** Shared event selection refuses stale numerical results, including timeline
 * and 3D marker clicks. Guards are local callbacks, never serialized. */
export const analysisResultGuards = new Map<string, () => boolean>();
