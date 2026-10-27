Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dense Jezero · vectors off | 1.72 | 1.75 |  | 0.8 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 4.87 | 6.09 | 3.15 | 1.8 | 99 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.98 | 1.04 |  | 0.3 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 6.38 | 7.56 | 5.40 | 0.4 | 6 | 6 | 1 | 177 |
| Rhine close · vectors off | 1.53 | 1.62 |  | 0.3 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 15.43 | 15.79 | 13.90 | 0.3 | 6 | 6 | 1 | 177 |
| Gale regional · vectors off | 2.66 | 2.94 |  | 2.3 | 0 | 0 | 0 | 0 |
| Gale regional · wide regions | 2.51 | 3.49 | -0.15 | 5.2 | 552 | 4 | 251 | 9 |
| Gale close · vectors off | 2.99 | 3.02 |  | 2.5 | 0 | 0 | 0 | 0 |
| Gale close · wide regions | 6.96 | 9.03 | 3.97 | 5.4 | 828 | 4 | 233 | 9 |
| Gale very close · vectors off | 0.78 | 2.04 |  | 1.2 | 0 | 0 | 0 | 0 |
| Gale very close · wide regions | 5.04 | 5.49 | 4.26 | 2.5 | 396 | 4 | 101 | 9 |
| Gale very close + contours · vectors off | 1.09 | 3.73 |  | 1.2 | 0 | 0 | 0 | 0 |
| Gale very close + contours · wide regions | 5.41 | 7.56 | 4.32 | 2.7 | 396 | 4 | 101 | 9 |
