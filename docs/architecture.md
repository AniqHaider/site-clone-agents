# Architecture

One section at a time goes through the same four stages. Each stage is a separate Claude Code subagent with one job and one output file, so a failed stage can be re-run without redoing the others, and each agent keeps a small, clean context.

```
ONCE PER PAGE
  Input (URL or Figma frames)
    -> Phase 0  discover   scroll, find sections, capture 4 breakpoints
    -> pick sections       one, several, or all

FOR EACH SECTION, STRICTLY IN ORDER
  Phase 1  harvest         tokens, assets, hover and scroll behaviour, screenshots
    -> (optional) compress the handoff JSON
  Phase 2  build UI        React + Tailwind component in the target project
    -> verify build         pass: next section.  fail: retry, up to 3 times

AFTER THE RUN
  Hill-climb               mine notes and failures into docs/learnings.md
                           (every agent reads it at the start of the next run)
```

## Design decisions

| Decision | Choice | Why |
|---|---|---|
| Orchestration | The main Claude session, no orchestrator agent | Saves context, and a human can step in between phases |
| Context passing | Files in a session directory | Keeps each agent's context small |
| Parallelism | None. Sections run one at a time | Keeps agents focused and builds deterministic |
| Retry limit | 3 | Balances cost against persistence |
| Figma input | Replaces only phases 0 and 1 | They emit the same files, so Phase 2 is reused untouched |
| Learning | `docs/learnings.md` | Notes from every run become rules for the next |

## Session directory

```
~/nextjs-clone-sessions/{date}-{name}/
  config.json              source (url | figma), target URL or frame links, projectRoot
  sections.json            ordered section list with selectors and boundaries   (Phase 0)
  dom-blueprint.json       DOM tree and positions per section at 4 breakpoints  (Phase 0)
  {Section}/
    harvest.json           tokens, interactions, assets, snippet                 (Phase 1)
    *.png                  screenshots at 360 / 768 / 1024 / 1440                (Phase 1)
  generated-files.json     files written, buildPassed, buildErrors, retryNumber,
                           pixelVerified, notes                                  (Phase 2)
```

`config.json` example:

```json
{
  "source": "url",
  "url": "https://example.com",
  "name": "example",
  "projectRoot": "/path/to/nextjs-project",
  "createdAt": "2026-01-01T12:00:00Z"
}
```

For Figma input, replace `url` with `figmaDesktopUrl` and `figmaMobileUrl` (either may be `null`).

## Hill-climb step

After the last section, the orchestrator reads every `generated-files.json`, keeps the signals that repeat (any `retryNumber > 0`, repeated `buildErrors` text, `pixelVerified: false`, and especially the free-text `notes`), skips anything already in `docs/learnings.md`, and appends short imperative rules with a detection and a fix. A clean first-try run still produces rules, because `notes` records workarounds and gotchas.
