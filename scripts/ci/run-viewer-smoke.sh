#!/usr/bin/env bash
# Shared browser harness for targeted PR checks and the scheduled/manual full run.
# Usage: bash scripts/ci/run-viewer-smoke.sh stars|geographic pr|full
set -euo pipefail

suite="${1:?expected stars or geographic}"
level="${2:?expected pr or full}"
if [[ "$level" != pr && "$level" != full ]]; then
  echo "Unknown smoke level: $level" >&2
  exit 2
fi

if [[ "$suite" == stars ]]; then
  # Shader/readback is an independent WebGL fixture; no viewer server needed.
  CL_STAR_OUTPUT=/tmp/starfield-webgl npm run test:stars:webgl
elif [[ "$suite" != geographic ]]; then
  echo "Unknown smoke suite: $suite" >&2
  exit 2
fi

export DEV_DATA_MODE=local
export CL_VIEWER_URL=http://127.0.0.1:5188/
npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5188 --strictPort > /tmp/viewer-smoke-vite.log 2>&1 &
viewer_pid=$!
trap 'kill "$viewer_pid" 2>/dev/null || true' EXIT

ready=0
for attempt in $(seq 1 60); do
  if curl --fail --silent "$CL_VIEWER_URL" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "Viewer did not start at $CL_VIEWER_URL; see /tmp/viewer-smoke-vite.log" >&2
  exit 1
fi

case "$suite" in
  stars)
    if [[ "$level" == pr ]]; then
      CL_STAR_SMOKE=1 CL_STAR_OUTPUT=/tmp/starfield-viewer npm run capture:stars
    else
      CL_STAR_OUTPUT=/tmp/starfield-viewer npm run capture:stars
    fi
    ;;
  geographic)
    if [[ "$level" == pr ]]; then
      export CL_SMOKE=1 CL_FRAMES=1
    fi
    CL_OUTPUT=/tmp/geographic-global-smoke node scripts/test-geographic-global.mjs
    CL_OUTPUT=/tmp/planetary-places node scripts/test-planetary-places.mjs
    echo '::group::Place inspector/source/framing acceptance'
    CL_OUTPUT=/tmp/planetary-place-inspector node scripts/test-place-inspector.mjs
    echo '::endgroup::'
    echo '::group::Place label-motion acceptance'
    CL_OUTPUT=/tmp/planetary-places-motion node scripts/test-place-label-motion.mjs
    echo '::endgroup::'
    CL_OUTPUT=/tmp/planetary-place-targets node scripts/test-place-targets.mjs
    ;;
esac
