import { describe, expect, it } from 'vitest';
import { viewerBrowserOptions } from './viewer-browser.mjs';

describe('optional viewer browser launch', () => {
  it('uses portable Playwright Chromium/SwiftShader outside macOS', () => {
    expect(viewerBrowserOptions({}, 'linux')).toEqual({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  });
  it('retains explicit executable selection on any platform', () => {
    expect(viewerBrowserOptions({ CL_CHROMIUM: '/custom/chromium' }, 'linux').executablePath).toBe('/custom/chromium');
  });
  it('allows software rendering on macOS without a Chrome dependency', () => {
    expect(viewerBrowserOptions({ CL_GPU: 'software' }, 'darwin')).toEqual(viewerBrowserOptions({}, 'linux'));
  });
});
