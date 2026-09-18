// Relay: the same library worker as spice-cache-relay, under its own entry
// point so the geometry worker and the trajectory-cache worker are separately
// identifiable.
//
// They run identical code, so one relay would do. What a shared entry point
// costs is attribution: a worker is named by its script URL, in DevTools and in
// performance.measureUserAgentSpecificMemory() alike, so two workers built from
// one script appear as a single realm holding the sum of both. That is not a
// cosmetic problem -- each of these holds its own CSPICE heap and its own copy
// of the catalog's SPKs, which for a mission-length kernel set is hundreds of
// megabytes, and telling them apart is the whole of knowing which one grew.
//
// The cost is a duplicated worker chunk in the bundle, which is small beside
// the kernels either instance loads.
import '@cosmolabe/three/src/workers/spice-cache.worker';
