import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Response } from "express";
import { In, Repository } from "typeorm";
import { AccessService } from "../common/access.service";
import { DomainError } from "../domain/errors";
import { composeAgentPrompt } from "../domain/policy";
import {
  AgentEntity,
  AgentRunEntity,
  AgentWorkspaceEntity,
  ProjectRoleEntity,
  ServiceEntity,
  ServiceVersionEntity,
  TeamMemberEntity,
  WorkItemEntity,
} from "../entities";
import { GitRepoClient } from "../platform/git-repo";
import { QueueService } from "../platform/queue.service";

const TERMINAL = new Set(["finished", "error", "startup_error", "cancelled"]);

@Injectable()
export class AgentsService {
  constructor(
    private readonly access: AccessService,
    private readonly queue: QueueService,
    private readonly git: GitRepoClient,
    @InjectRepository(AgentEntity) private readonly agents: Repository<AgentEntity>,
    @InjectRepository(AgentRunEntity) private readonly runs: Repository<AgentRunEntity>,
    @InjectRepository(AgentWorkspaceEntity) private readonly workspaces: Repository<AgentWorkspaceEntity>,
    @InjectRepository(TeamMemberEntity) private readonly members: Repository<TeamMemberEntity>,
    @InjectRepository(ProjectRoleEntity) private readonly roles: Repository<ProjectRoleEntity>,
    @InjectRepository(ServiceEntity) private readonly services: Repository<ServiceEntity>,
    @InjectRepository(ServiceVersionEntity) private readonly versions: Repository<ServiceVersionEntity>,
    @InjectRepository(WorkItemEntity) private readonly workItems: Repository<WorkItemEntity>,
  ) {}

  async preview(userId: string, agentId: string, input: { prompt: string; workItemId?: string }) {
    const context = await this.loadContext(userId, agentId, { prompt: input.prompt, workItemId: input.workItemId });
    return { composedPrompt: context.composedPrompt, roleSnapshot: context.roleSnapshot };
  }

  async createRun(userId: string, agentId: string, input: { prompt: string; workItemId?: string }) {
    const context = await this.loadContext(userId, agentId, { workItemId: input.workItemId });
    if (context.agent.status !== "active" || !context.agent.externalAgentId) {
      throw new DomainError("Agent 还不可用", 400);
    }
    const active = await this.runs.find({ where: { agentId, status: In(["queued", "running"]) } });
    if (active.length > 0) throw new DomainError("Agent 正在执行任务", 409);
    const run = await this.runs.save(
      this.runs.create({
        agentId,
        workItemId: input.workItemId ?? null,
        prompt: input.prompt.trim(),
        composedPrompt: "",
        roleSnapshot: {},
        status: "queued",
        log: "",
      }),
    );
    await this.queue.enqueue({ kind: "send-run", runId: run.id }, `run-${run.id}`);
    return run;
  }

  async listRuns(userId: string, agentId: string) {
    await this.loadContext(userId, agentId);
    return this.runs.find({ where: { agentId }, order: { createdAt: "DESC" }, take: 30 });
  }

  async cancel(userId: string, agentId: string, runId: string) {
    await this.loadContext(userId, agentId);
    const run = await this.runs.findOne({ where: { id: runId, agentId } });
    if (!run) throw new DomainError("运行不存在", 404);
    if (TERMINAL.has(run.status)) return run;
    await this.queue.redis.set(`cancel:${runId}`, "1", "EX", 60 * 60 * 6);
    if (run.status === "queued") {
      const job = await this.queue.queue.getJob(`run-${runId}`);
      let active = false;
      if (job) {
        active = (await job.getState()) === "active";
        if (!active) await job.remove().catch(() => undefined);
      }
      if (!active) {
        run.status = "cancelled";
        run.finishedAt = new Date();
        await this.runs.save(run);
        await this.queue.redis.publish(`run:${runId}`, JSON.stringify({ type: "status", status: "cancelled" }));
      }
    }
    return this.runs.findOneOrFail({ where: { id: runId } });
  }

  async stream(userId: string, agentId: string, runId: string, res: Response) {
    await this.loadContext(userId, agentId);
    const run = await this.runs.findOne({ where: { id: runId, agentId } });
    if (!run) throw new DomainError("运行不存在", 404);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ type: "snapshot", status: run.status, log: run.log, errorMessage: run.errorMessage });
    if (TERMINAL.has(run.status)) {
      res.end();
      return;
    }
    const subscriber = this.queue.redis.duplicate();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await subscriber.quit().catch(() => undefined);
      if (!res.writableEnded) res.end();
    };
    subscriber.on("message", (_channel, message) => {
      send(JSON.parse(message));
      const payload = JSON.parse(message) as { type?: string; status?: string };
      if (payload.type === "status" && payload.status && TERMINAL.has(payload.status)) void close();
    });
    await subscriber.subscribe(`run:${runId}`);
    res.on("close", () => void close());
  }

  async sync(userId: string, agentId: string) {
    const context = await this.loadContext(userId, agentId);
    const results = [];
    for (const workspace of context.workspaces.filter((item) => item.forked && item.forkStatus === "ready")) {
      const outcome = await this.git.syncBranch(workspace.serviceId, workspace.repoUrl, workspace.branch, workspace.baselineRef);
      results.push({ workspaceId: workspace.id, branch: workspace.branch, outcome });
    }
    return { results };
  }

  private async loadContext(userId: string, agentId: string, options?: { prompt?: string; workItemId?: string }) {
    const workItemId = options?.workItemId;
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent) throw new DomainError("Agent 不存在", 404);
    const member = await this.members.findOne({ where: { id: agent.memberId } });
    if (!member) throw new DomainError("成员不存在", 404);
    const { team, membership } = await this.access.requireTeam(userId, member.teamId, "member");
    const human = await this.members.findOne({ where: { teamId: member.teamId, userId, memberType: "human" } });
    if (!human && membership.projectRole === "member") throw new DomainError("只有 Team 成员或项目管理员可以操作 Agent", 403);
    const role = await this.roles.findOne({ where: { id: member.roleId } });
    if (!role) throw new DomainError("角色不存在", 404);
    const workspaces = await this.workspaces.find({ where: { agentId } });
    const services = workspaces.length
      ? await this.services.find({ where: { id: In(workspaces.map((workspace) => workspace.serviceId)) } })
      : [];
    let testedVersion: { serviceName: string; version: string } | null = null;
    if (member.testedServiceVersionId) {
      const version = await this.versions.findOne({ where: { id: member.testedServiceVersionId } });
      const service = version ? await this.services.findOne({ where: { id: version.serviceId } }) : null;
      if (version && service) testedVersion = { serviceName: service.name, version: version.version };
    }
    let workItem: WorkItemEntity | null = null;
    if (workItemId) {
      workItem = await this.workItems.findOne({ where: { id: workItemId, teamId: member.teamId } });
      if (!workItem) throw new DomainError("工作项不存在", 404);
    }
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
      prompt: options?.prompt ?? "",
    });
    return {
      agent,
      member,
      role,
      workspaces,
      projectId: team.projectId,
      workItem,
      composedPrompt,
      roleSnapshot: {
        roleId: role.id,
        code: role.code,
        name: role.name,
        duties: role.duties,
        promptTemplate: role.promptTemplate,
        permissions: role.permissions,
        dutyOverride: member.dutyOverride,
      },
    };
  }
}
