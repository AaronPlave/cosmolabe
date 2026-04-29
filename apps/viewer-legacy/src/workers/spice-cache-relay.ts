// Relay: import the library worker to run its self.onmessage setup.
// Vite bundles this as a separate worker entry point, resolving all imports.
import '@cosmolabe/three/src/workers/spice-cache.worker';
