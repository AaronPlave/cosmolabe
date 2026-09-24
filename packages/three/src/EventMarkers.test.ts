import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Body } from '@cosmolabe/core';
import { EventMarkers, eventAnchorOpacityAtSphere, pickEventMarkerGroups, type EventMarker } from './EventMarkers.js';
import { TrajectoryLine } from './TrajectoryLine.js';
import { eventLeadRequest, eventPiecesOnLines, selectEventTrajectoryBody } from './UniverseRenderer.js';
import type { GeometryEvent } from '@cosmolabe/core';

const body = { name: 'Europa Clipper' } as Body;

function marker(overrides: Partial<EventMarker> = {}): EventMarker {
  return {
    id: 'e1', queryId: 'q1', kind: 'future-kind', temporality: 'instant',
    startEt: 100, endEt: 100, ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('EventMarkers', () => {
  it('fades a whole glyph across a planet limb and hides it well behind the body', () => {
    const camera = new THREE.Vector3(0, 0, 10);
    const center = new THREE.Vector3();
    const opacity = (x: number, z = -10) => eventAnchorOpacityAtSphere(
      new THREE.Vector3(x, 0, z), camera, center, 2, 100,
    );
    expect(opacity(0)).toBe(0);
    expect(opacity(4)).toBeGreaterThan(0);
    expect(opacity(4)).toBeLessThan(1);
    expect(opacity(5)).toBe(1);
    expect(opacity(0, 5)).toBe(1); // anchor in front of the body
  });

  it('applies anchor opacity to the entire sprite, without overriding the trail fade', () => {
    const group = new EventMarkers(body);
    group.setMarkers([marker({ selected: true })]);
    group.update(1, [0, 0, 0], () => [0, 0, 0], [90, 100]);
    const sprite = group.children[0] as THREE.Sprite;
    const material = sprite.material as THREE.SpriteMaterial;
    expect(material.depthTest).toBe(false);
    group.applyAnchorOpacity(() => 0.4);
    expect(material.opacity).toBeCloseTo(0.4);
    expect(sprite.visible).toBe(true);
    group.applyAnchorOpacity(() => 0);
    expect(sprite.visible).toBe(false);
    group.applyAnchorOpacity(() => 1);
    expect(sprite.visible).toBe(true);
    group.update(1, [0, 0, 0], () => [0, 0, 0], [101, 200]);
    group.applyAnchorOpacity(() => 1);
    expect(sprite.visible).toBe(false);
    group.dispose();

    const faded = new EventMarkers(body);
    faded.setMarkers([marker()]);
    faded.update(1, [0, 0, 0], () => [0, 0, 0], [90, 100], () => 0.5);
    faded.applyAnchorOpacity(() => 0.4);
    expect(((faded.children[0] as THREE.Sprite).material as THREE.SpriteMaterial).opacity).toBeCloseTo(0.2);
    faded.dispose();
  });

  it('places an instant through its trajectory-frame resolver and center offset', () => {
    const group = new EventMarkers(body);
    group.setMarkers([marker({ selected: true })]);
    // Local Clipper-on-Jupiter-arc position + Jupiter's current scene offset.
    group.update(0.01, [1000, 2000, 3000], (_name, et) => [et, et + 1, et + 2], [90, 100]);

    const sprite = group.children.find((child): child is THREE.Sprite => child instanceof THREE.Sprite);
    expect(sprite?.position.toArray()).toEqual([11, 21.01, 31.02]);
    group.dispose();
  });

  it('draws a compact midpoint diamond and two boundary caps without a duplicate trajectory', () => {
    const group = new EventMarkers(body, { intervalSamples: 5 });
    group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20, selected: true })]);
    group.update(1, [1, 2, 3], (_name, et) => [et, et * 2, et * 3], [10, 20]);

    const sprites = group.children.filter((child): child is THREE.Sprite => child instanceof THREE.Sprite);
    expect(group.children.some((child) => child instanceof THREE.Line)).toBe(false);
    expect(sprites.map((sprite) => sprite.name)).toEqual([
      'future-kind_e1_midpoint', 'future-kind_e1_start', 'future-kind_e1_end',
    ]);
    expect(sprites[0].position.toArray()).toEqual([16, 32, 48]);
    expect(sprites[1].position.toArray()).toEqual([11, 22, 33]);
    expect(sprites[2].position.toArray()).toEqual([21, 42, 63]);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    camera.position.set(0, 0, 200);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    for (const [sprite, et] of sprites.map((sprite, i) => [sprite, [15, 10, 20][i]] as const)) {
      const projected = sprite.position.clone().project(camera);
      const hit = group.pick(camera, (projected.x + 1) * 500, (1 - projected.y) * 500, 1000, 1000);
      expect(hit?.marker.id).toBe('e1');
      expect(hit?.et).toBe(et);
    }
    group.dispose();
  });

  it('keeps future results off the scene until their owning trail reaches them', () => {
    const group = new EventMarkers(body);
    group.setMarkers([marker()]);
    group.update(1, [0, 0, 0], (_name, et) => [et, 0, 0], [0, 99]);
    const sprite = group.children[0] as THREE.Sprite;
    expect(sprite.visible).toBe(false);
    group.update(1, [0, 0, 0], (_name, et) => [et, 0, 0], [90, 100]);
    expect(sprite.visible).toBe(true);
    group.update(1, [0, 0, 0], (_name, et) => [et, 0, 0], [101, 200]);
    expect(sprite.visible).toBe(false);
    group.dispose();
  });

  it('clips interval annotations to the visible trail and hides a stale selection', () => {
    const group = new EventMarkers(body, { intervalSamples: 5 });
    group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20, selected: true })]);
    group.update(1, [0, 0, 0], (_name, et) => [et, 0, 0], [0, 15]);
    const sprites = group.children.filter((child): child is THREE.Sprite => child instanceof THREE.Sprite);
    expect(sprites.map((sprite) => sprite.visible)).toEqual([true, true, false]);
    group.update(1, [0, 0, 0], (_name, et) => [et, 0, 0], [30, 40]);
    expect(sprites.every((sprite) => !sprite.visible)).toBe(true);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 10;
    camera.updateMatrixWorld();
    expect(group.pick(camera, 100, 100, 200, 200)).toBeNull();
    group.update(1, [0, 0, 0], (_name, et) => [et, 0, 0], [10, 20]);
    expect(sprites[0].visible).toBe(true);
    group.dispose();
  });

  it('keeps caps attached to the resolved trajectory while the playhead advances', () => {
    const group = new EventMarkers(body, { intervalSamples: 5 });
    group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20, selected: true })]);
    const start = group.children.find((child): child is THREE.Sprite => child instanceof THREE.Sprite && child.name.endsWith('_start'))!;
    const end = group.children.find((child): child is THREE.Sprite => child instanceof THREE.Sprite && child.name.endsWith('_end'))!;
    const resolve = (_name: string, et: number): [number, number, number] => [et, et * et, 0];
    group.update(2, [1, 0, 0], resolve, [10, 16]);
    expect(start.position.toArray()).toEqual([22, 200, 0]);
    expect(end.position.toArray()).toEqual([42, 800, 0]);
    expect(end.visible).toBe(false);
    group.update(2, [1, 0, 0], resolve, [10, 17.5]);
    expect(end.visible).toBe(false);
    group.update(2, [1, 0, 0], resolve, [10, 13]);
    expect(start.visible).toBe(true);
    group.update(2, [1, 0, 0], resolve, [10, 20]);
    expect(end.visible).toBe(true);
    group.dispose();
  });

  it('does not move the interval glyph to the advancing trail edge before its midpoint', () => {
    const group = new EventMarkers(body, { intervalSamples: 5 });
    group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20, selected: true })]);
    const span = group.children.find((child): child is THREE.Sprite => child instanceof THREE.Sprite && child.name.endsWith('_midpoint'))!;

    group.update(1, [0, 0, 0], (_name, et) => [et, 0, 0], [10, 12.5]);
    expect(span.position.x).toBe(15);
    expect(span.visible).toBe(false);

    group.update(1, [0, 0, 0], (_name, et) => [et, 0, 0], [10, 15]);
    expect(span.position.x).toBe(15);
    expect(span.visible).toBe(true);

    group.update(1, [0, 0, 0], (_name, et) => [et, 0, 0], [12.5, 17.5]);
    expect(span.position.x).toBe(15);
    expect(span.visible).toBe(true);

    group.update(1, [0, 0, 0], (_name, et) => [et, 0, 0], [17.5, 20]);
    expect(span.visible).toBe(false);
    group.dispose();
  });

  it('picks only sprites currently visible in the scene', () => {
    const group = new EventMarkers(body);
    group.setMarkers([marker()]);
    group.update(1, [0, 0, 0], () => [0, 0, 0], [0, 99]);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 10;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    expect(group.pick(camera, 100, 100, 200, 200)).toBeNull();
    group.update(1, [0, 0, 0], () => [0, 0, 0], [90, 100]);
    expect(group.pick(camera, 100, 100, 200, 200)?.marker.id).toBe('e1');
    group.dispose();
  });

  it('chooses the visually nearest marker across trajectory groups', () => {
    const far = new EventMarkers(body);
    const near = new EventMarkers(body);
    far.setMarkers([marker({ id: 'far' })]);
    near.setMarkers([marker({ id: 'near' })]);
    far.update(1, [0, 0, 0], () => [0.4, 0, 0], [90, 100]);
    near.update(1, [0, 0, 0], () => [0.1, 0, 0], [90, 100]);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 10;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    expect(pickEventMarkerGroups([far, near], camera, 102, 100, 200, 200)?.marker.id).toBe('near');
    expect(pickEventMarkerGroups([far, near], camera, 118, 100, 200, 200)).toBeNull();
    far.dispose();
    near.dispose();
  });

  it('skips an occluded candidate and still finds another event on the same arc', () => {
    const group = new EventMarkers(body);
    group.setMarkers([marker({ id: 'behind', startEt: 100, endEt: 100 }), marker({ id: 'visible', startEt: 101, endEt: 101 })]);
    group.update(1, [0, 0, 0], (_name, et) => [et === 100 ? 0 : 0.05, 0, 0], [90, 101]);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 10;
    camera.updateMatrixWorld();
    const hit = group.pick(camera, 100, 100, 200, 200, 11, (point) => point.x > 0);
    expect(hit?.marker.id).toBe('visible');
    group.dispose();
  });

  it('chooses the selected glyph when two marker centers overlap', () => {
    const ordinary = new EventMarkers(body);
    const selected = new EventMarkers(body);
    ordinary.setMarkers([marker({ id: 'ordinary' })]);
    selected.setMarkers([marker({ id: 'selected', selected: true })]);
    ordinary.update(1, [0, 0, 0], () => [0, 0, 0], [90, 100]);
    selected.update(1, [0, 0, 0], () => [0, 0, 0], [90, 100]);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 10;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    expect(pickEventMarkerGroups([selected, ordinary], camera, 100, 100, 200, 200)?.marker.id).toBe('selected');
    ordinary.dispose();
    selected.dispose();
  });

  it('carries state as open → softly filled → solid, not by size', () => {
    const group = new EventMarkers(body);
    group.setMarkers([marker({ color: 0x71b896 })]);
    group.update(1, [0, 0, 0], () => [0, 0, 0], [90, 100]);
    const sprite = group.children[0] as THREE.Sprite;
    const material = sprite.material as THREE.SpriteMaterial;
    const uniforms = material.userData.eventGlyphUniforms;
    const baseScale = sprite.scale.x;
    const baseStroke = uniforms.eventGlyphStrokeCssPx.value;
    expect(material.map).toBeNull();
    expect(uniforms.eventGlyphFill.value).toBe(0);
    const originalColor = material.color.getHex();

    group.setPreview({ id: 'e1', queryId: 'q1' });
    expect(uniforms.eventGlyphFill.value).toBeGreaterThan(0.2);
    expect(uniforms.eventGlyphFill.value).toBeLessThan(0.5);
    expect(uniforms.eventGlyphStrokeCssPx.value).toBeGreaterThan(baseStroke);
    expect(material.color.getHex()).toBe(originalColor);
    expect(sprite.scale.x / baseScale).toBeGreaterThan(1);
    expect(sprite.scale.x / baseScale).toBeLessThanOrEqual(1.05);
    group.setPreview(null);
    expect(uniforms.eventGlyphFill.value).toBe(0);
    expect(group.anchorFor('e1', 'q1')?.toArray()).toEqual([0, 0, 0]);

    group.setMarkers([marker({ color: 0x71b896, selected: true })]);
    const selected = group.children[0] as THREE.Sprite;
    const selectedUniforms = (selected.material as THREE.SpriteMaterial).userData.eventGlyphUniforms;
    expect(selectedUniforms.eventGlyphFill.value).toBe(1);
    expect(selected.scale.x / baseScale).toBeLessThanOrEqual(1.15);
    group.dispose();
  });

  it('sizes glyphs in CSS pixels regardless of viewport height or FOV', () => {
    const pixelHeight = (fov: number, height: number) => {
      const group = new EventMarkers(body);
      group.setMarkers([marker()]);
      const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100);
      group.update(1, [0, 0, 0], () => [0, 0, 0], [90, 100], () => 1, camera, 1, { width: height, height });
      const scale = (group.children[0] as THREE.Sprite).scale.y;
      group.dispose();
      return scale * (height / 2) / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    };
    expect(pixelHeight(45, 900)).toBeCloseTo(15);
    expect(pixelHeight(70, 500)).toBeCloseTo(15);
  });

  it('collapses a projected-short interval instead of piling caps on its midpoint', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.z = 100;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const viewport = { width: 1000, height: 1000 };
    const layoutAtSpan = (span: number) => {
      const group = new EventMarkers(body, { intervalSamples: 5 });
      group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20 })]);
      group.update(1, [0, 0, 0], (_name, et) => [(et - 15) / 10 * span, 0, 0], [10, 20], () => 1, camera, 1, viewport);
      const sprites = group.children.filter((child): child is THREE.Sprite => child instanceof THREE.Sprite);
      const result = {
        layout: group.layoutFor('e1', 'q1'),
        visible: sprites.map((sprite) => sprite.visible),
        startAnchor: group.anchorFor('e1', 'q1', 'start')?.x,
      };
      group.dispose();
      return result;
    };
    // At z=100 with a 60° FOV, 1 world unit ≈ 8.66 px on a 1000 px viewport.
    expect(layoutAtSpan(1)).toEqual({ layout: 'point', visible: [true, false, false], startAnchor: 0 });
    expect(layoutAtSpan(3).layout).toBe('caps');
    expect(layoutAtSpan(3).visible).toEqual([false, true, true]);
    expect(layoutAtSpan(20)).toEqual({ layout: 'full', visible: [true, true, true], startAnchor: -10 });
  });

  it('draws one glyph for coincident ordinary results but always keeps the selected one', () => {
    const group = new EventMarkers(body);
    group.setMarkers([
      marker({ id: 'a', startEt: 95, endEt: 95 }),
      marker({ id: 'b', startEt: 96, endEt: 96 }),
      marker({ id: 'c', startEt: 97, endEt: 97, selected: true }),
      marker({ id: 'far', startEt: 98, endEt: 98 }),
    ]);
    // a, b, c project to (nearly) the same pixel; far is well apart.
    group.update(1, [0, 0, 0], (_name, et) => [et === 98 ? 1 : (et - 95) * 1e-4, 0, 0], [90, 100]);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 10;
    camera.updateMatrixWorld();
    const viewport = { width: 1000, height: 1000 };
    const occupied = new Map<string, Array<[number, number]>>();
    group.thinCoincidentGlyphs(camera, viewport, occupied, true);
    group.thinCoincidentGlyphs(camera, viewport, occupied, false);
    const visible = Object.fromEntries(group.children.map((child) => [child.name.split('_').pop(), child.visible]));
    expect(visible).toEqual({ a: false, b: false, c: true, far: true });
    group.dispose();
  });

  it('grows the selected-span stroke with the playhead in one fixed GPU buffer', () => {
    const group = new EventMarkers(body, { intervalSamples: 5 });
    group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20, selected: true })]);
    const geometry = group.spanEmphasis.geometry;
    const buffer = (geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).data;
    const resolve = (_name: string, et: number): [number, number, number] => [et, 0, 0];
    // Selected at the start: only the first sample pair is on the trail.
    group.update(1, [0, 0, 0], resolve, [0, 12.5]);
    expect(geometry.instanceCount).toBe(1);
    // Playback advances; the stroke must follow instead of freezing at the
    // draw count three.js cached on first render.
    group.update(1, [0, 0, 0], resolve, [0, 20]);
    expect(geometry.instanceCount).toBe(4);
    expect((geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).data).toBe(buffer);
    expect(Array.from(buffer.array.slice(18, 24))).toEqual([17.5, 0, 0, 20, 0, 0]);
    group.update(1, [0, 0, 0], resolve, [30, 40]);
    expect(group.spanEmphasis.visible).toBe(false);
    group.dispose();
  });

  it('retraces the owning trail to its live head instead of the last interval sample', () => {
    const trail = { positions: new Float32Array(0), times: new Float64Array(0), count: 0 };
    const setTrail = (times: number[]) => {
      trail.times = Float64Array.from(times);
      trail.positions = Float32Array.from(times.flatMap((t) => [t, t * t, 0]));
      trail.count = times.length;
    };
    const group = new EventMarkers(body, { intervalSamples: 5, path: () => [trail] });
    group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20, selected: true })]);
    const resolve = (_name: string, et: number): [number, number, number] => [et, et * et, 0];
    const geometry = group.spanEmphasis.geometry;
    const points = () => {
      const g = group.spanEmphasis.geometry;
      const a = (g.attributes.instanceStart as THREE.InterleavedBufferAttribute).data.array;
      return Array.from({ length: g.instanceCount + 1 }, (_, i) =>
        i < g.instanceCount ? a[i * 6] : a[(i - 1) * 6 + 3]);
    };
    // Playhead at 14.3: interval samples are 2.5 s apart, so the old stroke
    // stopped at 12.5. The trail's newest vertex is the live head sample.
    setTrail([0, 4, 8, 11, 13, 14.3]);
    group.update(1, [0, 0, 0], resolve, [0, 14.3]);
    expect(points()[0]).toBeCloseTo(10); // cut exactly at the event start
    expect(points().slice(1)).toEqual([11, 13, Math.fround(14.3)]);
    // After the event: cut exactly at its end, not at the next trail vertex.
    setTrail([8, 11, 13, 19, 23, 30]);
    group.update(1, [0, 0, 0], resolve, [0, 30]);
    expect(points()[0]).toBeCloseTo(10);
    expect(points().at(-1)).toBeCloseTo(20);
    // A dense trail outgrows the initial buffer; the swapped geometry draws it all.
    setTrail(Array.from({ length: 2001 }, (_, i) => 10 + i * 0.005));
    group.update(1, [0, 0, 0], resolve, [0, 20]);
    expect(group.spanEmphasis.geometry).not.toBe(geometry);
    expect(group.spanEmphasis.geometry.instanceCount).toBe(2000);
    group.dispose();
  });

  it('uses derivative AA and scales the stroke in CSS pixels at DPR 2', () => {
    const group = new EventMarkers(body);
    group.setMarkers([marker()]);
    const material = (group.children[0] as THREE.Sprite).material as THREE.SpriteMaterial;
    const shader = { uniforms: {}, vertexShader: 'void main() {', fragmentShader: 'void main() {\n#include <map_fragment>' };
    material.onBeforeCompile(shader as never, {} as never);
    expect(shader.fragmentShader).toContain('fwidth(glyphDistance)');
    expect(shader.fragmentShader).toContain('glyphNearest');
    expect(shader.fragmentShader).toContain('dFdx(glyphDistance)');
    expect(shader.fragmentShader).toContain('glyphKnockoutAlpha');
    expect(shader.fragmentShader).toContain('eventGlyphDpr');
    expect(shader.vertexShader).toContain('vEventUv = uv');
    group.update(1, [0, 0, 0], () => [0, 0, 0], [90, 100], () => 1, undefined, 2);
    expect(material.userData.eventGlyphUniforms.eventGlyphDpr.value).toBe(2);
    group.dispose();
  });

  it('hit-tests glyphs before the span that runs through them', () => {
    const group = new EventMarkers(body, { intervalSamples: 5 });
    group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20 })]);
    group.update(1, [0, 0, 0], (_name, et) => [et - 15, 0, 0], [10, 20]);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 10;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    // On the span (distance 0) but ~9 px from the start cap: the cap wins.
    const point = new THREE.Vector3(-4.5, 0, 0).project(camera);
    const hit = group.pick(camera, (point.x + 1) * 100, 100, 200, 200);
    expect(hit?.boundary).toBe('start');
    expect(hit?.span).toBeUndefined();
    expect(pickEventMarkerGroups([group], camera, (point.x + 1) * 100, 100, 200, 200)?.boundary).toBe('start');
    group.dispose();
  });

  it('thickens the hovered span in its event color and eases it in and out', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const group = new EventMarkers(body, { intervalSamples: 5 });
    group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20, color: 0x4fd1c5 })]);
    const resolve = (_name: string, et: number): [number, number, number] => [et, 0, 0];
    const frame = (ms: number) => { now += ms; group.update(1, [0, 0, 0], resolve, [0, 20]); };
    const material = group.spanPreview.material as LineMaterial;
    frame(0);
    expect(group.spanPreview.visible).toBe(false);
    group.setPreview({ id: 'e1', queryId: 'q1' });
    frame(16);
    expect(group.spanPreview.visible).toBe(true);
    expect(group.spanPreview.geometry.instanceCount).toBe(4);
    expect(material.color.getHex()).toBe(0x4fd1c5);
    expect(material.opacity).toBeGreaterThan(0);
    expect(material.opacity).toBeLessThan(0.3);
    frame(200);
    expect(material.opacity).toBeCloseTo(0.8);
    // Hover ends: the stroke keeps tracing the span while it fades.
    group.setPreview(null);
    frame(60);
    expect(group.spanPreview.visible).toBe(true);
    expect(material.opacity).toBeCloseTo(0.4);
    frame(70);
    expect(material.opacity).toBe(0);
    frame(16);
    expect(group.spanPreview.visible).toBe(false);
    // Selecting it hands over to the gold stroke; no second stroke on top.
    group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20, selected: true })]);
    group.setPreview({ id: 'e1', queryId: 'q1' });
    frame(16);
    expect(group.spanEmphasis.visible).toBe(true);
    expect(group.spanPreview.visible).toBe(false);
    group.dispose();
  });

  it('picks the interval trajectory span between its small visible glyphs', () => {
    const group = new EventMarkers(body, { intervalSamples: 5 });
    group.setMarkers([marker({ temporality: 'interval', startEt: 10, endEt: 20 })]);
    group.update(1, [0, 0, 0], (_name, et) => [et - 15, 0, 0], [10, 20]);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 10;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const point = new THREE.Vector3(-2.5, 0, 0).project(camera);
    const hit = group.pick(camera, (point.x + 1) * 100, 100, 200, 200);
    expect(hit?.marker.id).toBe('e1');
    expect(hit?.et).toBeCloseTo(12.5);
    expect(hit?.boundary).toBeUndefined();
    group.dispose();
  });
});

describe('interval pieces and span hits', () => {
  const camera = () => {
    const c = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    c.position.z = 10;
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld();
    return c;
  };
  const screenX = (c: THREE.Camera, x: number) => (new THREE.Vector3(x, 0, 0).project(c).x + 1) * 100;

  it('draws only true bounds as caps and the midpoint glyph on the piece that owns it', () => {
    // Event 0..20 split at 8 across two arcs; its midpoint (10) is on the second.
    const first = new EventMarkers(body, { intervalSamples: 5 });
    const second = new EventMarkers(body, { intervalSamples: 5 });
    const event = { temporality: 'interval' as const, startEt: 0, endEt: 20 };
    first.setMarkers([marker({ ...event, pieceStartEt: 0, pieceEndEt: 8 })]);
    second.setMarkers([marker({ ...event, pieceStartEt: 8, pieceEndEt: 20 })]);
    const resolve = (_name: string, et: number): [number, number, number] => [et - 10, 0, 0];
    first.update(1, [0, 0, 0], resolve, [0, 20]);
    second.update(1, [0, 0, 0], resolve, [0, 20]);
    const shown = (group: EventMarkers) => group.children
      .filter((child): child is THREE.Sprite => child instanceof THREE.Sprite && child.visible)
      .map((sprite) => sprite.name.split('_').pop());
    expect(shown(first)).toEqual(['start']);
    expect(shown(second)).toEqual(['midpoint', 'end']);
    expect(second.anchorFor('e1', 'q1')?.x).toBeCloseTo(0); // the event midpoint, exactly
    expect(first.anchorFor('e1', 'q1')).toBeNull(); // leaves the callout to the owner
    expect(first.anchorFor('e1', 'q1', 'start')?.x).toBeCloseTo(-10);
    first.dispose();
    second.dispose();
  });

  it('anchors a span hit where the pointer is, and picks the stretch up to the trail head', () => {
    // Trail vertices every 4 s, head sample at 13.9: the last coarse interval
    // sample (12.5) is behind the head, but the drawn span reaches it.
    const times = [0, 4, 8, 12, 13.9];
    const trail = {
      times: Float64Array.from(times),
      positions: Float32Array.from(times.flatMap((t) => [t - 10, 0, 0])),
      count: times.length,
    };
    const group = new EventMarkers(body, { intervalSamples: 5, path: () => [trail] });
    group.setMarkers([marker({ temporality: 'interval', startEt: 2, endEt: 20 })]);
    group.update(1, [0, 0, 0], (_name, et) => [et - 10, 0, 0], [0, 13.9]);
    const c = camera();
    // Between the last sample and the head (x = 3.4 → et 13.4).
    const hit = group.pick(c, screenX(c, 3.4), 100, 200, 200);
    expect(hit?.span).toBe(true);
    expect(hit?.et).toBeCloseTo(13.4, 1);
    expect(group.anchorAt('e1', 'q1', 13.4)?.x).toBeCloseTo(3.4);
    expect(group.anchorAt('e1', 'q1', 1)).toBeNull(); // before the event
    expect(group.anchorAt('e1', 'q1', 15)).toBeNull(); // not drawn yet
    group.dispose();
  });
});

describe('trajectory-line event placement', () => {
  it('splits an interval straddling two arcs into one piece per arc', () => {
    const clipper = { name: 'Europa Clipper', labelColor: [1, 1, 1], trajectory: { startTime: 0, endTime: 400 } } as Body;
    const arc0 = new TrajectoryLine(clipper, { minTime: 0, maxTime: 100 });
    const arc1 = new TrajectoryLine(clipper, { minTime: 100 });
    const lines = [['Europa Clipper__arc0', arc0], ['Europa Clipper__arc1', arc1]] as const;
    const interval = {
      id: 'r0', queryId: 'q', kind: 'occultation', temporality: 'interval', start: 60, end: 180,
      bodies: {}, label: 'eclipse',
    } as GeometryEvent;
    expect(eventPiecesOnLines(interval, lines).map(({ key, start, end }) => [key, start, end])).toEqual([
      ['Europa Clipper__arc0', 60, 100],
      ['Europa Clipper__arc1', 100, 180],
    ]);
    // Instants still go to the one arc that owns them.
    const instant = { ...interval, temporality: 'instant', et: 150 } as GeometryEvent;
    expect(eventPiecesOnLines(instant, lines).map(({ key }) => key)).toEqual(['Europa Clipper__arc1']);
    arc0.dispose();
    arc1.dispose();
  });

  it('uses the composite arc fixed resolver and its epoch bounds', () => {
    const line = new TrajectoryLine(
      { name: 'Europa Clipper', labelColor: [1, 1, 1], trajectory: { startTime: 100, endTime: 200 } } as Body,
      {
        minTime: 100,
        maxTime: 200,
        fixedResolver: (_name, et) => [et, et * 2, et * 3],
      },
    );
    expect(line.containsTime(99)).toBe(false);
    expect(line.containsTime(150)).toBe(true);
    expect(line.positionAt(150, () => [999, 999, 999])).toEqual([150, 300, 450]);
    line.dispose();
  });

  it('uses the same trailing window and fade for scene annotations', () => {
    const line = new TrajectoryLine(
      { name: 'Cassini', labelColor: [1, 1, 1], trajectory: { startTime: 0, endTime: 200 } } as Body,
      { trailDuration: 100, fadeFraction: 1 },
    );
    expect(line.visibleTimeRange(100)).toEqual([0, 100]);
    expect(line.trailAlphaAt(0, 100)).toBe(0);
    expect(line.trailAlphaAt(50, 100)).toBe(0.5);
    expect(line.trailAlphaAt(100, 100)).toBe(1);
    expect(line.trailAlphaAt(101, 100)).toBe(0);
    line.dispose();
  });

  it('eases hover emphasis instead of switching it in one frame', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const line = new TrajectoryLine(
      { name: 'Cassini', labelColor: [1, 1, 1], trajectory: { startTime: 0, endTime: 200 } } as Body,
      { trailDuration: 10, numKeySamples: 5 },
    );
    const trail = line.children.find((child): child is THREE.Line => child instanceof THREE.Line)!;
    const opacity = () => (trail.material as THREE.LineBasicMaterial).opacity;
    const resolve = (_name: string, et: number): [number, number, number] => [et, 0, 0];
    line.update(10, 1, resolve);
    const rest = opacity();
    line.setEmphasis('highlight');
    now += 60;
    line.update(10, 1, resolve);
    const halfway = opacity();
    now += 100;
    line.update(10, 1, resolve);
    const lit = opacity();
    expect(halfway).toBeGreaterThan(rest);
    expect(halfway).toBeLessThan(lit);
    expect(halfway).toBeCloseTo((rest + lit) / 2);
    line.dispose();
  });

  it('reports drawn vertex epochs ending at the live head sample', () => {
    const line = new TrajectoryLine(
      { name: 'Cassini', labelColor: [1, 1, 1], trajectory: { startTime: 0, endTime: 200 } } as Body,
      { trailDuration: 100, numKeySamples: 5, fadeFraction: 0 },
    );
    const resolve = (_name: string, et: number): [number, number, number] => [et, 0, 0];
    line.update(100, 1, resolve);
    line.update(137.25, 1, resolve); // within the resample throttle: only the tail moves
    const { positions, times, count } = line.drawnTrail();
    expect(times[count - 1]).toBe(137.25);
    expect(positions[(count - 1) * 3]).toBe(137.25);
    for (let i = 1; i < count; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    for (let i = 0; i < count; i++) expect(positions[i * 3]).toBeCloseTo(times[i], 3);
    line.dispose();
  });

  it('recolors the owning trail and exact live tail immediately when interval emphasis changes', () => {
    const line = new TrajectoryLine(
      { name: 'Cassini', labelColor: [1, 1, 1], trajectory: { startTime: 0, endTime: 200 } } as Body,
      { trailDuration: 10, numKeySamples: 5, fadeFraction: 0 },
    );
    const resolve = (_name: string, et: number): [number, number, number] => [et, 0, 0];
    const trail = line.children.find((child): child is THREE.Line => child instanceof THREE.Line)!;
    const tailColor = () => {
      const color = trail.geometry.getAttribute('color') as THREE.BufferAttribute;
      const last = trail.geometry.drawRange.start + trail.geometry.drawRange.count - 1;
      return [color.getX(last), color.getY(last), color.getZ(last)];
    };
    line.update(10, 1, resolve);
    expect(tailColor()).toEqual([1, 1, 1]);
    line.setColorSegments([{ startEt: 9, endEt: 10, color: 0xffc857 }]);
    line.update(10, 1, resolve);
    expect(tailColor()[0]).toBeCloseTo(1);
    expect(tailColor()[1]).toBeLessThan(1);
    line.clearColorSegments();
    line.update(10, 1, resolve);
    expect(tailColor()).toEqual([1, 1, 1]);
    line.dispose();
  });

  it('prefers the spacecraft path over the UI-primary planet', () => {
    const clipper = { name: 'Europa Clipper', classification: 'spacecraft' } as Body;
    const jupiter = { name: 'Jupiter', classification: 'planet' } as Body;
    expect(selectEventTrajectoryBody([clipper, jupiter], 'Jupiter')).toBe(clipper);
  });
});

describe('events on the future lead (#105)', () => {
  it('traces a span across trail and lead runs without bridging a gap between them', () => {
    // Trail to the playhead at 14, the lead from there to 18, then a lead
    // excerpt around a later stretch: a gap from 18 to 30.
    const run = (times: number[]) => ({
      times: Float64Array.from(times),
      positions: Float32Array.from(times.flatMap((t) => [t, 0, 0])),
      count: times.length,
    });
    const path = [run([0, 6, 12, 14]), run([14, 16, 18]), run([30, 34, 38])];
    const group = new EventMarkers(body, { intervalSamples: 5, path: () => path });
    group.setMarkers([marker({ temporality: 'interval', startEt: 12, endEt: 36, selected: true })]);
    const resolve = (_name: string, et: number): [number, number, number] => [et, 0, 0];
    group.update(1, [0, 0, 0], resolve, [0, 38]);
    const g = group.spanEmphasis.geometry;
    const a = (g.attributes.instanceStart as THREE.InterleavedBufferAttribute).data.array;
    const segments = Array.from({ length: g.instanceCount }, (_, i) => [a[i * 6], a[i * 6 + 3]]);
    expect(segments.length).toBeGreaterThan(0);
    // Every drawn segment lies inside one run: nothing spans the 18 → 30 gap.
    for (const [x0, x1] of segments) expect(x0 >= 30 || x1 <= 18).toBe(true);
    // Both ends of the event are cut exactly, the far one on the excerpt.
    expect(Math.min(...segments.flat())).toBeCloseTo(12);
    expect(Math.max(...segments.flat())).toBeCloseTo(36);
    // Picking and anchoring follow the lead too.
    expect(group.anchorAt('e1', 'q1', 32)?.x).toBeCloseTo(32);
    expect(group.anchorAt('e1', 'q1', 24)).toBeNull();
    group.dispose();
  });

  it('asks a line for the lead of the previewed or selected event only', () => {
    const events = [
      { id: 'a', queryId: 'q', kind: 'closest-approach', temporality: 'instant', et: 50, bodies: {}, label: '' },
      { id: 'b', queryId: 'q', kind: 'distance-range', temporality: 'interval', start: 60, end: 90, bodies: {}, label: '' },
    ] as unknown as GeometryEvent[];
    expect(eventLeadRequest(events, null)).toBeNull();
    expect(eventLeadRequest(events, { id: 'a', queryId: 'other' })).toBeNull();
    expect(eventLeadRequest(events, { id: 'a', queryId: 'q' })).toEqual({ target: { start: 50, end: 50 } });
    expect(eventLeadRequest(events, { id: 'b', queryId: 'q' })).toEqual({ target: { start: 60, end: 90 } });
  });
});
