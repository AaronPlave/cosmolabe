import * as THREE from 'three';
import type { BodyMesh } from './BodyMesh.js';

export interface OccultationGeometryParticipants {
  observer: BodyMesh;
  front: BodyMesh;
  back: BodyMesh;
  state?: string;
  startEt: number;
  endEt: number;
}

const RING_SEGMENTS = 64;
const GENERATOR_SEGMENTS = 4;
const EPSILON = 1e-12;
const MAX_LINE_VERTICES = 2 * (RING_SEGMENTS * 4 + GENERATOR_SEGMENTS * 2);
const MAX_SURFACE_VERTICES = RING_SEGMENTS * 3;
const MAX_SURFACE_INDICES = RING_SEGMENTS * 6 * 2;

/**
 * Scientific scene overlay for a selected occultation/eclipsing relationship.
 *
 * GFOCLT remains authoritative for event timing and classification. For a
 * solar eclipse this overlay draws the standard spherical-body tangent
 * construction from the instantaneous rendered positions and physical radii.
 * It is exact for spheres and an explanatory approximation for the ellipsoids
 * GFOCLT uses. The renderer's analytical eclipse shaders remain authoritative
 * for surface shadowing.
 *
 * A non-solar occultation is observer geometry, not a shadow. In that case the
 * overlay draws the foreground body's apparent tangent cone and no
 * umbra/penumbra volumes.
 */
export class OccultationGeometry extends THREE.Group {
  private readonly sightline: THREE.Line;
  private readonly lightline: THREE.Line;
  private readonly umbra: THREE.LineSegments;
  private readonly penumbra: THREE.LineSegments;
  private readonly viewCone: THREE.LineSegments;
  private readonly umbraFill: THREE.Mesh;
  private readonly penumbraFill: THREE.Mesh;
  private readonly viewConeFill: THREE.Mesh;
  private readonly participants: OccultationGeometryParticipants;
  private readonly observerPos = new THREE.Vector3();
  private readonly frontPos = new THREE.Vector3();
  private readonly backPos = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();

  constructor(participants: OccultationGeometryParticipants) {
    super();
    this.name = 'selected-occultation-geometry';
    this.participants = participants;

    this.sightline = this.makeLine('occultation-observer-sightline', 0x7cc7e8, 0.78);
    this.lightline = this.makeLine('occultation-light-axis', 0xf0c66a, 0.42);

    // Colors describe physical regions, not the selected event's
    // classification. Recoloring the umbra amber for a partial event made it
    // indistinguishable from the penumbra and made two real boundaries look
    // like duplicated geometry.
    const innerShadowColor = 0x8c72d8;
    this.umbra = this.makeSegments('occultation-umbra', innerShadowColor, 0.82);
    this.penumbra = this.makeSegments('occultation-penumbra', 0xe0a84c, 0.58);
    this.viewCone = this.makeSegments('occultation-view-cone', innerShadowColor, 0.62);
    this.umbraFill = this.makeSurface('occultation-umbra-fill', innerShadowColor, 0.105);
    this.penumbraFill = this.makeSurface('occultation-penumbra-fill', 0xe0a84c, 0.035);
    this.viewConeFill = this.makeSurface('occultation-view-cone-fill', innerShadowColor, 0.045);

    for (const object of [this.penumbraFill, this.umbraFill, this.viewConeFill]) {
      object.renderOrder = object === this.penumbraFill ? 78 : 79;
      object.layers.set(2);
      this.add(object);
    }
    for (const object of [this.lightline, this.sightline, this.penumbra, this.umbra, this.viewCone]) {
      object.renderOrder = 80;
      object.layers.set(2);
      this.add(object);
    }
    this.update(participants.startEt);
  }

  update(et: number): void {
    const { startEt, endEt } = this.participants;
    this.visible = Number.isFinite(et) && et >= startEt && et <= endEt;
    if (!this.visible) return;

    const { observer, front, back } = this.participants;
    observer.getWorldPosition(this.observerPos);
    front.getWorldPosition(this.frontPos);
    back.getWorldPosition(this.backPos);

    const solarEclipse = back.body.name.toLowerCase() === 'sun';
    // Solar events emphasize the occulter relationship; ordinary
    // occultations show the actual observer→background line of sight that the
    // foreground body blocks.
    this.updateLineGeometry(
      this.sightline,
      this.observerPos,
      solarEclipse ? this.frontPos : this.backPos,
    );
    this.lightline.visible = solarEclipse;
    this.umbra.visible = solarEclipse;
    this.penumbra.visible = solarEclipse;
    this.umbraFill.visible = solarEclipse;
    this.penumbraFill.visible = solarEclipse;
    this.viewCone.visible = !solarEclipse;
    this.viewConeFill.visible = !solarEclipse;

    if (solarEclipse) {
      this.updateLineGeometry(this.lightline, this.backPos, this.frontPos);
      this.updateEclipseGeometry();
    } else {
      this.updateOccultationGeometry();
    }
  }

  dispose(): void {
    for (const object of [
      this.sightline, this.lightline,
      this.umbra, this.penumbra, this.viewCone,
      this.umbraFill, this.penumbraFill, this.viewConeFill,
    ]) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    }
  }

  private updateEclipseGeometry(): void {
    this.axis.copy(this.frontPos).sub(this.backPos);
    const sourceDistance = this.axis.length();
    if (sourceDistance <= EPSILON) {
      this.umbra.visible = false;
      this.penumbra.visible = false;
      this.umbraFill.visible = false;
      this.penumbraFill.visible = false;
      return;
    }
    this.axis.multiplyScalar(1 / sourceDistance);

    const frontRadius = this.sceneRadius(this.participants.front);
    const sourceRadius = this.sceneRadius(this.participants.back);
    const observerOffset = this.observerPos.clone().sub(this.frontPos);
    const observerPlane = observerOffset.dot(this.axis);
    if (observerPlane <= EPSILON) {
      this.umbra.visible = false;
      this.penumbra.visible = false;
      this.umbraFill.visible = false;
      this.penumbraFill.visible = false;
      return;
    }
    // Terminate at the observer's plane. Extending farther may look grander,
    // but it invents geometry unrelated to the selected event and makes the
    // observer's umbra/penumbra membership harder to read.
    const length = observerPlane;

    // Similar-triangle tangent construction. The inner boundary converges to
    // the umbra apex and, if the observer is farther away, opens again as the
    // antumbra. The outer boundary expands monotonically as the penumbra.
    const innerSlope = (sourceRadius - frontRadius) / sourceDistance;
    const outerSlope = (sourceRadius + frontRadius) / sourceDistance;
    const penumbraEnd = frontRadius + outerSlope * length;
    this.setSegments(
      this.penumbra,
      this.frustumSegments(this.frontPos, frontRadius, length, penumbraEnd, this.axis, Math.PI / GENERATOR_SEGMENTS, false),
    );
    this.setSurface(
      this.penumbraFill,
      this.frustumSurface(this.frontPos, frontRadius, length, penumbraEnd, this.axis),
    );

    if (innerSlope > EPSILON) {
      const apexDistance = frontRadius / innerSlope;
      if (length <= apexDistance) {
        this.setSegments(
          this.umbra,
          this.frustumSegments(this.frontPos, frontRadius, length, frontRadius - innerSlope * length, this.axis, 0, false),
        );
        this.setSurface(
          this.umbraFill,
          this.frustumSurface(this.frontPos, frontRadius, length, frontRadius - innerSlope * length, this.axis),
        );
      } else {
        const apex = this.frontPos.clone().addScaledVector(this.axis, apexDistance);
        const antumbraRadius = innerSlope * (length - apexDistance);
        this.setSegments(this.umbra, [
          ...this.frustumSegments(this.frontPos, frontRadius, apexDistance, 0, this.axis, 0, false),
          ...this.frustumSegments(apex, 0, length - apexDistance, antumbraRadius, this.axis, 0, false),
        ]);
        this.setSurface(this.umbraFill, this.multiSectionSurface([
          { center: this.frontPos, radius: frontRadius },
          { center: apex, radius: 0 },
          { center: this.frontPos.clone().addScaledVector(this.axis, length), radius: antumbraRadius },
        ], this.axis));
      }
    } else {
      // A source no larger than the occulter has no finite umbra apex.
      this.setSegments(
        this.umbra,
        this.frustumSegments(this.frontPos, frontRadius, length, frontRadius - innerSlope * length, this.axis, 0, false),
      );
      this.setSurface(
        this.umbraFill,
        this.frustumSurface(this.frontPos, frontRadius, length, frontRadius - innerSlope * length, this.axis),
      );
    }
  }

  private updateOccultationGeometry(): void {
    this.axis.copy(this.frontPos).sub(this.observerPos);
    const frontDistance = this.axis.length();
    if (frontDistance <= EPSILON) {
      this.viewCone.visible = false;
      this.viewConeFill.visible = false;
      return;
    }
    this.axis.multiplyScalar(1 / frontDistance);

    const frontRadius = this.sceneRadius(this.participants.front);
    const backDistance = Math.max(
      this.backPos.clone().sub(this.observerPos).dot(this.axis),
      frontDistance,
    );
    const ratio = THREE.MathUtils.clamp(frontRadius / frontDistance, 0, 1 - Number.EPSILON);
    const apparentHalfAngle = Math.asin(ratio);
    const tangentDistance = frontDistance * (1 - ratio * ratio);
    const tangentRadius = frontRadius * Math.sqrt(1 - ratio * ratio);
    const projectedRadius = Math.tan(apparentHalfAngle) * backDistance;
    const tangentPlane = this.observerPos.clone().addScaledVector(this.axis, tangentDistance);
    const hiddenLength = backDistance - tangentDistance;

    // The cone is mathematically observer-apexed, but the space between the
    // observer and the foreground limb is not occulted. Draw that portion only
    // as tangent guides, then begin the shaded boundary at the sphere's exact
    // tangency ring. Starting it at the body's center plane left an artificial
    // notch beside nearby foreground bodies such as the Moon viewed from LRO.
    this.setSegments(this.viewCone, [
      ...this.frustumSegments(
        this.observerPos, 0, tangentDistance, tangentRadius, this.axis,
      ),
      ...this.frustumSegments(
        tangentPlane, tangentRadius, hiddenLength, projectedRadius, this.axis,
        Math.PI / GENERATOR_SEGMENTS, false,
      ),
    ]);
    this.setSurface(
      this.viewConeFill,
      this.frustumSurface(
        tangentPlane, tangentRadius, hiddenLength, projectedRadius, this.axis,
      ),
    );
  }

  private sceneRadius(body: BodyMesh): number {
    // displayRadius is the catalog/SPICE-derived physical radius in km; the
    // position scale converts it to the same scene units as getWorldPosition.
    return Math.max(body.displayRadius * body.scaleFactor, EPSILON);
  }

  /** A pair of clean end rings plus sparse tangent generators, not a mesh grid. */
  private frustumSegments(
    start: THREE.Vector3,
    startRadius: number,
    length: number,
    endRadius: number,
    axis: THREE.Vector3,
    generatorOffset = 0,
    includeStartRing = true,
  ): number[] {
    const end = start.clone().addScaledVector(axis, length);
    const reference = Math.abs(axis.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(axis, reference).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u).normalize();
    const values: number[] = [];
    const pushPoint = (center: THREE.Vector3, radius: number, angle: number) => {
      const cosRadius = Math.cos(angle) * radius;
      const sinRadius = Math.sin(angle) * radius;
      values.push(
        center.x + u.x * cosRadius + v.x * sinRadius,
        center.y + u.y * cosRadius + v.y * sinRadius,
        center.z + u.z * cosRadius + v.z * sinRadius,
      );
    };
    const pushSegment = (
      aCenter: THREE.Vector3, aRadius: number, aAngle: number,
      bCenter: THREE.Vector3, bRadius: number, bAngle: number,
    ) => {
      pushPoint(aCenter, aRadius, aAngle);
      pushPoint(bCenter, bRadius, bAngle);
    };

    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a0 = i * Math.PI * 2 / RING_SEGMENTS;
      const a1 = (i + 1) * Math.PI * 2 / RING_SEGMENTS;
      if (includeStartRing && startRadius > EPSILON) pushSegment(start, startRadius, a0, start, startRadius, a1);
      if (endRadius > EPSILON) pushSegment(end, endRadius, a0, end, endRadius, a1);
    }
    for (let i = 0; i < GENERATOR_SEGMENTS; i++) {
      const angle = generatorOffset + i * Math.PI * 2 / GENERATOR_SEGMENTS;
      pushSegment(start, startRadius, angle, end, endRadius, angle);
    }
    return values;
  }

  private makeLine(name: string, color: number, opacity: number): THREE.Line {
    const line = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: true, depthWrite: false }),
    );
    line.name = name;
    return line;
  }

  private makeSegments(name: string, color: number, opacity: number): THREE.LineSegments {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(MAX_LINE_VERTICES * 3), 3)
        .setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setDrawRange(0, 0);
    const segments = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: true, depthWrite: false }),
    );
    segments.name = name;
    // Dynamic geometry spans solar-system distances; a stale bounding sphere
    // would be worse than skipping culling for these few explanatory objects.
    segments.frustumCulled = false;
    return segments;
  }

  private makeSurface(name: string, color: number, opacity: number): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(MAX_SURFACE_VERTICES * 3), 3)
        .setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setIndex(
      new THREE.BufferAttribute(new Uint16Array(MAX_SURFACE_INDICES), 1)
        .setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setDrawRange(0, 0);
    const surface = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    surface.name = name;
    surface.frustumCulled = false;
    return surface;
  }

  private setSegments(lines: THREE.LineSegments, values: number[]): void {
    const positions = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    (positions.array as Float32Array).set(values);
    positions.needsUpdate = true;
    lines.geometry.setDrawRange(0, values.length / 3);
  }

  private frustumSurface(
    start: THREE.Vector3,
    startRadius: number,
    length: number,
    endRadius: number,
    axis: THREE.Vector3,
  ): { positions: number[]; indices: number[] } {
    return this.multiSectionSurface([
      { center: start, radius: startRadius },
      { center: start.clone().addScaledVector(axis, length), radius: endRadius },
    ], axis);
  }

  private multiSectionSurface(
    sections: readonly { center: THREE.Vector3; radius: number }[],
    axis: THREE.Vector3,
  ): { positions: number[]; indices: number[] } {
    const reference = Math.abs(axis.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(axis, reference).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u).normalize();
    const positions: number[] = [];
    const indices: number[] = [];

    for (const section of sections) {
      for (let i = 0; i < RING_SEGMENTS; i++) {
        const angle = i * Math.PI * 2 / RING_SEGMENTS;
        const cosRadius = Math.cos(angle) * section.radius;
        const sinRadius = Math.sin(angle) * section.radius;
        positions.push(
          section.center.x + u.x * cosRadius + v.x * sinRadius,
          section.center.y + u.y * cosRadius + v.y * sinRadius,
          section.center.z + u.z * cosRadius + v.z * sinRadius,
        );
      }
    }
    for (let section = 0; section < sections.length - 1; section++) {
      const current = section * RING_SEGMENTS;
      const next = (section + 1) * RING_SEGMENTS;
      for (let i = 0; i < RING_SEGMENTS; i++) {
        const j = (i + 1) % RING_SEGMENTS;
        indices.push(current + i, next + i, next + j, current + i, next + j, current + j);
      }
    }
    return { positions, indices };
  }

  private setSurface(
    surface: THREE.Mesh,
    geometry: { positions: number[]; indices: number[] },
  ): void {
    const positions = surface.geometry.getAttribute('position') as THREE.BufferAttribute;
    const indices = surface.geometry.getIndex()!;
    (positions.array as Float32Array).set(geometry.positions);
    (indices.array as Uint16Array).set(geometry.indices);
    positions.needsUpdate = true;
    indices.needsUpdate = true;
    surface.geometry.setDrawRange(0, geometry.indices.length);
  }

  private updateLineGeometry(line: THREE.Line, start: THREE.Vector3, end: THREE.Vector3): void {
    let positions = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!positions) {
      positions = new THREE.BufferAttribute(new Float32Array(6), 3);
      line.geometry.setAttribute('position', positions);
    }
    positions.setXYZ(0, start.x, start.y, start.z);
    positions.setXYZ(1, end.x, end.y, end.z);
    positions.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }
}
