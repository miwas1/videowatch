import { createEvent, DescribeOpsEventSchema } from "@describeops/shared";

const NATIVE_HOST = "com.describeops.native";

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

async function scanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }

  const request = createEvent("PAGE_SCAN_REQUESTED", { tabId: tab.id });
  const response = await chrome.tabs.sendMessage(tab.id, request, { frameId: 0 });
  return DescribeOpsEventSchema.parse(response);
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
