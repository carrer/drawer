import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** An error whose status and code are safe to show the client, shaped like ErrorResponseSchema. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Postgres unique_violation, e.g. a second live category with the same name. */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return reply.code(400).send({ error: 'bad_request', message });
  }
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  // Fastify's own client errors: malformed JSON, body too large, wrong content type.
  const status = (err as FastifyError).statusCode;
  if (status && status >= 400 && status < 500) {
    return reply.code(status).send({ error: 'bad_request', message: err.message });
  }
  req.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ error: 'internal', message: 'internal server error' });
}
