import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorText, MemberItem, TeamItem, token } from "./api";

interface AgentRun {
  id: string;
  prompt: string;
  status: "queued" | "running" | "finished" | "error" | "startup_error" | "cancelled";
  errorMessage: string | null;
  log: string;
  createdAt: string;
}

const STATUS_LABELS: Record<AgentRun["status"], string> = {
  queued: "排队",
  running: "进行中",
  finished: "已完成",
  error: "失败",
  startup_error: "启动失败",
  cancelled: "已取消",
};

function isLive(status: AgentRun["status"]) {
  return status === "queued" || status === "running";
}

function pickDefault(members: MemberItem[]) {
  const agents = members.filter((member) => member.memberType === "agent");
  return agents.find((member) => member.roleCode === "PM")
    ?? agents.find((member) => member.roleName.includes("产品经理") || member.name.includes("产品经理"))
    ?? agents[0]
    ?? null;
}

function short(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 42 ? `${line.slice(0, 42)}…` : line || "空会话";
}

export function TeamEntryPage() {
  const { projectId = "", teamId = "" } = useParams();
  const [teamName, setTeamName] = useState("");
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [memberId, setMemberId] = useState("");
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<TeamItem>(`/api/teams/${teamId}`),
      api<MemberItem[]>(`/api/teams/${teamId}/members`),
    ]).then(([team, items]) => {
      if (cancelled) return;
      setTeamName(team.name);
      setMembers(items);
      setMemberId(pickDefault(items)?.id ?? "");
    }).catch((reason) => { if (!cancelled) setError(errorText(reason)); });
    return () => { cancelled = true; };
  }, [teamId]);

  const member = members.find((item) => item.id === memberId) ?? null;
  const agents = members.filter((item) => item.memberType === "agent");
  const agentId = member?.agent?.id ?? "";
  const selected = runs.find((run) => run.id === selectedId) ?? null;
  const busy = runs.some((run) => isLive(run.status));
  const selectedLive = Boolean(selected && isLive(selected.status));

  useEffect(() => {
    setSelectedId("");
    if (!agentId) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    api<AgentRun[]>(`/api/agents/${agentId}/runs`)
      .then((items) => { if (!cancelled) setRuns(items); })
      .catch((reason) => { if (!cancelled) setError(errorText(reason)); });
    return () => { cancelled = true; };
  }, [agentId]);

  useEffect(() => {
    if (!selectedLive || !agentId || !selectedId) return;
    const controller = new AbortController();
    let stopped = false;
    (async () => {
      const response = await fetch(`/api/agents/${agentId}/runs/${selected.id}/events`, {
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
          const payload = JSON.parse(line.slice(5).trim()) as { type?: string; log?: string; text?: string; status?: string; errorMessage?: string };
          setRuns((current) => current.map((run) => {
            if (run.id !== selectedId) return run;
            const next = { ...run };
            if (payload.type === "snapshot") {
              next.log = payload.log ?? "";
              if (payload.status) next.status = payload.status as AgentRun["status"];
            }
            if (payload.type === "append" && payload.text) next.log += payload.text;
            if (payload.type === "status" && payload.status) next.status = payload.status as AgentRun["status"];
            if (payload.errorMessage) next.errorMessage = payload.errorMessage;
            return next;
          }));
        }
      }
    })().catch(() => undefined);
    return () => { stopped = true; controller.abort(); };
  }, [agentId, selectedId, selectedLive]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!agentId || !draft.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      const run = await api<AgentRun>(`/api/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ prompt: draft.trim() }),
      });
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setSelectedId(run.id);
      setDraft("");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="stack">
      <div className="toprow">
        <div>
          <Link to={`/projects/${projectId}?section=teams`}>返回 Team</Link>
          <h1>{teamName || "入口"}</h1>
        </div>
        {agents.length > 0 && (
          <label className="agent-pick">对话 Agent
            <select value={memberId} onChange={(event) => setMemberId(event.target.value)}>
              {agents.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.roleName}</option>)}
            </select>
          </label>
        )}
      </div>
      {error && <div className="alert">{error}</div>}
      {agents.length === 0 ? (
        <div className="card muted">这个 Team 还没有 Agent。先进入 Team，加入产品经理或其他 Agent。</div>
      ) : (
        <div className="chat">
          <aside className="chat-side">
            <div className="chat-side-head">
              <strong>会话历史</strong>
              <button className="btn" type="button" onClick={() => setSelectedId("")}>新对话</button>
            </div>
            <div className="chat-side-list">
              {runs.length === 0 && <p className="muted chat-empty">还没有会话。</p>}
              {runs.map((run) => (
                <button key={run.id} type="button" className={run.id === selectedId ? "session-item active" : "session-item"} onClick={() => setSelectedId(run.id)}>
                  <div>{short(run.prompt)}</div>
                  <div className="meta">{STATUS_LABELS[run.status]} · {formatTime(run.createdAt)}</div>
                </button>
              ))}
            </div>
          </aside>
          <section className="chat-main">
            <div className="chat-log">
              {!selected && <p className="muted">和{member?.name ?? "Agent"}开始新的对话。左侧可以回看已有会话。</p>}
              {selected && (
                <>
                  <div className="bubble mine">
                    <div className="meta">我 · {formatTime(selected.createdAt)}</div>
                    <div className="chat-text">{selected.prompt}</div>
                  </div>
                  <div className="bubble theirs">
                    <div className="meta">{member?.name} · {STATUS_LABELS[selected.status]}</div>
                    {selected.errorMessage && <div className="alert">{selected.errorMessage}</div>}
                    <div className="chat-text">{selected.log || (isLive(selected.status) ? "正在回复…" : "没有输出")}</div>
                  </div>
                </>
              )}
            </div>
            <form className="chat-compose" onSubmit={send}>
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={member ? `发给 ${member.name}` : "输入内容"} disabled={member?.status !== "active" || !agentId || busy || sending} />
              <button className="btn primary" disabled={member?.status !== "active" || !agentId || busy || sending || !draft.trim()}>发送</button>
            </form>
            {member && member.status !== "active" && <p className="meta chat-note">{member.status === "failed" ? "这个 Agent 创建失败，暂时不能对话。" : "这个 Agent 还在创建，暂时不能对话。"}</p>}
            {member?.status === "active" && busy && <p className="meta chat-note">当前 Agent 正在回复，完成后再发送下一条。</p>}
          </section>
        </div>
      )}
    </div>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false });
}
