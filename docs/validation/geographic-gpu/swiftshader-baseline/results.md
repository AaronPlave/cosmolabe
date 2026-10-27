Resolution 1280×720, ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver). GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.

| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jezero close · vectors off | 62.95 | 93.71 |  | 1 | 0 | 0 | 0 | 0 |
| Jezero close · one point | 175.43 | 203.04 | 112.48 | 1.2 | 1 | 1 | 1 | 1 |
| Jezero close · one small polygon | 313.45 | 377.02 | 250.50 | 1.3 | 1 | 1 | 1 | 1 |
| Jezero close · polygon selected | 455.32 | 506.31 | 392.37 | 1.3 | 2 | 1 | 1 | 1 |
| Jezero close · 200 annotations | 495.28 | 527.31 | 432.33 | 1.3 | 4 | 4 | 1 | 200 |
| Mars disk · vectors off | 35.44 | 57.63 |  | 0.9 | 0 | 0 | 0 | 0 |
| Mars disk · one small polygon | 106.98 | 130.51 | 71.54 | 1 | 1 | 1 | 1 | 1 |
| Mars disk · 200 annotations | 394.1 | 454.44 | 358.66 | 1.2 | 4 | 4 | 1 | 200 |
| Dense Jezero · vectors off | 52.6 | 69.26 |  | 1 | 0 | 0 | 0 | 0 |
| Dense Jezero · vectors on | 1042.9 | 1396.27 | 990.30 | 1.7 | 9 | 9 | 1 | 1601 |
| Earth orbit · vectors off | 39.28 | 64.47 |  | 0.9 | 0 | 0 | 0 | 0 |
| Earth orbit · countries | 1360.2 | 1475.79 | 1320.92 | 1.6 | 6 | 6 | 1 | 177 |
| Rhine close · vectors off | 82.34 | 102.96 |  | 0.9 | 0 | 0 | 0 | 0 |
| Rhine close · countries | 2198.54 | 2325.39 | 2116.20 | 1.5 | 6 | 6 | 1 | 177 |
