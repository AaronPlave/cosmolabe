Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jezero close · vectors off | 1.39 | 1.58 |  | 1.3 | 0 | 0 | 0 | 0 |
| Jezero close · one point | 1.39 | 1.57 | 0.00 | 0.7 | 1 | 1 | 1 | 1 |
| Jezero close · one small polygon | 1.46 | 1.65 | 0.07 | 1.3 | 1 | 1 | 1 | 1 |
| Jezero close · polygon selected | 1.51 | 1.69 | 0.12 | 0.5 | 2 | 1 | 1 | 1 |
| Jezero close · 200 annotations | 1.47 | 1.91 | 0.08 | 0.3 | 4 | 4 | 1 | 200 |
| Mars disk · vectors off | 0.99 | 1.11 |  | 1.1 | 0 | 0 | 0 | 0 |
| Mars disk · one small polygon | 1.01 | 1.14 | 0.02 | 1.3 | 1 | 1 | 1 | 1 |
| Mars disk · 200 annotations | 1.24 | 2.34 | 0.25 | 0.3 | 4 | 4 | 1 | 200 |
| Dense Jezero · vectors off | 1.77 | 1.81 |  | 1.2 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 4.56 | 4.65 | 2.79 | 1.4 | 99 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.99 | 1.12 |  | 0.5 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 5.11 | 6.39 | 4.12 | 0.9 | 6 | 6 | 1 | 177 |
| Rhine close · vectors off | 1.47 | 1.55 |  | 0.7 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 15 | 15.11 | 13.53 | 0.2 | 6 | 6 | 1 | 177 |
| Gale regional · vectors off | 2.82 | 2.85 |  | 2.5 | 0 | 0 | 0 | 0 |
| Gale regional · wide regions | 6.29 | 6.69 | 3.47 | 4.7 | 552 | 4 | 251 | 9 |
| Gale close · vectors off | 2.86 | 3.06 |  | 2.8 | 0 | 0 | 0 | 0 |
| Gale close · wide regions | 6.52 | 6.94 | 3.66 | 5.4 | 828 | 4 | 233 | 9 |
| Jezero terrain · vectors off | 1.73 | 1.8 |  | 1.1 | 0 | 0 | 0 | 0 |
| Jezero terrain · vectors on | 6.16 | 6.54 | 4.43 | 2.7 | 13 | 1 | 68 | 15 |
