import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckCircledIcon, ExclamationTriangleIcon, GearIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { DescribeOpsApi } from "./backend-api";
import { loadSettings, saveSettings } from "./storage";
import type { ExtensionSettings, HealthResponse } from "../types";
import "./styles.css";

function Popup() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [status, setStatus] = useState("Checking backend connection.");
  const [busy, setBusy] = useState(true);

  const api = useMemo(() => (settings ? new DescribeOpsApi(settings) : null), [settings]);

  useEffect(() => {
    let alive = true;
    loadSettings()
      .then(async (loaded) => {
        if (!alive) return;
        setSettings(loaded);
        try {
          const result = await new DescribeOpsApi(loaded).health();
          if (!alive) return;
          setHealth(result);
          setStatus(result.qwen_configured ? "Backend is ready for Qwen analysis." : "Backend is reachable; Qwen key is not configured.");
        } catch (error) {
          if (!alive) return;
          setStatus(`Backend is not reachable. ${String(error)}`);
        }
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function openPanel() {
    setStatus("Opening DescribeOps side panel.");
    await chrome.runtime.sendMessage({ name: "OPEN_SIDE_PANEL" });
  }

  async function updateApiBaseUrl(value: string) {
    if (!settings) return;
    const saved = await saveSettings({ ...settings, apiBaseUrl: value });
    setSettings(saved);
    setHealth(null);
  }

  async function recheck() {
    if (!api) return;
    setBusy(true);
    try {
      const result = await api.health();
      setHealth(result);
      setStatus(result.qwen_configured ? "Backend is ready for Qwen analysis." : "Backend is reachable; Qwen key is not configured.");
    } catch (error) {
      setHealth(null);
      setStatus(`Backend is not reachable. ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="popup-shell" aria-labelledby="popup-title">
      <section className="popup-hero">
        <div>
          <p className="eyebrow">Browser layer</p>
          <h1 id="popup-title">DescribeOps</h1>
        </div>
        <StatusGlyph healthy={Boolean(health?.ok)} busy={busy} />
      </section>

      <p className="status-line" role="status" aria-live="polite">{status}</p>

      <label className="field">
        <span>Backend URL</span>
        <input
          type="url"
          value={settings?.apiBaseUrl ?? ""}
          onChange={(event) => void updateApiBaseUrl(event.currentTarget.value)}
          placeholder="http://127.0.0.1:8000"
        />
        <small>Used for session creation, chunk upload, reviewer corrections, and document reads.</small>
      </label>

      <div className="popup-actions">
        <button type="button" className="button primary" onClick={openPanel}>
          <OpenInNewWindowIcon aria-hidden="true" />
          Open panel
        </button>
        <button type="button" className="button subtle" onClick={recheck} disabled={busy || !api}>
          <GearIcon aria-hidden="true" />
          Check
        </button>
      </div>
    </main>
  );
}

function StatusGlyph({ healthy, busy }: { healthy: boolean; busy: boolean }) {
  if (busy) return <span className="glyph pending" aria-label="Checking backend"><GearIcon /></span>;
  if (healthy) return <span className="glyph good" aria-label="Backend reachable"><CheckCircledIcon /></span>;
  return <span className="glyph bad" aria-label="Backend unreachable"><ExclamationTriangleIcon /></span>;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>
);
