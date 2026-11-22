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

  // Every run of plain top-level nodes in the draft, so that toggling can never
  // reach a quote, a signature or anything already formatted.
  function plainRuns(body) {
    const runs = [];
    let run = [];
    const close = () => {
      // Blank lines at the edges keep separating the text from what surrounds it.
      while (run.length && isBlank(run[0])) {
        run.shift();
      }
      while (run.length && isBlank(run.at(-1))) {
        run.pop();
      }
      if (run.length) {
        runs.push(run);
      }
      run = [];
    };
    for (const node of body.childNodes) {
      if (isPlain(node)) {
        run.push(node);
      } else {
        close();
      }
    }
    close();
    return runs;
  }

  // Runs of spaces and leading spaces would collapse on screen and in textOf's
  // eyes once inserted: they go in as non-breaking spaces, which textOf reads
  // back as spaces.
  function escapeLine(line) {
    return line
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/^ +| {2,}/g, (spaces) => "\u00a0".repeat(spaces.length));
  }

  // Markdown source as the editor holds typed text: one paragraph per line for a
  // block, br-separated text for an inline fragment.
  function sourceHtml(text, inline) {
    const lines = text.split("\n").map(escapeLine);
    if (inline) {
      return lines.join("<br>");
    }
    return lines.map((line) => `<p>${line || "<br>"}</p>`).join("");
  }

  function fragmentOf(document, html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  }

  // Rendered elements the toggle may bring back: not those inside a quote or a
  // signature, which a reply or an edited draft can carry.
  function restorable(root) {
    return [...root.querySelectorAll(`[${MarkdownPaste.SOURCE_ATTRIBUTE}]`)].filter(
      (element) => !element.closest('blockquote[type="cite"], .moz-signature'),
    );
  }

  // In br mode a block source is br-separated lines, and needs one more br only
  // when inline content follows on what would otherwise be its last line.
  function brSourceHtml(source, next) {
    const ends = !next || next.nodeName === "BR" || BLOCK_TAGS.has(next.nodeName);
    return sourceHtml(source, true) + (ends ? "" : "<br>");
  }

  // The HTML of nodes with every rendered element replaced by its source. When
  // the editor split or copied an element, its pieces share one source: the
  // first piece brings it back, the others stay rendered.
  function restoreHtml(nodes, brMode = false) {
    const document = nodes[0].ownerDocument;
    const box = document.createElement("div");
    box.append(...nodes.map((node) => node.cloneNode(true)));
    const seen = new Set();
    // Document order: an outer element goes first, and what it held leaves
    // the tree with it.
    for (const element of restorable(box)) {
      if (!box.contains(element)) {
        continue;
      }
      const source = element.getAttribute(MarkdownPaste.SOURCE_ATTRIBUTE);
      if (seen.has(source)) {
        element.replaceWith(...element.childNodes);
        continue;
      }
      seen.add(source);
      const inline = element.nodeName === "SPAN";
      const html = brMode && !inline ? brSourceHtml(source, element.nextSibling) : sourceHtml(source, inline);
      element.replaceWith(fragmentOf(document, html));
    }
    return box.innerHTML;
  }

  // The HTML of nodes with each run replaced by renderText of its text. A run
  // renderText refuses (null) and everything between runs are kept as they are.
  function renderRunsHtml(nodes, runs, renderText) {
    const document = nodes[0].ownerDocument;
    const runByStart = new Map(runs.map((run) => [run[0], run]));
    const box = document.createElement("div");
    for (let i = 0; i < nodes.length; i++) {
      const run = runByStart.get(nodes[i]);
      const html = run ? renderText(textOf(run)) : null;
      if (html === null) {
        box.append(nodes[i].cloneNode(true));
      } else {
        box.append(fragmentOf(document, html));
        i += run.length - 1;
      }
    }
    return box.innerHTML;
  }

  // Outside Thunderbird (unit tests) only the pure helpers above are exposed.
  if (typeof messenger === "undefined") {
    globalThis.MarkdownPasteCompose = { textOf, plainRuns, sourceHtml, restorable, restoreHtml, renderRunsHtml };
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
      if (MarkdownPaste.shouldRenderPaste(paste) && insertHtml(MarkdownPaste.renderTagged(paste.plain))) {
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

  function selectNodes(selection, first, last) {
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function topLevel(node) {
    while (node.parentNode !== document.body) {
      node = node.parentNode;
    }
    return node;
  }

  // The top-level nodes from first to last, both included.
  function nodesBetween(first, last) {
    const nodes = [first];
    while (nodes.at(-1) !== last) {
      nodes.push(nodes.at(-1).nextSibling);
    }
    return nodes;
  }

  // Convert is an explicit request: no heuristic, only the length limit and
  // text that would vanish.
  function renderable(text) {
    return text.length > 0 && text.length <= MarkdownPaste.MAX_MARKDOWN_LENGTH && !MarkdownPaste.rendersToNothing(text);
  }

  // A selection containing anything but plain text is left as it is.
  function convertSelection(selection) {
    const nodes = [...selection.getRangeAt(0).cloneContents().childNodes];
    const text = nodes.every(isPlain) ? textOf(nodes) : "";
    if (renderable(text)) {
      insertHtml(MarkdownPaste.renderTagged(text));
    }
  }

  // Brings every rendered element back to its Markdown if there is one, else
  // renders every plain run. One insertHTML over the whole stretch, so the
  // toggle is one undo step; what lies between runs is written back as it was.
  function toggleDraft(selection) {
    const body = document.body;
    const rendered = restorable(body);
    let nodes;
    let html;
    if (rendered.length > 0) {
      nodes = nodesBetween(topLevel(rendered[0]), topLevel(rendered.at(-1)));
      html = restoreHtml(nodes, document.queryCommandValue("defaultParagraphSeparator") === "br");
    } else {
      const runs = plainRuns(body);
      if (runs.length === 0) {
        return;
      }
      let changed = false;
      nodes = nodesBetween(runs[0][0], runs.at(-1).at(-1));
      html = renderRunsHtml(nodes, runs, (text) => {
        if (!renderable(text)) {
          return null;
        }
        changed = true;
        // Whole lines become a block: a one-line run must not turn into a
        // span loose in the body.
        return MarkdownPaste.renderTagged(text, true);
      });
      if (!changed) {
        return;
      }
    }
    selectNodes(selection, nodes[0], nodes.at(-1));
    insertHtml(html);
  }

  // Converts the selection, or else toggles the whole draft.
  function convert() {
    const selection = window.getSelection();
    if (!htmlEditor || !selection) {
      return;
    }
    try {
      if (selection.rangeCount > 0 && !selection.isCollapsed) {
        convertSelection(selection);
      } else {
        toggleDraft(selection);
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
