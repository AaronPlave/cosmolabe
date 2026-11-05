# SPICE test data and mission downloads

Small deterministic fixtures under `fixtures/` and `test-data/` are ordinary Git
binaries. Shared **DE440s stays in LFS**, alongside two full-size scientific oracles.
The full normal `npm test` suite requires these selective downloads:

```sh
git lfs pull --include="apps/viewer/test-catalogs/kernels/de440s.bsp,kernels/test-data/de425s.bsp,kernels/test-data/cassini/04183_04185ra.bc"
bash scripts/fetch-lro-kernels.sh
bash scripts/fetch-cosmographia-data.sh
```

DE440s remains the real planetary ephemeris used by Earth–Moon, MoonFall, Event
Finder, LRO and other integration tests. Their scientific assertions and coverage
are unchanged; no replacement planetary subset or generator is introduced.
DE425 retains the original broad planetary reference coverage; the Cassini CK
retains reconstructed pointing and disjoint attitude coverage. Their reference
hashes are unchanged. The existing LRO reconstruction/orientation download and
external Cosmographia catalog integration remain part of the full suite.
Normal CI never calls `fetch-all.sh`.

Mission-specific viewer binaries under `apps/viewer/test-catalogs/kernels/` are
ignored, not Git/LFS assets. Fetch scripts reconstruct those local demo files,
or Vite streams their versioned R2 pins. Publishing and deployed pins are unchanged.
Historical Git/LFS storage is not rewritten by this cleanup.

The OEM fidelity oracle reuses the byte-identical Cassini SPK already present in
`test-data/cassini/040629AP_SCPSE_04179_04185.bsp`. The real MSL clock and attitude
fixtures moved to `test-data/msl/` with their existing SHA-256 reference pins.
