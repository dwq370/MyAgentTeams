import { Navigate, NavLink, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { api, setToken, token, User } from "./api";
import { LoginPage, RegisterPage } from "./AuthPages";
import { EnginesPage } from "./EnginesPage";
import { ProjectPage } from "./ProjectPage";
import { ProjectsPage } from "./ProjectsPage";
import { RolesPage } from "./RolesPage";
import { TeamEntryPage } from "./TeamEntryPage";
import { TeamMonitorPage } from "./TeamMonitorPage";
import { TeamPage } from "./TeamPage";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!token()) {
      setReady(true);
      return;
    }
    api<User>("/api/auth/me")
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  if (!ready) return <main className="auth">加载中</main>;

  return (
    <Routes>
      <Route path="/login" element={<LoginPage onUser={setUser} />} />
      <Route path="/register" element={<RegisterPage onUser={setUser} />} />
      <Route element={user ? <Shell user={user} onLogout={() => { setToken(null); setUser(null); }} /> : <Navigate to="/login" replace />}>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/engines" element={<EnginesPage />} />
        <Route path="/roles" element={<RolesPage />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/projects/:projectId/teams/:teamId/monitor" element={<TeamMonitorPage />} />
        <Route path="/projects/:projectId/teams/:teamId/entry" element={<TeamEntryPage />} />
        <Route path="/projects/:projectId/teams/:teamId" element={<TeamPage />} />
      </Route>
    </Routes>
  );
}

function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(() => localStorage.getItem("agentteam.nav") !== "hidden");

  function toggleNav() {
    setNavOpen((current) => {
      const next = !current;
      localStorage.setItem("agentteam.nav", next ? "open" : "hidden");
      return next;
    });
  }

  return (
    <div className={navOpen ? "app" : "app nav-collapsed"}>
      {navOpen && (
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="brand">AgentTeam<span>人和 Agent 一起交付</span></div>
            <button className="side-button" type="button" onClick={toggleNav}>收起</button>
          </div>
          <nav>
            <NavLink className="side-link" to="/" end>项目</NavLink>
            <NavLink className="side-link" to="/engines">Agent引擎</NavLink>
            <NavLink className="side-link" to="/roles">角色</NavLink>
          </nav>
          <div className="muted">{user.name}</div>
          <button className="side-button" onClick={() => { onLogout(); navigate("/login"); }}>退出</button>
        </aside>
      )}
      <main className={navOpen ? "main" : "main nav-collapsed-main"}>
        {!navOpen && <button className="btn nav-open-button" type="button" onClick={toggleNav}>导航</button>}
        <Outlet />
      </main>
    </div>
  );
}
