/**
 * Module stores outlive a Svelte component tree: unmounting the workspace
 * leaves `vs`, `shell` and the rest holding the last session's panels,
 * selection and timeline. An embedding host that disposes and remounts must
 * get a fresh viewer, so each store records its initial value here and
 * `resetStores` restores them all.
 */
const resets: Array<() => void> = [];

export function resettable<T extends object>(store: T): void {
  // Copied now: on the server build `$state.snapshot` hands back the store itself.
  const initial = structuredClone($state.snapshot(store)) as T;
  resets.push(() => Object.assign(store, structuredClone(initial)));
}

export function resetStores(): void {
  for (const reset of resets) reset();
}
