import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DomainError } from "../domain/errors";
import { canonicalRepoUrl, parseGitRepo } from "../domain/policy";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "vendor", ".next", "coverage", "target", "__pycache__", ".venv", "venv"]);
const SOURCE_EXT = new Set(["py", "ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "go", "rs", "rb", "php", "cs", "sql", "yml", "yaml", "md", "json", "toml", "vue", "html", "css", "scss", "sh", "xml", "gradle", "kt", "swift", "mod"]);
const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "cargo.lock"]);

@Injectable()
export class LocalGit {
  constructor(private readonly config: ConfigService) {}

  root() {
    return this.config.get<string>("REPO_ROOT") || "/var/agentteam/repos";
  }

  async checkout(key: string, repoUrl: string, token: string, branch: string) {
    this.assertKey(key);
    this.assertBranch(branch);
    const localPath = this.resolveKey(key);
    const cleanUrl = canonicalRepoUrl(repoUrl) ?? repoUrl;
    const header = this.authHeader(cleanUrl, token);
    const gitDir = path.join(localPath, ".git");
    const exists = await fs.stat(gitDir).then(() => true).catch(() => false);
    if (exists) {
      const remote = (await this.git(["remote", "get-url", "origin"], { cwd: localPath })).stdout.trim();
      if ((canonicalRepoUrl(remote) ?? remote) !== cleanUrl) await fs.rm(localPath, { recursive: true, force: true });
    }
    const ready = await fs.stat(path.join(localPath, ".git")).then(() => true).catch(() => false);
    if (!ready) {
      await fs.rm(localPath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await this.git(["clone", "--branch", branch, "--single-branch", cleanUrl, localPath], { header });
    } else {
      await this.git(["fetch", "origin", branch], { cwd: localPath, header });
      await this.git(["checkout", "-B", branch, "FETCH_HEAD"], { cwd: localPath });
    }
    const current = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: localPath })).stdout.trim();
    if (current !== branch) throw new DomainError(`本地分支应为 ${branch}`);
    const sha = (await this.git(["rev-parse", "HEAD"], { cwd: localPath })).stdout.trim();
    return { localPath, sha };
  }

  async remove(localPath: string | null | undefined) {
    if (!localPath) return;
    const root = path.resolve(this.root());
    const target = path.resolve(localPath);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) return;
    await fs.rm(target, { recursive: true, force: true });
  }

  async readSource(localPath: string, name: string, repoUrl: string, branch: string) {
    const files: { relative: string; body: string }[] = [];
    const state = { chars: 0, truncated: false };
    await this.collectSource(localPath, "", files, state);
    const batches: string[] = [];
    let current: string[] = [];
    let size = 0;
    const flush = () => {
      if (!current.length) return;
      batches.push(current.join("\n\n"));
      current = [];
      size = 0;
    };
    for (const file of files) {
      const block = `## ${file.relative}\n${file.body}`;
      if (size > 0 && size + block.length > 48000) flush();
      current.push(block);
      size += block.length;
    }
    flush();
    return { name, repoUrl, branch, batches, truncated: state.truncated };
  }

  async summarize(localPath: string, name: string, repoUrl: string, branch: string) {
    const tree: string[] = [];
    await this.walk(localPath, "", tree, 0);
    const files = await this.keyFiles(localPath);
    const chunks = [`# ${name}`, repoUrl, `分支 ${branch}`, "", "目录", tree.join("\n") || "（空）", ""];
    let used = chunks.join("\n").length;
    for (const file of files) {
      if (used > 70000) break;
      const body = file.body.slice(0, 8000);
      const block = `\n## ${file.relative}\n${body}`;
      if (used + block.length > 70000) break;
      chunks.push(block);
      used += block.length;
    }
    return chunks.join("\n");
  }

  private async collectSource(dir: string, relative: string, files: { relative: string; body: string }[], state: { chars: number; truncated: boolean }) {
    if (files.length >= 800 || state.chars >= 1_200_000) {
      state.truncated = true;
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= 800 || state.chars >= 1_200_000) {
        state.truncated = true;
        return;
      }
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (next.endsWith("migrations/versions") || next.endsWith("alembic/versions")) continue;
        await this.collectSource(path.join(dir, entry.name), next, files, state);
        continue;
      }
      if (!this.isSource(entry.name)) continue;
      const body = await fs.readFile(path.join(dir, next), "utf8").catch(() => "");
      if (!body || body.includes("\u0000")) continue;
      const clipped = body.length > 12000 ? `${body.slice(0, 12000)}\n…文件已截断` : body;
      files.push({ relative: next, body: clipped });
      state.chars += clipped.length;
    }
  }

  private isSource(name: string) {
    const lower = name.toLowerCase();
    if (SKIP_FILES.has(lower) || lower.endsWith(".lock")) return false;
    if (["dockerfile", "makefile", "jenkinsfile", "procfile"].includes(lower)) return true;
    const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
    return SOURCE_EXT.has(ext);
  }

  private async walk(dir: string, relative: string, lines: string[], depth: number) {
    if (lines.length >= 250 || depth > 3) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (lines.length >= 250) return;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      lines.push(`${entry.isDirectory() ? "dir" : "file"} ${next}`);
      if (entry.isDirectory()) await this.walk(path.join(dir, entry.name), next, lines, depth + 1);
    }
  }

  private async keyFiles(root: string) {
    const found: { relative: string; body: string }[] = [];
    const queue = [""];
    while (queue.length && found.length < 12) {
      const relative = queue.shift() ?? "";
      const dir = path.join(root, relative);
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (found.length >= 12) break;
        if (SKIP_DIRS.has(entry.name) || entry.name === ".git") continue;
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (next.split("/").length <= 3) queue.push(next);
          continue;
        }
        if (!this.interesting(entry.name, next)) continue;
        const body = await fs.readFile(path.join(root, next), "utf8").catch(() => "");
        if (body) found.push({ relative: next, body });
      }
    }
    return found;
  }

  private interesting(name: string, relative: string) {
    const lower = name.toLowerCase();
    if (lower.startsWith("readme")) return true;
    if (["package.json", "go.mod", "pom.xml", "pyproject.toml", "cargo.toml", "composer.json", "dockerfile"].includes(lower)) return true;
    if (relative.startsWith("docs/") && lower.endsWith(".md")) return true;
    return false;
  }

  private assertKey(key: string) {
    if (!/^(workspaces\/[0-9a-f-]{36}|projects\/[0-9a-f-]{36}\/[0-9a-f-]{36})$/.test(key)) {
      throw new DomainError("本地目录无效");
    }
  }

  private assertBranch(branch: string) {
    if (!branch || branch.length > 200 || branch.startsWith("-") || branch.includes("..") || /[\s\0~^:?*\[\\]/.test(branch)) {
      throw new DomainError("分支名无效");
    }
  }

  private resolveKey(key: string) {
    const root = path.resolve(this.root());
    const target = path.resolve(root, key);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new DomainError("本地目录无效");
    return target;
  }

  private authHeader(repoUrl: string, token: string) {
    const repo = parseGitRepo(repoUrl);
    const user = repo?.host === "github" ? "x-access-token" : "oauth2";
    return `AUTHORIZATION: Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
  }

  private git(args: string[], options: { cwd?: string; header?: string }) {
    const prefix = options.header ? ["-c", `http.extraHeader=${options.header}`] : [];
    return new Promise<{ stdout: string }>((resolve, reject) => {
      const child = spawn("git", [...prefix, ...args], {
        cwd: options.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new DomainError("git 执行超时"));
      }, 180000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new DomainError(error.message.includes("ENOENT") ? "服务器未安装 git" : "git 执行失败"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout });
        else reject(new DomainError(this.publicGitError(stderr || stdout)));
      });
    });
  }

  private publicGitError(text: string) {
    const cleaned = text.replace(/AUTHORIZATION:\s*Basic\s+\S+/gi, "AUTHORIZATION: Basic ***").trim();
    const line = cleaned.split("\n").map((item) => item.trim()).filter(Boolean).slice(-3).join(" ");
    return line.slice(0, 500) || "git 执行失败";
  }
}
