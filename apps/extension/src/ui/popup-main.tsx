import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function Popup() {
  const [status, setStatus] = useState("Ready to scan the active page.");

  async function openPanel() {
    setStatus("Opening DescribeOps side panel.");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  }

  return (
    <main className="popup" aria-labelledby="popup-title">
      <h1 id="popup-title" className="title">DescribeOps</h1>
      <p className="muted">Qwen-powered accessibility checks for the current page.</p>
      <button type="button" onClick={openPanel} aria-label="Open DescribeOps side panel">
        Open side panel
      </button>
      <div className="status" role="status" aria-live="polite">{status}</div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>
);
