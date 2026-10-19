import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorText, MonitorMember, MonitorSession, TeamMonitor, UsageSnapshot } from "./api";

const ACTIVITY_LABELS = { creating: "创建中", failed: "异常", working: "处理中", idle: "空闲" };
const SESSION_LABELS: Record<MonitorSession["status"], string> = {
  queued: "排队",
  running: "进行中",
  finished: "已完成",
  error: "失败",
  startup_error: "启动失败",
  cancelled: "已取消",
};

export function TeamMonitorPage() {
  const { projectId = "", teamId = "" } = useParams();
  return (
    <div className="stack">
      <Link to={`/projects/${projectId}/teams/${teamId}`}>返回 Team</Link>
      <TeamMonitorView projectId={projectId} teamId={teamId} />
    </div>
  );
}

export function TeamMonitorView({ projectId, teamId, embedded = false }: { projectId: string; teamId: string; embedded?: boolean }) {
  const [monitor, setMonitor] = useState<TeamMonitor | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setMonitor(await api<TeamMonitor>(`/api/teams/${teamId}/monitor`));
  }

  useEffect(() => {
    setMonitor(null);
    load().catch((reason) => setError(errorText(reason)));
  }, [teamId]);

  useEffect(() => {
    if (!monitor || monitor.summary.working === 0) return;
    const timer = window.setInterval(() => { load().catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, [monitor?.summary.working, teamId]);

  if (!monitor) return <p>{error || "加载监控"}</p>;
  const Title = embedded ? "h2" : "h1";

  return (
    <div className="stack">
      <div className="toprow">
        <div>
          <Title>{monitor.teamName} 监控</Title>
          {embedded && <Link to={`/projects/${projectId}/teams/${teamId}`}>进入 Team</Link>}
        </div>
        <button className="btn" onClick={() => load().catch((reason) => setError(errorText(reason)))}>刷新</button>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="stats">
        <div className="card stat"><span className="muted">成员</span><strong>{monitor.summary.members}</strong></div>
        <div className="card stat"><span className="muted">正在处理</span><strong>{monitor.summary.working}</strong></div>
        <div className="card stat"><span className="muted">已处理任务</span><strong>{monitor.summary.doneTasks}</strong></div>
        <div className="card stat"><span className="muted">Token</span><strong>{formatTokens(monitor.summary.totalTokens)}</strong><span className="meta">{formatCost(monitor.summary.chargedCents)}</span></div>
      </div>
      {monitor.members.length === 0 && <p className="muted">这个 Team 还没有成员。</p>}
      {monitor.members.map((member) => <MemberMonitor key={member.id} member={member} />)}
    </div>
  );
}

function MemberMonitor({ member }: { member: MonitorMember }) {
  return (
    <article className="card stack">
      <div className="split">
        <div>
          <h2>{member.name}</h2>
          <div className="meta">{member.memberType === "agent" ? "Agent" : "人类"} · {member.roleName}{member.model ? ` · ${member.model}` : ""}</div>
        </div>
        <span className={pillClass(member.activity)}>{activityLabel(member)}</span>
      </div>
      {member.failureReason && <div className="alert">{member.failureReason}</div>}
      <div>
        <strong>当前任务</strong>
        {member.currentTasks.length === 0 && !member.currentSession && <p className="muted">当前没有正在处理的任务。</p>}
        {member.currentTasks.map((task) => (
          <div key={task.id}>
            <div>{task.title}</div>
            {task.description && <div className="muted">{task.description}</div>}
          </div>
        ))}
        {member.currentSession && (
          <div className="meta">会话 {SESSION_LABELS[member.currentSession.status]} · {short(member.currentSession.prompt)}</div>
        )}
      </div>
      <div>
        <strong>Token 用量</strong>
        {member.usage ? <UsageLine usage={member.usage} /> : <p className="muted">{member.usageNote}</p>}
        {member.usage && member.usageNote && <p className="meta">{member.usageNote}</p>}
      </div>
      <div className="two-col">
        <div>
          <strong>已处理任务</strong>
          {member.processedTasks.length === 0 && <p className="muted">还没有已处理任务。</p>}
          <div className="source-repos">
            {member.processedTasks.map((task) => (
              <div key={task.id}>
                <div>{task.title}</div>
                <div className="meta">{formatTime(task.updatedAt)}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <strong>会话历史</strong>
          {member.sessions.length === 0 && <p className="muted">{member.memberType === "agent" ? "还没有会话。" : "人类成员没有 Agent 会话。"}</p>}
          <div className="source-repos">
            {member.sessions.map((session) => <SessionRow key={session.id} session={session} />)}
          </div>
        </div>
      </div>
    </article>
  );
}

function SessionRow({ session }: { session: MonitorSession }) {
  return (
    <details>
      <summary>
        {short(session.prompt)}
        <span className="meta"> {SESSION_LABELS[session.status]} · {formatTime(session.createdAt)}{session.durationMs != null ? ` · ${formatDuration(session.durationMs)}` : ""}{session.usage ? ` · ${formatTokens(session.usage.totalTokens)} token` : ""}</span>
      </summary>
      {session.errorMessage && <div className="alert">{session.errorMessage}</div>}
      {session.usage && <UsageLine usage={session.usage} />}
      {session.logPreview && <pre className="log">{session.logPreview}</pre>}
    </details>
  );
}

function UsageLine({ usage }: { usage: UsageSnapshot }) {
  return (
    <div className="meta">
      输入 {formatTokens(usage.inputTokens)} · 输出 {formatTokens(usage.outputTokens)} · 缓存读取 {formatTokens(usage.cacheReadTokens)} · 合计 {formatTokens(usage.totalTokens)}
      {usage.reasoningTokens > 0 ? ` · 推理 ${formatTokens(usage.reasoningTokens)}` : ""}
      {formatCost(usage.chargedCents) ? ` · 费用 ${formatCost(usage.chargedCents)}` : ""}
    </div>
  );
}

function activityLabel(member: MonitorMember) {
  if (member.activity === "idle" && member.memberType === "human") return "在岗";
  return ACTIVITY_LABELS[member.activity];
}

function pillClass(activity: MonitorMember["activity"]) {
  if (activity === "failed") return "pill bad";
  if (activity === "working" || activity === "creating") return "pill wait";
  return "pill good";
}

function short(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line || "未命名会话";
}

function formatTokens(value: number) {
  return value.toLocaleString("zh-CN");
}

function formatCost(cents: number | null) {
  if (cents == null) return "";
  return `$${(cents / 100).toFixed(4)}`;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} 毫秒`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
