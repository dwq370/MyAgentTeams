import { Type } from "class-transformer";
import { IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from "class-validator";

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/;

export class CreateVersionDto {
  @IsUUID()
  teamId: string;

  @Matches(VERSION)
  version: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  gitSha?: string;
}

export class TransitionDto {
  @IsUUID()
  teamId: string;

  @IsIn(["ready_for_test", "testing"])
  to: "ready_for_test" | "testing";
}

export class TestReportDto {
  @IsUUID()
  teamId: string;

  @IsIn(["passed", "failed"])
  result: "passed" | "failed";

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class ReleaseItemDto {
  @IsUUID()
  serviceId: string;

  @IsUUID()
  serviceVersionId: string;
}

export class CreateReleaseDto {
  @IsUUID()
  teamId: string;

  @Matches(VERSION)
  version: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReleaseItemDto)
  items: ReleaseItemDto[];
}

export class ReplaceReleaseItemsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReleaseItemDto)
  items: ReleaseItemDto[];
}

export class TagDto {
  @IsOptional()
  @IsString()
  @MinLength(7)
  @MaxLength(64)
  gitSha?: string;
}
