import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateAgentEngineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsString()
  @MinLength(8)
  cursorApiKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  defaultModel?: string;
}

export class UpdateAgentEngineDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  cursorApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  defaultModel?: string;
}
