// Tests for src/runtime/env-config.ts — covers GIN-48 requirements:
//   - Required var missing → EnvConfigError with clear message
//   - Optional var absent → resolves to declared default
//   - Override takes precedence over process.env / dotenv / default
//   - Precedence ordering across all four tiers
//   - parseDotEnvContents handles common .env syntax
//   - Secret vars are masked in log output
//   - resolveDagConfig validates the auth-credential constraint
//   - parseNumber, parseBoolean, parsePositiveNumber, parseStringList parsers

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  EnvConfigError,
  resolveVar,
  resolveEnv,
  resolveDagConfig,
  parseDotEnvContents,
  loadDotEnv,
  parseString,
  parseNumber,
  parsePositiveNumber,
  parseBoolean,
  parseStringList,
  type EnvVarSchema,
} from '../../src/runtime/env-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Snapshot of process.env keys touched by tests, restored in afterEach. */
const TOUCHED_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENROUTER_API_KEY',
  'GINNUNG_COST_CEILING_USD',
  'GINNUNG_MODEL_OVERRIDE',
  'GINNUNG_MAX_REVISE_PASSES',
  'GINNUNG_LOG_LEVEL',
  'GINNUNG_PUBLISHED_ROOT',
  'MY_SECRET',
  'MY_OPTIONAL',
  'MY_NUMBER',
  'MY_BOOL',
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of TOUCHED_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

// ---------------------------------------------------------------------------
// parseDotEnvContents
// ---------------------------------------------------------------------------

describe('parseDotEnvContents', () => {
  it('parses simple KEY=value pairs', () => {
    const result = parseDotEnvContents('FOO=bar\nBAZ=qux\n');
    expect(result['FOO']).toBe('bar');
    expect(result['BAZ']).toBe('qux');
  });

  it('strips surrounding double quotes', () => {
    const result = parseDotEnvContents('FOO="hello world"\n');
    expect(result['FOO']).toBe('hello world');
  });

  it('strips surrounding single quotes', () => {
    const result = parseDotEnvContents("FOO='hello world'\n");
    expect(result['FOO']).toBe('hello world');
  });

  it('ignores comment lines starting with #', () => {
    const result = parseDotEnvContents('# comment\nFOO=bar\n');
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['FOO']).toBe('bar');
  });

  it('ignores blank lines', () => {
    const result = parseDotEnvContents('\n\nFOO=bar\n\n');
    expect(result['FOO']).toBe('bar');
  });

  it('handles values containing = signs', () => {
    const result = parseDotEnvContents('URL=http://example.com/path?a=1&b=2\n');
    expect(result['URL']).toBe('http://example.com/path?a=1&b=2');
  });

  it('handles empty value', () => {
    const result = parseDotEnvContents('EMPTY=\n');
    expect(result['EMPTY']).toBe('');
  });

  it('handles whitespace around the key', () => {
    const result = parseDotEnvContents('  KEY = value  \n');
    expect(result['KEY']).toBe('value');
  });
});

// ---------------------------------------------------------------------------
// loadDotEnv
// ---------------------------------------------------------------------------

describe('loadDotEnv', () => {
  it('returns parsed map when file is readable', () => {
    const readFile = vi.fn().mockReturnValue('FOO=bar\n');
    const result = loadDotEnv('.env', readFile);
    expect(result['FOO']).toBe('bar');
    expect(readFile).toHaveBeenCalledWith('.env');
  });

  it('returns empty map when file read throws', () => {
    const readFile = vi.fn().mockImplementation(() => { throw new Error('ENOENT'); });
    const result = loadDotEnv('.env', readFile);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Built-in parsers
// ---------------------------------------------------------------------------

describe('parseString', () => {
  it('returns the raw string unchanged', () => {
    expect(parseString('hello', 'VAR')).toBe('hello');
  });
});

describe('parseNumber', () => {
  it('parses integer strings', () => {
    expect(parseNumber('42', 'N')).toBe(42);
  });

  it('parses float strings', () => {
    expect(parseNumber('3.14', 'N')).toBeCloseTo(3.14);
  });

  it('throws EnvConfigError for non-numeric strings', () => {
    expect(() => parseNumber('abc', 'N')).toThrow(EnvConfigError);
  });

  it('throws EnvConfigError for NaN', () => {
    expect(() => parseNumber('NaN', 'N')).toThrow(EnvConfigError);
  });

  it('throws EnvConfigError for Infinity', () => {
    expect(() => parseNumber('Infinity', 'N')).toThrow(EnvConfigError);
  });
});

describe('parsePositiveNumber', () => {
  it('parses a positive number', () => {
    expect(parsePositiveNumber('0.5', 'N')).toBeCloseTo(0.5);
  });

  it('throws for zero', () => {
    expect(() => parsePositiveNumber('0', 'N')).toThrow(EnvConfigError);
  });

  it('throws for negative', () => {
    expect(() => parsePositiveNumber('-1', 'N')).toThrow(EnvConfigError);
  });
});

describe('parseBoolean', () => {
  it.each([['true'], ['1'], ['yes'], ['TRUE'], ['Yes']])('returns true for %s', (raw) => {
    expect(parseBoolean(raw, 'B')).toBe(true);
  });

  it.each([['false'], ['0'], ['no'], ['FALSE'], ['No']])('returns false for %s', (raw) => {
    expect(parseBoolean(raw, 'B')).toBe(false);
  });

  it('throws for unrecognised string', () => {
    expect(() => parseBoolean('maybe', 'B')).toThrow(EnvConfigError);
  });
});

describe('parseStringList', () => {
  it('splits on commas', () => {
    expect(parseStringList('a,b,c', 'L')).toEqual(['a', 'b', 'c']);
  });

  it('trims whitespace around items', () => {
    expect(parseStringList(' a , b , c ', 'L')).toEqual(['a', 'b', 'c']);
  });

  it('filters empty segments', () => {
    expect(parseStringList('a,,b,', 'L')).toEqual(['a', 'b']);
  });

  it('returns a single-element list for a plain string', () => {
    expect(parseStringList('only', 'L')).toEqual(['only']);
  });
});

// ---------------------------------------------------------------------------
// resolveVar — core precedence and validation
// ---------------------------------------------------------------------------

describe('resolveVar — required variable', () => {
  it('throws EnvConfigError with the var name when required var is missing', () => {
    const schema: EnvVarSchema<string> = { name: 'MY_SECRET', required: true, parser: parseString };
    expect(() => resolveVar(schema)).toThrowError(
      expect.objectContaining({ name: 'EnvConfigError', varName: 'MY_SECRET' }),
    );
  });

  it('error message mentions the variable name', () => {
    const schema: EnvVarSchema<string> = { name: 'MY_SECRET', required: true, parser: parseString };
    expect(() => resolveVar(schema)).toThrowError(/MY_SECRET/);
  });

  it('resolves from process.env when present', () => {
    process.env['MY_SECRET'] = 'process-value';
    const schema: EnvVarSchema<string> = { name: 'MY_SECRET', required: true, parser: parseString };
    const resolved = resolveVar(schema);
    expect(resolved.value).toBe('process-value');
    expect(resolved.source).toBe('process');
  });

  it('resolves from override even when process.env has a value (override wins)', () => {
    process.env['MY_SECRET'] = 'process-value';
    const schema: EnvVarSchema<string> = { name: 'MY_SECRET', required: true, parser: parseString };
    const resolved = resolveVar(schema, { overrides: { MY_SECRET: 'override-value' } });
    expect(resolved.value).toBe('override-value');
    expect(resolved.source).toBe('override');
  });
});

describe('resolveVar — optional variable with default', () => {
  it('returns the default when var is not set anywhere', () => {
    const schema: EnvVarSchema<string> = {
      name: 'MY_OPTIONAL',
      required: false,
      defaultValue: 'my-default',
      parser: parseString,
    };
    const resolved = resolveVar(schema);
    expect(resolved.value).toBe('my-default');
    expect(resolved.source).toBe('default');
  });

  it('process.env takes precedence over the default', () => {
    process.env['MY_OPTIONAL'] = 'from-env';
    const schema: EnvVarSchema<string> = {
      name: 'MY_OPTIONAL',
      required: false,
      defaultValue: 'my-default',
      parser: parseString,
    };
    const resolved = resolveVar(schema);
    expect(resolved.value).toBe('from-env');
    expect(resolved.source).toBe('process');
  });

  it('override takes precedence over the default', () => {
    const schema: EnvVarSchema<string> = {
      name: 'MY_OPTIONAL',
      required: false,
      defaultValue: 'my-default',
      parser: parseString,
    };
    const resolved = resolveVar(schema, { overrides: { MY_OPTIONAL: 'overridden' } });
    expect(resolved.value).toBe('overridden');
    expect(resolved.source).toBe('override');
  });

  it('override takes precedence over dotenv', () => {
    const schema: EnvVarSchema<string> = {
      name: 'MY_OPTIONAL',
      required: false,
      defaultValue: 'my-default',
      parser: parseString,
    };
    const resolved = resolveVar(schema, {
      overrides: { MY_OPTIONAL: 'override-wins' },
      dotenvValues: { MY_OPTIONAL: 'dotenv-value' },
    });
    expect(resolved.value).toBe('override-wins');
    expect(resolved.source).toBe('override');
  });
});

describe('resolveVar — four-tier precedence ordering', () => {
  const schema: EnvVarSchema<string> = {
    name: 'MY_OPTIONAL',
    required: false,
    defaultValue: 'default',
    parser: parseString,
  };

  it('tier 4 (default) is used when all other tiers absent', () => {
    const r = resolveVar(schema);
    expect(r.source).toBe('default');
    expect(r.value).toBe('default');
  });

  it('tier 3 (dotenv) overrides default', () => {
    const r = resolveVar(schema, { dotenvValues: { MY_OPTIONAL: 'dotenv' } });
    expect(r.source).toBe('dotenv');
    expect(r.value).toBe('dotenv');
  });

  it('tier 2 (process) overrides dotenv', () => {
    process.env['MY_OPTIONAL'] = 'process';
    const r = resolveVar(schema, { dotenvValues: { MY_OPTIONAL: 'dotenv' } });
    expect(r.source).toBe('process');
    expect(r.value).toBe('process');
  });

  it('tier 1 (override) overrides process', () => {
    process.env['MY_OPTIONAL'] = 'process';
    const r = resolveVar(schema, {
      overrides: { MY_OPTIONAL: 'override' },
      dotenvValues: { MY_OPTIONAL: 'dotenv' },
    });
    expect(r.source).toBe('override');
    expect(r.value).toBe('override');
  });
});

describe('resolveVar — typed parsers', () => {
  it('applies parseNumber to a numeric env var', () => {
    process.env['MY_NUMBER'] = '7';
    const schema: EnvVarSchema<number> = {
      name: 'MY_NUMBER',
      required: true,
      parser: parseNumber,
    };
    const resolved = resolveVar(schema);
    expect(resolved.value).toBe(7);
  });

  it('applies parseBoolean to a boolean env var', () => {
    const schema: EnvVarSchema<boolean> = {
      name: 'MY_BOOL',
      required: false,
      defaultValue: false,
      parser: parseBoolean,
    };
    const resolved = resolveVar(schema, { overrides: { MY_BOOL: 'true' } });
    expect(resolved.value).toBe(true);
  });
});

describe('resolveVar — secret masking in log output', () => {
  it('logs "***" for secret vars instead of the actual value', () => {
    const logLines: string[] = [];
    const schema: EnvVarSchema<string> = {
      name: 'MY_SECRET',
      required: true,
      secret: true,
      parser: parseString,
    };
    resolveVar(schema, {
      overrides: { MY_SECRET: 'super-secret-key' },
      log: (msg) => logLines.push(msg),
    });
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join(' ')).toContain('***');
    expect(logLines.join(' ')).not.toContain('super-secret-key');
  });

  it('logs the actual value for non-secret vars', () => {
    const logLines: string[] = [];
    const schema: EnvVarSchema<string> = {
      name: 'MY_OPTIONAL',
      required: false,
      secret: false,
      defaultValue: 'visible',
      parser: parseString,
    };
    resolveVar(schema, { log: (msg) => logLines.push(msg) });
    expect(logLines.join(' ')).toContain('visible');
  });
});

// ---------------------------------------------------------------------------
// resolveEnv — batch resolution
// ---------------------------------------------------------------------------

describe('resolveEnv', () => {
  it('resolves all vars and returns a typed record', () => {
    const schemas = {
      alpha: { name: 'MY_OPTIONAL', required: false, defaultValue: 'default-alpha', parser: parseString },
      beta: { name: 'MY_NUMBER', required: false, defaultValue: 99, parser: parseNumber },
    } as const;
    const result = resolveEnv(schemas, { overrides: { MY_NUMBER: '42' } });
    expect(result.alpha).toBe('default-alpha');
    expect(result.beta).toBe(42);
  });

  it('collects all missing-required errors and throws a single combined error', () => {
    const schemas = {
      a: { name: 'MY_SECRET', required: true, parser: parseString },
      b: { name: 'MY_OPTIONAL', required: true, parser: parseString },
    } as const;
    expect(() => resolveEnv(schemas)).toThrow(EnvConfigError);
    try {
      resolveEnv(schemas);
    } catch (err) {
      expect(err).toBeInstanceOf(EnvConfigError);
      if (err instanceof EnvConfigError) {
        // Both missing vars should be mentioned in the aggregated message.
        expect(err.message).toContain('MY_SECRET');
        expect(err.message).toContain('MY_OPTIONAL');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// resolveDagConfig — pipeline-level config resolver
// ---------------------------------------------------------------------------

describe('resolveDagConfig', () => {
  it('throws when no auth credential is set', () => {
    // All auth vars are deleted in beforeEach; no overrides supplied.
    expect(() => resolveDagConfig()).toThrow(EnvConfigError);
    expect(() => resolveDagConfig()).toThrow(/auth credential/);
  });

  it('resolves successfully when ANTHROPIC_API_KEY is provided via override', () => {
    const config = resolveDagConfig({ overrides: { ANTHROPIC_API_KEY: 'sk-test-key' } });
    expect(config.ANTHROPIC_API_KEY).toBe('sk-test-key');
  });

  it('resolves successfully when ANTHROPIC_AUTH_TOKEN is provided via override', () => {
    const config = resolveDagConfig({ overrides: { ANTHROPIC_AUTH_TOKEN: 'bearer-token' } });
    expect(config.ANTHROPIC_AUTH_TOKEN).toBe('bearer-token');
  });

  it('resolves successfully when OPENROUTER_API_KEY is provided via override', () => {
    const config = resolveDagConfig({ overrides: { OPENROUTER_API_KEY: 'or-key' } });
    expect(config.OPENROUTER_API_KEY).toBe('or-key');
  });

  it('resolves ANTHROPIC_API_KEY from process.env', () => {
    process.env['ANTHROPIC_API_KEY'] = 'env-key';
    const config = resolveDagConfig();
    expect(config.ANTHROPIC_API_KEY).toBe('env-key');
  });

  it('uses default cost ceiling (0.5) when GINNUNG_COST_CEILING_USD is absent', () => {
    const config = resolveDagConfig({ overrides: { ANTHROPIC_API_KEY: 'key' } });
    expect(config.GINNUNG_COST_CEILING_USD).toBe(0.5);
  });

  it('override for cost ceiling takes precedence over default', () => {
    const config = resolveDagConfig({
      overrides: { ANTHROPIC_API_KEY: 'key', GINNUNG_COST_CEILING_USD: '1.25' },
    });
    expect(config.GINNUNG_COST_CEILING_USD).toBeCloseTo(1.25);
  });

  it('dotenv cost ceiling overrides default', () => {
    const config = resolveDagConfig({
      overrides: { ANTHROPIC_API_KEY: 'key' },
      dotenvValues: { GINNUNG_COST_CEILING_USD: '0.75' },
    });
    expect(config.GINNUNG_COST_CEILING_USD).toBeCloseTo(0.75);
  });

  it('process.env cost ceiling overrides dotenv', () => {
    process.env['GINNUNG_COST_CEILING_USD'] = '0.9';
    const config = resolveDagConfig({
      overrides: { ANTHROPIC_API_KEY: 'key' },
      dotenvValues: { GINNUNG_COST_CEILING_USD: '0.75' },
    });
    expect(config.GINNUNG_COST_CEILING_USD).toBeCloseTo(0.9);
  });

  it('override cost ceiling overrides process.env', () => {
    process.env['GINNUNG_COST_CEILING_USD'] = '0.9';
    const config = resolveDagConfig({
      overrides: { ANTHROPIC_API_KEY: 'key', GINNUNG_COST_CEILING_USD: '0.1' },
    });
    expect(config.GINNUNG_COST_CEILING_USD).toBeCloseTo(0.1);
  });

  it('uses default max revise passes (2) when absent', () => {
    const config = resolveDagConfig({ overrides: { ANTHROPIC_API_KEY: 'key' } });
    expect(config.GINNUNG_MAX_REVISE_PASSES).toBe(2);
  });

  it('parses GINNUNG_MAX_REVISE_PASSES as a positive number', () => {
    const config = resolveDagConfig({
      overrides: { ANTHROPIC_API_KEY: 'key', GINNUNG_MAX_REVISE_PASSES: '4' },
    });
    expect(config.GINNUNG_MAX_REVISE_PASSES).toBe(4);
  });

  it('throws when GINNUNG_MAX_REVISE_PASSES is zero (not a positive number)', () => {
    expect(() =>
      resolveDagConfig({
        overrides: { ANTHROPIC_API_KEY: 'key', GINNUNG_MAX_REVISE_PASSES: '0' },
      }),
    ).toThrow(EnvConfigError);
  });

  it('uses default log level (info) when absent', () => {
    const config = resolveDagConfig({ overrides: { ANTHROPIC_API_KEY: 'key' } });
    expect(config.GINNUNG_LOG_LEVEL).toBe('info');
  });

  it('parses valid GINNUNG_LOG_LEVEL override', () => {
    const config = resolveDagConfig({
      overrides: { ANTHROPIC_API_KEY: 'key', GINNUNG_LOG_LEVEL: 'debug' },
    });
    expect(config.GINNUNG_LOG_LEVEL).toBe('debug');
  });

  it('throws for invalid GINNUNG_LOG_LEVEL value', () => {
    expect(() =>
      resolveDagConfig({
        overrides: { ANTHROPIC_API_KEY: 'key', GINNUNG_LOG_LEVEL: 'verbose' },
      }),
    ).toThrow(EnvConfigError);
  });

  it('logs each resolved var via the provided logger', () => {
    const logLines: string[] = [];
    resolveDagConfig({
      overrides: { ANTHROPIC_API_KEY: 'sk-key' },
      log: (msg) => logLines.push(msg),
    });
    // Should have at least one log line per schema key.
    const schemaKeyCount = 8; // ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENROUTER_API_KEY,
    // GINNUNG_COST_CEILING_USD, GINNUNG_MODEL_OVERRIDE, GINNUNG_MAX_REVISE_PASSES,
    // GINNUNG_LOG_LEVEL, GINNUNG_PUBLISHED_ROOT
    expect(logLines.length).toBeGreaterThanOrEqual(schemaKeyCount);
  });

  it('masks auth secrets in log output', () => {
    const logLines: string[] = [];
    resolveDagConfig({
      overrides: { ANTHROPIC_API_KEY: 'very-secret-key' },
      log: (msg) => logLines.push(msg),
    });
    const joined = logLines.join('\n');
    expect(joined).not.toContain('very-secret-key');
    expect(joined).toContain('***');
  });
});
