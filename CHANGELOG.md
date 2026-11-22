# Changelog

All notable changes to this add-on. Each version's section is the text of its
GitHub release; `npm run release:bump -- X.Y.Z` dates the Unreleased section.

## [Unreleased]

## [2.1.0] - 2026-11-22

### Changed

- The toolbar button and Ctrl+Alt+M (Cmd+Alt+M on macOS), without a selection,
  now toggle the whole message between Markdown and rich text: rendered
  Markdown goes back to its source, or else all plain text is rendered. One
  toggle is one undo step. Quotes, signatures and formatted content are left
  alone. With a selection, the button still renders just the selection.
- Rendered Markdown edited afterwards goes back to its original source; undo
  brings the edit back.

### Added

- Rendered Markdown keeps its source in a hidden attribute while you write, so
  the toggle can bring it back. It is removed when the message is sent, and put
  back in the window if sending fails. Saved drafts keep it.

## [2.0.2] - 2026-11-04

- Text that looks like Markdown is rendered on paste; rich content, images and
  ordinary text keep the native paste.
- One paste or one conversion is one undo step.
- Ctrl+Shift+V (Cmd+Shift+V on macOS) pastes raw.
- The toolbar button or Ctrl+Alt+M (Cmd+Alt+M on macOS) converts the selection
  or the plain text around the caret, and never touches quotes, signatures or
  formatted content.
- Styles are inline, so the recipient sees what you see.
- Known limitation: the *Paste Without Formatting* menu item still renders
  Markdown, because its paste event cannot be told apart from a normal paste of
  plain text. Use the keyboard shortcut instead.
