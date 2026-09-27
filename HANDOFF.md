# Handoff: Motion Director

This document is for the next engineer or AI who continues this project. Read all of it before changing anything. It says what exists, why it is shaped this way, what is proven and what is not, what to do next in order, and the rules that keep the project trustworthy.

---

## 1. The mission

Every other After Effects MCP (ten open-source ones, plus Higgsfield's closed one) lets an AI **operate** After Effects: make a layer, set a key, take a screenshot. None lets it **understand motion**. Motion Director's bet: give the designer and the AI a shared, measurable language for motion, so that "this feels cheap" becomes a measured diagnosis, a set of variants to watch side by side, and a safe, reversible change.

The bar to raise, and hold:
- **Understanding over operating.** Every decision should be grounded in measured curves, not in an AI squinting at still frames.
- **Taste stays human.** Measurements explain why something may feel a certain way. The designer decides what is right. Never present a measurement as a verdict on quality.
- **Trust is the product.** Nothing is applied that the designer did not choose; nothing the designer made is ever overwritten or lost; every outcome is reported honestly ("ok", "failed, nothing changed", or "unknown, go and look").
- **Designer language.** Tools, messages and pages speak about what the viewer feels, not about keyframe internals.

## 2. Where things stand

Repository: `github.com/Yasirdora/motiondirector`, work on branch `claude/nifty-feynman-yzxurv` (the repository had no default branch before; rename to `main` if the owner wants).

- **167 tests pass** (`npm run check` runs typecheck with no unused code, tests, build and a stdio smoke test). CI runs the same on Node 20 and 22.
- **Everything is tested against a fake After Effects**, not a real one. The fake (`test/helpers/fake-ae.ts`) runs the real `.jsx` files in a V8 context with ES5+ built-ins deleted, and models the scripting DOM (comps, layers, groups, keys, eases, tangents, files) including After Effects' ease-arity rule. It cannot prove After Effects behaves as modelled. **Nothing has been run inside a real After Effects yet.** That is the first job (section 6).

## 3. Architecture

```
MCP client (Claude Code, Desktop, Cursor, …)
   │ stdio
   ▼
src/index.ts ─► src/server/tools.ts      13 intent-named tools, errors as plain words + next step
                src/server/instructions.ts how the agent should work with a designer
                src/server/format.ts      tool output: meaning first, numbers second, ids last
                src/server/studio.ts      THE LOOP: read → critique → interpret → brief → approve
                                          → rehearse variants on copies → review → apply (verified)
                                          → restore; durable records; read-only mode
   ├─ src/lens/        Motion Score: curves → movements → layer events → choreography
   │    types.ts         data model (CompReading, Movement, LayerEvent, MotionScore)
   │    movements.ts     segmentation, ease shape, overshoot, oscillation+decay, anticipation, settle, tail
   │    choreography.ts  events, start/end clusters, stagger, duration variation, concurrency
   │    score.ts         buildScore + fingerprint (keys+expressions+timing hash)
   │    evaluate.ts      After Effects' bezier interpolation, to PREDICT an edit's result
   ├─ src/critic/      12 detectors (detectors.ts), critique(), Feel Lexicon (lexicon.ts: ~75 words)
   ├─ src/director/    brief.ts (verbatim feedback, numbered revisions, hash-bound approval)
   │                   recipes.ts (re-ease, stagger, retime, follow-through, soften-overshoot → exact key edits)
   │                   variants.ts (A/B/C from a critique), predict.ts, changes.ts (states, drift),
   │                   store.ts (atomic JSON under ~/.motion-director), style.ts (motion language)
   ├─ src/review/      data.ts (ReviewData, completion states), page.ts (self-contained HTML)
   ├─ assets/          review.css, review.js (inlined into each review page)
   └─ src/ae/          transport.ts (mailbox), launcher.ts, locate.ts, protocol.ts,
                       client.ts (typed ops, verified frames), png.ts, preview.ts
jsx/ (runs inside After Effects, ES3, ASCII only)
   dispatcher.jsx  takes the oldest request, deletes it as it reads, runs MD_OPS[op], undo group + dialog suppression
   json.jsx        eval-free JSON parser/stringifier
   ops.jsx         ping, list_comps, read_comp, duplicate_comp, delete_rehearsal, set_keys (drift check + rollback), save_frame
```

## 4. Invariants. Do not break these.

1. **The mailbox carries operation names and JSON, never code.** There is no `eval`/`new Function` of request data anywhere (a test enforces it). If you ever need raw script, make it a separate, off-by-default, clearly warned path, as kumo does.
2. **One request per file, consumed on read, atomic writes.** Never go back to a shared command file (Dakkshin's design loses commands).
3. **Three outcomes only: ok / failed (nothing changed) / unknown.** A timeout after After Effects picked a request up is *unknown*. **Never retry an unknown change**; read the comp and settle it (`Studio.settle`). A change that failed partway without rolling back is unknown.
4. **One tool call = one script = one undo group.** Undo groups do not survive across script calls (Engine Room measured this).
5. **Address layers by id and properties by matchName.** Never by index or display name.
6. **Rehearse on a marked copy first; the original changes only on `apply`.** Only comps carrying the rehearsal mark may be deleted.
7. **Approval is bound to one exact brief revision (number + content hash).** A new revision, even an identical one, needs a new approval. A change made for revision N can never be applied under revision N+1.
8. **Drift detection both ways.** Apply refuses if keys changed since planning; restore refuses if keys changed since applying. Nothing the designer made is overwritten.
9. **Never blind-undo.** Restore writes back the exact `before` keys recorded in the plan.
10. **Completion states:** any failed check → "Checks failed"; any required check not done → "Checks incomplete"; only then "Ready for design review". Never "verified" because nothing failed.
11. **Still frames are hints, curves are evidence, previews are for human eyes, and previews play at true speed** (playback fps = samples ÷ duration).
12. **Predictions are labelled predictions.** Only readings from After Effects count as measured.
13. **JSX stays ES3 and ASCII.** No `let/const`, arrows, ES5 array methods, `JSON`, trailing commas or reserved words (`final`, `class`, …). Libraries attach to `$.global` explicitly because `$.evalFile` evaluates into the caller's scope. Tests check ES3 syntax and ASCII.
14. **Honesty in text.** Say "I expect", "predicted", "not checked" when true. No claim of quality from a build or a measurement.

## 5. What we learned from the ten existing MCPs

Full study with file and line references: [docs/study.md](docs/study.md) (37 findings, 7 flaws the authors had not documented), summarised here. directorhomaidm-ops has no license: never copy code from it.

- **Engine Room** (`Engine-Room-Games/after-effects-mcp`): the best engineering. Read its `docs/fragile-areas-*.md` before touching the bridge, frames, text, shapes or mogrt. Measured traps: async `saveFrameToPng` and stale frames, 16-bit PNGs, undo groups, `$.evalFile` scope, text justification drift, expression errors only in `expressionError`, loopback is not a security boundary.
- **kumo** (`kumoproductions/mcp-aftereffects`): the no-panel transport we adopted (DoScript/`-r`, per-id mailbox, busy lock, dialog suppression). Its flaws we avoided: timeouts after pickup marked retryable; partial application on throw; blind `project.undo`.
- **solomon**: motion review via MP4 and contact sheet, but its preview plays at a fixed 12 fps, misrepresenting timing (we fixed this with true-speed playback).
- **Dakkshin** (most popular, weakest): tools return "queued" before running, one shared command file, 2 s polling against a 5 s timeout, index addressing.
- **LobzyJay**: motion-design taste (12 principles, "defaults to avoid"); our Critic's detector list started from it.
- **Higgsfield**: polished, cloud-relayed, generation-first; not reproducible or reviewable per a practitioner's notes. Motion Director is local, measured and reversible.

## 6. Next steps, in order

### Step 1: prove it on a real After Effects (Mac first)
Run these by hand and record results in `docs/verification.md` (create it). Fix what fails; keep the fake in sync with what you learn.

1. `check_setup` with After Effects 2024/2025/2026 open. Measure DoScript round-trip time (target under 300 ms; if much slower, consider a CEP panel with a per-session token as Engine Room does).
2. First-run macOS Automation prompt; deny it once and confirm the PERMISSION_DENIED message appears within seconds.
3. `read_comp` on a real comp with: separated position dimensions, shape layers, text animators, effects, expressions (one broken), parented layers, a 3D layer, a 60 s comp (check the sample budget and `truncated`). Compare `valueAtTime` samples with what After Effects shows.
4. `Layer.id` exists on 2024–2026 (Engine Room relies on it for 2026; confirm 2024).
5. `set_keys` round trip: read keys → write the same keys back → read again → identical (eases, tangents, roving, hold, continuous/auto-bezier). This is the most important test: restore depends on it. Check the ease-arity rule on Position, Scale, Opacity, separated X/Y, and Color.
6. `set_keys` with `expect` refusing after a manual edit; rollback after a forced failure. Confirm one ⌘Z undoes one Motion Director step.
7. `duplicate_comp` layer order and ids; rehearsal folder; `delete_rehearsal` refuses the designer's comps.
8. `save_frame`: sizes at resolution factors 1–4, restore of the viewer resolution (Engine Room's C5 race), 16-bit project, transparent frame, stale-frame behaviour on a heavy comp.
9. A modal dialog open while a call arrives: expect NOT_PICKED_UP, and no stuck state afterwards.
10. Non-English After Effects (matchNames must hold).
11. Windows: `AfterFX -r` with the shared temp mailbox.
12. End to end in Claude Code: "This logo reveal feels cheap" → question → brief → approve (does the client support elicitation?) → try_variants → open the review page → apply → "the overshoot is too strong" → revise → try again → restore.

### Step 2: make it delightful for designers
- **One-click install**: a `.mcpb` bundle for Claude Desktop, npm publish (`npx motion-director`), a designer-first README with a 2-minute demo video.
- **Review page as the home screen**: a "Pick this one" button per variant that the agent can see (MCP Apps / UI resources if the client supports them; otherwise instruct the agent to ask). Side-by-side synced players already exist ("Play all together").
- **Better previews**: optional MP4 via ffmpeg when installed, always at true speed; show onion-skin or motion-trail overlays drawn from the measured positions.
- **Messages**: every refusal already has a next step; keep that standard for everything new.

### Step 3: raise the bar of motion design
These are where Motion Director can set a new standard. Each must stay measurable, reversible and honest.
- **Richer Critic**: arcs vs straight paths on large moves; secondary action and overlap (child moves lagging parent); spacing charts; rhythm against music beats (audio markers); hierarchy (does the most important element move first and longest?); consistency of the same element type across comps; accessibility (motion intensity, flashing, large parallax: offer a reduced-motion variant).
- **More recipes**: arcs on position paths, overlap/offset of property channels (scale lagging position), secondary follow-through on children, anticipation, spring presets expressed as real keys (not expressions), exits that mirror entrances, rhythm snapping to beats.
- **Feel Lexicon grounded in evidence**: record which variant the designer picks for which words; over time, learn per-designer meanings ("when *you* say snappy you choose ~180 ms ease-outs"). Keep it local and inspectable.
- **Motion language as a living system**: tokens (durations, eases, staggers) exported for developers (CSS, SwiftUI, Lottie), checked in every comp, versioned with the brand.
- **Choreography composer**: from a brief ("lead with the logo, then the headline, then the details"), propose an order and timing map before touching keys, shown as a Motion Score the designer can drag.
- **Before/after truth**: every change reports what measurably changed, what stayed within "must not change", and what only the designer can judge.

### Step 4: optional integrations
- Generative tools (Higgsfield, Runway) are a different lane: if integrated, keep them opt-in, show credit cost before each call, and treat their output as footage the Director then choreographs.

## 7. How to work on this codebase

- Run `npm run check` before every commit. Add a failing test first for any bug; prove new tests fail without the fix (we did this for the ease preset: the "no variant introduces a new tell" test failed with the old expo curve).
- When you change anything in `jsx/`, test it in the fake **and** on a real After Effects, and update the fake to match reality.
- Visual changes to the review page: render the sample (`scratch` script pattern: build, generate a page from `test/helpers/scenes.ts`, screenshot with Playwright at 1200 px and 390 px, light and dark) and look at it. Colours follow a validated palette: one motion hue, grey for de-emphasis, status colours only on icons, text always in ink tokens (muted grey is too low-contrast for small text).
- Keep tools few and named for intent. Add capability inside the Studio and recipes, not as new low-level tools.
- **Commits**: small, stable, one logical change each, message explaining *why*. The owner's rule: commit as **Yasirdora** (`143439570+Yasirdora@users.noreply.github.com`), with **no AI co-author trailers**. Never rewrite published history. Do not backdate commits.

## 8. Known limitations (be honest about these in any demo)

- Not yet run on real After Effects (section 6).
- Recipes change keyframes only; expression-driven motion is measured and reported but left alone. Follow-through skips curved motion paths.
- Spatial easing in the evaluator treats paths between keys as straight lines (predictions on curved paths are approximate; rehearsal measures the real thing).
- The Critic's thresholds are informed defaults, tuned on synthetic curves; calibrate them on real designer work and record why each changes.
- Previews are PNG flipbooks rendered with `saveFrameToPng`; heavy comps will be slow. Frames identical across times are flagged, not resolved (a still moment and a stale render look the same).
- Approval without MCP elicitation is recorded as given on the designer's behalf; the review page says so.
