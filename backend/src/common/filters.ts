import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { QueryFailedError } from "typeorm";
import { DomainError } from "../domain/errors";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (exception instanceof DomainError) {
      response.status(exception.status).json({
        statusCode: exception.status,
        message: exception.message,
        details: exception.details ?? null,
      });
      return;
    }
    if (exception instanceof QueryFailedError) {
      const code = (exception.driverError as { code?: string } | undefined)?.code;
      if (code === "23505") {
        response.status(409).json({ statusCode: 409, message: "记录已存在", details: null });
        return;
      }
      if (code === "23503") {
        response.status(409).json({ statusCode: 409, message: "仍被其他数据引用，不能删除", details: null });
        return;
      }
      this.logger.error(exception.message);
      response.status(500).json({ statusCode: 500, message: "数据访问失败", details: null });
      return;
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      response.status(exception.getStatus()).json(typeof body === "string" ? { message: body } : body);
      return;
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    response.status(500).json({ statusCode: 500, message: "服务器错误", details: null });
  }
}
