/**
 * Impact-analysis queries on top of the Orbit graph.
 *
 * Orbit stores a real call graph: `gl_edge` rows with relationship_kind='CALLS'
 * connect a calling Definition (source) to the called Definition (target).
 * "Blast radius" of a symbol = the transitive closure of callers reachable by
 * walking CALLS edges *backwards* (target -> source).
 *
 * Two entry points matter:
 *   - blastRadius(name)  — impact of a symbol named by hand.
 *   - analyzeDiff(diff)  — impact of a *merge request*: parse the diff, map the
 *                          changed lines onto the exact definitions that enclose
 *                          them, then blast-radius each. No hand-naming, and no
 *                          ambiguity — the diff pins each symbol to one file+line.
 */
import { sql, lit } from "./orbit.js";
import { parseUnifiedDiff, type FileChange } from "./diff.js";

export interface Definition {
  // Orbit's ids are 64-bit and exceed JS's safe-integer range, so we surface
  // them as strings (cast in SQL) to avoid silent precision loss on parse.
  id: string;
  name: string;
  fqn: string | null;
  file_path: string;
  definition_type: string;
  start_line: number;
  end_line: number;
  project_id: string;
}

export interface ImpactedDef extends Definition {
  depth: number;
}

/** A definition the diff actually changed, plus which lines hit it. */
export interface ChangedDef extends Definition {
  changed_lines: number[];
}

export interface SymbolImpact {
  symbol: string;
  resolved: Definition[];
  impacted: ImpactedDef[];
  summary: ImpactSummary;
}

export interface ImpactSummary {
  resolved_count: number;
  ambiguous: boolean;
  direct_callers: number;
  total_impacted: number;
  files_touched: number;
  max_depth_reached: number;
  test_callers: number;
  untested: boolean;
  risk: "none" | "low" | "medium" | "high";
}

const TEST_RE = /(^|\/)(tests?|spec|__tests__)(\/|$)|[._-](test|spec)\.|test_/i;

function isTestFile(path: string): boolean {
  return TEST_RE.test(path);
}

/** Raw definition columns (real BIGINT id) — used inside the CTE for joins/grouping. */
const DEF_COLS =
  "id, name, fqn, file_path, definition_type, start_line, end_line, project_id";
/** Output projection: ids cast to VARCHAR so they survive JSON without rounding. */
const DEF_COLS_OUT =
  "CAST(id AS VARCHAR) AS id, name, fqn, file_path, definition_type, start_line, end_line, CAST(project_id AS VARCHAR) AS project_id";

/**
 * Walk the CALLS graph backwards from a seed set of definitions and return every
 * definition that (in)directly calls the seed, with the shortest hop distance.
 * `seedWhere` is a SQL predicate selecting the seed rows from gl_definition.
 *
 * Edges are keyed by globally-unique definition ids, so the traversal can never
 * cross from one indexed repo into another — the seed's project bounds it.
 */
async function traverse(
  seedWhere: string,
  maxDepth: number,
): Promise<ImpactedDef[]> {
  return sql<ImpactedDef>(`
    WITH RECURSIVE impacted(${DEF_COLS}, depth) AS (
      SELECT ${DEF_COLS}, 0
      FROM gl_definition
      WHERE ${seedWhere}
      UNION
      SELECT caller.id, caller.name, caller.fqn, caller.file_path,
             caller.definition_type, caller.start_line, caller.end_line,
             caller.project_id, i.depth + 1
      FROM impacted i
      JOIN gl_edge e
        ON e.target_id = i.id AND e.target_kind = 'Definition'
       AND e.relationship_kind = 'CALLS'
      JOIN gl_definition caller
        ON caller.id = e.source_id AND e.source_kind = 'Definition'
      WHERE i.depth < ${maxDepth}
    )
    SELECT ${DEF_COLS_OUT}, MIN(depth) AS depth
    FROM impacted
    GROUP BY ${DEF_COLS}
    ORDER BY depth, file_path, start_line
  `);
}

function clampDepth(maxDepth?: number): number {
  return Math.max(1, Math.min(maxDepth ?? 5, 25));
}

/** Find definitions by name. Exact by default; `fuzzy` does a substring match. */
export async function findSymbol(
  name: string,
  fuzzy = false,
): Promise<Definition[]> {
  const pred = fuzzy
    ? `lower(name) LIKE lower(${lit(`%${name}%`)})`
    : `name = ${lit(name)}`;
  return sql<Definition>(`
    SELECT ${DEF_COLS_OUT}
    FROM gl_definition
    WHERE ${pred}
    ORDER BY file_path, start_line
    LIMIT 50
  `);
}

/**
 * Transitive blast radius of a symbol named by hand. Resolves the name (with an
 * optional file disambiguator) and returns its caller closure + a risk summary.
 */
export async function blastRadius(
  name: string,
  opts: { filePath?: string; maxDepth?: number } = {},
): Promise<SymbolImpact> {
  const maxDepth = clampDepth(opts.maxDepth);
  let seedPred = `name = ${lit(name)}`;
  if (opts.filePath) seedPred += ` AND file_path = ${lit(opts.filePath)}`;

  const rows = await traverse(seedPred, maxDepth);
  const resolved = rows.filter((r) => r.depth === 0);
  const impacted = rows.filter((r) => r.depth >= 1);
  return { symbol: name, resolved, impacted, summary: summarize(resolved, impacted) };
}

/**
 * Blast radius of a single definition the diff already pinned to one file+line —
 * so there is no name ambiguity to resolve, unlike the by-name path.
 */
export async function blastRadiusFromDef(def: ChangedDef, maxDepth: number): Promise<SymbolImpact> {
  // Seed by a precise natural key, NOT the id: Orbit's 64-bit ids lose precision
  // when round-tripped through JSON, so `id = <number>` would match nothing.
  const seed =
    `name = ${lit(def.name)} AND file_path = ${lit(def.file_path)} ` +
    `AND start_line = ${Number(def.start_line)} AND end_line = ${Number(def.end_line)}`;
  const rows = await traverse(seed, maxDepth);
  const impacted = rows.filter((r) => r.depth >= 1);
  return { symbol: def.name, resolved: [def], impacted, summary: summarize([def], impacted) };
}

function summarize(resolved: Definition[], impacted: ImpactedDef[]): ImpactSummary {
  const files = new Set(impacted.map((d) => d.file_path));
  const direct = impacted.filter((d) => d.depth === 1).length;
  const testCallers = impacted.filter((d) => isTestFile(d.file_path)).length;
  const maxDepth = impacted.reduce((m, d) => Math.max(m, d.depth), 0);
  const total = impacted.length;

  let risk: ImpactSummary["risk"] = "none";
  if (total > 0) risk = "low";
  if (total >= 5 || files.size >= 3) risk = "medium";
  if (total >= 15 || files.size >= 6) risk = "high";
  // Untested public-ish surface with real fan-out is the dangerous case.
  if (total >= 3 && testCallers === 0 && risk !== "high") risk = "medium";

  return {
    resolved_count: resolved.length,
    ambiguous: resolved.length > 1,
    direct_callers: direct,
    total_impacted: total,
    files_touched: files.size,
    max_depth_reached: maxDepth,
    test_callers: testCallers,
    untested: total > 0 && testCallers === 0,
    risk,
  };
}

/**
 * Map a set of file changes onto the definitions they touch. For each changed
 * line we pick the *innermost* (smallest-span) enclosing definition, so editing
 * one method in a 300-line class reports the method, not the whole class.
 */
export async function resolveChangedDefs(changes: FileChange[]): Promise<ChangedDef[]> {
  const out: ChangedDef[] = [];
  for (const fc of changes) {
    if (fc.changedLines.length === 0) continue;
    const lo = fc.changedLines[0];
    const hi = fc.changedLines[fc.changedLines.length - 1];

    // Prefer an exact path match; fall back to a path-suffix match if the diff
    // carries extra leading directories the graph doesn't.
    const overlap = `start_line <= ${hi} AND end_line >= ${lo}`;
    let defs = await sql<Definition>(
      `SELECT ${DEF_COLS_OUT} FROM gl_definition WHERE file_path = ${lit(fc.path)} AND ${overlap}`,
    );
    if (defs.length === 0) {
      defs = await sql<Definition>(
        `SELECT ${DEF_COLS_OUT} FROM gl_definition WHERE file_path LIKE ${lit(`%/${fc.path}`)} AND ${overlap}`,
      );
    }
    if (defs.length === 0) continue;

    const chosen = new Map<string, ChangedDef>();
    for (const ln of fc.changedLines) {
      let best: Definition | null = null;
      let bestSpan = Infinity;
      for (const d of defs) {
        if (d.start_line <= ln && d.end_line >= ln) {
          const span = d.end_line - d.start_line;
          if (span < bestSpan) {
            bestSpan = span;
            best = d;
          }
        }
      }
      if (!best) continue;
      const existing = chosen.get(best.id);
      if (existing) existing.changed_lines.push(ln);
      else chosen.set(best.id, { ...best, changed_lines: [ln] });
    }
    out.push(...chosen.values());
  }
  return out;
}

export interface RollupSummary {
  symbols_analyzed: number;
  symbols_resolved: number;
  total_impacted_defs: number;
  files_touched: number;
  untested_symbols: number;
  highest_risk: ImpactSummary["risk"];
}

function rollupOf(per: SymbolImpact[]): RollupSummary {
  const files = new Set<string>();
  let total = 0;
  let untested = 0;
  const order = ["none", "low", "medium", "high"] as const;
  let highest: ImpactSummary["risk"] = "none";
  for (const s of per) {
    s.impacted.forEach((d) => files.add(d.file_path));
    total += s.summary.total_impacted;
    if (s.summary.untested && s.summary.total_impacted > 0) untested++;
    if (order.indexOf(s.summary.risk) > order.indexOf(highest)) highest = s.summary.risk;
  }
  return {
    symbols_analyzed: per.length,
    symbols_resolved: per.filter((s) => s.resolved.length > 0).length,
    total_impacted_defs: total,
    files_touched: files.size,
    untested_symbols: untested,
    highest_risk: highest,
  };
}

/**
 * Analyze a set of changed symbols *named by hand* (e.g. for the CLI/agent that
 * already knows the names) and return structured impact + a Markdown report.
 */
export async function analyzeChange(
  symbols: string[],
  opts: { maxDepth?: number } = {},
): Promise<{ perSymbol: SymbolImpact[]; markdown: string; rollup: RollupSummary }> {
  const maxDepth = clampDepth(opts.maxDepth);
  const perSymbol: SymbolImpact[] = [];
  for (const s of symbols) perSymbol.push(await blastRadius(s, { maxDepth }));
  const rollup = rollupOf(perSymbol);
  return { perSymbol, rollup, markdown: renderMarkdown(perSymbol, rollup) };
}

/**
 * Analyze a merge request from its raw unified diff. Parses the diff, resolves
 * the exact changed definitions, and blast-radiuses each — the zero-hand-naming
 * path a Duo flow uses: it already has the MR diff, so it just passes it here.
 */
export async function analyzeDiff(
  diff: string,
  opts: { maxDepth?: number } = {},
): Promise<{
  changed: ChangedDef[];
  perSymbol: SymbolImpact[];
  markdown: string;
  rollup: RollupSummary;
}> {
  const maxDepth = clampDepth(opts.maxDepth);
  const changes = parseUnifiedDiff(diff);
  const changed = await resolveChangedDefs(changes);

  const perSymbol: SymbolImpact[] = [];
  for (const def of changed) perSymbol.push(await blastRadiusFromDef(def, maxDepth));

  const rollup = rollupOf(perSymbol);
  const intro =
    changes.length === 0
      ? "_No textual changes found in the diff._"
      : changed.length === 0
        ? `_Parsed ${changes.length} changed file(s), but none of the changed lines fall inside a definition Orbit has indexed (new file, comments-only, or an un-indexed language)._`
        : `Resolved **${changed.length} changed definition(s)** across ${changes.length} file(s) directly from the diff.`;

  return { changed, perSymbol, rollup, markdown: renderMarkdown(perSymbol, rollup, { intro }) };
}

const RISK_BADGE: Record<ImpactSummary["risk"], string> = {
  none: "🟢 none",
  low: "🟢 low",
  medium: "🟡 medium",
  high: "🔴 high",
};

/** Distinct test files appearing anywhere in the analyzed blast radius. */
function testFilesInRadius(per: SymbolImpact[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of per) {
    for (const d of s.impacted) {
      if (isTestFile(d.file_path)) counts.set(d.file_path, (counts.get(d.file_path) ?? 0) + 1);
    }
  }
  return counts;
}

function renderMarkdown(
  per: SymbolImpact[],
  roll: RollupSummary,
  opts: { intro?: string } = {},
): string {
  const lines: string[] = [];
  lines.push("## 🛰️ Orbit Impact Analysis");
  lines.push("");
  if (opts.intro) {
    lines.push(opts.intro);
    lines.push("");
  }
  lines.push(
    `**Overall risk: ${RISK_BADGE[roll.highest_risk]}** — ` +
      `${roll.total_impacted_defs} dependent definition(s) across ${roll.files_touched} file(s) ` +
      `may be affected by changes to ${roll.symbols_analyzed} symbol(s).`,
  );
  if (roll.untested_symbols > 0) {
    lines.push("");
    lines.push(
      `> ⚠️ ${roll.untested_symbols} changed symbol(s) have callers but **no test coverage in their blast radius** — review carefully.`,
    );
  }
  lines.push("");

  for (const s of per) {
    if (s.resolved.length === 0) {
      lines.push(`### \`${s.symbol}\` — _not found in graph_`);
      lines.push("");
      continue;
    }
    const where = s.resolved.map((r) => `\`${r.file_path}:${r.start_line}\``).join(", ");
    lines.push(
      `### \`${s.symbol}\` — ${RISK_BADGE[s.summary.risk]} (${s.summary.total_impacted} impacted)`,
    );
    lines.push(
      `Defined in ${where}${s.summary.ambiguous ? " _(ambiguous — multiple definitions)_" : ""}.`,
    );
    lines.push("");
    if (s.impacted.length === 0) {
      lines.push("_No callers found — safe to change in isolation._");
    } else {
      lines.push("| Dependent | Location | Hops |");
      lines.push("|---|---|---|");
      for (const d of s.impacted.slice(0, 20)) {
        const flag = isTestFile(d.file_path) ? " 🧪" : "";
        lines.push(`| \`${d.name}\` | \`${d.file_path}:${d.start_line}\`${flag} | ${d.depth} |`);
      }
      if (s.impacted.length > 20) {
        lines.push(`| _…and ${s.impacted.length - 20} more_ | | |`);
      }
      if (s.summary.untested) {
        lines.push("");
        lines.push("> ⚠️ No 🧪 test files in this symbol's blast radius.");
      }
    }
    lines.push("");
  }

  // Actionable: which tests actually exercise this change.
  const tests = testFilesInRadius(per);
  if (tests.size > 0) {
    lines.push("### ✅ Tests to run");
    lines.push("These test files sit in the blast radius — run them to validate the change:");
    lines.push("");
    for (const [file, n] of [...tests].sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${file}\` _(${n} test definition(s) in radius)_`);
    }
    lines.push("");
  } else if (roll.total_impacted_defs > 0) {
    lines.push("### ✅ Tests to run");
    lines.push(
      "> ⚠️ **No test files appear anywhere in the blast radius.** This change is " +
        "effectively untested — consider adding coverage before merging.",
    );
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "<sub>Computed from the GitLab Knowledge Graph (Orbit) call graph — true dependents, not text search. " +
      "Generated by [orbit-impact](https://github.com/codewithfourtix/orbit-impact).</sub>",
  );
  return lines.join("\n");
}
