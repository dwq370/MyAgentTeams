import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorText, Project } from "./api";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [editing, setEditing] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setProjects(await api<Project[]>("/api/projects"));
  }

  useEffect(() => {
    load().catch((reason) => setError(errorText(reason)));
  }, []);

  function beginCreate() {
    setCreating(true);
    setEditing(null);
    setName("");
    setDescription("");
    setError("");
  }

  function beginEdit(project: Project) {
    setCreating(false);
    setEditing(project);
    setName(project.name);
    setDescription(project.description);
    setError("");
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
    setName("");
    setDescription("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      if (editing) {
        await api(`/api/projects/${editing.id}`, { method: "PATCH", body: JSON.stringify({ name, description }) });
      } else {
        await api("/api/projects", { method: "POST", body: JSON.stringify({ name, description }) });
      }
      closeForm();
      await load();
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function remove(project: Project) {
    if (!confirm(`删除项目 ${project.name}？`)) return;
    setError("");
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      if (editing?.id === project.id) closeForm();
      await load();
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  return (
    <div className="stack">
      <div className="toprow">
        <h1>项目</h1>
        <button className="btn primary" onClick={beginCreate}>新建项目</button>
      </div>
      {error && !creating && !editing && <div className="alert">{error}</div>}
      <div className="list">
        {projects.map((project) => (
          <article key={project.id} className="card project-row">
            <Link className="project-main" to={`/projects/${project.id}`}>
              <strong>{project.name}</strong>
              <div className="muted">{project.description || "暂无说明"}</div>
            </Link>
            <div className="row">
              <span className="pill">{roleLabel(project.projectRole)}</span>
              <button className="btn" onClick={() => beginEdit(project)}>编辑</button>
              <button className="btn danger" onClick={() => remove(project)}>删除</button>
            </div>
          </article>
        ))}
        {projects.length === 0 && <div className="card muted">还没有项目。</div>}
      </div>
      {(creating || editing) && (
        <form className="card form" onSubmit={save}>
          <h2>{editing ? `编辑 ${editing.name}` : "新建项目"}</h2>
          <label>名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label>说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          {error && <div className="alert">{error}</div>}
          <div className="row">
            <button className="btn primary">{editing ? "保存" : "创建"}</button>
            <button className="btn" type="button" onClick={closeForm}>取消</button>
          </div>
        </form>
      )}
    </div>
  );
}

export function roleLabel(role: string) {
  if (role === "owner") return "所有者";
  if (role === "admin") return "管理员";
  return "成员";
}
