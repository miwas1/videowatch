import { useState } from "react";
import { ArrowRightIcon } from "@radix-ui/react-icons";
import { api, storeAuth } from "@/api/client";
import type { AuthUser } from "@/api/types";

type Props = {
  onAuthenticated: (user: AuthUser) => void;
};

export function AuthPage({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const auth = mode === "login"
        ? await api.login(email.trim(), password)
        : await api.register(email.trim(), password);
      storeAuth(auth);
      onAuthenticated(auth.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <a className="site-header__brand auth-panel__brand" href="#home" aria-label="DescribeOps home">
          Describe<span>Ops</span>
        </a>
        <p className="section-kicker">Private workspace</p>
        <h1>{mode === "login" ? "Sign in to continue." : "Create your workspace."}</h1>
        <p className="auth-panel__copy">Your jobs, uploads, exports, and captured video work stay attached to your account.</p>

        <form className="auth-form" noValidate onSubmit={(e) => void submit(e)}>
          <label>
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
          <div className="auth-form__field">
            <label htmlFor="auth-password">
              <span>Password</span>
              <input
                id="auth-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={8}
                aria-describedby={mode === "register" ? "pw-hint" : undefined}
              />
            </label>
            {mode === "register" && (
              <span id="pw-hint" className="auth-form__hint">
                Minimum 8 characters
              </span>
            )}
          </div>
          <button className="btn btn--primary" type="submit" disabled={submitting || !email.trim() || password.length < 8}>
            {submitting ? "Working…" : mode === "login" ? <>Sign in <ArrowRightIcon aria-hidden="true" /></> : <>Create account <ArrowRightIcon aria-hidden="true" /></>}
          </button>
          {error && <p className="auth-form__error" role="alert">{error}</p>}
        </form>

        <button className="auth-panel__switch" type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}>
          {mode === "login" ? "Need an account? Create one" : "Already have an account? Sign in"}
        </button>
      </section>
    </main>
  );
}
