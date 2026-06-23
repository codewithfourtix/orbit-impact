/**
 * Unified-diff parsing.
 *
 * The point of orbit-impact is to answer "what does this change touch?" without
 * a human first having to name the symbols by hand. A merge request already
 * carries that information in its diff, so we parse the diff into the set of
 * source lines each file *gained or lost*, and let the graph layer map those
 * lines onto the definitions that enclose them.
 *
 * This module is intentionally dependency-free and pure so it can be unit
 * tested without Orbit installed.
 */

export interface FileChange {
  /** Repo-relative path of the changed file (b/ side; the post-change file). */
  path: string;
  /** New-side (post-change) line numbers that were added or sit at a deletion. */
  changedLines: number[];
}

/** Strip a leading `a/` or `b/` and any trailing tab-timestamp git appends. */
function normalizeDiffPath(raw: string): string {
  let p = raw.trim();
  // Git appends a tab + timestamp on some `---`/`+++` lines.
  const tab = p.indexOf("\t");
  if (tab !== -1) p = p.slice(0, tab);
  // Quoted paths with special chars: "b/some path".
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p === "/dev/null") return "";
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@+ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff (git or plain) into the changed lines per file, keyed by
 * the new-side path. Renames/deletes whose new side is /dev/null are skipped
 * (there is no post-change definition to analyze). Robust to combined-diff `@@@`
 * headers, mode-change preambles, and "\ No newline at end of file" markers.
 */
export function parseUnifiedDiff(diff: string): FileChange[] {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  let newLine = 0;

  for (const line of diff.split(/\r?\n/)) {
    // New-file header decides which file the following hunks belong to.
    if (line.startsWith("+++ ")) {
      const p = normalizeDiffPath(line.slice(4));
      if (p) {
        current = files.get(p) ?? new Set<number>();
        files.set(p, current);
      } else {
        current = null; // deletion: nothing on the new side to analyze
      }
      continue;
    }
    if (line.startsWith("--- ")) continue; // old-file header — ignore

    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }

    if (!current) continue; // outside a tracked file's hunks

    const c = line[0];
    if (c === "+") {
      current.add(newLine);
      newLine++;
    } else if (c === "-") {
      // A removed line has no new-side number; attribute it to the definition
      // that now occupies this position so pure deletions still resolve.
      current.add(newLine);
    } else if (c === "\\") {
      // "\ No newline at end of file" — not a real line.
    } else {
      // Context line (leading space) or blank: advances the new-side counter.
      newLine++;
    }
  }

  const out: FileChange[] = [];
  for (const [path, set] of files) {
    if (set.size === 0) continue;
    out.push({ path, changedLines: [...set].sort((a, b) => a - b) });
  }
  return out;
}
