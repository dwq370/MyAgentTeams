import { Type } from "class-transformer";
import { IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from "class-validator";

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;
}

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;
}

export class UpdateProjectDto {
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
  @IsString()
  @MaxLength(200000)
  architectureDescription?: string;
}

export class GenerateArchitectureDto {
  @IsUUID()
  agentId: string;

  @IsIn(["document", "code"])
  source: "document" | "code";

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  document?: string;
}

export class AddProjectMemberDto {
  @IsEmail()
  email: string;

  @IsIn(["admin", "member"])
  projectRole: "admin" | "member";
}

export class UpdateProjectMemberDto {
  @IsIn(["admin", "member"])
  projectRole: "admin" | "member";
}

export class BindAgentEngineDto {
  @IsOptional()
  @IsUUID()
  agentEngineId?: string | null;
}

export class ProbeTestEnvironmentDto {
  @IsIn(["standalone", "kubernetes"])
  kind: "standalone" | "kubernetes";

  @IsOptional()
  @IsUUID()
  environmentId?: string;

  @ValidateIf((item: ProbeTestEnvironmentDto) => item.kind === "standalone")
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  sshHost?: string;

  @ValidateIf((item: ProbeTestEnvironmentDto) => item.kind === "standalone")
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  sshPort?: number;

  @ValidateIf((item: ProbeTestEnvironmentDto) => item.kind === "standalone")
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  sshUsername?: string;

  @ValidateIf((item: ProbeTestEnvironmentDto) => item.kind === "standalone")
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sshPassword?: string;

  @ValidateIf((item: ProbeTestEnvironmentDto) => item.kind === "kubernetes")
  @IsIn(["local"])
  kubectlClient?: "local";

  @ValidateIf((item: ProbeTestEnvironmentDto) => item.kind === "kubernetes")
  @IsOptional()
  @IsString()
  @MaxLength(200)
  kubeContext?: string;
}

export class CreateTestEnvironmentDto extends ProbeTestEnvironmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;
}

export class UpdateTestEnvironmentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsIn(["standalone", "kubernetes"])
  kind?: "standalone" | "kubernetes";

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sshHost?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  sshPort?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  sshUsername?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  sshPassword?: string;

  @IsOptional()
  @IsIn(["local"])
  kubectlClient?: "local";

  @IsOptional()
  @IsString()
  @MaxLength(200)
  kubeContext?: string;
}

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

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  duties?: string;

  @IsOptional()
  @IsString()
  promptTemplate?: string;

  @IsOptional()
  @IsString({ each: true })
  permissions?: string[];
}
