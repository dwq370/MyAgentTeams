import { Module } from "@nestjs/common";
import { PlatformModule } from "../platform/platform.module";
import { AgentEnginesService } from "./agent-engines.service";

@Module({
  imports: [PlatformModule],
  providers: [AgentEnginesService],
  exports: [AgentEnginesService],
})
export class AgentEnginesModule {}
