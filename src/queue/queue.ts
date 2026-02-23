import { Queue } from 'bullmq';
import { config } from '../config.js';

const connection = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
};

export const taskQueue = new Queue('tasks', { connection });
