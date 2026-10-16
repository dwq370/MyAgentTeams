import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AllExceptionsFilter } from "./common/filters";
import { WorkerAppModule } from "./worker.module";

async function bootstrap() {
  process.env.PROCESS_ROLE = "worker";
  const app = await NestFactory.create(WorkerAppModule);
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(process.env.WORKER_PORT || 3001);
}

void bootstrap();
