// Starts the built server over stdio, as an MCP client would, and checks that
// it lists its tools without After Effects being present.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/src/index.js"], stderr: "inherit" });
const client = new Client({ name: "smoke", version: "1" });
await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
await client.close();
if (names.length !== 13 || !names.includes("read_motion") || !client.getInstructions()) {
  console.error("smoke: unexpected tools", names);
  process.exit(1);
}
console.log(`smoke: ${names.length} tools listed: ${names.join(", ")}`);
