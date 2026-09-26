import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server/tools.js";
import { fakeStudio } from "./helpers/studio.js";

type Answer = "approve" | "decline" | null;

async function connect(root: string, elicitation: Answer = null) {
  const { studio, client: ae, comp, ae: fake } = fakeStudio(root);
  const server = createServer(studio, ae);
  const client = new Client({ name: "test", version: "1" }, { capabilities: elicitation ? { elicitation: {} } : {} });
  const asked: string[] = [];
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return elicitation === "approve" ? { action: "accept", content: { approve: true } } : { action: "decline" };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const body = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    return { body, isError: result.isError === true, result };
  };
  return { client, call, asked, comp, fake };
}

describe("MCP server", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "md-server-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("offers intent-named tools and instructions for working with a designer", async () => {
    const { client } = await connect(root);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["apply_variant", "approve_brief", "check_setup", "discard_rehearsals", "history", "interpret_feedback", "look", "motion_style", "read_motion", "restore_change", "revise_brief", "try_variants", "write_brief"].sort(),
    );
    expect(tools.find((t) => t.name === "read_motion")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "apply_variant")?.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toMatch(/ask exactly that one question/);
  });

  it("runs the whole loop from 'feels cheap' to a restored comp", async () => {
    const { call, comp } = await connect(root);
    expect((await call("check_setup")).body).toMatch(/Open comp: "Title Card \(careless, keyed\)"/);

    const read = await call("read_motion");
    expect(read.body).toMatch(/6 of 6 elements start together/);
    expect(read.body).toMatch(/\[major\] 10 of 10 movements travel at constant speed/);

    const meaning = await call("interpret_feedback", { feedback: "This logo reveal feels cheap." });
    expect(meaning.body).toMatch(/Ask the designer: Should I work on/);

    const written = await call("write_brief", {
      feedback: "This logo reveal feels cheap.",
      interpretation: "Stagger the elements and ease them in; keep it quick.",
      keep: ["Total length under 1.5 s"],
      acceptance: ["No element moves at constant speed"],
    });
    expect(written.body).toContain("> This logo reveal feels cheap.");
    const [, briefId, revision, hash] = /briefId (\S+), revision (\d+), hash (\w+)/.exec(written.body)!;

    const early = await call("try_variants", { briefId });
    expect(early.isError).toBe(true);
    expect(early.body).toMatch(/not approved yet/);

    const approved = await call("approve_brief", { briefId, revision: Number(revision), hash });
    expect(approved.body).toMatch(/recorded on the designer's behalf/);

    const variants = await call("try_variants", { briefId });
    expect(variants.body).toMatch(/Ready for design review/);
    expect(variants.body).toMatch(/Review page \(open it and watch the previews\): .*index\.html/);
    expect(variants.body).toMatch(/The original comp is unchanged/);
    const both = /Variant C · Both[\s\S]*?changeId (\S+) \(rehearsed\)/.exec(variants.body)![1]!;

    const applied = await call("apply_variant", { changeId: both });
    expect(applied.isError).toBe(false);
    expect(applied.body).toMatch(/verified/);
    expect(comp.layers[1]!.prop("ADBE Opacity").keys[0]!.time).toBeGreaterThan(0);

    const history = await call("history");
    expect(history.body).toMatch(/Both \(variant C, rev 1\): applied/);

    const restored = await call("restore_change", { changeId: both });
    expect(restored.body).toMatch(/^Restored/);
    expect(comp.layers[1]!.prop("ADBE Opacity").keys[0]!.time).toBe(0);
  });

  it("asks the designer directly when the client can, and respects a no", async () => {
    const yes = await connect(root, "approve");
    const brief = await yes.call("write_brief", { feedback: "Feels cheap", interpretation: "Ease and stagger." });
    const [, id, rev, hash] = /briefId (\S+), revision (\d+), hash (\w+)/.exec(brief.body)!;
    const approved = await yes.call("approve_brief", { briefId: id, revision: Number(rev), hash });
    expect(yes.asked[0]).toMatch(/You said: "Feels cheap"/);
    expect(approved.body).toMatch(/approved by the designer/);

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(path.join(tmpdir(), "md-server-"));
    const no = await connect(root, "decline");
    const brief2 = await no.call("write_brief", { feedback: "Feels cheap" });
    const [, id2, rev2, hash2] = /briefId (\S+), revision (\d+), hash (\w+)/.exec(brief2.body)!;
    const declined = await no.call("approve_brief", { briefId: id2, revision: Number(rev2), hash: hash2 });
    expect(declined.body).toMatch(/did not approve/);
    expect((await no.call("try_variants", { briefId: id2 })).body).toMatch(/not approved yet/);
  });

  it("turns failures into plain words with a next step", async () => {
    const { call } = await connect(root);
    const missing = await call("read_motion", { comp: "Nope" });
    expect(missing.isError).toBe(true);
    expect(missing.body).toMatch(/There is no comp called "Nope"\.\nComps in this project: /);
    const unknown = await call("apply_variant", { changeId: "does-not-exist" });
    expect(unknown.body).toMatch(/no change does-not-exist/);
  });

  it("looks at frames as hints and never sends an empty one as an image", async () => {
    const { call } = await connect(root);
    const look = await call("look", { times: [0, 0.4] });
    expect(look.body).toMatch(/These are hints, not proof of how it moves/);
    expect(look.result.content.filter((c) => c.type === "image")).toHaveLength(2);
  });
});
