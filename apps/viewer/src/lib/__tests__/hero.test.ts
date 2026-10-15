import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Universe, builtinCatalogs } from '@cosmolabe/core';
const canonicalSaturn = builtinCatalogs.saturn;

const instances = vi.hoisted(() => [] as any[]);
vi.mock('@cosmolabe/three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cosmolabe/three')>();
  const THREE = await import('three');
  class Renderer {
    camera = new THREE.PerspectiveCamera();
    cameraController = {
      controls: { enabled: true, target: new THREE.Vector3() },
      keyboard: { enabled: true }, track: vi.fn(),
    };
    start = vi.fn(); stop = vi.fn(); dispose = vi.fn(); resize = vi.fn();
    use = vi.fn(); getBodyMesh = vi.fn(() => ({}));
    waitForInitialAssets = vi.fn(() => Promise.resolve());
    listeners: ((et: number) => void)[] = [];
    timeController = {
      et: 0, rate: 0,
      setTime: (et: number) => {
        this.timeController.et = et;
        this.universe.setTime(et);
        for (const listener of this.listeners) listener(et);
      },
      setRate: (rate: number) => { this.timeController.rate = rate; },
      onTimeChange: (listener: (et: number) => void) => { this.listeners.push(listener); },
    };
    constructor(_canvas: HTMLCanvasElement, public universe: Universe) { instances.push(this); }
  }
  return { ...actual, UniverseRenderer: Renderer };
});
import { resizeHero, startHero, stopHero } from '../hero';

let doc: EventTarget & { hidden: boolean };
beforeEach(() => {
  instances.length = 0;
  doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { innerWidth: 1440, innerHeight: 900 });
  vi.stubGlobal('location', { href: 'https://viewer.example/' });
});
afterEach(() => { stopHero(); vi.unstubAllGlobals(); });
const canvas = {} as HTMLCanvasElement;

describe('Home hero', () => {
  it('loads backdrop textures from base-aware viewer-owned asset URLs', () => {
    startHero(canvas, vi.fn());
    const universe = instances[0].universe as Universe;
    const asset = (name: string) => new URL(`${import.meta.env.BASE_URL}hero/${name}`, location.href).href;

    expect(universe.getBody('Saturn')?.geometryData?.baseMap).toBe(asset('saturn.jpg'));
    expect(universe.getBody('Saturn Rings')?.geometryData?.texture).toBe(asset('saturn-rings.png'));
    expect(universe.getBody('Dione')?.geometryData?.baseMap).toBe(asset('dione-1k.jpg'));
  });

  it('shares canonical Saturn orientation through the Universe frame registry', () => {
    startHero(canvas, vi.fn());
    const hero = instances[0];
    const ordinary = new Universe();
    ordinary.loadCatalog(canonicalSaturn as never);
    expect(hero.universe.bodyToWorldQuat('Saturn', hero.timeController.et))
      .toEqual(ordinary.bodyToWorldQuat('Saturn', hero.timeController.et));
    expect(hero.cameraController.controls.enabled).toBe(false);
    expect(hero.cameraController.keyboard.enabled).toBe(false);
    ordinary.dispose();
  });

  it('runs through the transit, then resets simulation time without creating a renderer', () => {
    startHero(canvas, vi.fn());
    const hero = instances[0];
    const start = hero.timeController.et;
    expect(hero.timeController.rate).toBe(100);
    hero.timeController.setTime(start + 14399);
    expect(hero.universe.time).toBe(start + 14399);
    hero.timeController.setTime(start + 14400);
    expect(hero.timeController.et).toBe(start);
    expect(hero.universe.time).toBe(start);
    expect(instances).toHaveLength(1);
  });

  it('pauses and resumes on visibility, removes the listener on disposal, and resizes its canvas owner', () => {
    doc.hidden = true;
    startHero(canvas, vi.fn());
    const hero = instances[0];
    expect(hero.start).not.toHaveBeenCalled();
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(hero.start).toHaveBeenCalledOnce();
    resizeHero(390, 844);
    expect(hero.resize).toHaveBeenLastCalledWith(390, 844);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(hero.stop).toHaveBeenCalledTimes(2);
    stopHero();
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(hero.start).toHaveBeenCalledOnce();
    expect(hero.dispose).toHaveBeenCalledOnce();
  });

  it('starts once and never reports stale assets ready after it releases the canvas', async () => {
    const ready = vi.fn();
    startHero(canvas, ready);
    startHero(canvas, ready);
    expect(instances).toHaveLength(1);
    stopHero();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    startHero(canvas, ready);
    await Promise.resolve();
    expect(ready).toHaveBeenCalledOnce();
  });
});
