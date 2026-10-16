import { Global, Injectable, Module, OnModuleInit } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { ALL_ENTITIES } from "./entities";
import { SCHEMA_STATEMENTS } from "./schema";

@Injectable()
export class SchemaService implements OnModuleInit {
  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit() {
    await this.dataSource.query("SELECT pg_advisory_lock(814220)");
    try {
      for (const statement of SCHEMA_STATEMENTS) {
        await this.dataSource.query(statement);
      }
    } finally {
      await this.dataSource.query("SELECT pg_advisory_unlock(814220)");
    }
  }
}

@Global()
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres" as const,
        url: config.getOrThrow<string>("DATABASE_URL"),
        entities: ALL_ENTITIES,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature(ALL_ENTITIES),
  ],
  providers: [SchemaService],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
