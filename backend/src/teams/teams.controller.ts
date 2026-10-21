import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { AuthUser, CurrentUser } from "../common/auth";
import {
  AgentMemberDto,
  CreateSourceDto,
  CreateTeamDto,
  CreateWorkItemDto,
  HumanMemberDto,
  ReplaceWorkspacesDto,
  ReplaceMemberReposDto,
  UpdateContactsDto,
  UpdateMemberDto,
  UpdateTeamDto,
  UpdateWorkItemDto,
} from "./dto";
import { TeamsService } from "./teams.service";

@Controller()
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get("projects/:projectId/teams")
  list(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.teams.list(user.id, projectId);
  }

  @Post("projects/:projectId/teams")
  create(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string, @Body() body: CreateTeamDto) {
    return this.teams.create(user.id, projectId, body);
  }

  @Get("teams/:teamId/monitor")
  monitor(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    return this.teams.monitor(user.id, teamId);
  }

  @Get("teams/:teamId")
  get(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    return this.teams.get(user.id, teamId);
  }

  @Patch("teams/:teamId")
  update(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string, @Body() body: UpdateTeamDto) {
    return this.teams.update(user.id, teamId, body);
  }

  @Delete("teams/:teamId")
  remove(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    return this.teams.remove(user.id, teamId);
  }

  @Get("teams/:teamId/workspaces")
  workspaces(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    return this.teams.listWorkspaces(user.id, teamId);
  }

  @Get("teams/:teamId/catalog")
  catalog(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    return this.teams.catalog(user.id, teamId);
  }

  @Post("teams/:teamId/sources")
  createSource(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string, @Body() body: CreateSourceDto) {
    return this.teams.createSource(user.id, teamId, body);
  }

  @Delete("teams/:teamId/sources/:sourceId")
  removeSource(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Param("sourceId") sourceId: string,
  ) {
    return this.teams.removeSource(user.id, teamId, sourceId);
  }

  @Delete("teams/:teamId/workspaces/:serviceId")
  removeWorkspace(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Param("serviceId") serviceId: string,
  ) {
    return this.teams.removeWorkspace(user.id, teamId, serviceId);
  }

  @Patch("teams/:teamId/workspaces")
  updateBaselines(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Body() body: ReplaceWorkspacesDto,
  ) {
    return this.teams.updateBaselines(user.id, teamId, body.items);
  }

  @Put("teams/:teamId/workspaces")
  replaceWorkspaces(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Body() body: ReplaceWorkspacesDto,
  ) {
    return this.teams.replaceWorkspaces(user.id, teamId, body.items);
  }

  @Get("teams/:teamId/branches")
  branches(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Query("serviceId") serviceId?: string,
    @Query("sourceId") sourceId?: string,
    @Query("repoUrl") repoUrl?: string,
  ) {
    return this.teams.listRepoBranches(user.id, teamId, { serviceId, sourceId, repoUrl });
  }

  @Get("teams/:teamId/members")
  members(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    return this.teams.listMembers(user.id, teamId);
  }

  @Post("teams/:teamId/members/humans")
  addHuman(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string, @Body() body: HumanMemberDto) {
    return this.teams.addHuman(user.id, teamId, body);
  }

  @Post("teams/:teamId/members/agents")
  addAgent(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string, @Body() body: AgentMemberDto) {
    return this.teams.addAgent(user.id, teamId, body);
  }

  @Patch("teams/:teamId/members/:memberId")
  updateMember(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
    @Body() body: UpdateMemberDto,
  ) {
    return this.teams.updateMember(user.id, teamId, memberId, body);
  }

  @Put("teams/:teamId/members/:memberId/repos")
  replaceRepos(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
    @Body() body: ReplaceMemberReposDto,
  ) {
    return this.teams.replaceMemberRepos(user.id, teamId, memberId, body);
  }

  @Put("teams/:teamId/members/:memberId/contacts")
  updateContacts(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
    @Body() body: UpdateContactsDto,
  ) {
    return this.teams.updateContacts(user.id, teamId, memberId, body.memberIds);
  }

  @Delete("teams/:teamId/members/:memberId")
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
    @Param("memberId") memberId: string,
  ) {
    return this.teams.removeMember(user.id, teamId, memberId);
  }

  @Post("agents/:agentId/retry")
  retry(@CurrentUser() user: AuthUser, @Param("agentId") agentId: string) {
    return this.teams.retryAgent(user.id, agentId);
  }

  @Get("teams/:teamId/work-items")
  workItems(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    return this.teams.listWorkItems(user.id, teamId);
  }

  @Post("teams/:teamId/work-items")
  createWorkItem(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string, @Body() body: CreateWorkItemDto) {
    return this.teams.createWorkItem(user.id, teamId, body);
  }

  @Patch("work-items/:workItemId")
  updateWorkItem(
    @CurrentUser() user: AuthUser,
    @Param("workItemId") workItemId: string,
    @Body() body: UpdateWorkItemDto,
  ) {
    return this.teams.updateWorkItem(user.id, workItemId, body);
  }
}
