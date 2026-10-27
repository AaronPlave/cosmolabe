Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dense Jezero · vectors off | 1.71 | 1.8 |  | 0.7 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 3.09 | 3.2 | 1.38 | 1 | 11 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.47 | 0.98 |  | 0.3 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 6.41 | 7.61 | 5.94 | 0.2 | 1 | 6 | 1 | 177 |
| Rhine close · vectors off | 1.43 | 1.61 |  | 0.2 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 2.42 | 2.76 | 0.99 | 0.3 | 1 | 6 | 1 | 177 |
| Gale close · vectors off | 2.87 | 2.92 |  | 1.9 | 0 | 0 | 0 | 0 |
| Gale close · wide regions | 7.04 | 7.62 | 4.17 | 3.5 | 207 | 4 | 233 | 9 |
| Gale very close · vectors off | 2.67 | 2.85 |  | 1 | 0 | 0 | 0 | 0 |
| Gale very close · wide regions | 6.78 | 10.9 | 4.11 | 1.8 | 99 | 4 | 101 | 9 |
| Gale very close + contours · vectors off | 3.64 | 3.93 |  | 1 | 0 | 0 | 0 | 0 |
| Gale very close + contours · wide regions | 6.63 | 6.86 | 2.99 | 1.7 | 99 | 4 | 101 | 9 |
