import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, KeyRound, Mail, ShieldCheck, Video } from "lucide-react";
import { api } from "../lib/api.js";
import { useAuth } from "../state/AuthContext.jsx";

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

const authErrorMessage = (err) => {
  if (err.code === "ECONNABORTED") {
    return "Server took too long to respond. If this is Render free hosting, wait a minute for the backend to wake up and try again.";
  }

  if (err.message === "Network Error") {
    return "Could not reach the backend. Check VITE_API_URL on the frontend and CLIENT_URL/CORS on the backend.";
  }

  if (err.response?.data?.message) {
    return err.response.data.message;
  }

  if (err.response?.status) {
    return `Authentication failed. Server returned ${err.response.status}. Check the backend logs on Render.`;
  }

  return err.message || "Authentication failed";
};

export default function AuthPage() {
  const { login, register, googleLogin } = useAuth();
  const googleButtonRef = useRef(null);
  const [mode, setMode] = useState(new URLSearchParams(window.location.search).get("resetToken") ? "reset" : "login");
  const [form, setForm] = useState({
    name: "",
    username: "",
    email: "",
    password: "",
    identifier: "",
    resetToken: new URLSearchParams(window.location.search).get("resetToken") || "",
    newPassword: "",
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (mode !== "login" || !googleClientId || !googleButtonRef.current) return;

    const initializeGoogle = () => {
      if (!window.google?.accounts?.id || !googleButtonRef.current) return;

      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (response) => {
          try {
            setError("");
            await googleLogin(response.credential);
          } catch (err) {
            setError(err.response?.data?.message || "Google login failed");
          }
        },
      });

      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: "outline",
        size: "large",
        width: 320,
        text: "continue_with",
      });
    };

    if (window.google?.accounts?.id) {
      initializeGoogle();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = initializeGoogle;
    document.body.appendChild(script);
  }, [googleLogin, mode]);

  const updateField = (event) => {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");

    try {
      if (mode === "login") {
        await login({ username: form.username, password: form.password });
      }

      if (mode === "register") {
        await register({
          name: form.name.trim(),
          username: form.username.trim(),
          email: form.email.trim() || undefined,
          password: form.password,
        });
      }

      if (mode === "forgot") {
        const { data } = await api.post("/users/forgot-password", { identifier: form.identifier });
        setNotice(
          data.resetToken
            ? `Local reset token: ${data.resetToken}`
            : data.message || "If the account exists, a reset token has been created."
        );
        if (data.resetToken) {
          setForm((current) => ({ ...current, resetToken: data.resetToken }));
          setMode("reset");
        }
      }

      if (mode === "reset") {
        await api.post("/users/reset-password", {
          resetToken: form.resetToken,
          password: form.newPassword,
        });
        setNotice("Password updated. You can login now.");
        setMode("login");
      }
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const title = {
    login: "Welcome back",
    register: "Create your NexaMeet account",
    forgot: "Recover your password",
    reset: "Set a new password",
  }[mode];
  const feedbackMessage = error || notice;
  const feedbackClassName = error ? "error-text" : "success-text";

  return (
    <main className="auth-shell nexameet-auth">
      <section className="auth-brand">
        <img className="brand-logo-xl" src="/nexameet-logo.png" alt="NexaMeet logo" />
        <h1>NexaMeet</h1>
        <p>Premium video meetings with scheduling, chat, summaries, reactions, captions, and simple invite sharing.</p>
        <div className="auth-feature-strip">
          <span>
            <Video size={18} /> HD meetings
          </span>
          <span>
            <ShieldCheck size={18} /> Secure rooms
          </span>
          <span>
            <Mail size={18} /> Fast invites
          </span>
        </div>
      </section>

      <form className="auth-panel auth-panel-pro" onSubmit={submit}>
        <div className="auth-card-header">
          <img src="/nexameet-logo.png" alt="" />
          <div>
            <p className="eyebrow">NexaMeet account</p>
            <h2>{title}</h2>
          </div>
        </div>

        {(mode === "login" || mode === "register") && (
          <div className="segmented">
            <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
              Login
            </button>
            <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
              Register
            </button>
          </div>
        )}

        {mode === "register" && (
          <>
            <label>
              Name
              <input name="name" value={form.name} onChange={updateField} autoComplete="name" required />
            </label>
            <label>
              Email
              <input name="email" value={form.email} onChange={updateField} autoComplete="email" type="email" />
            </label>
          </>
        )}

        {(mode === "login" || mode === "register") && (
          <>
            <label>
              Username
              <input name="username" value={form.username} onChange={updateField} autoComplete="username" required />
            </label>
            <label>
              Password
              <input
                name="password"
                value={form.password}
                onChange={updateField}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                type="password"
                minLength={6}
                required
              />
            </label>
          </>
        )}

        {mode === "forgot" && (
          <label>
            Username or email
            <input name="identifier" value={form.identifier} onChange={updateField} autoComplete="username" required />
          </label>
        )}

        {mode === "reset" && (
          <>
            <label>
              Reset token
              <input name="resetToken" value={form.resetToken} onChange={updateField} required />
            </label>
            <label>
              New password
              <input name="newPassword" value={form.newPassword} onChange={updateField} type="password" minLength={6} required />
            </label>
          </>
        )}

        <div className="feedback-slot">
          <p
            className={`${feedbackClassName} feedback-message ${feedbackMessage ? "" : "is-empty"}`}
            role={feedbackMessage ? "alert" : undefined}
            aria-hidden={feedbackMessage ? undefined : "true"}
          >
            {feedbackMessage || "Status"}
          </p>
        </div>

        <button className="primary-button" type="submit" disabled={loading}>
          {loading ? "Please wait..." : mode === "forgot" ? "Get reset token" : mode === "reset" ? "Update password" : mode === "login" ? "Login" : "Create account"}
        </button>

        {mode === "login" && (
          <>
            <button className="link-button" type="button" onClick={() => setMode("forgot")}>
              <KeyRound size={16} /> Forgot password?
            </button>
            <div className="auth-divider">or</div>
            {googleClientId ? (
              <div className="google-button-wrap" ref={googleButtonRef} />
            ) : (
              <button className="secondary-button" type="button" onClick={() => setError("Add VITE_GOOGLE_CLIENT_ID in frontend/.env and GOOGLE_CLIENT_ID in backend/.env to enable Google login.")}>
                Continue with Google
              </button>
            )}
          </>
        )}

        {(mode === "forgot" || mode === "reset") && (
          <button className="link-button" type="button" onClick={() => setMode("login")}>
            <ArrowLeft size={16} /> Back to login
          </button>
        )}
      </form>
    </main>
  );
}
