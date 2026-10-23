Resolution 1280×720, ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jezero close · vectors off | 50.84 | 66.96 |  | 1 | 0 | 0 | 0 | 0 |
| Jezero close · one point | 61.77 | 94.59 | 10.93 | 1.2 | 1 | 1 | 1 | 1 |
| Jezero close · one small polygon | 61.61 | 92.95 | 10.77 | 1.1 | 1 | 1 | 1 | 1 |
| Jezero close · polygon selected | 66.69 | 88.52 | 15.85 | 1.2 | 2 | 1 | 1 | 1 |
| Jezero close · 200 annotations | 286.38 | 324.42 | 235.54 | 1.2 | 4 | 4 | 1 | 200 |
| Mars disk · vectors off | 42.2 | 60.95 |  | 0.9 | 0 | 0 | 0 | 0 |
| Mars disk · one small polygon | 51.19 | 79.14 | 8.99 | 1 | 1 | 1 | 1 | 1 |
| Mars disk · 200 annotations | 193.92 | 246.69 | 151.72 | 1.1 | 4 | 4 | 1 | 200 |
| Dense Jezero · vectors off | 49.34 | 68.1 |  | 0.8 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 235.88 | 265.46 | 186.54 | 1.4 | 9 | 9 | 1 | 1601 |
| Earth orbit · vectors off | 44.57 | 61.06 |  | 0.9 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 1293.24 | 1398.57 | 1248.67 | 1.7 | 6 | 6 | 1 | 177 |
| Rhine close · vectors off | 77.82 | 92.33 |  | 0.9 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 1940.35 | 2114.97 | 1862.53 | 1.5 | 6 | 6 | 1 | 177 |
