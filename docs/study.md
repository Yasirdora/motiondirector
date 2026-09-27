# Motion Director — Blueprint

*From ten After Effects MCPs, what they got wrong, and what to build instead.*

---

## Part 1 · The idea

Every After Effects MCP today, open-source or Higgsfield's, does the same thing: **it lets an AI operate After Effects.** Make a layer, set a keyframe, take a screenshot. The AI works like a fast intern with no eye for motion. It judges its work by looking at still frames, which cannot show timing.

**Motion Director lets an AI understand motion, and gives the designer and the AI a shared, measurable language for it.**

When a designer says *"this feels cheap"*, today's tools guess. Motion Director **reads the motion**: every curve, every start time, every ease. Then it answers with evidence:

> "It feels cheap mainly for two reasons I can measure: all six elements start on the same frame, and four of them use linear easing. Should I fix the **choreography** (stagger them so the eye has a path) or the **feel** (snappier ease-outs), or both?"

Then it **shows** three variants side by side at real speed, the designer picks one, and the choice becomes part of the project's **motion language** so the next change already knows it.

### Five pillars

| Pillar | What the designer experiences | What's new |
|---|---|---|
| **1. Motion Score** | A beautiful timeline "score" of the comp: one lane per layer, a bar for each movement coloured by its easing, a speed curve inside each bar, stagger rhythm visible at a glance | Nobody visualizes motion structure. Others show stills |
| **2. Motion Critic** | Plain-language diagnosis with numbers: "4 of 6 layers ease linearly", "everything lands on frame 48", "no follow-through on the logo" | Deterministic detectors on measured curves, not an AI squinting at screenshots |
| **3. Feel Lexicon** | Designer words (*cheap, heavy, floaty, snappy, robotic, busy, premium, abrupt*) mapped to measurable causes in **this** comp | Grounds the clarifying question in evidence |
| **4. Variants at real speed** | A/B/C built on copies, previewed **at true playback speed**, side by side with their scores; pick one | Others preview at the wrong speed or not at all (see finding S1) |
| **5. Motion Language** | "Our brand eases like this, primary moves take 400 ms, stagger 60 ms, overshoot under 8%", **learned by measuring comps the designer likes**, then checked on every change | Engine Room's house style reads colours/fonts; nobody measures motion style |

And underneath, **safe by construction**: rehearse every change on a copy, apply to the original only when accepted, verify the result, and keep a version before every change.

---

## Part 2 · What we learned, line by line

Code cloned September 2026. Findings marked **[new]** are flaws we found that the authors don't document. Unmarked findings are lessons the authors themselves measured and wrote down. File paths are relative to each repository.

### A. Talking to After Effects

| # | Finding | Where | Lesson for us |
|---|---|---|---|
| A1 **[new]** | Seven tools write the command and immediately answer "has been queued… use get-results after a few seconds." The AI is told nothing about the outcome, and a second call before the panel's next poll **overwrites the first command, which is lost silently**. | Dakkshin `src/index.ts:456–468` (×7) | A tool call returns the real outcome or an honest "unknown", never "queued". |
| A2 **[new]** | The panel polls every **2 s** (`checkInterval = 2000`) while the server waits **5 s** by default. A command that lands just after a poll has about 3 s left to execute before the server reports a timeout, even though it may still apply. | Dakkshin `src/scripts/mcp-bridge-auto.jsx:1317`, `src/index.ts:78` | Never let the wait be shorter than a realistic pick-up plus execution. Better still, don't poll at all. |
| A3 | "Result arrived" is detected by the result file's **size changing**. Two results of the same length are indistinguishable. | Dakkshin `src/index.ts` (`waitForBridgeResult`) | Correlate every result by request ID. |
| A4 | Per-request mailbox (`request-<id>.json` / `response-<id>.json`), atomic tmp+rename writes, and **consume-on-read** so a late dispatcher run can't execute a request twice. | kumo `src/transport/FileIpcTransport.ts:150–170`, `jsx/dispatcher.jsx` header | Adopt. This is the right shape. |
| A5 | No panel: `osascript … DoScript` on macOS, `AfterFX -r` on Windows. The osascript exit code reveals a denied Automation permission (-1743) in seconds instead of a timeout. | kumo `src/transport/launcher.ts:57–77` | Adopt for zero-install setup. Measure latency first (Phase 0). |
| A6 | A cross-process busy lock (`open("wx")`), because AE shows a **modal "second script" warning that halts all scripting** if two scripts arrive at once. | kumo `FileIpcTransport.ts:327–389` | Adopt. |
| A7 **[new]** | On timeout, kumo knows whether AE had **already picked up** the request ("the operation may still be running") but returns error code `TIMEOUT`, which is marked **retryable**. An agent that retries a mutation can apply it twice (two layers, doubled keyframes). | kumo `src/errors.ts:46`, `FileIpcTransport.ts:251–258` | Add a distinct **`OUTCOME_UNKNOWN`** state that is never auto-retried. Check the project state first, then decide. |
| A8 | Any exception escaping a script raises a **modal error dialog that blocks every later script**. Even `"failed: " + e` throws in ExtendScript, because an Error can't be coerced to a string. | kumo `jsx/dispatcher.jsx` ("Talking about exceptions safely") | A top-level guard around everything, and one safe error formatter. |
| A9 | U+2028/U+2029 inside a JSON string are line terminators to ES3 and cut the request in half. | kumo `FileIpcTransport.ts:536–540` | Escape them. |
| A10 | Busy AE and dead AE look identical; the remedies are opposite. Engine Room separates *unreachable*, *busy timeout*, *queued behind another write* and *auth refused*. | Engine Room `docs/fragile-areas-bridge.md` §"four bridge failures" | Every failure message says which one it is and the one next step. |

### B. Changing the project safely

| # | Finding | Where | Lesson for us |
|---|---|---|---|
| B1 | An undo group **does not survive between two script calls**. It must open and close within one. | Engine Room `packages/jsx/core.jsx:90–98`, `docs/fragile-areas-ae.md` | One tool call = one script = one undo step. |
| B2 **[new]** | When a script throws halfway, both kumo and Engine Room close the undo group and report failure. **The half that already ran stays applied.** The agent is told "failed" while the project has changed. | kumo `jsx/dispatcher.jsx:409–424`, Engine Room `core.jsx:93–97` | **Rehearse on a copy** (throwaway duplicate comp): a failure deletes the copy, and the original is untouched by construction. |
| B3 **[new]** | kumo's `project.undo` presses Undo *N* times blindly. If the designer did anything in AE in between, **it undoes the designer's own work**. | kumo `src/operations/project.ts:138` | Never blind-undo. Restore from a version, or verify via a state fingerprint that the top of the stack is ours. |
| B4 | `app.executeCommand()` silently does nothing through a CEP panel, but kumo relies on it through DoScript. | Engine Room `fragile-areas-ae.md`; kumo `project.ts:138` | Transport changes what works. Test menu commands on our transport in Phase 0 and don't assume either way. |
| B5 | A few operations (e.g. `copyToComp` on parented layers) are refused while an undo group is open. | Engine Room `core.jsx:100–112` | Know the exceptions and split them into their own step. |
| B6 | Dialogs suppressed for the call and restored after (`endSuppressDialogs(false)` so they aren't replayed as a modal). | kumo `dispatcher.jsx:370–430` | Adopt. |
| B7 | Layers addressed by 1-based **index**, which shifts when layers are reordered. The next call edits the wrong layer. | Dakkshin `src/index.ts:439`; a-y-ibrahim `ENHANCEMENTS.md` "Honest remaining limitations" | Address everything by stable ID. |
| B8 | Setting an expression "succeeds" even when it's broken; the real error is only in `expressionError`. | Engine Room `fragile-areas-ae.md` | Always read back and report. |

### C. Seeing the result

| # | Finding | Where | Lesson for us |
|---|---|---|---|
| C1 | `saveFrameToPng` is asynchronous; "the file stopped growing" ≠ finished. Only a complete PNG (valid chunks ending in IEND) counts. | Engine Room `packages/ae-panel/client/framereader.js` | Adopt the structural check. |
| C2 | AE sometimes returns a **stale frame from an earlier render and reports success**. Engine Room detects it by content hash, but admits the first stale frame of a session always gets through and a genuinely static comp triggers false alarms. | Engine Room `client/framecache.js`, `fragile-areas-bridge.md:49` | Treat still frames as *hints*. Use measured curves as the primary evidence and real renders for previews. |
| C3 | 16-bit projects produce 16-bit PNGs many decoders reject; fully transparent frames confuse models. | Engine Room `fragile-areas-bridge.md:50` | Convert to 8-bit; report "empty frame" in words. |
| C4 | Screenshots rendered at the comp's current viewer resolution: a comp parked at Quarter returned a *larger* image for downsample 2 than for 1. Engine Room now sets and restores `resolutionFactor`. | Engine Room `packages/jsx/vision.jsx:47–79` | Name the resolution you rendered at. |
| C5 **[new, suspected]** | `saveFrameToPng` is async, but `resolutionFactor` is restored in the `finally` right after the call returns. If the render reads the factor late, it may render at the restored resolution. Engine Room's IHDR check would catch a size mismatch, so this is a risk, not an observed bug. | Engine Room `vision.jsx:68–79` | Verify dimensions on every frame. |
| C6 | Screenshot cost control: auto-downsample to about 1280 px long edge; contact-sheet tiles shrink by 1/√N so a sheet costs about one frame. | Engine Room `vision.jsx:16–45` | Adopt. |

### D. Judging motion

| # | Finding | Where | Lesson for us |
|---|---|---|---|
| D1 **[new]** | `ae_review_motion`, described as "the only way to judge whether timing and easing feel right", samples 16 frames across the range and encodes them at a **fixed 12 fps**, whatever the range's length. A 2-second animation plays back in 1.33 s (1.5× too fast); a 4-second one in 1.33 s (3× too fast). **The preview misrepresents the timing it exists to judge.** | solomon `mcp/ae-mcp.js:785–825` | Previews must play at true speed: render at the comp's frame rate, or encode samples at samples ÷ duration. |
| D2 | Every project judges motion by an AI looking at still images or a contact sheet. Stills cannot show easing, speed or rhythm. | all | Measure motion numerically; show video only to the human. |
| D3 | A practitioner's catalogue of "tells" of cheap motion (linear easing, everything moves at once, equal durations, no follow-through, symmetric bounce, default wiggle, opacity-only entrances, 2-second defaults). Almost all are **measurable from keyframe data**. | LobzyJay `skills/motion-design/references/defaults-to-avoid.md` | This becomes the Motion Critic's first detector set. |

### E. Security and trust

| # | Finding | Where | Lesson for us |
|---|---|---|---|
| E1 | "Loopback is not a security boundary": any web page can POST to `127.0.0.1`, and `/op` is an eval inside AE, so an open bridge is arbitrary code execution offered to every website. CORS doesn't help (simple requests skip preflight). Fixed with a per-session token file (mode 0600) and Origin checks. | Engine Room `fragile-areas-bridge.md` §"The bridge token" (their issue #106) | With the no-panel transport there is no port at all. The mailbox directory (0700) is the trust boundary, as kumo documents. |
| E2 | `eval("(" + text + ")")` fallback to parse command files: code execution from a file anyone can write. | Dakkshin `mcp-bridge-auto.jsx:1244, 1731`; Engine Room `core.jsx` JSON polyfill (only if `JSON` is missing) | Never eval data. |
| E3 | Raw script execution off by default; read-only mode; category allowlist; a clear warning about what's sent to the AI service. | kumo README, `src/policy.ts` | Adopt all four. |
| E4 | Higgsfield's bridge routes project control through their cloud; a practitioner's skill file advises not using it for motion builds ("not reproducible, idempotent, or reviewable"). | LobzyJay `skills/aftereffects-motion/references/higgsfield-bridge.md` | Local only, reproducible changes. |

### F. Experience

| # | Finding | Where | Lesson for us |
|---|---|---|---|
| F1 | Best install experience: `.mcpb` one-click for Claude Desktop, signed standalone binaries, "Set up After Effects" as a sentence. | Engine Room README | Match it, with no panel if possible. |
| F2 | Best failure experience: a symptom → cause → fix table, and a `check_setup` that names the broken part. | Engine Room README "When something goes wrong" | Adopt, in designer language. |
| F3 | Guidance written once and generated into MCP instructions, prompts, resources and skills, so it works in every client, not just Claude. | Engine Room `docs/guidance-system.md` | Adopt. |
| F4 | 70–76 fine-grained tools (Engine Room, ishu86) vs 2 generic ones (kumo `ae_catalog` + `ae_do`). The first overwhelms; the second hides everything from people. | — | ~12 **intent** tools for designers, with a precise engine underneath. |
| F5 | Honest "Things it is not good at" lists (solomon, a-y-ibrahim). | READMEs | Adopt. Honesty is a feature. |
| F6 | ishu86's install instructions point to `github.com/anthropics/ae-mcp`, which is not its own repository. | ishu86 README | Details are trust. |

---

## Part 3 · The design

### How it works

```
Designer ⇄ Claude (or any MCP client)
                │
        Motion Director (TypeScript, Node, local)
        ├── Lens      read curves → Motion Score (the model)
        ├── Critic    detectors → diagnosis with evidence
        ├── Lexicon   designer words → measurable causes
        ├── Director  brief, variants, decisions, motion language
        ├── Stage     rehearse on copies → apply → verify → versions
        ├── Review    local page: real-speed previews side by side + scores
        └── Transport per-request mailbox + DoScript (no panel)
                │
          After Effects (unchanged, nothing installed)
```

### The Motion Score: our core data model

One read call samples every animated property of every layer **at the comp's frame rate**, plus keyframe metadata (interpolation, ease influence and speed, expressions). From that we compute:

- **Movements:** each continuous change in a property. Start, end, duration, distance, peak speed, and **ease shape** (linear / ease-in / ease-out / ease-in-out / overshoot / bounce / hold), classified from the speed curve, not from keyframe labels.
- **Settling:** overshoot %, number of oscillations, settle time.
- **Choreography:** start-time clusters (what moves together), stagger intervals and their regularity, order of entrance, which element leads.
- **Hierarchy:** relative duration and amplitude by element.

Everything the Critic, the Lexicon, the Review page and the Motion Language checker do runs on this model. **It is pure data and fully testable without After Effects**, so we can build and test it here, in the cloud, before touching a Mac.

### Motion Critic: first detectors

| Detector | Measured as | Designer words it explains |
|---|---|---|
| Linear easing | Speed curve flat across the movement | cheap, robotic, mechanical |
| Everything at once | ≥70% of movements start within 2 frames | busy, cheap, flat |
| Equal durations | Duration spread under 10% | flat, no hierarchy |
| No follow-through | Big movements stop with zero overshoot and maximum deceleration at the end | stiff, abrupt, cheap |
| Symmetric bounce | Repeated oscillation without amplitude decay | fake, toy-like |
| Default wiggle | `wiggle(` expression with high frequency/amplitude and no relation to other motion | jittery, amateur |
| Opacity-only entrance | Entrance with an opacity change and no position/scale change | flat, PowerPoint |
| Sluggish settle | Long low-speed tail (e.g. over 40% of duration below 10% of peak speed) | heavy, floaty, slow |
| Abrupt start | Peak acceleration at frame 1 of a large move, no anticipation | jarring, abrupt |

Each finding carries evidence (layer, property, frames, numbers) and a confidence. A detector that couldn't run says so (e.g. "expression-driven property sampled but not interpreted").

### The tools (about 12, named for intent)

| Tool | Does |
|---|---|
| `check_setup` | Checks AE version, the scripting preference and macOS Automation permission; one-sentence fixes |
| `read_motion` | Builds the Motion Score for a comp (or a time range) |
| `critique` | Runs the Critic; optionally focused by the designer's words ("cheap") via the Lexicon |
| `look` | One frame or a contact sheet, as a *hint* (with the stale-frame and 16-bit safeguards) |
| `preview` | Real-speed video of a range, rendered in the background, for the designer |
| `brief` | Creates/revises the motion brief: exact words, interpretation, what must not change, acceptance criteria, numbered revisions |
| `try_variants` | Builds A/B/C on copies from a small recipe set (retime, re-ease, stagger, add follow-through, …) |
| `review` | Opens the review page: previews side by side at real speed, scores, what was checked |
| `apply` | Applies the chosen variant to the original (one undo), then **verifies the result matches the rehearsal** by comparing Motion Scores |
| `versions` | Lists or restores saved versions of the project |
| `motion_language` | Learns the style from comps the designer likes (measured), shows it, checks a comp against it |
| `advanced` | Precise engine operations and (off by default) raw script, for the agent's edge cases |

### Trust rules

1. Every call returns a real outcome: **done**, **failed (nothing changed)**, or **outcome unknown (checking…)**. Never "queued".
2. Changes are rehearsed on copies. The original changes only on `apply`, in one undo step, and is verified afterwards.
3. A version of the `.aep` is saved before every apply. Restore never overwrites work done since without asking.
4. Never blind-undo.
5. Evidence names the project state it measured. After any change it's stale until re-read.
6. Still frames are hints; measured curves are evidence; previews are for human eyes.
7. Measurements aren't taste. The Critic explains *why something may feel* a certain way; the designer decides.
8. Local only. Raw script off by default. The README says exactly what reaches the AI service.

---

## Part 4 · The plan

| Phase | Where | What | Done when |
|---|---|---|---|
| **1. Lens + Critic engine** | **This cloud session** (no AE needed) | Motion Score model, curve classification, detectors, lexicon, brief/versions stores, review-page generator, transport protocol with a fake AE; tested on synthetic and recorded curves | Tests cover every detector with failing and passing cases; a sample review page renders |
| **2. Phase 0 spikes** | Your Mac | DoScript latency; `saveFrameToPng` behaviour; background preview render speed; sampling 60 frames × all properties in one call; `executeCommand` under DoScript; layer ID availability | Numbers recorded; transport decision confirmed |
| **3. AE adapter** | Your Mac | The ExtendScript side: read curves, copy/rehearse, apply, versions, preview | The end-to-end loop runs on a real project |
| **4. Direction loop** | Both | Variants, review page, motion language | The demo scenario works end to end |
| **5. Ship** | Your Mac | `.mcpb` one-click, npm, designer README, 2-minute demo video | A designer installs it and gets a first critique in under 5 minutes |

### The demo (what the video shows)

1. *"This logo reveal feels cheap."*
2. The Motion Score appears: six lanes, all starting on frame 0, four grey (linear) bars.
3. *"Mainly two measurable reasons: … choreography, feel, or both?"* → *"Both, but keep it quick."*
4. Three variants at real speed, side by side. The designer picks B.
5. *"The overshoot is too much."* → rev 2 carries everything forward → refined → applied, verified, one ⌘Z.
6. *"Save this as our motion style."* The next comp gets checked against it automatically.
