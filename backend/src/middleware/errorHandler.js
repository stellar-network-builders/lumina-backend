const Joi = require('joi');

// --- Custom Error Classes ---

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      statusCode: this.statusCode,
    };
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400, 'BAD_REQUEST');
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, 409, 'CONFLICT');
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = null) {
    super(message, 422, 'VALIDATION_ERROR');
    this.details = details;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      details: this.details,
    };
  }
}

class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests') {
    super(message, 429, 'TOO_MANY_REQUESTS');
  }
}

class InternalError extends AppError {
  constructor(message = 'Internal server error') {
    super(message, 500, 'INTERNAL_ERROR');
  }
}

// --- Response Helpers ---

function successResponse(data = null, meta = null) {
  const body = { success: true, data };
  if (meta !== null) body.meta = meta;
  return body;
}

function errorResponse(error, statusCode = 500, meta = null) {
  const body = {
    success: false,
    data: null,
    error: typeof error === 'string'
      ? { message: error }
      : error instanceof Error
        ? { message: error.message, code: error.code || 'ERROR' }
        : error,
  };
  if (meta !== null) body.meta = meta;
  return body;
}

// --- Joi Request Validation Middleware ---

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
      allowUnknown: false,
    });

    if (error) {
      const details = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
        type: d.type,
      }));
      return res.status(422).json(
        errorResponse(new ValidationError('Validation failed', details), 422)
      );
    }

    req[source] = value;
    next();
  };
}

function validateParams(schema) {
  return validate(schema, 'params');
}

function validateQuery(schema) {
  return validate(schema, 'query');
}

// --- Global Error Handling Middleware ---

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(errorResponse(err, err.statusCode));
  }

  if (err.isJoi) {
    const details = err.details
      ? err.details.map((d) => ({
          field: d.path.join('.'),
          message: d.message,
          type: d.type,
        }))
      : [{ message: err.message }];
    const validationError = new ValidationError('Validation failed', details);
    return res.status(422).json(errorResponse(validationError, 422));
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json(
      errorResponse(new BadRequestError('Invalid JSON in request body'), 400)
    );
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json(
      errorResponse(new BadRequestError('Request payload too large'), 413)
    );
  }

  console.error('Unhandled error:', err);
  return res.status(500).json(
    errorResponse(new InternalError('Internal server error'), 500)
  );
}

// --- Async Route Wrapper ---

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  TooManyRequestsError,
  InternalError,
  successResponse,
  errorResponse,
  validate,
  validateParams,
  validateQuery,
  errorHandler,
  asyncHandler,
};
