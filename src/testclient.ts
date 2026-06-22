/**
 * Verifies the full MCP path: spawns the built server over stdio, lists tools,
 * and calls analyze_change. Run: `npx tsx src/testclient.ts compute_tax`
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const symbol = process.argv[2] || "compute_tax";
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
  });
  const client = new Client({ name: "orbit-impact-test", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

  const res = await client.callTool({
    name: "analyze_change",
    arguments: { symbols: [symbol] },
  });
  const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  const parsed = JSON.parse(text);
  console.log("ROLLUP:", JSON.stringify(parsed.rollup));
  console.log("MARKDOWN OK:", typeof parsed.markdown === "string" && parsed.markdown.includes("Orbit Impact"));

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
