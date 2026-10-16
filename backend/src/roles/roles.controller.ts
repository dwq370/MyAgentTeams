import { Body, Controller, Get, Post } from "@nestjs/common";
import { AuthUser, CurrentUser } from "../common/auth";
import { CreateRoleDto } from "./dto";
import { RolesService } from "./roles.service";

@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get("roles")
  list(@CurrentUser() user: AuthUser) {
    return this.roles.list(user.id);
  }

  @Post("roles")
  create(@CurrentUser() user: AuthUser, @Body() body: CreateRoleDto) {
    return this.roles.create(user.id, body);
  }
}
