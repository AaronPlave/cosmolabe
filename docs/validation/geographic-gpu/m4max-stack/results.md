Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jezero close · vectors off | 0.51 | 1.41 |  | 0.4 | 0 | 0 | 0 | 0 |
| Jezero close · one point | 0.97 | 1.69 | 0.46 | 0.4 | 1 | 1 | 1 | 1 |
| Jezero close · one small polygon | 1.87 | 5.32 | 1.36 | 0.4 | 1 | 1 | 1 | 1 |
| Jezero close · polygon selected | 2.12 | 3.58 | 1.61 | 0.4 | 2 | 1 | 1 | 1 |
| Jezero close · 200 annotations | 1.78 | 3.47 | 1.27 | 0.3 | 4 | 4 | 1 | 200 |
| Mars disk · vectors off | 0.43 | 1.13 |  | 0.3 | 0 | 0 | 0 | 0 |
| Mars disk · one small polygon | 1.21 | 3.71 | 0.78 | 0.3 | 1 | 1 | 1 | 1 |
| Mars disk · 200 annotations | 4.25 | 7.95 | 3.82 | 0.3 | 4 | 4 | 1 | 200 |
| Dense Jezero · vectors off | 1.7 | 2.01 |  | 0.8 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 9.15 | 10.01 | 7.45 | 2.1 | 612 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.95 | 1.06 |  | 0.3 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 6.21 | 7.05 | 5.26 | 0.4 | 6 | 6 | 1 | 177 |
| Rhine close · vectors off | 1.56 | 1.67 |  | 0.3 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 15.51 | 15.71 | 13.95 | 0.3 | 6 | 6 | 1 | 177 |
| Gale regional · vectors off | 2.6 | 2.89 |  | 2.4 | 0 | 0 | 0 | 0 |
| Gale regional · wide regions | 4.31 | 10.04 | 1.71 | 5 | 1004 | 4 | 251 | 9 |
| Gale close · vectors off | 2.96 | 3 |  | 2.2 | 0 | 0 | 0 | 0 |
| Gale close · wide regions | 8.69 | 9.28 | 5.73 | 4.4 | 932 | 4 | 233 | 9 |
| Jezero terrain · vectors off | 1.7 | 1.72 |  | 0.7 | 0 | 0 | 0 | 0 |
| Jezero terrain · vectors on | 8.56 | 9.1 | 6.86 | 1 | 68 | 1 | 68 | 15 |
