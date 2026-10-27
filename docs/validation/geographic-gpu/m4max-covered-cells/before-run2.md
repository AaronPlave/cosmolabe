Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jezero close · vectors off | 1.35 | 1.43 |  | 0.5 | 0 | 0 | 0 | 0 |
| Jezero close · one point | 1.39 | 1.48 | 0.04 | 1.3 | 1 | 1 | 1 | 1 |
| Jezero close · one small polygon | 1.44 | 1.49 | 0.09 | 0.7 | 1 | 1 | 1 | 1 |
| Jezero close · polygon selected | 1.49 | 1.59 | 0.14 | 0.8 | 2 | 1 | 1 | 1 |
| Jezero close · 200 annotations | 3.95 | 4.1 | 2.60 | 0.8 | 1 | 4 | 1 | 200 |
| Dense Jezero · vectors off | 1.97 | 2.28 |  | 1.3 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 3.06 | 3.17 | 1.09 | 2.3 | 11 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.88 | 0.99 |  | 0.6 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 5.37 | 7.25 | 4.49 | 0.7 | 1 | 6 | 1 | 177 |
| Rhine close · vectors off | 0.82 | 1.56 |  | 0.5 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 14.66 | 15.43 | 13.84 | 0.3 | 1 | 6 | 1 | 177 |
