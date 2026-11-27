#!/usr/bin/env python3
"""#136 decision gate: build-derived cube imagery (B) vs browser-side virtual cube tiles (A).

Same source (Murray Lab CTX XYZ), same site and the same cube levels the browser run
reached. B is the existing offline adapter (scripts/terrain/cube_imagery.py xyz) building a
finite region around the camera from a fresh source cache; A is read from the browser
acceptance run (scripts/test-virtual-cube-imagery.mjs result.json, Mars site `gale`).

  /usr/bin/python3.12 scripts/compare-cube-imagery-delivery.py --browser work/virtual-cube-imagery/result.json \
      --work work/gate --out docs/validation/virtual-cube-imagery/gate.json

Reports wall time, upstream requests and bytes, stored objects and bytes, and extrapolates
B's object count and storage to a planet-wide native pyramid at the browser's level. It
does not publish anything.
"""
import argparse
import json
import math
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CTX = {'id': 'ctx-global', 'type': 'xyz', 'projection': 'EPSG:4326', 'levels': 13, 'dimension': 512, 'minZoom': 5,
       'url': 'https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{y}/{x}',
       'latitudeConvention': 'planetocentric', 'allowSourceFallback': True}
# The browser camera: 1.5 km above Gale, 40° field of view, 1400×900 px. A region is a disc per
# level; radii cover the viewport footprint (~1.8 km across) at fine levels and the cube
# tiles holding it at coarse ones, which is what the browser requests on the way down.
REGION = 'gale@-4.59,137.44:4=150,5=80,6=40,7=20,8=10,9=5,10=3,11=2,12=1.5,13=1.2'


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--browser', required=True, help='result.json of scripts/test-virtual-cube-imagery.mjs')
    p.add_argument('--work', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--workers', type=int, default=4)
    a = p.parse_args()
    work = Path(a.work); work.mkdir(parents=True, exist_ok=True)
    cache, out = work / 'source-cache', work / 'ctx-gale-built'
    if out.exists() or cache.exists():
        raise SystemExit(f'Use a fresh --work (found {out} or {cache})')
    config = work / 'ctx.json'
    config.write_text(json.dumps({**CTX, 'cache': str(cache)}, indent=2))
    started = time.time()
    subprocess.run([sys.executable, str(ROOT / 'scripts/terrain/cube_imagery.py'), 'xyz', '--source', str(config), '--out', str(out),
                    '--body', 'Mars', '--frame', 'IAU_MARS', '--radius-km', '3396.19', '--global-level', '0', '--region', REGION,
                    '--supersample', '2', '--workers', str(a.workers)], check=True, cwd=ROOT)
    wall = time.time() - started
    manifest = json.loads((out / 'imagery.json').read_text())
    tiles = manifest['tiles']
    levels = {}
    for t in tiles:
        level = int(t.split('/')[1]); levels[level] = levels.get(level, 0) + 1
    stored = sum(f.stat().st_size for f in (out / 'tiles').rglob('*') if f.is_file())
    responses = [f for f in cache.rglob('*.image')]
    upstream_bytes = sum(f.stat().st_size for f in responses)
    browser = json.loads(Path(a.browser).read_text())
    gale = browser['mars']['sites']['gale']
    virtual = next(v for v in gale['fine']['virtual'] if v['id'] == 'ctx-global')
    deepest = gale['layer']['level']
    finest_tiles = levels.get(max(levels), 0)
    per_tile = stored / max(1, len(tiles))
    planet = 6 * 4 ** deepest
    result = {
        'site': {'name': 'Gale crater', 'lat': -4.59, 'lon': 137.44, 'note': 'py/nx face seam'},
        'source': {k: CTX[k] for k in ('url', 'levels', 'dimension', 'minZoom', 'latitudeConvention')},
        'browserLevel': deepest,
        'B_buildDerived': {
            'region': REGION, 'wallSeconds': round(wall, 1), 'workers': a.workers, 'tiles': len(tiles), 'tilesByLevel': levels,
            'upstreamResponses': len(responses), 'upstreamBytes': upstream_bytes, 'storedObjects': len(tiles), 'storedBytes': stored,
            'meanTileBytes': round(per_tile), 'finestLevelTiles': finest_tiles,
            'planetWideAtBrowserLevel': {'tiles': planet, 'storedTB': round(planet * per_tile / 1e12, 1),
                                         'note': 'all six faces to the browser\'s deepest level, at this region\'s mean tile size; excludes coarser levels (+33 %)'},
        },
        'A_virtual': {
            'upstreamRequests': gale['upstreamRequests'], 'sourceCache': gale['fine']['imagery']['sourceCache'],
            'virtualTiles': gale['fine']['imagery']['virtualTiles'], 'storedObjects': 0, 'storedBytes': 0,
            'displayedLevel': deepest, 'displayedMetersPerPixel': gale['layer']['displayedMetersPerPixel'],
            'coverage': virtual['coverage'], 'gpu': browser['gpu'],
        },
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
