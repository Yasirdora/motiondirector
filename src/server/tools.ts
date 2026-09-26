import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AfterEffects } from "../ae/client.js";
import { ApprovalError, currentRevision, type Approver } from "../director/brief.js";
import { TransitionError } from "../director/changes.js";
import { formatAnalysis, formatBrief, formatDeviations, formatHistory, formatInterpretation, formatStyle, formatVariants } from "./format.js";
import { INSTRUCTIONS } from "./instructions.js";
import { Studio, StudioError } from "./studio.js";

export const VERSION = "0.1.0";

const comp = z
  .union([z.number().int(), z.string().min(1)])
  .optional()
  .describe("The comp: its name (or part of it) or its id. Leave out to use the comp open in After Effects.");
const briefId = z.string().describe("The brief's id, from write_brief or history.");
const changeId = z.string().describe("The change's id, from try_variants or history.");
const list = (what: string) => z.array(z.string()).optional().describe(what);

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** Every refusal and failure reaches the agent as plain words plus the next step. */
async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof StudioError) return { content: [{ type: "text", text: [err.message, err.hint].filter(Boolean).join("\n") }], isError: true };
    if (err instanceof ApprovalError || err instanceof TransitionError) return { content: [{ type: "text", text: err.message }], isError: true };
    return { content: [{ type: "text", text: `Unexpected problem: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function createServer(studio: Studio, ae: AfterEffects): McpServer {
  const server = new McpServer({ name: "motion-director", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "check_setup",
    {
      title: "Check the After Effects connection",
      description: "Checks that After Effects is reachable and lists the project's comps. Every problem comes back with the one step that fixes it.",
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(async () => {
        const { info, comps } = await studio.checkSetup();
        return text(
          [
            `Connected to After Effects ${info.afterEffects}.`,
            `Project: ${info.project.name}${info.project.path ? "" : " (not saved yet; Motion Director keeps its records under this name until it is)"}.`,
            info.activeComp ? `Open comp: "${info.activeComp.name}".` : "No comp is open.",
            comps.length ? `Comps: ${comps.map((c) => `"${c.name}" (${c.duration.toFixed(2)} s, ${c.layers} layers)`).join(", ")}.` : "The project has no comps.",
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "read_motion",
    {
      title: "Read and measure a comp's motion",
      description:
        "Measures every movement in a comp (timing, easing, overshoot, settling) and how elements are choreographed, then lists the measured reasons it may read as careless. Read-only. Use it before discussing or changing motion, and again after anything changes.",
      inputSchema: {
        comp,
        start: z.number().min(0).optional().describe("Start of the range in seconds; defaults to the work area."),
        end: z.number().min(0).optional().describe("End of the range in seconds; defaults to the work area."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ comp: c, start, end }) =>
      guard(async () => text(formatAnalysis(await studio.analyse(c, { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) })))),
  );

  server.registerTool(
    "interpret_feedback",
    {
      title: "Interpret the designer's words",
      description:
        "Explains feedback like 'this feels cheap' or 'too heavy' using what is measured in the comp, and returns the one question worth asking when the feedback could mean materially different changes. Pass the designer's exact words.",
      inputSchema: { feedback: z.string().min(1).describe("The designer's words, verbatim."), comp },
      annotations: { readOnlyHint: true },
    },
    ({ feedback, comp: c }) => guard(async () => text(formatInterpretation(studio.interpret(feedback, await studio.analyse(c))))),
  );

  server.registerTool(
    "look",
    {
      title: "Look at frames",
      description:
        "Renders up to six frames of a comp as images, to check layout or content at specific moments. Still frames can't show timing or easing; use read_motion for that, and the review page previews for how it feels.",
      inputSchema: {
        comp,
        times: z.array(z.number().min(0)).min(1).max(6).describe("Times in seconds."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ comp: c, times }) =>
      guard(async () => {
        const { id, name } = await studio.resolveComp(c);
        const folder = path.join(tmpdir(), "motion-director", "look", `${Date.now()}`);
        try {
          const { frames, problems } = await ae.frames(id, times, folder, 3);
          const content: CallToolResult["content"] = [
            { type: "text", text: `"${name}" at ${times.map((t) => `${t.toFixed(2)} s`).join(", ")}. These are hints, not proof of how it moves.` },
          ];
          for (const f of frames) {
            const notes = [f.empty ? "nothing is visible" : "", f.identicalTo !== null ? `identical to ${f.identicalTo.toFixed(2)} s (a still moment, or an earlier render)` : ""].filter(Boolean);
            content.push({ type: "text", text: `${f.time.toFixed(2)} s${notes.length ? `: ${notes.join("; ")}` : ""}` });
            if (!f.empty) content.push({ type: "image", data: readFileSync(f.file).toString("base64"), mimeType: "image/png" });
          }
          if (problems.length) content.push({ type: "text", text: `Could not render: ${problems.join("; ")}` });
          return { content };
        } finally {
          rmSync(folder, { recursive: true, force: true });
        }
      }),
  );

  const briefFields = {
    interpretation: z.string().optional().describe("What you and the designer agreed the feedback means."),
    experience: z.string().optional().describe("The experience the viewer should have."),
    keep: list("What must not change."),
    acceptance: list("Observable criteria: how you'll both know it worked."),
    references: list("References the designer gave."),
    decisions: list("Decisions made along the way."),
    openQuestions: list("Open questions and assumptions."),
  };

  server.registerTool(
    "write_brief",
    {
      title: "Write the motion brief",
      description:
        "Starts a brief for a change: the designer's exact words, kept verbatim, plus the agreed interpretation, what must not change and how you'll know it worked. Show it to the designer before approving.",
      inputSchema: { comp, feedback: z.string().min(1).describe("The designer's words, verbatim."), ...briefFields },
    },
    ({ comp: c, feedback, ...content }) =>
      guard(async () => {
        const brief = await studio.createBrief({ ...(c !== undefined ? { comp: c } : {}), feedback, content });
        return text(formatBrief(brief, studio.briefMarkdown(brief)));
      }),
  );

  server.registerTool(
    "revise_brief",
    {
      title: "Revise the motion brief",
      description:
        "Adds a numbered revision. Everything not given carries forward, so follow-up feedback ('the selection is better, but hover is too strong') never needs the whole brief repeated. A revision needs its own approval.",
      inputSchema: {
        briefId,
        feedback: z.string().optional().describe("New words from the designer, verbatim, if any."),
        note: z.string().min(1).describe("What changed in this revision, in one line."),
        ...briefFields,
      },
    },
    ({ briefId: id, feedback, note, ...changes }) =>
      guard(async () => {
        const brief = await studio.reviseBrief(id, { ...(feedback ? { feedback } : {}), note, changes });
        return text(formatBrief(brief, studio.briefMarkdown(brief)));
      }),
  );

  server.registerTool(
    "approve_brief",
    {
      title: "Approve a brief revision",
      description:
        "Approves one exact revision of the brief. When the client supports it, the designer is asked to confirm directly; otherwise call this only after the designer has said yes, and the approval is recorded as given on their behalf.",
      inputSchema: {
        briefId,
        revision: z.number().int().min(1).describe("The revision number shown with the brief."),
        hash: z.string().describe("The hash shown with the brief, which ties the approval to its exact content."),
      },
    },
    ({ briefId: id, revision, hash }) =>
      guard(async () => {
        const brief = await studio.brief(id);
        const rev = currentRevision(brief);
        let by: Approver = "agent-on-behalf-of-designer";
        if (server.server.getClientCapabilities()?.elicitation) {
          const answer = await server.server.elicitInput({
            message: [
              `Approve this direction for "${brief.compName}" (revision ${rev.revision})?`,
              `You said: "${brief.feedback[brief.feedback.length - 1]?.text ?? ""}"`,
              `It means: ${rev.interpretation || "(not written yet)"}`,
              rev.keep.length ? `Must not change: ${rev.keep.join("; ")}` : "",
              rev.acceptance.length ? `It worked when: ${rev.acceptance.join("; ")}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            requestedSchema: {
              type: "object",
              properties: { approve: { type: "boolean", title: "Approve this revision", description: "Changes will be tried on copies and shown to you before anything is applied." } },
              required: ["approve"],
            },
          });
          if (answer.action !== "accept" || answer.content?.approve !== true) {
            return text("The designer did not approve this revision. Ask what should change and revise the brief.");
          }
          by = "designer";
        }
        const approved = await studio.approveBrief(id, revision, hash, by);
        return text(
          `Revision ${currentRevision(approved).revision} is approved${by === "designer" ? " by the designer" : " (recorded on the designer's behalf; their client can't ask them directly)"}. Next: try_variants.`,
        );
      }),
  );

  server.registerTool(
    "try_variants",
    {
      title: "Try variants on copies",
      description:
        "For an approved brief, builds up to three variants (for example choreography only, feel only, both), rehearses each on a copy of the comp, measures it, and writes a review page with real-speed previews side by side. The original comp is not changed.",
      inputSchema: {
        briefId,
        focus: z
          .array(z.enum(["choreography", "feel"]))
          .optional()
          .describe("Limit to one aspect when the designer chose one; the variants then differ in intensity."),
      },
    },
    ({ briefId: id, focus }) => guard(async () => text(formatVariants(await studio.tryVariants(id, focus ? { axes: focus } : {})))),
  );

  server.registerTool(
    "apply_variant",
    {
      title: "Apply the chosen variant",
      description:
        "Applies the variant the designer chose to the original comp, as one undo step, then reads the comp back to confirm. Refuses if the brief was revised since, or if anything it would change was edited since the variants were made.",
      inputSchema: { changeId },
      annotations: { destructiveHint: true },
    },
    ({ changeId: id }) =>
      guard(async () => {
        const { change, message } = await studio.apply(id);
        return change.status === "applied" ? text(`${message}\nTo undo later: restore_change with changeId ${change.id}.`) : { content: [{ type: "text", text: message }], isError: true };
      }),
  );

  server.registerTool(
    "restore_change",
    {
      title: "Restore the comp as it was before a change",
      description: "Puts back exactly the keys an applied change replaced, then confirms by reading the comp. Refuses rather than overwrite anything edited after the change.",
      inputSchema: { changeId },
      annotations: { destructiveHint: true },
    },
    ({ changeId: id }) => guard(async () => text((await studio.restore(id)).message)),
  );

  server.registerTool(
    "discard_rehearsals",
    {
      title: "Remove rehearsal copies",
      description: "Deletes the rehearsal copies made for a brief. Only comps Motion Director created and marked as rehearsals can be removed.",
      inputSchema: { briefId },
    },
    ({ briefId: id }) =>
      guard(async () => {
        const removed = await studio.discardRehearsals(id);
        return text(removed.length ? `Removed ${removed.length} rehearsal comp${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}.` : "There were no rehearsal copies to remove.");
      }),
  );

  server.registerTool(
    "history",
    {
      title: "What happened so far",
      description: "Lists this project's briefs and changes with their current state, including changes whose outcome is uncertain. Works after a restart.",
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => text(formatHistory(await studio.history()))),
  );

  server.registerTool(
    "motion_style",
    {
      title: "Learn or check a motion style",
      description:
        "learn: measures comps the designer likes and saves their motion language (easing, durations by role, stagger, overshoot). check: compares a comp against a saved style and explains each departure.",
      inputSchema: {
        action: z.enum(["learn", "check"]),
        name: z.string().min(1).describe("The style's name, e.g. the brand."),
        comps: z.array(z.union([z.number().int(), z.string()])).optional().describe("learn: comps to learn from; defaults to the open comp."),
        comp,
      },
    },
    ({ action, name, comps, comp: c }) =>
      guard(async () => {
        if (action === "learn") return text(formatStyle(await studio.learnStyle(name, comps ?? [])));
        const { style, deviations } = await studio.checkStyle(name, c);
        return text(formatDeviations(style, deviations));
      }),
  );

  return server;
}
