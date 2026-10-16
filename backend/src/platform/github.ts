import { Injectable } from "@nestjs/common";
import { DomainError } from "../domain/errors";
import { parseGitHubRepo, RemoteRepo } from "../domain/policy";

interface GitHubRepo {
  owner: string;
  repo: string;
}

@Injectable()
export class GitHubClient {
  async verifyToken(token: string): Promise<void> {
    const response = await this.request(token, "/user");
    if (!response.ok) {
      throw new DomainError("Git 访问令牌无效", 400);
    }
  }

  async verifyRepo(token: string, repoUrl: string): Promise<void> {
    await this.repoMeta(token, repoUrl);
  }

  async repoMeta(token: string, repoUrl: string): Promise<{ name: string; path: string; defaultBranch: string }> {
    const repo = this.repo(repoUrl);
    const response = await this.request(token, `/repos/${repo.owner}/${repo.repo}`);
    if (response.status === 401 || response.status === 403) throw new DomainError("Git 访问令牌无效或无权访问该仓库", 400);
    if (!response.ok) throw new DomainError("Git 访问令牌无法访问该仓库", 400);
    const body = (await response.json()) as { name?: string; default_branch?: string | null };
    return { name: body.name || repo.repo, path: repo.repo, defaultBranch: body.default_branch || "main" };
  }

  async listOrgRepos(org: string, token: string): Promise<{ name: string; repos: RemoteRepo[] }> {
    const orgResponse = await this.request(token, `/orgs/${encodeURIComponent(org)}`);
    if (orgResponse.status === 401) throw new DomainError("Git 访问令牌无效", 400);
    let name = org;
    let listPath = `/orgs/${encodeURIComponent(org)}/repos`;
    let type = "all";
    if (orgResponse.status === 404) {
      const userResponse = await this.request(token, `/users/${encodeURIComponent(org)}`);
      if (userResponse.status === 401) throw new DomainError("Git 访问令牌无效", 400);
      if (!userResponse.ok) throw new DomainError("找不到这个 GitHub 组织或用户，或令牌无权访问", 400);
      const user = (await userResponse.json()) as { login?: string; name?: string | null };
      name = user.name || user.login || org;
      listPath = `/users/${encodeURIComponent(org)}/repos`;
      type = "owner";
    } else if (!orgResponse.ok) {
      throw new DomainError(await this.errorText(orgResponse, "读取 GitHub 组织失败"));
    } else {
      const body = (await orgResponse.json()) as { login?: string; name?: string | null };
      name = body.name || body.login || org;
    }
    const repos: RemoteRepo[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const response = await this.request(token, `${listPath}?per_page=100&page=${page}&type=${type}&sort=full_name`);
      if (response.status === 401 || response.status === 403) throw new DomainError("Git 访问令牌无权列出仓库", 400);
      if (!response.ok) throw new DomainError(await this.errorText(response, "读取仓库列表失败"));
      const rows = (await response.json()) as Array<{
        name?: string;
        full_name?: string;
        default_branch?: string | null;
        archived?: boolean;
      }>;
      if (!Array.isArray(rows)) throw new DomainError("代码仓返回的仓库列表无法识别");
      for (const row of rows) {
        if (!row.full_name || row.archived) continue;
        const path = row.full_name.split("/").pop() || row.name || "repo";
        repos.push({
          name: row.name || path,
          path,
          repoUrl: `https://github.com/${row.full_name}.git`,
          defaultBranch: row.default_branch || "main",
        });
      }
      if (rows.length < 100) break;
    }
    return { name, repos };
  }

  async ensureBranch(token: string, repoUrl: string, baseline: string, branch: string) {
    const repo = this.repo(repoUrl);
    const baseSha = await this.resolveRef(token, repo, baseline);
    const existing = await this.readRef(token, repo, `heads/${branch}`);
    if (existing) return { sha: existing, created: false };
    await this.createRef(token, repo, `refs/heads/${branch}`, baseSha);
    return { sha: baseSha, created: true };
  }

  async deleteBranch(token: string, repoUrl: string, branch: string) {
    const repo = this.repo(repoUrl);
    const response = await this.request(token, `/repos/${repo.owner}/${repo.repo}/git/refs/heads/${this.refPath(branch)}`, {
      method: "DELETE",
    });
    if (response.status === 204 || response.status === 404 || response.status === 422) return;
    throw new DomainError(await this.errorText(response, "删除分支失败"));
  }

  async createTag(token: string, repoUrl: string, tag: string, sha: string) {
    const repo = this.repo(repoUrl);
    const existing = await this.readRef(token, repo, `tags/${tag}`);
    if (existing) {
      if (existing !== sha) throw new DomainError(`标签 ${tag} 已存在且指向其他提交`);
      return;
    }
    await this.createRef(token, repo, `refs/tags/${tag}`, sha);
  }

  async syncBranch(token: string, repoUrl: string, branch: string, baseline: string) {
    const repo = this.repo(repoUrl);
    const response = await this.request(token, `/repos/${repo.owner}/${repo.repo}/merges`, {
      method: "POST",
      body: JSON.stringify({
        base: branch,
        head: baseline,
        commit_message: "Sync team baseline into agent workspace",
      }),
    });
    if (response.status === 201) return "merged" as const;
    if (response.status === 204) return "up_to_date" as const;
    if (response.status === 409) return "conflict" as const;
    throw new DomainError(await this.errorText(response, "同步上游失败"));
  }

  private repo(repoUrl: string): GitHubRepo {
    const parsed = parseGitHubRepo(repoUrl);
    if (!parsed) throw new DomainError("不是 GitHub 仓库");
    return parsed;
  }

  private async resolveRef(token: string, repo: GitHubRepo, ref: string) {
    const head = await this.readRef(token, repo, `heads/${ref}`);
    if (head) return head;
    const tag = await this.readRef(token, repo, `tags/${ref}`);
    if (tag) return tag;
    throw new DomainError(`找不到基线 ${ref}`);
  }

  private async readRef(token: string, repo: GitHubRepo, ref: string) {
    const response = await this.request(token, `/repos/${repo.owner}/${repo.repo}/git/ref/${this.refPath(ref)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new DomainError(await this.errorText(response, "读取 Git 引用失败"));
    const body = (await response.json()) as { object?: { sha?: string } };
    if (!body.object?.sha) throw new DomainError("Git 引用没有提交号");
    return body.object.sha;
  }

  private async createRef(token: string, repo: GitHubRepo, ref: string, sha: string) {
    const response = await this.request(token, `/repos/${repo.owner}/${repo.repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref, sha }),
    });
    if (response.status === 422) return;
    if (!response.ok) throw new DomainError(await this.errorText(response, "创建 Git 引用失败"));
  }

  private refPath(ref: string) {
    return ref.split("/").map(encodeURIComponent).join("/");
  }

  private async request(token: string, path: string, init: RequestInit = {}) {
    try {
      return await fetch(`https://api.github.com${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "agentteam",
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
