/**
 * The contract between the Node server and the ExtendScript dispatcher.
 *
 * A request names an operation from the dispatcher's own library and carries
 * JSON arguments. It never carries code: unlike bridges that `eval` whatever
 * arrives, there is no path by which the mailbox can run arbitrary script.
 */
export interface AeRequest {
  id: string;
  op: string;
  args: unknown;
  /** Undo group label shown in After Effects' Edit menu. */
  label: string;
  /** Whether the operation changes the project (grouped as one undo step, dialogs suppressed). */
  mutates: boolean;
}

export interface AeResponse {
  id: string;
  ok: boolean;
  /** "dispatch": failed before the operation ran, so nothing changed. "execute": the operation threw. */
  phase: "dispatch" | "execute";
  result: unknown;
  error: string | null;
  /** Set by operations that roll themselves back on failure. */
  rolledBack?: boolean;
  logs: string[];
}

/**
 * Why a call failed. Each one has a different next step, and messages say which.
 * All of these guarantee the operation did not change the project.
 */
export type FailureCode =
  | "AE_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "NOT_PICKED_UP"
  | "BUSY"
  | "OPERATION_FAILED"
  | "BAD_RESPONSE"
  | "TRANSPORT";

/**
 * Every call ends in exactly one of three outcomes. There is no "queued":
 * a call returns what happened, or says honestly that it cannot know yet.
 */
export type AeOutcome<T = unknown> =
  | { status: "ok"; value: T; durationMs: number; logs: string[] }
  | { status: "failed"; code: FailureCode; message: string; hint: string; durationMs: number; logs: string[] }
  | { status: "unknown"; message: string; hint: string; durationMs: number };
