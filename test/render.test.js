"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRenderer, parse } = require("./helpers");

const window = loadRenderer();
const { render, looksLikeMarkdown, shouldRenderPaste } = window.MarkdownPaste;

test("detects block Markdown", () => {
  for (const text of [
    "# Title",
    "- one\n- two",
    "1. one\n2. two",
    "> quoted",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "```js\nconst a = 1;\n```",
  ]) {
    assert.equal(looksLikeMarkdown(text), true, text);
  }
});

test("detects inline Markdown", () => {
  for (const text of [
    "some **bold** word",
    "some *soft* word",
    "run `make` now",
    "a ~~gone~~ word",
    "see [the docs](https://example.org)",
    "![logo](https://example.org/a.png)",
  ]) {
    assert.equal(looksLikeMarkdown(text), true, text);
  }
});

test("leaves ordinary text alone", () => {
  for (const text of [
    "Bonjour, voici ma réponse.",
    "First paragraph.\n\nSecond paragraph.",
    "line one\nline two",
    "https://example.org/some_path_here",
    "nico@example.org",
    "snake_case_name and 2*3*4",
    "<div class=\"a\">raw markup</div>",
    "    indented output\n    more output",
    "",
    "   \n  ",
  ]) {
    assert.equal(looksLikeMarkdown(text), false, JSON.stringify(text));
  }
});

test("a paste carrying rich content keeps the native behaviour", () => {
  const plain = "# Title";
  assert.equal(shouldRenderPaste({ plain, html: "", hasFiles: false }), true);
  assert.equal(shouldRenderPaste({ plain, html: "", hasFiles: true }), false);
  assert.equal(shouldRenderPaste({ plain, html: "<h1>Title</h1>", hasFiles: false }), false);
  assert.equal(shouldRenderPaste({ plain, html: "<p><a href='x'>Title</a></p>", hasFiles: false }), false);
  assert.equal(shouldRenderPaste({ plain: "plain", html: "", hasFiles: false }), false);
});

test("editor HTML that only carries presentation does not count as rich", () => {
  const vscode =
    '<meta charset="utf-8"><div style="font-family: Menlo; white-space: pre;">' +
    '<div><span style="color: #569cd6;"># Title</span></div><br></div>';
  assert.equal(shouldRenderPaste({ plain: "# Title", html: vscode, hasFiles: false }), true);
});

test("renders a single inline fragment without a block wrapper", () => {
  const body = parse(window, render("some **bold** word"));
  assert.equal(body.querySelector("p"), null);
  assert.equal(body.querySelector("strong").textContent, "bold");
  assert.equal(body.textContent, "some bold word");
});

test("renders blocks with inline styles that survive sending", () => {
  const body = parse(window, render("# Title\n\n| a |\n|---|\n| 1 |\n\n> q\n\n`c`"));
  assert.match(body.querySelector("h1").getAttribute("style"), /font-size/);
  assert.match(body.querySelector("th").getAttribute("style"), /border/);
  assert.match(body.querySelector("td").getAttribute("style"), /border/);
  assert.match(body.querySelector("blockquote").getAttribute("style"), /border-left/);
  assert.match(body.querySelector("code").getAttribute("style"), /font-family/);
});

test("leaves no extension artefact in the message", () => {
  const html = render("# Title\n\n```js\nconst a = 1;\n```\n\n- [x] done");
  assert.doesNotMatch(html, /class=/);
  assert.doesNotMatch(html, /data-/);
  assert.doesNotMatch(html, /markdown-paste/);
});

test("carries syntax colours as inline styles", () => {
  const body = parse(window, render("```js\nconst a = 1;\n```"));
  const keyword = [...body.querySelectorAll("pre span")].find((s) => s.textContent === "const");
  assert.match(keyword.getAttribute("style"), /color/);
  assert.equal(body.querySelector("pre").textContent.trim(), "const a = 1;");
});

test("renders task lists with characters, not form controls", () => {
  const body = parse(window, render("- [x] done\n- [ ] todo"));
  assert.equal(body.querySelector("input"), null);
  const items = [...body.querySelectorAll("li")].map((li) => li.textContent.trim());
  assert.deepEqual(items, ["☑ done", "☐ todo"]);
});

test("shows raw HTML as text instead of swallowing it", () => {
  const block = parse(window, render("# T\n\n<div onclick=\"x()\">kept</div>"));
  assert.match(block.textContent, /<div onclick="x\(\)">kept<\/div>/);
  assert.equal(block.querySelector("div"), null);
  const inline = parse(window, render("a **b** <span>c</span>"));
  assert.equal(inline.textContent, "a b <span>c</span>");
});

test("drops dangerous link targets", () => {
  const body = parse(window, render("[x](javascript:alert(1)) and **y**"));
  assert.equal(body.querySelector("a[href^='javascript']"), null);
});

test("one newline is a line break", () => {
  const body = parse(window, render("# T\n\nline one\nline two"));
  assert.ok(body.querySelector("p br"));
});

test("leaves no whitespace text between blocks, where the caret could land", () => {
  const body = parse(window, render("# T\n\n1. a\n2. b\n\n- c\n  - d\n\n| x |\n|---|\n| 1 |\n\n> q\n\ntext"));
  const walker = body.ownerDocument.createTreeWalker(body, window.NodeFilter.SHOW_TEXT);
  const blank = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.nodeValue.trim()) {
      blank.push(walker.currentNode.parentNode.nodeName);
    }
  }
  assert.equal(blank.join(), "");
});

test("keeps the spaces that separate inline content and code lines", () => {
  assert.equal(parse(window, render("**a** *b*")).textContent, "a b");
  assert.equal(parse(window, render("# T\n\n**a** *b*")).querySelector("p").textContent, "a b");
  const code = parse(window, render("```\none\n\n  two\n```")).querySelector("pre").textContent;
  assert.equal(code, "one\n\n  two");
});

test("markup after a raw tag stays text, whatever its shape", () => {
  for (const source of [
    "**a** <code><a/href=//evil.example/login>Open invoice</a>",
    "**a** <kbd><form/action=//evil.example/f><input/name=password><input/type=submit>",
    "<code><span/style=font-size:0>hidden payload</span> **a**",
    "**a** <code><img/src=//t.example/x.png>",
  ]) {
    const body = parse(window, render(source));
    assert.equal(body.querySelector("a, form, input, img, span"), null, source);
  }
  assert.equal(
    parse(window, render("**a** <code><img/src=//t.example/x.png>")).textContent,
    "a <code><img/src=//t.example/x.png>",
  );
});

test("text after a raw tag is not lost", () => {
  assert.equal(parse(window, render("**a** <code>if a<b then c")).textContent, "a <code>if a<b then c");
  assert.equal(parse(window, render("**a** <script>x<y")).textContent, "a <script>x<y");
});

test("a lone marker is not Markdown", () => {
  for (const text of ["#", "-", "*", "+", ">", "1.", "```", "---"]) {
    assert.equal(looksLikeMarkdown(text), false, text);
  }
  assert.equal(looksLikeMarkdown("| 1 | 2 |\n|---|---|\n| 3 | 4 |"), true);
  assert.equal(looksLikeMarkdown("**12**"), true);
});

test("ordinary text that merely parses as Markdown is left alone", () => {
  for (const text of [
    "Cordialement\n--\nNico",
    "Jane Doe <jane@example.org>",
    "see <https://example.org/a>",
    "def __init__(self):",
    "2**3**4",
    "2024. was a good year",
    "[foo]: http://x.y",
  ]) {
    assert.equal(looksLikeMarkdown(text), false, text);
  }
  assert.equal(looksLikeMarkdown("Title\n====="), true);
  assert.equal(looksLikeMarkdown("a __strong__ word"), true);
});

test("code copied from a web page, and real formatting, stay native", () => {
  const paste = (plain, html) => shouldRenderPaste({ plain, html, hasFiles: false });
  assert.equal(paste("# install\nnpm i", "<pre><code># install\nnpm i</code></pre>"), false);
  assert.equal(paste("- red item", '<div style="color:red;font-size:30px">- red item</div>'), false);
});

test("an unused reference definition keeps its text", () => {
  assert.match(parse(window, render("**b**\n\n[note]: http://x.y/z")).textContent, /\[note\]: http:\/\/x\.y\/z/);
  const used = parse(window, render("see [the doc][note]\n\n[note]: http://x.y/z"));
  assert.equal(used.querySelector("a").getAttribute("href"), "http://x.y/z");
  assert.doesNotMatch(used.textContent, /\[note\]/);
});

test("a code span made of a space survives", () => {
  assert.equal(parse(window, render("use ` ` as sep")).querySelector("code").textContent, " ");
});

test("code without a known language is escaped", () => {
  const body = parse(window, render("```\n<img src=x>\n```"));
  assert.equal(body.querySelector("img"), null);
  assert.equal(body.querySelector("pre").textContent, "<img src=x>");
});

test("table column alignment is kept", () => {
  const body = parse(window, render("| a |\n|:-:|\n| 1 |"));
  assert.equal(body.querySelector("td").getAttribute("align"), "center");
});

test("oversized input is never parsed", () => {
  const started = Date.now();
  assert.equal(looksLikeMarkdown("*a".repeat(200000)), false);
  assert.ok(Date.now() - started < 200);
});
