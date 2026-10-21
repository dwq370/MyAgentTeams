import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { In, Repository } from "typeorm";
import { AgentEnginesService } from "../agent-engines/agent-engines.service";
import { composeAgentPrompt } from "../domain/policy";
import {
  AgentEntity,
  AgentRunEntity,
  AgentWorkspaceEntity,
  ProjectEntity,
  ProjectRoleEntity,
  ServiceEntity,
  ServiceVersionEntity,
  TeamEntity,
  TeamMemberEntity,
  TeamWorkspaceEntity,
  WorkItemEntity,
} from "../entities";
import { architectureDocument, writeArchitectureFile } from "../platform/architecture-file";
import { CursorPlatformAdapter, CursorRunOutcome, CursorUsage } from "../platform/cursor.adapter";
import { ModelSelection } from "../platform/model-selection";
import { GitRepoClient } from "../platform/git-repo";
import { AgentJob } from "../platform/queue.service";

@Injectable()
export class AgentJobRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentJobRunner.name);
  private worker?: Worker;
  private readonly redis: Redis;
  private readonly redisUrl: string;
  private readonly repoRoot: string;

  constructor(
    config: ConfigService,
    private readonly cursor: CursorPlatformAdapter,
    private readonly git: GitRepoClient,
    private readonly engines: AgentEnginesService,
    @InjectRepository(AgentEntity) private readonly agents: Repository<AgentEntity>,
    @InjectRepository(AgentRunEntity) private readonly runs: Repository<AgentRunEntity>,
    @InjectRepository(AgentWorkspaceEntity) private readonly workspaces: Repository<AgentWorkspaceEntity>,
    @InjectRepository(TeamMemberEntity) private readonly members: Repository<TeamMemberEntity>,
    @InjectRepository(TeamEntity) private readonly teams: Repository<TeamEntity>,
    @InjectRepository(ProjectRoleEntity) private readonly roles: Repository<ProjectRoleEntity>,
    @InjectRepository(ServiceEntity) private readonly services: Repository<ServiceEntity>,
    @InjectRepository(ServiceVersionEntity) private readonly versions: Repository<ServiceVersionEntity>,
    @InjectRepository(WorkItemEntity) private readonly workItems: Repository<WorkItemEntity>,
    @InjectRepository(ProjectEntity) private readonly projects: Repository<ProjectEntity>,
    @InjectRepository(TeamWorkspaceEntity) private readonly teamWorkspaces: Repository<TeamWorkspaceEntity>,
  ) {
    this.redisUrl = config.getOrThrow<string>("REDIS_URL");
    this.repoRoot = config.get<string>("REPO_ROOT") || "/var/agentteam/repos";
    this.redis = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
  }

  onModuleInit() {
    this.worker = new Worker("agent-jobs", async (job) => this.dispatch(job.data as AgentJob), {
      connection: { url: this.redisUrl, maxRetriesPerRequest: null },
      concurrency: 2,
    });
    this.worker.on("failed", (job, error) => {
      this.logger.error(`job ${job?.id} failed: ${error.message}`);
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.redis.quit();
  }

  private async dispatch(job: AgentJob) {
    if (job.kind === "create-agent") await this.createAgent(job.agentId);
    if (job.kind === "send-run") await this.sendRun(job.runId);
  }

  private async createAgent(agentId: string) {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent) return;
    const member = await this.members.findOne({ where: { id: agent.memberId } });
    if (!member) return;
    const team = await this.teams.findOne({ where: { id: member.teamId } });
    if (!team) return;
    const rows = await this.workspaces.find({ where: { agentId } });
    if (agent.externalAgentId) {
      await this.markAgent(agent, member, "active", null);
      return;
    }
    try {
      const secrets = await this.engines.secretsForProject(team.projectId);
      if (!secrets.selected) throw new Error("项目未选择 Agent 引擎");
      if (!secrets.apiKey) throw new Error("未配置 Cursor API Key");
      for (const workspace of rows) {
        if (workspace.branchOrigin === "created" && workspace.forkStatus === "planned") {
          const result = await this.git.ensureBranch(workspace.serviceId, workspace.repoUrl, workspace.baselineRef, workspace.branch);
          workspace.forkStatus = "ready";
          workspace.gitSha = result.sha;
        }
        try {
          if (workspace.branchOrigin === "baseline" && !(await this.git.tokenFor(workspace.serviceId))) {
            await this.workspaces.save(workspace);
            continue;
          }
          const local = await this.git.checkoutLocal(`workspaces/${workspace.id}`, workspace.serviceId, workspace.repoUrl, workspace.branch);
          workspace.localPath = local.localPath;
          workspace.gitSha = local.sha || workspace.gitSha;
        } catch (error) {
          if (workspace.branchOrigin !== "baseline") throw error;
        }
        await this.workspaces.save(workspace);
      }
      const externalAgentId = await this.cursor.createAgent({
        apiKey: secrets.apiKey,
        model: await this.cursor.resolveModel(secrets.apiKey, agent.model),
        repos: rows.map((workspace) => ({ url: workspace.repoUrl, startingRef: workspace.branch })),
        metadata: {
          agent_id: agent.id,
          team_id: team.id,
          project_id: team.projectId,
        },
      });
      agent.externalAgentId = externalAgentId;
      await this.agents.save(agent);
      await this.markAgent(agent, member, "active", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建 Agent 失败";
      const kept = rows.filter((workspace) => workspace.branchOrigin === "created" && !workspace.localPath).map((workspace) => workspace.branch);
      const hint = kept.length ? `${message}。远端分支未删除，请到 Git 上手动删除：${kept.join("、")}` : message;
      await this.markAgent(agent, member, "failed", hint);
    }
  }

  private async sendRun(runId: string) {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run || run.status === "cancelled") return;
    const agent = await this.agents.findOne({ where: { id: run.agentId } });
    const member = agent ? await this.members.findOne({ where: { id: agent.memberId } }) : null;
    const team = member ? await this.teams.findOne({ where: { id: member.teamId } }) : null;
    if (!agent || !member || !team || !agent.externalAgentId) {
      await this.finishRun(run, "startup_error", "startup", "Agent 还不可用");
      return;
    }
    const role = await this.roles.findOne({ where: { id: member.roleId } });
    if (!role) {
      await this.finishRun(run, "startup_error", "startup", "角色不存在");
      return;
    }
    const workspaces = await this.workspaces.find({ where: { agentId: agent.id } });
    const services = workspaces.length
      ? await this.services.find({ where: { id: In(workspaces.map((workspace) => workspace.serviceId)) } })
      : [];
    let testedVersion: { serviceName: string; version: string } | null = null;
    if (member.testedServiceVersionId) {
      const version = await this.versions.findOne({ where: { id: member.testedServiceVersionId } });
      const service = version ? services.find((item) => item.id === version.serviceId) : undefined;
      const fallback = version && !service ? await this.services.findOne({ where: { id: version.serviceId } }) : null;
      const name = service?.name ?? fallback?.name;
      if (version && name) testedVersion = { serviceName: name, version: version.version };
    }
    const workItem = run.workItemId ? await this.workItems.findOne({ where: { id: run.workItemId } }) : null;
    const architectureSource = typeof run.roleSnapshot?.source === "string" ? run.roleSnapshot.source : "";
    const project = await this.projects.findOne({ where: { id: team.projectId } });
    const composedPrompt = composeAgentPrompt({
      roleName: role.name,
      duties: role.duties,
      promptTemplate: role.promptTemplate,
      dutyOverride: member.dutyOverride,
      workspaces: workspaces.map((workspace) => ({
        serviceName: services.find((service) => service.id === workspace.serviceId)?.name ?? workspace.serviceId,
        repoUrl: workspace.repoUrl,
        branch: workspace.branch,
        forked: workspace.forked,
      })),
      testedVersion,
      workItem: workItem ? { title: workItem.title, description: workItem.description } : null,
      architectureDocument: role.permissions.includes("architecture:write")
        ? await architectureDocument(this.repoRoot, team.projectId, project?.architectureDescription ?? "")
        : undefined,
      prompt: run.prompt,
    });
    run.composedPrompt = composedPrompt;
    run.roleSnapshot = {
      ...run.roleSnapshot,
      roleId: role.id,
      code: role.code,
      name: role.name,
      duties: role.duties,
      promptTemplate: role.promptTemplate,
      permissions: role.permissions,
      dutyOverride: member.dutyOverride,
      capturedAt: new Date().toISOString(),
    };
    run.status = "running";
    await this.runs.save(run);
    await this.publish(run.id, { type: "status", status: "running" });
    if (workItem && workItem.status === "open") {
      workItem.status = "in_progress";
      await this.workItems.save(workItem);
    }
    const secrets = await this.engines.secretsForProject(team.projectId);
    if (!secrets.selected) {
      await this.finishRun(run, "startup_error", "startup", "项目未选择 Agent 引擎");
      return;
    }
    if (!secrets.apiKey) {
      await this.finishRun(run, "startup_error", "startup", "未配置 Cursor API Key");
      return;
    }
    const model = await this.cursor.resolveModel(secrets.apiKey, agent.model);
    if (run.purpose === "architecture" && architectureSource === "code") {
      await this.generateFromBaseline(run, agent, member, secrets.apiKey, model);
      return;
    }
    const sink = createLogSink((text) => this.appendLog(run.id, text));
    let answer = "";
    const outcome = await this.askCursor(
      run,
      agent,
      member,
      secrets.apiKey,
      model,
      composedPrompt,
      async (text) => {
        answer += text;
        await sink.text(text);
      },
      run.purpose === "architecture" ? (line) => sink.trace(line) : undefined,
    );
    await sink.flush();
    if ((outcome.text || "").trim() && !answer.trim()) {
      answer = outcome.text ?? "";
      await this.appendLog(run.id, outcome.text ?? "");
    }
    const measured = { durationMs: outcome.durationMs ?? null, usage: outcome.usage ?? null };
    const architectureText = run.purpose === "architecture" ? (outcome.text || answer).trim() : undefined;
    if (outcome.kind === "finished") await this.finishRun(run, "finished", null, null, measured, architectureText);
    else if (outcome.kind === "cancelled") await this.finishRun(run, "cancelled", null, null, measured);
    else if (outcome.kind === "run_error") await this.finishRun(run, "error", "run", outcome.message || "运行失败", measured);
    else {
      const message = [outcome.message || "Cursor 启动失败", outcome.helpUrl].filter(Boolean).join(" ");
      await this.finishRun(run, "startup_error", "startup", message, measured);
    }
  }

  private agentMissing(outcome: { kind: string; code?: string; message?: string }) {
    return outcome.kind === "startup_error" && (outcome.code === "agent_not_found" || Boolean(outcome.message?.includes("agent_not_found")));
  }

  private async askCursor(
    run: AgentRunEntity,
    agent: AgentEntity,
    member: TeamMemberEntity,
    apiKey: string,
    model: ModelSelection,
    prompt: string,
    onText: (text: string) => Promise<void>,
    onTrace?: (line: string) => Promise<void>,
  ): Promise<CursorRunOutcome> {
    const deliver = async (promptText: string, fresh = false) => {
      const shared = {
        apiKey,
        model,
        prompt: promptText,
        onText,
        onTrace,
        onRunId: async (externalRunId: string) => {
          this.logger.log(`run ${run.id} external ${externalRunId} agent ${agent.externalAgentId}`);
          await this.runs.update(run.id, { externalRunId });
        },
        shouldCancel: async () => Boolean(await this.redis.get(`cancel:${run.id}`)),
      };
      if (!fresh) return this.cursor.send({ ...shared, externalAgentId: agent.externalAgentId as string });
      const context = await this.cloudContext(agent.id);
      return this.cursor.sendFresh({
        ...shared,
        repos: context?.repos ?? [],
        metadata: context?.metadata ?? { agent_id: agent.id },
        onAgentId: async (externalAgentId) => {
          agent.externalAgentId = externalAgentId;
          await this.agents.update(agent.id, { externalAgentId, status: "active" });
          await this.members.update(member.id, { status: "active", failureReason: null });
          await this.traceNote(run.id, onTrace, "\n云端 Agent 已创建，开始处理当前任务\n");
        },
      });
    };
    let outcome = await deliver(prompt);
    if (!this.agentMissing(outcome)) return outcome;
    if (await this.redis.get(`cancel:${run.id}`)) return { kind: "cancelled" };
    this.logger.warn(`run ${run.id} cursor agent missing, creating on this prompt`);
    await this.traceNote(run.id, onTrace, "\nCursor 上还没有这个 Agent，改为用当前任务直接创建\n");
    return deliver(prompt, true);
  }

  private async cloudContext(agentId: string) {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    const member = agent ? await this.members.findOne({ where: { id: agent.memberId } }) : null;
    const team = member ? await this.teams.findOne({ where: { id: member.teamId } }) : null;
    if (!agent || !team) return null;
    const rows = await this.workspaces.find({ where: { agentId } });
    return {
      repos: rows.map((workspace) => ({ url: workspace.repoUrl, startingRef: workspace.branch })),
      metadata: { agent_id: agent.id, team_id: team.id, project_id: team.projectId },
    };
  }

  private async traceNote(runId: string, onTrace: ((line: string) => Promise<void>) | undefined, line: string) {
    if (onTrace) await onTrace(line);
    else await this.appendLog(runId, line);
  }

  private async generateFromBaseline(
    run: AgentRunEntity,
    agent: AgentEntity,
    member: TeamMemberEntity,
    apiKey: string,
    model: ModelSelection,
  ) {
    const sink = createLogSink((text) => this.appendLog(run.id, text));
    let measured = { durationMs: 0, usage: null as CursorUsage | null };
    let batches: { name: string; repoUrl: string; branch: string; text: string }[] = [];
    let notes: string[] = [];
    try {
      const loaded = await this.loadBaselineSource(run.targetProjectId, run.id);
      batches = loaded.batches;
      notes = loaded.notes;
    } catch (error) {
      await sink.flush();
      if (error instanceof RunCancelled) {
        await this.finishRun(run, "cancelled", null, null, measured);
        return;
      }
      const message = error instanceof Error ? error.message : "无法阅读代码";
      await this.finishRun(run, "startup_error", "startup", message, measured);
      return;
    }
    const findings: string[] = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      await sink.flush();
      await this.appendLog(run.id, `正在通读 ${batch.name} @ ${batch.branch}（${index + 1}/${batches.length}）\n`);
      if (await this.redis.get(`cancel:${run.id}`)) {
        await this.finishRun(run, "cancelled", null, null, measured);
        return;
      }
      let streamed = "";
      const outcome = await this.askCursor(
        run,
        agent,
        member,
        apiKey,
        model,
        [
          "你正在只读通读已经检出的基线代码。不要创建远端分支，不要修改代码。",
          "只根据这一批源码写简短笔记：这个目录做什么、对外接口、依赖的其他服务或系统。不超过 600 字。",
          `仓库 ${batch.name}`,
          batch.repoUrl,
          `基线 ${batch.branch}`,
          batch.text,
        ].join("\n"),
        async (text) => {
          streamed += text;
          await sink.text(text);
        },
        (line) => sink.trace(line),
      );
      await sink.flush();
      measured = combineMeasured(measured, outcome);
      if (outcome.kind !== "finished") {
        await this.finishMeasured(run, outcome, measured);
        return;
      }
      findings.push(`# ${batch.name} @ ${batch.branch}\n${(outcome.text || streamed).trim() || "这一批没有形成笔记。"}`);
    }
    await sink.flush();
    await this.appendLog(run.id, "\n正在整理架构描述\n");
    if (await this.redis.get(`cancel:${run.id}`)) {
      await this.finishRun(run, "cancelled", null, null, measured);
      return;
    }
    let streamed = "";
    const outcome = await this.askCursor(
      run,
      agent,
      member,
      apiKey,
      model,
      [
        "下面是按 Team 工作区基线只读通读源码后的笔记。请整理成项目架构描述。",
        "只输出架构文档正文，使用 Markdown。这份正文会保存为 architecture.md，并作为架构师之后评估需求和分解任务的依据。包含系统上下文、模块边界、主要接口、数据和处理流程，以及仓库之间的关联。不确定的地方明确写成假设。",
        notes.length ? `阅读时的限制：\n${notes.join("\n")}` : "",
        findings.join("\n\n"),
      ].filter(Boolean).join("\n\n"),
      async (text) => {
        streamed += text;
        await sink.text(text);
      },
      (line) => sink.trace(line),
    );
    await sink.flush();
    measured = combineMeasured(measured, outcome);
    if (outcome.kind !== "finished") {
      await this.finishMeasured(run, outcome, measured);
      return;
    }
    const document = (outcome.text || streamed).trim();
    if (document && !streamed.trim()) await this.appendLog(run.id, `\n${document}`);
    await this.finishRun(run, "finished", null, null, measured, document);
  }

  private async finishMeasured(
    run: AgentRunEntity,
    outcome: CursorRunOutcome,
    measured: { durationMs: number | null; usage: CursorUsage | null },
  ) {
    if (outcome.kind === "cancelled") {
      await this.finishRun(run, "cancelled", null, null, measured);
      return;
    }
    if (outcome.kind === "run_error") {
      await this.finishRun(run, "error", "run", outcome.message || "运行失败", measured);
      return;
    }
    const message = [outcome.message || "Cursor 启动失败", outcome.helpUrl].filter(Boolean).join(" ");
    await this.finishRun(run, "startup_error", "startup", message, measured);
  }

  private async appendLog(runId: string, text: string) {
    await this.runs.query(`UPDATE agent_run SET log = log || $1 WHERE id = $2`, [text, runId]);
    await this.publish(runId, { type: "append", text });
  }

  private async finishRun(
    run: AgentRunEntity,
    status: AgentRunEntity["status"],
    errorCategory: AgentRunEntity["errorCategory"],
    errorMessage: string | null,
    measured?: { durationMs: number | null; usage: AgentRunEntity["usage"] },
    architectureText?: string,
  ) {
    if (run.purpose === "architecture") {
      if (status === "cancelled") await this.appendLog(run.id, "\n已停止\n");
      else if (errorMessage) {
        const label = status === "startup_error" ? "启动失败" : "运行失败";
        await this.appendLog(run.id, `\n${label}：${errorMessage}\n`);
      }
    }
    await this.runs.update(run.id, {
      status,
      errorCategory,
      errorMessage,
      finishedAt: new Date(),
      durationMs: measured?.durationMs ?? null,
      usage: measured?.usage ?? null,
    });
    if (status === "finished" && run.purpose === "architecture" && run.targetProjectId) {
      const fresh = architectureText !== undefined ? null : await this.runs.findOne({ where: { id: run.id } });
      const text = (architectureText ?? fresh?.log ?? "").trim();
      if (text) {
        await this.projects.update(run.targetProjectId, { architectureDescription: text });
        await writeArchitectureFile(this.repoRoot, run.targetProjectId, text);
      }
    }
    await this.publish(run.id, { type: "status", status, errorMessage });
  }

  private async loadBaselineSource(projectId: string | null, runId: string) {
    if (!projectId) throw new Error("项目不存在");
    const teams = await this.teams.find({ where: { projectId } });
    const workspaces = teams.length
      ? await this.teamWorkspaces.find({ where: { teamId: In(teams.map((team) => team.id)) } })
      : [];
    const seen = new Map<string, TeamWorkspaceEntity>();
    for (const workspace of workspaces) if (!seen.has(workspace.serviceId)) seen.set(workspace.serviceId, workspace);
    if (seen.size === 0) throw new Error("项目里还没有代码仓，请先在 Team 工作区配置");
    const batches: { name: string; repoUrl: string; branch: string; text: string }[] = [];
    const notes: string[] = [];
    for (const workspace of seen.values()) {
      if (await this.redis.get(`cancel:${runId}`)) throw new RunCancelled();
      const service = await this.services.findOne({ where: { id: workspace.serviceId } });
      if (!service) continue;
      if (!(await this.git.tokenFor(service.id))) {
        const note = `${service.name} 未配置 Git 访问令牌，未检出。`;
        notes.push(note);
        await this.appendLog(runId, `${note}\n`);
        continue;
      }
      await this.appendLog(runId, `正在检出 ${service.name} @ ${workspace.baselineRef}\n`);
      let source: Awaited<ReturnType<GitRepoClient["readSourceLocal"]>>;
      try {
        const local = await this.git.checkoutLocal(`projects/${projectId}/${service.id}`, service.id, service.repoUrl, workspace.baselineRef);
        source = await this.git.readSourceLocal(local.localPath, service.name, service.repoUrl, workspace.baselineRef);
      } catch (error) {
        const message = error instanceof Error ? error.message : "检出失败";
        const note = `${service.name} 检出失败：${message}`;
        notes.push(note);
        await this.appendLog(runId, `${note}\n`);
        continue;
      }
      if (await this.redis.get(`cancel:${runId}`)) throw new RunCancelled();
      if (source.batches.length === 0) {
        const note = `${service.name} 的基线 ${workspace.baselineRef} 没有可通读的源码。`;
        notes.push(note);
        await this.appendLog(runId, `${note}\n`);
        continue;
      }
      source.batches.forEach((text, index) => {
        batches.push({
          name: source.batches.length > 1 ? `${service.name} 第 ${index + 1} 批` : service.name,
          repoUrl: service.repoUrl,
          branch: workspace.baselineRef,
          text,
        });
      });
      if (source.truncated) {
        const note = `${service.name} 源码过多，只通读了前面的源码文件。`;
        notes.push(note);
        await this.appendLog(runId, `${note}\n`);
      }
    }
    if (batches.length === 0) throw new Error(notes[0] || "没有可阅读的代码仓。请先配置 Git 访问令牌");
    return { batches, notes };
  }

  private async markAgent(agent: AgentEntity, member: TeamMemberEntity, status: "active" | "failed", failureReason: string | null) {
    await this.agents.update(agent.id, { status, externalAgentId: agent.externalAgentId });
    await this.members.update(member.id, { status, failureReason });
  }

  private async publish(runId: string, payload: unknown) {
    await this.redis.publish(`run:${runId}`, JSON.stringify(payload));
  }
}

class RunCancelled extends Error {
  constructor() {
    super("已停止");
  }
}

function createLogSink(write: (text: string) => Promise<void>) {
  let buffer = "";
  let last = Date.now();
  let kind: "none" | "text" | "trace" = "none";
  let chain = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work, work);
    return chain;
  };
  const flushBuffer = async () => {
    if (!buffer) return;
    const piece = buffer;
    buffer = "";
    last = Date.now();
    await write(piece);
  };
  return {
    text(text: string) {
      return enqueue(async () => {
        if (!text) return;
        if (kind === "trace" && !buffer.endsWith("\n") && !text.startsWith("\n")) buffer += "\n";
        kind = "text";
        buffer += text;
        if (Date.now() - last > 400) await flushBuffer();
      });
    },
    trace(line: string) {
      return enqueue(async () => {
        if (!line) return;
        if (kind === "text" && !buffer.endsWith("\n") && !line.startsWith("\n")) buffer += "\n";
        kind = "trace";
        buffer += line;
        if (line.includes("\n") || Date.now() - last > 400) await flushBuffer();
      });
    },
    flush() {
      return enqueue(flushBuffer);
    },
  };
}

function combineMeasured(
  current: { durationMs: number | null; usage: CursorUsage | null },
  outcome: CursorRunOutcome,
) {
  return {
    durationMs: (current.durationMs ?? 0) + (outcome.durationMs ?? 0),
    usage: mergeUsage(current.usage, outcome.usage ?? null),
  };
}

function mergeUsage(left: CursorUsage | null, right: CursorUsage | null): CursorUsage | null {
  if (!left) return right;
  if (!right) return left;
  const cost = (first: number | null, second: number | null) => (first == null && second == null ? null : (first ?? 0) + (second ?? 0));
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    rawCostCents: cost(left.rawCostCents, right.rawCostCents),
    chargedCents: cost(left.chargedCents, right.chargedCents),
  };
}
