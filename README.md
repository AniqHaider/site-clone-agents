# site-clone-agents

A multi-agent pipeline, built from [Claude Code](https://claude.com/claude-code) subagents, that turns a live URL or a Figma frame into reviewed, build-verified Next.js components, one section at a time.

This is a generic, framework-neutral version of a pipeline I built for storefront work. It has no company, merchant or house-framework specifics: the UI agent follows whatever conventions the target project already has.

Write-up: [A multi-agent pipeline that clones live sites into production components](https://aniq-haider.vercel.app/blog/agent-cloning-pipeline)

## How it flows

```
ONCE PER PAGE
  Input (URL or Figma frames)
    -> Phase 0  discover   scroll, find sections, capture 4 breakpoints
    -> pick sections       one, several, or all

FOR EACH SECTION, STRICTLY IN ORDER
  Phase 1  harvest         tokens, assets, hover and scroll behaviour, screenshots
  Phase 2  build UI        React + Tailwind component in the target project
    -> verify build         pass: next section.  fail: retry, up to 3 times

AFTER THE RUN
  Hill-climb               mine notes and failures into docs/learnings.md
```

Why separate agents: each phase has one job and one output file, so a failed phase re-runs without redoing the others. The main session orchestrates, so there is no nested orchestrator eating context, and a human can step in between phases. Details in [docs/architecture.md](docs/architecture.md).

## What is here

| Path | What |
|---|---|
| `agents/phase-0-discover.md` | Visits a URL, scrolls to trigger lazy loading, finds sections, captures positions at 360/768/1024/1440 |
| `agents/phase-0-figma-discover.md` | Same output, read from Figma frames through the Figma MCP |
| `agents/phase-1-harvest.md` | Design tokens, CSS hover/focus rules, SVGs, assets, interactions, screenshots |
| `agents/phase-1-figma-harvest.md` | Same output from Figma (variables, design context, renders) |
| `agents/phase-2-ui.md` | Builds one section as a React + Tailwind component and verifies the build |
| `scripts/harvest-extract.mjs` | The deterministic Playwright extraction Phase 1 runs |
| `docs/clone-patterns.md` | Practical UI-cloning patterns the build agent reads first |

The Figma agents emit the same files as the URL agents, so Phase 2 is reused untouched for both inputs.

## Use it

1. Copy the files in `agents/` into `~/.claude/agents/` (or a project's `.claude/agents/`).
2. Copy `scripts/` and `docs/` somewhere the agents can read, and run `bun install` (or `npm install`) in `scripts/`, then `npx playwright install chromium`.
3. In Claude Code, create a session directory with a `config.json` (see [docs/architecture.md](docs/architecture.md)) and ask the main session to run the phases in order, one section at a time. The agents are written to be spawned by an orchestrating session, with the session directory in the prompt.
4. After the run, have the orchestrator distill each section's `notes` into `docs/learnings.md`. Every agent reads it at the start of the next run. That file is git-ignored here because it is specific to your own runs.

The Playwright MCP (for interactive hover and click captures) and, for Figma input, the official Figma MCP need to be connected. Tool names depend on how you connected them; the agents resolve them at run time.

## Status

These agent prompts are used as written in my own workflow. Phase 2 here is a deliberately small generic rewrite, so expect to tune it to your project's conventions. It has not been run against many different codebases.

## License

MIT
