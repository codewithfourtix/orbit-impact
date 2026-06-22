# Demo video script (≤ 3:00) — Orbit Impact Analyzer

Goal: make a judge feel the "grep could never do this" moment in under 3 minutes.
Record at 1080p, terminal + browser. Keep cuts tight. Public on YouTube/Vimeo.

---

**[0:00–0:20] The problem.** *(screen: a terminal)*
> "When you change a function, the real question is: what else breaks? Today we
> answer that with grep."

Run `grep -rn "def send" src/ | wc -l` and `grep -rn "send(" . | wc -l` — show one
under-matches, the other returns a wall of noise. "Grep can't follow the call
graph. So the scary *indirect* callers stay invisible."

**[0:20–0:45] Orbit = the GitLab Knowledge Graph.**
> "GitLab Orbit indexes the repo into a real graph — with actual CALLS edges
> between functions."

Run `orbit index ~/requests --stats` (pre-warmed). One line: "907 definitions,
2114 call edges, in under a second."

**[0:45–1:05] The artifact.** *(screen: GitLab, the merge request)*
Open an MR that edits `Session.send`. "I'll run our published AI Catalog agent,
Orbit Impact Analyzer, on this MR." Trigger it.

**[1:05–1:55] The payoff.** *(the agent posts the comment)*
Let the 🛰️ Orbit Impact Analysis comment render. Narrate the highlights:
> "48 dependents across 3 files. Risk: high. It found `handle_401` — an
> *indirect* caller two hops out that grep never showed. Every test in the blast
> radius is flagged. And it warns that some callers have no test coverage."

Then point at the auto-opened issue: "It didn't just talk — it acted: opened an
issue to add the missing tests."

**[1:55–2:25] Reusable.** *(screen: AI Catalog)*
Show the agent in the AI Catalog, Visibility: Public. "Anyone in the org installs
it once and every MR gets true impact analysis — powered entirely by Orbit."

**[2:25–2:45] Close.**
> "orbit-impact: it turns Orbit's graph into the one answer reviewers actually
> need — what does this change really touch — and posts it right on the MR.
> Open source, MIT."

End card: repo URL + AI Catalog URL.

---
### Recording checklist
- [ ] Pre-index the demo repo so indexing is instant on camera.
- [ ] Pre-stage the MR diff (change `Session.send`).
- [ ] Disambiguate beforehand: know which `send` you're demoing.
- [ ] Have the AI Catalog tab open and the agent already Public.
- [ ] Hide secrets/tokens. Use the personal account only.
