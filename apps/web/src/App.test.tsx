import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api, storeAuth } from "@/api/client";

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.location.hash = "#/";
  });

  it("shows the landing page after validating a stored session", async () => {
    storeAuth({
      token: "test-token",
      user: { id: 1, email: "reader@example.com" },
    });
    vi.spyOn(api, "me").mockResolvedValue({ id: 1, email: "reader@example.com" });
    vi.spyOn(api, "health").mockResolvedValue({
      ok: true,
      service: "describeops-backend",
      qwen_configured: true,
      visual_model: "qwen3.6-flash",
      text_model: "qwen3.6-flash",
      final_model: "qwen3.7-max",
      deployment: "test",
    });
    vi.spyOn(api, "listSessions").mockResolvedValue([]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Make every frame/i })).toBeTruthy();
    });
  });

  it("shows the landing page after signup without crashing", async () => {
    vi.spyOn(api, "register").mockResolvedValue({
      token: "new-token",
      user: { id: 2, email: "new@example.com" },
    });
    vi.spyOn(api, "health").mockResolvedValue({
      ok: true,
      service: "describeops-backend",
      qwen_configured: true,
      visual_model: "qwen3.6-flash",
      text_model: "qwen3.6-flash",
      final_model: "qwen3.7-max",
      deployment: "test",
    });
    vi.spyOn(api, "listSessions").mockResolvedValue([]);

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Need an account? Create one" }));
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "password123");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Make every frame/i })).toBeTruthy();
    });
  });

  it("shows the extension guide route after validating a stored session", async () => {
    window.location.hash = "#/extension-guide";
    storeAuth({
      token: "test-token",
      user: { id: 1, email: "reader@example.com" },
    });
    vi.spyOn(api, "me").mockResolvedValue({ id: 1, email: "reader@example.com" });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Install, connect,/i })).toBeTruthy();
    });
    expect(screen.getAllByRole("link", { name: /Download extension/i }).length).toBeGreaterThan(0);
  });
});
