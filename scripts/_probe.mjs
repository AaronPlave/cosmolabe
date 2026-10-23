import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 960, height: 600 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
p.on('console', m => { if (m.type() !== 'debug' && m.type() !== 'log') console.log(m.type(), m.text().slice(0, 300)); });
await p.goto('http://127.0.0.1:5188/?test=1&catalog=test-catalogs/geographic-vectors-mars-streamed');
await p.waitForTimeout(40000);
console.log(await p.evaluate(() => ({ r: !!window.renderer, n: window.renderer?.geographicVectors.featureCount, loads: window.renderer?.universe.geographicLayers.loads.map(l => [l.id, l.status, l.diagnostics?.slice(0,2)]), diag: window.renderer?.geographicVectors.diagnostics.slice(0,3) })));
await b.close();
