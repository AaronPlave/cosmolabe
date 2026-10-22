// Isolated viewer for generated build artifacts. The normal app and renderer
// run unchanged; bound CSS discovery to viewer source and ignore generated data.
import { createServer } from 'vite';
import { resolve } from 'node:path';
const server=await createServer({root:resolve('apps/viewer'),configFile:resolve('apps/viewer/vite.config.ts'),
  plugins:[{name:'pilot-bounded-css-scan',enforce:'pre',transform(code,id){
    if(id.endsWith('/src/app.css'))return code.replace('@import "tailwindcss";','@import "tailwindcss" source(none);\n@source "./";');
  }}],
  server:{host:'127.0.0.1',port:Number(process.env.PILOT_VIEWER_PORT??5187),strictPort:true,
    watch:{ignored:['**/test-catalogs/data/**','**/work/**','**/scripts/**']}}});
await server.listen();server.printUrls();
