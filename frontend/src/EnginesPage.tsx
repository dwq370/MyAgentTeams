import { FormEvent, useEffect, useState } from "react";
import { api, AgentEngineItem, errorText } from "./api";

export function EnginesPage() {
  const [engines, setEngines] = useState<AgentEngineItem[]>([]);
  const [editing, setEditing] = useState<AgentEngineItem | null>(null);
  const [name, setName] = useState("");
  const [cursorApiKey, setCursorApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("composer-2.5");
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function load() {
    setEngines(await api<AgentEngineItem[]>("/api/agent-engines"));
  }

  useEffect(() => {
    load().catch((reason) => setError(errorText(reason)));
  }, []);

  function beginEdit(engine: AgentEngineItem) {
    setEditing(engine);
    setName(engine.name);
    setCursorApiKey("");
    setDefaultModel(engine.defaultModel);
    setOk("");
    setError("");
  }

  function beginCreate() {
    setEditing(null);
    setName("");
    setCursorApiKey("");
    setDefaultModel("composer-2.5");
    setOk("");
    setError("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setOk("");
    try {
      const body = {
        name,
        cursorApiKey: cursorApiKey || undefined,
        defaultModel,
      };
      const result = editing
        ? await api<AgentEngineItem & { models?: string[] }>(`/api/agent-engines/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api<AgentEngineItem & { models?: string[] }>("/api/agent-engines", { method: "POST", body: JSON.stringify(body) });
      setModels(result.models ?? []);
      setCursorApiKey("");
      setOk(editing ? "引擎已更新" : "引擎已创建");
      if (!editing) {
        setName("");
        setDefaultModel("composer-2.5");
      }
      await load();
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function remove(engine: AgentEngineItem) {
    if (!confirm(`删除 Agent 引擎 ${engine.name}？`)) return;
    setError("");
    try {
      await api(`/api/agent-engines/${engine.id}`, { method: "DELETE" });
      if (editing?.id === engine.id) beginCreate();
      await load();
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  return (
    <div className="grid-2">
      <section className="stack">
        <h1>Agent 引擎</h1>
        <p className="muted">引擎保存 Cursor API Key 和默认模型。测试环境在项目里配置。</p>
        {error && <div className="alert">{error}</div>}
        <div className="list">
          {engines.map((engine) => (
            <article key={engine.id} className="card stack">
              <div className="split">
                <div>
                  <strong>{engine.name}</strong>
                  <div className="meta">Cursor {engine.cursorHint ?? "未配置"} · {engine.defaultModel}</div>
                  <div className="meta">{engine.projects.length ? `用于 ${engine.projects.map((project) => project.name).join("、")}` : "还没有项目选用"}</div>
                </div>
                <div className="row">
                  <button className="btn" onClick={() => beginEdit(engine)}>修改</button>
                  <button className="btn danger" onClick={() => remove(engine)}>删除</button>
                </div>
              </div>
            </article>
          ))}
          {engines.length === 0 && <div className="card muted">还没有 Agent 引擎。</div>}
        </div>
      </section>
      <form className="card form" onSubmit={save}>
        <div className="split">
          <h2>{editing ? `修改 ${editing.name}` : "新建 Agent 引擎"}</h2>
          {editing && <button type="button" className="btn" onClick={beginCreate}>改为新建</button>}
        </div>
        <label>名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label>Cursor API Key<input value={cursorApiKey} onChange={(event) => setCursorApiKey(event.target.value)} placeholder={editing ? "留空则不修改" : ""} required={!editing} /></label>
        <label>默认模型<input value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} list="engine-models" /></label>
        <datalist id="engine-models">{models.map((model) => <option key={model} value={model} />)}</datalist>
        {ok && <div className="ok">{ok}</div>}
        <button className="btn primary">校验并保存</button>
      </form>
    </div>
  );
}
