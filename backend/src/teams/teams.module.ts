import { Module } from "@nestjs/common";
import { AgentEnginesModule } from "../agent-engines/agent-engines.module";
import { AuthModule } from "../auth/auth.module";
import { PlatformModule } from "../platform/platform.module";
import { TeamsController } from "./teams.controller";
import { TeamsService } from "./teams.service";

@Module({
  imports: [AuthModule, PlatformModule, AgentEnginesModule],
  controllers: [TeamsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
