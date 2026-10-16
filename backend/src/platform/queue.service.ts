import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { DomainError } from "../domain/errors";

export type AgentJob =
  | { kind: "create-agent"; agentId: string }
  | { kind: "send-run"; runId: string };

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly queue: Queue;
  readonly redis: Redis;

  constructor(config: ConfigService) {
    const url = config.getOrThrow<string>("REDIS_URL");
    this.queue = new Queue("agent-jobs", { connection: { url, maxRetriesPerRequest: null } });
    this.redis = new Redis(url, { maxRetriesPerRequest: null });
  }

  async enqueue(data: AgentJob, jobId: string) {
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "active") throw new DomainError("任务正在执行", 409);
      await existing.remove();
    }
    await this.queue.add(data.kind, data, {
      jobId,
      removeOnComplete: 200,
      removeOnFail: 200,
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.redis.quit();
  }
}
