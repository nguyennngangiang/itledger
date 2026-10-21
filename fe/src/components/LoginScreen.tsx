// The one shared admin login (be/auth.py) — no user table, no "forgot
// password" flow, no per-person accounts. Shown in place of the whole app
// shell whenever there is no valid session token (see App.tsx).
import { useState } from "react";
import { Button, Input } from "antd";
import { login } from "../api/auth";
import { setToken } from "../lib/authToken";
import { useT } from "../i18n/useT";
import { LogoMark } from "./icons";

export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!username || !password || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { token } = await login(username, password);
      setToken(token);
      onSuccess();
    } catch {
      // Deliberately not "wrong username" vs "wrong password" — see be/auth.py.
      setError(t("login.error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="login-brand">
          <LogoMark size={28} />
          <span>{t("app.name")}</span>
        </div>
        <p className="login-subtitle">{t("login.subtitle")}</p>

        <label className="login-label" htmlFor="login-username">
          {t("login.username")}
        </label>
        <Input
          id="login-username"
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label className="login-label" htmlFor="login-password">
          {t("login.password")}
        </label>
        <Input.Password
          id="login-password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <p className="login-error">{error}</p>}

        <Button type="primary" htmlType="submit" loading={loading} block>
          {t("login.submit")}
        </Button>
      </form>
    </div>
  );
}
