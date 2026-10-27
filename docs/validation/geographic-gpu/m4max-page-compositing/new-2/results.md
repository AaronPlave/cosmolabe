Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dense Jezero · vectors off | 1.7 | 1.72 |  | 0.7 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 3.09 | 3.11 | 1.39 | 1 | 11 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.56 | 1 |  | 0.3 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 6.73 | 7.55 | 6.17 | 0.3 | 1 | 6 | 1 | 177 |
| Rhine close · vectors off | 0.74 | 1.52 |  | 0.3 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 2.43 | 2.45 | 1.69 | 0.2 | 1 | 6 | 1 | 177 |
| Gale close · vectors off | 2.89 | 2.92 |  | 1.9 | 0 | 0 | 0 | 0 |
| Gale close · wide regions | 9.68 | 10.22 | 6.79 | 3.6 | 207 | 4 | 233 | 9 |
| Gale very close · vectors off | 2.68 | 2.7 |  | 0.9 | 0 | 0 | 0 | 0 |
| Gale very close · wide regions | 6.38 | 6.63 | 3.70 | 1.8 | 99 | 4 | 101 | 9 |
| Gale very close + contours · vectors off | 3.66 | 3.76 |  | 1.1 | 0 | 0 | 0 | 0 |
| Gale very close + contours · wide regions | 6.6 | 6.93 | 2.94 | 1.8 | 99 | 4 | 101 | 9 |
