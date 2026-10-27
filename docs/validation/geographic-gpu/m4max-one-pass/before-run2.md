Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dense Jezero · vectors off | 0.75 | 1.74 |  | 0.8 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 1.85 | 2.44 | 1.10 | 1.3 | 99 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.9 | 1.17 |  | 0.3 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 6.31 | 8.11 | 5.41 | 0.4 | 6 | 6 | 1 | 177 |
| Rhine close · vectors off | 0.87 | 2.16 |  | 0.3 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 16.32 | 16.87 | 15.45 | 0.4 | 6 | 6 | 1 | 177 |
| Gale regional · vectors off | 0.86 | 1.45 |  | 2.3 | 0 | 0 | 0 | 0 |
| Gale regional · wide regions | 4.72 | 6.18 | 3.86 | 5.5 | 552 | 4 | 251 | 9 |
| Gale close · vectors off | 2.76 | 3.08 |  | 2.4 | 0 | 0 | 0 | 0 |
| Gale close · wide regions | 7.15 | 8.26 | 4.39 | 6.4 | 828 | 4 | 233 | 9 |
| Gale very close · vectors off | 0.85 | 1.67 |  | 1.2 | 0 | 0 | 0 | 0 |
| Gale very close · wide regions | 6.51 | 7.75 | 5.66 | 2.6 | 396 | 4 | 101 | 9 |
| Gale very close + contours · vectors off | 1 | 3.64 |  | 1.3 | 0 | 0 | 0 | 0 |
| Gale very close + contours · wide regions | 5.34 | 8.63 | 4.34 | 3 | 396 | 4 | 101 | 9 |
