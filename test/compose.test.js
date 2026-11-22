"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { ROOT, SCRIPTS } = require("./helpers");

// The renderer first, then compose.js, as in the compose_scripts manifest key.
function load(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><body>${bodyHtml}</body>`, { runScripts: "outside-only" });
  const { window } = dom;
  for (const file of [...SCRIPTS, "src/compose.js"]) {
    window.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  }
  return window;
}

// Arrays built inside jsdom have another realm's prototype: copy them out.
const ids = (runs) => Array.from(runs, (run) => Array.from(run, (n) => n.id || n.nodeName));

// Reads HTML the way the editor will hold it once inserted.
function nodesOf(w, html) {
  const box = w.document.createElement("div");
  box.innerHTML = html;
  return [...box.childNodes];
}

test("reads plain lines as the user sees them", () => {
  const w = load("<p>- one</p><p>- two</p><p><br></p><p>text</p>");
  const { textOf } = w.MarkdownPasteCompose;
  assert.equal(textOf([...w.document.body.childNodes]), "- one\n- two\n\ntext");
});

test("reads br-separated lines and normalises non-breaking spaces", () => {
  const w = load("# a b<br>second<br><br>third");
  const { textOf } = w.MarkdownPasteCompose;
  assert.equal(textOf([...w.document.body.childNodes]), "# a b\nsecond\n\nthird");
});

test("finds every plain run of the draft, stopping at signature, quote and formatting", () => {
  const w = load(
    '<div class="moz-cite-prefix">On Monday:</div><blockquote type="cite">old</blockquote>' +
      '<p id="a"># mine</p><p id="b">more</p><br>' +
      '<table id="t"><tr><td>x</td></tr></table><p id="c">two</p>' +
      '<div class="moz-signature">-- <br>Me</div>',
  );
  const { plainRuns } = w.MarkdownPasteCompose;
  assert.deepEqual(ids(plainRuns(w.document.body)), [["a", "b"], ["c"]]);
});

test("a run loses its blank edges, and a blank run is no run", () => {
  const w = load('<p id="e1"><br></p><p id="a">x</p><p id="e2"><br></p><blockquote>q</blockquote><p id="e3"><br></p>');
  const { plainRuns } = w.MarkdownPasteCompose;
  assert.deepEqual(ids(plainRuns(w.document.body)), [["a"]]);
});

test("formatted content, a quote and a signature hold no run", () => {
  const w = load('<table><tr><td id="d">x</td></tr></table><div class="moz-signature" id="s">sig</div>');
  const { plainRuns } = w.MarkdownPasteCompose;
  assert.deepEqual(ids(plainRuns(w.document.body)), []);
});

test("rendered blocks are not plain, so a second toggle never renders them again", () => {
  const w = load('<p id="a">x</p><div data-markdown-source="# T"><h1>T</h1></div><p id="b">y <span data-markdown-source="**z**"><strong>z</strong></span></p>');
  const { plainRuns } = w.MarkdownPasteCompose;
  assert.deepEqual(ids(plainRuns(w.document.body)), [["a"]]);
});

test("a paragraph with its own formatting is not plain", () => {
  const w = load('<p id="a" style="color:red"># x</p><p id="b" align="right"># y</p><p id="c" dir="rtl"># z</p>');
  const { plainRuns } = w.MarkdownPasteCompose;
  assert.deepEqual(ids(plainRuns(w.document.body)), []);
});

test("the extension's test entry point needs no flag a message could set", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/compose.js"), "utf8");
  assert.doesNotMatch(source, /__TEST__/);
});

test("the editor's internal attributes do not make a paragraph formatted", () => {
  const w = load('<p id="a" _moz_dirty=""># x</p>');
  const { plainRuns } = w.MarkdownPasteCompose;
  assert.deepEqual(ids(plainRuns(w.document.body)), [["a"]]);
});

test("a block source comes back as one plain paragraph per line", () => {
  const w = load("");
  const { sourceHtml } = w.MarkdownPasteCompose;
  assert.equal(
    sourceHtml("# T\n\n  - <sub> & co", false),
    "<p># T</p><p><br></p><p>\u00a0\u00a0- &lt;sub&gt; &amp; co</p>",
  );
});

test("an inline source comes back as text, lines split by br", () => {
  const w = load("");
  const { sourceHtml } = w.MarkdownPasteCompose;
  assert.equal(sourceHtml("a  **b**\nc", true), "a\u00a0\u00a0**b**<br>c");
});

test("a restored source reads back as the exact Markdown", () => {
  const w = load("");
  const { sourceHtml, textOf } = w.MarkdownPasteCompose;
  for (const text of [
    "# Title\n\n- one\n  - nested\n\n```js\nif (a) {\n    b();\n}\n```",
    "\nleading blank line",
    "trailing spaces  \nand <html> & \"quotes\"",
    "| a | b |\n|---|---|\n| 1 | 2 |",
  ]) {
    assert.equal(textOf(nodesOf(w, sourceHtml(text, false))), text, text);
  }
  assert.equal(textOf(nodesOf(w, `<p>x ${sourceHtml("**b**\nnext", true)} y</p>`)), "x **b**\nnext y");
});

test("restoring replaces each rendered element with its source, and keeps the rest", () => {
  const w = load(
    '<p>before</p><div data-markdown-source="# T\n\nbody"><h1>T</h1><p>body</p></div>' +
      '<blockquote type="cite"><p>old</p></blockquote>' +
      '<p>x <span data-markdown-source="**b**"><strong>b</strong></span> y</p>',
  );
  const { restoreHtml } = w.MarkdownPasteCompose;
  assert.equal(
    restoreHtml([...w.document.body.childNodes]),
    '<p>before</p><p># T</p><p><br></p><p>body</p><blockquote type="cite"><p>old</p></blockquote><p>x **b** y</p>',
  );
});

test("rendering replaces each run and keeps what lies between runs", () => {
  const w = load('<p id="a"># A</p><p id="b">b</p><blockquote type="cite"><p>old</p></blockquote><p id="c">*c*</p>');
  const { plainRuns, renderRunsHtml } = w.MarkdownPasteCompose;
  const body = w.document.body;
  const fake = (text) => `<div data-r="">${text.replace(/\n/g, "|")}</div>`;
  assert.equal(
    renderRunsHtml([...body.childNodes], plainRuns(body), fake),
    '<div data-r=""># A|b</div><blockquote type="cite"><p>old</p></blockquote><div data-r="">*c*</div>',
  );
});

test("a run the renderer refuses stays as it was", () => {
  const w = load('<p id="a"># A</p><blockquote>q</blockquote><p id="c">[x]: http://y.z</p>');
  const { plainRuns, renderRunsHtml } = w.MarkdownPasteCompose;
  const body = w.document.body;
  const fake = (text) => (text.startsWith("#") ? "<h1>A</h1>" : null);
  assert.equal(
    renderRunsHtml([...body.childNodes], plainRuns(body), fake),
    '<h1>A</h1><blockquote>q</blockquote><p id="c">[x]: http://y.z</p>',
  );
});

test("a rendered element nested in another comes back with the outer source only", () => {
  const w = load('<div data-markdown-source="# **T**"><h1><span data-markdown-source="**T**"><strong>T</strong></span></h1></div>');
  const { restoreHtml } = w.MarkdownPasteCompose;
  assert.equal(restoreHtml([...w.document.body.childNodes]), "<p># **T**</p>");
});

test("pieces of one rendered element split by the editor restore its source once", () => {
  const w = load(
    '<p>Hello <span data-markdown-source="some **bold** word">some <strong>bo</strong></span></p>' +
      '<p><span data-markdown-source="some **bold** word"><strong>ld</strong> word</span></p>',
  );
  const { restoreHtml } = w.MarkdownPasteCompose;
  assert.equal(
    restoreHtml([...w.document.body.childNodes]),
    "<p>Hello some **bold** word</p><p><strong>ld</strong> word</p>",
  );
});

test("in br mode a block source comes back as br-separated lines", () => {
  const w = load('<div data-markdown-source="# T\n- a"><h1>T</h1></div>after<br><div data-markdown-source="**z**"><strong>z</strong></div>');
  const { restoreHtml } = w.MarkdownPasteCompose;
  assert.equal(restoreHtml([...w.document.body.childNodes], true), "# T<br>- a<br>after<br>**z**");
});

test("in br mode a block source keeps its line before a quote without an extra break", () => {
  const w = load('<div data-markdown-source="# T"><h1>T</h1></div><blockquote type="cite">q</blockquote>');
  const { restoreHtml } = w.MarkdownPasteCompose;
  assert.equal(restoreHtml([...w.document.body.childNodes], true), '# T<blockquote type="cite">q</blockquote>');
});

test("rendered elements inside a quote or a signature are left as they are", () => {
  const w = load(
    '<div data-markdown-source="# Mine"><h1>Mine</h1></div>' +
      '<blockquote type="cite"><div data-markdown-source="# Old"><h1>Old</h1></div></blockquote>' +
      '<div class="moz-signature"><span data-markdown-source="**Me**"><strong>Me</strong></span></div>',
  );
  const { restoreHtml, restorable } = w.MarkdownPasteCompose;
  const body = w.document.body;
  assert.deepEqual(Array.from(restorable(body), (el) => el.getAttribute("data-markdown-source")), ["# Mine"]);
  assert.equal(
    restoreHtml([...body.childNodes]),
    '<p># Mine</p><blockquote type="cite"><div data-markdown-source="# Old"><h1>Old</h1></div></blockquote>' +
      '<div class="moz-signature"><span data-markdown-source="**Me**"><strong>Me</strong></span></div>',
  );
});
