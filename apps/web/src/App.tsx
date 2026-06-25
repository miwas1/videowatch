import { useEffect, useState } from "react";
import { AuthPage } from "@/pages/AuthPage";
import { HomePage } from "@/pages/HomePage";
import { ProcessingPage } from "@/pages/ProcessingPage";
import { ReviewPage } from "@/pages/ReviewPage";
import { api, clearStoredAuth, readStoredUser } from "@/api/client";
import type { AuthUser } from "@/api/types";

import { parseRoute, routeHash, type AppRoute } from "@/lib/routes";

export function App() {
  const [view, setView] = useState<AppRoute>(() => parseRoute(window.location.hash));
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser());
  const [checkingAuth, setCheckingAuth] = useState(Boolean(readStoredUser()));

  useEffect(() => {
    const syncRoute = () => setView(parseRoute(window.location.hash));
    window.addEventListener("hashchange", syncRoute);
    if (!window.location.hash) window.location.hash = routeHash({ name: "home" });
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  useEffect(() => {
    if (!user) {
      setCheckingAuth(false);
      return;
    }
    api.me()
      .then(setUser)
      .catch(() => {
        clearStoredAuth();
        setUser(null);
      })
      .finally(() => setCheckingAuth(false));
  }, []);

  function navigate(route: AppRoute) {
    const nextHash = routeHash(route);
    if (window.location.hash === nextHash) setView(route);
    else window.location.hash = nextHash;
  }

  function startSession(sessionId: string, workflowTemplate: string) {
    navigate({ name: "processing", sessionId, workflowTemplate });
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      // Local logout should still clear the browser token if the server token is already invalid.
    }
    clearStoredAuth();
    setUser(null);
    navigate({ name: "home" });
  }

  if (checkingAuth) {
    return <main className="auth-page"><section className="auth-panel"><p className="section-kicker">Checking session</p><h1>Loading workspace.</h1></section></main>;
  }

  if (!user) {
    return <AuthPage onAuthenticated={setUser} />;
  }

  useEffect(() => {
    const titles: Record<string, string> = { home: "DescribeOps", processing: "Processing — DescribeOps", review: "Review — DescribeOps" };
    document.title = titles[view.name] ?? "DescribeOps";
  }, [view.name]);

  if (view.name === "home") {
    return <HomePage currentUser={user} onLogout={() => void logout()} onSessionStarted={startSession} onOpenSession={(sessionId, workflowTemplate, destination) => navigate({ name: destination, sessionId, workflowTemplate })} />;
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
