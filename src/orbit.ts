/**
 * Thin wrapper around the Orbit local CLI (`orbit`), the GitLab Knowledge Graph.
 *
 * Orbit indexes a repository into a local DuckDB property graph and exposes a
 * read-only `orbit sql` interface. We shell out to it rather than re-implement
 * any parsing: Orbit owns the tree-sitter parsing and graph construction, we
 * own the higher-level impact queries on top.
 */
import { spawn } from "node:child_process";

/** Path to the orbit binary. Overridable for non-standard installs. */
const ORBIT_BIN = process.env.ORBIT_BIN || "orbit";
/** Optional explicit DuckDB path (defaults to orbit's own ~/.orbit/graph.duckdb). */
const ORBIT_DB = process.env.ORBIT_DB || "";

export class OrbitError extends Error {}

function run(
  args: string[],
  stdin?: string,
  timeoutMs = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ORBIT_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new OrbitError(`orbit ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new OrbitError(
          `failed to launch '${ORBIT_BIN}': ${e.message}. Is Orbit installed and on PATH? ` +
            `Install: curl -fsSL https://gitlab.com/gitlab-org/orbit/knowledge-graph/-/raw/main/install.sh | bash`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new OrbitError((err || out || `orbit exited ${code}`).trim()));
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

/**
 * Run a read-only SQL query against the local Orbit graph and return rows as
 * objects. SQL is passed over stdin so we never have to escape it into argv.
 */
export async function sql<T = Record<string, unknown>>(
  query: string,
): Promise<T[]> {
  const args = ["sql", "-F", "json"];
  if (ORBIT_DB) args.push("--db", ORBIT_DB);
  args.push("-"); // read query from stdin
  const out = await run(args, query);
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed) as T[];
  } catch {
    throw new OrbitError(`could not parse orbit sql output as JSON: ${trimmed.slice(0, 200)}`);
  }
}

/** Index (or re-index) a repository into the local graph. Returns Orbit's JSON stats. */
export async function indexRepo(path: string): Promise<unknown> {
  const out = await run(["index", path, "--stats"], undefined, 600_000);
  try {
    return JSON.parse(out.trim());
  } catch {
    return { raw: out.trim() };
  }
}

/** Has any repository been indexed yet? Used to give agents a helpful error. */
export async function graphExists(): Promise<boolean> {
  try {
    await sql("SELECT 1 AS ok LIMIT 1");
    return true;
  } catch {
    return false;
  }
}

/** Escape a value as a DuckDB string literal (doubles single quotes). */
export function lit(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}
