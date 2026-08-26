const Joi = require('joi');

const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'staging')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(4000),
  FRONTEND_URL: Joi.string().uri().default('http://localhost:3000'),
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().integer().min(1).max(65535).required(),
  DB_NAME: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  JWT_SECRET: Joi.string().min(16).required(),
  WS_MAX_CONNECTIONS_PER_IP: Joi.number().integer().min(1).default(5),
  WS_MAX_CONNECTIONS_PER_USER: Joi.number().integer().min(1).default(3),
  TRANSPARENCY_PRIVATE_KEY: Joi.string().required(),
  TRANSPARENCY_PUBLIC_KEY: Joi.string().required(),
  STELLAR_RPC_URL: Joi.string().uri().required(),
  STELLAR_NETWORK: Joi.string().valid('testnet', 'mainnet', 'futurenet').required(),
  STELLAR_NETWORK_PASSPHRASE: Joi.string().required(),
  STELLAR_HORIZON_URL: Joi.string().uri().required(),
  SOROBAN_RPC_URL: Joi.string().uri().required(),
  VAULT_CONTRACT_ADDRESS: Joi.string().required(),
  STELLAR_ANCHORS: Joi.string().default(''),
  SWAP_FEE_PERCENT: Joi.number().min(0).max(100).default(0.3),
  DISCORD_BOT_TOKEN: Joi.string().allow('').optional(),
  DISCORD_CHANNEL_ID: Joi.string().allow('').optional(),
  REDIS_URL: Joi.string().uri().required(),
  SLACK_WEBHOOK_URL: Joi.string().uri().allow('').optional(),
  EMAIL_HOST: Joi.string().allow('').optional(),
  EMAIL_PORT: Joi.number().integer().optional(),
  EMAIL_USER: Joi.string().allow('').optional(),
  EMAIL_PASS: Joi.string().allow('').optional(),
  EMAIL_FROM: Joi.string().email().allow('').optional(),
  FIREBASE_SERVICE_ACCOUNT_PATH: Joi.string().allow('').optional(),
  FIREBASE_SERVICE_ACCOUNT_KEY: Joi.string().allow('').optional(),
  OTEL_SERVICE_NAME: Joi.string().default('vesting-vault-backend'),
  OTEL_EXPORTER_JAEGER_ENDPOINT: Joi.string().uri().allow('').optional(),
  OTEL_TRACES_SAMPLE_RATE: Joi.number().min(0).max(1).default(1.0),
  ENABLE_JAEGER: Joi.boolean().default(true),
  ENABLE_OTLP: Joi.boolean().default(false),
  OTEL_CONSOLE_EXPORT: Joi.boolean().default(false),
}).unknown(true);

function validateEnv(loadedEnv = process.env) {
  const { error, value } = envSchema.validate(loadedEnv, {
    abortEarly: false,
    stripUnknown: false,
  });

  if (error) {
    const missing = error.details
      .filter((d) => d.type === 'any.required')
      .map((d) => d.path.join('.'));
    const invalid = error.details
      .filter((d) => d.type !== 'any.required')
      .map((d) => `${d.path.join('.')}: ${d.message}`);

    const messages = [];
    if (missing.length) messages.push(`Missing required: ${missing.join(', ')}`);
    if (invalid.length) messages.push(`Invalid values: ${invalid.join('; ')}`);

    console.error('\nEnvironment validation failed:\n');
    messages.forEach((m) => console.error(`  - ${m}`));
    console.error('\nPlease check your .env file and ensure all required variables are set.\n');

    throw new Error(`Environment validation failed: ${messages.join('. ')}`);
  }

  return value;
}

function validateEnvOrExit(loadedEnv = process.env) {
  try {
    const validated = validateEnv(loadedEnv);
    console.log('Environment variables validated successfully');
    return validated;
  } catch (err) {
    if (process.env.NODE_ENV === 'test') {
      throw err;
    }
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  envSchema,
  validateEnv,
  validateEnvOrExit,
};
