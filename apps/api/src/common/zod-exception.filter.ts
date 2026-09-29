import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError, z } from 'zod';
import { SimulatorError } from '../simulator/simulator.errors.js';

/** Validation errors -> 400; simulator errors -> mapped status with the simulator's code. */
@Catch(ZodError, SimulatorError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(err: ZodError | SimulatorError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof ZodError) {
      res.status(HttpStatus.BAD_REQUEST).json({ statusCode: 400, error: 'VALIDATION_ERROR', message: z.prettifyError(err) });
      return;
    }
    const status = err.status && err.status < 500 ? err.status : HttpStatus.BAD_GATEWAY;
    res.status(status).json({ statusCode: status, error: err.code, message: err.message });
  }
}
