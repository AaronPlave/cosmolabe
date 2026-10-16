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

Create a GitHub Project containing Cosmolabe's issues, with auto-add for issues from this repo, then save:

| View | Layout | Filter | Sort / columns |
| --- | --- | --- | --- |
| Ready to Start | Table | `is:issue is:open -is:blocked` | Priority first; show assignee, status, parent |
| Keystones | Table | `is:issue is:open is:blocking` | Priority / manual downstream reach |
| Blocked | Table | `is:issue is:open is:blocked` | Group by status or initiative |
| Initiatives | Table | `is:issue is:open` | Use hierarchy/parent field and group by initiative |

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
