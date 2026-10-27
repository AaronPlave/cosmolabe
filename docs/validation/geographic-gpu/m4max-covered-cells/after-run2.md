Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jezero close · vectors off | 1.33 | 1.4 |  | 0.4 | 0 | 0 | 0 | 0 |
| Jezero close · one point | 1.37 | 1.38 | 0.04 | 1 | 1 | 1 | 1 | 1 |
| Jezero close · one small polygon | 1.44 | 1.52 | 0.11 | 0.8 | 1 | 1 | 1 | 1 |
| Jezero close · polygon selected | 1.5 | 1.54 | 0.17 | 0.9 | 2 | 1 | 1 | 1 |
| Jezero close · 200 annotations | 3.98 | 4.48 | 2.65 | 0.8 | 1 | 4 | 1 | 200 |
| Dense Jezero · vectors off | 2.02 | 2.23 |  | 1.2 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 3.62 | 3.76 | 1.60 | 2.3 | 11 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 1.01 | 1.06 |  | 0.8 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 6.17 | 8.52 | 5.16 | 0.9 | 1 | 6 | 1 | 177 |
| Rhine close · vectors off | 1.44 | 1.48 |  | 0.6 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 5.44 | 7.46 | 4.00 | 0.8 | 1 | 6 | 1 | 177 |
