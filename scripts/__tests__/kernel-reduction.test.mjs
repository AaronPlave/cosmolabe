import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpiceBindings } from 'cspice-wasm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'kernel-reduction-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const lsk = join(root, 'kernels/fixtures/naif0012.tls');

const clock = `\\begindata
SCLK_DATA_TYPE_999 = ( 1 )
SCLK01_TIME_SYSTEM_999 = ( 1 )
SCLK01_N_FIELDS_999 = ( 2 )
SCLK01_MODULI_999 = ( 1000000000000 1000 )
SCLK01_OFFSETS_999 = ( 0 0 )
SCLK01_OUTPUT_DELIM_999 = ( 1 )
SCLK_PARTITION_START_999 = ( 0 )
SCLK_PARTITION_END_999 = ( 1.0E15 )
SCLK01_COEFFICIENTS_999 = ( 0 0 1 )
\\begintext
`;
const frame = `\\begindata
FRAME_REDUCTION_TEST = -999000
FRAME_-999000_NAME = 'REDUCTION_TEST'
FRAME_-999000_CLASS = 3
FRAME_-999000_CLASS_ID = -999000
FRAME_-999000_CENTER = -999
CK_-999000_SCLK = -999
CK_-999000_SPK = -999
\\begintext
`;

describe('kernel reduction CLI accuracy gates', () => {
  it('preserves varying source rates even when attitude alone would discard every interior record, and keeps coverage gaps', async () => {
    const dir = temp();
    const writer = await createSpiceBindings();
    writer.furnsh('naif.tls', new Uint8Array(readFileSync(lsk)));
    writer.furnsh('test.tsc', new TextEncoder().encode(clock));
    writer.furnsh('test.tf', new TextEncoder().encode(frame));
    const et = writer.str2et('2026-01-01');
    const times = [0, 52, 53, 54, 200, 300, 352, 353, 354, 500].map(t => et + t);
    const ticks = times.map(t => writer.sce2c(-999, t));
    const quats = times.flatMap(() => [1, 0, 0, 0]);
    // CK angular velocity is independently supplied. A constant attitude is
    // intentional: no attitude-error gate can detect losing this source data.
    const rates = [0, 0, 0.001, 0, 0, 0, 0, 0.001, 0, 0].flatMap(z => [0, 0, z]);
    writer.writeCk03('source.bc', -999000, 'J2000', 'RATE FIXTURE', new Float64Array(ticks),
      new Float64Array(quats), new Float64Array(rates), new Float64Array([ticks[0], ticks[5]]));
    writeFileSync(join(dir, 'source.bc'), writer.readKernelBytes('source.bc'));
    writeFileSync(join(dir, 'test.tsc'), clock);
    writeFileSync(join(dir, 'test.tf'), frame);
    const output = execFileSync(process.execPath, ['scripts/thin-ck.mjs', '--kernels',
      [lsk, join(dir, 'test.tsc'), join(dir, 'test.tf'), join(dir, 'source.bc')].join(','),
      '--inst=-999000', '--frame', 'REDUCTION_TEST', '--ref', 'J2000', '--step', '60',
      '--verify', '100', '--out', join(dir, 'reduced.bc')], { cwd: root, encoding: 'utf8' });
    expect(output).toMatch(/2 covered stretches/);
    expect(output).toMatch(/max rate error/);
    const reader = await createSpiceBindings();
    for (const [name, data] of [['naif.tls', readFileSync(lsk)], ['test.tsc', Buffer.from(clock)],
      ['test.tf', Buffer.from(frame)], ['reduced.bc', readFileSync(join(dir, 'reduced.bc'))]]) {
      reader.furnsh(name, new Uint8Array(data));
    }
    expect(() => reader.pxform('J2000', 'REDUCTION_TEST', et + 250)).toThrow();
    for (const t of [et, et + 52.5, et + 53, et + 199.999, et + 300.001, et + 353, et + 500]) {
      const a = writer.sxform('J2000', 'REDUCTION_TEST', t);
      const b = reader.sxform('J2000', 'REDUCTION_TEST', t);
      expect(Math.max(...a.map((v, i) => Math.abs(v - b[i])))).toBeLessThan(1e-5);
    }

    // Preserve compatibility with orientation-only sources: their derivative
    // is explicitly estimated rather than mistaken for missing output rates.
    writer.writeCk03('no-av.bc', -999000, 'J2000', 'NO AV FIXTURE', new Float64Array(ticks),
      new Float64Array(quats), null, new Float64Array([ticks[0], ticks[5]]));
    writeFileSync(join(dir, 'no-av.bc'), writer.readKernelBytes('no-av.bc'));
    expect(() => execFileSync(process.execPath, ['scripts/thin-ck.mjs', '--kernels',
      [lsk, join(dir, 'test.tsc'), join(dir, 'test.tf'), join(dir, 'no-av.bc')].join(','),
      '--inst=-999000', '--frame', 'REDUCTION_TEST', '--ref', 'J2000', '--step', '60',
      '--verify', '100', '--out', join(dir, 'no-av-reduced.bc')], { cwd: root, encoding: 'utf8' })).not.toThrow();
  });

  it('rejects a reduced SPK with acceptable position error but unacceptable velocity error', async () => {
    const dir = temp();
    const writer = await createSpiceBindings();
    writer.furnsh('naif.tls', new Uint8Array(readFileSync(lsk)));
    const et = writer.str2et('2026-01-01');
    const times = Array.from({ length: 121 }, (_, i) => et + i * 5);
    const states = times.flatMap(t => {
      const phase = (t - et) / 40;
      return [Math.sin(phase), 0, 0, Math.cos(phase) / 40, 0, 0];
    });
    writer.writeSpkType13('source.bsp', -9990, 399, 'J2000', 'VELOCITY FIXTURE', 7,
      new Float64Array(times), new Float64Array(states));
    writeFileSync(join(dir, 'source.bsp'), writer.readKernelBytes('source.bsp'));
    const result = spawnSync(process.execPath, ['scripts/resample-spk.mjs', '--source', join(dir, 'source.bsp'),
      '--kernels', lsk, '--target=-9990', '--center=399', '--step', '100', '--degree', '3',
      '--verify', '100', '--max-error-m', '10000', '--max-velocity-error-mm-s', '0.001',
      '--out', join(dir, 'reduced.bsp')], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/max velocity error/);
    expect(result.stderr).toMatch(/velocity error exceeds/);
    expect(result.stderr).not.toMatch(/worst error exceeds/);
    expect(existsSync(join(dir, 'reduced.bsp'))).toBe(false);
  });
});
