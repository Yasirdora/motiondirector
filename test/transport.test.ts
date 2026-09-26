import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLaunchPlan } from "../src/ae/launcher.js";
import { AfterEffectsNotFound, locateAfterEffects } from "../src/ae/locate.js";
import type { AeResponse } from "../src/ae/protocol.js";
import { MailboxTransport, serialize, type SpawnFn } from "../src/ae/transport.js";

type Behaviour = "answer" | "ignore" | "hang" | "permission" | "fail-rolled-back" | "fail-partway" | "refuse";

/**
 * Plays the part of After Effects: each launch picks up the oldest request
 * (consuming it, as the real dispatcher does) and behaves as told.
 */
function fakeAfterEffects(mailbox: string, behaviours: Behaviour[], delayMs = 20) {
  const launches: string[][] = [];
  const spawn: SpawnFn = (command, args) => {
    launches.push([command, ...args]);
    const behaviour = behaviours[Math.min(launches.length - 1, behaviours.length - 1)] as Behaviour;
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter & { setEncoding(): void }; unref(): void };
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.unref = () => {};
    setTimeout(() => {
      if (behaviour === "permission") {
        child.stderr.emit("data", "execution error: Not authorized to send Apple events to After Effects. (-1743)");
        child.emit("exit", 1);
        return;
      }
      if (behaviour === "ignore") return;
      const pending = readdirSync(mailbox).filter((n) => /^request-.*\.json$/.test(n)).sort();
      const name = pending[0];
      if (!name) return;
      const request = JSON.parse(readFileSync(path.join(mailbox, name), "utf8"));
      unlinkSync(path.join(mailbox, name));
      if (behaviour === "hang") return;
      const response: AeResponse = {
        id: request.id,
        ok: behaviour === "answer",
        phase: behaviour === "refuse" ? "dispatch" : "execute",
        result: behaviour === "answer" ? { op: request.op, args: request.args } : null,
        error: behaviour === "answer" ? null : "Something went wrong",
        ...(behaviour === "fail-rolled-back" ? { rolledBack: true } : {}),
        logs: [],
      };
      const tmp = path.join(mailbox, `.response-${request.id}.tmp`);
      writeFileSync(tmp, JSON.stringify(response));
      renameSync(tmp, path.join(mailbox, `response-${request.id}.json`));
      child.emit("exit", 0);
    }, delayMs);
    return child as unknown as ReturnType<SpawnFn>;
  };
  return { spawn, launches };
}

describe("MailboxTransport", () => {
  let mailbox: string;
  const make = (behaviours: Behaviour[], extra: Partial<ConstructorParameters<typeof MailboxTransport>[0]> = {}) => {
    mailbox = mkdtempSync(path.join(tmpdir(), "md-mailbox-"));
    const fake = fakeAfterEffects(mailbox, behaviours);
    const transport = new MailboxTransport({
      mailbox,
      dispatcherPath: "/pkg/jsx/dispatcher.jsx",
      locate: () => "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app",
      spawn: fake.spawn,
      platform: "darwin",
      pollMs: 5,
      relaunchAfterMs: 150,
      ...extra,
    });
    return { transport, launches: fake.launches };
  };
  afterEach(() => rmSync(mailbox, { recursive: true, force: true }));

  it("returns the operation's result", async () => {
    const { transport, launches } = make(["answer"]);
    const outcome = await transport.call("read_comp", { compId: 3 }, { mutates: false, label: "Read", timeoutMs: 2000 });
    expect(outcome).toMatchObject({ status: "ok", value: { op: "read_comp", args: { compId: 3 } } });
    expect(launches[0]![0]).toBe("/usr/bin/osascript");
    expect(readdirSync(mailbox).filter((n) => n !== "busy.lock")).toEqual([]);
    expect(existsSync(path.join(mailbox, "busy.lock"))).toBe(false);
  });

  it("says nothing changed when After Effects never picks the request up", async () => {
    const { transport } = make(["ignore"], { maxLaunches: 1 });
    const outcome = await transport.call("set_keys", {}, { mutates: true, label: "Apply", timeoutMs: 300 });
    expect(outcome).toMatchObject({ status: "failed", code: "NOT_PICKED_UP" });
    // The request is taken back, so it can never run later on its own.
    expect(readdirSync(mailbox).some((n) => n.startsWith("request-"))).toBe(false);
  });

  it("reports an unknown outcome, not a failure, when a change was picked up but never answered", async () => {
    const { transport } = make(["hang"]);
    const outcome = await transport.call("set_keys", {}, { mutates: true, label: "Apply", timeoutMs: 300 });
    expect(outcome.status).toBe("unknown");
    if (outcome.status === "unknown") expect(outcome.hint).toMatch(/Don't repeat the change/);
  });

  it("diagnoses a denied macOS Automation permission quickly", async () => {
    const { transport } = make(["permission"]);
    const started = Date.now();
    const outcome = await transport.call("ping", {}, { mutates: false, label: "Ping", timeoutMs: 5000 });
    expect(outcome).toMatchObject({ status: "failed", code: "PERMISSION_DENIED" });
    expect(Date.now() - started).toBeLessThan(1000);
    if (outcome.status === "failed") expect(outcome.hint).toMatch(/Privacy & Security → Automation/);
  });

  it("relaunches when After Effects refused the first script", async () => {
    const { transport, launches } = make(["ignore", "answer"]);
    const outcome = await transport.call("ping", {}, { mutates: false, label: "Ping", timeoutMs: 3000 });
    expect(outcome.status).toBe("ok");
    expect(launches.length).toBe(2);
  });

  it("treats a change that failed and undid itself as a clean failure", async () => {
    const { transport } = make(["fail-rolled-back"]);
    const outcome = await transport.call("set_keys", {}, { mutates: true, label: "Apply", timeoutMs: 2000 });
    expect(outcome).toMatchObject({ status: "failed", code: "OPERATION_FAILED" });
    if (outcome.status === "failed") expect(outcome.hint).toMatch(/undid itself/);
  });

  it("treats a change that failed partway without undoing itself as unknown", async () => {
    const { transport } = make(["fail-partway"]);
    const outcome = await transport.call("set_keys", {}, { mutates: true, label: "Apply", timeoutMs: 2000 });
    expect(outcome.status).toBe("unknown");
  });

  it("treats a refusal before running as a clean failure", async () => {
    const { transport } = make(["refuse"]);
    const outcome = await transport.call("set_keys", {}, { mutates: true, label: "Apply", timeoutMs: 2000 });
    expect(outcome).toMatchObject({ status: "failed", code: "OPERATION_FAILED" });
  });

  it("runs concurrent calls one at a time and never mixes up their answers", async () => {
    const { transport } = make(["answer"]);
    const [a, b, c] = await Promise.all(
      [1, 2, 3].map((n) => transport.call<{ args: { n: number } }>("echo", { n }, { mutates: false, label: "Echo", timeoutMs: 3000 })),
    );
    expect([a, b, c].map((o) => (o?.status === "ok" ? o.value.args.n : null))).toEqual([1, 2, 3]);
  });

  it("waits for another process's lock, then gives up without leaving its request behind", async () => {
    const { transport } = make(["answer"]);
    writeFileSync(path.join(mailbox, "busy.lock"), JSON.stringify({ id: "someone-else" }));
    const outcome = await transport.call("ping", {}, { mutates: false, label: "Ping", timeoutMs: 200 });
    expect(outcome).toMatchObject({ status: "failed", code: "BUSY" });
    expect(readdirSync(mailbox).some((n) => n.startsWith("request-"))).toBe(false);
  });

  it("breaks a stale lock left by a crashed process", async () => {
    const { transport } = make(["answer"], { lockStaleMs: 0 });
    writeFileSync(path.join(mailbox, "busy.lock"), JSON.stringify({ id: "crashed" }));
    await new Promise((r) => setTimeout(r, 5));
    const outcome = await transport.call("ping", {}, { mutates: false, label: "Ping", timeoutMs: 2000 });
    expect(outcome.status).toBe("ok");
  });

  it("reports a missing After Effects without touching the mailbox", async () => {
    const { transport } = make(["answer"], {
      locate: () => {
        throw new AfterEffectsNotFound("not installed");
      },
    });
    const outcome = await transport.call("ping", {}, { mutates: false, label: "Ping", timeoutMs: 500 });
    expect(outcome).toMatchObject({ status: "failed", code: "AE_NOT_FOUND" });
    expect(readdirSync(mailbox)).toEqual([]);
  });
});

describe("serialize", () => {
  it("escapes the two characters that end a line in ES3", () => {
    const text = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
    const out = serialize({ text });
    expect(out).toBe('{"text":"a\\u2028b\\u2029c"}');
    expect(JSON.parse(out).text).toBe(text);
  });
});

describe("buildLaunchPlan", () => {
  it("uses osascript DoScript on macOS, addressed to the app bundle", () => {
    const plan = buildLaunchPlan("/Applications/AE/AE.app/Contents/MacOS/AE", "/p/jsx/dispatcher.jsx", "/tmp/m'box", "darwin");
    expect(plan.command).toBe("/usr/bin/osascript");
    expect(plan.diagnoseExit).toBe(true);
    const script = plan.args.join("\n");
    expect(script).toContain('tell application "/Applications/AE/AE.app" to DoScript');
    expect(script).toContain("MOTION_DIRECTOR_MAILBOX = '/tmp/m\\\\'box'");
  });

  it("uses AfterFX -r on Windows", () => {
    expect(buildLaunchPlan("C:/AE/AfterFX.exe", "C:/p/dispatcher.jsx", "C:/t", "win32")).toEqual({
      command: "C:/AE/AfterFX.exe",
      args: ["-r", "C:/p/dispatcher.jsx"],
      diagnoseExit: false,
    });
  });
});

describe("locateAfterEffects", () => {
  it("finds the newest installed version", () => {
    const found = locateAfterEffects("darwin", {}, (p) => p.includes("2025"));
    expect(found).toBe("/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app");
  });

  it("honours an override and rejects a wrong one", () => {
    expect(locateAfterEffects("darwin", { MOTION_DIRECTOR_AE: "/x/AE.app" }, () => true)).toBe("/x/AE.app");
    expect(() => locateAfterEffects("darwin", { MOTION_DIRECTOR_AE: "/nope" }, () => false)).toThrow(/does not exist/);
  });

  it("explains that After Effects only runs on macOS and Windows", () => {
    expect(() => locateAfterEffects("linux", {}, () => false)).toThrow(/only runs on macOS and Windows/);
  });
});
