/**
 * env-config — typed, validated environment variable resolution for the DAG runtime.
 *
 * Design goals (GIN-48):
 *  1. Typed reads — every var is declared with an explicit TypeScript type and
 *     a parser that converts the raw string value.
 *  2. Validation — required vars that are absent raise a clear, named error.
 *     Optional vars fall back to a declared default without surprises.
 *  3. Override precedence (highest → lowest):
 *       a. Runtime override object (passed programmatically, e.g. in tests)
 *       b. Process environment (process.env, which includes anything a shell or
 *          container has injected)
 *       c. .env file values (loaded once at module init via loadDotEnv())
 *       d. Declared default value in the var schema
 *  4. Logging — when a EnvConfig is resolved, every variable's resolved value
 *     and the source tier that supplied it are logged via the provided logger.
 *     Secret vars are masked before logging.
 */

// ---------------------------------------------------------------------------
// Public error type
// ---------------------------------------------------------------------------

export class EnvConfigError extends Error {
  constructor(
    message: string,
    public readonly varName: string,
  ) {
    super(message);
    this.name = 'EnvConfigError';
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Where the resolved value came from — used in logging and auditing. */
export type EnvSource = 'override' | 'process' | 'dotenv' | 'default';

/** A single resolved variable entry. */
export interface ResolvedVar<T> {
  name: string;
  value: T;
  source: EnvSource;
  /** True if the value should be masked in logs. */
  secret: boolean;
}

/** A function that converts a raw string to T, throwing on invalid input. */
export type EnvParser<T> = (raw: string, name: string) => T;

// ---------------------------------------------------------------------------
// Built-in parsers
// ---------------------------------------------------------------------------

export const parseString: EnvParser<string> = (raw) => raw;

export const parseNumber: EnvParser<number> = (raw, name) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new EnvConfigError(
      `${name}: expected a finite number, got "${raw}"`,
      name,
    );
  }
  return n;
};

export const parsePositiveNumber: EnvParser<number> = (raw, name) => {
  const n = parseNumber(raw, name);
  if (n <= 0) {
    throw new EnvConfigError(
      `${name}: expected a positive number (> 0), got ${n}`,
      name,
    );
  }
  return n;
};

export const parseBoolean: EnvParser<boolean> = (raw, name) => {
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  throw new EnvConfigError(
    `${name}: expected a boolean ("true"/"false"/"1"/"0"), got "${raw}"`,
    name,
  );
};

/** Parse a comma-separated list of non-empty strings. */
export const parseStringList: EnvParser<string[]> = (raw) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

// ---------------------------------------------------------------------------
// Var schema descriptor
// ---------------------------------------------------------------------------

/** Descriptor for a single environment variable. */
export interface EnvVarSchema<T> {
  /** The environment variable name (e.g. 'ANTHROPIC_API_KEY'). */
  name: string;
  /**
   * If true, the variable MUST be present in at least one tier (override,
   * process, or dotenv). Missing required vars throw EnvConfigError.
   * If false or omitted, `defaultValue` is used when all tiers are absent.
   */
  required?: boolean;
  /**
   * Default value used when the var is not required and not found in any tier.
   * Ignored for required vars.
   */
  defaultValue?: T;
  /** Parser applied to the raw string. Defaults to parseString. */
  parser?: EnvParser<T>;
  /**
   * When true, the resolved value is masked as "***" in log output.
   * Recommended for API keys, auth tokens, and other secrets.
   */
  secret?: boolean;
}

// ---------------------------------------------------------------------------
// Dot-env file loader
// ---------------------------------------------------------------------------

/**
 * Parse a .env file body into a key/value map.
 *
 * Supports:
 *  - KEY=value
 *  - KEY="quoted value"
 *  - KEY='quoted value'
 *  - # comment lines
 *  - blank lines
 *
 * Values are NOT recursively interpolated (intentionally simple).
 */
export function parseDotEnvContents(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) continue; // no '=' or key is empty

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (single or double).
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (key) out[key] = val;
  }
  return out;
}

/**
 * Attempt to load a .env file from `path`. Returns an empty map on any
 * read error so the absence of a .env file is always a soft failure.
 */
export function loadDotEnv(
  path: string,
  readFile: (p: string) => string,
): Record<string, string> {
  try {
    return parseDotEnvContents(readFile(path));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /**
   * Runtime overrides — highest priority. Useful for tests and programmatic
   * callers that want to inject values without touching process.env.
   */
  overrides?: Record<string, string>;
  /**
   * Pre-loaded dotenv values — loaded from a .env file by the caller.
   * Lowest priority above the declared default.
   */
  dotenvValues?: Record<string, string>;
  /**
   * Logger function. Receives a human-readable line per resolved variable.
   * Defaults to a no-op so callers explicitly opt in.
   */
  log?: (msg: string) => void;
}

/**
 * Resolve a single environment variable against the four-tier precedence chain.
 * Throws EnvConfigError if the var is required and not found in any tier.
 */
export function resolveVar<T>(
  schema: EnvVarSchema<T>,
  opts: ResolveOptions = {},
): ResolvedVar<T> {
  const { overrides = {}, dotenvValues = {}, log = () => {} } = opts;
  const parser: EnvParser<T> = (schema.parser ?? parseString) as EnvParser<T>;

  // Tier 1: runtime overrides
  if (Object.prototype.hasOwnProperty.call(overrides, schema.name)) {
    const raw = overrides[schema.name]!;
    const value = parser(raw, schema.name);
    const resolved: ResolvedVar<T> = { name: schema.name, value, source: 'override', secret: schema.secret ?? false };
    logResolved(resolved, log);
    return resolved;
  }

  // Tier 2: process environment
  if (schema.name in process.env && process.env[schema.name] !== undefined) {
    const raw = process.env[schema.name]!;
    const value = parser(raw, schema.name);
    const resolved: ResolvedVar<T> = { name: schema.name, value, source: 'process', secret: schema.secret ?? false };
    logResolved(resolved, log);
    return resolved;
  }

  // Tier 3: dotenv file
  if (Object.prototype.hasOwnProperty.call(dotenvValues, schema.name)) {
    const raw = dotenvValues[schema.name]!;
    const value = parser(raw, schema.name);
    const resolved: ResolvedVar<T> = { name: schema.name, value, source: 'dotenv', secret: schema.secret ?? false };
    logResolved(resolved, log);
    return resolved;
  }

  // Tier 4: default
  if (!schema.required && schema.defaultValue !== undefined) {
    const resolved: ResolvedVar<T> = {
      name: schema.name,
      value: schema.defaultValue,
      source: 'default',
      secret: schema.secret ?? false,
    };
    logResolved(resolved, log);
    return resolved;
  }

  // Required and not found in any tier — hard error.
  throw new EnvConfigError(
    `Required environment variable "${schema.name}" is not set. ` +
      `Set it in your environment, a .env file, or pass it as a runtime override.`,
    schema.name,
  );
}

// ---------------------------------------------------------------------------
// Batch resolver — resolves a map of schemas at once
// ---------------------------------------------------------------------------

/**
 * Resolve a record of named schemas, returning a record of typed values.
 * Collects all errors before throwing so the user sees every missing var at once.
 */
export function resolveEnv<Schemas extends Record<string, EnvVarSchema<unknown>>>(
  schemas: Schemas,
  opts: ResolveOptions = {},
): { [K in keyof Schemas]: Schemas[K] extends EnvVarSchema<infer T> ? T : never } {
  const errors: EnvConfigError[] = [];
  const result: Record<string, unknown> = {};

  for (const [key, schema] of Object.entries(schemas)) {
    try {
      result[key] = resolveVar(schema, opts).value;
    } catch (err) {
      if (err instanceof EnvConfigError) {
        errors.push(err);
      } else {
        throw err;
      }
    }
  }

  if (errors.length > 0) {
    const names = errors.map((e) => `  - ${e.varName}: ${e.message}`).join('\n');
    throw new EnvConfigError(
      `${errors.length} environment variable(s) failed to resolve:\n${names}`,
      errors[0]!.varName,
    );
  }

  return result as { [K in keyof Schemas]: Schemas[K] extends EnvVarSchema<infer T> ? T : never };
}

// ---------------------------------------------------------------------------
// DAG runtime env schema — canonical variable definitions for the pipeline
// ---------------------------------------------------------------------------

/**
 * The canonical environment schema for all DAG runtime configuration.
 *
 * Override precedence (high → low):
 *  1. Runtime overrides (tests, programmatic callers)
 *  2. process.env (shell, container, CI)
 *  3. .env file values
 *  4. Declared defaults below
 *
 * Add every new pipeline env var here rather than reading process.env inline
 * across multiple modules.
 */
export const DAG_ENV_SCHEMA = {
  // ---- Auth ----------------------------------------------------------------
  ANTHROPIC_API_KEY: {
    name: 'ANTHROPIC_API_KEY',
    required: false,
    secret: true,
    parser: parseString,
    defaultValue: '',
  } satisfies EnvVarSchema<string>,

  ANTHROPIC_AUTH_TOKEN: {
    name: 'ANTHROPIC_AUTH_TOKEN',
    required: false,
    secret: true,
    parser: parseString,
    defaultValue: '',
  } satisfies EnvVarSchema<string>,

  OPENROUTER_API_KEY: {
    name: 'OPENROUTER_API_KEY',
    required: false,
    secret: true,
    parser: parseString,
    defaultValue: '',
  } satisfies EnvVarSchema<string>,

  // ---- Cost control --------------------------------------------------------
  GINNUNG_COST_CEILING_USD: {
    name: 'GINNUNG_COST_CEILING_USD',
    required: false,
    secret: false,
    parser: parsePositiveNumber,
    defaultValue: 0.5,
  } satisfies EnvVarSchema<number>,

  // ---- Model selection -----------------------------------------------------
  GINNUNG_MODEL_OVERRIDE: {
    name: 'GINNUNG_MODEL_OVERRIDE',
    required: false,
    secret: false,
    parser: parseString,
    defaultValue: '',
  } satisfies EnvVarSchema<string>,

  // ---- Pipeline behaviour --------------------------------------------------
  GINNUNG_MAX_REVISE_PASSES: {
    name: 'GINNUNG_MAX_REVISE_PASSES',
    required: false,
    secret: false,
    parser: parsePositiveNumber,
    defaultValue: 2,
  } satisfies EnvVarSchema<number>,

  GINNUNG_LOG_LEVEL: {
    name: 'GINNUNG_LOG_LEVEL',
    required: false,
    secret: false,
    parser: (raw: string, name: string) => {
      const allowed = ['debug', 'info', 'warn', 'error'] as const;
      const lower = raw.trim().toLowerCase();
      if (!allowed.includes(lower as (typeof allowed)[number])) {
        throw new EnvConfigError(
          `${name}: expected one of ${allowed.join('|')}, got "${raw}"`,
          name,
        );
      }
      return lower as 'debug' | 'info' | 'warn' | 'error';
    },
    defaultValue: 'info' as 'debug' | 'info' | 'warn' | 'error',
  } satisfies EnvVarSchema<'debug' | 'info' | 'warn' | 'error'>,

  // ---- Output paths --------------------------------------------------------
  GINNUNG_PUBLISHED_ROOT: {
    name: 'GINNUNG_PUBLISHED_ROOT',
    required: false,
    secret: false,
    parser: parseString,
    defaultValue: '',
  } satisfies EnvVarSchema<string>,
} as const;

// ---------------------------------------------------------------------------
// Resolved DAG config type (derived from the schema for type safety)
// ---------------------------------------------------------------------------

export interface DagEnvConfig {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_AUTH_TOKEN: string;
  OPENROUTER_API_KEY: string;
  GINNUNG_COST_CEILING_USD: number;
  GINNUNG_MODEL_OVERRIDE: string;
  GINNUNG_MAX_REVISE_PASSES: number;
  GINNUNG_LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  GINNUNG_PUBLISHED_ROOT: string;
}

/**
 * Resolve the full DAG runtime config from the four-tier precedence chain.
 * Validates that at least one auth credential is present after resolution.
 *
 * @param opts.overrides  - Runtime overrides (highest priority).
 * @param opts.dotenvValues - Pre-loaded .env key/value pairs.
 * @param opts.log        - Receives one log line per resolved variable.
 */
export function resolveDagConfig(opts: ResolveOptions = {}): DagEnvConfig {
  const config = resolveEnv(DAG_ENV_SCHEMA, opts) as unknown as DagEnvConfig;

  // Validate the mutually-exclusive auth constraint: at least one credential
  // must be non-empty so the pipeline can make LLM calls.
  const hasAuth =
    config.ANTHROPIC_API_KEY !== '' ||
    config.ANTHROPIC_AUTH_TOKEN !== '' ||
    config.OPENROUTER_API_KEY !== '';

  if (!hasAuth) {
    throw new EnvConfigError(
      'DAG runtime requires at least one auth credential: ' +
        'ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or OPENROUTER_API_KEY.',
      'ANTHROPIC_API_KEY',
    );
  }

  return config;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function logResolved<T>(resolved: ResolvedVar<T>, log: (msg: string) => void): void {
  const displayValue = resolved.secret
    ? '***'
    : typeof resolved.value === 'string' && resolved.value === ''
      ? '(empty)'
      : String(resolved.value);
  log(`[env-config] ${resolved.name}=${displayValue} (source: ${resolved.source})`);
}
