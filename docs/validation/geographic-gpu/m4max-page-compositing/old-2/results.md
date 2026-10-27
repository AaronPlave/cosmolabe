Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dense Jezero · vectors off | 1.7 | 1.72 |  | 0.7 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 3.05 | 3.07 | 1.35 | 1 | 11 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.57 | 1.01 |  | 0.2 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 6.98 | 7.37 | 6.41 | 0.2 | 1 | 6 | 1 | 177 |
| Rhine close · vectors off | 0.71 | 1.61 |  | 0.2 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 2.38 | 2.39 | 1.67 | 0.2 | 1 | 6 | 1 | 177 |
| Gale close · vectors off | 2.89 | 3.04 |  | 1.8 | 0 | 0 | 0 | 0 |
| Gale close · wide regions | 6.24 | 9.4 | 3.35 | 3.6 | 207 | 4 | 233 | 9 |
| Gale very close · vectors off | 2.68 | 2.83 |  | 1 | 0 | 0 | 0 | 0 |
| Gale very close · wide regions | 7.5 | 12.12 | 4.82 | 1.8 | 99 | 4 | 101 | 9 |
| Gale very close + contours · vectors off | 3.66 | 3.73 |  | 1 | 0 | 0 | 0 | 0 |
| Gale very close + contours · wide regions | 7.75 | 8.38 | 4.09 | 1.8 | 99 | 4 | 101 | 9 |
