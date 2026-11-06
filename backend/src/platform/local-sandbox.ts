import { randomBytes } from "crypto";
import { request as httpRequest } from "http";
import { Injectable } from "@nestjs/common";
import { DomainError } from "../domain/errors";

const IMAGE = "alpine:3.20";
const NAME_PATTERN = /^agentteam-sandbox-[a-f0-9]{8}$/;

export interface SandboxInfo {
  kind: "sandbox";
  runtime: "local";
  containerName: string;
  containerId: string;
  image: string;
  status: string;
}

interface ContainerView {
  id: string;
  name: string;
  image: string;
  status: string;
  projectId: string | null;
}

@Injectable()
export class LocalSandbox {
  async ensure(projectId: string, containerName?: string): Promise<SandboxInfo> {
    const name = containerName?.trim() || this.freshName();
    this.assertName(name);
    const existing = await this.inspect(name);
    if (existing) {
      this.assertOwner(existing, projectId);
      if (existing.status !== "running") await this.start(name);
      const started = await this.inspect(name);
      if (!started || started.status !== "running") throw new DomainError("本地 sandbox 没有启动");
      return this.toInfo(started);
    }
    await this.ensureImage();
    await this.create(name, projectId);
    try {
      await this.start(name);
      const created = await this.inspect(name);
      if (!created || created.status !== "running") throw new DomainError("本地 sandbox 创建后没有运行");
      return this.toInfo(created);
    } catch (error) {
      await this.remove(name).catch(() => undefined);
      throw error;
    }
  }

  async remove(containerName: string | null | undefined) {
    const name = containerName?.trim();
    if (!name) return;
    this.assertName(name);
    const response = await this.request("DELETE", `/containers/${name}?force=1`);
    if (response.status === 404 || response.status === 204 || response.status < 300) return;
    this.fail(response.body, "删除本地 sandbox 失败");
  }

  async removeIfOwned(projectId: string, containerName: string) {
    this.assertName(containerName);
    const existing = await this.inspect(containerName);
    if (!existing) return;
    this.assertOwner(existing, projectId);
    await this.remove(containerName);
  }

  private freshName() {
    return `agentteam-sandbox-${randomBytes(4).toString("hex")}`;
  }

  private assertName(name: string) {
    if (!NAME_PATTERN.test(name)) throw new DomainError("sandbox 名称无效");
  }

  private assertOwner(container: ContainerView, projectId: string) {
    if (container.projectId && container.projectId !== projectId) throw new DomainError("这个 sandbox 属于其他项目");
  }

  private toInfo(container: ContainerView): SandboxInfo {
    return {
      kind: "sandbox",
      runtime: "local",
      containerName: container.name,
      containerId: container.id,
      image: container.image,
      status: container.status,
    };
  }

  private async ensureImage() {
    const existing = await this.request("GET", `/images/${encodeURIComponent(IMAGE)}/json`);
    if (existing.status === 200) return;
    if (existing.status !== 404) this.fail(existing.body, "无法读取 sandbox 镜像");
    const auth = Buffer.from("{}").toString("base64");
    const pulled = await this.request("POST", "/images/create?fromImage=alpine&tag=3.20", undefined, 180000, {
      "X-Registry-Auth": auth,
    });
    if (pulled.status >= 300) this.fail(pulled.body, "拉取 sandbox 镜像失败");
    for (const line of pulled.body.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) throw new DomainError(`拉取 sandbox 镜像失败：${parsed.error.slice(0, 240)}`);
      } catch (error) {
        if (error instanceof DomainError) throw error;
      }
    }
  }

  private async create(name: string, projectId: string) {
    const response = await this.request("POST", `/containers/create?name=${name}`, {
      Image: IMAGE,
      Cmd: ["sleep", "infinity"],
      Labels: {
        "agentteam.sandbox": "1",
        "agentteam.project": projectId,
      },
      HostConfig: {
        Memory: 256 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        Privileged: false,
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    if (response.status === 409) return;
    if (response.status >= 300) this.fail(response.body, "创建本地 sandbox 失败");
  }

  private async start(name: string) {
    const response = await this.request("POST", `/containers/${name}/start`);
    if (response.status === 304 || response.status < 300) return;
    this.fail(response.body, "启动本地 sandbox 失败");
  }

  private async inspect(name: string): Promise<ContainerView | null> {
    const response = await this.request("GET", `/containers/${name}/json`);
    if (response.status === 404) return null;
    if (response.status >= 300) this.fail(response.body, "读取本地 sandbox 失败");
    let parsed: {
      Id?: string;
      Name?: string;
      State?: { Status?: string };
      Config?: { Image?: string; Labels?: Record<string, string> };
    };
    try {
      parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
      throw new DomainError("本地 Docker 返回了无法读取的 sandbox 信息");
    }
    const containerName = (parsed.Name || name).replace(/^\//, "");
    this.assertName(containerName);
    return {
      id: parsed.Id || "",
      name: containerName,
      image: parsed.Config?.Image || IMAGE,
      status: parsed.State?.Status || "unknown",
      projectId: parsed.Config?.Labels?.["agentteam.project"] ?? null,
    };
  }

  private request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 20000,
    headers?: Record<string, string>,
  ) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
          path,
          method,
          timeout: timeoutMs,
          headers: {
            ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new DomainError("本地 Docker 响应超时"));
      });
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EACCES") {
          reject(new DomainError("未找到本地 Docker，请确认本机 Docker 正在运行"));
          return;
        }
        reject(new DomainError(`本地 Docker 不可用：${error.message}`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  private fail(body: string, fallback: string): never {
    let message = body.trim();
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // Docker sometimes returns plain text.
    }
    throw new DomainError((message || fallback).slice(0, 300));
  }
}

export function sandboxContainerName(info: Record<string, unknown> | null | undefined) {
  if (!info || info.kind !== "sandbox" || typeof info.containerName !== "string") return null;
  return info.containerName;
}
