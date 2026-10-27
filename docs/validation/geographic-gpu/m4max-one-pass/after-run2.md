Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dense Jezero · vectors off | 0.47 | 1.24 |  | 0.8 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 0.73 | 2.55 | 0.26 | 1.1 | 11 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.46 | 0.99 |  | 0.3 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 7.2 | 9.16 | 6.74 | 0.3 | 1 | 6 | 1 | 177 |
| Rhine close · vectors off | 0.84 | 1.62 |  | 0.3 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 15.51 | 16.98 | 14.67 | 0.3 | 1 | 6 | 1 | 177 |
| Gale regional · vectors off | 2.8 | 2.86 |  | 2.3 | 0 | 0 | 0 | 0 |
| Gale regional · wide regions | 2.34 | 2.73 | -0.46 | 3.8 | 138 | 4 | 251 | 9 |
| Gale close · vectors off | 1.79 | 3.02 |  | 2.2 | 0 | 0 | 0 | 0 |
| Gale close · wide regions | 6.22 | 7.27 | 4.43 | 3.9 | 207 | 4 | 233 | 9 |
| Gale very close · vectors off | 1.1 | 2.68 |  | 1.3 | 0 | 0 | 0 | 0 |
| Gale very close · wide regions | 4.22 | 5.68 | 3.12 | 2 | 99 | 4 | 101 | 9 |
| Gale very close + contours · vectors off | 3.67 | 3.83 |  | 1.2 | 0 | 0 | 0 | 0 |
| Gale very close + contours · wide regions | 4.99 | 5.49 | 1.32 | 2 | 99 | 4 | 101 | 9 |
