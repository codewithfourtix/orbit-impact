# Integration & demo runbook

Step-by-step to publish the Showcase artifact and record the demo. Items marked
**[Ali]** need the GitLab account + Duo trial; the rest are already done/local.

## Prerequisites
- [x] Orbit installed, repo indexed, `orbit-impact` built & MCP-tested (done in WSL).
- [x] Standalone CLI verified: `git diff | node dist/index.js diff` prints the
      report with **no GitLab account or Duo credits required**. This is the
      always-works core of the demo — record it even if the live Agent run is
      flaky, since it proves the Orbit-powered impact analysis end-to-end.
- [ ] **[Ali]** Personal GitLab.com account.
- [ ] **[Ali]** GitLab Duo trial started (for Agent Platform execution credits).
- [ ] **[Ali]** Public GitLab project created to host this MIT repo.

## A. Publish the repo
1. Create a public project on GitLab.com (personal namespace).
2. Push this repo to it (MIT LICENSE already present).

## B. Wire Orbit into a target project (the repo we'll analyze in the demo)
1. Pick a demo repo (e.g. a fork of `psf/requests`, or a small sample app).
2. `orbit index <demo-repo-path>` so the graph is fresh.
3. Copy `catalog/mcp.json` → `<demo-repo>/.gitlab/duo/mcp.json`, fixing the
   absolute path to `dist/index.js`.

## C. Publish the AI Catalog artifact
1. GitLab → **AI → Agents → New agent**.
2. Paste the fields from `catalog/agent-orbit-impact.md` (name, description,
   system prompt; select the GitLab action tools).
3. Save as **Private** first; test it on a merge request in the demo repo.
4. Once it posts a correct impact comment, flip **Visibility → Public** and note
   the AI Catalog URL — this is the submission link.
   - (Optional) Alternatively publish the **Flow** from `catalog/flow-orbit-impact.yml`.

## D. Verify the action end-to-end
1. Open a merge request in the demo repo that changes a high-fan-in function
   (e.g. `Session.send`).
2. Invoke the Orbit Impact Analyzer agent on the MR.
3. Confirm it posts the 🛰️ Orbit Impact Analysis comment with the real blast
   radius, and (for an untested high-risk symbol) opens a follow-up issue.

## E. Record the ≤3-min demo video
Suggested beat sheet (see `../demo/SCRIPT.md`):
1. (0:00) The problem — `grep send` over/under-matches. 20s.
2. (0:20) `orbit index` the repo; one line on Orbit = the GitLab Knowledge Graph. 25s.
3. (0:45) Open the MR; run the Orbit Impact Analyzer agent. 20s.
4. (1:05) The comment appears: 48 dependents, risk 🔴 high, untested callers,
   indirect caller `handle_401` that grep missed. 50s.
5. (1:55) Show it's reusable — the artifact in the AI Catalog, Public. 30s.
6. (2:25) Close: "true impact from the call graph, as an action on your MR." 20s.
Upload to YouTube/Vimeo, **set Public**.

## F. Devpost submission
- Repo link (public, MIT) ✔
- AI Catalog artifact link (Public) ✔
- Demo video link (Public) ✔
- Written description: problem / solution / how Orbit is used / what's next.
