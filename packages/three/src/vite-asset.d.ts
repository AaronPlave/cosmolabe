// Vite asset-URL imports used by the worker entries, e.g.
// 'cspice-wasm/wasm/cspice.wasm?url'. Vite rewrites the suffix to the emitted
// asset's URL at bundle time; this ambient declaration is what tsc sees, since
// the specifier has no real module behind it.
declare module '*?url' {
  const url: string;
  export default url;
}
