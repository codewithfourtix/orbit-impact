#!/usr/bin/env node
/**
 * orbit-impact — an MCP server (and CLI) that gives AI agents high-level
 * code-impact tools backed by the GitLab Knowledge Graph (Orbit).
 *
 * Orbit Local ships a raw `run_sql` interface only. Agents are bad at writing
 * correct recursive graph SQL, so this server exposes the queries that matter
 * for change review as first-class, typed tools:
 *
 *   - index_repo      build/refresh the graph for a repo
 *   - find_symbol     locate a definition by name (disambiguation)
 *   - blast_radius    transitive callers of a symbol (the impact set)
 *   - analyze_change  blast radius for a set of changed symbol *names* + report
 *   - analyze_diff    blast radius for a raw MR *diff* — resolves the changed
 *                     definitions itself, then reports (the zero-hand-naming path)
 *
 * Run with no arguments it speaks MCP over stdio. Run with a subcommand
 * (analyze/diff/blast/symbol/index) it acts as a standalone CLI — so you can
 * `git diff | orbit-impact diff` without any MCP client at all.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { graphExists, indexRepo } from "./orbit.js";
import { analyzeChange, analyzeDiff, blastRadius, findSymbol } from "./impact.js";

const server = new McpServer({ name: "orbit-impact", version: "0.2.0" });

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (msg: string) => ({
  content: [{ type: "text" as const, text: msg }],
  isError: true,
});

async function ensureGraph(): Promise<string | null> {
  if (await graphExists()) return null;
  return (
    "No Orbit graph found yet. Index a repository first with the `index_repo` " +
    "tool (or run `orbit index <path>` in a terminal)."
  );
}

server.registerTool(
  "index_repo",
  {
    title: "Index a repository into the Orbit graph",
    description:
      "Build or refresh the GitLab Knowledge Graph for a local repository. " +
      "Must be a git repository. Returns indexing statistics.",
    inputSchema: { path: z.string().describe("Absolute path to a git repository to index") },
  },
  async ({ path }) => {
    try {
      return ok(await indexRepo(path));
    } catch (e) {
      return fail(`index_repo failed: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "find_symbol",
  {
    title: "Find a definition by name",
    description:
      "Locate function/class/method definitions by name in the Orbit graph. " +
      "Use this to disambiguate before computing blast radius when a name is common.",
    inputSchema: {
      name: z.string().describe("Symbol name to look up"),
      fuzzy: z.boolean().optional().describe("Substring match instead of exact (default false)"),
    },
  },
  async ({ name, fuzzy }) => {
    const missing = await ensureGraph();
    if (missing) return fail(missing);
    try {
      const defs = await findSymbol(name, fuzzy ?? false);
      return ok({ count: defs.length, definitions: defs });
    } catch (e) {
      return fail(`find_symbol failed: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "blast_radius",
  {
    title: "Compute the blast radius of a symbol",
    description:
      "Return every definition that directly or transitively CALLS the given " +
      "symbol, walking Orbit's call graph. This is the true set of code affected " +
      "by changing the symbol — not a text search. Includes a risk summary.",
    inputSchema: {
      symbol: z.string().describe("Name of the changed symbol"),
      file_path: z.string().optional().describe("Disambiguate by the file the symbol is defined in"),
      max_depth: z.number().int().optional().describe("Max call-graph hops to traverse (default 5, max 25)"),
    },
  },
  async ({ symbol, file_path, max_depth }) => {
    const missing = await ensureGraph();
    if (missing) return fail(missing);
    try {
      return ok(await blastRadius(symbol, { filePath: file_path, maxDepth: max_depth }));
    } catch (e) {
      return fail(`blast_radius failed: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "analyze_change",
  {
    title: "Analyze the impact of a set of changed symbols",
    description:
      "Given the symbols changed by a merge request, compute the combined blast " +
      "radius and return a ready-to-post Markdown impact report plus structured " +
      "data. Use analyze_diff instead when you have the raw MR diff.",
    inputSchema: {
      symbols: z.array(z.string()).min(1).describe("Names of changed symbols"),
      max_depth: z.number().int().optional().describe("Max call-graph hops (default 5)"),
    },
  },
  async ({ symbols, max_depth }) => {
    const missing = await ensureGraph();
    if (missing) return fail(missing);
    try {
      return ok(await analyzeChange(symbols, { maxDepth: max_depth }));
    } catch (e) {
      return fail(`analyze_change failed: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "analyze_diff",
  {
    title: "Analyze the impact of a merge-request diff",
    description:
      "Given the raw unified diff of a merge request, resolve the exact changed " +
      "definitions (no hand-naming, no ambiguity), compute each one's blast " +
      "radius from Orbit's call graph, and return a ready-to-post Markdown " +
      "impact report plus structured data. This is the preferred entry point " +
      "for an MR review agent: pass the diff you already fetched.",
    inputSchema: {
      diff: z.string().min(1).describe("Raw unified diff (e.g. output of `git diff` or the MR changes)"),
      max_depth: z.number().int().optional().describe("Max call-graph hops (default 5, max 25)"),
    },
  },
  async ({ diff, max_depth }) => {
    const missing = await ensureGraph();
    if (missing) return fail(missing);
    try {
      return ok(await analyzeDiff(diff, { maxDepth: max_depth }));
    } catch (e) {
      return fail(`analyze_diff failed: ${(e as Error).message}`);
    }
  },
);

// ───────────────────────────── CLI mode ──────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const CLI_HELP = `orbit-impact — blast-radius impact analysis on the GitLab Knowledge Graph

USAGE
  orbit-impact                         start the MCP server (stdio)
  orbit-impact diff [FILE]             analyze a unified diff (FILE or stdin)
  orbit-impact analyze <SYM>...        analyze named changed symbols
  orbit-impact blast <SYM> [FILE]      blast radius of one symbol
  orbit-impact symbol <NAME> [--fuzzy] locate a definition
  orbit-impact index <PATH>            (re)index a repository

OPTIONS
  --json            print structured JSON instead of the Markdown report
  --max-depth N     max call-graph hops to traverse (default 5)

EXAMPLES
  git diff main | orbit-impact diff
  orbit-impact analyze order_total compute_tax
  orbit-impact blast send src/requests/sessions.py`;

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}
function takeOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const CLI_COMMANDS = new Set(["diff", "analyze", "blast", "symbol", "index", "help", "--help", "-h"]);

async function runCli(argv: string[]): Promise<void> {
  const args = [...argv];
  const cmd = args.shift()!;
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(CLI_HELP);
    return;
  }

  const asJson = takeFlag(args, "--json");
  const maxDepthStr = takeOpt(args, "--max-depth");
  const maxDepth = maxDepthStr ? parseInt(maxDepthStr, 10) : undefined;

  if (cmd === "index") {
    const path = args[0];
    if (!path) throw new Error("index requires a repository PATH");
    console.log(JSON.stringify(await indexRepo(path), null, 2));
    return;
  }

  const missing = await ensureGraph();
  if (missing) throw new Error(missing);

  if (cmd === "diff") {
    const diff = args[0] ? readFileSync(args[0], "utf8") : await readStdin();
    if (!diff.trim()) throw new Error("no diff provided (pass a FILE or pipe one on stdin)");
    const res = await analyzeDiff(diff, { maxDepth });
    console.log(asJson ? JSON.stringify(res, null, 2) : res.markdown);
    return;
  }

  if (cmd === "analyze") {
    if (args.length === 0) throw new Error("analyze requires one or more symbol names");
    const res = await analyzeChange(args, { maxDepth });
    console.log(asJson ? JSON.stringify(res, null, 2) : res.markdown);
    return;
  }

  if (cmd === "blast") {
    const [symbol, filePath] = args;
    if (!symbol) throw new Error("blast requires a symbol name");
    const res = await blastRadius(symbol, { filePath, maxDepth });
    console.log(asJson ? JSON.stringify(res, null, 2) : JSON.stringify({ symbol: res.symbol, summary: res.summary, impacted: res.impacted }, null, 2));
    return;
  }

  if (cmd === "symbol") {
    const fuzzy = takeFlag(args, "--fuzzy");
    const name = args[0];
    if (!name) throw new Error("symbol requires a NAME");
    const defs = await findSymbol(name, fuzzy);
    console.log(JSON.stringify({ count: defs.length, definitions: defs }, null, 2));
    return;
  }

  throw new Error(`unknown command: ${cmd}\n\n${CLI_HELP}`);
}

async function serveMcp(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP channel.
  console.error("orbit-impact MCP server running on stdio");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length > 0 && CLI_COMMANDS.has(argv[0])) {
    await runCli(argv);
  } else {
    await serveMcp();
  }
}

main().catch((e) => {
  console.error("fatal:", (e as Error).message ?? e);
  process.exit(1);
});
