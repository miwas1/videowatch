import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type Health = {
  status: string;
  version: string;
  storagePath: string;
  supportedTools: string[];
  ffmpeg: { available: boolean; remediation?: string };
};

function App() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    invoke<Health>("health").then(setHealth).catch(() => undefined);
  }, []);

  return (
    <main className="app">
      <h1>DescribeOps Companion</h1>
      {health ? (
        <section>
          <p>Status: {health.status}</p>
          <p>Version: {health.version}</p>
          <p>Storage: {health.storagePath}</p>
          <p>Tools: {health.supportedTools.join(", ")}</p>
          <p>FFmpeg: {health.ffmpeg.available ? "available" : health.ffmpeg.remediation}</p>
        </section>
      ) : (
        <p>Loading companion status.</p>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
