import { z } from 'zod';

const envSchema = z.object({
  TRELLO_API_KEY: z.string().min(1),
  TRELLO_TOKEN: z.string().min(1),
  TRELLO_WEBHOOK_SECRET: z.string().min(1),
  TRELLO_DONE_LIST_ID: z.string().min(1),
  TRELLO_BOARD_ID: z.string().min(1),

  GITHUB_TOKEN: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),

  WEBHOOK_BASE_URL: z.string().url(),

  // Docker worker image name (built from Dockerfile.worker)
  WORKER_IMAGE: z.string().default('claude-swe-worker:latest'),

  REDIS_HOST: z.string().default('redis'),
  REDIS_PORT: z.coerce.number().default(6379),

  PORT: z.coerce.number().default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Missing or invalid environment variables:');
  for (const [field, issues] of Object.entries(parsed.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${issues?.join(', ')}`);
  }
  process.exit(1);
}

export const config = parsed.data;
