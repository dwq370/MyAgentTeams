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
  parseGitGroup,
  parseGitRepo,
  RemoteRepo,
  repoIdentity,
  workspaceBranch,
} from "../domain/policy";
import {
  AgentEntity,
  AgentWorkspaceEntity,
  MemberServiceEntity,
  ProjectRoleEntity,
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
      if (service) {
        const occupied = await this.dataSource.query(
          `SELECT count(*)::int AS count FROM member_service ms
           JOIN team_member tm ON tm.id = ms.member_id
           WHERE tm.team_id = $1 AND ms.service_id = $2`,
          [teamId, service.id],
        );
        if (Number(occupied[0]?.count) > 0) throw new DomainError("该仓库已分配给成员，不能移除", 409);
        await this.workspaces.delete({ teamId, serviceId: service.id });
      }
    }
    await this.sources.delete(source.id);
    return { ok: true };
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
    },
  ) {
    const { team } = await this.access.requireTeam(userId, teamId, "admin");
    const role = await this.requireOwnedRole(userId, input.roleId);
    const serviceIds = await this.assignedServiceIds(team, role.permissions, input.serviceIds, input.groupRepos);
    await this.assertAssignment(teamId, role.permissions, serviceIds, input.testedServiceVersionId);
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
      await this.writeWorkspaces(manager, agent.id, member.name, teamId, role.permissions, serviceIds);
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
    if (input.name && member.memberType === "agent") member.name = input.name.trim();
    if (tested !== undefined) member.testedServiceVersionId = tested;
    await this.members.save(member);
    if (servicesTouched && !agent?.externalAgentId) {
      await this.dataSource.transaction(async (manager) => {
        await this.replaceServices(manager, member.id, serviceIds);
        if (agent) {
          await manager.delete(AgentWorkspaceEntity, { agentId: agent.id });
          await this.writeWorkspaces(manager, agent.id, member.name, teamId, nextRole.permissions, serviceIds);
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

  async removeMember(userId: string, teamId: string, memberId: string) {
    const { membership } = await this.access.requireTeam(userId, teamId, "member");
    const member = await this.requireMember(teamId, memberId);
    const isSelf = member.userId === userId;
    if (membership.projectRole === "member" && !isSelf) throw new DomainError("需要项目管理员权限", 403);
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
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(AgentWorkspaceEntity, { agentId: agent.id });
      await this.writeWorkspaces(manager, agent.id, member.name, member.teamId, role.permissions, serviceIds);
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
    agentId: string,
    agentName: string,
    teamId: string,
    permissions: string[],
    serviceIds: string[],
  ) {
    const teamWorkspaces = await manager.find(TeamWorkspaceEntity, { where: { teamId } });
    const fork = forksWorkspace(permissions);
    const selected = teamWorkspaces.filter((workspace) => (fork ? serviceIds.includes(workspace.serviceId) : true));
    if (fork && selected.length === 0) throw new DomainError("没有可 fork 的服务工作区");
    const serviceRows = selected.length
      ? await manager.find(ServiceEntity, { where: { id: In(selected.map((workspace) => workspace.serviceId)) } })
      : [];
    for (const workspace of selected) {
      const service = serviceRows.find((item) => item.id === workspace.serviceId);
      if (!service) continue;
      await manager.save(
        manager.create(AgentWorkspaceEntity, {
          agentId,
          parentWorkspaceId: workspace.id,
          serviceId: service.id,
          repoUrl: service.repoUrl,
          branch: fork ? workspaceBranch(agentName, agentId, service.name) : workspace.baselineRef,
          baselineRef: workspace.baselineRef,
          forked: fork,
          forkStatus: fork ? "planned" : "ready",
          gitSha: null,
        }),
      );
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
      services: services.map((service) => ({ id: service.id, name: service.name })),
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
