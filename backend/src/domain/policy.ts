import { DomainError } from "./errors";

export const PERMISSIONS = [
  "requirement:write",
  "architecture:write",
  "service:develop",
  "service:version:create",
  "service:test",
  "system:release",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type VersionStatus = "draft" | "ready_for_test" | "testing" | "passed" | "failed";

export interface RoleTemplate {
  code: string;
  name: string;
  description: string;
  duties: string;
  promptTemplate: string;
  permissions: Permission[];
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    code: "PM",
    name: "产品经理",
    description: "负责需求与验收标准",
    duties: "整理需求、编写验收标准、确认需求范围，不直接产生代码版本。",
    promptTemplate: "你是产品经理。输出应包含需求说明和可验证的验收标准。不要修改服务代码，不要创建版本。",
    permissions: ["requirement:write"],
  },
  {
    code: "ARCH",
    name: "系统架构师",
    description: "负责服务边界与接口契约",
    duties: "依据项目架构评估需求，并把需求分解成可交给开发工程师的任务。不发布版本。",
    promptTemplate: "你是系统架构师。以 architecture.md 中的项目架构为依据，评估需求是否符合架构，并按模块边界和接口把需求分解成开发任务。给出服务边界、接口契约和取舍。不要修改代码，不要创建远端分支，不要发布服务版本或系统版本。",
    permissions: ["architecture:write"],
  },
  {
    code: "SWE",
    name: "软件开发工程师",
    description: "负责指定服务的实现与候选版本",
    duties: "只在被分配的服务上实现需求，并创建候选服务版本。",
    promptTemplate: "你是软件开发工程师。只修改被分配的服务仓库。完成实现后说明变更，不要发布系统版本。",
    permissions: ["service:develop", "service:version:create"],
  },
  {
    code: "QA",
    name: "测试工程师",
    description: "负责指定服务的测试结论",
    duties: "针对被分配服务的候选版本执行测试，给出通过或失败结论。",
    promptTemplate: "你是测试工程师。针对被测服务版本验证验收标准，输出通过或失败及证据。不要改写已通过的版本 tag。",
    permissions: ["service:test"],
  },
  {
    code: "REL",
    name: "版本经理",
    description: "负责组装并发布系统版本",
    duties: "只把测试通过的服务版本组装为系统版本并发布。",
    promptTemplate: "你是版本经理。核对各服务版本均为通过后，组装系统版本清单。不要把草稿版本纳入系统版本。",
    permissions: ["system:release"],
  },
];

const SERVICE_SCOPED: Permission[] = ["service:develop", "service:version:create", "service:test"];

export function assignmentRequired(permissions: string[]): boolean {
  return permissions.some((permission) => SERVICE_SCOPED.includes(permission as Permission));
}

export function forksWorkspace(permissions: string[]): boolean {
  return permissions.includes("service:develop") || permissions.includes("service:test");
}

export function assertKnownPermissions(permissions: string[]): void {
  const unknown = permissions.filter((permission) => !PERMISSIONS.includes(permission as Permission));
  if (unknown.length > 0) {
    throw new DomainError(`未知权限：${unknown.join("、")}`);
  }
}

export function roleDeletionBlock<T extends { id: string; name: string; memberType: string }>(members: T[]) {
  if (members.length === 0) return null;
  return { message: "仍有成员使用该角色，不能删除", members };
}

const TRANSITIONS: Record<VersionStatus, VersionStatus[]> = {
  draft: ["ready_for_test"],
  ready_for_test: ["testing"],
  testing: [],
  passed: [],
  failed: [],
};

export function assertVersionTransition(from: VersionStatus, to: VersionStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new DomainError(`服务版本不能从 ${from} 变为 ${to}`);
  }
}

export function assertCanRecordTest(status: VersionStatus): void {
  if (status !== "ready_for_test" && status !== "testing") {
    throw new DomainError("只有待测试或测试中的版本可以提交测试结论");
  }
}

export function assertReleaseItems(
  items: { serviceId: string; status: VersionStatus }[],
  projectServiceIds: Set<string>,
): void {
  if (items.length === 0) throw new DomainError("系统版本至少包含一个服务");
  const seen = new Set<string>();
  for (const item of items) {
    if (!projectServiceIds.has(item.serviceId)) throw new DomainError("服务不属于当前项目");
    if (item.status !== "passed") throw new DomainError("只能纳入测试通过的服务版本");
    if (seen.has(item.serviceId)) throw new DomainError("同一个服务不能重复进入系统版本");
    seen.add(item.serviceId);
  }
}

export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function workspaceBranch(agentName: string, agentId: string, serviceName: string): string {
  const agentSlug = slug(agentName) || `a-${agentId.replace(/-/g, "").slice(0, 8)}`;
  const serviceSlug = slug(serviceName) || "service";
  return `agents/${agentSlug}/${serviceSlug}`;
}

export function branchSegment(raw: string): string {
  const value = raw
    .trim()
    .replace(/[\s/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!value) throw new DomainError("分支名不能为空");
  if (
    value === "@" ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".lock") ||
    value.endsWith(".") ||
    value.startsWith(".")
  ) {
    throw new DomainError("分支名包含不能使用的字符");
  }
  if (/[\u0000-\u001f\u007f~^:?*\[\\]/.test(value)) throw new DomainError("分支名包含不能使用的字符");
  return value;
}

export function memberBranchName(teamName: string, memberName: string, leaf: string): string {
  const name = `agentteams-${branchSegment(teamName)}/${branchSegment(memberName)}/${branchSegment(leaf)}`;
  if (name.length > 200) throw new DomainError("分支名过长");
  return name;
}

export function tagNameForVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export function imageTagFor(imageName: string, version: string): string {
  return `${imageName}:${version}`;
}

export interface PromptWorkspace {
  serviceName: string;
  repoUrl: string;
  branch: string;
  forked: boolean;
}

export function composeAgentPrompt(input: {
  roleName: string;
  duties: string;
  promptTemplate: string;
  dutyOverride: string;
  workspaces: PromptWorkspace[];
  testedVersion?: { serviceName: string; version: string } | null;
  workItem?: { title: string; description: string } | null;
  architectureDocument?: string;
  prompt: string;
}): string {
  const lines = [
    `角色：${input.roleName}`,
    `职责：${input.duties}`,
    input.promptTemplate.trim(),
    input.architectureDocument === undefined
      ? ""
      : [
          "系统提示词：architecture.md 是当前项目架构。评估需求时对照它判断是否符合架构；分解任务时按其中的模块边界和接口把工作拆给对应服务的开发工程师。不要修改代码，不要创建远端分支，不要发布版本。",
          input.architectureDocument.trim() ? `architecture.md：\n${input.architectureDocument.trim()}` : "architecture.md：还没有架构描述。",
        ].join("\n"),
    input.dutyOverride.trim() ? `补充职责：${input.dutyOverride.trim()}` : "",
    "工作区：",
    ...(input.workspaces.length
      ? input.workspaces.map(
          (workspace) =>
            `- ${workspace.serviceName} ${workspace.repoUrl} @ ${workspace.branch}${workspace.forked ? "（fork）" : "（Team 基线）"}`,
        )
      : ["- 当前没有挂载服务仓库"]),
    input.testedVersion ? `被测版本：${input.testedVersion.serviceName} ${input.testedVersion.version}` : "",
    input.workItem ? `工作项：${input.workItem.title}\n${input.workItem.description}` : "",
    `任务：${input.prompt.trim()}`,
  ].filter((line) => line !== "");
  return lines.join("\n");
}

export interface ParsedGitRepo {
  host: "github" | "gitlab";
  origin: string;
  hostname: string;
  owner: string;
  repo: string;
  projectPath: string;
}

export interface ParsedGitGroup {
  host: "github" | "gitlab";
  origin: string;
  hostname: string;
  path: string;
}

export interface RemoteRepo {
  name: string;
  path: string;
  repoUrl: string;
  defaultBranch: string;
}

export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const parsed = parseGitRepo(repoUrl);
  if (!parsed || parsed.host !== "github") return null;
  return { owner: parsed.owner, repo: parsed.repo };
}

function gitLocation(raw: string): { url: URL; host: "github" | "gitlab"; origin: string } | null {
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    const host = url.hostname.toLowerCase() === "github.com" || url.hostname.toLowerCase() === "www.github.com" ? "github" : "gitlab";
    const protocol = host === "github" ? "https:" : url.protocol;
    const hostname = host === "github" ? "github.com" : url.hostname.toLowerCase();
    const defaultPort = protocol === "https:" ? "443" : "80";
    const port = url.port && url.port !== defaultPort ? url.port : "";
    const origin = port ? `${protocol}//${hostname}:${port}` : `${protocol}//${hostname}`;
    return { url, host, origin };
  } catch {
    return null;
  }
}

export function parseGitGroup(raw: string): ParsedGitGroup | null {
  const located = gitLocation(raw);
  if (!located) return null;
  const parts = located.url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 1 || parts.some((part) => part === "." || part === "..")) return null;
  if (located.host === "github" && parts.length !== 1) return null;
  return { host: located.host, origin: located.origin, hostname: located.host === "github" ? "github.com" : located.url.hostname, path: parts.join("/") };
}

export function canonicalGroupUrl(group: ParsedGitGroup): string {
  return `${group.origin}/${group.path}`;
}

export function repoIdentity(repoUrl: string): string | null {
  const parsed = parseGitRepo(repoUrl);
  if (!parsed) return null;
  return `${parsed.origin}/${parsed.projectPath}`;
}

export function canonicalRepoUrl(repoUrl: string): string | null {
  const parsed = parseGitRepo(repoUrl);
  if (!parsed) return null;
  return `${parsed.origin}/${parsed.projectPath}.git`;
}

export function invalidGroupMessage(raw: string): string {
  const repo = parseGitRepo(raw);
  if (repo?.host === "github") return "GitHub 群组请填写组织地址，例如 https://github.com/epvs";
  return "群组地址需要是 GitLab 群组或 GitHub 组织，例如 http://192.168.31.85:8077/epvs";
}

export function invalidRepoMessage(): string {
  return "仓库地址需要包含所有者和仓库名，例如 http://192.168.31.85:8077/epvs/api";
}

export function parseGitRepo(repoUrl: string): ParsedGitRepo | null {
  const located = gitLocation(repoUrl);
  if (!located) return null;
  const parts = located.url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return {
    host: located.host,
    origin: located.origin,
    hostname: located.host === "github" ? "github.com" : located.url.hostname,
    owner: parts[0],
    repo: parts[parts.length - 1],
    projectPath: located.host === "github" ? `${parts[0]}/${parts[1]}` : parts.join("/"),
  };
}
