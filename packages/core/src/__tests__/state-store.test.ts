import { describe, it, expect, vi } from 'vitest';
import { StateStore } from '../state/StateStore.js';

interface TestState {
  count: number;
  name: string | null;
  [key: `plugin:${string}`]: unknown;
}

describe('StateStore', () => {
  it('get/set round-trip', () => {
    const store = new StateStore<TestState>({ count: 0, name: null });
    store.set('count', 5);
    expect(store.get('count')).toBe(5);
  });

  it('watch fires on change', () => {
    const store = new StateStore<TestState>({ count: 0, name: null });
    const listener = vi.fn();
    store.watch('count', listener);
    store.set('count', 10);
    expect(listener).toHaveBeenCalledWith(10, 0);
  });

  it('watch does not fire on same-value set', () => {
    const store = new StateStore<TestState>({ count: 5, name: null });
    const listener = vi.fn();
    store.watch('count', listener);
    store.set('count', 5);
    expect(listener).not.toHaveBeenCalled();
  });

  it('watch returns unsubscribe function', () => {
    const store = new StateStore<TestState>({ count: 0, name: null });
    const listener = vi.fn();
    const unsub = store.watch('count', listener);
    unsub();
    store.set('count', 99);
    expect(listener).not.toHaveBeenCalled();
  });

  it('snapshot returns a copy of state', () => {
    const store = new StateStore<TestState>({ count: 3, name: 'test' });
    const snap = store.snapshot();
    expect(snap).toEqual({ count: 3, name: 'test' });
    store.set('count', 99);
    expect(snap.count).toBe(3); // original snapshot unchanged
  });

  it('plugin-namespaced keys work', () => {
    const store = new StateStore<TestState>({ count: 0, name: null });
    store.set('plugin:myTool', { active: true });
    expect(store.get('plugin:myTool')).toEqual({ active: true });
  });

  it('catches listener errors without breaking other listeners', () => {
    const store = new StateStore<TestState>({ count: 0, name: null });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = () => { throw new Error('boom'); };
    const good = vi.fn();
    store.watch('count', bad);
    store.watch('count', good);
    store.set('count', 1);
    expect(good).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('dispose clears all watchers', () => {
    const store = new StateStore<TestState>({ count: 0, name: null });
    const listener = vi.fn();
    store.watch('count', listener);
    store.dispose();
    store.set('count', 1);
    expect(listener).not.toHaveBeenCalled();
  });
});
