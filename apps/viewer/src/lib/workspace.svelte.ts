/**
 * The workspace the viewer occupies: the whole page (standalone), or a host
 * element (embedded, `embed.ts`).
 *
 * Embedded, the workspace root is the containing block for every page-level
 * layer — floating panels, callouts, portalled popovers — so they scroll with
 * the host page and stay inside the workspace. Those layers place themselves
 * in workspace coordinates; `toWorkspace` converts a pointer's client
 * coordinates, and is the identity for the standalone page, whose root sits
 * at the viewport origin.
 */
import type { WorkspaceUi } from '../embed-api';

export type { WorkspaceUi };

export const ALL_UI: Readonly<WorkspaceUi> = Object.freeze({
  timeline: true, toolRail: true, analysisPanels: true, catalogBrowser: true, homeScreen: true, shortcuts: true,
});

export const workspace = $state({
  embedded: false,
  ui: { ...ALL_UI } as WorkspaceUi,
  /** Root size in CSS pixels, kept by a ResizeObserver. */
  width: 0,
  height: 0,
});

let root: HTMLElement | null = null;

export function setWorkspaceRoot(el: HTMLElement | null): void {
  root = el;
}

/** Where page-level layers mount: the page body standalone, the workspace root embedded. */
export function layerRoot(): HTMLElement {
  return workspace.embedded && root ? root : document.body;
}

/** The node the workspace's own DOM queries run against. */
export function workspaceNode(): ParentNode {
  return (workspace.embedded && root?.getRootNode() as ParentNode | undefined) || document;
}

/** Client coordinates → workspace coordinates. */
export function toWorkspace(x: number, y: number): { x: number; y: number } {
  if (!workspace.embedded || !root) return { x, y };
  const r = root.getBoundingClientRect();
  return { x: x - r.left, y: y - r.top };
}

/** The workspace's size: what page-level layers clamp to instead of the window. */
export function workspaceSize(): { width: number; height: number } {
  const { width, height } = workspace;
  if (width > 0 && height > 0) return { width, height };
  return { width: window.innerWidth, height: window.innerHeight };
}
