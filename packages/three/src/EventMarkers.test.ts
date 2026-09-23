import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Body } from '@cosmolabe/core';
import { EventMarkers, eventAnchorOpacityAtSphere, pickEventMarkerGroups, type EventMarker } from './EventMarkers.js';
import { TrajectoryLine } from './TrajectoryLine.js';
import { selectEventTrajectoryBody } from './UniverseRenderer.js';

const body = { name: 'Europa Clipper' } as Body;

function marker(overrides: Partial<EventMarker> = {}): EventMarker {
  return {
    id: 'e1', queryId: 'q1', kind: 'future-kind', temporality: 'instant',
    startEt: 100, endEt: 100, ...overrides,
  };
}

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

  it('previews the same SDF diamond without texture regeneration or semantic-color change', () => {
    const group = new EventMarkers(body);
    group.setMarkers([marker({ color: 0x71b896 })]);
    group.update(1, [0, 0, 0], () => [0, 0, 0], [90, 100]);
    const sprite = group.children[0] as THREE.Sprite;
    const material = sprite.material as THREE.SpriteMaterial;
    const uniforms = material.userData.eventGlyphUniforms;
    expect(material.map).toBeNull();
    expect(uniforms.eventGlyphFill.value).toBe(0);
    expect(uniforms.eventGlyphStrokeCssPx.value).toBe(1.6);
    const originalColor = material.color.getHex();
    group.setPreview({ id: 'e1', queryId: 'q1' });
    expect(uniforms.eventGlyphFill.value).toBeGreaterThan(0);
    expect(uniforms.eventGlyphStrokeCssPx.value).toBeGreaterThan(1.6);
    expect(material.color.getHex()).toBe(originalColor);
    expect(sprite.scale.x).toBeGreaterThan(0.021);
    group.setPreview(null);
    expect(uniforms.eventGlyphFill.value).toBe(0);
    expect(group.anchorFor('e1', 'q1')?.toArray()).toEqual([0, 0, 0]);
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

describe('trajectory-line event placement', () => {
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
