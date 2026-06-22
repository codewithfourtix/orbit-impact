/**
 * Smoke test: exercises the impact layer directly against whatever repo is
 * currently indexed in the local Orbit graph. Run: `npm run smoke -- compute_tax`
 */
import { findSymbol, blastRadius, analyzeChange } from "./impact.js";

async function main() {
  const symbol = process.argv[2] || "compute_tax";

  console.log(`\n=== find_symbol("${symbol}") ===`);
  console.log(JSON.stringify(await findSymbol(symbol), null, 2));

  console.log(`\n=== blast_radius("${symbol}") ===`);
  const br = await blastRadius(symbol);
  console.log(JSON.stringify(br.summary, null, 2));
  console.log("impacted:", br.impacted.map((d) => `${d.name}@${d.file_path}#${d.depth}`));

  console.log(`\n=== analyze_change(["${symbol}"]) → markdown ===`);
  const { markdown } = await analyzeChange([symbol]);
  console.log(markdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
