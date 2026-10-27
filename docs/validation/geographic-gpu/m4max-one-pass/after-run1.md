Resolution 3840×2160, ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dense Jezero · vectors off | 0.79 | 1.71 |  | 0.8 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 0.99 | 1.32 | 0.20 | 1.1 | 11 | 9 | 68 | 1601 |
| Earth orbit · vectors off | 0.45 | 1.01 |  | 0.3 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 5.53 | 8.9 | 5.08 | 0.4 | 1 | 6 | 1 | 177 |
| Rhine close · vectors off | 0.53 | 2.37 |  | 0.3 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 17.33 | 19.29 | 16.80 | 0.4 | 1 | 6 | 1 | 177 |
| Gale regional · vectors off | 0.74 | 1.03 |  | 2.3 | 0 | 0 | 0 | 0 |
| Gale regional · wide regions | 1.78 | 1.99 | 1.04 | 4.1 | 138 | 4 | 251 | 9 |
| Gale close · vectors off | 0.87 | 1.65 |  | 2.3 | 0 | 0 | 0 | 0 |
| Gale close · wide regions | 5.86 | 6.43 | 4.99 | 3.8 | 207 | 4 | 233 | 9 |
| Gale very close · vectors off | 0.77 | 0.81 |  | 1.1 | 0 | 0 | 0 | 0 |
| Gale very close · wide regions | 4.32 | 8.09 | 3.55 | 1.9 | 99 | 4 | 101 | 9 |
| Gale very close + contours · vectors off | 1.28 | 3.8 |  | 1.2 | 0 | 0 | 0 | 0 |
| Gale very close + contours · wide regions | 6.29 | 7.79 | 5.01 | 2.1 | 99 | 4 | 101 | 9 |
