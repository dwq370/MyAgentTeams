import { Body, Controller, Get, Post } from "@nestjs/common";
import { AuthUser, CurrentUser, Public } from "../common/auth";
import { AuthService } from "./auth.service";
import { LoginDto, RegisterDto } from "../projects/dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("register")
  register(@Body() body: RegisterDto) {
    return this.auth.register(body);
  }

  @Public()
  @Post("login")
  login(@Body() body: LoginDto) {
    return this.auth.login(body);
  }

  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}
