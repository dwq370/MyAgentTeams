import { Body, Controller, Get, Param, Post, Res } from "@nestjs/common";
import { Response } from "express";
import { AuthUser, CurrentUser } from "../common/auth";
import { AgentsService } from "./agents.service";
import { CreateRunDto, PreviewRunDto } from "./dto";

@Controller()
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post("agents/:agentId/runs/preview")
  preview(@CurrentUser() user: AuthUser, @Param("agentId") agentId: string, @Body() body: PreviewRunDto) {
    return this.agents.preview(user.id, agentId, body);
  }

  @Post("agents/:agentId/runs")
  createRun(@CurrentUser() user: AuthUser, @Param("agentId") agentId: string, @Body() body: CreateRunDto) {
    return this.agents.createRun(user.id, agentId, body);
  }

  @Get("agents/:agentId/runs")
  listRuns(@CurrentUser() user: AuthUser, @Param("agentId") agentId: string) {
    return this.agents.listRuns(user.id, agentId);
  }

  @Post("agents/:agentId/runs/:runId/cancel")
  cancel(@CurrentUser() user: AuthUser, @Param("agentId") agentId: string, @Param("runId") runId: string) {
    return this.agents.cancel(user.id, agentId, runId);
  }

  @Get("agents/:agentId/runs/:runId/events")
  stream(
    @CurrentUser() user: AuthUser,
    @Param("agentId") agentId: string,
    @Param("runId") runId: string,
    @Res() res: Response,
  ) {
    return this.agents.stream(user.id, agentId, runId, res);
  }

  @Post("agents/:agentId/sync")
  sync(@CurrentUser() user: AuthUser, @Param("agentId") agentId: string) {
    return this.agents.sync(user.id, agentId);
  }
}
