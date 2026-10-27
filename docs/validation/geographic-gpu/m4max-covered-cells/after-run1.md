Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jezero close · vectors off | 0.94 | 1.47 |  | 0.4 | 0 | 0 | 0 | 0 |
| Jezero close · one point | 1.39 | 1.57 | 0.45 | 0.9 | 1 | 1 | 1 | 1 |
| Jezero close · one small polygon | 1.46 | 2.87 | 0.52 | 0.7 | 1 | 1 | 1 | 1 |
| Jezero close · polygon selected | 1.5 | 1.77 | 0.56 | 0.9 | 2 | 1 | 1 | 1 |
| Jezero close · 200 annotations | 3.97 | 4.33 | 3.03 | 0.7 | 1 | 4 | 1 | 200 |
| Dense Jezero · vectors off | 1.76 | 1.84 |  | 1.2 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 3.1 | 3.21 | 1.34 | 2 | 11 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.9 | 1.01 |  | 0.3 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 6.85 | 8.56 | 5.95 | 1.1 | 1 | 6 | 1 | 177 |
| Rhine close · vectors off | 1.46 | 1.64 |  | 0.4 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 8.03 | 10.31 | 6.57 | 0.6 | 1 | 6 | 1 | 177 |
