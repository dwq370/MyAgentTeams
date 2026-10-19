import { FormEvent, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  AgentEngineItem,
  api,
  errorText,
  Project,
  TeamItem,
  KubernetesProbe,
  SshProbeResult,
  TestEnvironment,
} from "./api";
import { roleLabel } from "./ProjectsPage";
import { TeamMonitorView } from "./TeamMonitorPage";

export const PROJECT_SECTIONS = [
  { id: "overview", label: "概览" },
  { id: "teams", label: "Team" },
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
      {section === "overview" && <Overview project={project} projectId={projectId} manager={manager} owner={owner} onSaved={load} />}
      {section === "teams" && <Teams projectId={projectId} manager={manager} />}
    </div>
  );
}

function isSetupComplete(project: Project) {
  return Boolean(project.agentEngine) && (project.counts?.environments ?? 0) > 0 && (project.counts?.teams ?? 0) > 0;
}

function firstIncomplete(project: Project) {
  if (!project.agentEngine) return 0;
  if ((project.counts?.environments ?? 0) === 0) return 1;
  return 2;
}

function Overview({ project, projectId, manager, owner, onSaved }: { project: Project; projectId: string; manager: boolean; owner: boolean; onSaved: () => Promise<void> }) {
  const complete = isSetupComplete(project);
  const [step, setStep] = useState(firstIncomplete(project));
  const [trackedId, setTrackedId] = useState(project.id);
  const [finished, setFinished] = useState(complete);
  const switching = trackedId !== project.id;
  if (switching) {
    setTrackedId(project.id);
    setFinished(complete);
    setStep(firstIncomplete(project));
  } else if (complete && !finished) {
    setFinished(true);
  }
  if (switching ? complete : finished || complete) {
    return <ProjectHome project={project} projectId={projectId} manager={manager} owner={owner} onSaved={onSaved} />;
  }
  return <SetupWizard project={project} projectId={projectId} manager={manager} owner={owner} step={step} onStep={setStep} onSaved={onSaved} />;
}

function SetupWizard({ project, projectId, manager, owner, step, onStep, onSaved }: { project: Project; projectId: string; manager: boolean; owner: boolean; step: number; onStep: (step: number) => void; onSaved: () => Promise<void> }) {
  const steps = [
    { title: "选择 Agent 引擎", done: Boolean(project.agentEngine) },
    { title: "配置测试环境", done: (project.counts?.environments ?? 0) > 0 },
    { title: "创建 Team", done: (project.counts?.teams ?? 0) > 0 },
  ];

  function open(index: number) {
    if (index <= step || steps.slice(0, index).every((item) => item.done)) onStep(index);
  }

  return (
    <div className="stack">
      <p className="muted">按顺序完成创建。完成后，概览会集中显示 Agent 引擎、测试环境和 Team 监控。</p>
      <div className="tabs">
        {steps.map((item, index) => (
          <button key={item.title} type="button" className={index === step ? "active" : ""} disabled={index > step && !steps.slice(0, index).every((entry) => entry.done)} onClick={() => open(index)}>
            {index + 1}. {item.title}{item.done ? " · 已完成" : ""}
          </button>
        ))}
      </div>
      {step === 0 && <EngineChoice project={project} projectId={projectId} owner={owner} onSaved={onSaved} />}
      {step === 1 && <Environments projectId={projectId} manager={manager} onChanged={onSaved} />}
      {step === 2 && (
        <div className="stack">
          <p className="muted">创建 Team 后进入概览。代码来源可以之后在 Team 里配置。</p>
          <Teams projectId={projectId} manager={manager} onChanged={onSaved} />
        </div>
      )}
      <div className="row">
        <button className="btn" type="button" disabled={step === 0} onClick={() => onStep(step - 1)}>上一步</button>
        {step < 2 && <button className="btn primary" type="button" disabled={!steps[step].done} onClick={() => onStep(step + 1)}>下一步</button>}
      </div>
    </div>
  );
}

function ProjectHome({ project, projectId, manager, owner, onSaved }: { project: Project; projectId: string; manager: boolean; owner: boolean; onSaved: () => Promise<void> }) {
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<TeamItem[]>(`/api/projects/${projectId}/teams`).then(setTeams).catch((reason) => setError(errorText(reason)));
  }, [projectId, project.counts?.teams]);

  return (
    <div className="stack">
      <EngineChoice project={project} projectId={projectId} owner={owner} onSaved={onSaved} />
      <div className="stack">
        <h2>测试环境</h2>
        <Environments projectId={projectId} manager={manager} onChanged={onSaved} />
      </div>
      <div className="stack">
        <h2>Team 监控</h2>
        {error && <div className="alert">{error}</div>}
        {teams.map((team) => <TeamMonitorView key={team.id} projectId={projectId} teamId={team.id} embedded />)}
        {teams.length === 0 && <p className="muted">还没有 Team。</p>}
      </div>
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

function Environments({ projectId, manager, onChanged }: { projectId: string; manager: boolean; onChanged?: () => Promise<void> }) {
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
      await onChanged?.();
    } catch (reason) { setError(errorText(reason)); }
  }

  async function remove(item: TestEnvironment) {
    if (!confirm(`删除测试环境 ${item.name}？`)) return;
    setError("");
    try {
      await api(`/api/projects/${projectId}/environments/${item.id}`, { method: "DELETE" });
      if (editing?.id === item.id) beginCreate();
      await load();
      await onChanged?.();
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

function Teams({ projectId, manager, onChanged }: { projectId: string; manager: boolean; onChanged?: () => Promise<void> }) {
  const [items, setItems] = useState<TeamItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  async function load() { setItems(await api<TeamItem[]>(`/api/projects/${projectId}/teams`)); }
  useEffect(() => { load().catch((reason) => setError(errorText(reason))); }, [projectId]);

  function openCreate() {
    setName("");
    setDescription("");
    setError("");
    setCreating(true);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/api/projects/${projectId}/teams`, { method: "POST", body: JSON.stringify({ name, description }) });
      setCreating(false);
      setName("");
      setDescription("");
      await load();
      await onChanged?.();
    } catch (reason) { setError(errorText(reason)); }
  }

  return (
    <div className="stack">
      <div className="toprow">
        <p className="muted">打开入口后可以选择 Agent 对话。</p>
        {manager && <button className="btn primary" type="button" onClick={openCreate}>创建 Team</button>}
      </div>
      <div className="list">
        {items.map((team) => (
          <div key={team.id} className="card project-row">
            <Link className="project-main" to={`/projects/${projectId}/teams/${team.id}`}>
              <strong>{team.name}</strong>
              <span className="muted">{team.description}</span>
            </Link>
            <Link className="btn primary" to={`/projects/${projectId}/teams/${team.id}/entry`}>入口</Link>
          </div>
        ))}
        {items.length === 0 && <div className="card muted">还没有 Team。</div>}
      </div>
      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <form className="card form modal" onClick={(event) => event.stopPropagation()} onSubmit={create}>
            <h2>创建 Team</h2>
            <label>名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
            <label>说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            {error && <div className="alert">{error}</div>}
            <div className="row">
              <button className="btn primary">创建</button>
              <button className="btn" type="button" onClick={() => setCreating(false)}>取消</button>
            </div>
          </form>
        </div>
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
