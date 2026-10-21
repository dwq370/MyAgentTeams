import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";
import { AgentEnginesService } from "../agent-engines/agent-engines.service";
import { AccessService } from "../common/access.service";
import { decryptSecret, encryptSecret, secretHint } from "../common/crypto";
import { DomainError } from "../domain/errors";
import { assertKnownPermissions, parseGitRepo, PERMISSIONS } from "../domain/policy";
import {
  AgentEntity,
  AgentRunEntity,
  ProjectEntity,
  ProjectMemberEntity,
  ProjectRoleEntity,
  ServiceEntity,
  TeamMemberEntity,
  TeamEntity,
  TestEnvironmentEntity,
  UserEntity,
} from "../entities";
import { writeArchitectureFile } from "../platform/architecture-file";
import { QueueService } from "../platform/queue.service";
import { KubectlProbe } from "../platform/kubectl";
import { SshProbe } from "../platform/ssh-probe";

@Injectable()
export class ProjectsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: AccessService,
    private readonly engines: AgentEnginesService,
    private readonly config: ConfigService,
    private readonly kubectl: KubectlProbe,
    private readonly ssh: SshProbe,
    private readonly queue: QueueService,
    @InjectRepository(ProjectEntity) private readonly projects: Repository<ProjectEntity>,
    @InjectRepository(ProjectMemberEntity) private readonly projectMembers: Repository<ProjectMemberEntity>,
    @InjectRepository(ProjectRoleEntity) private readonly roles: Repository<ProjectRoleEntity>,
    @InjectRepository(ServiceEntity) private readonly services: Repository<ServiceEntity>,
    @InjectRepository(TestEnvironmentEntity) private readonly environments: Repository<TestEnvironmentEntity>,
    @InjectRepository(TeamEntity) private readonly teams: Repository<TeamEntity>,
    @InjectRepository(TeamMemberEntity) private readonly teamMembers: Repository<TeamMemberEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(AgentEntity) private readonly agents: Repository<AgentEntity>,
    @InjectRepository(AgentRunEntity) private readonly runs: Repository<AgentRunEntity>,
  ) {}

  async create(userId: string, input: { name: string; description?: string }) {
    return this.dataSource.transaction(async (manager) => {
      const project = await manager.save(
        manager.create(ProjectEntity, {
          name: input.name.trim(),
          description: input.description?.trim() ?? "",
          architectureDescription: "",
          ownerId: userId,
        }),
      );
      await manager.save(
        manager.create(ProjectMemberEntity, { projectId: project.id, userId, projectRole: "owner" }),
      );
      return this.presentProject(project, "owner");
    });
  }

  async list(userId: string) {
    const memberships = await this.projectMembers.find({ where: { userId } });
    const items = [];
    for (const membership of memberships) {
      const project = await this.projects.findOne({ where: { id: membership.projectId } });
      if (project) items.push(this.presentProject(project, membership.projectRole));
    }
    return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async get(userId: string, projectId: string) {
    const membership = await this.access.requireProject(userId, projectId, "member");
    const project = await this.requireProject(projectId);
    const [services, roles, teams, members, environments] = await Promise.all([
      this.services.count({ where: { projectId } }),
      this.roles.count({ where: { projectId } }),
      this.teams.count({ where: { projectId } }),
      this.projectMembers.count({ where: { projectId } }),
      this.environments.count({ where: { projectId } }),
    ]);
    const agentEngine = await this.engines.summary(project.agentEngineId);
    return {
      ...this.presentProject(project, membership.projectRole),
      counts: { services, roles, teams, members, environments },
      agentEngine,
      cursorConfigured: Boolean(agentEngine),
    };
  }

  async bindEngine(userId: string, projectId: string, agentEngineId: string | null) {
    await this.access.requireProject(userId, projectId, "owner");
    if (agentEngineId) await this.engines.requireOwned(userId, agentEngineId);
    await this.projects.update(projectId, { agentEngineId });
    return this.get(userId, projectId);
  }

  async update(userId: string, projectId: string, input: { name?: string; description?: string; architectureDescription?: string }) {
    await this.access.requireProject(userId, projectId, "admin");
    const project = await this.requireProject(projectId);
    const patch: { name?: string; description?: string; architectureDescription?: string } = {};
    if (input.name) patch.name = input.name.trim();
    if (input.description !== undefined) patch.description = input.description.trim();
    if (input.architectureDescription !== undefined) {
      const text = input.architectureDescription.trim();
      await writeArchitectureFile(this.config.get<string>("REPO_ROOT") || "/var/agentteam/repos", projectId, text);
      patch.architectureDescription = text;
    }
    if (Object.keys(patch).length > 0) await this.projects.update(projectId, patch);
    const membership = await this.access.requireProject(userId, projectId, "member");
    return this.presentProject({ ...project, ...patch }, membership.projectRole);
  }

  async listArchitects(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "member");
    const teams = await this.teams.find({ where: { projectId } });
    if (teams.length === 0) return [];
    const members = await this.teamMembers.find({ where: { teamId: In(teams.map((team) => team.id)), memberType: "agent" } });
    if (members.length === 0) return [];
    const roles = await this.roles.find({ where: { id: In(members.map((member) => member.roleId)) } });
    const agents = await this.agents.find({ where: { memberId: In(members.map((member) => member.id)) } });
    return members.flatMap((member) => {
      const role = roles.find((item) => item.id === member.roleId);
      const agent = agents.find((item) => item.memberId === member.id);
      if (!role?.permissions.includes("architecture:write") || !agent) return [];
      return [{
        agentId: agent.id,
        name: member.name,
        teamId: member.teamId,
        teamName: teams.find((team) => team.id === member.teamId)?.name ?? "",
        status: member.status,
      }];
    });
  }

  async generateArchitecture(
    userId: string,
    projectId: string,
    input: { agentId: string; source: "document" | "code"; document?: string },
  ) {
    await this.access.requireProject(userId, projectId, "admin");
    const agent = await this.agents.findOne({ where: { id: input.agentId } });
    if (!agent) throw new DomainError("架构师不存在", 404);
    const member = await this.teamMembers.findOne({ where: { id: agent.memberId } });
    const team = member ? await this.teams.findOne({ where: { id: member.teamId } }) : null;
    if (!member || !team || team.projectId !== projectId) throw new DomainError("架构师不在这个项目中", 404);
    const role = await this.roles.findOne({ where: { id: member.roleId } });
    if (!role?.permissions.includes("architecture:write")) throw new DomainError("请选择系统架构师");
    if (member.status !== "active" || agent.status !== "active" || !agent.externalAgentId) {
      throw new DomainError("架构师还不可用，请等待创建完成");
    }
    const active = await this.runs.find({ where: { agentId: agent.id, status: In(["queued", "running"]) } });
    if (active.length > 0) throw new DomainError("架构师正在执行任务", 409);
    const document = input.document?.trim() ?? "";
    if (input.source === "document" && !document) throw new DomainError("请填写或上传要阅读的文档");
    const prompt = input.source === "document"
      ? `请阅读下面的文档，整理成项目架构描述。正文会保存为 architecture.md，并作为架构师之后评估需求和分解任务的依据。只输出架构文档正文，使用 Markdown。\n\n${document}`
      : "请按 Team 工作区的基线检出只读代码并通读源码，整理成项目架构描述。正文会保存为 architecture.md，并作为架构师之后评估需求和分解任务的依据。不要创建远端分支。只输出架构文档正文，使用 Markdown。包含系统上下文、模块边界、主要接口、数据和处理流程。不确定的地方明确写成假设。";
    const run = await this.runs.save(this.runs.create({
      agentId: agent.id,
      workItemId: null,
      prompt,
      composedPrompt: "",
      roleSnapshot: { source: input.source },
      status: "queued",
      log: "",
      purpose: "architecture",
      targetProjectId: projectId,
    }));
    await this.queue.enqueue({ kind: "send-run", runId: run.id }, `run-${run.id}`);
    return { id: run.id, agentId: agent.id };
  }

  async remove(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "owner");
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE team_member SET tested_service_version_id = NULL
         WHERE team_id IN (SELECT id FROM team WHERE project_id = $1)`,
        [projectId],
      );
      await manager.query(
        `DELETE FROM test_report WHERE service_version_id IN (
           SELECT id FROM service_version WHERE service_id IN (SELECT id FROM service WHERE project_id = $1)
         )`,
        [projectId],
      );
      await manager.query(
        `DELETE FROM system_release_item WHERE release_id IN (SELECT id FROM system_release WHERE project_id = $1)`,
        [projectId],
      );
      await manager.query(`DELETE FROM system_release WHERE project_id = $1`, [projectId]);
      await manager.query(
        `UPDATE service_version SET created_by_member_id = NULL
         WHERE service_id IN (SELECT id FROM service WHERE project_id = $1)`,
        [projectId],
      );
      await manager.query(
        `DELETE FROM service_version WHERE service_id IN (SELECT id FROM service WHERE project_id = $1)`,
        [projectId],
      );
      await manager.query(
        `DELETE FROM agent_run WHERE agent_id IN (
           SELECT a.id FROM agent a
           JOIN team_member tm ON tm.id = a.member_id
           JOIN team t ON t.id = tm.team_id
           WHERE t.project_id = $1
         )`,
        [projectId],
      );
      await manager.query(
        `DELETE FROM agent_workspace WHERE agent_id IN (
           SELECT a.id FROM agent a
           JOIN team_member tm ON tm.id = a.member_id
           JOIN team t ON t.id = tm.team_id
           WHERE t.project_id = $1
         )`,
        [projectId],
      );
      await manager.query(
        `DELETE FROM agent WHERE member_id IN (
           SELECT tm.id FROM team_member tm JOIN team t ON t.id = tm.team_id WHERE t.project_id = $1
         )`,
        [projectId],
      );
      await manager.query(
        `DELETE FROM member_service WHERE member_id IN (
           SELECT tm.id FROM team_member tm JOIN team t ON t.id = tm.team_id WHERE t.project_id = $1
         )`,
        [projectId],
      );
      await manager.query(`DELETE FROM work_item WHERE team_id IN (SELECT id FROM team WHERE project_id = $1)`, [projectId]);
      await manager.query(`DELETE FROM team_member WHERE team_id IN (SELECT id FROM team WHERE project_id = $1)`, [projectId]);
      await manager.query(`DELETE FROM team_workspace WHERE team_id IN (SELECT id FROM team WHERE project_id = $1)`, [projectId]);
      await manager.query(`DELETE FROM team WHERE project_id = $1`, [projectId]);
      await manager.query(`DELETE FROM project_role WHERE project_id = $1`, [projectId]);
      await manager.query(`DELETE FROM service WHERE project_id = $1`, [projectId]);
      await manager.query(`DELETE FROM project_platform WHERE project_id = $1`, [projectId]);
      await manager.query(`DELETE FROM project_member WHERE project_id = $1`, [projectId]);
      await manager.query(`DELETE FROM project WHERE id = $1`, [projectId]);
    });
    return { ok: true };
  }

  async listMembers(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "member");
    const memberships = await this.projectMembers.find({ where: { projectId } });
    const items = [];
    for (const membership of memberships) {
      const user = await this.users.findOne({ where: { id: membership.userId } });
      if (!user) continue;
      items.push({
        userId: user.id,
        email: user.email,
        name: user.name,
        projectRole: membership.projectRole,
      });
    }
    return items;
  }

  async addMember(userId: string, projectId: string, input: { email: string; projectRole: "admin" | "member" }) {
    await this.access.requireProject(userId, projectId, "admin");
    const user = await this.users.findOne({ where: { email: input.email.trim().toLowerCase() } });
    if (!user) throw new DomainError("用户尚未注册", 404);
    const existing = await this.projectMembers.findOne({ where: { projectId, userId: user.id } });
    if (existing) throw new DomainError("用户已在项目中", 409);
    await this.projectMembers.save(
      this.projectMembers.create({ projectId, userId: user.id, projectRole: input.projectRole }),
    );
    return { userId: user.id, email: user.email, name: user.name, projectRole: input.projectRole };
  }

  async updateMember(userId: string, projectId: string, targetUserId: string, projectRole: "admin" | "member") {
    await this.access.requireProject(userId, projectId, "admin");
    const membership = await this.projectMembers.findOne({ where: { projectId, userId: targetUserId } });
    if (!membership) throw new DomainError("项目成员不存在", 404);
    if (membership.projectRole === "owner") throw new DomainError("不能修改所有者", 400);
    membership.projectRole = projectRole;
    await this.projectMembers.save(membership);
    return { ok: true };
  }

  async removeMember(userId: string, projectId: string, targetUserId: string) {
    await this.access.requireProject(userId, projectId, "admin");
    const membership = await this.projectMembers.findOne({ where: { projectId, userId: targetUserId } });
    if (!membership) throw new DomainError("项目成员不存在", 404);
    if (membership.projectRole === "owner") throw new DomainError("不能移除所有者", 400);
    await this.projectMembers.delete({ id: membership.id });
    return { ok: true };
  }

  async listServices(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "member");
    const services = await this.services
      .createQueryBuilder("service")
      .addSelect("service.gitTokenEncrypted")
      .where("service.projectId = :projectId", { projectId })
      .orderBy("service.name", "ASC")
      .getMany();
    return services.map((service) => this.presentService(service));
  }

  async listEnvironments(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "member");
    const rows = await this.environments
      .createQueryBuilder("env")
      .addSelect("env.sshPasswordEncrypted")
      .where("env.projectId = :projectId", { projectId })
      .orderBy("env.name", "ASC")
      .getMany();
    return rows.map((row) => this.presentEnvironment(row));
  }

  async probeEnvironment(
    userId: string,
    projectId: string,
    input: {
      kind: "standalone" | "kubernetes";
      environmentId?: string;
      sshHost?: string;
      sshPort?: number;
      sshUsername?: string;
      sshPassword?: string;
      kubectlClient?: "local";
      kubeContext?: string;
    },
  ) {
    await this.access.requireProject(userId, projectId, "admin");
    const existing = input.environmentId ? await this.loadEnvironment(projectId, input.environmentId) : null;
    const checked = await this.checkConnection(input, existing);
    return checked.info;
  }

  async createEnvironment(
    userId: string,
    projectId: string,
    input: {
      name: string;
      kind: "standalone" | "kubernetes";
      sshHost?: string;
      sshPort?: number;
      sshUsername?: string;
      sshPassword?: string;
      kubectlClient?: "local";
      kubeContext?: string;
    },
  ) {
    await this.access.requireProject(userId, projectId, "admin");
    const name = input.name.trim();
    await this.assertEnvironmentNameFree(projectId, name);
    const checked = await this.checkConnection(input, null);
    const environment = await this.environments.save(this.environments.create({ projectId, name, deployEntry: "", ...checked.fields }));
    if (checked.passwordEncrypted !== undefined) {
      await this.environments.update(environment.id, { sshPasswordEncrypted: checked.passwordEncrypted });
    }
    return this.presentEnvironment({ ...environment, ...checked.fields, sshPasswordEncrypted: checked.passwordEncrypted ?? null });
  }

  async updateEnvironment(
    userId: string,
    projectId: string,
    environmentId: string,
    input: {
      name?: string;
      kind?: "standalone" | "kubernetes";
      sshHost?: string;
      sshPort?: number;
      sshUsername?: string;
      sshPassword?: string;
      kubectlClient?: "local";
      kubeContext?: string;
    },
  ) {
    await this.access.requireProject(userId, projectId, "admin");
    const environment = await this.loadEnvironment(projectId, environmentId);
    if (input.name && input.name.trim() !== environment.name) {
      await this.assertEnvironmentNameFree(projectId, input.name.trim(), environment.id);
      environment.name = input.name.trim();
    }
    const kind = input.kind ?? environment.kind;
    const checked = await this.checkConnection(
      {
        kind,
        sshHost: input.sshHost ?? environment.sshHost ?? undefined,
        sshPort: input.sshPort ?? environment.sshPort ?? undefined,
        sshUsername: input.sshUsername ?? environment.sshUsername ?? undefined,
        sshPassword: input.sshPassword,
        kubectlClient: kind === "kubernetes" ? "local" : undefined,
        kubeContext: input.kubeContext ?? environment.kubeContext ?? undefined,
      },
      environment,
    );
    Object.assign(environment, checked.fields);
    await this.environments.save(environment);
    await this.environments.update(environment.id, { sshPasswordEncrypted: checked.passwordEncrypted ?? null });
    return this.presentEnvironment({ ...environment, sshPasswordEncrypted: checked.passwordEncrypted ?? null });
  }

  async removeEnvironment(userId: string, projectId: string, environmentId: string) {
    await this.access.requireProject(userId, projectId, "admin");
    const environment = await this.environments.findOne({ where: { id: environmentId, projectId } });
    if (!environment) throw new DomainError("测试环境不存在", 404);
    const teams = await this.teams.find({ where: { testEnvironmentId: environmentId } });
    if (teams.length > 0) {
      throw new DomainError("仍有 Team 选用该测试环境，不能删除", 409, {
        teams: teams.map((team) => ({ id: team.id, name: team.name })),
      });
    }
    await this.environments.delete({ id: environmentId });
    return { ok: true };
  }

  async listRoles(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "member");
    const roles = await this.roles.find({ where: { projectId }, order: { isBuiltin: "DESC", code: "ASC" } });
    return roles.map((role) => this.presentRole(role));
  }

  permissionCatalog() {
    return PERMISSIONS;
  }

  async createRole(
    userId: string,
    projectId: string,
    input: { code: string; name: string; description?: string; duties: string; promptTemplate: string; permissions: string[] },
  ) {
    await this.access.requireProject(userId, projectId, "admin");
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(input.code)) {
      throw new DomainError("角色编码需为大写字母开头，只含大写字母、数字和下划线");
    }
    assertKnownPermissions(input.permissions);
    const role = await this.roles.save(
      this.roles.create({
        projectId,
        code: input.code,
        name: input.name.trim(),
        description: input.description?.trim() ?? "",
        duties: input.duties.trim(),
        promptTemplate: input.promptTemplate.trim(),
        permissions: input.permissions,
        isBuiltin: false,
      }),
    );
    return this.presentRole(role);
  }

  async updateRole(
    userId: string,
    projectId: string,
    roleId: string,
    input: { name?: string; description?: string; duties?: string; promptTemplate?: string; permissions?: string[] },
  ) {
    await this.access.requireProject(userId, projectId, "admin");
    const role = await this.roles.findOne({ where: { id: roleId, projectId } });
    if (!role) throw new DomainError("角色不存在", 404);
    if (input.name) role.name = input.name.trim();
    if (input.description !== undefined) role.description = input.description.trim();
    if (input.duties !== undefined) role.duties = input.duties.trim();
    if (input.promptTemplate !== undefined) role.promptTemplate = input.promptTemplate.trim();
    if (input.permissions) {
      assertKnownPermissions(input.permissions);
      role.permissions = input.permissions;
    }
    await this.roles.save(role);
    return this.presentRole(role);
  }

  async removeRole(userId: string, projectId: string, roleId: string) {
    await this.access.requireProject(userId, projectId, "admin");
    const role = await this.roles.findOne({ where: { id: roleId, projectId } });
    if (!role) throw new DomainError("角色不存在", 404);
    const members = await this.teamMembers
      .createQueryBuilder("member")
      .innerJoin(TeamEntity, "team", "team.id = member.team_id")
      .where("member.role_id = :roleId AND team.project_id = :projectId", { roleId, projectId })
      .getMany();
    if (members.length > 0) {
      throw new DomainError("仍有成员使用该角色，不能删除", 409, {
        members: members.map((member) => ({
          id: member.id,
          name: member.name,
          memberType: member.memberType,
        })),
      });
    }
    await this.roles.delete({ id: roleId });
    return { ok: true };
  }

  private presentProject(project: ProjectEntity, projectRole: string) {
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      architectureDescription: project.architectureDescription ?? "",
      ownerId: project.ownerId,
      projectRole,
      createdAt: project.createdAt,
    };
  }

  private presentRole(role: ProjectRoleEntity) {
    return {
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      duties: role.duties,
      promptTemplate: role.promptTemplate,
      permissions: role.permissions,
      isBuiltin: role.isBuiltin,
    };
  }

  private async requireProject(projectId: string) {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw new DomainError("项目不存在", 404);
    return project;
  }

  private presentService(service: ServiceEntity) {
    const parsed = parseGitRepo(service.repoUrl);
    const token = service.gitTokenEncrypted ? decryptSecret(service.gitTokenEncrypted, this.encryptionKey()) : null;
    return {
      id: service.id,
      name: service.name,
      repoUrl: service.repoUrl,
      defaultBranch: service.defaultBranch,
      imageName: service.imageName,
      host: parsed?.host ?? "gitlab",
      gitConfigured: Boolean(token),
      gitHint: token ? secretHint(token) : null,
    };
  }

  private async loadEnvironment(projectId: string, environmentId: string) {
    const environment = await this.environments
      .createQueryBuilder("env")
      .addSelect("env.sshPasswordEncrypted")
      .where("env.id = :environmentId AND env.projectId = :projectId", { environmentId, projectId })
      .getOne();
    if (!environment) throw new DomainError("测试环境不存在", 404);
    return environment;
  }

  private async checkConnection(
    input: {
      kind: "standalone" | "kubernetes";
      sshHost?: string;
      sshPort?: number;
      sshUsername?: string;
      sshPassword?: string;
      kubectlClient?: "local";
      kubeContext?: string;
    },
    existing: TestEnvironmentEntity | null,
  ) {
    if (input.kind === "kubernetes") {
      if (input.kubectlClient && input.kubectlClient !== "local") throw new DomainError("请选择本地 kubectl 客户端");
      const info = await this.kubectl.inspect(input.kubeContext);
      return {
        info,
        passwordEncrypted: null,
        fields: {
          kind: "kubernetes" as const,
          url: info.server,
          sshHost: null,
          sshPort: null,
          sshUsername: null,
          kubeContext: info.context,
          clusterServer: info.server,
          connectionInfo: info as unknown as Record<string, unknown>,
        },
      };
    }
    const host = input.sshHost?.trim() || "";
    const username = input.sshUsername?.trim() || "";
    const port = input.sshPort ?? 22;
    const password = input.sshPassword?.trim() || (existing?.sshPasswordEncrypted ? decryptSecret(existing.sshPasswordEncrypted, this.encryptionKey()) : "");
    const probe = await this.ssh.probe({ host, port, username, password });
    return {
      info: probe,
      passwordEncrypted: encryptSecret(password, this.encryptionKey()),
      fields: {
        kind: "standalone" as const,
        url: null,
        sshHost: probe.host,
        sshPort: probe.port,
        sshUsername: probe.username,
        kubeContext: null,
        clusterServer: null,
        connectionInfo: probe as unknown as Record<string, unknown>,
      },
    };
  }

  private presentEnvironment(environment: TestEnvironmentEntity) {
    return {
      id: environment.id,
      name: environment.name,
      kind: environment.kind,
      url: environment.url,
      deployEntry: environment.deployEntry,
      sshHost: environment.sshHost,
      sshPort: environment.sshPort,
      sshUsername: environment.sshUsername,
      passwordConfigured: Boolean(environment.sshPasswordEncrypted),
      kubeContext: environment.kubeContext,
      clusterServer: environment.clusterServer,
      connectionInfo: environment.connectionInfo,
    };
  }

  private async assertEnvironmentNameFree(projectId: string, name: string, exceptId?: string) {
    const existing = await this.environments.findOne({ where: { projectId, name } });
    if (existing && existing.id !== exceptId) throw new DomainError("已有同名测试环境", 409);
  }

  private encryptionKey() {
    return this.config.getOrThrow<string>("APP_ENCRYPTION_KEY");
  }
}
