#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AfterEffects } from "./ae/client.js";
import { MailboxTransport } from "./ae/transport.js";
import { Studio } from "./server/studio.js";
import { createServer } from "./server/tools.js";

/**
 * Motion Director over stdio. Nothing talks to After Effects until a tool is
 * called, so the server starts (and lists its tools) even when After Effects
 * is closed or not installed; the first call then says what to fix.
 */
async function main(): Promise<void> {
  const ae = new AfterEffects(new MailboxTransport());
  const studio = new Studio(ae, {
    readOnly: process.env.MOTION_DIRECTOR_READONLY === "1",
    previews: process.env.MOTION_DIRECTOR_PREVIEWS !== "0",
  });
  const server = createServer(studio, ae);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`motion-director: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
