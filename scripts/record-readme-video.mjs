/** Full browser-viewport mission clip; reuses the verified README scene setup. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const videoRecipe = JSON.parse(readFileSync(new URL((process.env.CL_VIDEO_KIND === 'analysis' || process.argv.includes('--analysis'))
  ? '../docs/readme-video-analysis.json' : '../docs/readme-video.json', import.meta.url), 'utf8'));
const recipe = videoRecipe;
const command = (binary, args) => {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${binary} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const ease = t => t * t * (3 - 2 * t);
const interpolate = (a, b, f) => a.map((value, i) => value + (b[i] - value) * f);

export function assertExternalVideoOutput(output) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  assert.ok(output !== repository && !output.startsWith(repository + '/'), 'Video output must be outside the repository');
}

/** Called only after the capture driver has validated assets, events and plots. */
export async function recordMissionVideo(page, scene, output) {
  assertExternalVideoOutput(output);
  assert.equal(scene.id, recipe.scene, 'Video recipe requires its prepared scene');
  const flyby = recipe.kind === 'flyby';
  assert.ok(Number.isInteger(recipe.fps) && recipe.fps > 0 && Number.isInteger(recipe.duration * recipe.fps));
  if (flyby) {
    assert.ok(recipe.flybyEndAt > 0 && recipe.flybyEndAt < recipe.zoomEndAt && recipe.zoomEndAt < recipe.duration);
    assert.ok(recipe.flybyWindow[0] < recipe.flybyWindow[1] && recipe.openingDistanceKm > 0);
    assert.ok(recipe.posterAt >= 0 && recipe.posterAt < recipe.flybyEndAt);
    assert.ok(Math.hypot(...recipe.overviewOffsetKm) > recipe.trajectoryRevealDistanceKm &&
      recipe.trajectoryRevealDistanceKm > recipe.sensorHideDistanceKm && recipe.sensorHideDistanceKm > recipe.openingDistanceKm);
  } else {
    assert.ok(recipe.openAnalysisAt > 0 && recipe.openAnalysisAt < recipe.scrubStartAt &&
      recipe.scrubStartAt < recipe.scrubEndAt && recipe.scrubEndAt < recipe.selectEventAt &&
      recipe.selectEventAt < recipe.duration, 'Video stages must be ordered within the duration');
    assert.ok(recipe.scrubWindow[0] < recipe.scrubWindow[1] &&
      recipe.scrubWindow[0] >= scene.timeline[0] && recipe.scrubWindow[1] <= scene.timeline[1]);
  }
  command(ffmpeg, ['-version']); command(ffprobe, ['-version']);
  const frames = mkdtempSync(resolve(output, 'frames-'));
  const mp4 = resolve(output, recipe.basename + '.mp4');
  const poster = resolve(output, recipe.basename + '-poster.png');
  const count = recipe.duration * recipe.fps;
  const openingEye = flyby ? null : scene.camera.position.map(value => value * recipe.openingCameraScale);
  const stageFrames = Object.fromEntries(['openAnalysisAt', 'scrubStartAt', 'scrubEndAt', 'selectEventAt']
    .map(key => [key, Math.round(recipe[key] * recipe.fps)]));
  let track;
  try {
    if (!flyby) await page.evaluate(({ scene, start }) => {
      return (async () => {
        const shell = await import('/src/lib/shell.svelte.ts');
        const events = await import('/src/lib/event-finder.svelte.ts');
        events.clearSelection(); shell.closeTool('events'); shell.setTimelineDepth('transport');
        cosmo.setTime({ kind: 'et', et: start }); cosmo.track(scene.tracked); cosmo.deselect();
      })();
    }, { scene, start: recipe.scrubWindow[0] });
    if (flyby) {
      await page.evaluate(() => { cosmo.deselect(); cosmo.untrack(); });
    }
    for (let frame = 0; frame < count; frame++) {
      const t = frame / recipe.fps;
      if (flyby) {
        const timeProgress = Math.min(t / recipe.flybyEndAt, 1);
        const zoom = ease(Math.min(Math.max((t - recipe.flybyEndAt) /
          (recipe.zoomEndAt - recipe.flybyEndAt), 0), 1));
        const distance = recipe.openingDistanceKm * Math.pow(Math.hypot(...recipe.overviewOffsetKm) / recipe.openingDistanceKm, zoom);
        await page.evaluate(async ({ recipe, scene, et, zoom, distance }) => {
          const c = cosmo, u = renderer.getContext().universe;
          c.setTime({ kind: 'et', et });
          // Let the renderer update its floating origin before placing a camera
          // just metres from a spacecraft that moved kilometres between frames.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          // All poses use the retained Clipper origin in the inertial frame.
          const a = u.absolutePositionOf('Europa Clipper', et);
          const relative = name => u.absolutePositionOf(name, et).map((v, i) => v - a[i]);
          const normal = v => v.map(x => x / Math.hypot(...v));
          const europa = normal(relative('Europa')), jupiter = relative('Jupiter'), j = normal(jupiter);
          const closeDirection = normal(europa.map((v, i) => -v - j[i]));
          const wideDirection = normal(recipe.overviewOffsetKm);
          const direction = normal(closeDirection.map((v, i) => v * (1 - zoom) + wideDirection[i] * zoom));
          // Recenter in proportion to physical distance, keeping the spacecraft
          // in frame until Jupiter and its moons become the subjects.
          const target = jupiter.map(v => v * distance / Math.hypot(...recipe.overviewOffsetKm));
          c.setCamera(target.map((v, i) => v + direction[i] * distance), target, [0, 0, 1]);
          c.setLayer('sensors', distance < recipe.sensorHideDistanceKm);
          for (const name of renderer.getSensorNames()) c.setObjectVisible(name, distance < recipe.sensorHideDistanceKm && name === scene.sensor);
          const reveal = distance >= recipe.trajectoryRevealDistanceKm;
          c.setLayer('trajectories', reveal);
          if (reveal) for (const name of renderer.trajectoryLines.keys())
            c.showTrajectory(name, ['Europa Clipper', 'Io', 'Europa', 'Ganymede', 'Callisto'].includes(name));
          for (const name of renderer.bodyMeshes.keys()) c.showLabel(name,
            (reveal ? ['Europa Clipper', 'Jupiter', 'Io', 'Europa', 'Ganymede', 'Callisto'] : ['Jupiter', 'Europa']).includes(name));
        }, { recipe, scene, et: recipe.flybyWindow[0] + (recipe.flybyWindow[1] - recipe.flybyWindow[0]) * timeProgress, zoom, distance });
      } else {
        if (frame === stageFrames.openAnalysisAt) {
          await page.getByRole('button', { name: 'Events', exact: true }).click();
          await page.getByRole('button', { name: 'Expand timeline', exact: true }).click();
          await page.evaluate(() => cosmo.untrack());
        }
        const cameraProgress = ease(Math.min(t / recipe.scrubStartAt, 1));
        // Before the panels open, track Saturn. Then retain its coordinate origin
        // and move the aim down, making room for the actual plots and event lanes.
        const aimProgress = ease(Math.min(Math.max((t - recipe.openAnalysisAt) /
          (recipe.scrubStartAt - recipe.openAnalysisAt), 0), 1));
        await page.evaluate(({ position, target, up }) => {
          cosmo.setCamera(position, target, up);
        }, { position: interpolate(openingEye, scene.camera.position, cameraProgress),
          target: interpolate([0, 0, 0], scene.camera.target, aimProgress), up: scene.camera.up });
        if (frame === stageFrames.scrubStartAt) {
          track = await page.getByRole('slider', { name: 'Time scrubber — scroll to zoom, Shift+scroll to pan' })
            .locator('.track').boundingBox();
          assert.ok(track, 'Timeline track must be visible');
          const fraction = (recipe.scrubWindow[0] - scene.timeline[0]) / (scene.timeline[1] - scene.timeline[0]);
          await page.mouse.move(track.x + fraction * track.width, track.y + track.height / 2);
          await page.mouse.down();
        }
        if (frame >= stageFrames.scrubStartAt && frame <= stageFrames.scrubEndAt) {
          const progress = ease((frame - stageFrames.scrubStartAt) /
            (stageFrames.scrubEndAt - stageFrames.scrubStartAt));
          const et = recipe.scrubWindow[0] + (recipe.scrubWindow[1] - recipe.scrubWindow[0]) * progress;
          const fraction = (et - scene.timeline[0]) / (scene.timeline[1] - scene.timeline[0]);
          await page.mouse.move(track.x + fraction * track.width, track.y + track.height / 2);
          if (frame === stageFrames.scrubEndAt) {
            await page.mouse.up();
            const actual = await page.evaluate(() => cosmo.getTime());
            assert.ok(Math.abs(actual - recipe.scrubWindow[1]) < 1, `Timeline drag did not reach its epoch: ${actual}`);
            await page.mouse.move(1900, 15);
          }
        }
        if (frame === stageFrames.selectEventAt) {
          await page.locator('.event-result').click({ position: { x: 120, y: 14 } });
          await page.evaluate(scene => {
            cosmo.deselect(); cosmo.untrack();
            cosmo.setCamera(scene.camera.position, scene.camera.target, scene.camera.up);
          }, scene);
          await page.locator('.event-result.selected').waitFor();
          const actual = await page.evaluate(() => cosmo.getTime());
          assert.ok(Math.abs(actual - scene.et) < 0.001, 'Result click must return to closest approach');
          await page.mouse.move(1900, 15);
        }
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: resolve(frames, `frame-${String(frame).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 });
      if (flyby && frame === Math.round(recipe.posterAt * recipe.fps)) await page.screenshot({ path: poster });
      if (frame % (recipe.fps * 2) === 0) console.log(`Video frames: ${frame}/${count}`);
    }
    if (flyby) {
      const actual = await page.evaluate(() => cosmo.getTime());
      assert.ok(Math.abs(actual - recipe.flybyWindow[1]) < 0.001, 'Flyby must reach its recorded epoch');
    }
    if (!flyby) await page.screenshot({ path: poster });
    command(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(recipe.fps),
      '-i', resolve(frames, 'frame-%04d.jpg'), '-frames:v', String(count),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(recipe.crf),
      '-vf', 'scale=in_range=full:out_range=limited:out_color_matrix=bt709',
      '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-an', mp4]);
    const probe = JSON.parse(command(ffprobe, ['-v', 'error', '-show_entries',
      'stream=codec_name,width,height,pix_fmt,nb_frames,r_frame_rate:format=duration,size', '-of', 'json', mp4]));
    const video = probe.streams[0];
    const viewport = page.viewportSize();
    assert.equal(video.codec_name, 'h264'); assert.equal(video.pix_fmt, 'yuv420p');
    assert.equal(video.width, viewport.width); assert.equal(video.height, viewport.height);
    assert.equal(video.r_frame_rate, `${recipe.fps}/1`);
    assert.equal(Number(video.nb_frames), count); assert.ok(Math.abs(Number(probe.format.duration) - recipe.duration) < 0.05);
    const stamp = seconds => {
      const ms = Math.round(seconds * 1000);
      return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
    };
    const cues = flyby ? [
      [0, recipe.flybyEndAt, 'Europa Clipper flies past Europa, with Jupiter behind it and the EIS narrow-angle field of view on the surface.'],
      [recipe.flybyEndAt, recipe.zoomEndAt, 'Pull back from the spacecraft to reveal Jupiter, its four Galilean moons and the mission trajectory.'],
      [recipe.zoomEndAt, recipe.duration, 'Hold the Jupiter system overview.'],
    ] : [
      [0, recipe.openAnalysisAt, 'Cassini approaches Saturn at orbit insertion.'],
      [recipe.openAnalysisAt, recipe.scrubStartAt, 'Open Event Finder and the six-hour analysis timeline.'],
      [recipe.scrubStartAt, recipe.scrubEndAt, 'Scrub through 100,000 and 150,000 km distance windows, with distance and range-rate plots.'],
      [recipe.scrubEndAt, recipe.selectEventAt, 'Release the timeline at departure.'],
      [recipe.selectEventAt, recipe.duration, 'Select closest approach to align the result, 3D marker and plot playhead.'],
    ];
    const subtitles = 'WEBVTT\n\n' + cues.map(([start, end, text]) => `${stamp(start)} --> ${stamp(end)}\n${text}\n`).join('\n');
    writeFileSync(resolve(output, recipe.basename + '.vtt'), subtitles);
    writeFileSync(resolve(output, recipe.basename + '.json'), JSON.stringify({ recipe, viewport, probe,
      scene, final: await page.evaluate(() => ({ et: cosmo.getTime(), camera: cosmo.getCamera(), snapshot: cosmo.snapshot() })) }, null, 2) + '\n');
    console.log(`Video: ${mp4} (${probe.format.duration}s, ${probe.format.size} bytes); poster: ${poster}`);
  } finally {
    await page.mouse.up().catch(() => {});
    if (process.env.CL_KEEP_VIDEO_FRAMES !== '1') rmSync(frames, { recursive: true, force: true });
  }
}

// CLI delegates setup to the existing driver rather than duplicating searches,
// asset gates, viewport framing or browser launch configuration.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.env.CL_CAPTURE_DIR ?? resolve(tmpdir(), 'cosmolabe-readme-video'));
  assertExternalVideoOutput(output);
  mkdirSync(output, { recursive: true });
  assert.ok(process.argv.slice(2).every(arg => arg === '--analysis'), 'Only --analysis is supported');
  const selectedRecipe = recipe;
  const result = spawnSync(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), 'capture-readme-media.mjs'),
    selectedRecipe.scene, '--video'], { stdio: 'inherit', env: { ...process.env, CL_VIDEO_KIND: selectedRecipe.kind, CL_CAPTURE_DIR: output } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
