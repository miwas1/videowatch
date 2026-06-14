import { createEvent, DescribeOpsEventSchema } from "@describeops/shared";

const NATIVE_HOST = "com.describeops.native";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.name === "PAGE_SCAN_REQUESTED") {
    scanActiveTab().then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        message: "DescribeOps could not scan the active tab.",
        diagnostics: String(error)
      });
    });
    return true;
  }

  if (message?.name === "ACCESSIBILITY_MODE_START_REQUESTED") {
    sendToActiveTab(message).then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        status: "error",
        message: "DescribeOps could not start accessibility mode on the active tab.",
        diagnostics: String(error)
      });
    });
    return true;
  }

  if (message?.name === "ACCESSIBILITY_MODE_STOP_REQUESTED") {
    sendToActiveTab(message).then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        status: "error",
        message: "DescribeOps could not stop accessibility mode on the active tab.",
        diagnostics: String(error)
      });
    });
    return true;
  }

  if (message?.name === "ACCESSIBILITY_DESCRIBE_NOW_REQUESTED") {
    sendToActiveTab(message).then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        status: "error",
        message: "DescribeOps could not ask the active tab for a description.",
        diagnostics: String(error)
      });
    });
    return true;
  }

  if (message?.name === "ACCESSIBILITY_STATUS_REQUESTED") {
    sendToActiveTab(message).then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        status: "inactive",
        message: "DescribeOps could not read the active tab playback state.",
        diagnostics: String(error)
      });
    });
    return true;
  }

  if (message?.name === "TAB_CAPTURE_START_REQUESTED") {
    startTabCapture(message.targetTabId).then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        status: "error",
        message: "DescribeOps could not start tab capture fallback.",
        diagnostics: String(error)
      });
    });
    return true;
  }

  if (message?.name === "TAB_CAPTURE_STOP_REQUESTED") {
    stopTabCapture().then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        status: "error",
        message: "DescribeOps could not stop tab capture fallback.",
        diagnostics: String(error)
      });
    });
    return true;
  }

  if (message?.name === "NATIVE_HEALTH_REQUESTED") {
    requestNativeHealth().then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        message: "DescribeOps native companion is not connected.",
        diagnostics: String(error)
      });
    });
    return true;
  }

  if (message?.name === "NATIVE_ACTION_REQUESTED") {
    requestNativeAction(message.method, message.params).then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        status: "error",
        message: "DescribeOps native companion could not complete that action.",
        diagnostics: String(error)
      });
    });
    return true;
  }

  return false;
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "describe-current-state") {
    sendToActiveTab({ name: "ACCESSIBILITY_DESCRIBE_NOW_REQUESTED" }).catch(() => undefined);
  }
});

async function scanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }

  const request = createEvent("PAGE_SCAN_REQUESTED", { tabId: tab.id });
  const response = await chrome.tabs.sendMessage(tab.id, request, { frameId: 0 });
  return DescribeOpsEventSchema.parse(response);
}

async function sendToActiveTab(message: unknown) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }

  return chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
}

async function startTabCapture(targetTabId?: unknown) {
  const tabId = typeof targetTabId === "number" ? targetTabId : await activeTabId();

  if (!chrome.tabCapture?.getMediaStreamId) {
    return {
      ok: false,
      status: "unsupported",
      message: "This Chromium build does not expose tab capture to extensions."
    };
  }

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const summary = await chrome.runtime.sendMessage({
    name: "OFFSCREEN_CAPTURE_START_REQUESTED",
    streamId,
    durationMs: 2500,
    sampleEveryMs: 500
  });

  return {
    ...summary,
    mode: "tab_capture",
    tabId,
    message: summary?.message ?? "Tab capture fallback sampled the active tab."
  };
}

async function stopTabCapture() {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ name: "OFFSCREEN_CAPTURE_STOP_REQUESTED" });
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }
  return tab.id;
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const runtimeWithContexts = chrome.runtime as typeof chrome.runtime & {
    getContexts?: (filter: { contextTypes: string[]; documentUrls?: string[] }) => Promise<Array<{ documentUrl?: string }>>;
  };

  if (runtimeWithContexts.getContexts) {
    const contexts = await runtimeWithContexts.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) {
      return;
    }
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA"] as chrome.offscreen.Reason[],
      justification: "Redeem a user-authorized tabCapture stream so DescribeOps can sample protected video players."
    });
  } catch (error) {
    if (!String(error).includes("Only a single offscreen document")) {
      throw error;
    }
  }
}

async function requestNativeHealth() {
  const response = await sendNativeRequest("health", {});

  if (response?.ok && response?.result) {
    return response.result;
  }

  return {
    ok: false,
    status: "error",
    message: response?.error?.message ?? "DescribeOps native companion returned an unexpected response.",
    diagnostics: response?.error?.diagnostics
  };
}

async function requestNativeAction(method: unknown, params: unknown) {
  if (typeof method !== "string" || !method.trim()) {
    return {
      ok: false,
      status: "error",
      message: "DescribeOps received an invalid native action."
    };
  }

  const response = await sendNativeRequest(method, params ?? {});
  if (response?.ok && response?.result) {
    return response.result;
  }

  return {
    ok: false,
    status: "error",
    message: response?.error?.message ?? "DescribeOps native companion returned an unexpected response.",
    diagnostics: response?.error?.diagnostics
  };
}

async function sendNativeRequest(method: string, params: unknown) {
  return chrome.runtime.sendNativeMessage(NATIVE_HOST, {
    id: crypto.randomUUID(),
    method,
    params
  });
}
