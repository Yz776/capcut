// src/services/job-manager.js
import { nanoid } from 'nanoid';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { saveVideo, videoPublicUrl, sanitizeFilename } from '../utils/paths.js';
import { CapCutBrowser } from './capcut-browser.js';

/**
 * Async job manager. Handles:
 * - Create job (queued)
 * - Run job (launches browser, login, render, download)
 * - Track status & progress
 * - Cleanup old jobs from memory
 */

const STATES = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const jobs = new Map(); // jobId -> { id, status, progress, message, videoUrl, error, createdAt, updatedAt, meta }
let activeCount = 0;
const queue = [];

export function createJob(meta = {}) {
  const id = nanoid(12);
  const job = {
    id,
    status: STATES.QUEUED,
    progress: 0,
    message: 'Job queued',
    videoUrl: null,
    videoPath: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta,
  };
  jobs.set(id, job);
  logger.info({ jobId: id, meta }, 'Job created');
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs() {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Enqueue job for execution. Resolves when job starts running (not when complete).
 */
export function enqueueJob(job, work) {
  queue.push({ job, work });
  processQueue();
}

async function processQueue() {
  while (queue.length > 0 && activeCount < config.jobs.maxConcurrent) {
    const { job, work } = queue.shift();
    activeCount++;
    job.status = STATES.RUNNING;
    job.message = 'Starting...';
    job.updatedAt = Date.now();
    // Run async, don't await
    work(job).catch(e => {
      logger.error({ jobId: job.id, err: e.message, stack: e.stack }, 'Job crashed');
      job.status = STATES.FAILED;
      job.error = e.message;
      job.updatedAt = Date.now();
    }).finally(() => {
      activeCount--;
      processQueue();
    });
  }
}

/**
 * Periodic cleanup old jobs from memory
 */
export function startCleanupTimer() {
  setInterval(() => {
    const now = Date.now();
    const ttl = config.jobs.ttlMinutes * 60 * 1000;
    for (const [id, job] of jobs.entries()) {
      if (now - job.updatedAt > ttl) {
        jobs.delete(id);
        logger.info({ jobId: id }, 'Old job cleaned from memory');
      }
    }
  }, 10 * 60 * 1000).unref();
}

export { STATES };
