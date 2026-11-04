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
