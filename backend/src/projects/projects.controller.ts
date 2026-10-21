import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from "@nestjs/common";
import { AuthUser, CurrentUser, Public } from "../common/auth";
import {
  AddProjectMemberDto,
  BindAgentEngineDto,
  CreateProjectDto,
  CreateRoleDto,
  CreateTestEnvironmentDto,
  ProbeTestEnvironmentDto,
  GenerateArchitectureDto,
  UpdateProjectDto,
  UpdateProjectMemberDto,
  UpdateRoleDto,
  UpdateTestEnvironmentDto,
} from "./dto";
import { ProjectsService } from "./projects.service";

@Controller()
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get("permissions")
  @Public()
  permissions() {
    return this.projects.permissionCatalog();
  }

  @Post("projects")
  create(@CurrentUser() user: AuthUser, @Body() body: CreateProjectDto) {
    return this.projects.create(user.id, body);
  }

  @Get("projects")
  list(@CurrentUser() user: AuthUser) {
    return this.projects.list(user.id);
  }

  @Get("projects/:projectId")
  get(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.projects.get(user.id, projectId);
  }

  @Patch("projects/:projectId")
  update(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string, @Body() body: UpdateProjectDto) {
    return this.projects.update(user.id, projectId, body);
  }

  @Get("projects/:projectId/architects")
  architects(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.projects.listArchitects(user.id, projectId);
  }

  @Post("projects/:projectId/architecture")
  generateArchitecture(
    @CurrentUser() user: AuthUser,
    @Param("projectId") projectId: string,
    @Body() body: GenerateArchitectureDto,
  ) {
    return this.projects.generateArchitecture(user.id, projectId, body);
  }

  @Delete("projects/:projectId")
  remove(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.projects.remove(user.id, projectId);
  }

  @Get("projects/:projectId/members")
  listMembers(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.projects.listMembers(user.id, projectId);
  }

  @Post("projects/:projectId/members")
  addMember(
    @CurrentUser() user: AuthUser,
    @Param("projectId") projectId: string,
    @Body() body: AddProjectMemberDto,
  ) {
    return this.projects.addMember(user.id, projectId, body);
  }

  @Patch("projects/:projectId/members/:memberUserId")
  updateMember(
    @CurrentUser() user: AuthUser,
    @Param("projectId") projectId: string,
    @Param("memberUserId") memberUserId: string,
    @Body() body: UpdateProjectMemberDto,
  ) {
    return this.projects.updateMember(user.id, projectId, memberUserId, body.projectRole);
  }

  @Delete("projects/:projectId/members/:memberUserId")
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param("projectId") projectId: string,
    @Param("memberUserId") memberUserId: string,
  ) {
    return this.projects.removeMember(user.id, projectId, memberUserId);
  }

  @Put("projects/:projectId/agent-engine")
  bindEngine(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string, @Body() body: BindAgentEngineDto) {
    return this.projects.bindEngine(user.id, projectId, body.agentEngineId ?? null);
  }

  @Get("projects/:projectId/services")
  listServices(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.projects.listServices(user.id, projectId);
  }

  @Get("projects/:projectId/environments")
  listEnvironments(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.projects.listEnvironments(user.id, projectId);
  }

  @Post("projects/:projectId/environments/probe")
  probeEnvironment(
    @CurrentUser() user: AuthUser,
    @Param("projectId") projectId: string,
    @Body() body: ProbeTestEnvironmentDto,
  ) {
    return this.projects.probeEnvironment(user.id, projectId, body);
  }

  @Post("projects/:projectId/environments")
  createEnvironment(
    @CurrentUser() user: AuthUser,
    @Param("projectId") projectId: string,
    @Body() body: CreateTestEnvironmentDto,
  ) {
    return this.projects.createEnvironment(user.id, projectId, body);
  }

  @Patch("projects/:projectId/environments/:environmentId")
  updateEnvironment(
    @CurrentUser() user: AuthUser,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
    @Body() body: UpdateTestEnvironmentDto,
  ) {
    return this.projects.updateEnvironment(user.id, projectId, environmentId, body);
  }

  @Delete("projects/:projectId/environments/:environmentId")
  removeEnvironment(
    @CurrentUser() user: AuthUser,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
  ) {
    return this.projects.removeEnvironment(user.id, projectId, environmentId);
  }

  @Get("projects/:projectId/roles")
  listRoles(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.projects.listRoles(user.id, projectId);
  }

  @Post("projects/:projectId/roles")
  createRole(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string, @Body() body: CreateRoleDto) {
    return this.projects.createRole(user.id, projectId, body);
  }

  @Patch("projects/:projectId/roles/:roleId")
  updateRole(
    @CurrentUser() user: AuthUser,
    @Param("projectId") projectId: string,
    @Param("roleId") roleId: string,
    @Body() body: UpdateRoleDto,
  ) {
    return this.projects.updateRole(user.id, projectId, roleId, body);
  }

  @Delete("projects/:projectId/roles/:roleId")
  removeRole(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string, @Param("roleId") roleId: string) {
    return this.projects.removeRole(user.id, projectId, roleId);
  }
}
