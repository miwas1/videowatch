export type AppRoute =
  | { name: "home" }
  | { name: "processing"; sessionId: string; workflowTemplate: string }
  | { name: "review"; sessionId: string; workflowTemplate: string };

export function parseRoute(hash: string): AppRoute {
  const raw = hash.replace(/^#/, "") || "/";
  const [pathname, query = ""] = raw.split("?", 2);
  const match = pathname.match(/^\/jobs\/([^/]+)\/(processing|review)$/);
  if (!match) return { name: "home" };
  const workflowTemplate = new URLSearchParams(query).get("template") || "reading_document";
  return {
    name: match[2] as "processing" | "review",
    sessionId: decodeURIComponent(match[1]),
    workflowTemplate,
  };
}

export function routeHash(route: AppRoute): string {
  if (route.name === "home") return "#/";
  const query = new URLSearchParams({ template: route.workflowTemplate });
  return `#/jobs/${encodeURIComponent(route.sessionId)}/${route.name}?${query.toString()}`;
}
