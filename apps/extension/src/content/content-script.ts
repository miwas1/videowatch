import { scanDocument } from "./detector";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.name !== "PAGE_SCAN_REQUESTED") {
    return false;
  }

  if (window.top !== window) {
    sendResponse({
      ok: false,
      message: "DescribeOps scans the top page frame only."
    });
    return true;
  }

  const event = {
    id: crypto.randomUUID(),
    name: "PAGE_SCAN_COMPLETED",
    createdAt: new Date().toISOString(),
    payload: scanDocument(document)
  };
  sendResponse(event);
  return true;
});
