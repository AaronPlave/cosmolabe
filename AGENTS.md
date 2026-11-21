# Issue and initiative hygiene

When creating or materially changing a GitHub issue in Cosmolabe:

1. Search existing issues first. Reuse an appropriate **one native parent** when the work is part of an existing initiative. Create a small tracking-only "Initiative:" parent first only if a real group of deliverables needs one; never introduce a parent for a single unrelated issue.
2. Identify **hard open prerequisites**, not merely code overlap, shared components, optional future capabilities or preferred work order. Use native blockers only if implementation cannot safely start without the prerequisite. Avoid cycles and redundant transitive blockers.
3. Always include this exact section, including explicit **None** when appropriate:

   ## Issue relationships
   - Parent issue: #316
   - Blocked by: #307, #285
   - Related (not blockers): #250

   For an independent issue or root initiative use Parent issue: None. If there are no hard blockers use Blocked by: None. The Related field is optional context only.
4. GitHub Actions automatically applies the explicitly declared native Parent issue and Blocked by relationships on new or edited issues, with a weekly reconciliation audit. **Do not assume #123 prose mentions are sufficient, and do not invent dependencies.** Confirm native links appear.
5. On an existing issue, removing/changing the text does not remove old native links: use the GitHub issue sidebar for removal/reparenting. For relationships also listed in .github/issue-relationships.json, update that manifest too or the legacy additive backfill may restore removed links.
6. For work delegated to coding/research agents, include the relationship section in the issue body itself, not just a comment or handoff. Prefer one full-scope implementation PR where feasible; a parent does not imply splitting scope or making sibling issues block each other.

See [docs/issue-dependencies.md](docs/issue-dependencies.md). GitHub Projects auto-add and saved-view configuration are separate from native relationship links.
