# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Thunderbird MailExtension (Manifest V3, Thunderbird 151+) that renders pasted Markdown as rich text. Plain JavaScript with no bundler or transpiler: the files in the repository are the files Thunderbird loads. No linter or formatter is configured.

## Commands

```sh
npm install
npm test                                                 # all unit tests, under jsdom
node --test test/render.test.js                          # one test file
node --test --test-name-pattern="detects block Markdown" test/render.test.js   # one test
npm run e2e                                              # all scenarios in a headless Thunderbird
npm run e2e -- "plain-text editor"                       # scenarios whose name contains the string
npm run build                                            # dist/markdown-paste-<version>.xpi
```

`npm run e2e` installs the working tree as a temporary add-on, so it needs no build. Environment variables:

- `THUNDERBIRD_BIN`: Thunderbird binary; the default is the macOS application path.
- `E2E_ADDON`: test a built XPI instead of the working tree.
- `MARIONETTE_PORT`: default 2929. The run refuses to start if the port is already in use, since that could be the user's own instance.
- `E2E_TMP`: parent directory of the throwaway profile; the default is the system temporary directory.

CI (`.github/workflows/ci.yml`) runs unit tests and the build on Ubuntu, e2e on macOS, and also runs weekly to catch Thunderbird changes without a commit.

## Architecture

Three contexts, connected by `runtime` messages:

- `background.js` receives the toolbar button and the shortcut, and sends `convert` to the tab. It also answers `get-compose-mode`, because compose scripts cannot reach the compose API.
- `src/compose.js` runs inside the compose editor document. It intercepts `paste` and handles `convert`.
- `src/render.js` turns Markdown into e-mail HTML and decides whether a text is Markdown. It is pure, never touches the compose document, and is exposed as `globalThis.MarkdownPaste`.

The compose scripts share one global scope: `vendor/*` (marked, DOMPurify, highlight.js), then `render.js`, then `compose.js`.

Paste and convert use different gates. A paste renders only through `shouldRenderPaste` (no files, no rich `text/html`, `looksLikeMarkdown`). Convert is an explicit request, so it skips the heuristic and checks only the length limit and `rendersToNothing`; its protection is `isPlain` / `plainRunAround`, which keep quotes, signatures and formatted content out of the conversion.

## Invariants

- Every edit of the message goes through `document.execCommand`. It is the only path recorded by the editor's undo stack; `Range.insertNode` and similar calls break undo.
- The rendered output carries inline styles only, with no `class` left on it. A stylesheet would not travel with the message.
- Raw HTML in the Markdown is displayed as text, never interpreted. The output of marked always goes through DOMPurify.
- On any failure in `onPaste`, do not call `preventDefault`: the native paste goes ahead and nothing is lost.
- `htmlEditor` stays `false` until the background answers, so an unknown mode never intercepts a paste.

## Keep in sync

- Script list and order: `compose_scripts` in `manifest.json` and `SCRIPTS` in `test/helpers.js`.
- Version: `manifest.json` (read by `scripts/build.sh`), `package.json` and `package-lock.json`.
- Add-on id: `manifest.json`, and `ACTION_ID` and the `AddonManager` calls in `scripts/e2e.js`.
- Packaged files: the explicit list in `scripts/build.sh`; a new top-level runtime file is not packaged until it is added there.
- Vendored libraries: `vendor/` holds unmodified npm tarball files; updating one means updating its version and SHA-256 in `VENDOR.md`.

## Testing

- Unit tests have no editor. Undo, clipboard and real key handling can only be proven in `scripts/e2e.js`, which drives real `cmd_paste` / `cmd_undo` over Marionette.
- `compose.js` exposes `textOf` and `plainRunAround` as `globalThis.MarkdownPasteCompose` and returns early when `messenger` is undefined. Only helpers defined above that check are unit-testable.
- E2E scenarios are entries of the `scenarios` object in `scripts/e2e.js`; the rendering and detection cases belong in `test/render.test.js`.

## Known limitation

The *Paste Without Formatting* menu item still renders Markdown: its paste event is identical to a normal plain-text paste. Only the keyboard shortcut is detected (`trackRawPaste`).
