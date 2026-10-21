type TraceTool = {
  type?: string;
  args?: Record<string, unknown>;
  result?: { status?: string; value?: Record<string, unknown> };
};

type TraceUpdate = {
  type?: string;
  text?: string;
  summary?: string;
  toolCall?: TraceTool;
  taskUpdate?: TraceUpdate;
};

const TOOL_LABEL: Record<string, string> = {
  read: "读取",
  grep: "搜索",
  semSearch: "语义搜索",
  glob: "查找文件",
  ls: "列出目录",
  shell: "执行",
  edit: "修改",
  write: "写入",
  delete: "删除",
  task: "子任务",
  mcp: "调用",
  readLints: "检查",
  createPlan: "制定计划",
  updateTodos: "更新待办",
  generateImage: "生成图片",
};

const ARG_KEYS = ["command", "pattern", "query", "glob", "globPattern", "path", "targetFile", "file", "targetDirectory", "url", "description", "prompt", "name", "toolName"];

export function createTraceFormatter() {
  let thinking = false;
  const format = (raw: unknown, nested = false): string | null => {
    const update = raw && typeof raw === "object" ? raw as TraceUpdate : undefined;
    if (!update?.type) return null;
    if (update.type === "thinking-delta") {
      const text = update.text ?? "";
      if (!text) return null;
      const prefix = thinking ? "" : "\n思考：";
      thinking = true;
      return prefix + text;
    }
    if (update.type === "thinking-completed") {
      if (!thinking) return null;
      thinking = false;
      return "\n";
    }
    if (update.type === "tool-call-started" && update.toolCall) {
      thinking = false;
      return formatTool(update.toolCall, "started");
    }
    if (update.type === "tool-call-completed" && update.toolCall) {
      return formatTool(update.toolCall, "completed");
    }
    if (update.type === "summary" && update.summary) return `\n摘要：${clip(update.summary, 500)}\n`;
    if (update.type === "tool-call-delta" && update.taskUpdate && !nested) return format(update.taskUpdate, true);
    return null;
  };
  return { format };
}

function formatTool(tool: TraceTool, phase: "started" | "completed") {
  const label = TOOL_LABEL[tool.type ?? ""] ?? (tool.type || "工具");
  if (phase === "completed") {
    const failed = tool.result?.status === "error";
    return `\n· ${label}${failed ? "失败" : "完成"}${failed ? "" : resultHint(tool)}\n`;
  }
  const summary = argSummary(tool.args);
  return `\n· ${label}${summary ? ` ${summary}` : ""}\n`;
}

function resultHint(tool: TraceTool) {
  const value = tool.result?.value;
  if (!value) return "";
  if (typeof value.totalLines === "number") return `，${value.totalLines} 行`;
  if (typeof value.exitCode === "number") return `，退出码 ${value.exitCode}`;
  return "";
}

function argSummary(args: Record<string, unknown> | undefined) {
  if (!args) return "";
  for (const key of ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return clip(value.replace(/\s+/g, " ").trim(), 180);
  }
  return "";
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
