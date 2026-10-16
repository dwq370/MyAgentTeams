import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  errorText,
  MemberItem,
  needsServices,
  PERMISSION_LABELS,
  RoleItem,
  CatalogRepo,
  ServiceItem,
  TeamCatalog,
  TeamItem,
  TestEnvironment,
  token,
  VersionItem,
  VERSION_LABELS,
} from "./api";

export function TeamPage() {
  const { projectId = "", teamId = "" } = useParams();
  const [tab, setTab] = useState("工作区");
  const [team, setTeam] = useState<TeamItem | null>(null);
  const [error, setError] = useState("");

  async function loadTeam() {
    setTeam(await api<TeamItem>(`/api/teams/${teamId}`));
  }
  useEffect(() => { loadTeam().catch((reason) => setError(errorText(reason))); }, [teamId]);
  useEffect(() => {
    if (tab !== "版本") return;
    loadTeam().catch((reason) => setError(errorText(reason)));
  }, [tab, teamId]);
  if (!team) return <p>{error || "加载 Team"}</p>;
  const manager = team.projectRole !== "member";

  return (
    <div className="stack">
      <div>
        <Link to={`/projects/${projectId}`}>返回项目</Link>
        <h1>{team.name}</h1>
        <p className="muted">{team.description || "暂无说明"}{team.myMembership ? ` · 我的角色 ${team.myMembership.roleName}` : ""}</p>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="tabs">
        {["工作区", "成员", "工作项", "版本"].map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>
        ))}
      </div>
      {tab === "工作区" && <Workspaces team={team} projectId={projectId} manager={manager} onSaved={loadTeam} />}
      {tab === "成员" && <Members teamId={teamId} projectId={projectId} manager={manager} onTeamChanged={loadTeam} />}
      {tab === "工作项" && <WorkItems teamId={teamId} />}
      {tab === "版本" && <Versions team={team} />}
    </div>
  );
}

function environmentSummary(item: TestEnvironment) {
  if (item.kind === "kubernetes") return `Kubernetes · ${item.kubeContext ?? ""} · ${item.clusterServer ?? ""}`;
  return `单机 · ${item.sshUsername ?? ""}@${item.sshHost ?? ""}:${item.sshPort ?? 22}`;
}

function Workspaces({ team, projectId, manager, onSaved }: { team: TeamItem; projectId: string; manager: boolean; onSaved: () => Promise<void> }) {
  const teamId = team.id;
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [environments, setEnvironments] = useState<TestEnvironment[]>([]);
  const [environmentId, setEnvironmentId] = useState(team.testEnvironment?.id ?? "");
  const [baselines, setBaselines] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<"group" | "repo">("group");
  const [url, setUrl] = useState("");
  const [gitToken, setGitToken] = useState("");
  const [baselineRef, setBaselineRef] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function load() {
    const [nextCatalog, environmentList] = await Promise.all([
      api<TeamCatalog>(`/api/teams/${teamId}/catalog`),
      api<TestEnvironment[]>(`/api/projects/${projectId}/environments`),
    ]);
    setCatalog(nextCatalog);
    setEnvironments(environmentList);
    const next: Record<string, string> = {};
    for (const address of nextCatalog.addresses) next[address.serviceId] = address.baselineRef;
    setBaselines(next);
  }

  useEffect(() => {
    load().catch((reason) => setError(errorText(reason)));
  }, [projectId, teamId]);

  useEffect(() => {
    setEnvironmentId(team.testEnvironment?.id ?? "");
  }, [team.testEnvironment?.id]);

  async function saveEnvironment(event: FormEvent) {
    event.preventDefault();
    setError("");
    setOk("");
    try {
      await api(`/api/teams/${teamId}`, { method: "PATCH", body: JSON.stringify({ testEnvironmentId: environmentId || null }) });
      setOk("测试环境已保存");
      await onSaved();
    } catch (reason) { setError(errorText(reason)); }
  }

  async function addSource(event: FormEvent) {
    event.preventDefault();
    setError("");
    setOk("");
    try {
      await api(`/api/teams/${teamId}/sources`, {
        method: "POST",
        body: JSON.stringify({
          kind,
          url,
          gitToken,
          baselineRef: kind === "repo" && baselineRef.trim() ? baselineRef.trim() : undefined,
        }),
      });
      setUrl("");
      setGitToken("");
      setBaselineRef("");
      setOk(kind === "group" ? "群组已加入工作区" : "仓库已加入工作区");
      await load();
    } catch (reason) { setError(errorText(reason)); }
  }

  async function removeSource(sourceId: string) {
    setError("");
    setOk("");
    try {
      await api(`/api/teams/${teamId}/sources/${sourceId}`, { method: "DELETE" });
      setOk("代码来源已移除");
      await load();
    } catch (reason) { setError(errorText(reason)); }
  }

  async function saveBaselines(event: FormEvent) {
    event.preventDefault();
    setError("");
    setOk("");
    try {
      await api(`/api/teams/${teamId}/workspaces`, {
        method: "PATCH",
        body: JSON.stringify({
          items: Object.entries(baselines).map(([serviceId, baseline]) => ({ serviceId, baselineRef: baseline })),
        }),
      });
      setOk("基线已保存");
      await load();
    } catch (reason) { setError(errorText(reason)); }
  }

  const selected = environments.find((item) => item.id === environmentId);
  return (
    <div className="stack">
    {error && <div className="alert">{error}</div>}
    {ok && <div className="ok">{ok}</div>}
    <form className="card form" onSubmit={saveEnvironment}>
      <h2>测试环境</h2>
      {environments.length === 0 ? (
        <p>项目还没有测试环境。<Link to={`/projects/${projectId}?section=environments`}>去配置</Link></p>
      ) : (
        <label>选用
          <select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)} disabled={!manager}>
            <option value="">不使用</option>
            {environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      )}
      {selected && <p className="meta">{environmentSummary(selected)}</p>}
      {manager && environments.length > 0 && <button className="btn primary">保存测试环境</button>}
    </form>
    <form className="card form" onSubmit={addSource}>
      <h2>代码来源</h2>
      <p className="muted">添加 Git 群组，或直接添加仓库地址。Agent 创建时可以从群组里选仓库，也可以选这里已经配置的仓库地址。</p>
      <label>类型
        <select value={kind} onChange={(event) => setKind(event.target.value as "group" | "repo")} disabled={!manager}>
          <option value="group">群组</option>
          <option value="repo">仓库</option>
        </select>
      </label>
      <label>地址
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={kind === "group" ? "http://192.168.31.85:8077/epvs" : "http://192.168.31.85:8077/epvs/api"}
          required
          disabled={!manager}
        />
      </label>
      <label>Git 访问令牌
        <input type="password" value={gitToken} onChange={(event) => setGitToken(event.target.value)} required disabled={!manager} autoComplete="off" />
      </label>
      {kind === "repo" && (
        <label>基线分支
          <input value={baselineRef} onChange={(event) => setBaselineRef(event.target.value)} placeholder="留空则使用仓库默认分支" disabled={!manager} />
        </label>
      )}
      {manager && <button className="btn primary">添加</button>}
    </form>
    <div className="card stack">
      <h2>已配置</h2>
      {(catalog?.sources.length ?? 0) === 0 && <p className="muted">还没有配置代码来源。</p>}
      {catalog?.sources.map((source) => {
        const group = catalog.groups.find((item) => item.id === source.id);
        return (
          <article key={source.id}>
            <div className="split">
              <div>
                <strong>{source.kind === "group" ? "群组" : "仓库"} · {source.name}</strong>
                <div className="meta">{source.url}</div>
                {source.kind === "repo" && <div className="meta">基线 {source.baselineRef}</div>}
                {group?.error && <div className="alert">{group.error}</div>}
                {group && !group.error && <div className="meta">{group.repos.length} 个仓库</div>}
              </div>
              {manager && <button className="btn danger" type="button" onClick={() => removeSource(source.id)}>移除</button>}
            </div>
            {group && group.repos.length > 0 && (
              <div className="source-repos">
                {group.repos.map((repo) => (
                  <div key={repo.repoUrl} className="meta">{repo.name} · {repo.repoUrl}</div>
                ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
    <form className="card form" onSubmit={saveBaselines}>
      <h2>仓库地址</h2>
      <p className="muted">这里是工作区里可直接分配的仓库。从群组勾选的仓库在保存 Agent 后也会出现在这里。</p>
      {(catalog?.addresses.length ?? 0) === 0 && <p className="muted">还没有仓库地址。</p>}
      {catalog?.addresses.map((address) => (
        <label key={address.serviceId}>{address.name}
          <span className="meta">{address.repoUrl}</span>
          <input
            value={baselines[address.serviceId] ?? address.baselineRef}
            onChange={(event) => setBaselines({ ...baselines, [address.serviceId]: event.target.value })}
            disabled={!manager}
          />
        </label>
      ))}
      {manager && (catalog?.addresses.length ?? 0) > 0 && <button className="btn primary">保存基线</button>}
    </form>
    </div>
  );
}

function Members({ teamId, projectId, manager, onTeamChanged }: { teamId: string; projectId: string; manager: boolean; onTeamChanged: () => Promise<void> }) {
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [error, setError] = useState("");

  async function loadMembers() {
    const [memberList, versionData] = await Promise.all([
      api<MemberItem[]>(`/api/teams/${teamId}/members`),
      api<{ versions: VersionItem[] }>(`/api/teams/${teamId}/versions`),
    ]);
    setMembers(memberList);
    setVersions(versionData.versions);
  }

  async function load() {
    const [roleList, nextCatalog] = await Promise.all([
      api<RoleItem[]>("/api/roles"),
      api<TeamCatalog>(`/api/teams/${teamId}/catalog`),
    ]);
    setRoles(roleList);
    setCatalog(nextCatalog);
    await loadMembers();
    await onTeamChanged();
  }
  useEffect(() => { load().catch((reason) => setError(errorText(reason))); }, [teamId, projectId]);
  useEffect(() => {
    if (!members.some((member) => member.status === "pending")) return;
    const timer = window.setInterval(() => { loadMembers().catch(() => undefined); }, 4000);
    return () => window.clearInterval(timer);
  }, [members, teamId, projectId]);

  return (
    <div className="stack">
      {error && <div className="alert">{error}</div>}
      {members.map((member) => (
        <MemberCard key={member.id} member={member} teamId={teamId} versions={versions} onChanged={load} onError={setError} />
      ))}
      {manager && <MemberForm teamId={teamId} roles={roles} catalog={catalog} versions={versions} onCreated={load} />}
    </div>
  );
}

function MemberCard({ member, teamId, versions, onChanged, onError }: {
  member: MemberItem;
  teamId: string;
  versions: VersionItem[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState("");
  const [runId, setRunId] = useState("");

  async function remove() {
    if (!confirm(`移除 ${member.name}？`)) return;
    try { await api(`/api/teams/${teamId}/members/${member.id}`, { method: "DELETE" }); await onChanged(); }
    catch (reason) { onError(errorText(reason)); }
  }
  async function retry() {
    if (!member.agent) return;
    try { await api(`/api/agents/${member.agent.id}/retry`, { method: "POST" }); await onChanged(); }
    catch (reason) { onError(errorText(reason)); }
  }
  async function showPreview() {
    if (!member.agent) return;
    try {
      const result = await api<{ composedPrompt: string }>(`/api/agents/${member.agent.id}/runs/preview`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      setPreview(result.composedPrompt);
    } catch (reason) { onError(errorText(reason)); }
  }
  async function dispatch(event: FormEvent) {
    event.preventDefault();
    if (!member.agent) return;
    try {
      const run = await api<{ id: string }>(`/api/agents/${member.agent.id}/runs`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      setRunId(run.id);
      setPrompt("");
    } catch (reason) { onError(errorText(reason)); }
  }

  const statusClass = member.status === "active" ? "good" : member.status === "failed" ? "bad" : "wait";
  return (
    <article className="card stack">
      <div className="split">
        <div>
          <strong>{member.name}</strong> · {member.roleName}
          <div className="meta">{member.memberType === "agent" ? "Agent" : "人类"} · {member.services.map((service) => service.name).join("、") || "不按服务分配"}</div>
        </div>
        <span className={`pill ${statusClass}`}>{member.status}</span>
      </div>
      {member.failureReason && <div className="alert">{member.failureReason}</div>}
      {member.dutyOverride && <p>{member.dutyOverride}</p>}
      {member.agent && (
        <div className="meta">
          {member.agent.platform} / {member.agent.model} / {member.agent.externalAgentId || "尚未创建外部 Agent"}
          {member.agent.workspaces.map((workspace) => (
            <div key={workspace.id}>{workspace.forked ? "fork" : "基线"} {workspace.branch} · {workspace.forkStatus}</div>
          ))}
        </div>
      )}
      <div className="row">
        <button className="btn danger" onClick={remove}>移除</button>
        {member.agent && member.status === "failed" && <button className="btn" onClick={retry}>重试创建</button>}
      </div>
      {member.agent && (
        <form className="form" onSubmit={dispatch}>
          <label>派发任务<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
          <div className="row">
            <button className="btn" type="button" onClick={showPreview}>查看本次提示词</button>
            <button className="btn primary" disabled={member.status !== "active"}>发送</button>
          </div>
          {preview && <pre className="log">{preview}</pre>}
          {runId && <RunStream agentId={member.agent.id} runId={runId} />}
        </form>
      )}
      {member.testedServiceVersionId && <div className="meta">被测版本 {versions.find((item) => item.id === member.testedServiceVersionId)?.version}</div>}
    </article>
  );
}

function MemberForm({ teamId, roles, catalog, versions, onCreated }: {
  teamId: string;
  roles: RoleItem[];
  catalog: TeamCatalog | null;
  versions: VersionItem[];
  onCreated: () => Promise<void>;
}) {
  const [kind, setKind] = useState<"human" | "agent">("human");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [creatingRole, setCreatingRole] = useState(false);
  const [roleCode, setRoleCode] = useState("");
  const [roleName, setRoleName] = useState("");
  const [roleDuties, setRoleDuties] = useState("");
  const [rolePrompt, setRolePrompt] = useState("");
  const [rolePermissions, setRolePermissions] = useState<string[]>([]);
  const [dutyOverride, setDutyOverride] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [groupRepos, setGroupRepos] = useState<{ sourceId: string; repoUrl: string }[]>([]);
  const [model, setModel] = useState("");
  const [testedServiceVersionId, setTested] = useState("");
  const [error, setError] = useState("");
  const role = roles.find((item) => item.id === roleId) ?? roles[0];
  const activeRoleId = role?.id ?? "";
  const selectedPermissions = kind === "agent" && creatingRole ? rolePermissions : (role?.permissions ?? []);
  const scoped = needsServices(selectedPermissions);

  function toggleService(serviceId: string) {
    setServiceIds((current) => current.includes(serviceId) ? current.filter((item) => item !== serviceId) : [...current, serviceId]);
  }

  function toggleGroupRepo(sourceId: string, repo: CatalogRepo) {
    if (repo.serviceId) {
      toggleService(repo.serviceId);
      return;
    }
    setGroupRepos((current) => {
      const exists = current.some((item) => item.sourceId === sourceId && item.repoUrl === repo.repoUrl);
      return exists
        ? current.filter((item) => !(item.sourceId === sourceId && item.repoUrl === repo.repoUrl))
        : [...current, { sourceId, repoUrl: repo.repoUrl }];
    });
  }

  function groupChecked(sourceId: string, repo: CatalogRepo) {
    if (repo.serviceId) return serviceIds.includes(repo.serviceId);
    return groupRepos.some((item) => item.sourceId === sourceId && item.repoUrl === repo.repoUrl);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    let chosenRoleId = activeRoleId;
    try {
      if (kind === "agent" && creatingRole) {
        const created = await api<RoleItem>("/api/roles", {
          method: "POST",
          body: JSON.stringify({
            code: roleCode,
            name: roleName,
            duties: roleDuties,
            promptTemplate: rolePrompt,
            permissions: rolePermissions,
          }),
        });
        chosenRoleId = created.id;
      }
      const payload = {
        roleId: chosenRoleId,
        dutyOverride,
        serviceIds: scoped ? serviceIds : [],
        groupRepos: scoped ? groupRepos : [],
        testedServiceVersionId: testedServiceVersionId || undefined,
      };
      if (kind === "human") {
        await api(`/api/teams/${teamId}/members/humans`, { method: "POST", body: JSON.stringify({ ...payload, email }) });
      } else {
        await api(`/api/teams/${teamId}/members/agents`, { method: "POST", body: JSON.stringify({ ...payload, name, model: model || undefined }) });
      }
      setEmail(""); setName(""); setDutyOverride(""); setServiceIds([]); setGroupRepos([]);
      await onCreated();
    } catch (reason) { setError(errorText(reason)); }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>加入成员</h2>
      <div className="row">
        <button type="button" className={kind === "human" ? "btn primary" : "btn"} onClick={() => setKind("human")}>人类</button>
        <button type="button" className={kind === "agent" ? "btn primary" : "btn"} onClick={() => setKind("agent")}>Agent</button>
      </div>
      {kind === "human" ? (
        <label>邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      ) : (
        <label>名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
      )}
      {kind === "agent" && (
        <div className="row">
          <button type="button" className={!creatingRole ? "btn primary" : "btn"} onClick={() => setCreatingRole(false)}>选择角色</button>
          <button type="button" className={creatingRole ? "btn primary" : "btn"} onClick={() => setCreatingRole(true)}>新建角色</button>
        </div>
      )}
      {kind === "agent" && creatingRole ? (
        <>
          <label>编码<input value={roleCode} onChange={(event) => setRoleCode(event.target.value.toUpperCase())} placeholder="SEC" required /></label>
          <label>名称<input value={roleName} onChange={(event) => setRoleName(event.target.value)} required /></label>
          <label>职责<textarea value={roleDuties} onChange={(event) => setRoleDuties(event.target.value)} required /></label>
          <label>派发提示词<textarea value={rolePrompt} onChange={(event) => setRolePrompt(event.target.value)} required /></label>
          <div className="checks">
            {Object.entries(PERMISSION_LABELS).map(([id, label]) => (
              <label key={id}><input type="checkbox" checked={rolePermissions.includes(id)} onChange={() => setRolePermissions((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} />{label}</label>
            ))}
          </div>
        </>
      ) : (
        <label>角色
          <select value={activeRoleId} onChange={(event) => { setRoleId(event.target.value); setServiceIds([]); setGroupRepos([]); }}>
            {roles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      )}
      <label>职责补充<textarea value={dutyOverride} onChange={(event) => setDutyOverride(event.target.value)} /></label>
      {scoped && (
        <div className="stack">
          <div>
            <strong>工作区仓库</strong>
            {(catalog?.addresses.length ?? 0) === 0 && <p className="muted">工作区还没有仓库地址。</p>}
            <div className="source-repos">
              {catalog?.addresses.map((address) => (
                <label key={address.serviceId} className="check-line">
                  <input type="checkbox" checked={serviceIds.includes(address.serviceId)} onChange={() => toggleService(address.serviceId)} />
                  <span>{address.name}</span>
                  <span className="muted">{address.repoUrl}</span>
                </label>
              ))}
            </div>
          </div>
          {catalog?.groups.map((group) => (
            <div key={group.id}>
              <strong>群组 {group.name}</strong>
              {group.error && <div className="alert">{group.error}</div>}
              <div className="source-repos">
                {group.repos.map((repo) => (
                  <label key={repo.repoUrl} className="check-line">
                    <input type="checkbox" checked={groupChecked(group.id, repo)} onChange={() => toggleGroupRepo(group.id, repo)} />
                    <span>{repo.name}</span>
                    <span className="muted">{repo.repoUrl}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          {(catalog?.addresses.length ?? 0) === 0 && (catalog?.groups.length ?? 0) === 0 && (
            <p className="muted">请先在工作区配置群组或仓库地址。</p>
          )}
        </div>
      )}
      {kind === "agent" && <label>模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="默认使用项目模型" /></label>}
      {selectedPermissions.includes("service:test") && (
        <label>被测版本
          <select value={testedServiceVersionId} onChange={(event) => setTested(event.target.value)}>
            <option value="">暂不指定</option>
            {versions.filter((item) => serviceIds.includes(item.serviceId)).map((item) => (
              <option key={item.id} value={item.id}>{item.version}</option>
            ))}
          </select>
        </label>
      )}
      {error && <div className="alert">{error}</div>}
      <button className="btn primary">加入</button>
    </form>
  );
}

function WorkItems({ teamId }: { teamId: string }) {
  const [items, setItems] = useState<{ id: string; title: string; description: string; status: string }[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  async function load() {
    setItems(await api<{ id: string; title: string; description: string; status: string }[]>(`/api/teams/${teamId}/work-items`));
  }
  useEffect(() => { load().catch((reason) => setError(errorText(reason))); }, [teamId]);
  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/api/teams/${teamId}/work-items`, { method: "POST", body: JSON.stringify({ title, description }) });
      setTitle(""); setDescription(""); await load();
    } catch (reason) { setError(errorText(reason)); }
  }
  async function done(id: string) {
    await api(`/api/work-items/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
    await load();
  }
  return (
    <div className="grid-2">
      <div className="list">
        {items.map((item) => (
          <div key={item.id} className="card split">
            <div><strong>{item.title}</strong><div className="muted">{item.description}</div></div>
            <button className="btn" onClick={() => done(item.id)}>{item.status}</button>
          </div>
        ))}
      </div>
      <form className="card form" onSubmit={create}>
        <h2>新建工作项</h2>
        <label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
        <label>说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        {error && <div className="alert">{error}</div>}
        <button className="btn primary">创建</button>
      </form>
    </div>
  );
}

function Versions({ team }: { team: TeamItem }) {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [version, setVersion] = useState("");
  const [gitSha, setGitSha] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const permissions = team.myMembership?.permissions ?? [];
  const mine = new Set(team.myMembership?.serviceIds ?? []);

  async function load() {
    const data = await api<{ services: ServiceItem[]; versions: VersionItem[] }>(`/api/teams/${team.id}/versions`);
    setServices(data.services);
    setVersions(data.versions);
    setServiceId((current) => current || data.services[0]?.id || "");
  }
  useEffect(() => { load().catch((reason) => setError(errorText(reason))); }, [team.id]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api(`/api/services/${serviceId}/versions`, { method: "POST", body: JSON.stringify({ teamId: team.id, version, gitSha: gitSha || undefined }) });
      setVersion(""); setGitSha(""); await load();
    } catch (reason) { setError(errorText(reason)); }
  }
  async function act(path: string, body: unknown) {
    setError("");
    try { await api(path, { method: "POST", body: JSON.stringify(body) }); await load(); }
    catch (reason) { setError(errorText(reason)); }
  }

  return (
    <div className="stack">
      {error && <div className="alert">{error}</div>}
      {services.map((service) => (
        <section key={service.id} className="card">
          <h2>{service.name}</h2>
          {versions.filter((item) => item.serviceId === service.id).map((item) => (
            <div key={item.id} className="split">
              <div>
                <strong>{item.version}</strong> <span className="pill">{VERSION_LABELS[item.status]}</span>
                <div className="meta">{item.imageTag || "尚未生成镜像 tag"} {item.tagName ? `· ${item.tagName} ${item.tagStatus}` : ""} {item.tagError || ""}</div>
              </div>
              <div className="row">
                {item.status === "draft" && permissions.includes("service:version:create") && mine.has(service.id) && (
                  <button className="btn" onClick={() => act(`/api/services/${service.id}/versions/${item.id}/transition`, { teamId: team.id, to: "ready_for_test" })}>提交测试</button>
                )}
                {item.status === "ready_for_test" && permissions.includes("service:test") && mine.has(service.id) && (
                  <button className="btn" onClick={() => act(`/api/services/${service.id}/versions/${item.id}/transition`, { teamId: team.id, to: "testing" })}>开始测试</button>
                )}
                {(item.status === "ready_for_test" || item.status === "testing") && permissions.includes("service:test") && mine.has(service.id) && (
                  <>
                    <button className="btn primary" onClick={() => act(`/api/services/${service.id}/versions/${item.id}/test-reports`, { teamId: team.id, result: "passed", notes })}>通过</button>
                    <button className="btn danger" onClick={() => act(`/api/services/${service.id}/versions/${item.id}/test-reports`, { teamId: team.id, result: "failed", notes })}>失败</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </section>
      ))}
      {permissions.includes("service:version:create") && (
        <form className="card form" onSubmit={create}>
          <h2>创建候选版本</h2>
          <label>服务
            <select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
              {services.filter((service) => mine.has(service.id)).map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
            </select>
          </label>
          <label>版本号<input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.0.0" required /></label>
          <label>Git SHA<input value={gitSha} onChange={(event) => setGitSha(event.target.value)} /></label>
          <label>测试备注<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          <button className="btn primary">创建</button>
        </form>
      )}
    </div>
  );
}

function RunStream({ agentId, runId }: { agentId: string; runId: string }) {
  const [log, setLog] = useState("");
  const [status, setStatus] = useState("queued");
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    (async () => {
      const response = await fetch(`/api/agents/${agentId}/runs/${runId}/events`, {
        headers: { Authorization: `Bearer ${token() ?? ""}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return;
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
          const payload = JSON.parse(line.slice(5).trim()) as { type?: string; log?: string; text?: string; status?: string };
          if (payload.type === "snapshot") {
            setLog(payload.log ?? "");
            if (payload.status) setStatus(payload.status);
          }
          if (payload.type === "append" && payload.text) setLog((current) => current + payload.text);
          if (payload.type === "status" && payload.status) setStatus(payload.status);
        }
      }
    })().catch(() => undefined);
    return () => { stopped = true; controller.abort(); };
  }, [agentId, runId]);
  return (
    <div>
      <div className="meta">运行 {status}</div>
      <pre className="log">{log || "等待输出"}</pre>
    </div>
  );
}
