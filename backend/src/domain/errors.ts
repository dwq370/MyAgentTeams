export class DomainError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
