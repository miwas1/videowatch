import { describe, expect, it } from "vitest";
import { parseRoute, routeHash } from "./routes";

describe("app routes", () => {
  it("round-trips processing and review routes", () => {
    const routes = [
      { name: "processing" as const, sessionId: "session one", workflowTemplate: "course_notes" },
      { name: "review" as const, sessionId: "session-two", workflowTemplate: "audio_description" },
    ];
    for (const route of routes) expect(parseRoute(routeHash(route))).toEqual(route);
  });

  it("round-trips the extension guide route", () => {
    expect(parseRoute(routeHash({ name: "extensionGuide" }))).toEqual({ name: "extensionGuide" });
  });

  it("falls back to home for unknown hashes", () => {
    expect(parseRoute("#/unknown")).toEqual({ name: "home" });
  });
});
