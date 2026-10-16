import { Injectable } from "@nestjs/common";
import { DomainError } from "../domain/errors";
import { canonicalRepoUrl, ParsedGitRepo, RemoteRepo } from "../domain/policy";

@Injectable()
export class GitLabClient {
  async verifyRepo(repo: ParsedGitRepo, token: string): Promise<void> {
    await this.projectMeta(repo, token);
  }

  async projectMeta(repo: ParsedGitRepo, token: string): Promise<{ name: string; path: string; defaultBranch: string }> {
    const user = await this.request(repo, token, "/user");
    if (user.status === 401) throw new DomainError("Git 访问令牌无效", 400);
    if (!user.ok) throw new DomainError(await this.errorText(user, "Git 访问令牌无效"));
    const project = await this.request(repo, token, `/projects/${this.projectId(repo)}`);
    if (project.status === 401) throw new DomainError("Git 访问令牌无效", 400);
    if (!project.ok) throw new DomainError("Git 访问令牌无法访问该仓库", 400);
    const body = (await project.json()) as { name?: string; path?: string; default_branch?: string | null };
    return {
      name: body.name || repo.repo,
      path: body.path || repo.repo,
      defaultBranch: body.default_branch || "main",
    };
  }

  async listGroupProjects(origin: string, groupPath: string, token: string): Promise<{ name: string; repos: RemoteRepo[] }> {
    const group = await this.api(origin, token, `/groups/${encodeURIComponent(groupPath)}`);
    if (group.status === 401) throw new DomainError("Git 访问令牌无效", 400);
    if (group.status === 404) throw new DomainError("找不到这个群组，或令牌无权访问", 400);
    if (!group.ok) throw new DomainError(await this.errorText(group, "读取群组失败"));
    const info = (await group.json()) as { name?: string; full_path?: string };
    const repos: RemoteRepo[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const response = await this.api(
        origin,
        token,
        `/groups/${encodeURIComponent(groupPath)}/projects?include_subgroups=true&simple=true&archived=false&per_page=100&page=${page}&order_by=path&sort=asc`,
      );
      if (response.status === 401 || response.status === 403) throw new DomainError("Git 访问令牌无权列出群组仓库", 400);
      if (!response.ok) throw new DomainError(await this.errorText(response, "读取群组仓库失败"));
        const rows = (await response.json()) as Array<{
        name?: string;
        path?: string;
        path_with_namespace?: string;
        http_url_to_repo?: string;
        default_branch?: string | null;
      }>;
      if (!Array.isArray(rows)) throw new DomainError("代码仓返回的仓库列表无法识别");
      for (const row of rows) {
        if (!row.path_with_namespace) continue;
        const path = row.path || row.path_with_namespace.split("/").pop() || "repo";
        repos.push({
          name: row.name || path,
          path,
          repoUrl: canonicalRepoUrl(row.http_url_to_repo ?? "") ?? `${origin}/${row.path_with_namespace}.git`,
          defaultBranch: row.default_branch || "main",
        });
      }
      if (!response.headers.get("x-next-page")) break;
    }
    return { name: info.name || info.full_path || groupPath.split("/").pop() || groupPath, repos };
  }

  async ensureBranch(repo: ParsedGitRepo, token: string, baseline: string, branch: string) {
    await this.resolveRef(repo, token, baseline);
    const existing = await this.readBranch(repo, token, branch);
    if (existing) return { sha: existing, created: false };
    const response = await this.request(repo, token, `/projects/${this.projectId(repo)}/repository/branches`, {
      method: "POST",
      body: JSON.stringify({ branch, ref: baseline }),
    });
    if (!response.ok) throw new DomainError(await this.errorText(response, "创建分支失败"));
    const body = (await response.json()) as { commit?: { id?: string } };
    if (!body.commit?.id) throw new DomainError("GitLab 没有返回分支提交号");
    return { sha: body.commit.id, created: true };
  }

  async deleteBranch(repo: ParsedGitRepo, token: string, branch: string) {
    const response = await this.request(
      repo,
      token,
      `/projects/${this.projectId(repo)}/repository/branches/${encodeURIComponent(branch)}`,
      { method: "DELETE" },
    );
    if (response.status === 204 || response.status === 404) return;
    throw new DomainError(await this.errorText(response, "删除分支失败"));
  }

  async createTag(repo: ParsedGitRepo, token: string, tag: string, sha: string) {
    const existing = await this.readTag(repo, token, tag);
    if (existing) {
      if (existing !== sha) throw new DomainError(`标签 ${tag} 已存在且指向其他提交`);
      return;
    }
    const response = await this.request(repo, token, `/projects/${this.projectId(repo)}/repository/tags`, {
      method: "POST",
      body: JSON.stringify({ tag_name: tag, ref: sha, message: tag }),
    });
    if (!response.ok) throw new DomainError(await this.errorText(response, "创建标签失败"));
  }

  async syncBranch(repo: ParsedGitRepo, token: string, branch: string, baseline: string) {
    const baselineSha = await this.readBranch(repo, token, baseline);
    if (!baselineSha) throw new DomainError("GitLab 同步上游时，基线需要是分支");
    const compare = await this.request(
      repo,
      token,
      `/projects/${this.projectId(repo)}/repository/compare?from=${encodeURIComponent(branch)}&to=${encodeURIComponent(baseline)}`,
    );
    if (!compare.ok) throw new DomainError(await this.errorText(compare, "比较分支失败"));
    const compared = (await compare.json()) as { commits?: unknown[] };
    if (!compared.commits?.length) return "up_to_date" as const;
    const iid = await this.openMergeRequest(repo, token, baseline, branch);
    const merge = await this.request(repo, token, `/projects/${this.projectId(repo)}/merge_requests/${iid}/merge`, {
      method: "PUT",
      body: JSON.stringify({ should_remove_source_branch: false }),
    });
    if (merge.ok) return "merged" as const;
    if (merge.status === 405 || merge.status === 406 || merge.status === 409 || merge.status === 422) return "conflict" as const;
    throw new DomainError(await this.errorText(merge, "同步上游失败"));
  }

  private async openMergeRequest(repo: ParsedGitRepo, token: string, source: string, target: string) {
    const created = await this.request(repo, token, `/projects/${this.projectId(repo)}/merge_requests`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: source,
        target_branch: target,
        title: "Sync team baseline into agent workspace",
      }),
    });
    if (created.ok) {
      const body = (await created.json()) as { iid?: number };
      if (!body.iid) throw new DomainError("GitLab 没有返回合并请求编号");
      return body.iid;
    }
    if (created.status !== 409) throw new DomainError(await this.errorText(created, "创建合并请求失败"));
    const listed = await this.request(
      repo,
      token,
      `/projects/${this.projectId(repo)}/merge_requests?state=opened&source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}`,
    );
    if (!listed.ok) throw new DomainError(await this.errorText(listed, "查找合并请求失败"));
    const rows = (await listed.json()) as { iid?: number }[];
    if (!rows[0]?.iid) throw new DomainError("找不到已存在的合并请求");
    return rows[0].iid;
  }

  private async resolveRef(repo: ParsedGitRepo, token: string, ref: string) {
    const response = await this.request(
      repo,
      token,
      `/projects/${this.projectId(repo)}/repository/commits/${encodeURIComponent(ref)}`,
    );
    if (response.status === 404) throw new DomainError(`找不到基线 ${ref}`);
    if (!response.ok) throw new DomainError(await this.errorText(response, "读取 Git 引用失败"));
    const body = (await response.json()) as { id?: string };
    if (!body.id) throw new DomainError("Git 引用没有提交号");
    return body.id;
  }

  private async readBranch(repo: ParsedGitRepo, token: string, branch: string) {
    const response = await this.request(
      repo,
      token,
      `/projects/${this.projectId(repo)}/repository/branches/${encodeURIComponent(branch)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new DomainError(await this.errorText(response, "读取分支失败"));
    const body = (await response.json()) as { commit?: { id?: string } };
    if (!body.commit?.id) throw new DomainError("分支没有提交号");
    return body.commit.id;
  }

  private async readTag(repo: ParsedGitRepo, token: string, tag: string) {
    const response = await this.request(
      repo,
      token,
      `/projects/${this.projectId(repo)}/repository/tags/${encodeURIComponent(tag)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new DomainError(await this.errorText(response, "读取标签失败"));
    const body = (await response.json()) as { commit?: { id?: string } };
    if (!body.commit?.id) throw new DomainError("标签没有提交号");
    return body.commit.id;
  }

  private projectId(repo: ParsedGitRepo) {
    return encodeURIComponent(repo.projectPath);
  }

  private async request(repo: ParsedGitRepo, token: string, path: string, init: RequestInit = {}) {
    return this.api(repo.origin, token, path, init);
  }

  private async api(origin: string, token: string, path: string, init: RequestInit = {}) {
    try {
      return await fetch(`${origin}/api/v4${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(20000),
        headers: {
          "PRIVATE-TOKEN": token,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new DomainError("连接代码仓超时", 400);
      throw new DomainError("无法连接代码仓", 400);
    }
  }

  private async errorText(response: Response, fallback: string) {
    const text = await response.text();
    return text ? `${fallback}：${text.slice(0, 400)}` : fallback;
  }
}
