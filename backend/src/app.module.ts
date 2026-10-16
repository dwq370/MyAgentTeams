import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { AgentEnginesController } from "./agent-engines/agent-engines.controller";
import { AgentEnginesModule } from "./agent-engines/agent-engines.module";
import { AgentsController } from "./agents/agents.controller";
import { AgentsService } from "./agents/agents.service";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./common/jwt-auth.guard";
import { DatabaseModule } from "./database.module";
import { HealthController } from "./health.controller";
import { PlatformModule } from "./platform/platform.module";
import { ProjectsModule } from "./projects/projects.module";
import { RolesController } from "./roles/roles.controller";
import { RolesModule } from "./roles/roles.module";
import { TeamsModule } from "./teams/teams.module";
import { VersionsModule } from "./versions/versions.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    PlatformModule,
    AgentEnginesModule,
    AuthModule,
    ProjectsModule,
    RolesModule,
    TeamsModule,
    VersionsModule,
  ],
  controllers: [HealthController, AgentsController, AgentEnginesController, RolesController],
  providers: [AgentsService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
