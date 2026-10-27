Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jezero close · vectors off | 1.4 | 1.83 |  | 1.3 | 0 | 0 | 0 | 0 |
| Jezero close · one point | 1.23 | 1.43 | -0.17 | 1 | 1 | 1 | 1 | 1 |
| Jezero close · one small polygon | 1.44 | 1.74 | 0.04 | 0.5 | 1 | 1 | 1 | 1 |
| Jezero close · polygon selected | 1.5 | 1.73 | 0.10 | 0.5 | 2 | 1 | 1 | 1 |
| Jezero close · 200 annotations | 3.94 | 4.15 | 2.54 | 0.9 | 1 | 4 | 1 | 200 |
| Dense Jezero · vectors off | 1.73 | 1.82 |  | 1.2 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 3.06 | 3.34 | 1.33 | 1.7 | 11 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 1.09 | 1.34 |  | 0.8 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 7.02 | 8.39 | 5.93 | 0.9 | 1 | 6 | 1 | 177 |
| Rhine close · vectors off | 1.46 | 1.88 |  | 1 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 14.86 | 15.03 | 13.40 | 0.3 | 1 | 6 | 1 | 177 |
