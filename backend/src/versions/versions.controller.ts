import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { AuthUser, CurrentUser } from "../common/auth";
import { CreateReleaseDto, CreateVersionDto, ReplaceReleaseItemsDto, TagDto, TestReportDto, TransitionDto } from "./dto";
import { VersionsService } from "./versions.service";

@Controller()
export class VersionsController {
  constructor(private readonly versions: VersionsService) {}

  @Get("teams/:teamId/versions")
  listForTeam(@CurrentUser() user: AuthUser, @Param("teamId") teamId: string) {
    return this.versions.listForTeam(user.id, teamId);
  }

  @Post("services/:serviceId/versions")
  create(
    @CurrentUser() user: AuthUser,
    @Param("serviceId") serviceId: string,
    @Body() body: CreateVersionDto,
  ) {
    return this.versions.createVersion(user.id, serviceId, body);
  }

  @Post("services/:serviceId/versions/:versionId/transition")
  transition(
    @CurrentUser() user: AuthUser,
    @Param("serviceId") serviceId: string,
    @Param("versionId") versionId: string,
    @Body() body: TransitionDto,
  ) {
    return this.versions.transition(user.id, serviceId, versionId, body);
  }

  @Post("services/:serviceId/versions/:versionId/test-reports")
  testReport(
    @CurrentUser() user: AuthUser,
    @Param("serviceId") serviceId: string,
    @Param("versionId") versionId: string,
    @Body() body: TestReportDto,
  ) {
    return this.versions.recordTest(user.id, serviceId, versionId, body);
  }

  @Post("services/:serviceId/versions/:versionId/tag")
  tag(
    @CurrentUser() user: AuthUser,
    @Param("serviceId") serviceId: string,
    @Param("versionId") versionId: string,
    @Body() body: TagDto,
  ) {
    return this.versions.retryTag(user.id, serviceId, versionId, body.gitSha);
  }

  @Get("projects/:projectId/releases")
  releases(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.versions.listReleases(user.id, projectId);
  }

  @Post("projects/:projectId/releases")
  createRelease(
    @CurrentUser() user: AuthUser,
    @Param("projectId") projectId: string,
    @Body() body: CreateReleaseDto,
  ) {
    return this.versions.createRelease(user.id, projectId, body);
  }

  @Put("system-releases/:releaseId/items")
  replaceItems(
    @CurrentUser() user: AuthUser,
    @Param("releaseId") releaseId: string,
    @Body() body: ReplaceReleaseItemsDto,
  ) {
    return this.versions.replaceItems(user.id, releaseId, body.items);
  }

  @Post("system-releases/:releaseId/publish")
  publish(@CurrentUser() user: AuthUser, @Param("releaseId") releaseId: string) {
    return this.versions.publish(user.id, releaseId);
  }
}
