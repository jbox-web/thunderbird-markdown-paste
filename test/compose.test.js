"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { ROOT } = require("./helpers");

function load(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><body>${bodyHtml}</body>`, { runScripts: "outside-only" });
  const { window } = dom;
  window.eval(fs.readFileSync(path.join(ROOT, "src/compose.js"), "utf8"));
  return window;
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

test("selects the plain run around the caret, stopping at signature and quote", () => {
  const w = load(
    '<div class="moz-cite-prefix">On Monday:</div><blockquote type="cite">old</blockquote>' +
      '<p id="a"># mine</p><p id="b">more</p><br>' +
      '<div class="moz-signature">-- <br>Me</div>',
  );
  const { plainRunAround } = w.MarkdownPasteCompose;
  const b = w.document.getElementById("b");
  const run = plainRunAround(b.firstChild);
  assert.deepEqual(Array.from(run, (n) => n.id), ["a", "b"]);
});

test("does not extend a run through formatted content", () => {
  const w = load('<p id="a">one</p><table id="t"><tr><td>x</td></tr></table><p id="c">two</p>');
  const { plainRunAround } = w.MarkdownPasteCompose;
  const run = plainRunAround(w.document.getElementById("c").firstChild);
  assert.deepEqual(Array.from(run, (n) => n.id), ["c"]);
});

test("finds nothing to convert inside formatted content", () => {
  const w = load('<table><tr><td id="d">x</td></tr></table><div class="moz-signature" id="s">sig</div>');
  const { plainRunAround } = w.MarkdownPasteCompose;
  assert.equal(plainRunAround(w.document.getElementById("d").firstChild).length, 0);
  assert.equal(plainRunAround(w.document.getElementById("s").firstChild).length, 0);
});

test("a paragraph with its own formatting is not plain", () => {
  const w = load('<p id="a" style="color:red"># x</p><p id="b" align="right"># y</p><p id="c" dir="rtl"># z</p>');
  const { plainRunAround } = w.MarkdownPasteCompose;
  for (const id of ["a", "b", "c"]) {
    assert.equal(plainRunAround(w.document.getElementById(id).firstChild).length, 0, id);
  }
});

test("the extension's test entry point needs no flag a message could set", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/compose.js"), "utf8");
  assert.doesNotMatch(source, /__TEST__/);
});

test("the editor's internal attributes do not make a paragraph formatted", () => {
  const w = load('<p id="a" _moz_dirty=""># x</p>');
  const { plainRunAround } = w.MarkdownPasteCompose;
  assert.equal(plainRunAround(w.document.getElementById("a").firstChild).length, 1);
});
