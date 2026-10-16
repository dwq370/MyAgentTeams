import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { decryptSecret } from "../common/crypto";
import { DomainError } from "../domain/errors";
import { canonicalRepoUrl, invalidGroupMessage, parseGitGroup, parseGitRepo, RemoteRepo } from "../domain/policy";
import { ServiceEntity } from "../entities";
import { GitHubClient } from "./github";
import { GitLabClient } from "./gitlab";

@Injectable()
export class GitRepoClient {
  constructor(
    private readonly config: ConfigService,
    private readonly github: GitHubClient,
    private readonly gitlab: GitLabClient,
    @InjectRepository(ServiceEntity) private readonly services: Repository<ServiceEntity>,
  ) {}

  async inspectRepo(repoUrl: string, token: string): Promise<RemoteRepo> {
    const repo = this.parse(repoUrl);
    if (repo.host === "github") {
      const meta = await this.github.repoMeta(token, repoUrl);
      return {
        name: meta.name,
        path: meta.path,
        repoUrl: canonicalRepoUrl(repoUrl) ?? repoUrl,
        defaultBranch: meta.defaultBranch,
      };
    }
    const meta = await this.gitlab.projectMeta(repo, token);
    return {
      name: meta.name,
      path: meta.path,
      repoUrl: canonicalRepoUrl(repoUrl) ?? repoUrl,
      defaultBranch: meta.defaultBranch,
    };
  }

  async listGroup(url: string, token: string): Promise<{ name: string; repos: RemoteRepo[] }> {
    const group = parseGitGroup(url);
    if (!group) throw new DomainError(invalidGroupMessage(url));
    if (group.host === "github") return this.github.listOrgRepos(group.path, token);
    return this.gitlab.listGroupProjects(group.origin, group.path, token);
  }

  async verifyToken(repoUrl: string, token: string) {
    const repo = this.parse(repoUrl);
    if (repo.host === "github") await this.github.verifyRepo(token, repoUrl);
    else await this.gitlab.verifyRepo(repo, token);
  }

  async tokenFor(serviceId: string) {
    const service = await this.services
      .createQueryBuilder("service")
      .addSelect("service.gitTokenEncrypted")
      .where("service.id = :serviceId", { serviceId })
      .getOne();
    if (!service?.gitTokenEncrypted) return null;
    return decryptSecret(service.gitTokenEncrypted, this.config.getOrThrow<string>("APP_ENCRYPTION_KEY"));
  }

  async ensureBranch(serviceId: string, repoUrl: string, baseline: string, branch: string) {
    const token = await this.requireToken(serviceId);
    const repo = this.parse(repoUrl);
    if (repo.host === "github") return this.github.ensureBranch(token, repoUrl, baseline, branch);
    return this.gitlab.ensureBranch(repo, token, baseline, branch);
  }

  async deleteBranch(serviceId: string, repoUrl: string, branch: string) {
    const token = await this.tokenFor(serviceId);
    if (!token) return;
    const repo = this.parse(repoUrl);
    if (repo.host === "github") await this.github.deleteBranch(token, repoUrl, branch);
    else await this.gitlab.deleteBranch(repo, token, branch);
  }

  async createTag(serviceId: string, repoUrl: string, tag: string, sha: string) {
    const token = await this.requireToken(serviceId, "未配置 Git 访问令牌，未打 tag");
    const repo = this.parse(repoUrl);
    if (repo.host === "github") await this.github.createTag(token, repoUrl, tag, sha);
    else await this.gitlab.createTag(repo, token, tag, sha);
  }

  async syncBranch(serviceId: string, repoUrl: string, branch: string, baseline: string) {
    const token = await this.requireToken(serviceId);
    const repo = this.parse(repoUrl);
    if (repo.host === "github") return this.github.syncBranch(token, repoUrl, branch, baseline);
    return this.gitlab.syncBranch(repo, token, branch, baseline);
  }

  private async requireToken(serviceId: string, message = "未配置 Git 访问令牌，无法 fork 工作区") {
    const token = await this.tokenFor(serviceId);
    if (!token) throw new DomainError(message);
    return token;
  }

  private parse(repoUrl: string) {
    const repo = parseGitRepo(repoUrl);
    if (!repo) throw new DomainError("仓库地址需要是 GitHub 或 GitLab 仓库");
    return repo;
  }
}
