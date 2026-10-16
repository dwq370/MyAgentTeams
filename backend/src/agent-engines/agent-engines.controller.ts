import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { AuthUser, CurrentUser } from "../common/auth";
import { AgentEnginesService } from "./agent-engines.service";
import { CreateAgentEngineDto, UpdateAgentEngineDto } from "./dto";

@Controller()
export class AgentEnginesController {
  constructor(private readonly engines: AgentEnginesService) {}

  @Get("agent-engines")
  list(@CurrentUser() user: AuthUser) {
    return this.engines.list(user.id);
  }

  @Post("agent-engines")
  create(@CurrentUser() user: AuthUser, @Body() body: CreateAgentEngineDto) {
    return this.engines.create(user.id, body);
  }

  @Patch("agent-engines/:engineId")
  update(@CurrentUser() user: AuthUser, @Param("engineId") engineId: string, @Body() body: UpdateAgentEngineDto) {
    return this.engines.update(user.id, engineId, body);
  }

  @Delete("agent-engines/:engineId")
  remove(@CurrentUser() user: AuthUser, @Param("engineId") engineId: string) {
    return this.engines.remove(user.id, engineId);
  }
}
