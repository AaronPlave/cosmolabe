// Default SPICE Web Worker entry: runs CSPICE-WASM off the main thread so furnsh
// and geometry calls never block rendering. Bundler shells that need to control
// the wasm asset URL call installSpiceWorker directly (see worker-core.ts).

import { installSpiceWorker, type SpiceWorkerScope } from './worker-core.ts';

installSpiceWorker(self as unknown as SpiceWorkerScope);
