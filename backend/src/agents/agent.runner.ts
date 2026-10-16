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
  ProjectRoleEntity,
  ServiceEntity,
  ServiceVersionEntity,
  TeamEntity,
  TeamMemberEntity,
  WorkItemEntity,
} from "../entities";
import { CursorPlatformAdapter } from "../platform/cursor.adapter";
import { GitRepoClient } from "../platform/git-repo";
import { AgentJob } from "../platform/queue.service";

@Injectable()
export class AgentJobRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentJobRunner.name);
  private worker?: Worker;
  private readonly redis: Redis;
  private readonly redisUrl: string;

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
  ) {
    this.redisUrl = config.getOrThrow<string>("REDIS_URL");
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
    const created: AgentWorkspaceEntity[] = [];
    try {
      const secrets = await this.engines.secretsForProject(team.projectId);
      const forked = rows.filter((row) => row.forked);
      if (!secrets.selected) throw new Error("项目未选择 Agent 引擎");
      if (!secrets.apiKey) throw new Error("未配置 Cursor API Key");
      for (const workspace of forked) {
        const result = await this.git.ensureBranch(workspace.serviceId, workspace.repoUrl, workspace.baselineRef, workspace.branch);
        if (result.created) created.push(workspace);
        workspace.forkStatus = "ready";
        workspace.gitSha = result.sha;
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
      for (const workspace of created) {
        await this.git.deleteBranch(workspace.serviceId, workspace.repoUrl, workspace.branch).catch(() => undefined);
        workspace.forkStatus = "failed";
        workspace.gitSha = null;
        await this.workspaces.save(workspace);
      }
      await this.markAgent(agent, member, "failed", message);
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
      prompt: run.prompt,
    });
    run.composedPrompt = composedPrompt;
    run.roleSnapshot = {
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
    let buffer = "";
    let lastFlush = Date.now();
    const flush = async () => {
      if (!buffer) return;
      const piece = buffer;
      buffer = "";
      lastFlush = Date.now();
      await this.runs.query(`UPDATE agent_run SET log = log || $1 WHERE id = $2`, [piece, run.id]);
      await this.publish(run.id, { type: "append", text: piece });
    };
    const outcome = await this.cursor.send({
      apiKey: secrets.apiKey,
      externalAgentId: agent.externalAgentId,
      model: await this.cursor.resolveModel(secrets.apiKey, agent.model),
      prompt: composedPrompt,
      onText: async (text) => {
        buffer += text;
        if (Date.now() - lastFlush > 400) await flush();
      },
      onRunId: async (externalRunId) => {
        this.logger.log(`run ${run.id} external ${externalRunId} agent ${agent.externalAgentId}`);
        await this.runs.update(run.id, { externalRunId });
      },
      shouldCancel: async () => Boolean(await this.redis.get(`cancel:${run.id}`)),
    });
    await flush();
    if (outcome.text) {
      const current = await this.runs.findOne({ where: { id: run.id } });
      if (current && !current.log.trim()) {
        await this.runs.query(`UPDATE agent_run SET log = log || $1 WHERE id = $2`, [outcome.text, run.id]);
        await this.publish(run.id, { type: "append", text: outcome.text });
      }
    }
    if (outcome.kind === "finished") await this.finishRun(run, "finished", null, null);
    else if (outcome.kind === "cancelled") await this.finishRun(run, "cancelled", null, null);
    else if (outcome.kind === "run_error") await this.finishRun(run, "error", "run", outcome.message || "运行失败");
    else {
      const message = [outcome.message || "Cursor 启动失败", outcome.helpUrl].filter(Boolean).join(" ");
      await this.finishRun(run, "startup_error", "startup", message);
    }
  }

  private async finishRun(
    run: AgentRunEntity,
    status: AgentRunEntity["status"],
    errorCategory: AgentRunEntity["errorCategory"],
    errorMessage: string | null,
  ) {
    await this.runs.update(run.id, { status, errorCategory, errorMessage, finishedAt: new Date() });
    await this.publish(run.id, { type: "status", status, errorMessage });
  }

  private async markAgent(agent: AgentEntity, member: TeamMemberEntity, status: "active" | "failed", failureReason: string | null) {
    await this.agents.update(agent.id, { status, externalAgentId: agent.externalAgentId });
    await this.members.update(member.id, { status, failureReason });
  }

  private async publish(runId: string, payload: unknown) {
    await this.redis.publish(`run:${runId}`, JSON.stringify(payload));
  }
}
