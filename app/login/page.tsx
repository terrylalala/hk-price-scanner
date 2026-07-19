"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * The unlock screen for the shared-password gate.
 *
 * Says "shared password", not "sign in": there are no accounts, everyone who
 * enters it shares one history, and implying otherwise would be a lie the app
 * cannot keep.
 */

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Could not unlock.");
        return;
      }
      // replace(), not push(): the login screen should not sit in history for
      // the back button to land on once you are already through it.
      const next = params.get("next");
      router.replace(next && next.startsWith("/") ? next : "/");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="masthead">
        <h1>Price Scanner</h1>
        <p>Enter the shared password to continue</p>
      </header>

      <form className="card" onSubmit={submit}>
        {error && (
          <div className="error" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            disabled={busy}
          />
        </label>

        <button className="btn block" type="submit" disabled={busy || !password}>
          {busy ? "Checking…" : "Unlock"}
        </button>

        <p className="note" style={{ marginTop: 12 }}>
          Everyone using this password shares the same scan history and the same
          daily search limit.
        </p>
      </form>
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary to prerender.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
