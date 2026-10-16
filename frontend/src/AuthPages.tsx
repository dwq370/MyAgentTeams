import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, errorText, setToken, User } from "./api";

export function LoginPage({ onUser }: { onUser: (user: User) => void }) {
  return <AuthForm mode="login" onUser={onUser} />;
}

export function RegisterPage({ onUser }: { onUser: (user: User) => void }) {
  return <AuthForm mode="register" onUser={onUser} />;
}

function AuthForm({ mode, onUser }: { mode: "login" | "register"; onUser: (user: User) => void }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = mode === "login" ? { email, password } : { email, password, name };
      const result = await api<{ accessToken: string; user: User }>(path, { method: "POST", body: JSON.stringify(body) });
      setToken(result.accessToken);
      onUser(result.user);
      navigate("/");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth">
      <form className="card form" onSubmit={submit}>
        <div>
          <h1>{mode === "login" ? "登录" : "注册"}</h1>
          <p className="muted">先进入项目，再组建包含人和 Agent 的 Team。</p>
        </div>
        {mode === "register" && (
          <label>
            姓名
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
        )}
        <label>
          邮箱
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label>
          密码
          <input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        {error && <div className="alert">{error}</div>}
        <button className="btn primary" disabled={pending}>{pending ? "提交中" : "继续"}</button>
        {mode === "login" ? <Link to="/register">注册账号</Link> : <Link to="/login">已有账号</Link>}
      </form>
    </main>
  );
}
