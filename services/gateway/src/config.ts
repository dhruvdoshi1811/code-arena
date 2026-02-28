import { z } from 'zod';

/** Env is validated once, at boot, and the process refuses to start if it is wrong. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  KAFKA_BROKERS: z.string().default('localhost:19092'),
  KAFKA_CLIENT_ID: z.string().default('codearena-gateway'),
  KAFKA_SUBMISSIONS_TOPIC: z.string().default('code-submissions'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  kafkaBrokers: env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter(Boolean),
  kafkaClientId: env.KAFKA_CLIENT_ID,
  kafkaSubmissionsTopic: env.KAFKA_SUBMISSIONS_TOPIC,
  corsOrigins: env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
} as const;
