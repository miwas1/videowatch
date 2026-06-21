chrome.runtime.onInstalled.addListener(() => {
  const sidePanel = (chrome as typeof chrome & { sidePanel?: { setPanelBehavior: (options: { openPanelOnActionClick: boolean }) => Promise<void> } }).sidePanel;
  sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.name === "OPEN_SIDE_PANEL") {
    openSidePanel().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, message: "Could not open the side panel.", diagnostics: String(error) });
    });
    return true;
  }

  if (message?.name === "CAPTURE_TAB_SCREENSHOT") {
    captureVisibleTab()
      .then((dataUrl) => sendResponse({ ok: true, payload: { dataUrl } }))
      .catch((error) => sendResponse({ ok: false, message: "Tab capture failed.", diagnostics: String(error) }));
    return true;
  }

  if (
    message?.name === "PAGE_SCAN_REQUESTED" ||
    message?.name === "CAPTURE_FRAME_REQUESTED" ||
    message?.name === "CAPTURE_MULTI_FRAMES_REQUESTED" ||
    message?.name === "DESCRIPTIONS_ATTACH_REQUESTED" ||
    message?.name === "DESCRIPTIONS_STOP_REQUESTED" ||
    message?.name === "DESCRIBE_NOW_REQUESTED"
  ) {
    sendToActiveTab(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, message: "DescribeOps could not reach the active tab.", diagnostics: String(error) });
    });
    return true;
  }

  return false;
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "describe-current-state") {
    sendToActiveTab({ name: "DESCRIBE_NOW_REQUESTED" }).catch(() => undefined);
  }
});

async function openSidePanel(): Promise<{ ok: true }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sidePanel = (chrome as typeof chrome & { sidePanel?: { open: (options: { windowId: number }) => Promise<void> } }).sidePanel;
  if (tab?.windowId && sidePanel?.open) {
    await sidePanel.open({ windowId: tab.windowId });
  }
  return { ok: true };
}

async function sendToActiveTab(message: unknown): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }
  assertScannableTab(tab);

  try {
    return await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ["content-script.js"]
    });
    return chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  }
}

async function captureVisibleTab(): Promise<string> {
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined as unknown as number, { format: "jpeg", quality: 80 });
  return dataUrl;
}

function assertScannableTab(tab: chrome.tabs.Tab): void {
  const url = tab.url ?? "";
  if (/^(chrome|edge|brave|vivaldi|opera|about):/i.test(url)) {
    throw new Error("Browser internal pages cannot be scanned.");
  }
  if (url.startsWith("chrome-extension://")) {
    throw new Error("Extension pages cannot be scanned.");
  }
}
