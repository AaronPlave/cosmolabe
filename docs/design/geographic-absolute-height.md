# Follow-up: error-bounded absolute-height geographic drawing

Tracking parent: [#197](https://github.com/AaronPlave/cosmolabe/issues/197).
Deferred from PR #262; this remains required scope for completing #197.

`body-fixed-height` and default imported absolute Z are currently diagnosed and
omitted. Explicit clamp and terrain-relative placement remain available without
changing source coordinates. The former fixed 192 x 96 shell was inaccurate by
hundreds of metres on Mars; restoring that shell does not meet acceptance.

Implementation and acceptance:

- [ ] Define an absolute datum-height representation with a quantified maximum
  geometric error in kilometres, independent of imagery resolution.
- [ ] Bound refinement, geometry memory and draw cost while satisfying that
  error at orbit-to-surface zoom levels; report inability to meet the bound.
- [ ] Validate absolute Z=0 and Z=0.002 km against detailed measured Mars terrain
  and an oblate reference ellipsoid, including foreground/background occlusion.
- [ ] Preserve holes, multipart features, seams, polar projection, body attitude,
  floating origin and the shared picking identity/precedence.
- [ ] Verify changing terrain LOD cannot hide a feature because its absolute
  drawing representation undershoots the declared height beyond its bound.
- [ ] Keep source uncertainty separate from mesh approximation error and
  displayed-terrain height; document datum compatibility explicitly.
- [ ] Profile the implementation on physical desktop and mobile GPUs before
  enabling it. Retain existing diagnosed omission until these checks pass.
