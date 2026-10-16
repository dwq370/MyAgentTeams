import { createHash } from "crypto";
import { Injectable } from "@nestjs/common";
import { Client } from "ssh2";
import { DomainError } from "../domain/errors";

export interface SshProbeResult {
  kind: "standalone";
  host: string;
  port: number;
  username: string;
  fingerprint: string;
  output: string;
}

@Injectable()
export class SshProbe {
  probe(input: { host: string; port: number; username: string; password: string }): Promise<SshProbeResult> {
    const host = input.host.trim();
    const username = input.username.trim();
    if (!/^[A-Za-z0-9.:_-]{1,255}$/.test(host)) throw new DomainError("主机地址无效");
    if (!username) throw new DomainError("请填写登录账号");
    if (!input.password) throw new DomainError("请填写登录密码");
    const connectHost = host === "localhost" || host === "127.0.0.1" ? "host.docker.internal" : host;
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let fingerprint = "";
      let settled = false;
      const finish = (error?: Error, result?: SshProbeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.end();
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const timer = setTimeout(() => finish(new DomainError("SSH 连接超时")), 12000);
      conn.on("ready", () => {
        conn.exec("printf connected", (error, stream) => {
          if (error) {
            finish(undefined, { kind: "standalone", host, port: input.port, username, fingerprint, output: "已登录" });
            return;
          }
          let output = "";
          stream.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
          });
          stream.on("close", () => {
            finish(undefined, {
              kind: "standalone",
              host,
              port: input.port,
              username,
              fingerprint,
              output: output.trim() || "已登录",
            });
          });
        });
      });
      conn.on("error", (error) => finish(new DomainError(`SSH 连接失败：${error.message}`)));
      conn.connect({
        host: connectHost,
        port: input.port,
        username,
        password: input.password,
        readyTimeout: 10000,
        hostVerifier: (key: Buffer) => {
          fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64")}`;
          return true;
        },
      });
    });
  }
}
