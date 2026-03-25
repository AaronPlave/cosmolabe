import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../events/EventBus.js';

interface TestEventMap {
  'foo': { value: number };
  'bar': { name: string };
}

describe('EventBus', () => {
  it('delivers typed events to subscribers', () => {
    const bus = new EventBus<TestEventMap>();
    const handler = vi.fn();
    bus.on('foo', handler);
    bus.emit('foo', { value: 42 });
    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it('returns an unsubscribe function', () => {
    const bus = new EventBus<TestEventMap>();
    const handler = vi.fn();
    const unsub = bus.on('foo', handler);
    unsub();
    bus.emit('foo', { value: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers', () => {
    const bus = new EventBus<TestEventMap>();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('foo', h1);
    bus.on('foo', h2);
    bus.emit('foo', { value: 7 });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('once() fires exactly once', () => {
    const bus = new EventBus<TestEventMap>();
    const handler = vi.fn();
    bus.once('foo', handler);
    bus.emit('foo', { value: 1 });
    bus.emit('foo', { value: 2 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ value: 1 });
  });

  it('emit with no listeners is a no-op', () => {
    const bus = new EventBus<TestEventMap>();
    expect(() => bus.emit('foo', { value: 1 })).not.toThrow();
  });

  it('catches and logs handler errors without breaking other handlers', () => {
    const bus = new EventBus<TestEventMap>();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badHandler = () => { throw new Error('boom'); };
    const goodHandler = vi.fn();
    bus.on('foo', badHandler);
    bus.on('foo', goodHandler);
    bus.emit('foo', { value: 1 });
    expect(goodHandler).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('onCustom/emitCustom work for untyped plugin events', () => {
    const bus = new EventBus<TestEventMap>();
    const handler = vi.fn();
    bus.onCustom('plugin:myEvent', handler);
    bus.emitCustom('plugin:myEvent', { custom: true });
    expect(handler).toHaveBeenCalledWith({ custom: true });
  });

  it('dispose() clears all listeners', () => {
    const bus = new EventBus<TestEventMap>();
    const handler = vi.fn();
    bus.on('foo', handler);
    bus.dispose();
    bus.emit('foo', { value: 1 });
    expect(handler).not.toHaveBeenCalled();
  });
});
