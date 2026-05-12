#!/usr/bin/env -S pnpm tsx
/**
 * run-pipeline — Phase 3 orchestration CLI.
 *
 * Loads an IdeaBrief JSON file and walks the full 8-step Ginnung writing
 * pipeline: idea-capture → research (no-op) → outline → draft → critique →
 * revise (two-pass) → critique-again → publish → post-publish (no-op).
 *
 * Each step emits a pair of SonderEvents (entry + exit) hashed into a chain.
 * L0 invariants run on every event. Final artifacts land in
 * voice-loop-runs/published/<ideaId>/.
 *
 * Usage:
 *   pnpm tsx scripts/run-pipeline.ts --idea voice-loop-runs/ideas-real/01-lattice-400-handoffs.json
 *   pnpm tsx scripts/run-pipeline.ts --idea <path> --out-dir <dir>
 *   pnpm tsx scripts/run-pipeline.ts --idea <path> --cost-ceiling 0.75
 *
 * Auth: ANTHROPIC_API_KEY > ANTHROPIC_AUTH_TOKEN > OPENROUTER_API_KEY.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';

import { loadIdeaBriefFromFile } from '../src/orchestration/idea-brief.js';
import { runPipeline, loadDrafterExemplars } from '../src/orchestration/runner.js';
import type { VoiceFingerprint } from '../src/voice/corpus/fingerprint.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const VOICE_CORPUS_DIR = join(PACKAGE_ROOT, 'voice-corpus');
const PUBLISHED_ROOT = join(PACKAGE_ROOT, 'voice-loop-runs', 'published');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Cli {
  idea?: string;
  outDir?: string;
  costCeiling?: number;
}

function parseCli(argv: string[]): Cli {
  const out: Cli = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--idea') out.idea = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--cost-ceiling') {
      const v = parseFloat(argv[++i] ?? '');
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`FATAL: --cost-ceiling must be a positive number (got ${argv[i]})`);
        process.exit(2);
      }
      out.costCeiling = v;
    } else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return out;
}

function printUsage(): void {
  console.error(
    [
      'Usage: pnpm tsx scripts/run-pipeline.ts --idea <path-to-idea.json> [options]',
      '',
      'Options:',
      '  --idea <path>          Path to a validated IdeaBrief JSON file. REQUIRED.',
      '  --out-dir <path>       Output directory. Default: voice-loop-runs/published/<ideaId>/',
      '  --cost-ceiling <usd>   Hard cost cap per essay. Default: 0.50.',
      '',
      'Auth: one of ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or OPENROUTER_API_KEY.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (!cli.idea) {
    console.error('FATAL: --idea <path> is required');
    printUsage();
    process.exit(2);
  }

  const { client, modelOverride } = resolveClient();

  console.error(`[run-pipeline] loading idea: ${cli.idea}`);
  const idea = loadIdeaBriefFromFile(resolve(cli.idea));
  console.error(`[run-pipeline]   id=${idea.id} title="${idea.title}"`);
  console.error(`[run-pipeline]   facts=${idea.facts.length} anchors=${idea.anchors.length} forbidden=${idea.forbidden.length}`);

  const fingerprint = loadFingerprint();
  const exemplars = loadDrafterExemplars(PACKAGE_ROOT);
  console.error(`[run-pipeline] loaded fingerprint + ${exemplars.length} exemplars`);

  const outDir = cli.outDir ?? join(PUBLISHED_ROOT, idea.id);
  console.error(`[run-pipeline] out: ${outDir}`);

  const artifact = await runPipeline(idea, {
    client,
    ...(modelOverride ? { modelOverride } : {}),
    fingerprint,
    exemplars,
    outDir,
    ...(cli.costCeiling !== undefined ? { costCeilingUsd: cli.costCeiling } : {}),
    log: (m: string) => console.error(m),
  });

  // Render a short stdout summary so the caller can pipe it.
  if (artifact.status === 'ok') {
    process.stdout.write(renderOkSummary(artifact));
    process.exit(0);
  } else {
    process.stdout.write(renderFailSummary(artifact));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve which Anthropic client to use, in this priority:
 *  1. ANTHROPIC_API_KEY — production raw API key (Messages API).
 *  2. ANTHROPIC_AUTH_TOKEN — OAuth bearer token (Claude Code / inference scope).
 *  3. OPENROUTER_API_KEY — route through OpenRouter's Anthropic-compatible
 *     endpoint with model id rewritten to anthropic/claude-opus-4.6.
 */
function resolveClient(): { client: Anthropic; modelOverride?: string } {
  if (process.env['ANTHROPIC_API_KEY']) {
    console.error('[run-pipeline] auth: ANTHROPIC_API_KEY (direct)');
    return { client: new Anthropic() };
  }
  if (process.env['ANTHROPIC_AUTH_TOKEN']) {
    console.error('[run-pipeline] auth: ANTHROPIC_AUTH_TOKEN (oauth bearer)');
    return { client: new Anthropic({ authToken: process.env['ANTHROPIC_AUTH_TOKEN']! }) };
  }
  if (process.env['OPENROUTER_API_KEY']) {
    console.error('[run-pipeline] auth: OPENROUTER_API_KEY (via openrouter.ai)');
    const client = new Anthropic({
      authToken: process.env['OPENROUTER_API_KEY']!,
      baseURL: 'https://openrouter.ai/api',
      defaultHeaders: { 'x-api-key': '' },
    });
    return { client, modelOverride: 'anthropic/claude-opus-4.6' };
  }
  console.error(
    'FATAL: none of ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENROUTER_API_KEY are set.',
  );
  process.exit(1);
}

function loadFingerprint(): VoiceFingerprint {
  const path = join(VOICE_CORPUS_DIR, 'fingerprint-v1.json');
  return JSON.parse(readFileSync(path, 'utf8')) as VoiceFingerprint;
}

type Artifact = Awaited<ReturnType<typeof runPipeline>>;

function renderOkSummary(a: Artifact): string {
  const lines: string[] = [];
  lines.push(`# Pipeline OK — ${a.task_id}`);
  lines.push('');
  lines.push(`Out dir: ${a.outDir}`);
  lines.push(`Total cost: $${a.totalCostUsd.toFixed(4)}`);
  lines.push('');
  lines.push('## Scores');
  lines.push('');
  lines.push('| Stage | voice_match | slop/kchar | slop_total |');
  lines.push('|---|---|---|---|');
  const row = (label: string, s: typeof a.scores.draft) =>
    s
      ? `| ${label} | ${s.voice_match} | ${s.slop_per_kilochar} | ${s.slop_total} |`
      : `| ${label} | (no pass) | | |`;
  lines.push(row('draft', a.scores.draft));
  lines.push(row('revise pass 1', a.scores.revise1));
  lines.push(row('revise pass 2', a.scores.revise2));
  lines.push('');
  if (a.factCitation) {
    lines.push('## Fact citation');
    lines.push('');
    lines.push(`- total first-person claims: ${a.factCitation.totalClaims}`);
    lines.push(`- cited with [fact:N]: ${a.factCitation.citedClaims}`);
    lines.push(`- uncited violations: ${a.factCitation.invalidCount}`);
    lines.push('');
  }
  lines.push(`Essay: ${a.outDir}/essay.md`);
  lines.push('');
  return lines.join('\n');
}

function renderFailSummary(a: Artifact): string {
  return [
    `# Pipeline FAILED — ${a.task_id}`,
    '',
    `Out dir: ${a.outDir}`,
    `Reason: ${a.failureReason ?? '(unknown)'}`,
    `Cost so far: $${a.totalCostUsd.toFixed(4)}`,
    '',
  ].join('\n');
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
