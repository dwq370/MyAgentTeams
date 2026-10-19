import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";

export class CreateTeamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;
}

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsUUID()
  testEnvironmentId?: string | null;
}

export class WorkspaceItemDto {
  @IsUUID()
  serviceId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  baselineRef: string;
}

export class ReplaceWorkspacesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkspaceItemDto)
  items: WorkspaceItemDto[];
}

export class GroupRepoDto {
  @IsUUID()
  sourceId: string;

  @IsString()
  @MaxLength(2000)
  repoUrl: string;
}

export class CreateSourceDto {
  @IsIn(["group", "repo"])
  kind: "group" | "repo";

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  url: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  gitToken: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  baselineRef?: string;
}

export class ExistingBranchDto {
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  repoUrl?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  branch: string;
}

export class BranchPlanDto {
  @IsBoolean()
  create: boolean;

  @IsOptional()
  @IsIn(["default", "custom", "existing"])
  mode?: "default" | "custom" | "existing";

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExistingBranchDto)
  existing?: ExistingBranchDto[];
}

export class HumanMemberDto {
  @IsEmail()
  email: string;

  @IsUUID()
  roleId: string;

  @IsOptional()
  @IsString()
  dutyOverride?: string;

  @IsArray()
  @IsUUID("4", { each: true })
  serviceIds: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GroupRepoDto)
  groupRepos?: GroupRepoDto[];

  @IsOptional()
  @IsUUID()
  testedServiceVersionId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  contactMemberIds?: string[];
}

export class AgentMemberDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsUUID()
  roleId: string;

  @IsOptional()
  @IsString()
  dutyOverride?: string;

  @IsArray()
  @IsUUID("4", { each: true })
  serviceIds: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GroupRepoDto)
  groupRepos?: GroupRepoDto[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @IsUUID()
  testedServiceVersionId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BranchPlanDto)
  branch?: BranchPlanDto;

  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  contactMemberIds?: string[];
}

export class ReplaceMemberReposDto {
  @IsArray()
  @IsUUID("4", { each: true })
  serviceIds: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GroupRepoDto)
  groupRepos?: GroupRepoDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => BranchPlanDto)
  branch?: BranchPlanDto;
}

export class UpdateContactsDto {
  @IsArray()
  @IsUUID("4", { each: true })
  memberIds: string[];
}

export class UpdateMemberDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsUUID()
  roleId?: string;

  @IsOptional()
  @IsString()
  dutyOverride?: string;

  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  serviceIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GroupRepoDto)
  groupRepos?: GroupRepoDto[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @IsUUID()
  testedServiceVersionId?: string | null;
}

export class CreateWorkItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @IsOptional()
  @IsUUID()
  assigneeMemberId?: string;
}

export class UpdateWorkItemDto {
  @IsOptional()
  @IsIn(["open", "in_progress", "done"])
  status?: "open" | "in_progress" | "done";

  @IsOptional()
  @IsUUID()
  assigneeMemberId?: string;
}
