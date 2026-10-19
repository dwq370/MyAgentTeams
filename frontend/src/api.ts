export class ApiError extends Error {
  status: number;
  details: {
    members?: { id: string; name: string; memberType: string }[];
    projects?: { id: string; name: string }[];
    teams?: { id: string; name: string }[];
  } | null;

  constructor(message: string, status: number, details: ApiError["details"]) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const TOKEN_KEY = "agentteam.token";

export function token() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(value: string | null) {
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const current = token();
  if (current) headers.set("Authorization", `Bearer ${current}`);
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = Array.isArray(body?.message) ? body.message.join("；") : body?.message || "请求失败";
    throw new ApiError(message, response.status, body?.details ?? null);
  }
  return body as T;
}

export function errorText(error: unknown) {
  if (error instanceof ApiError) {
    const names = error.details?.members?.map((member) => member.name).join("、")
      || error.details?.projects?.map((project) => project.name).join("、")
      || error.details?.teams?.map((team) => team.name).join("、");
    return names ? `${error.message}：${names}` : error.message;
  }
  return error instanceof Error ? error.message : "请求失败";
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  projectRole: "owner" | "admin" | "member";
  createdAt: string;
  counts?: { services: number; roles: number; teams: number; members: number; environments: number };
  agentEngine?: AgentEngineSummary | null;
  cursorConfigured?: boolean;
}

export interface AgentEngineSummary {
  id: string;
  name: string;
  kind: string;
  defaultModel: string;
}

export interface AgentEngineItem extends AgentEngineSummary {
  runtime: string;
  cursorHint: string | null;
  projects: { id: string; name: string }[];
}

export interface ServiceItem {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  imageName: string;
  host?: "github" | "gitlab";
  gitConfigured?: boolean;
  gitHint?: string | null;
}

export interface KubernetesProbe {
  kind: "kubernetes";
  client: "local";
  contexts: string[];
  currentContext: string | null;
  context: string;
  clusterName: string;
  server: string;
  kubernetesVersion: string;
  nodes: { name: string; status: string; roles: string }[];
  nodesError: string | null;
}

export interface SshProbeResult {
  kind: "standalone";
  host: string;
  port: number;
  username: string;
  fingerprint: string;
  output: string;
}

export interface TestEnvironment {
  id: string;
  name: string;
  kind: "standalone" | "kubernetes";
  url: string | null;
  deployEntry: string;
  sshHost: string | null;
  sshPort: number | null;
  sshUsername: string | null;
  passwordConfigured?: boolean;
  kubeContext: string | null;
  clusterServer: string | null;
  connectionInfo: KubernetesProbe | SshProbeResult | null;
}

export interface RoleItem {
  id: string;
  code: string;
  name: string;
  description: string;
  duties: string;
  promptTemplate: string;
  permissions: string[];
  isBuiltin: boolean;
}

export interface TeamItem {
  id: string;
  projectId: string;
  name: string;
  description: string;
  testEnvironment?: TestEnvironment | null;
  projectRole?: string;
  myMembership?: {
    memberId: string;
    roleId: string;
    roleName: string;
    permissions: string[];
    serviceIds: string[];
  } | null;
}

export interface WorkspaceItem {
  id: string;
  serviceId: string;
  serviceName: string;
  repoUrl: string;
  baselineRef: string;
}

export interface TeamSource {
  id: string;
  kind: "group" | "repo";
  name: string;
  url: string;
  baselineRef: string;
  tokenConfigured: boolean;
}

export interface CatalogRepo {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  serviceId: string | null;
}

export interface TeamCatalog {
  sources: TeamSource[];
  addresses: { serviceId: string; name: string; repoUrl: string; baselineRef: string }[];
  groups: { id: string; name: string; url: string; error: string | null; repos: CatalogRepo[] }[];
}

export interface MemberItem {
  id: string;
  name: string;
  memberType: "human" | "agent";
  userId: string | null;
  roleId: string;
  roleName: string;
  roleCode: string;
  permissions: string[];
  dutyOverride: string;
  status: "pending" | "active" | "failed";
  failureReason: string | null;
  testedServiceVersionId: string | null;
  serviceIds: string[];
  services: { id: string; name: string; repoUrl: string }[];
  contacts: { id: string; name: string; memberType: "human" | "agent"; roleName: string }[];
  agent: null | {
    id: string;
    platform: string;
    externalAgentId: string | null;
    model: string;
    runtime: string;
    status: string;
    workspaces: {
      id: string;
      serviceId: string;
      repoUrl: string;
      branch: string;
      baselineRef: string;
      forked: boolean;
      forkStatus: string;
      branchOrigin?: "baseline" | "created" | "selected";
    }[];
  };
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  rawCostCents: number | null;
  chargedCents: number | null;
}

export interface MonitorTask {
  id: string;
  title: string;
  description: string;
  status: "open" | "in_progress" | "done";
  updatedAt: string;
}

export interface MonitorSession {
  id: string;
  workItemId: string | null;
  prompt: string;
  status: "queued" | "running" | "finished" | "error" | "startup_error" | "cancelled";
  errorMessage: string | null;
  externalRunId: string | null;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  logPreview: string;
  usage: UsageSnapshot | null;
}

export interface MonitorMember {
  id: string;
  name: string;
  memberType: "human" | "agent";
  roleName: string;
  status: "pending" | "active" | "failed";
  failureReason: string | null;
  activity: "creating" | "failed" | "working" | "idle";
  model: string | null;
  currentTasks: MonitorTask[];
  currentSession: MonitorSession | null;
  processedTasks: MonitorTask[];
  sessions: MonitorSession[];
  usage: UsageSnapshot | null;
  usageNote: string | null;
}

export interface TeamMonitor {
  teamId: string;
  teamName: string;
  summary: {
    members: number;
    working: number;
    doneTasks: number;
    sessions: number;
    totalTokens: number;
    chargedCents: number | null;
  };
  members: MonitorMember[];
}

export interface VersionItem {
  id: string;
  serviceId: string;
  teamId: string;
  version: string;
  gitSha: string | null;
  status: "draft" | "ready_for_test" | "testing" | "passed" | "failed";
  tagName: string | null;
  tagStatus: string;
  tagError: string | null;
  imageTag: string | null;
}

export interface ReleaseItem {
  id: string;
  version: string;
  status: "draft" | "published";
  teamId: string;
  items: { serviceId: string; serviceVersionId: string }[];
}

export const PERMISSION_LABELS: Record<string, string> = {
  "requirement:write": "编写需求",
  "architecture:write": "编写架构与契约",
  "service:develop": "开发指定服务",
  "service:version:create": "创建服务候选版本",
  "service:test": "提交测试结论",
  "system:release": "发布系统版本",
};

export const VERSION_LABELS: Record<string, string> = {
  draft: "草稿",
  ready_for_test: "待测试",
  testing: "测试中",
  passed: "通过",
  failed: "失败",
};

export function needsServices(permissions: string[]) {
  return permissions.some((permission) =>
    ["service:develop", "service:version:create", "service:test"].includes(permission),
  );
}
