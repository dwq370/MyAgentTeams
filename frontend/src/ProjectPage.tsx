import { FormEvent, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  AgentEngineItem,
  api,
  errorText,
  Project,
  ReleaseItem,
  ServiceItem,
  TeamItem,
  KubernetesProbe,
  SshProbeResult,
  TestEnvironment,
  VersionItem,
  VERSION_LABELS,
} from "./api";
import { roleLabel } from "./ProjectsPage";

export const PROJECT_SECTIONS = [
  { id: "overview", label: "概览" },
  { id: "environments", label: "测试环境" },
  { id: "teams", label: "Team" },
  { id: "members", label: "成员" },
  { id: "engine", label: "选用引擎" },
  { id: "releases", label: "系统版本" },
] as const;

export type ProjectSection = (typeof PROJECT_SECTIONS)[number]["id"];

function parseSection(value: string | null): ProjectSection {
  return PROJECT_SECTIONS.some((section) => section.id === value) ? (value as ProjectSection) : "overview";
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const section = parseSection(params.get("section"));
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");

  function openSection(next: ProjectSection) {
    setParams(next === "overview" ? {} : { section: next });
  }

  async function load() {
    setProject(await api<Project>(`/api/projects/${projectId}`));
  }

  useEffect(() => {
    if (section !== "overview" && project) return;
    load().catch((reason) => setError(errorText(reason)));
  }, [projectId, section]);

  if (!project) return <p>{error || "加载项目"}</p>;
  const manager = project.projectRole !== "member";
  const owner = project.projectRole === "owner";

  return (
    <div>
      <div className="toprow">
        <div>
          <h1>{project.name}</h1>
          <p className="muted">{project.description || "暂无说明"} · {roleLabel(project.projectRole)}</p>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="tabs">
        {PROJECT_SECTIONS.map((item) => (
          <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => openSection(item.id)}>{item.label}</button>
        ))}
      </div>
      {section === "overview" && <Overview project={project} onOpen={openSection} />}
      {section === "environments" && <Environments projectId={projectId} manager={manager} />}
      {section === "teams" && <Teams projectId={projectId} manager={manager} />}
      {section === "members" && <People projectId={projectId} manager={manager} />}
      {section === "engine" && <EngineChoice project={project} projectId={projectId} owner={owner} onSaved={load} />}
      {section === "releases" && <Releases projectId={projectId} />}
    </div>
  );
}

function Overview({ project, onOpen }: { project: Project; onOpen: (section: ProjectSection) => void }) {
  const steps: { done: boolean; label: string; section: ProjectSection; action: string }[] = [
    { done: Boolean(project.agentEngine), label: "选择 Agent 引擎", section: "engine", action: "去选择" },
    { done: (project.counts?.environments ?? 0) > 0, label: "配置测试环境", section: "environments", action: "去配置" },
    { done: (project.counts?.teams ?? 0) > 0, label: "创建 Team 并圈定工作区", section: "teams", action: "去创建" },
  ];
  return (
    <div className="card stack">
      {steps.map((step) => (
        <div className="step-row" key={step.label}>
          <div><span className={step.done ? "pill good" : "pill wait"}>{step.done ? "已完成" : "待做"}</span> {step.label}</div>
          <button className="btn" onClick={() => onOpen(step.section)}>{step.done ? "查看" : step.action}</button>
        </div>
      ))}
    </div>
  );
}

function environmentSummary(item: TestEnvironment) {
  if (item.kind === "kubernetes") {
    const version = item.connectionInfo?.kind === "kubernetes" ? item.connectionInfo.kubernetesVersion : "";
    return `Kubernetes · ${item.kubeContext ?? ""} · ${item.clusterServer ?? ""} ${version}`.trim();
  }
  return `单机 · ${item.sshUsername ?? ""}@${item.sshHost ?? ""}:${item.sshPort ?? 22}`;
}

function Environments({ projectId, manager }: { projectId: string; manager: boolean }) {
  const [items, setItems] = useState<TestEnvironment[]>([]);
  const [editing, setEditing] = useState<TestEnvironment | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"standalone" | "kubernetes">("standalone");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [kubeContext, setKubeContext] = useState("");
  const [kubeProbe, setKubeProbe] = useState<KubernetesProbe | null>(null);
  const [sshProbe, setSshProbe] = useState<SshProbeResult | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setItems(await api<TestEnvironment[]>(`/api/projects/${projectId}/environments`));
  }
  useEffect(() => { load().catch((reason) => setError(errorText(reason))); }, [projectId]);

  function resetConnection() {
    setKubeProbe(null);
    setSshProbe(null);
  }

  function beginEdit(item: TestEnvironment) {
    setEditing(item);
    setName(item.name);
    setKind(item.kind ?? "standalone");
    setSshHost(item.sshHost ?? "");
    setSshPort(String(item.sshPort ?? 22));
    setSshUsername(item.sshUsername ?? "");
    setSshPassword("");
    setKubeContext(item.kubeContext ?? "");
    resetConnection();
    setError("");
  }

  function beginCreate() {
    setEditing(null);
    setName("");
    setKind("standalone");
    setSshHost("");
    setSshPort("22");
    setSshUsername("");
    setSshPassword("");
    setKubeContext("");
    resetConnection();
    setError("");
  }

  function connectionBody() {
    if (kind === "kubernetes") return { kind, kubectlClient: "local" as const, kubeContext: kubeContext || undefined, environmentId: editing?.id };
    return {
      kind,
      sshHost,
      sshPort: Number(sshPort || 22),
      sshUsername,
      sshPassword: sshPassword || undefined,
      environmentId: editing?.id,
    };
  }

  async function probe() {
    setError("");
    resetConnection();
    try {
      const result = await api<KubernetesProbe | SshProbeResult>(`/api/projects/${projectId}/environments/probe`, {
        method: "POST",
        body: JSON.stringify(connectionBody()),
      });
      if (result.kind === "kubernetes") {
        setKubeProbe(result);
        setKubeContext(result.context);
      } else setSshProbe(result);
    } catch (reason) { setError(errorText(reason)); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const body = { name, ...connectionBody() };
      if (editing) await api(`/api/projects/${projectId}/environments/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api(`/api/projects/${projectId}/environments`, { method: "POST", body: JSON.stringify(body) });
      beginCreate();
      await load();
    } catch (reason) { setError(errorText(reason)); }
  }

  async function remove(item: TestEnvironment) {
    if (!confirm(`删除测试环境 ${item.name}？`)) return;
    setError("");
    try {
      await api(`/api/projects/${projectId}/environments/${item.id}`, { method: "DELETE" });
      if (editing?.id === item.id) beginCreate();
      await load();
    } catch (reason) { setError(errorText(reason)); }
  }

  const confirmed = kind === "kubernetes" ? Boolean(kubeProbe) : Boolean(sshProbe);
  return (
    <div className="grid-2">
      <div className="stack">
        {items.map((item) => (
          <article key={item.id} className="card stack">
            <div className="split">
              <div>
                <strong>{item.name}</strong>
                <div className="meta">{environmentSummary(item)}</div>
              </div>
              {manager && (
                <div className="row">
                  <button className="btn" onClick={() => beginEdit(item)}>修改</button>
                  <button className="btn danger" onClick={() => remove(item)}>删除</button>
                </div>
              )}
            </div>
          </article>
        ))}
        {items.length === 0 && <div className="card muted">还没有测试环境。</div>}
      </div>
      {manager && (
        <form className="card form" onSubmit={save}>
          <div className="split">
            <h2>{editing ? `修改 ${editing.name}` : "新建测试环境"}</h2>
            {editing && <button type="button" className="btn" onClick={beginCreate}>改为新建</button>}
          </div>
          <label>名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label>类型
            <select value={kind} onChange={(event) => { setKind(event.target.value as "standalone" | "kubernetes"); resetConnection(); }}>
              <option value="standalone">单机</option>
              <option value="kubernetes">Kubernetes 集群</option>
            </select>
          </label>
          {kind === "kubernetes" ? (
            <>
              <label>kubectl 客户端
                <select value="local" onChange={() => undefined}>
                  <option value="local">本地 kubectl</option>
                </select>
              </label>
              {kubeProbe && kubeProbe.contexts.length > 0 && (
                <label>上下文
                  <select value={kubeContext} onChange={(event) => { setKubeContext(event.target.value); setKubeProbe(null); }}>
                    {kubeProbe.contexts.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
              )}
              <button className="btn" type="button" onClick={() => void probe()}>检查集群</button>
              {kubeProbe && (
                <div className="stack">
                  <strong>请确认集群信息</strong>
                  <p className="meta">上下文 {kubeProbe.context}</p>
                  <p className="meta">集群 {kubeProbe.clusterName}</p>
                  <p className="meta">API {kubeProbe.server}</p>
                  <p className="meta">版本 {kubeProbe.kubernetesVersion}</p>
                  {kubeProbe.nodes.map((node) => <p key={node.name} className="meta">{node.name} · {node.status} · {node.roles}</p>)}
                  {kubeProbe.nodesError && <p className="meta">{kubeProbe.nodesError}</p>}
                </div>
              )}
            </>
          ) : (
            <>
              <label>主机 IP<input value={sshHost} onChange={(event) => { setSshHost(event.target.value); resetConnection(); }} placeholder="192.168.1.10" required /></label>
              <label>端口<input value={sshPort} onChange={(event) => { setSshPort(event.target.value); resetConnection(); }} required /></label>
              <label>登录账号<input value={sshUsername} onChange={(event) => { setSshUsername(event.target.value); resetConnection(); }} required /></label>
              <label>登录密码<input type="password" value={sshPassword} onChange={(event) => { setSshPassword(event.target.value); resetConnection(); }} placeholder={editing?.passwordConfigured ? "留空则不修改" : ""} required={!editing?.passwordConfigured} /></label>
              <button className="btn" type="button" onClick={() => void probe()}>测试连通性</button>
              {sshProbe && (
                <div className="stack">
                  <strong>请确认主机连通性</strong>
                  <p className="meta">{sshProbe.username}@{sshProbe.host}:{sshProbe.port}</p>
                  <p className="meta">主机密钥 {sshProbe.fingerprint}</p>
                  <p className="meta">{sshProbe.output}</p>
                </div>
              )}
            </>
          )}
          {error && <div className="alert">{error}</div>}
          <button className="btn primary" disabled={!confirmed}>确认并保存</button>
        </form>
      )}
    </div>
  );
}

function Teams({ projectId, manager }: { projectId: string; manager: boolean }) {
  const [items, setItems] = useState<TeamItem[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  async function load() { setItems(await api<TeamItem[]>(`/api/projects/${projectId}/teams`)); }
  useEffect(() => { load().catch((reason) => setError(errorText(reason))); }, [projectId]);

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/api/projects/${projectId}/teams`, { method: "POST", body: JSON.stringify({ name, description }) });
      setName(""); setDescription(""); await load();
    } catch (reason) { setError(errorText(reason)); }
  }

  return (
    <div className="grid-2">
      <div className="list">
        {items.map((team) => (
          <Link key={team.id} className="card project-row" to={`/projects/${projectId}/teams/${team.id}`}>
            <strong>{team.name}</strong>
            <span className="muted">{team.description}</span>
          </Link>
        ))}
      </div>
      {manager && (
        <form className="card form" onSubmit={create}>
          <h2>创建 Team</h2>
          <label>名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label>说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          {error && <div className="alert">{error}</div>}
          <button className="btn primary">创建</button>
        </form>
      )}
    </div>
  );
}

function People({ projectId, manager }: { projectId: string; manager: boolean }) {
  const [items, setItems] = useState<{ userId: string; email: string; name: string; projectRole: string }[]>([]);
  const [email, setEmail] = useState("");
  const [projectRole, setProjectRole] = useState("member");
  const [error, setError] = useState("");
  async function load() {
    setItems(await api<{ userId: string; email: string; name: string; projectRole: string }[]>(`/api/projects/${projectId}/members`));
  }
  useEffect(() => { load().catch((reason) => setError(errorText(reason))); }, [projectId]);
  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/api/projects/${projectId}/members`, { method: "POST", body: JSON.stringify({ email, projectRole }) });
      setEmail(""); await load();
    } catch (reason) { setError(errorText(reason)); }
  }
  return (
    <div className="grid-2">
      <div className="card">
        <table>
          <tbody>
            {items.map((item) => (
              <tr key={item.userId}><td>{item.name}<div className="meta">{item.email}</div></td><td>{roleLabel(item.projectRole)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {manager && (
        <form className="card form" onSubmit={add}>
          <h2>加入项目</h2>
          <label>邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>项目权限
            <select value={projectRole} onChange={(event) => setProjectRole(event.target.value)}>
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
          </label>
          {error && <div className="alert">{error}</div>}
          <button className="btn primary">添加</button>
        </form>
      )}
    </div>
  );
}

function EngineChoice({ project, projectId, owner, onSaved }: { project: Project; projectId: string; owner: boolean; onSaved: () => Promise<void> }) {
  const [engines, setEngines] = useState<AgentEngineItem[]>([]);
  const [engineId, setEngineId] = useState(project.agentEngine?.id ?? "");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    setEngineId(project.agentEngine?.id ?? "");
  }, [project.agentEngine?.id]);

  useEffect(() => {
    if (!owner) return;
    api<AgentEngineItem[]>("/api/agent-engines").then(setEngines).catch((reason) => setError(errorText(reason)));
  }, [owner]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setOk("");
    try {
      await api(`/api/projects/${projectId}/agent-engine`, {
        method: "PUT",
        body: JSON.stringify({ agentEngineId: engineId || null }),
      });
      setOk("已选用");
      await onSaved();
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  if (!owner) {
    return (
      <div className="card">
        {project.agentEngine
          ? `当前 Agent 引擎：${project.agentEngine.name} · ${project.agentEngine.defaultModel}`
          : "尚未选择 Agent 引擎。"}
        <p className="muted">只有项目所有者可以选择引擎。</p>
      </div>
    );
  }

  return (
    <form className="card form" onSubmit={save}>
      <h2>选用 Agent 引擎</h2>
      <p className="muted">凭证在「Agent引擎」里配置。这里只决定本项目使用哪一个。</p>
      {engines.length === 0 ? (
        <p>还没有可用的引擎。<Link to="/engines">去创建 Agent 引擎</Link></p>
      ) : (
        <label>引擎
          <select value={engineId} onChange={(event) => setEngineId(event.target.value)}>
            <option value="">不使用</option>
            {engines.map((engine) => (
              <option key={engine.id} value={engine.id}>{engine.name} · {engine.defaultModel}</option>
            ))}
          </select>
        </label>
      )}
      {project.agentEngine && <p className="meta">当前：{project.agentEngine.name}</p>}
      {error && <div className="alert">{error}</div>}
      {ok && <div className="ok">{ok}</div>}
      {engines.length > 0 && <button className="btn primary">保存</button>}
    </form>
  );
}

function Releases({ projectId }: { projectId: string }) {
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [teamId, setTeamId] = useState("");
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [releases, setReleases] = useState<ReleaseItem[]>([]);
  const [error, setError] = useState("");

  async function loadReleases() {
    setReleases(await api<ReleaseItem[]>(`/api/projects/${projectId}/releases`));
  }
  useEffect(() => {
    api<TeamItem[]>(`/api/projects/${projectId}/teams`).then(setTeams).catch((reason) => setError(errorText(reason)));
    loadReleases().catch((reason) => setError(errorText(reason)));
  }, [projectId]);

  useEffect(() => {
    if (!teamId) return;
    api<{ services: ServiceItem[]; versions: VersionItem[] }>(`/api/teams/${teamId}/versions`)
      .then((data) => { setServices(data.services); setVersions(data.versions.filter((item) => item.status === "passed")); })
      .catch((reason) => setError(errorText(reason)));
  }, [teamId]);

  function toggle(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const release = await api<ReleaseItem>(`/api/projects/${projectId}/releases`, {
        method: "POST",
        body: JSON.stringify({
          teamId,
          version,
          items: selected.map((serviceVersionId) => ({
            serviceVersionId,
            serviceId: versions.find((item) => item.id === serviceVersionId)?.serviceId,
          })),
        }),
      });
      await api(`/api/system-releases/${release.id}/publish`, { method: "POST" });
      setVersion(""); setSelected([]);
      await loadReleases();
    } catch (reason) { setError(errorText(reason)); }
  }

  return (
    <div className="grid-2">
      <div className="card">
        <h2>已发布</h2>
        {releases.map((release) => (
          <div key={release.id} className="row">
            <strong>{release.version}</strong>
            <span className="pill">{release.status === "published" ? "已发布" : "草稿"}</span>
            <span className="meta">{release.items.length} 个服务</span>
          </div>
        ))}
      </div>
      <form className="card form" onSubmit={create}>
        <h2>组装系统版本</h2>
        <label>Team
          <select value={teamId} onChange={(event) => setTeamId(event.target.value)} required>
            <option value="">选择</option>
            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </label>
        <label>系统版本号<input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.0.0" required /></label>
        <div className="checks">
          {versions.map((item) => (
            <label key={item.id}>
              <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} />
              {services.find((service) => service.id === item.serviceId)?.name} {item.version} · {VERSION_LABELS[item.status]}
            </label>
          ))}
        </div>
        {error && <div className="alert">{error}</div>}
        <button className="btn primary">发布</button>
      </form>
    </div>
  );
}
