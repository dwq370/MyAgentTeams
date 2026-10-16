import { Controller, Get } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Public } from "./common/auth";
import { QueueService } from "./platform/queue.service";

@Controller("health")
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly queue: QueueService,
  ) {}

  @Public()
  @Get()
  async check() {
    await this.dataSource.query("SELECT 1");
    const redis = await this.queue.redis.ping();
    return { status: "ok", redis, process: process.env.PROCESS_ROLE ?? "api" };
  }
}
