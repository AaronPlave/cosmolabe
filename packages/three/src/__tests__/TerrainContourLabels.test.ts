import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contourAnchor, formatContourHeight, TerrainContourLabels } from '../TerrainContourLabels.js';
import { DEFAULT_SURFACE_APPEARANCE as defaults, normalizeSurfaceAppearance, SurfaceAppearance } from '../SurfaceAppearance.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const a = new THREE.Vector3(0, 0, 0), b = new THREE.Vector3(10, 0, 0), c = new THREE.Vector3(0, 10, 0);

describe('terrain contour labels', () => {
  it('intersects the interpolated shader height, including negative elevations and vertex crossings', () => {
    const anchor = contourAnchor(a, b, c, [-3, -1, 1], -1)!;
    expect(anchor.point.toArray()).toEqual([5, 2.5, 0]);
    // Barycentric weights: .25 a + .5 b + .25 c = -1 km.
    expect(anchor.heightKm).toBe(-1);
    expect(anchor.normal.toArray()).toEqual([0, 0, 1]);
    expect(anchor.gradient.toArray()).toEqual([0.2, 0.4, 0]);
    expect(contourAnchor(a, b, c, [-3, -1, 1], 2)).toBeUndefined();
    expect(contourAnchor(a, b, c, [1, 1, 1], 1)).toBeUndefined();
    expect(contourAnchor(a, b, c, [0, 1, 2], 0)).toBeUndefined();
  });

  it('formats signed metres without negative zero and bounds persisted intervals', () => {
    expect([-4, -0.025, -0, 0.05, 1.25].map(formatContourHeight)).toEqual(['-4000 m', '-25 m', '0 m', '50 m', '1250 m']);
    expect(normalizeSurfaceAppearance({ ...defaults, contourDensity: 4 }).contourDensity).toBe(2);
    expect(normalizeSurfaceAppearance({ ...defaults, contourIntervalKm: Infinity }).contourIntervalKm).toBe(1);
    expect(normalizeSurfaceAppearance({ ...defaults, contourIntervalKm: -1 }).contourIntervalKm).toBe(0);
    expect(normalizeSurfaceAppearance({ ...defaults, contourIntervalKm: 0.00001 }).contourIntervalKm).toBe(0.001);
  });

  it('uses visible source terrain through cube imagery splitting, excluding derived meshes and cached ancestors', () => {
    const style = new SurfaceAppearance({ referenceShape: { kind: 'sphere', radiusKm: 1 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' });
    const tile = new THREE.Group(), world = new THREE.Group(), source = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    world.add(tile); tile.add(source);
    const derived = new THREE.Mesh(source.geometry, new THREE.MeshStandardMaterial()); tile.add(derived);
    style.attach(source, new THREE.Matrix4(), tile); style.attachDerived(derived, source);
    style.set({ ...defaults, contours: true }); style.update(Infinity);
    source.visible = false; // imagery blocks render this source geometry
    expect(style.contourSources()).toEqual([source]);
    tile.visible = false;
    expect(style.contourSources()).toEqual([]);
    tile.visible = true; tile.removeFromParent();
    expect(style.contourSources()).toEqual([]);
  });

  it('places depth-tested labels, skips skirts, follows transforms, and removes retired LOD anchors', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-100, -100, 0, 100, -100, 0, 0, 100, 0, -100, -100, -1000], 3));
    geometry.setAttribute('surfaceHeightKm', new THREE.Float32BufferAttribute([-0.2, 0.2, 0.2, -10], 1));
    geometry.setAttribute('surfaceGround', new THREE.Float32BufferAttribute([1, 1, 1, 0], 1));
    geometry.setIndex([0, 1, 2, 0, 3, 1]); geometry.userData.surfaceTriangles = 1;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()), labels = new TerrainContourLabels();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000); camera.position.z = 500; camera.lookAt(0, 0, 0);
    const settings = { ...defaults, contours: true, contourLabels: true, contourIntervalKm: 0.1 };
    labels.update(camera, 800, 800, [mesh], settings);
    const visible = labels.group.children.filter(s => s.visible) as THREE.Sprite[];
    expect(visible.length).toBeGreaterThan(0);
    for (const sprite of visible) {
      expect(sprite.material.depthTest).toBe(true); expect(sprite.material.depthWrite).toBe(false);
      expect(parseInt(sprite.userData.text)).toBeGreaterThanOrEqual(-200);
      expect(sprite.position.z).toBe(0);
      expect(sprite.userData.depthUniforms.saLabelBias.value).toBeGreaterThan(0);
    }
    mesh.position.x = 20;
    labels.update(camera, 800, 800, [mesh], settings);
    expect(visible[0].position.x).toBeGreaterThan(-100);
    labels.update(camera, 800, 800, [mesh], settings, true, [{ x0: 0, x1: 800, y0: 0, y1: 800 }]);
    expect(labels.group.children.filter(s => s.visible)).toHaveLength(0);
    labels.update(camera, 800, 800, [mesh], { ...settings, contourIntervalKm: 0.2 });
    expect(labels.group.children.filter(s => s.visible).length).toBeGreaterThan(0);
    for (const sprite of labels.group.children.filter(s => s.visible)) expect(parseInt(sprite.userData.text) % 200).toBe(0);
    camera.lookAt(0, 0, 1000);
    labels.update(camera, 800, 800, [mesh], settings);
    expect(labels.group.children.filter(s => s.visible)).toHaveLength(0);
    camera.lookAt(0, 0, 0);
    labels.update(camera, 800, 800, [], settings);
    expect(labels.group.children.filter(s => s.visible)).toHaveLength(0);
    labels.update(camera, 800, 800, [mesh], { ...settings, contours: false });
    expect(labels.group.visible).toBe(false);
    labels.update(camera, 800, 800, [mesh], settings, false);
    expect(labels.group.visible).toBe(false);
    labels.update(camera, 800, 800, [mesh], { ...settings, contourIntervalKm: 0 });
    expect(labels.group.visible).toBe(false);
    const texture = visible[0].material.map!, dispose = vi.spyOn(texture, 'dispose');
    labels.dispose(); expect(dispose).toHaveBeenCalledOnce(); expect(labels.group.children).toHaveLength(0);
  });

  it('labels each visible index path without a global count cap and follows its tangent', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) });
    vi.spyOn(performance, 'now').mockReturnValue(0); // complete a static fixture without preparation yielding
    const geometry = new THREE.PlaneGeometry(1200, 1000, 1, 40), p = geometry.getAttribute('position');
    geometry.setAttribute('surfaceHeightKm', new THREE.Float32BufferAttribute(Array.from({ length: p.count }, (_, i) => p.getY(i) * 0.01), 1));
    const mesh = new THREE.Mesh(geometry), labels = new TerrainContourLabels();
    const camera = new THREE.OrthographicCamera(-600, 600, 500, -500, 0.1, 10000); camera.position.z = 1000; camera.lookAt(0, 0, 0);
    const settings = { ...defaults, contours: true, contourLabels: true, contourIntervalKm: 0.1 };
    labels.update(camera, 1200, 1000, [mesh], settings);
    const visible = labels.group.children.filter(s => s.visible) as THREE.Sprite[];
    expect(visible).toHaveLength(19);
    expect(new Set(visible.map(s => s.userData.text)).size).toBe(19);
    for (const sprite of visible) expect(Math.abs(parseInt(sprite.userData.text) % 500)).toBe(0);
    const anchors = () => labels.group.children.filter(s => s.visible).map(s => JSON.stringify([s.userData.text, s.position.toArray()])).sort();
    const initial = anchors();
    // Parallel contours use a common terrain transect, rather than unrelated
    // screen-centred positions selected as each path arrives.
    for (const sprite of visible) expect(sprite.position.x).toBeCloseTo(0, 8);
    labels.update(camera, 1200, 1000, [], settings);
    labels.update(camera, 1200, 1000, [mesh], settings);
    expect(anchors()).toEqual(initial);
    for (const x of [2, -2, 0]) {
      camera.position.x = x; camera.updateMatrixWorld();
      vi.mocked(performance.now).mockReturnValue(500 + x);
      labels.update(camera, 1200, 1000, [mesh], settings);
      expect(anchors()).toEqual(initial);
    }
    const body = new THREE.Group(); body.add(mesh, labels.group, camera);
    body.position.set(1e7, -2e7, 3e7); body.rotation.y = 0.7; body.scale.setScalar(2);
    // Keep the physical camera unscaled and double its orthographic extent
    // to preserve the same view while all terrain/body coordinates scale.
    camera.scale.setScalar(0.5); camera.left *= 2; camera.right *= 2; camera.top *= 2; camera.bottom *= 2; camera.updateProjectionMatrix();
    body.updateMatrixWorld(true); vi.mocked(performance.now).mockReturnValue(1000);
    labels.update(camera, 1200, 1000, [mesh], settings);
    const transformed = labels.group.children.filter(s => s.visible) as THREE.Sprite[];
    expect(transformed).toHaveLength(19);
    for (const sprite of transformed) {
      expect(sprite.position.x).toBeCloseTo(0, 5);
      expect(sprite.position.y).toBeCloseTo(sprite.userData.heightKm / 0.01, 5);
    }
    body.position.set(0, 0, 0); body.rotation.set(0, 0, 0); body.scale.setScalar(1);
    camera.scale.setScalar(1); camera.left /= 2; camera.right /= 2; camera.top /= 2; camera.bottom /= 2; camera.updateProjectionMatrix(); body.updateMatrixWorld(true);
    mesh.rotation.z = 0.4;
    labels.update(camera, 1200, 1000, [mesh], settings);
    const rotated = labels.group.children.filter(s => s.visible) as THREE.Sprite[];
    expect(rotated.length).toBeGreaterThan(0);
    for (const sprite of rotated) expect(sprite.material.rotation).toBeCloseTo(0.4, 6);
    labels.dispose();
  });
  it('keeps labels opaque and neutral, bounds distance scaling, and rejects distant and occluded anchors', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const labels = new TerrainContourLabels();
    const camera = new THREE.OrthographicCamera(-600, 600, 500, -500, 0.1, 20000);
    camera.position.z = 1000; camera.lookAt(0, 0, 0);
    const meshes = [-350, 0, 350].map((x, i) => {
      const geometry = new THREE.PlaneGeometry(250, 800, 1, 20), p = geometry.getAttribute('position');
      geometry.setAttribute('surfaceHeightKm', new THREE.Float32BufferAttribute(Array.from({ length: p.count }, (_, j) => p.getY(j) * 0.01), 1));
      const mesh = new THREE.Mesh(geometry); mesh.position.set(x, 0, [0, -1000, -9000][i]); return mesh;
    });
    const settings = { ...defaults, contours: true, contourLabels: true, contourIntervalKm: 0.1, contourOpacity: 0, contourColor: '#000000' };
    labels.update(camera, 1200, 1000, meshes, settings);
    const visible = labels.group.children.filter(s => s.visible) as THREE.Sprite[];
    const near = visible.filter(s => s.position.x < -200), middle = visible.filter(s => Math.abs(s.position.x) < 100);
    expect(near.length).toBeGreaterThan(0); expect(middle.length).toBeGreaterThan(0);
    expect(visible.some(s => s.position.x > 200)).toBe(false);
    for (const sprite of visible) {
      expect(sprite.material.opacity).toBe(1); expect(sprite.material.color.getHexString()).toBe('fff8e8');
    }
    expect(Math.min(...middle.map(s => s.scale.y)) / 26).toBeCloseTo(10 / 14);
    for (const sprite of visible) expect(sprite.scale.y).toBeGreaterThanOrEqual(26 * 10 / 14);
    // Transparent/fading terrain can omit depth writes. It must still hide the
    // anchor rather than allowing a label to show through a foreground ridge.
    const ridge = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1000), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    ridge.position.z = 500;
    labels.update(camera, 1200, 1000, [...meshes, ridge], settings);
    expect(labels.group.children.filter(s => s.visible)).toHaveLength(0);
    labels.dispose();
  });

  it('fairly refreshes moving visibility checks without blinking or invalidating tracking-time motion', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new THREE.Group(), labels = new TerrainContourLabels();
    const geometry = new THREE.PlaneGeometry(1200, 1000, 1, 40), p = geometry.getAttribute('position');
    geometry.setAttribute('surfaceHeightKm', new THREE.Float32BufferAttribute(Array.from({ length: p.count }, (_, i) => p.getY(i) * 0.01), 1));
    const mesh = new THREE.Mesh(geometry);
    const camera = new THREE.OrthographicCamera(-600, 600, 500, -500, 0.1, 10000);
    camera.position.z = 1000; camera.lookAt(0, 0, 0);
    body.add(mesh, labels.group, camera);
    const settings = { ...defaults, contours: true, contourLabels: true, contourIntervalKm: 0.1 };
    const update = () => { body.updateMatrixWorld(true); labels.update(camera, 1200, 1000, [mesh], settings); };
    update();
    const initial = labels.group.children.filter(s => s.visible).map(s => s.position.toArray());
    expect(initial).toHaveLength(19);
    const raycast = mesh.raycast.bind(mesh);
    const check = vi.spyOn(mesh, 'raycast').mockImplementation((ray, hits) => { now += 1; raycast(ray, hits); });
    // More than one pixel per frame invalidates LOS. Each real raycast uses
    // half the allowance, so later labels must retain their result and get a
    // turn, instead of going dark behind the first two labels every frame.
    now += 10000; // A long paused view must not consume the motion grace period.
    for (let frame = 0; frame < 60; frame++) {
      now += 16; camera.position.x = Math.sin(frame / 8) * 20;
      update();
      expect(labels.group.children.filter(s => s.visible)).toHaveLength(19);
    }
    expect(check.mock.calls.length).toBeGreaterThan(50);
    check.mockClear();
    camera.position.x = 0; now += 16; update();
    // A whole moving body and its tracking camera have constant relative LOS.
    // Expensive checks must remain cached despite changing world coordinates.
    check.mockClear();
    for (let frame = 0; frame < 10; frame++) {
      now += 16; body.position.set(1e7 + frame * 100, -2e7, 3e7); body.rotation.y += 0.001;
      update();
      expect(labels.group.children.filter(s => s.visible)).toHaveLength(19);
    }
    expect(check.mock.calls.length).toBeLessThan(19);
    labels.dispose();
  });

});
