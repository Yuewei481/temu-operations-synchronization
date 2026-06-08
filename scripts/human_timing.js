const DEFAULT_MIN_SECONDS = 2;
const DEFAULT_MAX_SECONDS = 5;

export function parseHumanDelayConfig(env = process.env) {
  const minSeconds = parseSeconds(env.HUMAN_DELAY_MIN_SECONDS, DEFAULT_MIN_SECONDS);
  const maxSeconds = parseSeconds(env.HUMAN_DELAY_MAX_SECONDS, DEFAULT_MAX_SECONDS);

  if (minSeconds > maxSeconds) {
    throw new Error('HUMAN_DELAY_MIN_SECONDS must be less than or equal to HUMAN_DELAY_MAX_SECONDS');
  }

  return {
    minMs: minSeconds * 1000,
    maxMs: maxSeconds * 1000,
  };
}

export function randomHumanDelayMs(config) {
  const span = config.maxMs - config.minMs;
  return config.minMs + Math.floor(Math.random() * (span + 1));
}

function parseSeconds(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid human delay seconds: ${value}`);
  }

  return parsed;
}
