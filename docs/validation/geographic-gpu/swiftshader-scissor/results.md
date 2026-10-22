Resolution 1280×720, ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jezero close · vectors off | 49.98 | 66.07 |  | 1 | 0 | 0 | 0 | 0 |
| Jezero close · one point | 56.2 | 70.55 | 6.22 | 1.2 | 1 | 1 | 1 | 1 |
| Jezero close · one small polygon | 63.32 | 89.48 | 13.34 | 1 | 1 | 1 | 1 | 1 |
| Jezero close · polygon selected | 81.79 | 103.63 | 31.81 | 1.2 | 2 | 1 | 1 | 1 |
| Jezero close · 200 annotations | 405.49 | 439.92 | 355.51 | 1.4 | 4 | 4 | 1 | 200 |
| Mars disk · vectors off | 38.72 | 64.33 |  | 0.8 | 0 | 0 | 0 | 0 |
| Mars disk · one small polygon | 47.62 | 87.42 | 8.90 | 1 | 1 | 1 | 1 | 1 |
| Mars disk · 200 annotations | 200.09 | 243.6 | 161.37 | 1.2 | 4 | 4 | 1 | 200 |
| Dense Jezero · vectors off | 56.91 | 89.5 |  | 0.9 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 301.33 | 359.04 | 244.42 | 1.5 | 9 | 9 | 1 | 1601 |
| Earth orbit · vectors off | 46.95 | 69.37 |  | 0.9 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 1367.48 | 1476.71 | 1320.53 | 1.6 | 6 | 6 | 1 | 177 |
| Rhine close · vectors off | 97.14 | 118.39 |  | 0.9 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 2154.3 | 2291.85 | 2057.16 | 1.5 | 6 | 6 | 1 | 177 |
