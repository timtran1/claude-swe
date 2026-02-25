import { Queue } from 'bullmq';
import { config } from '../config.js';

const connection = {
  host: config.redis.host,
  port: config.redis.port,
};

export const taskQueue = new Queue('tasks', { connection });
