import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PlatformModule } from "../platform/platform.module";
import { VersionsController } from "./versions.controller";
import { VersionsService } from "./versions.service";

@Module({
  imports: [AuthModule, PlatformModule],
  controllers: [VersionsController],
  providers: [VersionsService],
})
export class VersionsModule {}
