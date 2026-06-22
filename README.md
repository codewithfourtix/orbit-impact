# 🛰️ orbit-impact

**Blast-radius impact analysis for code review, powered by the GitLab Knowledge Graph (Orbit).**

`orbit-impact` is an [MCP](https://modelcontextprotocol.io) server that gives AI
agents the one question every reviewer actually asks — *"if I change this, what
breaks?"* — answered from a **real call graph**, not a text search.

It turns GitLab **Orbit** (the Knowledge Graph) into high-level impact tools, and
ships with a **GitLab Duo Agent Platform** flow that posts the answer straight
onto your merge request.

> Built for the GitLab **Transcend** hackathon (Showcase track).

---

## The problem

When you change a function, the dangerous question is *who depends on it?*
Today reviewers answer this with `grep` and vibes:

- **`grep` over-matches** — every comment, string, and unrelated same-named symbol.
- **`grep` under-matches** — it can't follow the call graph two hops out, so the
  scary indirect callers (the ones that actually break in prod) stay invisible.
- LLM reviewers hallucinate dependents because they only see the diff, not the
  whole repository's structure.

Orbit already knows the truth: it parses your repo into a property graph with
real `CALLS` edges between definitions. But Orbit Local only exposes a raw
`run_sql` interface, and agents are bad at writing correct recursive graph SQL.

## The solution

`orbit-impact` wraps Orbit's graph into four typed tools an agent can actually
use, with the recursive call-graph traversal baked in:

| Tool | What it answers |
|---|---|
| `index_repo` | Build/refresh the Orbit graph for a repo. |
| `find_symbol` | Where is this symbol defined? (disambiguation) |
| `blast_radius` | **Every definition that directly or transitively calls this symbol** — the true impact set, with a risk rating. |
| `analyze_change` | Blast radius for *all* symbols changed by an MR, plus a ready-to-post Markdown report. |

Because it reads Orbit's `CALLS` edges, the answer is **exact**: no false
positives from same-named symbols, and it follows the call chain as many hops as
you ask for.

### Real example (the `requests` library)

Changing `Session.send` — `analyze_change(["send"])` returns:

> ## 🛰️ Orbit Impact Analysis
> **Overall risk: 🔴 high** — 48 dependent definition(s) across 3 file(s)…
> | Dependent | Location | Hops |
> |---|---|---|
> | `handle_401` | `src/requests/auth.py:273` | 1 |
> | `resolve_redirects` | `src/requests/sessions.py:186` | 1 |
> | `request` | `src/requests/sessions.py:557` | 1 |
> | …48 total, tests auto-flagged 🧪 | | |

`grep send` would drown you in matches and still miss `handle_401` (an indirect
caller). The graph doesn't.

---

## Architecture

```
            ┌─────────────────────────┐
   git repo │  GitLab Orbit (local)   │  tree-sitter parse → DuckDB property graph
   ─────────►  `orbit index`          │  nodes: gl_definition / gl_file …
            │  `orbit sql`  (CALLS)   │  edges: gl_edge (relationship_kind='CALLS')
            └───────────┬─────────────┘
                        │ read-only SQL (stdin)
            ┌───────────▼─────────────┐
            │   orbit-impact (MCP)    │  recursive blast-radius + risk scoring
            │  index_repo find_symbol │
            │  blast_radius analyze_* │
            └───────────┬─────────────┘
                        │ MCP tools
            ┌───────────▼─────────────┐
            │  GitLab Duo Agent /Flow │  "Orbit Impact Analyzer" (AI Catalog)
            │  → posts MR comment     │  performs an action, not just chat
            └─────────────────────────┘
```

---

## Quick start

### 1. Install Orbit (the Knowledge Graph)

```bash
curl -fsSL "https://gitlab.com/gitlab-org/orbit/knowledge-graph/-/raw/main/install.sh" | bash
export PATH="$HOME/.local/bin:$PATH"
orbit --version
```

### 2. Install & build orbit-impact

```bash
git clone <this-repo> orbit-impact && cd orbit-impact
npm install
npm run build
```

### 3. Index a repository

```bash
node dist/index.js   # then call index_repo, or just:
orbit index /path/to/your/repo
```

### 4. Wire it into an MCP client

**Claude Code / Cursor / any MCP client** — add to your MCP config:

```json
{
  "mcpServers": {
    "orbit-impact": { "command": "node", "args": ["/abs/path/orbit-impact/dist/index.js"] }
  }
}
```

**GitLab Duo (IDE)** — drop the same block into `.gitlab/duo/mcp.json` in your
project. See [`catalog/`](catalog/) for the published agent + flow definitions.

### Try it

```bash
npm run smoke -- send        # impact report for a symbol in the indexed repo
```

---

## Tool reference

<details>
<summary><code>blast_radius(symbol, file_path?, max_depth?)</code></summary>

Returns the resolved definition(s), the transitive caller set (`impacted`, each
with a `depth`), and a `summary` with a `risk` rating
(`none`/`low`/`medium`/`high`), `files_touched`, `test_callers`, and an
`untested` flag (callers exist but none live in test files). `max_depth`
defaults to 5 (max 25).
</details>

<details>
<summary><code>analyze_change(symbols[], max_depth?)</code></summary>

Runs `blast_radius` for each changed symbol, rolls them up, and returns a
`markdown` field ready to post as a merge-request comment.
</details>

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ORBIT_BIN` | `orbit` | Path to the Orbit binary. |
| `ORBIT_DB` | Orbit's default | Override the DuckDB graph path. |

## Limitations & honest notes

- Impact is computed from Orbit's `CALLS` edges, which are resolved per the
  languages Orbit supports (Python, TS/JS, Go, Ruby, Java, Rust, C/C++, C#, PHP…).
  Dynamic dispatch and reflection aren't statically resolvable — same caveat as
  any call-graph tool.
- Common symbol names can resolve to multiple definitions; the report flags this
  as *ambiguous* and `file_path` disambiguates.
- Orbit Local indexes a single repo's code; cross-repo impact needs Orbit Remote.

## License

MIT © 2026 Ali Zulfiqar. See [LICENSE](LICENSE).
