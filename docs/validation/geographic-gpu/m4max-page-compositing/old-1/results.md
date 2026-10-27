Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dense Jezero · vectors off | 1.71 | 1.74 |  | 0.7 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 3.05 | 3.08 | 1.34 | 1 | 11 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.99 | 1.04 |  | 0.2 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 6.79 | 7.75 | 5.80 | 0.3 | 1 | 6 | 1 | 177 |
| Rhine close · vectors off | 1.53 | 1.62 |  | 0.2 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 4.54 | 5.26 | 3.01 | 0.2 | 1 | 6 | 1 | 177 |
| Gale close · vectors off | 2.89 | 2.94 |  | 1.8 | 0 | 0 | 0 | 0 |
| Gale close · wide regions | 8.53 | 10.56 | 5.64 | 3.4 | 207 | 4 | 233 | 9 |
| Gale very close · vectors off | 2.68 | 2.78 |  | 0.9 | 0 | 0 | 0 | 0 |
| Gale very close · wide regions | 6.2 | 6.65 | 3.52 | 1.7 | 99 | 4 | 101 | 9 |
| Gale very close + contours · vectors off | 3.65 | 3.68 |  | 1 | 0 | 0 | 0 | 0 |
| Gale very close + contours · wide regions | 5.37 | 6.96 | 1.72 | 1.7 | 99 | 4 | 101 | 9 |
