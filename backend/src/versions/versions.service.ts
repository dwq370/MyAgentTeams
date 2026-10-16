import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { AccessService } from "../common/access.service";
import { DomainError } from "../domain/errors";
import { assertCanRecordTest, assertReleaseItems, assertVersionTransition, imageTagFor, tagNameForVersion } from "../domain/policy";
import {
  MemberServiceEntity,
  ProjectRoleEntity,
  ServiceEntity,
  ServiceVersionEntity,
  SystemReleaseEntity,
  SystemReleaseItemEntity,
  TeamWorkspaceEntity,
  TestReportEntity,
} from "../entities";
import { GitRepoClient } from "../platform/git-repo";

@Injectable()
export class VersionsService {
  constructor(
    private readonly access: AccessService,
    private readonly git: GitRepoClient,
    @InjectRepository(ServiceEntity) private readonly services: Repository<ServiceEntity>,
    @InjectRepository(ServiceVersionEntity) private readonly versions: Repository<ServiceVersionEntity>,
    @InjectRepository(TestReportEntity) private readonly reports: Repository<TestReportEntity>,
    @InjectRepository(TeamWorkspaceEntity) private readonly workspaces: Repository<TeamWorkspaceEntity>,
    @InjectRepository(MemberServiceEntity) private readonly memberServices: Repository<MemberServiceEntity>,
    @InjectRepository(SystemReleaseEntity) private readonly releases: Repository<SystemReleaseEntity>,
    @InjectRepository(SystemReleaseItemEntity) private readonly releaseItems: Repository<SystemReleaseItemEntity>,
    @InjectRepository(ProjectRoleEntity) private readonly roles: Repository<ProjectRoleEntity>,
  ) {}

  async listForTeam(userId: string, teamId: string) {
    await this.access.requireTeam(userId, teamId, "member");
    const workspaces = await this.workspaces.find({ where: { teamId } });
    const serviceIds = workspaces.map((workspace) => workspace.serviceId);
    const services = serviceIds.length ? await this.services.find({ where: { id: In(serviceIds) }, order: { name: "ASC" } }) : [];
    const versions = serviceIds.length
      ? await this.versions.find({ where: { serviceId: In(serviceIds), teamId }, order: { createdAt: "DESC" } })
      : [];
    const reports = versions.length
      ? await this.reports.find({ where: { serviceVersionId: In(versions.map((version) => version.id)) }, order: { createdAt: "DESC" } })
      : [];
    return { services, versions, reports };
  }

  async createVersion(userId: string, serviceId: string, input: { teamId: string; version: string; gitSha?: string }) {
    const { human } = await this.access.requireHumanTeammate(userId, input.teamId);
    await this.assertServicePermission(human.id, human.roleId, serviceId, input.teamId, "service:version:create");
    const existing = await this.versions.findOne({ where: { serviceId, version: input.version } });
    if (existing) throw new DomainError("该服务版本已存在", 409);
    return this.versions.save(
      this.versions.create({
        serviceId,
        teamId: input.teamId,
        version: input.version,
        gitSha: input.gitSha?.trim() || null,
        status: "draft",
        tagStatus: "none",
        createdByMemberId: human.id,
      }),
    );
  }

  async transition(userId: string, serviceId: string, versionId: string, input: { teamId: string; to: "ready_for_test" | "testing" }) {
    const { human, role } = await this.access.requireHumanTeammate(userId, input.teamId);
    const version = await this.requireVersion(serviceId, versionId, input.teamId);
    const permission = input.to === "ready_for_test" ? "service:version:create" : "service:test";
    if (!role.permissions.includes(permission)) throw new DomainError("当前角色没有该权限", 403);
    await this.assertAssigned(human.id, serviceId);
    assertVersionTransition(version.status, input.to);
    version.status = input.to;
    return this.versions.save(version);
  }

  async recordTest(
    userId: string,
    serviceId: string,
    versionId: string,
    input: { teamId: string; result: "passed" | "failed"; notes?: string },
  ) {
    const { human } = await this.access.requireHumanTeammate(userId, input.teamId);
    await this.assertServicePermission(human.id, human.roleId, serviceId, input.teamId, "service:test");
    const version = await this.requireVersion(serviceId, versionId, input.teamId);
    assertCanRecordTest(version.status);
    const report = await this.reports.save(
      this.reports.create({
        serviceVersionId: version.id,
        authorMemberId: human.id,
        result: input.result,
        notes: input.notes?.trim() ?? "",
      }),
    );
    version.status = input.result;
    if (input.result === "passed") {
      const service = await this.services.findOneOrFail({ where: { id: serviceId } });
      version.imageTag = imageTagFor(service.imageName, version.version);
      await this.applyTag(version, service);
    }
    await this.versions.save(version);
    return { report, version };
  }

  async retryTag(userId: string, serviceId: string, versionId: string, gitSha?: string) {
    const version = await this.versions.findOne({ where: { id: versionId, serviceId } });
    if (!version) throw new DomainError("服务版本不存在", 404);
    const { human } = await this.access.requireHumanTeammate(userId, version.teamId);
    await this.assertServicePermission(human.id, human.roleId, serviceId, version.teamId, "service:test");
    if (version.status !== "passed") throw new DomainError("只有测试通过的版本可以打 tag");
    if (gitSha) version.gitSha = gitSha.trim();
    const service = await this.services.findOneOrFail({ where: { id: serviceId } });
    version.imageTag = imageTagFor(service.imageName, version.version);
    await this.applyTag(version, service);
    return this.versions.save(version);
  }

  async listReleases(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "member");
    const releases = await this.releases.find({ where: { projectId }, order: { createdAt: "DESC" } });
    const items = releases.length
      ? await this.releaseItems.find({ where: { releaseId: In(releases.map((release) => release.id)) } })
      : [];
    return releases.map((release) => ({
      ...release,
      items: items.filter((item) => item.releaseId === release.id),
    }));
  }

  async createRelease(
    userId: string,
    projectId: string,
    input: { teamId: string; version: string; items: { serviceId: string; serviceVersionId: string }[] },
  ) {
    const { team, human } = await this.access.requireHumanTeammate(userId, input.teamId);
    if (team.projectId !== projectId) throw new DomainError("Team 不属于该项目", 400);
    await this.assertPermission(human.roleId, "system:release");
    await this.assertReleaseShape(projectId, input.teamId, input.items);
    const release = await this.releases.save(
      this.releases.create({
        projectId,
        teamId: input.teamId,
        version: input.version,
        status: "draft",
        createdByMemberId: human.id,
      }),
    );
    await this.releaseItems.save(
      input.items.map((item) =>
        this.releaseItems.create({
          releaseId: release.id,
          serviceId: item.serviceId,
          serviceVersionId: item.serviceVersionId,
        }),
      ),
    );
    return { ...release, items: input.items };
  }

  async replaceItems(userId: string, releaseId: string, items: { serviceId: string; serviceVersionId: string }[]) {
    const release = await this.requireRelease(releaseId);
    if (release.status !== "draft") throw new DomainError("已发布的系统版本不能修改", 400);
    const { human } = await this.access.requireHumanTeammate(userId, release.teamId);
    await this.assertPermission(human.roleId, "system:release");
    await this.assertReleaseShape(release.projectId, release.teamId, items);
    await this.releaseItems.delete({ releaseId });
    await this.releaseItems.save(
      items.map((item) => this.releaseItems.create({ releaseId, serviceId: item.serviceId, serviceVersionId: item.serviceVersionId })),
    );
    return this.listOne(releaseId);
  }

  async publish(userId: string, releaseId: string) {
    const release = await this.requireRelease(releaseId);
    if (release.status === "published") throw new DomainError("系统版本已发布", 400);
    const { human } = await this.access.requireHumanTeammate(userId, release.teamId);
    await this.assertPermission(human.roleId, "system:release");
    const items = await this.releaseItems.find({ where: { releaseId } });
    await this.assertReleaseShape(
      release.projectId,
      release.teamId,
      items.map((item) => ({ serviceId: item.serviceId, serviceVersionId: item.serviceVersionId })),
    );
    release.status = "published";
    release.publishedAt = new Date();
    await this.releases.save(release);
    return this.listOne(releaseId);
  }

  private async listOne(releaseId: string) {
    const release = await this.requireRelease(releaseId);
    const items = await this.releaseItems.find({ where: { releaseId } });
    return { ...release, items };
  }

  private async assertReleaseShape(
    projectId: string,
    teamId: string,
    items: { serviceId: string; serviceVersionId: string }[],
  ) {
    const services = await this.services.find({ where: { projectId } });
    const versions = items.length
      ? await this.versions.find({ where: { id: In(items.map((item) => item.serviceVersionId)) } })
      : [];
    const workspaces = await this.workspaces.find({ where: { teamId } });
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.serviceId));
    const resolved = items.map((item) => {
      const version = versions.find((candidate) => candidate.id === item.serviceVersionId);
      if (!version || version.serviceId !== item.serviceId) throw new DomainError("服务版本与服务不匹配");
      if (!workspaceIds.has(item.serviceId)) throw new DomainError("服务不在 Team 工作区中");
      return { serviceId: item.serviceId, status: version.status };
    });
    assertReleaseItems(resolved, new Set(services.map((service) => service.id)));
  }

  private async applyTag(version: ServiceVersionEntity, service: ServiceEntity) {
    if (!version.gitSha) {
      version.tagStatus = "skipped";
      version.tagError = "未提供 git sha，未打 tag";
      version.tagName = tagNameForVersion(version.version);
      return;
    }
    const token = await this.git.tokenFor(service.id);
    if (!token) {
      version.tagStatus = "skipped";
      version.tagError = "未配置 Git 访问令牌，未打 tag";
      version.tagName = tagNameForVersion(version.version);
      return;
    }
    try {
      const tag = tagNameForVersion(version.version);
      await this.git.createTag(service.id, service.repoUrl, tag, version.gitSha);
      version.tagName = tag;
      version.tagStatus = "tagged";
      version.tagError = null;
    } catch (error) {
      version.tagName = tagNameForVersion(version.version);
      version.tagStatus = "failed";
      version.tagError = error instanceof Error ? error.message : "打 tag 失败";
    }
  }

  private async assertServicePermission(memberId: string, roleId: string, serviceId: string, teamId: string, permission: string) {
    await this.assertPermission(roleId, permission);
    const workspace = await this.workspaces.findOne({ where: { teamId, serviceId } });
    if (!workspace) throw new DomainError("服务不在 Team 工作区中");
    await this.assertAssigned(memberId, serviceId);
  }

  private async assertPermission(roleId: string, permission: string) {
    const role = await this.roles.findOne({ where: { id: roleId } });
    if (!role?.permissions.includes(permission)) throw new DomainError("当前角色没有该权限", 403);
  }

  private async assertAssigned(memberId: string, serviceId: string) {
    const link = await this.memberServices.findOne({ where: { memberId, serviceId } });
    if (!link) throw new DomainError("没有分配该服务", 403);
  }

  private async requireVersion(serviceId: string, versionId: string, teamId: string) {
    const version = await this.versions.findOne({ where: { id: versionId, serviceId, teamId } });
    if (!version) throw new DomainError("服务版本不存在", 404);
    return version;
  }

  private async requireRelease(releaseId: string) {
    const release = await this.releases.findOne({ where: { id: releaseId } });
    if (!release) throw new DomainError("系统版本不存在", 404);
    return release;
  }
}
