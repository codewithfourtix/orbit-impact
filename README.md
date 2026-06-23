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

`orbit-impact` wraps Orbit's graph into five typed tools an agent can actually
use, with the recursive call-graph traversal baked in:

| Tool | What it answers |
|---|---|
| `analyze_diff` | **Give it a raw MR diff** — it resolves the exact changed definitions itself and returns a ready-to-post impact report. No hand-naming, no ambiguity. |
| `analyze_change` | Same report, but for symbols you name by hand. |
| `blast_radius` | **Every definition that directly or transitively calls a symbol** — the true impact set, with a risk rating. |
| `find_symbol` | Where is this symbol defined? (disambiguation) |
| `index_repo` | Build/refresh the Orbit graph for a repo. |

Because it reads Orbit's `CALLS` edges, the answer is **exact**: no false
positives from same-named symbols, and it follows the call chain as many hops as
you ask for.

### The headline trick: a diff in, the true blast radius out

A reviewer (or an agent reviewing an MR) already has the diff. `analyze_diff`
parses it, intersects the changed line ranges with Orbit's definition spans, and
picks the **innermost enclosing definition** for each change — so you analyze
*exactly what the MR touched*, pinned to one file and line. The name-ambiguity
problem just disappears.

**Real example — the `requests` library.** A diff that edits one line inside
`Session.send`:

```bash
git diff | orbit-impact diff
```

> ## 🛰️ Orbit Impact Analysis
> Resolved **1 changed definition** across 1 file directly from the diff.
> **Overall risk: 🔴 high** — 40 dependent definitions across 2 files…

The name `send` matches **5** definitions in `requests` (two in `adapters.py`,
two in `sessions.py`, one in a test). A plain `grep send` drowns you in matches;
naming the symbol by hand is ambiguous. The *diff* pins it to exactly
`sessions.py:752` and walks the real call graph from there — catching indirect
callers many hops out that `grep` never shows, and flagging every test in the
radius 🧪.

### Self-contained example — the `shopfast` demo repo

[`orbit-impact-demo`](https://gitlab.com/aalizulfiqar46/orbit-impact-demo) is a
tiny billing app whose tests cover the pricing layer but **not** the
order/invoice layer. Editing `order_total` and running `orbit-impact diff`:

> **Overall risk: 🟡 medium** — 3 dependent definitions across 2 files.
> | Dependent | Location | Hops |
> |---|---|---|
> | `create_invoice` | `shopfast/invoicing.py:6` | 1 |
> | `checkout` | `shopfast/orders.py:12` | 1 |
> | `monthly_statement` | `shopfast/invoicing.py:12` | 2 |
>
> ### ✅ Tests to run
> ⚠️ **No test files appear anywhere in the blast radius** — this change is
> effectively untested.

`monthly_statement` is two hops out — an indirect caller — and the tool proves
the change is untested. That's the answer reviewers actually need.

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
orbit index /path/to/your/repo        # or use the index_repo tool
```

### 4a. Use it as a CLI (no MCP client needed)

The fastest way to feel it — pipe a diff straight in:

```bash
git diff main | node dist/index.js diff      # → the Markdown impact report
node dist/index.js analyze order_total       # by symbol name
node dist/index.js blast send src/requests/sessions.py
node dist/index.js help
```

Add `--json` for structured output, `--max-depth N` to control traversal depth.

### 4b. Wire it into an MCP client

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
<summary><code>analyze_diff(diff, max_depth?)</code></summary>

The headline tool. Parses a unified diff, resolves the **innermost enclosing
definition** for every changed line (so a one-method edit in a big class reports
the method, not the class), and blast-radiuses each. Returns `changed` (the
resolved definitions), `perSymbol`, a `rollup`, and a `markdown` report ready to
post on an MR. No symbol names required, and no ambiguity — the diff pins each
change to one file and line.
</details>

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
