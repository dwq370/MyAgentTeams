import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { Injectable } from "@nestjs/common";
import { DomainError } from "../domain/errors";

export interface KubernetesNode {
  name: string;
  status: string;
  roles: string;
}

export interface KubernetesProbe {
  kind: "kubernetes";
  client: "local";
  contexts: string[];
  currentContext: string | null;
  context: string;
  clusterName: string;
  server: string;
  kubernetesVersion: string;
  nodes: KubernetesNode[];
  nodesError: string | null;
}

@Injectable()
export class KubectlProbe {
  async inspect(requestedContext?: string): Promise<KubernetesProbe> {
    const contexts = await this.contexts();
    if (contexts.length === 0) throw new DomainError("本地 kubeconfig 里没有可用上下文");
    const currentContext = await this.currentContext();
    const context = (requestedContext || currentContext || "").trim();
    if (!context) throw new DomainError("请选择 kubectl 上下文", 400, { contexts });
    this.assertContext(context);
    if (!contexts.includes(context)) throw new DomainError("本地 kubectl 没有这个上下文", 400, { contexts });
    const identity = await this.identity(context);
    const kubernetesVersion = await this.serverVersion(context);
    const nodes = await this.nodes(context);
    return {
      kind: "kubernetes",
      client: "local",
      contexts,
      currentContext,
      context,
      clusterName: identity.name,
      server: identity.server,
      kubernetesVersion,
      nodes: nodes.nodes,
      nodesError: nodes.error,
    };
  }

  private async contexts() {
    const stdout = await this.exec(["config", "get-contexts", "-o", "name"]);
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  private async currentContext() {
    try {
      const stdout = await this.exec(["config", "current-context"]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async identity(context: string) {
    const stdout = await this.exec([
      "config",
      "view",
      "--context",
      context,
      "--minify",
      "-o",
      'jsonpath={.clusters[0].name}{"\\n"}{.clusters[0].cluster.server}',
    ]);
    const [name, server] = stdout.split(/\r?\n/).map((line) => line.trim());
    if (!name || !server) throw new DomainError("kubectl 没有返回集群名称或地址");
    return { name, server };
  }

  private async serverVersion(context: string) {
    const stdout = await this.exec(["--context", context, "version", "-o", "json"]);
    let parsed: { serverVersion?: { gitVersion?: string } };
    try {
      parsed = JSON.parse(stdout) as { serverVersion?: { gitVersion?: string } };
    } catch {
      throw new DomainError("kubectl 没有返回可读的集群版本");
    }
    const version = parsed.serverVersion?.gitVersion;
    if (!version) throw new DomainError("kubectl 没有连上集群，请确认当前上下文可以访问 API");
    return version;
  }

  private async nodes(context: string): Promise<{ nodes: KubernetesNode[]; error: string | null }> {
    try {
      const stdout = await this.exec(["--context", context, "get", "nodes", "-o", "json"]);
      const parsed = JSON.parse(stdout) as {
        items?: {
          metadata?: { name?: string; labels?: Record<string, string> };
          status?: { conditions?: { type?: string; status?: string }[] };
        }[];
      };
      const nodes = (parsed.items ?? []).slice(0, 20).map((item) => {
        const labels = item.metadata?.labels ?? {};
        const roles = Object.keys(labels)
          .filter((key) => key.startsWith("node-role.kubernetes.io/"))
          .map((key) => key.slice("node-role.kubernetes.io/".length));
        const ready = item.status?.conditions?.find((condition) => condition.type === "Ready");
        return {
          name: item.metadata?.name || "未命名节点",
          status: ready?.status === "True" ? "Ready" : "NotReady",
          roles: roles.join("、") || "worker",
        };
      });
      return { nodes, error: null };
    } catch (error) {
      return { nodes: [], error: error instanceof Error ? error.message : "无法读取节点" };
    }
  }

  private assertContext(context: string) {
    if (!/^[A-Za-z0-9@_.:+/-]{1,200}$/.test(context)) throw new DomainError("kubectl 上下文名称无效");
  }

  private exec(args: string[]) {
    const config = process.env.KUBECONFIG || `${homedir()}/.kube/config`;
    if (!existsSync(config)) throw new DomainError("未找到本地 kubeconfig，请先在本机配置 kubectl");
    const env: NodeJS.ProcessEnv = { ...process.env, KUBECONFIG: config };
    if (existsSync("/.dockerenv")) env.HOME = "/tmp";
    return new Promise<string>((resolve, reject) => {
      execFile("kubectl", args, { timeout: 15000, maxBuffer: 4_000_000, env }, (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new DomainError("未找到本地 kubectl，请先在运行服务的机器上安装"));
          return;
        }
        const detail = `${stderr || ""}`.trim() || error.message;
        reject(new DomainError(detail.slice(0, 500) || "kubectl 执行失败"));
      });
    });
  }
}
