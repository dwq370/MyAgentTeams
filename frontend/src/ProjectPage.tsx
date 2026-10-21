import { FormEvent, useEffect, useRef, useState } from "react";
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
  token,
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
  const ready = switching ? complete : finished || complete;
  return (
    <div className="stack">
      <ArchitecturePanel project={project} projectId={projectId} manager={manager} onSaved={onSaved} />
      {ready
        ? <ProjectHome project={project} projectId={projectId} manager={manager} owner={owner} onSaved={onSaved} />
        : <SetupWizard project={project} projectId={projectId} manager={manager} owner={owner} step={step} onStep={setStep} onSaved={onSaved} />}
    </div>
  );
}

function ArchitecturePanel({ project, projectId, manager, onSaved }: { project: Project; projectId: string; manager: boolean; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(project.architectureDescription ?? "");
  const [editing, setEditing] = useState(false);
  const [architects, setArchitects] = useState<{ agentId: string; name: string; teamName: string; status: string }[]>([]);
  const [agentId, setAgentId] = useState("");
  const [source, setSource] = useState<"document" | "code">("code");
  const [documentText, setDocumentText] = useState("");
  const [run, setRun] = useState<{ agentId: string; id: string } | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(project.architectureDescription ?? ""); }, [project.architectureDescription]);
  useEffect(() => {
    api<{ agentId: string; name: string; teamName: string; status: string }[]>(`/api/projects/${projectId}/architects`)
      .then((items) => {
        setArchitects(items);
        setAgentId((current) => current || items.find((item) => item.status === "active")?.agentId || "");
      })
      .catch((reason) => setError(errorText(reason)));
  }, [projectId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ architectureDescription: draft }) });
      setEditing(false);
      await onSaved();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  }

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!agentId) {
      setError("请选择系统架构师");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const created = await api<{ id: string; agentId: string }>(`/api/projects/${projectId}/architecture`, {
        method: "POST",
        body: JSON.stringify({ agentId, source, document: source === "document" ? documentText : undefined }),
      });
      setRun(created);
      setLive(true);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card stack">
      <div className="split">
        <h2>项目架构描述</h2>
        {manager && !editing && <button className="btn" type="button" onClick={() => { setDraft(project.architectureDescription ?? ""); setEditing(true); }}>修改</button>}
      </div>
      {editing ? (
        <form className="form" onSubmit={save}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={12} />
          {error && <div className="alert">{error}</div>}
          <div className="row">
            <button className="btn primary" disabled={saving}>保存</button>
            <button className="btn" type="button" disabled={saving} onClick={() => setEditing(false)}>取消</button>
          </div>
        </form>
      ) : (
        <div className="doc">{project.architectureDescription || "还没有架构描述。"}</div>
      )}
      {manager && (
        <form className="form" onSubmit={generate}>
          <p className="muted">选择系统架构师，让它阅读文档，或通读已检出的基线代码并生成架构描述。生成时显示 Agent 轨迹，可以停止。结果保存为 architecture.md，并作为架构师的系统提示词，用来评估需求和分解任务。生成结果可以再修改。</p>
          {architects.length === 0 && <p className="muted">还没有系统架构师。请先在 Team 中加入架构师 Agent。</p>}
          {architects.length > 0 && (
            <label>架构师
              <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                <option value="">选择架构师</option>
                {architects.map((item) => (
                  <option key={item.agentId} value={item.agentId} disabled={item.status !== "active"}>
                    {item.name} · {item.teamName}{item.status === "active" ? "" : ` · ${item.status}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="row">
            <button type="button" className={source === "code" ? "btn primary" : "btn"} onClick={() => setSource("code")}>通读代码</button>
            <button type="button" className={source === "document" ? "btn primary" : "btn"} onClick={() => setSource("document")}>阅读文档</button>
          </div>
          {source === "document" && (
            <>
              <label>文档<textarea value={documentText} onChange={(event) => setDocumentText(event.target.value)} rows={8} placeholder="粘贴架构材料、接口说明或设计笔记" /></label>
              <label>上传文本
                <input type="file" accept=".md,.txt,.markdown,text/plain" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  file.text().then(setDocumentText).catch(() => setError("无法读取文档"));
                }} />
              </label>
            </>
          )}
          {source === "code" && <p className="muted">会按 Team 工作区的基线检出只读代码并通读源码。架构师不创建远端分支。</p>}
          {!editing && error && <div className="alert">{error}</div>}
          <button className="btn primary" disabled={saving || !agentId || live}>生成架构文档</button>
        </form>
      )}
      {run && <ArchitectureStream key={run.id} agentId={run.agentId} runId={run.id} onLive={setLive} onFinished={() => { onSaved().catch(() => undefined); }} />}
    </section>
  );
}

const RUN_LABEL: Record<string, string> = {
  queued: "排队",
  running: "进行中",
  finished: "已完成",
  cancelled: "已停止",
  error: "运行失败",
  startup_error: "启动失败",
};

function ArchitectureStream({ agentId, runId, onLive, onFinished }: { agentId: string; runId: string; onLive: (live: boolean) => void; onFinished: () => void }) {
  const [log, setLog] = useState("");
  const [status, setStatus] = useState("queued");
  const [failure, setFailure] = useState("");
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState("");
  const box = useRef<HTMLPreElement>(null);
  const finished = useRef(false);
  const live = status === "queued" || status === "running";
  useEffect(() => { onLive(live); }, [live, onLive]);
  useEffect(() => {
    const node = box.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [log]);
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    (async () => {
      const response = await fetch(`/api/agents/${agentId}/runs/${runId}/events`, {
        headers: { Authorization: `Bearer ${token() ?? ""}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        setStatus("error");
        setFailure("无法连接轨迹");
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((item) => item.startsWith("data:"));
          if (!line) continue;
          const payload = JSON.parse(line.slice(5).trim()) as { type?: string; log?: string; text?: string; status?: string; errorMessage?: string | null };
          if (payload.type === "snapshot") {
            setLog(payload.log ?? "");
            if (payload.status) setStatus(payload.status);
            setFailure(payload.errorMessage ?? "");
            if (payload.status === "finished" && !finished.current) {
              finished.current = true;
              onFinished();
            }
          }
          if (payload.type === "append" && payload.text) setLog((current) => current + payload.text);
          if (payload.type === "status" && payload.status) {
            setStatus(payload.status);
            if (payload.errorMessage) setFailure(payload.errorMessage);
            if (payload.status === "finished" && !finished.current) {
              finished.current = true;
              onFinished();
            }
          }
        }
      }
    })().catch(() => {
      if (stopped) return;
      setStatus("error");
      setFailure("轨迹连接中断");
    });
    return () => { stopped = true; controller.abort(); };
  }, [agentId, runId]);
  async function stop() {
    setStopping(true);
    setActionError("");
    try {
      await api(`/api/agents/${agentId}/runs/${runId}/cancel`, { method: "POST" });
    } catch (reason) {
      setActionError(errorText(reason));
      setStopping(false);
    }
  }
  return (
    <div className="stack">
      <div className="split">
        <div className="meta">Agent 轨迹 · {stopping && live ? "正在停止" : (RUN_LABEL[status] ?? status)}</div>
        {live && <button className="btn" type="button" onClick={() => { void stop(); }} disabled={stopping}>停止</button>}
      </div>
      {failure && <div className="alert">{failure}</div>}
      {actionError && <div className="alert">{actionError}</div>}
      <pre className="log trace" ref={box}>{log || "等待架构师开始"}</pre>
    </div>
  );
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
