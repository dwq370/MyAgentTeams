import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, IsNull, Repository } from "typeorm";
import { AgentEnginesService } from "../agent-engines/agent-engines.service";
import { AccessService } from "../common/access.service";
import { decryptSecret, encryptSecret } from "../common/crypto";
import { DomainError } from "../domain/errors";
import {
  assignmentRequired,
  canonicalGroupUrl,
  canonicalRepoUrl,
  forksWorkspace,
  invalidGroupMessage,
  invalidRepoMessage,
  memberBranchName,
  parseGitGroup,
  parseGitRepo,
  RemoteRepo,
  repoIdentity,
} from "../domain/policy";
import {
  AgentEntity,
  AgentWorkspaceEntity,
  MemberContactEntity,
  MemberServiceEntity,
  ProjectRoleEntity,
  RunUsageSnapshot,
  ServiceEntity,
  ServiceVersionEntity,
  TeamEntity,
  TeamMemberEntity,
  TeamSourceEntity,
  TeamWorkspaceEntity,
  TestEnvironmentEntity,
  UserEntity,
  WorkItemEntity,
} from "../entities";
import { CursorPlatformAdapter, CursorUsage } from "../platform/cursor.adapter";
import { GitRepoClient } from "../platform/git-repo";
import { QueueService } from "../platform/queue.service";

@Injectable()
export class TeamsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: AccessService,
    private readonly queue: QueueService,
    private readonly engines: AgentEnginesService,
    private readonly config: ConfigService,
    private readonly git: GitRepoClient,
    private readonly cursor: CursorPlatformAdapter,
    @InjectRepository(TeamEntity) private readonly teams: Repository<TeamEntity>,
    @InjectRepository(TestEnvironmentEntity) private readonly environments: Repository<TestEnvironmentEntity>,
    @InjectRepository(TeamWorkspaceEntity) private readonly workspaces: Repository<TeamWorkspaceEntity>,
    @InjectRepository(TeamSourceEntity) private readonly sources: Repository<TeamSourceEntity>,
    @InjectRepository(TeamMemberEntity) private readonly members: Repository<TeamMemberEntity>,
    @InjectRepository(ProjectRoleEntity) private readonly roles: Repository<ProjectRoleEntity>,
    @InjectRepository(ServiceEntity) private readonly services: Repository<ServiceEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(AgentEntity) private readonly agents: Repository<AgentEntity>,
    @InjectRepository(AgentWorkspaceEntity) private readonly agentWorkspaces: Repository<AgentWorkspaceEntity>,
    @InjectRepository(MemberServiceEntity) private readonly memberServices: Repository<MemberServiceEntity>,
    @InjectRepository(MemberContactEntity) private readonly contacts: Repository<MemberContactEntity>,
    @InjectRepository(WorkItemEntity) private readonly workItems: Repository<WorkItemEntity>,
    @InjectRepository(ServiceVersionEntity) private readonly versions: Repository<ServiceVersionEntity>,
  ) {}

  async create(userId: string, projectId: string, input: { name: string; description?: string }) {
    await this.access.requireProject(userId, projectId, "admin");
    const team = await this.teams.save(
      this.teams.create({
        projectId,
        name: input.name.trim(),
        description: input.description?.trim() ?? "",
      }),
    );
    return team;
  }

  async list(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "member");
    const teams = await this.teams.find({ where: { projectId }, order: { createdAt: "DESC" } });
    return this.attachEnvironments(teams);
  }

  async get(userId: string, teamId: string) {
    const { team, membership } = await this.access.requireTeam(userId, teamId, "member");
    const human = await this.members.findOne({ where: { teamId, userId, memberType: "human" } });
    const role = human ? await this.roles.findOne({ where: { id: human.roleId } }) : null;
    const serviceLinks = human ? await this.memberServices.find({ where: { memberId: human.id } }) : [];
    const [presented] = await this.attachEnvironments([team]);
    return {
      ...presented,
      myMembership: human
        ? {
            memberId: human.id,
            roleId: human.roleId,
            roleName: role?.name ?? "",
            permissions: role?.permissions ?? [],
            serviceIds: serviceLinks.map((link) => link.serviceId),
          }
        : null,
      projectRole: membership.projectRole,
    };
  }

  async update(
    userId: string,
    teamId: string,
    input: { name?: string; description?: string; testEnvironmentId?: string | null },
  ) {
    const { team } = await this.access.requireTeam(userId, teamId, "admin");
    if (input.name) team.name = input.name.trim();
    if (input.description !== undefined) team.description = input.description.trim();
    if (input.testEnvironmentId !== undefined) {
      if (input.testEnvironmentId === null) team.testEnvironmentId = null;
      else {
        const environment = await this.environments.findOne({
          where: { id: input.testEnvironmentId, projectId: team.projectId },
        });
        if (!environment) throw new DomainError("测试环境不存在", 404);
        team.testEnvironmentId = environment.id;
      }
    }
    await this.teams.save(team);
    return this.get(userId, teamId);
  }

  async remove(userId: string, teamId: string) {
    await this.access.requireTeam(userId, teamId, "admin");
    const releases = await this.dataSource.query(`SELECT count(*)::int AS count FROM system_release WHERE team_id = $1`, [
      teamId,
    ]);
    if (Number(releases[0]?.count) > 0) throw new DomainError("Team 已有系统版本，不能删除", 409);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE team_member SET tested_service_version_id = NULL WHERE team_id = $1`, [teamId]);
      await manager.query(
        `UPDATE service_version SET created_by_member_id = NULL WHERE created_by_member_id IN (SELECT id FROM team_member WHERE team_id = $1)`,
        [teamId],
      );
      await manager.query(`DELETE FROM service_version WHERE team_id = $1`, [teamId]);
      await manager.query(
        `DELETE FROM agent_run WHERE agent_id IN (SELECT a.id FROM agent a JOIN team_member tm ON tm.id = a.member_id WHERE tm.team_id = $1)`,
        [teamId],
      );
      await manager.query(
        `DELETE FROM agent_workspace WHERE agent_id IN (SELECT a.id FROM agent a JOIN team_member tm ON tm.id = a.member_id WHERE tm.team_id = $1)`,
        [teamId],
      );
      await manager.query(`DELETE FROM agent WHERE member_id IN (SELECT id FROM team_member WHERE team_id = $1)`, [teamId]);
      await manager.query(`DELETE FROM member_service WHERE member_id IN (SELECT id FROM team_member WHERE team_id = $1)`, [
        teamId,
      ]);
      await manager.query(`DELETE FROM work_item WHERE team_id = $1`, [teamId]);
      await manager.query(`DELETE FROM team_member WHERE team_id = $1`, [teamId]);
      await manager.query(`DELETE FROM team_workspace WHERE team_id = $1`, [teamId]);
      await manager.query(`DELETE FROM team WHERE id = $1`, [teamId]);
    });
    return { ok: true };
  }

  async listWorkspaces(userId: string, teamId: string) {
    const { team } = await this.access.requireTeam(userId, teamId, "member");
    const rows = await this.workspaces.find({ where: { teamId } });
    const services = rows.length
      ? await this.services.find({ where: { id: In(rows.map((row) => row.serviceId)) } })
      : [];
    return rows.map((row) => ({
      ...row,
      serviceName: services.find((service) => service.id === row.serviceId)?.name ?? "",
      repoUrl: services.find((service) => service.id === row.serviceId)?.repoUrl ?? "",
      projectId: team.projectId,
    }));
  }

  async replaceWorkspaces(userId: string, teamId: string, items: { serviceId: string; baselineRef: string }[]) {
    const { team } = await this.access.requireTeam(userId, teamId, "admin");
    const unique = new Map<string, string>();
    for (const item of items) {
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(item.baselineRef.trim())) {
        throw new DomainError("分支或 tag 含有不支持的字符");
      }
      unique.set(item.serviceId, item.baselineRef.trim());
    }
    const services = unique.size
      ? await this.services.find({ where: { id: In([...unique.keys()]), projectId: team.projectId } })
      : [];
    if (services.length !== unique.size) throw new DomainError("工作区包含不属于项目的服务");
    const current = await this.workspaces.find({ where: { teamId } });
    const removed = current.filter((row) => !unique.has(row.serviceId)).map((row) => row.serviceId);
    if (removed.length) {
      const occupied = await this.dataSource.query(
        `SELECT count(*)::int AS count FROM member_service ms
         JOIN team_member tm ON tm.id = ms.member_id
         WHERE tm.team_id = $1 AND ms.service_id = ANY($2::uuid[])`,
        [teamId, removed],
      );
      if (Number(occupied[0]?.count) > 0) throw new DomainError("有成员仍分配在即将移出的服务上", 409);
    }
    await this.dataSource.transaction(async (manager) => {
      const keep = [...unique.keys()];
      if (keep.length === 0) {
        await manager.delete(TeamWorkspaceEntity, { teamId });
      } else {
        await manager.query(`DELETE FROM team_workspace WHERE team_id = $1 AND NOT (service_id = ANY($2::uuid[]))`, [
          teamId,
          keep,
        ]);
      }
      for (const [serviceId, baselineRef] of unique) {
        const existing = await manager.findOne(TeamWorkspaceEntity, { where: { teamId, serviceId } });
        if (existing) {
          existing.baselineRef = baselineRef;
          await manager.save(existing);
        } else {
          await manager.save(manager.create(TeamWorkspaceEntity, { teamId, serviceId, baselineRef }));
        }
      }
    });
    return this.listWorkspaces(userId, teamId);
  }

  async updateBaselines(userId: string, teamId: string, items: { serviceId: string; baselineRef: string }[]) {
    await this.access.requireTeam(userId, teamId, "admin");
    const current = await this.workspaces.find({ where: { teamId } });
    const byService = new Map(current.map((row) => [row.serviceId, row]));
    for (const item of items) {
      if (!byService.has(item.serviceId)) throw new DomainError("服务不在 Team 工作区中");
      const baseline = item.baselineRef.trim();
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(baseline)) throw new DomainError("分支或 tag 含有不支持的字符");
    }
    await this.dataSource.transaction(async (manager) => {
      for (const item of items) {
        const row = byService.get(item.serviceId);
        if (!row) continue;
        row.baselineRef = item.baselineRef.trim();
        await manager.save(row);
      }
    });
    return this.listWorkspaces(userId, teamId);
  }

  async removeWorkspace(userId: string, teamId: string, serviceId: string) {
    const { team } = await this.access.requireTeam(userId, teamId, "admin");
    const workspace = await this.workspaces.findOne({ where: { teamId, serviceId } });
    if (!workspace) throw new DomainError("仓库不在工作区中", 404);
    const service = await this.services.findOne({ where: { id: serviceId, projectId: team.projectId } });
    if (!service) throw new DomainError("服务不存在", 404);
    const members = await this.members.find({ where: { teamId } });
    const agents = members.length
      ? await this.agents.find({ where: { memberId: In(members.map((member) => member.id)) } })
      : [];
    const rows = agents.length
      ? await this.agentWorkspaces.find({ where: { agentId: In(agents.map((agent) => agent.id)), serviceId } })
      : [];
    const affectedIds = new Set(rows.map((row) => row.agentId));
    const affectedAgents = agents.filter((agent) => affectedIds.has(agent.id));
    const pending = affectedAgents.some((agent) => agent.status === "pending")
      || members.some((member) => member.status === "pending" && affectedAgents.some((agent) => agent.memberId === member.id));
    if (pending) throw new DomainError("有成员正在创建，完成后再删除仓库");
    const remoteBranchesKept = rows
      .filter((row) => row.branchOrigin !== "baseline")
      .map((row) => {
        const agent = agents.find((item) => item.id === row.agentId);
        const member = members.find((item) => item.id === agent?.memberId);
        return { memberName: member?.name ?? "", name: service.name, repoUrl: service.repoUrl, branch: row.branch };
      });
    const identity = repoIdentity(service.repoUrl);
    await this.dataSource.transaction(async (manager) => {
      if (rows.length) await manager.delete(AgentWorkspaceEntity, { id: In(rows.map((row) => row.id)) });
      if (members.length) {
        await manager
          .createQueryBuilder()
          .delete()
          .from(MemberServiceEntity)
          .where("service_id = :serviceId", { serviceId })
          .andWhere("member_id IN (:...memberIds)", { memberIds: members.map((member) => member.id) })
          .execute();
      }
      await manager.delete(TeamWorkspaceEntity, { id: workspace.id });
      const sources = await manager.find(TeamSourceEntity, { where: { teamId, kind: "repo" } });
      const matched = identity ? sources.filter((source) => repoIdentity(source.url) === identity) : [];
      if (matched.length) await manager.delete(TeamSourceEntity, { id: In(matched.map((source) => source.id)) });
    });
    for (const row of rows) await this.git.removeLocal(row.localPath).catch(() => undefined);
    for (const agent of affectedAgents) {
      await this.agents.update(agent.id, { externalAgentId: null, status: "pending" });
      await this.members.update(agent.memberId, { status: "pending", failureReason: null });
      await this.enqueueCreate(agent.id);
    }
    return { ok: true, remoteBranchesKept };
  }

  async catalog(userId: string, teamId: string) {
    const { team } = await this.access.requireTeam(userId, teamId, "member");
    const sources = await this.sources
      .createQueryBuilder("source")
      .addSelect("source.gitTokenEncrypted")
      .where("source.team_id = :teamId", { teamId })
      .orderBy("source.created_at", "ASC")
      .getMany();
    const workspaces = await this.listWorkspaces(userId, teamId);
    const addresses = workspaces.map((workspace) => ({
      serviceId: workspace.serviceId,
      name: workspace.serviceName,
      repoUrl: workspace.repoUrl,
      baselineRef: workspace.baselineRef,
    }));
    const serviceByRepo = new Map(addresses.map((address) => [repoIdentity(address.repoUrl), address.serviceId]));
    const groups: {
      id: string;
      name: string;
      url: string;
      error: string | null;
      repos: { name: string; repoUrl: string; defaultBranch: string; serviceId: string | null }[];
    }[] = [];
    for (const source of sources.filter((item) => item.kind === "group")) {
      if (!source.gitTokenEncrypted) {
        groups.push({ id: source.id, name: source.name, url: source.url, error: "未配置 Git 访问令牌", repos: [] });
        continue;
      }
      try {
        const token = decryptSecret(source.gitTokenEncrypted, this.encryptionKey());
        const listed = await this.git.listGroup(source.url, token);
        groups.push({
          id: source.id,
          name: listed.name || source.name,
          url: source.url,
          error: null,
          repos: listed.repos.map((repo) => ({
            name: repo.name,
            repoUrl: repo.repoUrl,
            defaultBranch: repo.defaultBranch,
            serviceId: serviceByRepo.get(repoIdentity(repo.repoUrl) ?? "") ?? null,
          })),
        });
      } catch (error) {
        const message = error instanceof DomainError ? error.message : "读取群组失败";
        groups.push({ id: source.id, name: source.name, url: source.url, error: message, repos: [] });
      }
    }
    return {
      projectId: team.projectId,
      sources: sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        name: source.name,
        url: source.url,
        baselineRef: source.baselineRef,
        tokenConfigured: Boolean(source.gitTokenEncrypted),
      })),
      addresses,
      groups,
    };
  }

  async createSource(
    userId: string,
    teamId: string,
    input: { kind: "group" | "repo"; url: string; gitToken: string; baselineRef?: string },
  ) {
    const { team } = await this.access.requireTeam(userId, teamId, "admin");
    const token = input.gitToken.trim();
    const encrypted = encryptSecret(token, this.encryptionKey());
    if (input.kind === "repo") {
      if (!parseGitRepo(input.url)) throw new DomainError(invalidRepoMessage());
      const inspected = await this.git.inspectRepo(input.url.trim(), token);
      const baseline = input.baselineRef?.trim() || inspected.defaultBranch || "main";
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(baseline)) throw new DomainError("分支或 tag 含有不支持的字符");
      const url = inspected.repoUrl;
      await this.assertNewSource(teamId, url);
      const saved = await this.dataSource.transaction(async (manager) => {
        await this.ensureWorkspaceRepo(manager, team, {
          repo: { ...inspected, defaultBranch: baseline },
          tokenEncrypted: encrypted,
          baseline,
          replaceBaseline: true,
        });
        const source = await manager.save(
          manager.create(TeamSourceEntity, {
            teamId,
            kind: "repo",
            url,
            name: inspected.name.slice(0, 200),
            baselineRef: baseline,
            gitTokenEncrypted: null,
          }),
        );
        await manager.update(TeamSourceEntity, source.id, { gitTokenEncrypted: encrypted });
        source.gitTokenEncrypted = encrypted;
        return source;
      });
      return this.presentSource(saved);
    }
    const group = parseGitGroup(input.url);
    if (!group) throw new DomainError(invalidGroupMessage(input.url));
    const listed = await this.git.listGroup(input.url.trim(), token);
    const url = canonicalGroupUrl(group);
    await this.assertNewSource(teamId, url);
    const saved = await this.sources.save(
      this.sources.create({
        teamId,
        kind: "group",
        url,
        name: listed.name.slice(0, 200),
        baselineRef: "main",
        gitTokenEncrypted: null,
      }),
    );
    await this.sources.update(saved.id, { gitTokenEncrypted: encrypted });
    saved.gitTokenEncrypted = encrypted;
    return { ...this.presentSource(saved), repoCount: listed.repos.length };
  }

  async removeSource(userId: string, teamId: string, sourceId: string) {
    const { team } = await this.access.requireTeam(userId, teamId, "admin");
    const source = await this.sources.findOne({ where: { id: sourceId, teamId } });
    if (!source) throw new DomainError("代码来源不存在", 404);
    if (source.kind === "repo") {
      const service = await this.findProjectService(team.projectId, source.url);
      const linked = service ? await this.workspaces.findOne({ where: { teamId, serviceId: service.id } }) : null;
      if (service && linked) return this.removeWorkspace(userId, teamId, service.id);
    }
    await this.sources.delete(source.id);
    return { ok: true, remoteBranchesKept: [] };
  }

  async monitor(userId: string, teamId: string) {
    const { team } = await this.access.requireTeam(userId, teamId, "member");
    const members = await this.listMembers(userId, teamId);
    const tasks = await this.workItems.find({ where: { teamId }, order: { updatedAt: "DESC" } });
    const sessions = await this.dataSource.query(
      `SELECT r.id, r.agent_id, r.work_item_id, r.prompt, r.status, r.error_message,
              r.external_run_id, r.usage, r.duration_ms, r.created_at, r.finished_at,
              LEFT(r.log, 240) AS log_preview, a.member_id
       FROM agent_run r
       JOIN agent a ON a.id = r.agent_id
       JOIN team_member m ON m.id = a.member_id
       WHERE m.team_id = $1
       ORDER BY r.created_at DESC
       LIMIT 200`,
      [teamId],
    );
    const secrets = await this.engines.secretsForProject(team.projectId);
    const live = new Map<string, { usage: CursorUsage; runs: { runId: string; usage: CursorUsage }[] } | null>();
    if (secrets.apiKey) {
      await Promise.all(
        members
          .filter((member) => member.agent?.externalAgentId)
          .map(async (member) => {
            const agent = member.agent;
            if (!agent?.externalAgentId) return;
            const usage = await this.cursorUsage(secrets.apiKey as string, agent.externalAgentId);
            live.set(agent.id, usage);
            if (!usage) return;
            for (const run of usage.runs) {
              await this.dataSource.query(
                `UPDATE agent_run SET usage = $1::jsonb WHERE agent_id = $2 AND external_run_id = $3`,
                [JSON.stringify(run.usage), agent.id, run.runId],
              );
            }
          }),
      );
    }
    const presented = members.map((member) => {
      const memberTasks = tasks.filter((task) => task.assigneeMemberId === member.id);
      const memberSessions = (sessions as MonitorSessionRow[])
        .filter((session) => session.member_id === member.id)
        .map((session) => this.presentSession(session, live.get(member.agent?.id ?? "")?.runs ?? []));
      const currentTasks = memberTasks.filter((task) => task.status === "in_progress").map((task) => this.presentTask(task));
      const currentSession = memberSessions.find((session) => session.status === "queued" || session.status === "running") ?? null;
      const agentUsage = member.agent ? live.get(member.agent.id)?.usage ?? null : null;
      const usage = agentUsage ?? sumUsage(memberSessions.map((session) => session.usage));
      const hasUsage = member.memberType === "agent" && (agentUsage !== null || memberSessions.some((session) => session.usage));
      return {
        id: member.id,
        name: member.name,
        memberType: member.memberType,
        roleName: member.roleName,
        status: member.status,
        failureReason: member.failureReason,
        activity: this.activity(member.status, currentTasks.length > 0 || Boolean(currentSession)),
        model: member.agent?.model ?? null,
        currentTasks,
        currentSession,
        processedTasks: memberTasks.filter((task) => task.status === "done").map((task) => this.presentTask(task)),
        sessions: memberSessions,
        usage: member.memberType === "agent" ? usage : null,
        usageNote: this.usageNote(member.memberType, member.agent?.externalAgentId ?? null, hasUsage, Boolean(secrets.apiKey)),
      };
    });
    const teamUsage = sumUsage(presented.map((member) => member.usage));
    return {
      teamId: team.id,
      teamName: team.name,
      summary: {
        members: presented.length,
        working: presented.filter((member) => member.activity === "working").length,
        doneTasks: tasks.filter((task) => task.status === "done").length,
        sessions: sessions.length,
        totalTokens: teamUsage?.totalTokens ?? 0,
        chargedCents: teamUsage?.chargedCents ?? null,
      },
      members: presented,
    };
  }

  async listMembers(userId: string, teamId: string) {
    await this.access.requireTeam(userId, teamId, "member");
    const members = await this.members.find({ where: { teamId }, order: { createdAt: "ASC" } });
    return Promise.all(members.map((member) => this.presentMember(member)));
  }

  async addHuman(
    userId: string,
    teamId: string,
    input: {
      email: string;
      roleId: string;
      dutyOverride?: string;
      serviceIds: string[];
      groupRepos?: { sourceId: string; repoUrl: string }[];
      testedServiceVersionId?: string;
      contactMemberIds?: string[];
    },
  ) {
    const { team } = await this.access.requireTeam(userId, teamId, "admin");
    const user = await this.users.findOne({ where: { email: input.email.trim().toLowerCase() } });
    if (!user) throw new DomainError("用户尚未注册", 404);
    const projectMember = await this.access.requireProject(user.id, team.projectId, "member").catch(() => null);
    if (!projectMember) throw new DomainError("请先把用户加入项目", 400);
    const existing = await this.members.findOne({ where: { teamId, userId: user.id, memberType: "human" } });
    if (existing) throw new DomainError("用户已在 Team 中", 409);
    const role = await this.requireOwnedRole(userId, input.roleId);
    const serviceIds = await this.assignedServiceIds(team, role.permissions, input.serviceIds, input.groupRepos);
    await this.assertAssignment(teamId, role.permissions, serviceIds, input.testedServiceVersionId);
    const member = await this.dataSource.transaction(async (manager) => {
      const created = await manager.save(
        manager.create(TeamMemberEntity, {
          teamId,
          memberType: "human",
          userId: user.id,
          name: user.name,
          roleId: role.id,
          dutyOverride: input.dutyOverride?.trim() ?? "",
          status: "active",
          testedServiceVersionId: input.testedServiceVersionId ?? null,
        }),
      );
      await this.replaceServices(manager, created.id, serviceIds);
      await this.replaceContacts(manager, created.id, teamId, input.contactMemberIds ?? []);
      return created;
    });
    return this.presentMember(member);
  }

  async addAgent(
    userId: string,
    teamId: string,
    input: {
      name: string;
      roleId: string;
      dutyOverride?: string;
      serviceIds: string[];
      groupRepos?: { sourceId: string; repoUrl: string }[];
      model?: string;
      testedServiceVersionId?: string;
      branch?: BranchPlan;
      contactMemberIds?: string[];
    },
  ) {
    const { team } = await this.access.requireTeam(userId, teamId, "admin");
    const role = await this.requireOwnedRole(userId, input.roleId);
    const serviceIds = await this.assignedServiceIds(team, role.permissions, input.serviceIds, input.groupRepos);
    await this.assertAssignment(teamId, role.permissions, serviceIds, input.testedServiceVersionId);
    const plan = input.branch ?? { create: false };
    if (assignmentRequired(role.permissions) && plan.create) {
      await this.prepareBranchPlan(team.name, input.name.trim(), serviceIds, plan);
    }
    const model = input.model?.trim() || (await this.engines.defaultModelForProject(team.projectId));
    const created = await this.dataSource.transaction(async (manager) => {
      const member = await manager.save(
        manager.create(TeamMemberEntity, {
          teamId,
          memberType: "agent",
          userId: null,
          name: input.name.trim(),
          roleId: role.id,
          dutyOverride: input.dutyOverride?.trim() ?? "",
          status: "pending",
          testedServiceVersionId: input.testedServiceVersionId ?? null,
        }),
      );
      const agent = await manager.save(
        manager.create(AgentEntity, {
          memberId: member.id,
          platform: "cursor",
          externalAgentId: null,
          model,
          runtime: "cloud",
          status: "pending",
        }),
      );
      await this.replaceServices(manager, member.id, serviceIds);
      await this.replaceContacts(manager, member.id, teamId, input.contactMemberIds ?? []);
      await this.writeWorkspaces(manager, {
        agentId: agent.id,
        agentName: member.name,
        teamId,
        teamName: team.name,
        permissions: role.permissions,
        serviceIds,
        plan,
      });
      return agent;
    });
    await this.enqueueCreate(created.id);
    const member = await this.members.findOneOrFail({ where: { id: created.memberId } });
    return this.presentMember(member);
  }

  async updateMember(userId: string, teamId: string, memberId: string, input: {
    name?: string;
    roleId?: string;
    dutyOverride?: string;
    serviceIds?: string[];
    groupRepos?: { sourceId: string; repoUrl: string }[];
    model?: string;
    testedServiceVersionId?: string | null;
  }) {
    await this.access.requireTeam(userId, teamId, "admin");
    const member = await this.requireMember(teamId, memberId);
    const team = await this.teams.findOneOrFail({ where: { id: teamId } });
    const nextRole = input.roleId ? await this.requireOwnedRole(userId, input.roleId) : await this.requireRole(member.roleId);
    const currentServices = await this.memberServices.find({ where: { memberId } });
    const serviceIds = await this.assignedServiceIds(
      team,
      nextRole.permissions,
      input.serviceIds ?? currentServices.map((link) => link.serviceId),
      input.groupRepos,
    );
    const tested = input.testedServiceVersionId === undefined ? member.testedServiceVersionId : input.testedServiceVersionId;
    await this.assertAssignment(teamId, nextRole.permissions, serviceIds, tested);
    const agent = member.memberType === "agent" ? await this.agents.findOne({ where: { memberId } }) : null;
    const servicesTouched = input.serviceIds !== undefined || Boolean(input.groupRepos?.length);
    if (agent?.externalAgentId && servicesTouched) {
      const same =
        serviceIds.length === currentServices.length &&
        serviceIds.every((serviceId) => currentServices.some((link) => link.serviceId === serviceId));
      if (!same) throw new DomainError("Agent 已在 Cursor 创建，不能改分配的服务", 400);
    }
    if (agent?.externalAgentId && input.roleId) {
      const previous = await this.requireRole(member.roleId);
      if (forksWorkspace(previous.permissions) !== forksWorkspace(nextRole.permissions)) {
        throw new DomainError("Agent 已在 Cursor 创建，不能改成另一类工作区角色", 400);
      }
    }
    member.roleId = nextRole.id;
    if (input.dutyOverride !== undefined) member.dutyOverride = input.dutyOverride.trim();
    if (input.name) member.name = input.name.trim();
    if (tested !== undefined) member.testedServiceVersionId = tested;
    await this.members.save(member);
    if (servicesTouched && !agent?.externalAgentId) {
      await this.dataSource.transaction(async (manager) => {
        await this.replaceServices(manager, member.id, serviceIds);
        if (agent) {
          await manager.delete(AgentWorkspaceEntity, { agentId: agent.id });
          await this.writeWorkspaces(manager, {
            agentId: agent.id,
            agentName: member.name,
            teamId,
            teamName: team.name,
            permissions: nextRole.permissions,
            serviceIds,
            plan: { create: false },
          });
        }
      });
    } else if (servicesTouched) {
      await this.dataSource.transaction(async (manager) => {
        await this.replaceServices(manager, member.id, serviceIds);
      });
    }
    if (agent && input.model) await this.agents.update(agent.id, { model: input.model.trim() });
    return this.presentMember(await this.requireMember(teamId, memberId));
  }

  async replaceMemberRepos(
    userId: string,
    teamId: string,
    memberId: string,
    input: {
      serviceIds: string[];
      groupRepos?: { sourceId: string; repoUrl: string }[];
      branch?: BranchPlan;
    },
  ) {
    await this.access.requireTeam(userId, teamId, "admin");
    const member = await this.requireMember(teamId, memberId);
    const team = await this.teams.findOneOrFail({ where: { id: teamId } });
    const role = await this.requireRole(member.roleId);
    if (!assignmentRequired(role.permissions)) throw new DomainError("该角色不按代码仓分配");
    if (member.status === "pending") throw new DomainError("成员正在创建，完成后再修改代码仓");
    const serviceIds = await this.assignedServiceIds(team, role.permissions, input.serviceIds, input.groupRepos);
    await this.assertAssignment(teamId, role.permissions, serviceIds, member.testedServiceVersionId);
    const currentIds = (await this.memberServices.find({ where: { memberId } })).map((link) => link.serviceId);
    const same = serviceIds.length === currentIds.length && serviceIds.every((serviceId) => currentIds.includes(serviceId));
    if (same) return this.presentMember(member);
    const added = serviceIds.filter((serviceId) => !currentIds.includes(serviceId));
    const removed = currentIds.filter((serviceId) => !serviceIds.includes(serviceId));
    const agent = member.memberType === "agent" ? await this.agents.findOne({ where: { memberId } }) : null;
    if (agent?.status === "pending") throw new DomainError("Agent 正在创建，完成后再修改代码仓");
    const plan = input.branch ?? { create: member.memberType === "agent", mode: "default" as const };
    const existingWorkspaces = agent ? await this.agentWorkspaces.find({ where: { agentId: agent.id } }) : [];
    const teamWorkspaces = await this.workspaces.find({ where: { teamId } });
    const serviceRows = [...new Set([...serviceIds, ...removed])].length
      ? await this.services.find({ where: { id: In([...new Set([...serviceIds, ...removed])]) } })
      : [];
    const planned: PlannedRepoWorkspace[] = [];
    if (agent && added.length && plan.create) await this.prepareBranchPlan(team.name, member.name, added, plan);
    if (agent) {
      for (const serviceId of added) {
        const service = serviceRows.find((item) => item.id === serviceId);
        const parent = teamWorkspaces.find((item) => item.serviceId === serviceId);
        if (!service || !parent) throw new DomainError("服务不在 Team 工作区中");
        const resolved = this.resolveBranch(team.name, member.name, service, parent.baselineRef, plan);
        planned.push({
          serviceId,
          parentWorkspaceId: parent.id,
          repoUrl: service.repoUrl,
          baselineRef: parent.baselineRef,
          branch: resolved.branch,
          forked: resolved.forked,
          branchOrigin: resolved.branchOrigin,
          gitSha: null,
        });
      }
    }
    const made: PlannedRepoWorkspace[] = [];
    try {
      for (const row of planned) {
        if (row.branchOrigin !== "created") continue;
        const result = await this.git.ensureBranch(row.serviceId, row.repoUrl, row.baselineRef, row.branch);
        row.gitSha = result.sha;
        if (result.created) made.push(row);
      }
      await this.dataSource.transaction(async (manager) => {
        await this.replaceServices(manager, member.id, serviceIds);
        if (!agent) return;
        if (removed.length) await manager.delete(AgentWorkspaceEntity, { agentId: agent.id, serviceId: In(removed) });
        for (const row of planned) {
          await manager.save(
            manager.create(AgentWorkspaceEntity, {
              agentId: agent.id,
              parentWorkspaceId: row.parentWorkspaceId,
              serviceId: row.serviceId,
              repoUrl: row.repoUrl,
              branch: row.branch,
              baselineRef: row.baselineRef,
              forked: row.forked,
              forkStatus: "ready",
              branchOrigin: row.branchOrigin,
              gitSha: row.gitSha,
            }),
          );
        }
      });
    } catch (error) {
      const kept = made.map((row) => row.branch);
      const message = error instanceof DomainError ? error.message : error instanceof Error ? error.message : "修改代码仓失败";
      if (kept.length) throw new DomainError(`${message}。远端分支未删除，请到 Git 上手动删除：${kept.join("、")}`);
      throw error;
    }
    if (agent) {
      const removedRows = existingWorkspaces.filter((workspace) => removed.includes(workspace.serviceId));
      for (const row of removedRows) await this.git.removeLocal(row.localPath).catch(() => undefined);
    }
    if (agent) {
      await this.agents.update(agent.id, { externalAgentId: null, status: "pending" });
      await this.members.update(member.id, { status: "pending", failureReason: null });
      await this.enqueueCreate(agent.id);
    }
    const remoteBranchesKept = existingWorkspaces
      .filter((workspace) => removed.includes(workspace.serviceId) && workspace.branchOrigin !== "baseline")
      .map((workspace) => ({
        name: serviceRows.find((service) => service.id === workspace.serviceId)?.name ?? workspace.repoUrl,
        repoUrl: workspace.repoUrl,
        branch: workspace.branch,
      }));
    return {
      ...(await this.presentMember(await this.requireMember(teamId, memberId))),
      remoteBranchesKept,
    };
  }

  async updateContacts(userId: string, teamId: string, memberId: string, peerIds: string[]) {
    await this.access.requireTeam(userId, teamId, "admin");
    await this.requireMember(teamId, memberId);
    await this.dataSource.transaction(async (manager) => {
      await this.replaceContacts(manager, memberId, teamId, peerIds);
    });
    return this.presentMember(await this.requireMember(teamId, memberId));
  }

  async listRepoBranches(
    userId: string,
    teamId: string,
    query: { serviceId?: string; sourceId?: string; repoUrl?: string },
  ) {
    await this.access.requireTeam(userId, teamId, "member");
    if (query.serviceId) {
      const workspace = await this.workspaces.findOne({ where: { teamId, serviceId: query.serviceId } });
      if (!workspace) throw new DomainError("服务不在 Team 工作区中");
      const service = await this.services.findOne({ where: { id: query.serviceId } });
      if (!service) throw new DomainError("服务不存在", 404);
      return { branches: await this.git.listBranches(service.id, service.repoUrl) };
    }
    if (query.sourceId && query.repoUrl) {
      const source = await this.sources
        .createQueryBuilder("source")
        .addSelect("source.gitTokenEncrypted")
        .where("source.id = :id AND source.team_id = :teamId", { id: query.sourceId, teamId })
        .getOne();
      if (!source || source.kind !== "group") throw new DomainError("群组不在这个 Team 工作区中");
      if (!source.gitTokenEncrypted) throw new DomainError("群组未配置 Git 访问令牌");
      const token = decryptSecret(source.gitTokenEncrypted, this.encryptionKey());
      const repos = (await this.git.listGroup(source.url, token)).repos;
      const wanted = repoIdentity(query.repoUrl);
      const repo = repos.find((item) => repoIdentity(item.repoUrl) === wanted);
      if (!repo) throw new DomainError("所选仓库不在群组中");
      return { branches: await this.git.listBranchesWithToken(repo.repoUrl, token) };
    }
    throw new DomainError("请指定仓库");
  }

  async removeMember(userId: string, teamId: string, memberId: string) {
    const { membership } = await this.access.requireTeam(userId, teamId, "member");
    const member = await this.requireMember(teamId, memberId);
    const isSelf = member.userId === userId;
    if (membership.projectRole === "member" && !isSelf) throw new DomainError("需要项目管理员权限", 403);
    const agent = await this.agents.findOne({ where: { memberId } });
    if (agent) {
      const rows = await this.agentWorkspaces.find({ where: { agentId: agent.id } });
      for (const row of rows) await this.git.removeLocal(row.localPath).catch(() => undefined);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE service_version SET created_by_member_id = NULL WHERE created_by_member_id = $1`, [memberId]);
      await manager.query(`UPDATE test_report SET author_member_id = NULL WHERE author_member_id = $1`, [memberId]);
      await manager.query(`UPDATE work_item SET assignee_member_id = NULL WHERE assignee_member_id = $1`, [memberId]);
      await manager.query(`UPDATE system_release SET created_by_member_id = NULL WHERE created_by_member_id = $1`, [memberId]);
      await manager.query(`UPDATE team_member SET tested_service_version_id = NULL WHERE id = $1`, [memberId]);
      await manager.query(`DELETE FROM agent_run WHERE agent_id IN (SELECT id FROM agent WHERE member_id = $1)`, [memberId]);
      await manager.query(`DELETE FROM agent_workspace WHERE agent_id IN (SELECT id FROM agent WHERE member_id = $1)`, [memberId]);
      await manager.query(`DELETE FROM agent WHERE member_id = $1`, [memberId]);
      await manager.query(`DELETE FROM member_service WHERE member_id = $1`, [memberId]);
      await manager.query(`DELETE FROM team_member WHERE id = $1`, [memberId]);
    });
    return { ok: true };
  }

  async retryAgent(userId: string, agentId: string) {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent) throw new DomainError("Agent 不存在", 404);
    const member = await this.members.findOne({ where: { id: agent.memberId } });
    if (!member) throw new DomainError("成员不存在", 404);
    await this.access.requireTeam(userId, member.teamId, "admin");
    if (agent.externalAgentId) {
      await this.agents.update(agent.id, { status: "active" });
      await this.members.update(member.id, { status: "active", failureReason: null });
      return this.presentMember(await this.requireMember(member.teamId, member.id));
    }
    const role = await this.requireRole(member.roleId);
    const serviceIds = (await this.memberServices.find({ where: { memberId: member.id } })).map((link) => link.serviceId);
    const team = await this.teams.findOneOrFail({ where: { id: member.teamId } });
    const previous = await this.agentWorkspaces.find({ where: { agentId: agent.id } });
    for (const row of previous) await this.git.removeLocal(row.localPath).catch(() => undefined);
    const preserved = new Map(
      previous.map((row) => [
        row.serviceId,
        {
          branch: row.branch,
          forked: row.forked,
          forkStatus: row.branchOrigin === "created" ? ("planned" as const) : row.forkStatus,
          branchOrigin: row.branchOrigin,
          gitSha: row.branchOrigin === "created" ? null : row.gitSha,
        },
      ]),
    );
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(AgentWorkspaceEntity, { agentId: agent.id });
      await this.writeWorkspaces(manager, {
        agentId: agent.id,
        agentName: member.name,
        teamId: member.teamId,
        teamName: team.name,
        permissions: role.permissions,
        serviceIds,
        preserved,
      });
      await manager.update(AgentEntity, agent.id, { status: "pending" });
      await manager.update(TeamMemberEntity, member.id, { status: "pending", failureReason: null });
    });
    await this.enqueueCreate(agent.id);
    return this.presentMember(await this.requireMember(member.teamId, member.id));
  }

  async listWorkItems(userId: string, teamId: string) {
    await this.access.requireTeam(userId, teamId, "member");
    return this.workItems.find({ where: { teamId }, order: { createdAt: "DESC" } });
  }

  async createWorkItem(
    userId: string,
    teamId: string,
    input: { title: string; description?: string; serviceId?: string; assigneeMemberId?: string },
  ) {
    const { membership } = await this.access.requireTeam(userId, teamId, "member");
    const human = await this.members.findOne({ where: { teamId, userId, memberType: "human" } });
    if (!human && membership.projectRole === "member") throw new DomainError("你不在这个 Team 中", 403);
    if (input.serviceId) {
      const workspace = await this.workspaces.findOne({ where: { teamId, serviceId: input.serviceId } });
      if (!workspace) throw new DomainError("服务不在 Team 工作区中");
    }
    if (input.assigneeMemberId) await this.requireMember(teamId, input.assigneeMemberId);
    return this.workItems.save(
      this.workItems.create({
        teamId,
        title: input.title.trim(),
        description: input.description?.trim() ?? "",
        serviceId: input.serviceId ?? null,
        assigneeMemberId: input.assigneeMemberId ?? null,
        creatorUserId: userId,
        status: "open",
      }),
    );
  }

  async updateWorkItem(userId: string, workItemId: string, input: { status?: "open" | "in_progress" | "done"; assigneeMemberId?: string }) {
    const item = await this.workItems.findOne({ where: { id: workItemId } });
    if (!item) throw new DomainError("工作项不存在", 404);
    const { membership } = await this.access.requireTeam(userId, item.teamId, "member");
    const human = await this.members.findOne({ where: { teamId: item.teamId, userId, memberType: "human" } });
    if (!human && membership.projectRole === "member") throw new DomainError("你不在这个 Team 中", 403);
    if (input.assigneeMemberId) await this.requireMember(item.teamId, input.assigneeMemberId);
    if (input.status) item.status = input.status;
    if (input.assigneeMemberId) item.assigneeMemberId = input.assigneeMemberId;
    return this.workItems.save(item);
  }

  private async enqueueCreate(agentId: string) {
    try {
      await this.queue.enqueue({ kind: "create-agent", agentId }, `create-${agentId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法加入队列";
      const agent = await this.agents.findOne({ where: { id: agentId } });
      if (agent) {
        await this.agents.update(agentId, { status: "failed" });
        await this.members.update(agent.memberId, { status: "failed", failureReason: message });
      }
      throw error;
    }
  }

  private async assertAssignment(
    teamId: string,
    permissions: string[],
    serviceIds: string[],
    testedServiceVersionId?: string | null,
  ) {
    const required = assignmentRequired(permissions);
    if (required && serviceIds.length === 0) throw new DomainError("该角色至少分配一个服务");
    if (!required && serviceIds.length > 0) throw new DomainError("该角色不按服务分配");
    if (serviceIds.length) {
      const rows = await this.workspaces.find({ where: { teamId, serviceId: In(serviceIds) } });
      if (rows.length !== new Set(serviceIds).size) throw new DomainError("服务不在 Team 工作区中");
    }
    const tests = permissions.includes("service:test");
    if (testedServiceVersionId) {
      if (!tests) throw new DomainError("只有测试角色可以指定被测版本");
      const version = await this.versions.findOne({ where: { id: testedServiceVersionId } });
      if (!version || !serviceIds.includes(version.serviceId)) throw new DomainError("被测版本不属于已分配的服务");
    }
  }

  private async writeWorkspaces(
    manager: DataSource["manager"],
    input: {
      agentId: string;
      agentName: string;
      teamId: string;
      teamName: string;
      permissions: string[];
      serviceIds: string[];
      plan?: BranchPlan | null;
      preserved?: Map<string, PreservedWorkspace>;
    },
  ) {
    const teamWorkspaces = await manager.find(TeamWorkspaceEntity, { where: { teamId: input.teamId } });
    const assign = assignmentRequired(input.permissions);
    const selected = teamWorkspaces.filter((workspace) => (assign ? input.serviceIds.includes(workspace.serviceId) : true));
    if (assign && selected.length === 0) throw new DomainError("没有可分配的服务工作区");
    const serviceRows = selected.length
      ? await manager.find(ServiceEntity, { where: { id: In(selected.map((workspace) => workspace.serviceId)) } })
      : [];
    for (const workspace of selected) {
      const service = serviceRows.find((item) => item.id === workspace.serviceId);
      if (!service) continue;
      const kept = input.preserved?.get(service.id);
      const resolved =
        kept ??
        (assign
          ? this.resolveBranch(input.teamName, input.agentName, service, workspace.baselineRef, input.plan)
          : baselineWorkspace(workspace.baselineRef));
      await manager.save(
        manager.create(AgentWorkspaceEntity, {
          agentId: input.agentId,
          parentWorkspaceId: workspace.id,
          serviceId: service.id,
          repoUrl: service.repoUrl,
          branch: resolved.branch,
          baselineRef: workspace.baselineRef,
          forked: resolved.forked,
          forkStatus: resolved.forkStatus,
          branchOrigin: resolved.branchOrigin,
          gitSha: kept?.gitSha ?? null,
        }),
      );
    }
  }

  private resolveBranch(
    teamName: string,
    memberName: string,
    service: ServiceEntity,
    baselineRef: string,
    plan?: BranchPlan | null,
  ): PreservedWorkspace {
    if (!plan?.create) return baselineWorkspace(baselineRef);
    const mode = plan.mode ?? "default";
    if (mode === "existing") {
      const chosen = this.matchExisting(service, plan.existing ?? []);
      if (!chosen) throw new DomainError(`请为 ${service.name} 选择已有分支`);
      const branch = chosen.branch.trim();
      if (!branch || branch.length > 200 || branch.includes("..")) throw new DomainError("分支名无效");
      return { branch, forked: true, forkStatus: "ready", branchOrigin: "selected", gitSha: null };
    }
    const leaf = mode === "custom" ? (plan.name ?? "") : service.name;
    return {
      branch: memberBranchName(teamName, memberName, leaf),
      forked: true,
      forkStatus: "planned",
      branchOrigin: "created",
      gitSha: null,
    };
  }

  private async prepareBranchPlan(teamName: string, memberName: string, serviceIds: string[], plan: BranchPlan) {
    const services = serviceIds.length ? await this.services.find({ where: { id: In(serviceIds) } }) : [];
    for (const serviceId of serviceIds) {
      const service = services.find((item) => item.id === serviceId);
      if (!service) throw new DomainError("服务不存在", 404);
      const resolved = this.resolveBranch(teamName, memberName, service, service.defaultBranch, plan);
      if (resolved.branchOrigin !== "selected") continue;
      const branches = await this.git.listBranches(service.id, service.repoUrl);
      if (!branches.includes(resolved.branch)) throw new DomainError(`${service.name} 没有分支 ${resolved.branch}`);
    }
  }

  private matchExisting(service: ServiceEntity, existing: NonNullable<BranchPlan["existing"]>) {
    return (
      existing.find((item) => item.serviceId === service.id) ??
      existing.find((item) => item.repoUrl && repoIdentity(item.repoUrl) === repoIdentity(service.repoUrl))
    );
  }

  private async replaceContacts(manager: DataSource["manager"], memberId: string, teamId: string, peerIds: string[]) {
    const unique = [...new Set(peerIds)].filter((id) => id !== memberId);
    if (unique.length) {
      const peers = await manager.find(TeamMemberEntity, { where: { teamId, id: In(unique) } });
      if (peers.length !== unique.length) throw new DomainError("可沟通成员不在这个 Team 中");
    }
    await manager.delete(MemberContactEntity, { memberId });
    for (const peerMemberId of unique) {
      await manager.save(manager.create(MemberContactEntity, { memberId, peerMemberId }));
    }
  }

  private async replaceServices(manager: DataSource["manager"], memberId: string, serviceIds: string[]) {
    await manager.delete(MemberServiceEntity, { memberId });
    for (const serviceId of [...new Set(serviceIds)]) {
      await manager.save(manager.create(MemberServiceEntity, { memberId, serviceId }));
    }
  }

  private async attachEnvironments<T extends TeamEntity>(teams: T[]) {
    const ids = [...new Set(teams.map((team) => team.testEnvironmentId).filter((id): id is string => Boolean(id)))];
    const environments = ids.length ? await this.environments.find({ where: { id: In(ids) } }) : [];
    return teams.map((team) => {
      const environment = environments.find((item) => item.id === team.testEnvironmentId);
      return {
        ...team,
        testEnvironment: environment
          ? {
              id: environment.id,
              name: environment.name,
              kind: environment.kind,
              url: environment.url,
              deployEntry: environment.deployEntry,
              sshHost: environment.sshHost,
              sshPort: environment.sshPort,
              sshUsername: environment.sshUsername,
              kubeContext: environment.kubeContext,
              clusterServer: environment.clusterServer,
              connectionInfo: environment.connectionInfo,
            }
          : null,
      };
    });
  }

  private async cursorUsage(apiKey: string, externalAgentId: string) {
    try {
      return await Promise.race([
        this.cursor.usage(apiKey, externalAgentId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
    } catch {
      return null;
    }
  }

  private activity(status: string, busy: boolean): "creating" | "failed" | "working" | "idle" {
    if (status === "failed") return "failed";
    if (status === "pending") return "creating";
    return busy ? "working" : "idle";
  }

  private usageNote(memberType: string, externalAgentId: string | null, hasUsage: boolean, hasKey: boolean) {
    if (memberType !== "agent") return "人类成员不产生 token 用量";
    if (!externalAgentId) return "Agent 尚未创建，没有会话用量";
    if (!hasKey && !hasUsage) return "项目未配置 Agent 引擎";
    if (!hasUsage) return "Cursor 尚未返回 token 用量";
    return null;
  }

  private presentTask(task: WorkItemEntity) {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      updatedAt: task.updatedAt,
    };
  }

  private presentSession(row: MonitorSessionRow, liveRuns: { runId: string; usage: CursorUsage }[]) {
    const stored = readUsage(row.usage);
    const live = row.external_run_id ? liveRuns.find((run) => run.runId === row.external_run_id)?.usage ?? null : null;
    return {
      id: row.id,
      workItemId: row.work_item_id,
      prompt: row.prompt,
      status: row.status,
      errorMessage: row.error_message,
      externalRunId: row.external_run_id,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      logPreview: row.log_preview ?? "",
      usage: live ?? stored,
    };
  }

  private encryptionKey() {
    return this.config.getOrThrow<string>("APP_ENCRYPTION_KEY");
  }

  private presentSource(source: TeamSourceEntity) {
    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      url: source.url,
      baselineRef: source.baselineRef,
      tokenConfigured: Boolean(source.gitTokenEncrypted),
    };
  }

  private async assertNewSource(teamId: string, url: string) {
    const existing = await this.sources.findOne({ where: { teamId, url } });
    if (existing) throw new DomainError("这个地址已经在工作区中", 409);
  }

  private async assignedServiceIds(
    team: TeamEntity,
    permissions: string[],
    serviceIds: string[],
    groupRepos?: { sourceId: string; repoUrl: string }[],
  ) {
    const picks = groupRepos ?? [];
    if (!assignmentRequired(permissions)) {
      if (serviceIds.length > 0 || picks.length > 0) throw new DomainError("该角色不按服务分配");
      return [];
    }
    if (picks.length === 0) return [...new Set(serviceIds)];
    const extra = await this.materializeGroupRepos(team, picks);
    return [...new Set([...serviceIds, ...extra])];
  }

  private async materializeGroupRepos(team: TeamEntity, picks: { sourceId: string; repoUrl: string }[]) {
    const prepared: { repo: RemoteRepo; tokenEncrypted: string; baseline: string }[] = [];
    const listedCache = new Map<string, RemoteRepo[]>();
    for (const pick of picks) {
      const source = await this.sources
        .createQueryBuilder("source")
        .addSelect("source.gitTokenEncrypted")
        .where("source.id = :id AND source.team_id = :teamId", { id: pick.sourceId, teamId: team.id })
        .getOne();
      if (!source || source.kind !== "group") throw new DomainError("群组不在这个 Team 工作区中");
      if (!source.gitTokenEncrypted) throw new DomainError("群组未配置 Git 访问令牌");
      let repos = listedCache.get(source.id);
      if (!repos) {
        const token = decryptSecret(source.gitTokenEncrypted, this.encryptionKey());
        repos = (await this.git.listGroup(source.url, token)).repos;
        listedCache.set(source.id, repos);
      }
      const wanted = repoIdentity(pick.repoUrl);
      const repo = repos.find((item) => repoIdentity(item.repoUrl) === wanted);
      if (!repo) throw new DomainError(`所选仓库不在群组 ${source.name} 中`);
      prepared.push({
        repo,
        tokenEncrypted: source.gitTokenEncrypted,
        baseline: repo.defaultBranch || source.baselineRef || "main",
      });
    }
    return this.dataSource.transaction(async (manager) => {
      const ids: string[] = [];
      for (const item of prepared) {
        ids.push(await this.ensureWorkspaceRepo(manager, team, { ...item, replaceBaseline: false }));
      }
      return ids;
    });
  }

  private async ensureWorkspaceRepo(
    manager: DataSource["manager"],
    team: TeamEntity,
    item: { repo: RemoteRepo; tokenEncrypted: string; baseline: string; replaceBaseline: boolean },
  ) {
    const canonical = canonicalRepoUrl(item.repo.repoUrl) ?? item.repo.repoUrl;
    let service = await this.findProjectService(team.projectId, canonical, manager);
    if (!service) {
      const name = await this.uniqueServiceName(manager, team.projectId, item.repo.path || item.repo.name);
      service = await manager.save(
        manager.create(ServiceEntity, {
          projectId: team.projectId,
          name,
          repoUrl: canonical,
          defaultBranch: item.baseline,
          imageName: (item.repo.path || name).slice(0, 200),
          gitTokenEncrypted: null,
        }),
      );
    }
    await manager.update(ServiceEntity, service.id, { gitTokenEncrypted: item.tokenEncrypted });
    const workspace = await manager.findOne(TeamWorkspaceEntity, { where: { teamId: team.id, serviceId: service.id } });
    if (!workspace) {
      await manager.save(
        manager.create(TeamWorkspaceEntity, {
          teamId: team.id,
          serviceId: service.id,
          baselineRef: item.baseline,
        }),
      );
    } else if (item.replaceBaseline) {
      workspace.baselineRef = item.baseline;
      await manager.save(workspace);
    }
    return service.id;
  }

  private async findProjectService(projectId: string, repoUrl: string, manager?: DataSource["manager"]) {
    const identity = repoIdentity(repoUrl);
    if (!identity) return null;
    const services = manager
      ? await manager.find(ServiceEntity, { where: { projectId } })
      : await this.services.find({ where: { projectId } });
    return services.find((service) => repoIdentity(service.repoUrl) === identity) ?? null;
  }

  private async uniqueServiceName(manager: DataSource["manager"], projectId: string, raw: string) {
    const seed = raw.trim().slice(0, 60) || "repo";
    const rows = await manager.find(ServiceEntity, { where: { projectId } });
    const taken = new Set(rows.map((row) => row.name));
    if (!taken.has(seed)) return seed;
    for (let index = 2; index < 100; index += 1) {
      const suffix = `-${index}`;
      const candidate = `${seed.slice(0, 64 - suffix.length)}${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new DomainError("无法为仓库生成唯一名称");
  }

  private async requireOwnedRole(userId: string, roleId: string) {
    const role = await this.roles.findOne({ where: { id: roleId, ownerId: userId, projectId: IsNull() } });
    if (!role) throw new DomainError("角色不存在", 404);
    return role;
  }

  private async requireRole(roleId: string) {
    const role = await this.roles.findOne({ where: { id: roleId } });
    if (!role) throw new DomainError("角色不存在", 404);
    return role;
  }

  private async requireMember(teamId: string, memberId: string) {
    const member = await this.members.findOne({ where: { id: memberId, teamId } });
    if (!member) throw new DomainError("成员不存在", 404);
    return member;
  }

  private async presentMember(member: TeamMemberEntity) {
    const role = await this.roles.findOne({ where: { id: member.roleId } });
    const links = await this.memberServices.find({ where: { memberId: member.id } });
    const agent = member.memberType === "agent" ? await this.agents.findOne({ where: { memberId: member.id } }) : null;
    const workspaces = agent ? await this.agentWorkspaces.find({ where: { agentId: agent.id } }) : [];
    const services = links.length ? await this.services.find({ where: { id: In(links.map((link) => link.serviceId)) } }) : [];
    const contactRows = await this.contacts.find({ where: { memberId: member.id } });
    const peers = contactRows.length
      ? await this.members.find({ where: { id: In(contactRows.map((row) => row.peerMemberId)) } })
      : [];
    const peerRoles = peers.length
      ? await this.roles.find({ where: { id: In([...new Set(peers.map((peer) => peer.roleId))]) } })
      : [];
    return {
      id: member.id,
      teamId: member.teamId,
      memberType: member.memberType,
      userId: member.userId,
      name: member.name,
      roleId: member.roleId,
      roleName: role?.name ?? "",
      roleCode: role?.code ?? "",
      permissions: role?.permissions ?? [],
      dutyOverride: member.dutyOverride,
      status: member.status,
      failureReason: member.failureReason,
      testedServiceVersionId: member.testedServiceVersionId,
      serviceIds: links.map((link) => link.serviceId),
      services: services.map((service) => ({ id: service.id, name: service.name, repoUrl: service.repoUrl })),
      contacts: peers.map((peer) => ({
        id: peer.id,
        name: peer.name,
        memberType: peer.memberType,
        roleName: peerRoles.find((role) => role.id === peer.roleId)?.name ?? "",
      })),
      agent: agent
        ? {
            id: agent.id,
            platform: agent.platform,
            externalAgentId: agent.externalAgentId,
            model: agent.model,
            runtime: agent.runtime,
            status: agent.status,
            workspaces,
          }
        : null,
    };
  }
}

type MonitorSessionRow = {
  id: string;
  work_item_id: string | null;
  prompt: string;
  status: string;
  error_message: string | null;
  external_run_id: string | null;
  usage: RunUsageSnapshot | string | null;
  duration_ms: number | null;
  created_at: Date | string;
  finished_at: Date | string | null;
  log_preview: string | null;
  member_id: string;
};

function readUsage(value: RunUsageSnapshot | string | null): RunUsageSnapshot | null {
  if (!value) return null;
  const parsed = typeof value === "string" ? (JSON.parse(value) as RunUsageSnapshot) : value;
  if (!parsed || typeof parsed.totalTokens !== "number") return null;
  return {
    inputTokens: parsed.inputTokens ?? 0,
    outputTokens: parsed.outputTokens ?? 0,
    cacheReadTokens: parsed.cacheReadTokens ?? 0,
    cacheWriteTokens: parsed.cacheWriteTokens ?? 0,
    totalTokens: parsed.totalTokens ?? 0,
    reasoningTokens: parsed.reasoningTokens ?? 0,
    rawCostCents: parsed.rawCostCents ?? null,
    chargedCents: parsed.chargedCents ?? null,
  };
}

function sumUsage(items: Array<RunUsageSnapshot | null>): RunUsageSnapshot | null {
  const present = items.filter((item): item is RunUsageSnapshot => Boolean(item));
  if (present.length === 0) return null;
  return present.reduce(
    (total, item) => ({
      inputTokens: total.inputTokens + item.inputTokens,
      outputTokens: total.outputTokens + item.outputTokens,
      cacheReadTokens: total.cacheReadTokens + item.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + item.cacheWriteTokens,
      totalTokens: total.totalTokens + item.totalTokens,
      reasoningTokens: total.reasoningTokens + item.reasoningTokens,
      rawCostCents: addCents(total.rawCostCents, item.rawCostCents),
      chargedCents: addCents(total.chargedCents, item.chargedCents),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      rawCostCents: null,
      chargedCents: null,
    } satisfies RunUsageSnapshot,
  );
}

function addCents(left: number | null, right: number | null) {
  if (left == null && right == null) return null;
  return (left ?? 0) + (right ?? 0);
}

type PlannedRepoWorkspace = {
  serviceId: string;
  parentWorkspaceId: string;
  repoUrl: string;
  baselineRef: string;
  branch: string;
  forked: boolean;
  branchOrigin: AgentWorkspaceEntity["branchOrigin"];
  gitSha: string | null;
};

type BranchPlan = {
  create: boolean;
  mode?: "default" | "custom" | "existing";
  name?: string;
  existing?: { serviceId?: string; repoUrl?: string; branch: string }[];
};

type PreservedWorkspace = {
  branch: string;
  forked: boolean;
  forkStatus: AgentWorkspaceEntity["forkStatus"];
  branchOrigin: AgentWorkspaceEntity["branchOrigin"];
  gitSha: string | null;
};

function baselineWorkspace(baselineRef: string): PreservedWorkspace {
  return { branch: baselineRef, forked: false, forkStatus: "ready", branchOrigin: "baseline", gitSha: null };
}
