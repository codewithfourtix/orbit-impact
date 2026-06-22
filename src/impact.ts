/**
 * Impact-analysis queries on top of the Orbit graph.
 *
 * Orbit stores a real call graph: `gl_edge` rows with relationship_kind='CALLS'
 * connect a calling Definition (source) to the called Definition (target).
 * "Blast radius" of a symbol = the transitive closure of callers reachable by
 * walking CALLS edges *backwards* (target -> source).
 */
import { sql, lit } from "./orbit.js";

export interface Definition {
  id: number;
  name: string;
  fqn: string | null;
  file_path: string;
  definition_type: string;
  start_line: number;
}

export interface ImpactedDef extends Definition {
  depth: number;
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

/** Find definitions by name. Exact by default; `fuzzy` does a substring match. */
export async function findSymbol(
  name: string,
  fuzzy = false,
): Promise<Definition[]> {
  const pred = fuzzy
    ? `lower(name) LIKE lower(${lit(`%${name}%`)})`
    : `name = ${lit(name)}`;
  return sql<Definition>(`
    SELECT id, name, fqn, file_path, definition_type, start_line
    FROM gl_definition
    WHERE ${pred}
    ORDER BY file_path, start_line
    LIMIT 50
  `);
}

/**
 * Transitive blast radius of a symbol: every definition that (in)directly calls
 * it, up to maxDepth hops. Depth 0 is the symbol itself; depth >= 1 are callers.
 */
export async function blastRadius(
  name: string,
  opts: { filePath?: string; maxDepth?: number } = {},
): Promise<SymbolImpact> {
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 5, 25));
  let seedPred = `name = ${lit(name)}`;
  if (opts.filePath) seedPred += ` AND file_path = ${lit(opts.filePath)}`;

  const rows = await sql<ImpactedDef>(`
    WITH RECURSIVE impacted(id, name, fqn, file_path, definition_type, start_line, depth) AS (
      SELECT id, name, fqn, file_path, definition_type, start_line, 0
      FROM gl_definition
      WHERE ${seedPred}
      UNION
      SELECT caller.id, caller.name, caller.fqn, caller.file_path,
             caller.definition_type, caller.start_line, i.depth + 1
      FROM impacted i
      JOIN gl_edge e
        ON e.target_id = i.id AND e.target_kind = 'Definition'
       AND e.relationship_kind = 'CALLS'
      JOIN gl_definition caller
        ON caller.id = e.source_id AND e.source_kind = 'Definition'
      WHERE i.depth < ${maxDepth}
    )
    SELECT id, name, fqn, file_path, definition_type, start_line, MIN(depth) AS depth
    FROM impacted
    GROUP BY id, name, fqn, file_path, definition_type, start_line
    ORDER BY depth, file_path, start_line
  `);

  const resolved = rows.filter((r) => r.depth === 0);
  const impacted = rows.filter((r) => r.depth >= 1);
  const summary = summarize(resolved, impacted);
  return { symbol: name, resolved, impacted, summary };
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
 * Analyze a set of changed symbols (e.g. the definitions touched by an MR) and
 * return both structured impact and a ready-to-post Markdown report. This is the
 * payload a Duo flow posts as a merge-request comment.
 */
export async function analyzeChange(
  symbols: string[],
  opts: { maxDepth?: number } = {},
): Promise<{ perSymbol: SymbolImpact[]; markdown: string; rollup: RollupSummary }> {
  const perSymbol: SymbolImpact[] = [];
  for (const s of symbols) {
    perSymbol.push(await blastRadius(s, { maxDepth: opts.maxDepth }));
  }
  const rollup = rollupOf(perSymbol);
  const markdown = renderMarkdown(perSymbol, rollup);
  return { perSymbol, markdown, rollup };
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

const RISK_BADGE: Record<ImpactSummary["risk"], string> = {
  none: "🟢 none",
  low: "🟢 low",
  medium: "🟡 medium",
  high: "🔴 high",
};

function renderMarkdown(per: SymbolImpact[], roll: RollupSummary): string {
  const lines: string[] = [];
  lines.push("## 🛰️ Orbit Impact Analysis");
  lines.push("");
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
    const where = s.resolved
      .map((r) => `\`${r.file_path}:${r.start_line}\``)
      .join(", ");
    lines.push(
      `### \`${s.symbol}\` — ${RISK_BADGE[s.summary.risk]} (${s.summary.total_impacted} impacted)`,
    );
    lines.push(`Defined in ${where}${s.summary.ambiguous ? " _(ambiguous — multiple definitions)_" : ""}.`);
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

  lines.push("---");
  lines.push(
    "<sub>Computed from the GitLab Knowledge Graph (Orbit) call graph — true dependents, not text search. " +
      "Generated by [orbit-impact](https://gitlab.com/).</sub>",
  );
  return lines.join("\n");
}
