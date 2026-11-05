// Bundles the embeddable workspace's public declarations into one
// self-contained `dist-embed/cosmolabe.d.ts`: hosts install only this
// package, so types from the workspace packages are inlined, not imported.
import { dts } from 'rollup-plugin-dts';

export default {
  input: 'src/embed-types.ts',
  output: { file: 'dist-embed/cosmolabe.d.ts', format: 'es' },
  plugins: [dts({ includeExternal: ['@cosmolabe/core', '@cosmolabe/control', '@cosmolabe/interop'], tsconfig: 'tsconfig.json' })],
};
