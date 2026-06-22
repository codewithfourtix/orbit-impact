#!/usr/bin/env node
/**
 * orbit-impact — an MCP server that gives AI agents high-level code-impact
 * tools backed by the GitLab Knowledge Graph (Orbit).
 *
 * Orbit Local ships a raw `run_sql` interface only. Agents are bad at writing
 * correct recursive graph SQL, so this server exposes the queries that matter
 * for change review as first-class, typed tools:
 *
 *   - index_repo      build/refresh the graph for a repo
 *   - find_symbol     locate a definition by name (disambiguation)
 *   - blast_radius    transitive callers of a symbol (the impact set)
 *   - analyze_change  blast radius for a set of changed symbols + a ready-to-post
 *                     Markdown report (what a Duo flow posts on a merge request)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { graphExists, indexRepo } from "./orbit.js";
import { analyzeChange, blastRadius, findSymbol } from "./impact.js";

const server = new McpServer({
  name: "orbit-impact",
  version: "0.1.0",
});

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
      file_path: z
        .string()
        .optional()
        .describe("Disambiguate by the file the symbol is defined in"),
      max_depth: z
        .number()
        .int()
        .optional()
        .describe("Max call-graph hops to traverse (default 5, max 25)"),
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
      "data. Intended to be posted as a merge-request comment by an agent/flow.",
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP channel.
  console.error("orbit-impact MCP server running on stdio");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
