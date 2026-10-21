#!/usr/bin/env python3
"""Build separate, bounded Mars imagery products from the existing catalog sources.

Not a production catalog migration (#246/#247) or a global native-resolution bake.
Original responses are cached outside the products. Repeat with --only to rebuild
one source; use a fresh --out for different coverage. No terrain output is touched.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--out', default=str(ROOT / 'apps/viewer/test-catalogs/data/mars-imagery-cube'))
p.add_argument('--cache', default='/tmp/cosmolabe-mars-source-images')
p.add_argument('--workers', type=int, default=4)
p.add_argument('--only', choices=['viking', 'ctx-global', 'jezero-ctx', 'jezero-hirise'])
a = p.parse_args()
catalog = json.loads((ROOT / 'apps/viewer/test-catalogs/ingenuity-jezero.json').read_text())
layers = next(i for i in catalog['items'] if i['name'] == 'Mars')['geometry']['imagery']
for source in layers:
    if a.only and source['id'] != a.only:
        continue
    target = Path(a.out) / source['id']
    if target.exists():
        raise SystemExit(f'Output already exists: {target}; use a fresh --out')
    config = {**source, 'latitudeConvention': 'planetocentric', 'cache': os.path.abspath(a.cache), 'allowSourceFallback': True}
    config_file = Path(a.cache) / (source['id'] + '.json')
    config_file.parent.mkdir(parents=True, exist_ok=True)
    config_file.write_text(json.dumps(config, indent=2))
    command = [sys.executable, str(ROOT / 'scripts/terrain/cube_imagery.py'), 'xyz', '--source', str(config_file),
               '--out', str(target), '--body', 'Mars', '--frame', 'IAU_MARS', '--radius-km', '3396.19',
               '--global-level', '1' if source['id'] == 'viking' else '0', '--supersample', '2', '--workers', str(a.workers)]
    if source['id'] != 'viking':
        levels = '1=80,2=60,3=40,4=20,5=10,6=5,7=2,8=1,9=.5,10=.5,11=.35,12=.25,13=.2'
        if source['id'] == 'jezero-hirise':
            levels += ',14=.15,15=.08,16=.04,17=.02'
        command += ['--region', 'inside@18.4447,77.4508:' + levels]
        if source['id'] == 'ctx-global':
            command += ['--region', 'outside@18.9,77.4:' + levels]
    subprocess.run(command, check=True, cwd=ROOT)
