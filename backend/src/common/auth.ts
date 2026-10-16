import { SetMetadata } from "@nestjs/common";
import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export const IS_PUBLIC = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user as AuthUser;
});
