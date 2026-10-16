import { Module } from "@nestjs/common";
import { AgentEnginesModule } from "../agent-engines/agent-engines.module";
import { AuthModule } from "../auth/auth.module";
import { PlatformModule } from "../platform/platform.module";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";

@Module({
  imports: [AuthModule, AgentEnginesModule, PlatformModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
