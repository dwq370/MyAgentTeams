import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class CreateRunDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  prompt: string;

  @IsOptional()
  @IsUUID()
  workItemId?: string;
}

export class PreviewRunDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  prompt: string;

  @IsOptional()
  @IsUUID()
  workItemId?: string;
}
