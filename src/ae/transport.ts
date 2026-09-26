import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLaunchPlan } from "./launcher.js";
import { AfterEffectsNotFound, locateAfterEffects } from "./locate.js";
import type { AeOutcome, AeRequest, AeResponse, FailureCode } from "./protocol.js";

export type SpawnFn = (command: string, args: string[]) => Pick<ChildProcess, "on" | "stderr" | "unref">;

export interface TransportOptions {
  mailbox?: string;
  dispatcherPath?: string;
  locate?: () => string;
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
  pollMs?: number;
  /** Relaunch the dispatcher if a request still sits unread after this long (After Effects refused a script). */
  relaunchAfterMs?: number;
  maxLaunches?: number;
  lockStaleMs?: number;
  lockRefreshMs?: number;
}

export interface CallOptions {
  mutates: boolean;
  label: string;
  timeoutMs?: number;
}

export function defaultMailbox(): string {
  return path.join(tmpdir(), "motion-director", "mailbox");
}

/** The package's jsx folder, whether running from src/ae (tests) or dist/src/ae (built). */
export function defaultDispatcher(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "..", "..", "jsx", "dispatcher.jsx"), path.resolve(here, "..", "..", "..", "jsx", "dispatcher.jsx")];
  return candidates.find((c) => existsSync(c)) ?? (candidates[0] as string);
}

/**
 * File-mailbox transport to a running After Effects.
 *
 * Every request is its own file, written atomically, and the dispatcher
 * deletes it as it reads it, so a request can never run twice and never be
 * overwritten by the next one (the failure that loses commands in bridges
 * built on one shared command file). Calls from this process are serialised;
 * a lock file serialises separate processes, because After Effects halts all
 * scripting behind a modal if two scripts arrive at once.
 *
 * Every call ends in "ok", "failed" (nothing changed) or "unknown" (After
 * Effects took the request but did not answer in time). An unknown outcome is
 * never retried here: retrying a change that may already have applied is how
 * a change gets applied twice.
 */
export class MailboxTransport {
  readonly mailbox: string;
  private readonly dispatcherPath: string;
  private readonly locate: () => string;
  private readonly spawn: SpawnFn;
  private readonly platform: NodeJS.Platform;
  private readonly pollMs: number;
  private readonly relaunchAfterMs: number;
  private readonly maxLaunches: number;
  private readonly lockStaleMs: number;
  private readonly lockRefreshMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private aePath: string | null = null;

  constructor(options: TransportOptions = {}) {
    this.mailbox = options.mailbox ?? defaultMailbox();
    this.dispatcherPath = options.dispatcherPath ?? defaultDispatcher();
    this.locate = options.locate ?? (() => locateAfterEffects());
    this.spawn = options.spawn ?? ((command, args) => nodeSpawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }));
    this.platform = options.platform ?? process.platform;
    this.pollMs = options.pollMs ?? 60;
    this.relaunchAfterMs = options.relaunchAfterMs ?? 2500;
    this.maxLaunches = options.maxLaunches ?? 3;
    this.lockStaleMs = options.lockStaleMs ?? 90_000;
    this.lockRefreshMs = options.lockRefreshMs ?? 15_000;
    // 0700: whoever can write here can make After Effects run our operations.
    mkdirSync(this.mailbox, { recursive: true, mode: 0o700 });
  }

  call<T>(op: string, args: unknown, options: CallOptions): Promise<AeOutcome<T>> {
    const run = this.queue.then(() => this.callOne<T>(op, args, options));
    this.queue = run.catch(() => undefined);
    return run.catch((err): AeOutcome<T> => {
      const message = `Motion Director could not talk to After Effects: ${err instanceof Error ? err.message : String(err)}`;
      const hint = "Check that the mailbox folder is writable, then try again.";
      // Where exactly it broke is unknown, so a change is not assumed to be undone.
      return options.mutates ? { status: "unknown", message, hint, durationMs: 0 } : failed("TRANSPORT", message, hint, 0);
    });
  }

  private async callOne<T>(op: string, args: unknown, options: CallOptions): Promise<AeOutcome<T>> {
    const started = Date.now();
    const deadline = started + (options.timeoutMs ?? 60_000);
    const elapsed = () => Date.now() - started;

    try {
      this.aePath ??= this.locate();
    } catch (err) {
      return failed("AE_NOT_FOUND", err instanceof AfterEffectsNotFound ? err.message : String(err), "Install After Effects 2024 or later, or set MOTION_DIRECTOR_AE.", elapsed());
    }

    const id = randomUUID();
    const request: AeRequest = { id, op, args, label: options.label, mutates: options.mutates };
    const requestPath = path.join(this.mailbox, `request-${id}.json`);
    const responsePath = path.join(this.mailbox, `response-${id}.json`);
    const tmp = path.join(this.mailbox, `.request-${id}.json.tmp`);
    await fs.writeFile(tmp, serialize(request), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, requestPath);

    if (!(await this.acquireLock(id, deadline))) {
      await unlink(requestPath);
      return failed("BUSY", "Another Motion Director session is using After Effects right now.", "Wait for it to finish, or close the other session.", elapsed());
    }

    let keepLock = false;
    try {
      const exit: { error: string | null; permission: boolean } = { error: null, permission: false };
      this.launch(exit);
      let launches = 1;
      let lastLaunch = Date.now();
      let lastRefresh = Date.now();

      while (Date.now() < deadline) {
        const response = await readResponse(responsePath);
        if (response) {
          await unlink(responsePath);
          return interpret<T>(response, id, options.mutates, elapsed());
        }
        if (exit.permission || exit.error) {
          if (await unlink(requestPath)) {
            return exit.permission
              ? failed("PERMISSION_DENIED", "macOS did not allow Motion Director to control After Effects.", "Open System Settings → Privacy & Security → Automation, and allow your MCP client (or Terminal) to control After Effects.", elapsed())
              : failed("TRANSPORT", `After Effects could not be reached: ${exit.error}`, "Check that After Effects is installed and can open.", elapsed());
          }
          // The request was taken before the launcher complained; keep waiting for its answer.
          exit.error = null;
        }
        const now = Date.now();
        if (now - lastRefresh >= this.lockRefreshMs) {
          lastRefresh = now;
          await this.refreshLock(id);
        }
        if (launches < this.maxLaunches && now - lastLaunch >= this.relaunchAfterMs * launches && (await exists(requestPath))) {
          launches++;
          lastLaunch = now;
          this.launch(exit);
        }
        await sleep(this.pollMs);
      }

      if (await unlink(requestPath)) {
        return failed(
          "NOT_PICKED_UP",
          "After Effects did not pick up the request, so nothing was changed.",
          "After Effects may be busy, starting up, or showing a dialog (a dialog blocks all scripts until it is closed). Also check After Effects › Settings › Scripting & Expressions › “Allow Scripts to Write Files and Access Network”.",
          elapsed(),
        );
      }
      // Taken but unanswered: the operation may still be running. Leave the
      // lock to expire on its own rather than let the next call collide with it.
      keepLock = true;
      return {
        status: "unknown",
        message: "After Effects took the request but did not answer in time. It may still be working, or it may have finished.",
        hint: options.mutates
          ? "Don't repeat the change. Read the comp again to see whether it applied."
          : "It is safe to ask again once After Effects is responsive.",
        durationMs: elapsed(),
      };
    } finally {
      if (!keepLock) await this.releaseLock(id);
    }
  }

  private launch(exit: { error: string | null; permission: boolean }): void {
    const plan = buildLaunchPlan(this.aePath as string, this.dispatcherPath, this.mailbox, this.platform);
    try {
      const child = this.spawn(plan.command, plan.args);
      child.unref?.();
      child.on("error", (err: Error) => {
        exit.error = err.message;
      });
      if (plan.diagnoseExit) {
        let stderr = "";
        child.stderr?.setEncoding?.("utf8");
        child.stderr?.on("data", (chunk: string) => {
          if (stderr.length < 4096) stderr += chunk;
        });
        child.on("exit", (code: number | null) => {
          if (code === null || code === 0) return;
          if (/-1743|not authori[sz]ed/i.test(stderr)) exit.permission = true;
          else exit.error = `the launcher exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
        });
      }
    } catch (err) {
      exit.error = err instanceof Error ? err.message : String(err);
    }
  }

  private get lockPath(): string {
    return path.join(this.mailbox, "busy.lock");
  }

  private async acquireLock(id: string, deadline: number): Promise<boolean> {
    for (;;) {
      try {
        const handle = await fs.open(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ id, pid: process.pid, at: new Date().toISOString() }));
        } finally {
          await handle.close();
        }
        return true;
      } catch {
        try {
          const stat = await fs.stat(this.lockPath);
          if (Date.now() - stat.mtimeMs > this.lockStaleMs) await unlink(this.lockPath);
        } catch {
          /* the lock vanished between open and stat */
        }
        if (Date.now() >= deadline) return false;
        await sleep(this.pollMs);
      }
    }
  }

  /** Only the owner may refresh or release a lock; a stalled owner's lock may have been taken over. */
  private async ownsLock(id: string): Promise<boolean> {
    try {
      return (JSON.parse(await fs.readFile(this.lockPath, "utf8")) as { id?: string }).id === id;
    } catch {
      return false;
    }
  }

  private async refreshLock(id: string): Promise<void> {
    if (!(await this.ownsLock(id))) return;
    const now = new Date();
    await fs.utimes(this.lockPath, now, now).catch(() => undefined);
  }

  private async releaseLock(id: string): Promise<void> {
    if (await this.ownsLock(id)) await unlink(this.lockPath);
  }
}

function interpret<T>(response: AeResponse, id: string, mutates: boolean, durationMs: number): AeOutcome<T> {
  if (response.id !== id) {
    return mutates
      ? { status: "unknown", message: "After Effects answered with a mismatched id.", hint: "Read the comp again before changing anything.", durationMs }
      : failed("BAD_RESPONSE", "After Effects answered with a mismatched id.", "Try again.", durationMs);
  }
  if (response.ok) return { status: "ok", value: response.result as T, durationMs, logs: response.logs ?? [] };
  // A change that threw partway and could not undo itself has left the
  // project in a state nobody chose. Only a read can say what that is.
  if (mutates && response.phase === "execute" && !response.rolledBack) {
    return {
      status: "unknown",
      message: `The change failed partway and could not undo itself: ${response.error ?? "unknown error"}`,
      hint: "Read the comp again to see what changed, and use ⌘Z in After Effects if needed.",
      durationMs,
    };
  }
  return {
    status: "failed",
    code: "OPERATION_FAILED",
    message: response.error ?? "The operation failed.",
    hint: response.rolledBack ? "Nothing was left half-done: the change undid itself." : "Nothing was changed.",
    durationMs,
    logs: response.logs ?? [],
  };
}

function failed<T>(code: FailureCode, message: string, hint: string, durationMs: number): AeOutcome<T> {
  return { status: "failed", code, message, hint, durationMs, logs: [] };
}

async function readResponse(file: string): Promise<AeResponse | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw ? (JSON.parse(raw) as AeResponse) : null;
  } catch {
    // Not there yet, or caught mid-rename: poll again.
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function unlink(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

/**
 * JSON for the ES3 reader on the other side. U+2028 and U+2029 are legal
 * inside JSON strings but end a line in ES3, cutting a string in half, so they
 * are escaped (kumo documents the same trap).
 */
export function serialize(value: unknown): string {
  return JSON.stringify(value).replace(LINE_SEPARATOR, "\\u2028").replace(PARAGRAPH_SEPARATOR, "\\u2029");
}
