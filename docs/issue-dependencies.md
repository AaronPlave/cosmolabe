# Issue sequencing and dependencies

Cosmolabe tracks **hard prerequisites** with GitHub's native **Blocked by / Blocking** relationships, and **initiatives** with GitHub's native **parent / sub-issue** relationships. A parent is not itself a blocker.

## Start here

Use these live GitHub issue searches after the dependency backfill has run:

- [Ready to start — open, not blocked](https://github.com/AaronPlave/cosmolabe/issues?q=is%3Aissue+is%3Aopen+-is%3Ablocked)
- [High-priority, ready to start](https://github.com/AaronPlave/cosmolabe/issues?q=is%3Aissue+is%3Aopen+-is%3Ablocked+label%3A%22priority%3A+high%22)
- [Keystones — currently blocking other issues](https://github.com/AaronPlave/cosmolabe/issues?q=is%3Aissue+is%3Aopen+is%3Ablocking)
- [Blocked work](https://github.com/AaronPlave/cosmolabe/issues?q=is%3Aissue+is%3Aopen+is%3Ablocked)

*Note:* Unblocked doesn't mean independently safe to implement: human UX review, ongoing PRs and non-issue external prerequisites can still matter. A keystone is useful because it unlocks other work, not necessarily because it has the highest urgency.

## Suggested GitHub Projects views

Use the existing Cosmolabe Project (or configure an auto-add Project for this repo if one is not present), then save:

| View | Layout | Filter | Sort / columns |
| --- | --- | --- | --- |
| Ready to Start | Table | `is:issue is:open -is:blocked` | Priority first; show assignee, status, parent |
| Keystones | Table | `is:issue is:open is:blocking` | Priority / manual downstream reach |
| Blocked | Table | `is:issue is:open is:blocked` | Group by status or initiative |
| Initiatives | Table | `is:issue is:open` (optionally `has:parent-issue` to hide unparented items) | Group by **Parent issue**, or enable **Show hierarchy** to see nested initiatives and their sub-issues |

Project view filters vary by Projects UI; use the linked repository searches as the working fallback when a Project filter isn't accepted. The repository GitHub integration does not currently expose creating or configuring user-owned Projects views, so **these views must be saved in the GitHub UI**. Do not mistake the suggested configuration for a created Project.

## How the backfill works

- `.github/issue-relationships.json` lists hard dependencies as `blockedBy` and initiative membership as `subIssues`. Numbers are repository issue numbers.
- `scripts/sync-issue-relationships.mjs --validate` checks shape and cycles without GitHub credentials.
- `--dry-run` uses the GitHub API to preview missing links (requires `GITHUB_TOKEN`).
- `--apply` adds the missing native GitHub links (requires `GITHUB_TOKEN` with Issues write permission).
- The `Issue dependency graph` workflow validates changes on PRs and applies the additive backfill after the manifest/workflow/script is merged to `main`. It can also be dispatched manually, with apply off by default.
- Existing links are preserved. Existing parents are never replaced. Closed blockers and closed targets are not given new blocking links. A rerun doesn't duplicate links.
- This is a *one-time audited backfill and occasional explicit corrections*, not a cron job that guesses dependencies from free-text issue bodies. Future issues should get native relationships at creation time.

## Rules of thumb

1. Use **Blocked by** only when starting the downstream implementation before completion of the prerequisite would force rework or be unsafe. Avoid redundant transitive edges.
2. Use **Sub-issue** for scope decomposition and progress reporting. Grouping is not scheduling.
3. Keep `Related`, `follows`, `coordinate with` and optional enhancements in prose unless they genuinely block starting.
4. Don't block an entire large issue on a sibling's nice-to-have improvements; split it if only one phase needs the prerequisite.
5. Before taking work, check its open blockers **and** any active PR touching the same area.
6. Mark priority separately from blocking. A high-impact issue with no prerequisites can be a keystone; not every keystone is urgent.

## Initial audit coverage

The 2026-10-16 audit reviewed the 95 open issues returned by GitHub issue search and captured the clear prerequisite chains: Mars cube migration, surface data authoring/publishing, GeoJSON surface layers, Rosetta observation phases, Instrument View, Sun/terrain lighting, atmosphere coupling, bookmarks, and terrain-aware events. Other work remains independent or loosely related intentionally. Extend the manifest only for verified hard dependencies, and update native relationships directly for routine new issues.

GitHub docs: [issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies), [sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues), and [saved Projects views](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/managing-your-views).

## 2026-10-30 open-issue audit and maintenance

Reviewed all **103** open issues, including the October surface-data, Jezero, mission plugin, scripting and AI-control additions. Added five verified hard dependencies to the manifest:

- #285 blocked by #307 — reusable scientific raster output contract before the viewer consumer.
- #308 blocked by #285 — integrated Diviner/Mini-SAR scalar demo needs the real raster viewer (indirectly depends on #307).
- #295 blocked by #247 — reuse verified local-mesh placement instead of implementing another registration contract.
- #312 blocked by #311 — external agent/MCP adapter consumes shared typed tool facade.
- #313 blocked by #311 — voice consumes the same tool facade; **not** blocked by MCP #312.

Independent or optionally coordinated work deliberately remains unblocked: #309 imagery-only publishing, #250 initial graphical planner (later science controls may wait), #294 flight mosaics/source investigation, #306 historical flight geometry, #296 plugin demo and #297's broader scripting gaps. The 2026-10-30 initial dependency pass did not add parent/sub-issue links; the dedicated hierarchy audit below addresses that separately.

Older manifest entries can mention now-closed issues: the sync job skips closed targets and closed blockers, so historical links aren't re-created. Native issue dependencies still retain their history; closing the blocking issue resolves the remaining work's active blocker.

### When opening or updating an issue

1. Check the issue's full scope and any existing PR before declaring a blocker. Only **hard, open prerequisites** receive native `Blocked by`; a mention of `#123`, `related`, `uses`, or an optional future capability is not itself a blocker.
2. If you have access to GitHub's native issue relationship controls, create `Blocked by` and `Sub-issue` relationships immediately in the issue sidebar (or via the GitHub REST dependency/sub-issue API). Do not confuse parentage with sequencing.
3. When working through an integration that cannot directly write native relationship endpoints, update `.github/issue-relationships.json` in the same change. The `Issue dependency graph` workflow validates on PR and applies native links on merge. Never claim a relationship was applied just because it appears in prose or a PR diff.
4. Verify the blocked/ready state after merging, periodically review open blockers against completed issues, and keep issue priority/Project status independent of blocking.
5. GitHub Projects membership and saved view/status/priority fields are **not writable through this repository integration**. Use the Project UI for those fields; do not claim that the manifest configures Projects views.

## 2026-10-30 initiative hierarchy audit

The Projects `Initiatives` view is grouped by GitHub's native **Parent issue**. Dependency links do not populate this field. Before this pass, it showed only a few historic root issues and a large `No Parent issue` bucket.

Eight tracking-only initiative issues were created (these do **not** demand new implementation PRs or change child issue ownership):

| Parent tracker | Workstream | Existing issues grouped under it |
| --- | --- | --- |
| #315 | AI and agent-driven visualization | #311, #312, #313 |
| #316 | Surface data, science layers and publishing | #250, #285, #286, #307, #308, #309 |
| #317 | Jezero mission content | #294, #295, #306 |
| #318 | Instrument/observation systems | #28, #175, #192–#195, #280, #282 |
| #319 | Planetary geographic data/places | #201, #266, #267, #290 |
| #320 | Navigation, views and capture | #116, #220–#224 |
| #321 | Spatial guides, measures and analysis | #157–#160, #176, #177, #216, #217, #254, #259 |
| #322 | Solar/airless physical lighting | #204–#207, #243 |

Existing initiatives were expanded without replacing any existing parent: #14 adopts #297; #47 adopts #238, #239, #240, #256, #257; #107 adopts #234/#235; #134 adopts #219; #182 adopts #264. No new `Blocked by` links were created in this hierarchy pass—parenthood is grouping only. Some issues intentionally remain top-level because they are independent, cross-cutting or research/maintenance work. Parent tracking issues themselves also naturally have no parent.

**To use the saved Projects view:** in `Cosmolabe Management → Initiatives`, keep `is:issue is:open`, group by `Parent issue`, and expand groups. To hide standalone issues from this specific grouped workstream view, add `has:parent-issue` if accepted by the Project's field filter. Alternatively enable GitHub's newer `Show hierarchy` mode in the view menu to see parent issues with nested children; filter/group semantics differ. Neither change is applied through the repository connector. The `Ready to Start` and `Blocked` views should keep independent issues and should not filter on initiative membership.

**Verification:** The native parent links are written by `Issue dependency graph` CI after the manifest PR merges. Inspect the project's Parent issue groups and sample child sidebars after the sync completes. Do not equate a committed manifest with already-synchronized GitHub relationships. Make sure the new initiative parent issues are included in the Project; auto-add is configured outside this repository integration.

GitHub Projects documentation: [parent and sub-issue progress fields](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-parent-issue-and-sub-issue-progress-fields), [filter Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/filtering-projects), [hierarchy view](https://github.blog/changelog/2026-03-19-hierarchy-view-in-github-projects-is-now-generally-available/).
