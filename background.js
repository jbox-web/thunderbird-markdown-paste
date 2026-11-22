"use strict";

function convertIn(tabId) {
  return messenger.tabs.sendMessage(tabId, { type: "convert" }).catch((error) => {
    console.error("Markdown Paste:", error);
  });
}

messenger.composeAction.onClicked.addListener((tab) => convertIn(tab.id));

messenger.commands.onCommand.addListener(async (command, tab) => {
  if (command === "convert-markdown" && tab?.id !== undefined) {
    await convertIn(tab.id);
  }
});

// Compose scripts cannot reach the compose API themselves.
messenger.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "get-compose-mode" && sender.tab) {
    return messenger.compose.getComposeDetails(sender.tab.id).then(({ isPlainText }) => ({ isPlainText }));
  }
  return undefined;
});

// Must match SOURCE_ATTRIBUTE in src/render.js, which the background does not load.
const SOURCE_ATTRIBUTE = "data-markdown-source";

// The body as it was before onBeforeSend stripped it, per compose tab.
const unsentBodies = new Map();

// The source of rendered blocks only serves the toggle while editing: it must
// not reach the recipient. The wrapper goes too, its content takes its place.
// The returned details also rewrite the compose window, so its body is kept
// until the send is known to have succeeded.
messenger.compose.onBeforeSend.addListener((tab, details) => {
  if (details.isPlainText) {
    return undefined;
  }
  const doc = new DOMParser().parseFromString(details.body, "text/html");
  const rendered = doc.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`);
  if (rendered.length === 0) {
    return undefined;
  }
  unsentBodies.set(tab.id, details.body);
  rendered.forEach((element) => element.replaceWith(...element.childNodes));
  const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) + "\n" : "";
  return { details: { body: doctype + doc.documentElement.outerHTML } };
});

// After a failed send the window stays open: give it its sources back, so the
// toggle still works. Thunderbird 160 reports a refused SMTP connection with no
// error field, only a null headerMessageId.
messenger.compose.onAfterSend.addListener((tab, sendInfo) => {
  const body = unsentBodies.get(tab.id);
  unsentBodies.delete(tab.id);
  const failed = Boolean(sendInfo.error) || !sendInfo.headerMessageId;
  if (failed && body !== undefined) {
    return messenger.compose.setComposeDetails(tab.id, { body }).catch((error) => {
      console.error("Markdown Paste:", error);
    });
  }
  return undefined;
});

messenger.tabs.onRemoved.addListener((tabId) => unsentBodies.delete(tabId));
