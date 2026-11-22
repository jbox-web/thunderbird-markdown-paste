# Markdown Paste for Thunderbird

[![CI](https://github.com/jbox-web/thunderbird-markdown-paste/actions/workflows/ci.yml/badge.svg)](https://github.com/jbox-web/thunderbird-markdown-paste/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/jbox-web/thunderbird-markdown-paste)](LICENSE)
[![Thunderbird 151+](https://img.shields.io/badge/Thunderbird-151%2B-0a84ff)](https://www.thunderbird.net/)

Paste Markdown into a message and get rich text. Written from scratch after
[thunderbird-markdown-paste-extension](https://github.com/andyesys/thunderbird-markdown-paste-extension),
whose behaviour it replaces rather than reuses. Requires Thunderbird 151 or later.

## Behaviour

- **Paste**: text that looks like Markdown is rendered. Rich content, images and
  ordinary text keep Thunderbird's native paste.
- **Undo**: one paste, one conversion or one toggle is one undo step, through
  the editor's own undo stack.
- **Paste raw**: Ctrl+Shift+V (Cmd+Shift+V on macOS) never renders.
- **Toggle** (toolbar button, Ctrl+Alt+M, Cmd+Alt+M on macOS), without a
  selection: switches the whole message between Markdown and rich text. If the
  message holds rendered Markdown, all of it goes back to its Markdown source;
  otherwise all its plain text is rendered. Rendered Markdown edited afterwards
  goes back to its source too, without the edit: undo brings the edit back.
- **Convert** (same button and shortcut) with a selection: renders just the
  selection.
- Quotes, signatures and formatted content are never converted: a selection
  containing any is left as it is, and the toggle goes around them.
- **Raw HTML** in the Markdown is shown as text, never interpreted.
- **Sent message**: styles are inline, so the recipient sees what you see, and no
  extension artefact is left in the message. While you write, rendered Markdown
  keeps its source in a hidden attribute so the toggle can bring it back; it is
  removed when the message is sent, but stays in saved drafts.
- **Plain-text messages** are left alone.
- **Remote images** written in Markdown keep their URL, like any image in a mail.

## Known limitation

The *Paste Without Formatting* **menu item** still renders Markdown: its paste
event is identical to a normal paste of plain text, so a script cannot tell them
apart. Use the keyboard shortcut, or undo.

## Development

```sh
npm install
npm test          # renderer and DOM logic, under jsdom
npm run e2e       # real headless Thunderbird on a throwaway profile
npm run build     # dist/markdown-paste-<version>.xpi
```

`npm run e2e` needs a local Thunderbird (`THUNDERBIRD_BIN` overrides its path)
and leaves the user's profile alone. Set `E2E_ADDON` to test a built XPI.

## License

MIT, see [LICENSE](LICENSE). Bundled libraries keep their own licences, see [VENDOR.md](VENDOR.md).
