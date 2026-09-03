#!/usr/bin/env bash
#
# Fail if a tracked file is stored as a git-lfs pointer while NOT being routed
# through lfs by .gitattributes.
#
# This is the signature of an lfs narrowing: an extension is removed from
# .gitattributes (or a path rule is dropped), but the blobs committed while the
# old rule was live are not re-staged. Git keeps serving the ~130-byte pointer,
# so the file ships as a short chunk of ASCII wearing a binary's name — a .wasm
# that is not WebAssembly, a .jpg that is not an image. Nothing else in the
# build notices, because the file is present and readable.
#
# Files that ARE lfs-routed are skipped: a pointer there is normal for a
# checkout that has not fetched lfs objects.
set -euo pipefail

readonly POINTER_MAGIC='version https://git-lfs.github.com/spec/v1'
status=0

while IFS= read -r file; do
	[ -f "$file" ] || continue

	# Pointers are tiny; anything larger cannot be one, and skipping early
	# keeps this to a stat for the overwhelming majority of files.
	size=$(wc -c <"$file")
	[ "$size" -le 200 ] || continue

	head -c ${#POINTER_MAGIC} "$file" 2>/dev/null | grep -qF "$POINTER_MAGIC" || continue

	# check-attr prints "<path>: filter: <value>"; unset attrs give "unspecified".
	filter=$(git check-attr filter -- "$file" | sed 's/.*: //')
	if [ "$filter" != "lfs" ]; then
		echo "::error file=$file::stored as a git-lfs pointer but .gitattributes does not route it through lfs — re-stage it with 'git -c filter.lfs.clean=cat add --renormalize $file'"
		status=1
	fi
done < <(git ls-files)

if [ "$status" -eq 0 ]; then
	echo "No stale git-lfs pointers: every pointer-shaped file is lfs-routed."
fi

exit "$status"
