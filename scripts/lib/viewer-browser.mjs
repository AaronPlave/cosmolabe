import { existsSync } from 'node:fs';

/** Portable browser selection for optional viewer checks; explicit overrides win. */
export function viewerBrowserOptions(env = process.env, platform = process.platform) {
  const metal = platform === 'darwin' && env.CL_GPU !== 'software';
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = env.CL_CHROMIUM || (metal && existsSync(chrome) ? chrome : undefined);
  return { ...(executablePath ? { executablePath } : {}), args: metal
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
}
