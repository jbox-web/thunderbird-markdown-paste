/*
 * Runs inside the compose editor document.
 *
 * Every change goes through document.execCommand, because it is the only path
 * recorded by the editor's transaction manager: Ctrl+Z, Ctrl+Y and the Edit
 * menu keep working, and one paste or one conversion is one undo step.
 * Range.insertNode and friends edit the DOM behind the editor's back.
 */
(() => {
  "use strict";

  const BLOCK_TAGS = new Set([
    "ADDRESS", "BLOCKQUOTE", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "OL", "P", "PRE", "TABLE", "TR", "UL",
  ]);

  function textOf(nodes) {
    let text = "";

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue.replace(/ /g, " ");
      } else if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      } else if (node.tagName === "BR") {
        text += "\n";
      } else if (BLOCK_TAGS.has(node.tagName)) {
        if (text && !text.endsWith("\n")) {
          text += "\n";
        }
        const children = [...node.childNodes];
        // The editor keeps a <br> at the end of a block so the line stays
        // visible; it is not a line of its own.
        if (children.at(-1)?.nodeName === "BR") {
          children.pop();
        }
        children.forEach(walk);
        text += "\n";
      } else {
        node.childNodes.forEach(walk);
      }
    }

    nodes.forEach(walk);
    return text.replace(/\n+$/, "");
  }

  // Plain means the user typed it and nothing formatted it: signatures, citation
  // headers and aligned text carry attributes, quotes and rendered Markdown their
  // own tags.
  function isPlain(node) {
    if (node.nodeType === Node.TEXT_NODE || node.nodeName === "BR") {
      return true;
    }
    if (node.nodeName !== "P" && node.nodeName !== "DIV") {
      return false;
    }
    // The editor marks what it touches with internal _moz_* attributes.
    if ([...node.attributes].some(({ name }) => name !== "id" && !name.startsWith("_moz"))) {
      return false;
    }
    return [...node.childNodes].every((c) => c.nodeType === Node.TEXT_NODE || c.nodeName === "BR");
  }

  function isBlank(node) {
    return textOf([node]).trim() === "";
  }

  // The run of plain top-level nodes around a node, so that converting at the
  // caret can never reach a quote, a signature or anything already formatted.
  function plainRunAround(node) {
    const body = node.ownerDocument.body;
    let top = node;
    while (top && top.parentNode !== body) {
      top = top.parentNode;
    }
    if (!top || !isPlain(top)) {
      return [];
    }
    const run = [top];
    while (run[0].previousSibling && isPlain(run[0].previousSibling)) {
      run.unshift(run[0].previousSibling);
    }
    while (run.at(-1).nextSibling && isPlain(run.at(-1).nextSibling)) {
      run.push(run.at(-1).nextSibling);
    }
    // Blank lines at the edges keep separating the text from what surrounds it.
    while (run.length && isBlank(run[0])) {
      run.shift();
    }
    while (run.length && isBlank(run.at(-1))) {
      run.pop();
    }
    return run;
  }

  // Outside Thunderbird (unit tests) only the pure helpers above are exposed.
  if (typeof messenger === "undefined") {
    globalThis.MarkdownPasteCompose = { textOf, plainRunAround };
    return;
  }

  // Unknown until the background answers: until then nothing is intercepted,
  // so the worst case is a native paste, never a broken plain-text message.
  let htmlEditor = false;
  let rawPasteRequested = false;

  messenger.runtime
    .sendMessage({ type: "get-compose-mode" })
    .then((mode) => {
      htmlEditor = mode?.isPlainText === false;
    })
    .catch(() => {});

  function insertHtml(html) {
    try {
      return document.execCommand("insertHTML", false, html);
    } catch {
      return false;
    }
  }

  function onPaste(event) {
    const raw = rawPasteRequested;
    rawPasteRequested = false;
    if (!htmlEditor || raw || !event.clipboardData) {
      return;
    }
    const data = event.clipboardData;
    try {
      const paste = {
        plain: data.getData("text/plain"),
        html: data.getData("text/html"),
        hasFiles: data.files.length > 0,
      };
      if (MarkdownPaste.shouldRenderPaste(paste) && insertHtml(MarkdownPaste.render(paste.plain))) {
        event.preventDefault();
      }
    } catch (error) {
      // Without preventDefault the native paste goes ahead: nothing is lost.
      console.error("Markdown Paste:", error);
    }
  }

  // Ctrl+Shift+V / Cmd+Shift+V keeps its meaning: paste without formatting. The
  // flag lives until the next key or paste, whatever order the keys are released.
  // event.code covers layouts where that key does not produce a Latin "v".
  function trackRawPaste(event) {
    rawPasteRequested =
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      (event.code === "KeyV" || event.key.toLowerCase() === "v");
  }

  function selectRun(selection, run) {
    const range = document.createRange();
    range.setStartBefore(run[0]);
    range.setEndAfter(run.at(-1));
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function caretNode(selection) {
    const { anchorNode, anchorOffset } = selection;
    if (anchorNode === document.body) {
      return document.body.childNodes[anchorOffset] ?? document.body.lastChild;
    }
    return anchorNode;
  }

  // The text to convert, or null when converting would destroy formatting.
  function selectedSource(selection) {
    if (!selection.isCollapsed) {
      const nodes = [...selection.getRangeAt(0).cloneContents().childNodes];
      return nodes.every(isPlain) ? textOf(nodes) : null;
    }
    const node = caretNode(selection);
    const run = node ? plainRunAround(node) : [];
    if (run.length === 0) {
      return null;
    }
    selectRun(selection, run);
    return textOf(run);
  }

  // Converts the selection, or else the plain text around the caret.
  function convert() {
    const selection = window.getSelection();
    if (!htmlEditor || !selection || selection.rangeCount === 0) {
      return;
    }
    try {
      const text = selectedSource(selection);
      if (text && text.length <= MarkdownPaste.MAX_MARKDOWN_LENGTH && !MarkdownPaste.rendersToNothing(text)) {
        insertHtml(MarkdownPaste.render(text));
      }
    } catch (error) {
      console.error("Markdown Paste:", error);
    }
  }

  document.addEventListener("keydown", trackRawPaste, true);
  window.addEventListener("blur", () => {
    rawPasteRequested = false;
  });
  document.addEventListener("paste", onPaste, true);

  messenger.runtime.onMessage.addListener((message) => {
    if (message?.type === "convert") {
      convert();
    }
  });
})();
