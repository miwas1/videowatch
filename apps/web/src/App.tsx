import { useEffect, useState } from "react";
import { HomePage } from "@/pages/HomePage";
import { ProcessingPage } from "@/pages/ProcessingPage";
import { ReviewPage } from "@/pages/ReviewPage";

import { parseRoute, routeHash, type AppRoute } from "@/lib/routes";

export function App() {
  const [view, setView] = useState<AppRoute>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const syncRoute = () => setView(parseRoute(window.location.hash));
    window.addEventListener("hashchange", syncRoute);
    if (!window.location.hash) window.location.hash = routeHash({ name: "home" });
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  function navigate(route: AppRoute) {
    const nextHash = routeHash(route);
    if (window.location.hash === nextHash) setView(route);
    else window.location.hash = nextHash;
  }

  function startSession(sessionId: string, workflowTemplate: string) {
    navigate({ name: "processing", sessionId, workflowTemplate });
  }

  if (view.name === "home") {
    return <HomePage onSessionStarted={startSession} onOpenSession={(sessionId, workflowTemplate, destination) => navigate({ name: destination, sessionId, workflowTemplate })} />;
  }

  if (view.name === "processing") {
    return (
      <ProcessingPage
        sessionId={view.sessionId}
        workflowTemplate={view.workflowTemplate}
        onReady={() => navigate({ name: "review", sessionId: view.sessionId, workflowTemplate: view.workflowTemplate })}
        onBack={() => navigate({ name: "home" })}
      />
    );
  }

  return (
    <ReviewPage
      sessionId={view.sessionId}
      workflowTemplate={view.workflowTemplate}
      onBack={() => navigate({ name: "home" })}
    />
  );
}
