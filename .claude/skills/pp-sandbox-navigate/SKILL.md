---
name: pp-sandbox-navigate
description: Use before editing any of the three Perpetual Pantries apps (Perpetual_Pantries_v1.html, pp-command-ronin.html, ppcanopy.html) or the pp-backend that links them. Helps pick the right app file, handles the zipped backend and the currently-unusable pp-fix.bundle correctly, and locates code inside the large single-file apps without reading them end to end.
---

# Working in the Perpetual Pantries sandbox

This repo holds three separate single-file HTML apps plus a backend that
links them (see `CLAUDE.md` for the full architecture: PP/Gavin, PP
Command/Ronin, PPcanopy/Canopy, and `pp-backend`). Follow this before
editing any of them.

## 1. Pick the right file for the task

Don't assume "the app" means `Perpetual_Pantries_v1.html` — check which of
the three the task actually concerns:

- Café-facing features (inventory, POS, orders, payroll, BAS) →
  `Perpetual_Pantries_v1.html` (Gavin)
- Org/multi-site console features (link codes, approving site requests,
  cross-site data) → `pp-command-ronin.html` (Ronin)
- PP's own internal ops (managing clients/orgs, billing, operator queue) →
  `ppcanopy.html` (Canopy)
- Cross-app API/data-flow changes → `pp-backend.zip` (see step 2)

If a request is ambiguous about which app it targets, ask rather than
guessing — they're independent files with independent state.

## 2. The backend is zipped — unzip before working on it

`pp-backend.zip` has no unpacked counterpart in the repo. To read or edit
it:

```bash
unzip -o pp-backend.zip -d /tmp/pp-backend-work   # or repo scratch dir — don't commit the unpacked tree
```

Read `pp-backend/README.md` first (endpoint table, run/test commands, what
the spec's steps 5–6 deliberately leave unimplemented) before changing
routes. When done, re-zip changes back into `pp-backend.zip` at the repo
root rather than committing an unpacked `pp-backend/` directory, unless
the user has said they want it unpacked in git going forward.

`npm test` runs an e2e suite against `DATABASE_URL` and **truncates
whatever database it points at** — never point it at anything but a
disposable scratch DB.

## 3. Don't touch `pp-fix.bundle` without checking first

`git bundle verify pp-fix.bundle` currently fails — its base commit isn't
in this repo's history, so it can't be applied or inspected via a normal
clone/fetch. If a task seems related to it (e.g. anything mentioning an
"audit" fix), stop and ask the user where the missing base commit might
live rather than guessing at the bundle's contents or ignoring it.

## 4. Finding code inside a given app file

Each HTML file is one document with inline `<style>` and a single big
`<script>` — reading it top to bottom wastes context.

- Search for the feature's UI text (button labels, headings) or a likely
  function/variable name with `grep -n` / `rg -n`.
- `<title>` strings and CSS custom property names (`--verdigris`, `--ink`,
  etc. in PPcanopy; different palette per app) are useful anchors.
- Jump to a function with `grep -n "functionName" <file>.html`, then
  `Read` with `offset`/`limit` around that line, plus a generous
  surrounding chunk for related helpers in the same `<script>` block.

## 5. Editing conventions

- Match each file's existing vanilla JS/DOM style — no bundler, no
  framework, no shared code between the three apps beyond what the
  backend API contract implies.
- No test suite for the HTML apps. Verify changes by opening the file in
  a browser; verify backend changes with `npm test` (see step 2's caveat)
  or by hitting endpoints manually.
- Don't assume this repo's `Perpetual_Pantries_v1.html` matches the one in
  the sibling `pp-refactored` repo — they've diverged (see CLAUDE.md). Ask
  before copying the file between the two repos.
