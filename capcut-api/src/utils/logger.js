// src/utils/logger.js
import pino from 'pino';
import { config } from './config.js';

// Lazy-init logger: coba pino-pretty untuk dev mode, fallback ke default bila tidak ada
let _logger = null;
export async function getLogger() {
  if (_logger) return _logger;

  let transport;
  if (process.env.NODE_ENV !== 'production') {
    try {
      await import('pino-pretty');
      transport = {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      };
    } catch (_) {
      transport = undefined;
    }
  }
  _logger = pino({ level: config.logLevel, transport });
  return _logger;
}

// Synchronous fallback (tidak pakai pino-pretty)
export const logger = pino({
  level: config.logLevel,
  transport: undefined, // sync init
});

export default logger;
