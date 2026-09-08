#!/usr/bin/env bash
#
# Fail if a framework-agnostic package imports a renderer.
#
# CONTRIBUTING.md has claimed "`core` never imports `three` or `cesium`" since
# the repo was opened and M-0001 ratified core as the spine partly on it, but
# nothing checked. tsc cannot: three and cesium are hoisted to the root
# node_modules by the workspace, so an import from core resolves, typechecks
# and builds green.
#
# @cosmolabe/control is held to the same rule and for a sharper reason: it is
# the contract an embed host programs against, and the whole point of a port is
# that it names no implementation. Its `FRAME_MODES` deliberately restates
# `CameraModeName` rather than importing it; the duplication is pinned by a test
# in apps/viewer, which is the one workspace that can see both sides.
#
# The DOM half of the same property is NOT here — each package's tsconfig.json
# drops "DOM" from lib, so tsc rejects `document` and friends during the build
# that already runs. That is an allowlist and beats any denylist a script could
# keep.
#
# One grep per package, deliberately. It catches every import form that appears
# in real code — `from 'three'`, bare `import 'three'`, `import('three')`,
# `require('three')`, type-only imports — and subpaths like
# 'three/examples/jsm/...'. Import specifiers are string literals, so unlike a
# scan for DOM globals (core says "document" in prose 40+ times) this has
# nowhere to pick up a false positive.
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PATTERN="(from|import|require)[[:space:]]*\(?[[:space:]]*['\"](three|cesium|@cesium)(/|['\"])"
readonly PURE_PACKAGES=(core control)

failed=0
for pkg in "${PURE_PACKAGES[@]}"; do
	if hits=$(grep -rnE "$PATTERN" --include='*.ts' "$ROOT/packages/$pkg/src"); then
		echo "purity-lint: @cosmolabe/$pkg must not import a renderer." >&2
		echo >&2
		echo "$hits" | sed "s|$ROOT/||;s|^|  |" >&2
		echo >&2
		failed=1
	fi
done

if [ "$failed" -ne 0 ]; then
	echo "Move renderer-facing code into packages/three or packages/cesium, or take" >&2
	echo "the dependency as an injected parameter the way CatalogResolver takes its" >&2
	echo "\`fetcher\`." >&2
	exit 1
fi

echo "purity-lint: no renderer imports in ${PURE_PACKAGES[*]}."
