import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateRoleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(32)
  code: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  duties: string;

  @IsString()
  promptTemplate: string;

  @IsString({ each: true })
  permissions: string[];
}
