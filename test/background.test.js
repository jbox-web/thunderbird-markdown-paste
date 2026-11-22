"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { ROOT } = require("./helpers");

// Runs background.js against a messenger stub that records its listeners.
function loadBackground() {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  const { window } = dom;
  const listeners = {};
  const restored = [];
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  window.messenger = {
    composeAction: { onClicked: event("composeAction.onClicked") },
    commands: { onCommand: event("commands.onCommand") },
    runtime: { onMessage: event("runtime.onMessage") },
    compose: {
      onBeforeSend: event("compose.onBeforeSend"),
      onAfterSend: event("compose.onAfterSend"),
      setComposeDetails: async (tabId, details) => { restored.push([tabId, details]); },
    },
    tabs: { sendMessage: async () => {}, onRemoved: event("tabs.onRemoved") },
  };
  window.eval(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"));
  return { window, listeners, restored };
}

const DRAFT =
  '<!DOCTYPE html>\n<html><head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body>' +
  '<p>a</p><div data-markdown-source="# T"><h1 style="font-size: 2em;">T</h1></div>' +
  '<p>x <span data-markdown-source="**b**"><strong>b</strong></span> y</p></body></html>';

test("on send, rendered blocks lose their source and their wrapper, nothing else", async () => {
  const { window, listeners } = loadBackground();
  const result = await listeners["compose.onBeforeSend"]({ id: 1 }, { isPlainText: false, body: DRAFT });
  const sent = result.details.body;
  assert.match(sent, /^<!DOCTYPE html>/);
  assert.doesNotMatch(sent, /data-markdown/);
  const doc = new window.DOMParser().parseFromString(sent, "text/html");
  assert.equal(doc.body.innerHTML, '<p>a</p><h1 style="font-size: 2em;">T</h1><p>x <strong>b</strong> y</p>');
  assert.equal(doc.head.querySelector("meta").getAttribute("content"), "text/html; charset=UTF-8");
});

test("a message without rendered blocks is sent untouched", async () => {
  const { listeners } = loadBackground();
  const body = "<!DOCTYPE html>\n<html><head></head><body><p>plain</p></body></html>";
  assert.equal(await listeners["compose.onBeforeSend"]({ id: 1 }, { isPlainText: false, body }), undefined);
});

test("a plain-text message is sent untouched", async () => {
  const { listeners } = loadBackground();
  assert.equal(await listeners["compose.onBeforeSend"]({ id: 1 }, { isPlainText: true, body: DRAFT }), undefined);
});

test("a failed send puts the sources back into the compose window", async () => {
  // Thunderbird 160 reports a refused SMTP connection with no error field and a
  // null headerMessageId; the documented error field is covered too.
  for (const sendInfo of [{ mode: "sendNow", headerMessageId: null }, { mode: "sendNow", error: "Connection refused" }]) {
    const { listeners, restored } = loadBackground();
    await listeners["compose.onBeforeSend"]({ id: 7 }, { isPlainText: false, body: DRAFT });
    await listeners["compose.onAfterSend"]({ id: 7 }, sendInfo);
    assert.equal(restored.length, 1, JSON.stringify(sendInfo));
    assert.equal(restored[0][0], 7);
    assert.equal(restored[0][1].body, DRAFT);
  }
});

test("a successful send leaves the compose window alone, and forgets the draft", async () => {
  const { listeners, restored } = loadBackground();
  await listeners["compose.onBeforeSend"]({ id: 7 }, { isPlainText: false, body: DRAFT });
  await listeners["compose.onAfterSend"]({ id: 7 }, { mode: "sendNow", headerMessageId: "abc@example.org" });
  await listeners["compose.onAfterSend"]({ id: 7 }, { mode: "sendNow", headerMessageId: null });
  assert.equal(restored.length, 0);
});
