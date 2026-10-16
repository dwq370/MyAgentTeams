import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AgentEnginesModule } from "./agent-engines/agent-engines.module";
import { AgentJobRunner } from "./agents/agent.runner";
import { DatabaseModule } from "./database.module";
import { HealthController } from "./health.controller";
import { PlatformModule } from "./platform/platform.module";
import { RolesModule } from "./roles/roles.module";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, PlatformModule, AgentEnginesModule, RolesModule],
  controllers: [HealthController],
  providers: [AgentJobRunner],
})
export class WorkerAppModule {}
