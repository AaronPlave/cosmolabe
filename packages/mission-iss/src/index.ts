// Public surface for hosts that wire the optional live telemetry (#371) or articulate by hand.
export { IssArticulationPlugin, APPROXIMATE_LABEL, usesIssModel } from './plugin.js';
export type { JointSource, JointSourceStatus, ArticulationMode, ArticulationStatus } from './plugin.js';
export { sunTrackingAngles, sunTrackingJointAngles, TRUSS_JOINTS, ARRAY_JOINTS } from './joints.js';
export type { IssJointAngles } from './joints.js';
export { createLiveIssFeed } from './live/source.js';
export type { LiveIssConfig, LiveIssFeed, LiveIssStatus, LiveIssOptions, JointChannels } from './live/source.js';
export { issLiveConfig, issLiveTransportConfig, CANDIDATE_JOINT_ITEMS, ISS_ATTITUDE_ITEMS } from './live/channels.js';
export { lightstreamerTransport, ReplayTransport } from './live/transport.js';
export { fetchCelestrakIss } from './live/orbit.js';
export { default as registration } from './registration.js';
