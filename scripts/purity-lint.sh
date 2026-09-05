#!/usr/bin/env bash
#
# Fail if @cosmolabe/core imports a renderer.
#
# CONTRIBUTING.md has claimed "`core` never imports `three` or `cesium`" since
# the repo was opened and M-0001 ratified core as the spine partly on it, but
# nothing checked. tsc cannot: three and cesium are hoisted to the root
# node_modules by the workspace, so an import from core resolves, typechecks
# and builds green.
#
# The DOM half of the same property is NOT here — packages/core/tsconfig.json
# drops "DOM" from lib, so tsc rejects `document` and friends during the build
# that already runs. That is an allowlist and beats any denylist a script could
# keep.
#
# One grep, deliberately. It catches every import form that appears in real
# code — `from 'three'`, bare `import 'three'`, `import('three')`,
# `require('three')`, type-only imports — and subpaths like
# 'three/examples/jsm/...'. Import specifiers are string literals, so unlike a
# scan for DOM globals (core says "document" in prose 40+ times) this has
# nowhere to pick up a false positive.
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PATTERN="(from|import|require)[[:space:]]*\(?[[:space:]]*['\"](three|cesium|@cesium)(/|['\"])"

if hits=$(grep -rnE "$PATTERN" --include='*.ts' "$ROOT/packages/core/src"); then
	echo "purity-lint: @cosmolabe/core must not import a renderer." >&2
	echo >&2
	echo "$hits" | sed "s|$ROOT/||;s|^|  |" >&2
	echo >&2
	echo "Move renderer-facing code into packages/three or packages/cesium, or take" >&2
	echo "the dependency as an injected parameter the way CatalogResolver takes its" >&2
	echo "\`fetcher\`." >&2
	exit 1
fi

echo "purity-lint: no renderer imports in packages/core/src."
