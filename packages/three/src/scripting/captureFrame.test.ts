import { describe, expect, it } from 'vitest';
import { captureFilename, captureFrameDataUrl, type CaptureHost } from './captureFrame.js';

describe('captureFrameDataUrl', () => {
  // Ordering is the whole content of this helper: reading the canvas before the
  // multi-pass render photographs pass 1 alone — no tiles, no models, no bloom.
  it('renders before it reads', () => {
    const order: string[] = [];
    const host: CaptureHost = {
      canvas: {
        toDataURL: (type: string) => {
          order.push(`toDataURL(${type})`);
          return 'data:image/png;base64,AAA';
        },
      } as unknown as HTMLCanvasElement,
      renderFrame: () => void order.push('renderFrame'),
    };

    expect(captureFrameDataUrl(host)).toBe('data:image/png;base64,AAA');
    expect(order).toEqual(['renderFrame', 'toDataURL(image/png)']);
  });
});

describe('captureFilename', () => {
  it('is safe to hand a filesystem, label and all', () => {
    expect(captureFilename('png')).toMatch(/^cosmolabe-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/);
    expect(captureFilename('png', 'Ring Plane View')).toMatch(/-Ring_Plane_View\.png$/);
    expect(captureFilename('webm', '../etc/passwd')).toMatch(/-.._etc_passwd\.webm$/);
  });
});
