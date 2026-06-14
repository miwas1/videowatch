import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function Popup() {
  const [status, setStatus] = useState("Open the side panel to detect the current video.");

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
      <p className="muted">Audio descriptions for videos already playing in your browser.</p>
      <button type="button" onClick={openPanel} aria-label="Open DescribeOps side panel">
        Open video assistant
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
