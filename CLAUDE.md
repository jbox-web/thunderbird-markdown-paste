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

CI (`.github/workflows/ci.yml`) runs unit tests and the build on Ubuntu, e2e on Linux and macOS, and also runs weekly to catch Thunderbird changes without a commit.

## Architecture

Three contexts, connected by `runtime` messages:

- `background.js` receives the toolbar button and the shortcut, and sends `convert` to the tab. It also answers `get-compose-mode`, because compose scripts cannot reach the compose API, and strips rendered blocks' Markdown source in `compose.onBeforeSend`. The returned details also rewrite the compose window, so the body is kept until `compose.onAfterSend` and put back when the send failed (Thunderbird 160 signals a refused connection by a null `headerMessageId`, without `error`).
- `src/compose.js` runs inside the compose editor document. It intercepts `paste` and handles `convert`: with a selection it renders the selection, without one it toggles the whole draft.
- `src/render.js` turns Markdown into e-mail HTML and decides whether a text is Markdown. It is pure, never touches the compose document, and is exposed as `globalThis.MarkdownPaste`.

The compose scripts share one global scope: `vendor/*` (marked, DOMPurify, highlight.js), then `render.js`, then `compose.js`.

Paste and convert use different gates. A paste renders only through `shouldRenderPaste` (no files, no rich `text/html`, `looksLikeMarkdown`). Convert is an explicit request, so it skips the heuristic and checks only the length limit and `rendersToNothing`; its protection is `isPlain` / `plainRuns`, which keep quotes, signatures and formatted content out of the conversion.

Everything the extension renders goes through `renderTagged`: a `div` (blocks) or `span` (inline fragment) carrying the Markdown in `data-markdown-source`. The toggle restores every such element through `restoreHtml` if the body holds one outside quotes and signatures (`restorable`), and otherwise renders every plain run through `renderRunsHtml`, always as a block (`renderTagged(text, true)`). Rendered elements are not plain, so they are never rendered twice. Pieces of one element split or copied by the editor share a source: only the first brings it back. In br mode (`defaultParagraphSeparator` is `br`), block sources come back as br-separated lines instead of paragraphs.

## Invariants

- Every edit of the message goes through `document.execCommand`. It is the only path recorded by the editor's undo stack; `Range.insertNode` and similar calls break undo.
- The rendered output carries inline styles only, with no `class` left on it. A stylesheet would not travel with the message.
- Raw HTML in the Markdown is displayed as text, never interpreted. The output of marked always goes through DOMPurify.
- On any failure in `onPaste`, do not call `preventDefault`: the native paste goes ahead and nothing is lost.
- A toggle is one `insertHTML` over the stretch from the first to the last top-level node it touches, so it stays one undo step; nodes between runs are written back as they were.
- `data-markdown-source` and its wrapper never reach the recipient: `onBeforeSend` unwraps them. Saved drafts keep them.
- `htmlEditor` stays `false` until the background answers, so an unknown mode never intercepts a paste.

## Keep in sync

- Script list and order: `compose_scripts` in `manifest.json` and `SCRIPTS` in `test/helpers.js`.
- Version: `manifest.json` (read by `scripts/build.sh`), `package.json` and `package-lock.json`.
- Add-on id: `manifest.json`, and `ACTION_ID` and the `AddonManager` calls in `scripts/e2e.js`.
- Source attribute name: `SOURCE_ATTRIBUTE` in `src/render.js` and in `background.js`, which does not load the renderer.
- Packaged files: the explicit list in `scripts/build.sh`; a new top-level runtime file is not packaged until it is added there.
- Vendored libraries: `vendor/` holds unmodified npm tarball files; updating one means updating its version and SHA-256 in `VENDOR.md`.

## Testing

- Unit tests have no editor. Undo, clipboard and real key handling can only be proven in `scripts/e2e.js`, which drives real `cmd_paste` / `cmd_undo` over Marionette.
- `compose.js` exposes `textOf`, `plainRuns`, `sourceHtml`, `restoreHtml` and `renderRunsHtml` as `globalThis.MarkdownPasteCompose` and returns early when `messenger` is undefined. Only helpers defined above that check are unit-testable; `test/compose.test.js` loads the renderer scripts first, as the manifest does.
- `test/background.test.js` runs `background.js` against a `messenger` stub that records its listeners.
- The e2e bench sends messages for real to a local SMTP sink (`smtpSink`), so `sentHtml` reads what `onBeforeSend` let through, not the editor's serialisation.
- E2E scenarios are entries of the `scenarios` object in `scripts/e2e.js`; the rendering and detection cases belong in `test/render.test.js`.

## Known limitation

The *Paste Without Formatting* menu item still renders Markdown: its paste event is identical to a normal plain-text paste. Only the keyboard shortcut is detected (`trackRawPaste`).
