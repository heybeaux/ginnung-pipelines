#!/usr/bin/env -S pnpm tsx
/**
 * run-voice-loop — Phase 2D.
 *
 * Standalone CLI that runs idea → draft → critique → revise → critique for a
 * single idea file. Writes a fresh run directory under `voice-loop-runs/`
 * containing every artifact so we can inspect, compare, and commit them.
 *
 * Usage:
 *   pnpm tsx scripts/run-voice-loop.ts --idea-file voice-loop-runs/ideas/01.md
 *   pnpm tsx scripts/run-voice-loop.ts --idea "one-liner idea text"
 *
 * Required env: ANTHROPIC_API_KEY.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  draftEssay,
  reviseDraft,
  critiqueDraft,
  buildDrafterSystemPrompt,
  DRAFTER_EXEMPLAR_FILES,
} from '../src/voice/index.js';
import type { Critique } from '../src/voice/critic.js';
import type { VoiceFingerprint } from '../src/voice/corpus/fingerprint.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const VOICE_CORPUS_DIR = join(PACKAGE_ROOT, 'voice-corpus');
const RUNS_DIR = join(PACKAGE_ROOT, 'voice-loop-runs');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Cli {
  ideaFile?: string;
  idea?: string;
  outDir?: string;
}

function parseCli(argv: string[]): Cli {
  const out: Cli = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--idea-file') out.ideaFile = argv[++i];
    else if (a === '--idea') out.idea = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '-h' || a === '--help') {
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
      'Usage: pnpm tsx scripts/run-voice-loop.ts [options]',
      '',
      'Options:',
      '  --idea-file <path>   Path to a markdown file with the idea.',
      '  --idea <text>        Inline idea text (one-liner).',
      '  --out-dir <path>     Override the output directory.',
      '',
      'Exactly one of --idea-file or --idea is required.',
      'Output is written under voice-loop-runs/<timestamp>-<slug>/ by default.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('FATAL: ANTHROPIC_API_KEY is not set. Export it and re-run.');
    process.exit(1);
  }

  const cli = parseCli(process.argv.slice(2));
  const { idea, ideaSource } = resolveIdea(cli);

  const slug = slugify(ideaSource);
  const stamp = timestamp();
  const outDir = cli.outDir ?? join(RUNS_DIR, `${stamp}-${slug}`);
  mkdirSync(outDir, { recursive: true });

  console.error(`[voice-loop] out: ${outDir}`);
  console.error(`[voice-loop] idea: ${truncate(idea, 100)}`);

  // Write the idea verbatim so the run is self-contained.
  writeFileSync(join(outDir, 'idea.md'), idea + (idea.endsWith('\n') ? '' : '\n'));

  // Load fingerprint + exemplars once so we can pass them to both stages and
  // hit the prompt cache on the second call.
  const fingerprint = loadFingerprint();
  const exemplars = loadExemplars();
  const system = buildDrafterSystemPrompt(fingerprint, exemplars);

  // ---- 1. Draft -----------------------------------------------------------
  console.error('[voice-loop] drafting...');
  const draftResult = await draftEssay(idea, { system });
  writeFileSync(join(outDir, 'draft.md'), draftResult.draft + '\n');

  // ---- 2. Critique v1 -----------------------------------------------------
  const critiqueV1 = critiqueDraft(draftResult.draft, { fingerprint });
  writeFileSync(
    join(outDir, 'critique-v1.json'),
    JSON.stringify(critiqueV1, null, 2) + '\n',
  );

  console.error(
    `[voice-loop] draft: voice_match=${critiqueV1.scores.voice_match} ` +
      `slop_total=${critiqueV1.scores.slop_total} ` +
      `slop_per_kilochar=${critiqueV1.scores.slop_per_kilochar} ` +
      `issues=${critiqueV1.issues.length}`,
  );

  // ---- 3. Revise + Critique v2 -------------------------------------------
  console.error('[voice-loop] revising...');
  const reviseResult = await reviseDraft(draftResult.draft, {
    idea,
    fingerprint,
    system,
  });
  writeFileSync(join(outDir, 'revised.md'), reviseResult.finalDraft + '\n');
  writeFileSync(
    join(outDir, 'critique-v2.json'),
    JSON.stringify(reviseResult.finalCritique, null, 2) + '\n',
  );

  console.error(
    `[voice-loop] revised: voice_match=${reviseResult.finalCritique.scores.voice_match} ` +
      `slop_total=${reviseResult.finalCritique.scores.slop_total} ` +
      `slop_per_kilochar=${reviseResult.finalCritique.scores.slop_per_kilochar} ` +
      `accepted=${reviseResult.accepted}`,
  );

  // ---- 4. Summary ---------------------------------------------------------
  const summary = renderSummary({
    idea,
    ideaSource,
    draftResult,
    critiqueV1,
    reviseResult,
  });
  writeFileSync(join(outDir, 'summary.md'), summary);

  console.error('[voice-loop] done.');
  // Echo final summary to stdout so a caller can pipe it.
  process.stdout.write(summary);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveIdea(cli: Cli): { idea: string; ideaSource: string } {
  if (cli.ideaFile) {
    if (!existsSync(cli.ideaFile)) {
      console.error(`FATAL: idea file not found: ${cli.ideaFile}`);
      process.exit(1);
    }
    const raw = readFileSync(cli.ideaFile, 'utf8').trim();
    return { idea: raw, ideaSource: basename(cli.ideaFile, '.md') };
  }
  if (cli.idea) {
    return { idea: cli.idea, ideaSource: cli.idea };
  }
  console.error('FATAL: must pass --idea-file <path> or --idea <text>');
  printUsage();
  process.exit(2);
}

function loadFingerprint(): VoiceFingerprint {
  const path = join(VOICE_CORPUS_DIR, 'fingerprint-v1.json');
  return JSON.parse(readFileSync(path, 'utf8')) as VoiceFingerprint;
}

function loadExemplars(): { file: string; body: string }[] {
  return DRAFTER_EXEMPLAR_FILES.map((file) => ({
    file,
    body: readFileSync(join(VOICE_CORPUS_DIR, 'examples', file), 'utf8'),
  }));
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    'T',
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
    'Z',
  ].join('').replace(/T/, 'T');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}

interface SummaryInput {
  idea: string;
  ideaSource: string;
  draftResult: Awaited<ReturnType<typeof draftEssay>>;
  critiqueV1: Critique;
  reviseResult: Awaited<ReturnType<typeof reviseDraft>>;
}

function renderSummary(s: SummaryInput): string {
  const draftUsage = s.draftResult.usage;
  const reviseUsage = s.reviseResult.usage;

  const draftCostUSD = costForOpus46(draftUsage);
  const reviseCostUSD = costForOpus46(reviseUsage);

  const lines: string[] = [];
  lines.push(`# Voice loop summary — ${s.ideaSource}`);
  lines.push('');
  lines.push('## Idea');
  lines.push('');
  lines.push('> ' + s.idea.split('\n').join('\n> '));
  lines.push('');
  lines.push('## Scores');
  lines.push('');
  lines.push('| Stage | voice_match | slop_total | slop/kchar | issues |');
  lines.push('|---|---|---|---|---|');
  lines.push(
    `| draft v1 | ${s.critiqueV1.scores.voice_match} | ${s.critiqueV1.scores.slop_total} | ${s.critiqueV1.scores.slop_per_kilochar} | ${s.critiqueV1.issues.length} |`,
  );
  lines.push(
    `| revised v2 | ${s.reviseResult.finalCritique.scores.voice_match} | ${s.reviseResult.finalCritique.scores.slop_total} | ${s.reviseResult.finalCritique.scores.slop_per_kilochar} | ${s.reviseResult.finalCritique.issues.length} |`,
  );
  lines.push('');
  lines.push(`Revision decision: **${s.reviseResult.accepted ? 'accepted' : 'reverted'}** — ${s.reviseResult.decisionNote}`);
  lines.push('');
  lines.push('## Costs and cache');
  lines.push('');
  lines.push('| Stage | input | output | cache_create | cache_read | est. $ |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(
    `| draft | ${draftUsage.input_tokens} | ${draftUsage.output_tokens} | ${draftUsage.cache_creation_input_tokens} | ${draftUsage.cache_read_input_tokens} | ${draftCostUSD.toFixed(4)} |`,
  );
  lines.push(
    `| revise | ${reviseUsage.input_tokens} | ${reviseUsage.output_tokens} | ${reviseUsage.cache_creation_input_tokens} | ${reviseUsage.cache_read_input_tokens} | ${reviseCostUSD.toFixed(4)} |`,
  );
  lines.push(`| **total** | | | | | **${(draftCostUSD + reviseCostUSD).toFixed(4)}** |`);
  lines.push('');
  lines.push('## Top issues from v1 critique');
  lines.push('');
  const top = s.critiqueV1.issues.slice(0, 10);
  if (top.length === 0) {
    lines.push('_None._');
  } else {
    for (const iss of top) {
      lines.push(`- **[${iss.severity}] ${iss.kind}** — ${iss.diagnosis}`);
    }
  }
  lines.push('');
  lines.push('## Fingerprint drift (v1 → v2)');
  lines.push('');
  lines.push('| feature | v1 obs | v2 obs | baseline | v2 drift |');
  lines.push('|---|---|---|---|---|');
  const baseByName = new Map(
    s.reviseResult.finalCritique.fingerprint_delta.features.map((f) => [f.feature, f]),
  );
  for (const v1f of s.critiqueV1.fingerprint_delta.features) {
    const v2f = baseByName.get(v1f.feature);
    lines.push(
      `| ${v1f.feature} | ${v1f.observed} | ${v2f?.observed ?? '?'} | ${v1f.baseline} | ${v2f?.normalisedDrift ?? '?'} |`,
    );
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * Rough $ cost using Opus 4.6 rates (input $5/Mtok, output $25/Mtok). Cache
 * reads bill at 10% of base input rate, cache writes at 125%.
 * These are estimates for the summary file, not billing-grade.
 */
function costForOpus46(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}): number {
  const inputBase = usage.input_tokens / 1_000_000;
  const outputBase = usage.output_tokens / 1_000_000;
  const cacheCreate = usage.cache_creation_input_tokens / 1_000_000;
  const cacheRead = usage.cache_read_input_tokens / 1_000_000;
  return (
    inputBase * 5 +
    outputBase * 25 +
    cacheCreate * 5 * 1.25 +
    cacheRead * 5 * 0.1
  );
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
