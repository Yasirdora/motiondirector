# Motion Director

**Direct motion in After Effects like a creative director.** Motion Director is an MCP server that lets an AI (Claude Code, Claude Desktop, or any MCP client) understand the motion in your comps: it measures every movement, explains in plain words why something feels cheap, heavy or floaty, tries changes on copies you can watch side by side at true speed, and applies only what you choose, in one undo step, restorable at any time.

> Status: early. Everything below is built and tested against a faithful fake of After Effects' scripting engine. It has **not yet been run against a real After Effects install**; see [HANDOFF.md](HANDOFF.md) for exactly what that means.

## What it does

- **Measures motion.** Every movement's timing, easing, overshoot, settling and how elements are choreographed together, taken from the curves as they actually play, including expressions.
- **Explains a feeling.** Say "this feels cheap" and it answers with what it measured: *"10 of 10 movements travel at constant speed, and 6 of 6 elements start on the same frame."* When your words could mean different changes, it asks one question.
- **Keeps a brief.** Your exact words, the agreed interpretation, what must not change and how you'll know it worked. Follow-ups carry every earlier decision forward.
- **Tries variants on copies.** Choreography only, feel only, both. Each is rehearsed on a copy of your comp, measured, and shown on a review page with the Motion Score and real-speed previews.
- **Applies safely.** Only the variant you choose, as one ⌘Z, confirmed by reading the comp back. It refuses rather than overwrite anything you edited meanwhile, and `restore` puts back exactly what was there.
- **Learns your motion style.** Point it at comps you like; it measures your easing, durations, stagger and overshoot, and checks new work against them.

## Install

Requirements: After Effects 2024 or later on macOS or Windows, Node.js 20+.

```bash
git clone https://github.com/Yasirdora/motiondirector.git
cd motiondirector
npm install && npm run build
claude mcp add motion-director -- node "$(pwd)/dist/src/index.js"
```

In After Effects, turn on **Settings → Scripting & Expressions → Allow Scripts to Write Files and Access Network**. On macOS, allow your terminal or MCP client to control After Effects when asked (System Settings → Privacy & Security → Automation). Nothing is installed inside After Effects.

Then open a comp and tell your AI: *"This logo reveal feels cheap."*

Options (environment variables): `MOTION_DIRECTOR_READONLY=1` refuses every change; `MOTION_DIRECTOR_PREVIEWS=0` skips preview rendering; `MOTION_DIRECTOR_AE` points at a non-standard After Effects install; `MOTION_DIRECTOR_HOME` moves the records folder (default `~/.motion-director`).

## Privacy

Motion Director calls no AI service and needs no API key. Your AI client sends what the tools return to its own provider: layer and comp names, timing values, your feedback, and rendered frames when the `look` tool is used. Briefs, change records and review pages stay on your machine.

## How it's built

TypeScript server; ExtendScript (ES3) inside After Effects; a per-request file mailbox launched through `osascript DoScript` (macOS) or `AfterFX -r` (Windows). Requests name operations and carry data, never code. Details, design decisions and what is left to do are in [HANDOFF.md](HANDOFF.md).

```bash
npm run check   # typecheck, 167 tests, build, stdio smoke test
```

MIT licensed.
