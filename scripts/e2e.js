#!/usr/bin/env node
/*
 * End-to-end checks in a real, headless Thunderbird on a throwaway profile.
 * Real clipboard, real cmd_paste and cmd_undo: jsdom has no editor, so this is
 * the only place where undo can be proven. It never touches the user's profile.
 */
"use strict";
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BINARY = process.env.THUNDERBIRD_BIN ?? "/Applications/Thunderbird.app/Contents/MacOS/thunderbird";
const PORT = Number(process.env.MARIONETTE_PORT ?? 2929);
const COMMAND_TIMEOUT = Number(process.env.E2E_COMMAND_TIMEOUT ?? 60000);
const ACTION_ID = "markdown-paste_nicoladmin_fr-composeAction-toolbarbutton";

class Marionette {
  #socket; #buffer = Buffer.alloc(0); #waiting = []; #id = 0;

  async connect() {
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          this.#socket = net.connect(PORT, "127.0.0.1", resolve);
          this.#socket.once("error", reject);
        });
        this.#socket.on("data", (chunk) => this.#onData(chunk));
        await this.#next();
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error("Marionette did not answer");
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const colon = this.#buffer.indexOf(":");
      if (colon < 0) return;
      const length = Number(this.#buffer.subarray(0, colon).toString());
      if (this.#buffer.length < colon + 1 + length) return;
      const body = this.#buffer.subarray(colon + 1, colon + 1 + length).toString();
      this.#buffer = this.#buffer.subarray(colon + 1 + length);
      this.#waiting.shift()(JSON.parse(body));
    }
  }

  #next() {
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  async send(name, params = {}) {
    const body = JSON.stringify([0, ++this.#id, name, params]);
    const reply = this.#next();
    this.#socket.write(`${Buffer.byteLength(body)}:${body}`);
    // Marionette can stay silent forever: a hung command must fail, and say which.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name}: no answer after ${COMMAND_TIMEOUT} ms`)), COMMAND_TIMEOUT);
    });
    const [, , error, result] = await Promise.race([reply, timeout]).finally(() => clearTimeout(timer));
    if (error) throw new Error(`${name}: ${error.error}: ${error.message}`);
    return result;
  }

  async run(script, args = []) {
    const wrapped = `const done = arguments[arguments.length - 1];
      (async (...a) => { ${script} })(...arguments).then(
        (value) => done({ value }), (e) => done({ failure: String(e) + "\\n" + e.stack }));`;
    const { value } = await this.send("WebDriver:ExecuteAsyncScript", { script: wrapped, args, sandbox: "system" });
    if (value.failure) throw new Error(value.failure);
    return value.value;
  }

  close() {
    this.#socket?.destroy();
  }
}

const step = (message) => console.log(`--    ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HELPERS = `
  const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const editorWin = () => Services.wm.getMostRecentWindow("msgcompose");
  const doc = () => editorWin().document.getElementById("messageEditor").contentDocument;
`;

async function openCompose(tb, { plainText = false, body = "" } = {}) {
  await tb.run(`${HELPERS}
    const params = Cc["@mozilla.org/messengercompose/composeparams;1"].createInstance(Ci.nsIMsgComposeParams);
    const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
    fields.body = a[1];
    params.type = Ci.nsIMsgCompType.New;
    params.format = a[0] ? Ci.nsIMsgCompFormat.PlainText : Ci.nsIMsgCompFormat.HTML;
    params.composeFields = fields;
    params.identity = MailServices.accounts.defaultAccount?.defaultIdentity ?? MailServices.accounts.allIdentities[0];
    MailServices.compose.OpenComposeWindowWithParams(null, params);
  `, [plainText, body]);
  await waitFor(tb, `const w = Services.wm.getMostRecentWindow("msgcompose");
    return !!w && w.document.readyState === "complete" && !!w.gMsgCompose && !!w.document.getElementById("messageEditor").contentDocument?.body;`);
  // Lets the compose script load and learn the editor mode.
  await sleep(1500);
}

async function waitFor(tb, script) {
  for (let i = 0; i < 60; i++) {
    if (await tb.run(script)) return;
    await sleep(250);
  }
  throw new Error(`timeout: ${script}`);
}

const closeCompose = (tb) => tb.run(`${HELPERS}
  const w = editorWin();
  w.gMsgCompose.bodyModified = false; w.gContentChanged = false;
  w.ComposeCanClose = () => true;
  w.close();
  await new Promise((r) => setTimeout(r, 300));`);

function setClipboard(tb, flavors) {
  return tb.run(`
    const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    t.init(null);
    for (const [flavor, value] of Object.entries(a[0])) {
      const s = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
      s.data = value;
      t.addDataFlavor(flavor);
      t.setTransferData(flavor, s);
    }
    Services.clipboard.setData(t, null, Ci.nsIClipboard.kGlobalClipboard);
  `, [flavors]);
}

const command = (tb, name) => tb.run(`${HELPERS}
  const w = editorWin();
  w.document.getElementById("messageEditor").contentWindow.focus();
  w.goDoCommand(a[0]);
  await new Promise((r) => setTimeout(r, 150));`, [name]);

const bodyHtml = (tb) => tb.run(`${HELPERS} return doc().body.innerHTML;`);
const bodyText = (tb) => tb.run(`${HELPERS} return doc().body.textContent;`);
const query = (tb, selector) => tb.run(`${HELPERS}
  return doc().querySelector(a[0])?.outerHTML ?? null;`, [selector]);
const sentHtml = (tb) => tb.run(`${HELPERS}
  return editorWin().GetCurrentEditor().outputToString("text/html", 2);`);

const clickAction = async (tb) => {
  await tb.run(`${HELPERS}
    const button = editorWin().document.getElementById(a[0]);
    if (!button) throw new Error("compose action button not found");
    button.click();`, [ACTION_ID]);
  await sleep(400);
};

const putCaret = (tb, selector) => tb.run(`${HELPERS}
  const d = doc();
  const el = d.querySelector(a[0]);
  d.defaultView.getSelection().collapse(el.firstChild, 0);`, [selector]);


// Real key events: they go through the window's key bindings like a keystroke.
const press = async (tb, key, code, modifiers) => {
  await tb.run(`${HELPERS}
    const w = editorWin();
    const editorWindow = w.document.getElementById("messageEditor").contentWindow;
    Services.focus.activeWindow = w;
    editorWindow.focus();
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    tip.beginInputTransactionForTests(editorWindow);
    const make = (k, c) => new editorWindow.KeyboardEvent("", { key: k, code: c, keyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0 });
    const names = { accel: AppConstants.platform === "macosx" ? "Meta" : "Control", shift: "Shift", alt: "Alt" };
    const held = a[2].map((m) => make(names[m], names[m] + "Left"));
    held.forEach((e) => tip.keydown(e));
    const main = make(a[0], a[1]);
    tip.keydown(main);
    tip.keyup(main);
    held.reverse().forEach((e) => tip.keyup(e));
    await new Promise((r) => setTimeout(r, 300));`, [key, code, modifiers]);
};

const MD = "# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = 1;\n```";

const scenarios = {
  async "Markdown paste renders, and one undo restores the exact body"(tb) {
    await openCompose(tb);
    const before = await bodyHtml(tb);
    await setClipboard(tb, { "text/plain": MD });
    await command(tb, "cmd_paste");
    const pasted = await bodyHtml(tb);
    assert.match(pasted, /<h1[^>]*>Title<\/h1>/);
    assert.match(pasted, /<table/);
    assert.match(await query(tb, "h1"), /font-size/);
    assert.doesNotMatch(await sentHtml(tb), /# Title/);
    await command(tb, "cmd_undo");
    assert.equal(await bodyHtml(tb), before);
    await command(tb, "cmd_redo");
    assert.equal(await bodyHtml(tb), pasted);
    await closeCompose(tb);
  },

  async "the rendered text is inserted once, without a raw copy"(tb) {
    await openCompose(tb);
    await setClipboard(tb, { "text/plain": "# Unique heading\n\nBody **word** here" });
    await command(tb, "cmd_paste");
    const text = await bodyText(tb);
    assert.equal(text.match(/Unique heading/g).length, 1);
    assert.doesNotMatch(text, /\*\*|# Unique/);
    await closeCompose(tb);
  },

  async "inline styles reach the HTML that gets sent"(tb) {
    await openCompose(tb);
    await setClipboard(tb, { "text/plain": MD });
    await command(tb, "cmd_paste");
    const sent = await sentHtml(tb);
    assert.match(sent, /<h1[^>]*style="[^"]*font-size/);
    assert.match(sent, /<td[^>]*style="[^"]*border/);
    assert.match(sent, /<span[^>]*style="[^"]*color[^"]*"[^>]*>const<\/span>/);
    assert.doesNotMatch(sent, /markdown-paste|data-markdown|class="hljs/);
    await closeCompose(tb);
  },

  async "rich clipboard content keeps its native paste"(tb) {
    await openCompose(tb);
    await setClipboard(tb, {
      "text/html": '<p>see <a href="https://example.org/x">the **link**</a></p>',
      "text/plain": "see the **link**",
    });
    await command(tb, "cmd_paste");
    assert.match(await query(tb, "a"), /href="https:\/\/example.org\/x"/);
    assert.match(await bodyText(tb), /\*\*link\*\*/);
    assert.equal(await query(tb, "strong"), null);
    await closeCompose(tb);
  },

  async "ordinary text keeps its native paste, undo included"(tb) {
    await openCompose(tb);
    const before = await bodyHtml(tb);
    await setClipboard(tb, { "text/plain": "Just a sentence." });
    await command(tb, "cmd_paste");
    assert.match(await bodyText(tb), /Just a sentence\./);
    await command(tb, "cmd_undo");
    assert.equal(await bodyHtml(tb), before);
    await closeCompose(tb);
  },

  async "the paste-without-formatting shortcut stays raw"(tb) {
    await openCompose(tb);
    await setClipboard(tb, { "text/plain": "# Raw" });
    await tb.run(`${HELPERS}
      const d = doc();
      d.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "V", ctrlKey: true, shiftKey: true, bubbles: true }));`);
    await command(tb, "cmd_paste");
    assert.match(await bodyText(tb), /# Raw/);
    assert.equal(await query(tb, "h1"), null);
    await closeCompose(tb);
  },

  async "the plain-text editor is left alone"(tb) {
    await openCompose(tb, { plainText: true });
    await setClipboard(tb, { "text/plain": "# Raw" });
    await command(tb, "cmd_paste");
    assert.match(await bodyText(tb), /# Raw/);
    assert.equal(await query(tb, "h1"), null);
    await closeCompose(tb);
  },

  async "the button converts the caret's text only, and one undo reverts it"(tb) {
    const quote = '<blockquote type="cite"><p># old **quote**</p></blockquote>';
    const signature = '<div class="moz-signature">--<br>**Me**</div>';
    await openCompose(tb);
    await tb.run(`${HELPERS}
      const d = doc();
      d.defaultView.focus();
      d.execCommand("selectAll");
      d.execCommand("insertHTML", false, a[0]);`, [`${quote}<p id="mine"># Mine</p><p>- item</p><br>${signature}`]);
    await sleep(100);
    const before = await bodyHtml(tb);
    await putCaret(tb, "#mine");
    await clickAction(tb);
    const after = await bodyHtml(tb);
    assert.match(after, /<h1[^>]*>Mine<\/h1>/);
    assert.match(after, /<li[^>]*>item<\/li>/);
    assert.match(after, /# old \*\*quote\*\*/);
    assert.match(after, /\*\*Me\*\*/);
    await command(tb, "cmd_undo");
    assert.equal(await bodyHtml(tb), before);
    await closeCompose(tb);
  },

  async "the button does nothing inside a quote"(tb) {
    await openCompose(tb);
    await tb.run(`${HELPERS}
      const d = doc();
      d.defaultView.focus();
      d.execCommand("selectAll");
      d.execCommand("insertHTML", false, a[0]);`, ['<blockquote id="q" type="cite"># old</blockquote><p>mine</p>']);
    await sleep(100);
    const before = await bodyHtml(tb);
    await putCaret(tb, "#q");
    await clickAction(tb);
    assert.equal(await bodyHtml(tb), before);
    await closeCompose(tb);
  },

  async "the button converts just the selection"(tb) {
    await openCompose(tb);
    await tb.run(`${HELPERS}
      const d = doc();
      d.defaultView.focus();
      d.execCommand("selectAll");
      d.execCommand("insertHTML", false, a[0]);`, ['<p id="a">**keep**</p><p id="b">**take**</p>']);
    await sleep(100);
    await tb.run(`${HELPERS}
      const d = doc();
      const r = d.createRange();
      r.selectNodeContents(d.getElementById("b"));
      const s = d.defaultView.getSelection();
      s.removeAllRanges();
      s.addRange(r);`);
    await clickAction(tb);
    const after = await bodyHtml(tb);
    assert.match(after, /\*\*keep\*\*/);
    assert.match(after, /<strong>take<\/strong>/);
    await closeCompose(tb);
  },

  async "the real keyboard shortcuts paste and undo"(tb) {
    await openCompose(tb);
    const before = await bodyHtml(tb);
    await setClipboard(tb, { "text/plain": MD });
    await press(tb, "v", "KeyV", ["accel"]);
    assert.match(await bodyHtml(tb), /<h1[^>]*>Title<\/h1>/);
    await press(tb, "z", "KeyZ", ["accel"]);
    assert.equal(await bodyHtml(tb), before);
    await closeCompose(tb);
  },

  async "the real paste-without-formatting shortcut stays raw"(tb) {
    await openCompose(tb);
    await setClipboard(tb, { "text/plain": "# Raw" });
    await press(tb, "v", "KeyV", ["accel", "shift"]);
    assert.match(await bodyText(tb), /# Raw/);
    assert.equal(await query(tb, "h1"), null);
    await closeCompose(tb);
  },

  async "the real conversion shortcut works"(tb) {
    await openCompose(tb);
    await tb.run(`${HELPERS}
      const d = doc();
      d.defaultView.focus();
      d.execCommand("selectAll");
      d.execCommand("insertHTML", false, a[0]);`, ['<p id="mine"># Mine</p>']);
    await sleep(100);
    await putCaret(tb, "#mine");
    await press(tb, "m", "KeyM", ["accel", "alt"]);
    await sleep(400);
    assert.match(await bodyHtml(tb), /<h1[^>]*>Mine<\/h1>/);
    await closeCompose(tb);
  },

  async "an inline paste stays on its line, and undo keeps what was typed"(tb) {
    await openCompose(tb);
    await tb.run(`${HELPERS}
      const d = doc();
      d.defaultView.focus();
      d.execCommand("insertText", false, "Hello ");`);
    await sleep(100);
    const before = await bodyHtml(tb);
    await setClipboard(tb, { "text/plain": "some **bold** word" });
    await command(tb, "cmd_paste");
    const after = await bodyHtml(tb);
    assert.match(after, /Hello\s*(&nbsp;)?\s*some <strong>bold<\/strong> word/);
    assert.equal((after.match(/<(p|div|h1)\b/g) ?? []).length, (before.match(/<(p|div|h1)\b/g) ?? []).length);
    await command(tb, "cmd_undo");
    assert.equal(await bodyHtml(tb), before);
    await closeCompose(tb);
  },

  async "a click between two lists does not land outside them, and Delete keeps the text"(tb) {
    await openCompose(tb);
    await setClipboard(tb, { "text/plain": "1. first\n2. last\n\n- [x] kept item\n- [ ] other item\n\n## Next" });
    await press(tb, "v", "KeyV", ["accel"]);
    const before = await bodyHtml(tb);
    const point = await tb.run(`${HELPERS}
      const frame = editorWin().document.getElementById("messageEditor").getBoundingClientRect();
      const ol = doc().querySelector("ol");
      const top = ol.getBoundingClientRect();
      const next = ol.nextElementSibling.getBoundingClientRect();
      return { x: Math.round(frame.left + top.left + 300), y: Math.round(frame.top + (top.bottom + next.top) / 2) };`);
    await tb.send("WebDriver:PerformActions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", x: point.x, y: point.y, origin: "viewport", duration: 0 },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ] }] });
    await sleep(300);
    const caretParent = await tb.run(`${HELPERS}
      const node = doc().defaultView.getSelection().anchorNode;
      return (node.nodeType === 3 ? node.parentNode : node).nodeName;`);
    assert.notEqual(caretParent, "BODY");
    await press(tb, "Delete", "Delete", []);
    const text = await bodyText(tb);
    assert.match(text, /kept item/);
    assert.equal(text.match(/first/g).length, 1);
    await command(tb, "cmd_undo");
    assert.equal(await bodyHtml(tb), before);
    await closeCompose(tb);
  },

  async "the raw shortcut does not stick when its keys are released in another order"(tb) {
    await openCompose(tb);
    await tb.run(`${HELPERS}
      const d = doc();
      const K = d.defaultView.KeyboardEvent;
      d.dispatchEvent(new K("keydown", { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true, bubbles: true }));
      d.dispatchEvent(new K("keyup", { key: "Shift", code: "ShiftLeft", ctrlKey: true, bubbles: true }));
      d.dispatchEvent(new K("keyup", { key: "v", code: "KeyV", ctrlKey: true, bubbles: true }));`);
    await setClipboard(tb, { "text/plain": "# Rendered" });
    await press(tb, "v", "KeyV", ["accel"]);
    assert.match(await query(tb, "h1"), /Rendered/);
    await closeCompose(tb);
  },

  async "the raw shortcut works on a non-Latin layout"(tb) {
    await openCompose(tb);
    await setClipboard(tb, { "text/plain": "# Raw" });
    await tb.run(`${HELPERS}
      const d = doc();
      d.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "м", code: "KeyV", ctrlKey: true, shiftKey: true, bubbles: true }));`);
    await command(tb, "cmd_paste");
    assert.equal(await query(tb, "h1"), null);
    await closeCompose(tb);
  },

  async "the button leaves a selection containing formatted content alone"(tb) {
    await openCompose(tb);
    await tb.run(`${HELPERS}
      const d = doc();
      d.defaultView.focus();
      d.execCommand("selectAll");
      d.execCommand("insertHTML", false, a[0]);`, ['<p>intro <a href="https://example.org/doc">the doc</a> **b**</p><blockquote type="cite"><p>old</p></blockquote><div class="moz-signature">-- <br>Me</div>']);
    await sleep(100);
    const before = await bodyHtml(tb);
    await tb.run(`${HELPERS} doc().execCommand("selectAll");`);
    await clickAction(tb);
    assert.equal(await bodyHtml(tb), before);
    await closeCompose(tb);
  },

  async "the button leaves a text that renders to nothing alone"(tb) {
    await openCompose(tb);
    await tb.run(`${HELPERS}
      const d = doc();
      d.defaultView.focus();
      d.execCommand("selectAll");
      d.execCommand("insertHTML", false, a[0]);`, ['<p id="p">[foo]: http://x.y</p>']);
    await sleep(100);
    await putCaret(tb, "#p");
    await clickAction(tb);
    assert.match(await bodyText(tb), /\[foo\]: http:\/\/x\.y/);
    await closeCompose(tb);
  },

  async "a disabled add-on stops touching pastes"(tb) {
    await openCompose(tb);
    await tb.run(`
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID("markdown-paste@nicoladmin.fr");
      await addon.disable();`);
    await sleep(500);
    try {
      await setClipboard(tb, { "text/plain": "# Raw" });
      await command(tb, "cmd_paste");
      assert.equal(await query(tb, "h1"), null);
    } finally {
      await tb.run(`
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const addon = await AddonManager.getAddonByID("markdown-paste@nicoladmin.fr");
        await addon.enable();`);
      await sleep(800);
    }
    await closeCompose(tb);
  },
};

// Refuses to run against an instance it did not start, which could be the user's.
function assertPortFree() {
  return new Promise((resolve, reject) => {
    const probe = net.connect(PORT, "127.0.0.1");
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error(`port ${PORT} is already in use: not running against that instance`));
    });
    probe.once("error", () => resolve());
  });
}

async function main() {
  await assertPortFree();
  const profile = fs.mkdtempSync(path.join(process.env.E2E_TMP ?? os.tmpdir(), "tb-profile-"));
  fs.writeFileSync(path.join(profile, "user.js"), [
    `user_pref("marionette.port", ${PORT});`,
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("mailnews.start_page.enabled", false);',
    'user_pref("mail.provider.suppress_dialog_on_startup", true);',
    'user_pref("mail.shell.checkDefaultClient", false);',
    'user_pref("mail.compose.default_to_paragraph", true);',
    'user_pref("app.update.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  ].join("\n"));

  const child = spawn(BINARY, [
    "--headless", "--marionette", "--no-remote", "--new-instance", "--profile", profile,
  ], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" } });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-20000);
  });
  child.on("exit", (code, signal) => step(`thunderbird exited: code=${code} signal=${signal}`));

  const tb = new Marionette();
  let failed = 0;
  try {
    step("waiting for Marionette");
    await tb.connect();
    step("connected");
    await tb.send("WebDriver:NewSession", { capabilities: { alwaysMatch: { "moz:accessibilityChecks": false } } });
    step("session open");
    await tb.send("Marionette:SetContext", { value: "chrome" });
    await tb.send("WebDriver:SetTimeouts", { script: 30000 });
    await tb.run(`${HELPERS}
      const account = MailServices.accounts.createAccount();
      const identity = MailServices.accounts.createIdentity();
      identity.email = "test@example.org";
      identity.fullName = "Test";
      account.addIdentity(identity);
      account.incomingServer = MailServices.accounts.createIncomingServer("test", "localhost", "none");`);
    step("account created");
    await tb.send("Addon:Install", { path: process.env.E2E_ADDON ?? ROOT, temporary: !process.env.E2E_ADDON });
    step("add-on installed");
    await sleep(1000);

    const only = process.argv[2];
    for (const [name, run] of Object.entries(scenarios)) {
      if (only && !name.includes(only)) continue;
      try {
        await run(tb);
        console.log(`ok    ${name}`);
      } catch (error) {
        failed++;
        console.log(`FAIL  ${name}\n      ${String(error.message).split("\n").slice(0, 12).join("\n      ")}`);
        await closeCompose(tb).catch(() => {});
      }
    }
    console.log(failed ? `\n${failed} failed` : "\nall passed");
  } catch (error) {
    console.error(`thunderbird stderr (tail):\n${stderr}`);
    throw error;
  } finally {
    tb.close();
    child.kill("SIGKILL");
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
