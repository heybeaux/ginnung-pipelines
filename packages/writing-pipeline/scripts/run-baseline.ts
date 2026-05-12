#!/usr/bin/env -S pnpm tsx
/**
 * run-baseline — Phase 3 Track F.
 *
 * Sidecar baseline that bypasses the Ginnung machinery (no fingerprint, no
 * voice critic, no L0 rules, no fact citations, no SonderEvent chain). It
 * gives Opus 4.6 the IdeaBrief, asks for a 2000-word essay, then runs one
 * self-critique + revise pass with the same model.
 *
 * Output lands under voice-loop-runs/baseline/<ideaId>/ and includes:
 *   - idea.json (the brief, for reference)
 *   - draft.md
 *   - self-critique.md
 *   - revised.md
 *   - essay.md (final)
 *   - summary.json (token usage + cost)
 *
 * Cost cap defaults to $0.40 (vs Ginnung's $0.50). On breach the script
 * aborts before the next call.
 *
 * Usage:
 *   pnpm tsx scripts/run-baseline.ts --idea voice-loop-runs/ideas-real/01-lattice-400-handoffs.json
 *
 * Auth: ANTHROPIC_API_KEY > ANTHROPIC_AUTH_TOKEN > OPENROUTER_API_KEY.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';

import { loadIdeaBriefFromFile } from '../src/orchestration/idea-brief.js';
import type { IdeaBrief } from '../src/orchestration/types.js';

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const BASELINE_ROOT = join(PACKAGE_ROOT, 'voice-loop-runs', 'baseline');

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_COST_CEILING = 0.4;
const DRAFT_MAX_TOKENS = 8192;
const REVISE_MAX_TOKENS = 8192;
const CRITIQUE_MAX_TOKENS = 2048;

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
      'Usage: pnpm tsx scripts/run-baseline.ts --idea <path-to-idea.json> [options]',
      '',
      'Options:',
      '  --idea <path>          Path to a validated IdeaBrief JSON file. REQUIRED.',
      '  --out-dir <path>       Output dir. Default: voice-loop-runs/baseline/<ideaId>/',
      '  --cost-ceiling <usd>   Hard cost cap. Default: 0.40.',
      '',
      'Sidecar: no Ginnung machinery — just Opus 4.6, the brief, and one self-critique pass.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (!cli.idea) {
    console.error('FATAL: --idea <path> is required');
    printUsage();
    process.exit(2);
  }

  const { client, modelOverride } = resolveClient();
  const model = modelOverride ?? DEFAULT_MODEL;
  const costCeiling = cli.costCeiling ?? DEFAULT_COST_CEILING;

  console.error(`[baseline] loading idea: ${cli.idea}`);
  const idea = loadIdeaBriefFromFile(resolve(cli.idea));
  console.error(`[baseline]   id=${idea.id} title="${idea.title}"`);

  const outDir = cli.outDir ?? join(BASELINE_ROOT, idea.id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'idea.json'), JSON.stringify(idea, null, 2) + '\n');

  let totalCost = 0;
  const stageCosts: Record<string, number> = {};
  const stageUsage: Record<string, Usage> = {};

  const checkBudget = (label: string): void => {
    if (totalCost > costCeiling) {
      console.error(`[baseline] cost ceiling breach at ${label}: $${totalCost.toFixed(4)} > $${costCeiling.toFixed(2)}`);
      writeSummary();
      process.exit(1);
    }
  };

  const writeSummary = (): void => {
    writeFileSync(
      join(outDir, 'summary.json'),
      JSON.stringify(
        {
          task_id: idea.id,
          model,
          totalCostUsd: round4(totalCost),
          costCeilingUsd: costCeiling,
          stageCostsUsd: Object.fromEntries(
            Object.entries(stageCosts).map(([k, v]) => [k, round4(v)]),
          ),
          stageUsage,
        },
        null,
        2,
      ) + '\n',
    );
  };

  // ---- Stage 1: Draft -----------------------------------------------------
  console.error('[baseline] drafting...');
  const draftSystem = buildBaselineSystem();
  const draftUser = buildDraftUserMessage(idea);
  const draftResp = await client.messages.create({
    model,
    max_tokens: DRAFT_MAX_TOKENS,
    system: draftSystem,
    messages: [{ role: 'user', content: [{ type: 'text', text: draftUser }] }],
  });
  const draftText = extractText(draftResp);
  const draftUsage = extractUsage(draftResp);
  const draftCost = estimateCost(draftUsage);
  totalCost += draftCost;
  stageCosts['draft'] = draftCost;
  stageUsage['draft'] = draftUsage;
  writeFileSync(join(outDir, 'draft.md'), draftText + '\n');
  console.error(`[baseline]   draft: ${countWords(draftText)} words, $${draftCost.toFixed(4)} (cumulative $${totalCost.toFixed(4)})`);
  checkBudget('draft');

  // ---- Stage 2: Self-critique --------------------------------------------
  console.error('[baseline] self-critiquing...');
  const critiqueUser = buildCritiqueUserMessage(idea, draftText);
  const critiqueResp = await client.messages.create({
    model,
    max_tokens: CRITIQUE_MAX_TOKENS,
    system: draftSystem,
    messages: [{ role: 'user', content: [{ type: 'text', text: critiqueUser }] }],
  });
  const critiqueText = extractText(critiqueResp);
  const critiqueUsage = extractUsage(critiqueResp);
  const critiqueCost = estimateCost(critiqueUsage);
  totalCost += critiqueCost;
  stageCosts['critique'] = critiqueCost;
  stageUsage['critique'] = critiqueUsage;
  writeFileSync(join(outDir, 'self-critique.md'), critiqueText + '\n');
  console.error(`[baseline]   critique: $${critiqueCost.toFixed(4)} (cumulative $${totalCost.toFixed(4)})`);
  checkBudget('critique');

  // ---- Stage 3: Revise ----------------------------------------------------
  console.error('[baseline] revising...');
  const reviseUser = buildReviseUserMessage(idea, draftText, critiqueText);
  const reviseResp = await client.messages.create({
    model,
    max_tokens: REVISE_MAX_TOKENS,
    system: draftSystem,
    messages: [{ role: 'user', content: [{ type: 'text', text: reviseUser }] }],
  });
  const revisedText = extractText(reviseResp);
  const reviseUsage = extractUsage(reviseResp);
  const reviseCost = estimateCost(reviseUsage);
  totalCost += reviseCost;
  stageCosts['revise'] = reviseCost;
  stageUsage['revise'] = reviseUsage;
  writeFileSync(join(outDir, 'revised.md'), revisedText + '\n');
  writeFileSync(join(outDir, 'essay.md'), revisedText + '\n');
  console.error(`[baseline]   revised: ${countWords(revisedText)} words, $${reviseCost.toFixed(4)} (cumulative $${totalCost.toFixed(4)})`);

  writeSummary();
  process.stdout.write(renderSummary(idea, outDir, totalCost, costCeiling, stageCosts));
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildBaselineSystem(): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: [
        'You are a skilled essayist drafting a long-form blog post.',
        'Write clear, direct prose. Avoid clichés, slop phrasing, AI-tells, and corporate boilerplate.',
        'Prefer concrete detail over abstract framing. Honour the brief\'s voice and forbidden directives.',
      ].join('\n'),
    },
  ];
}

function buildDraftUserMessage(idea: IdeaBrief): string {
  const lines: string[] = [];
  lines.push(`Write a long-form blog post. Title: "${idea.title}".`);
  lines.push('');
  if (idea.target_word_count) {
    lines.push(`Target length: ${idea.target_word_count} words (within ±15% is fine).`);
    lines.push('');
  }
  if (idea.thesis) {
    lines.push('## Thesis');
    lines.push(idea.thesis);
    lines.push('');
  }
  lines.push('## Brief');
  lines.push(idea.brief);
  lines.push('');
  lines.push('## Facts (use these — do not invent additional figures or sources)');
  idea.facts.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  lines.push('');
  if (idea.anchors.length > 0) {
    lines.push('## Anchors / framing devices');
    idea.anchors.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
    lines.push('');
  }
  if (idea.voice) {
    lines.push('## Voice constraint');
    lines.push(idea.voice);
    lines.push('');
  }
  if (idea.forbidden.length > 0) {
    lines.push('## Forbidden — do not break any of these');
    idea.forbidden.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
    lines.push('');
  }
  if (idea.structural_preferences && idea.structural_preferences.length > 0) {
    lines.push('## Structural preferences');
    idea.structural_preferences.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }
  lines.push('Write the full essay. Output prose only, no preamble, no headings unless natural.');
  return lines.join('\n');
}

function buildCritiqueUserMessage(idea: IdeaBrief, draft: string): string {
  return [
    'You wrote the draft below. Critique it honestly against the brief.',
    '',
    'Focus on:',
    '- Voice fidelity to the constraint (if specified).',
    '- Clichés, slop phrasing, AI-tells, corporate boilerplate, hedge words.',
    '- Any forbidden items that slipped in.',
    '- Any invented facts beyond the supplied list.',
    '- Pacing, opener strength, closer landing.',
    '',
    '## Brief title',
    idea.title,
    '',
    idea.voice ? `## Voice constraint\n${idea.voice}\n` : '',
    idea.forbidden.length > 0 ? `## Forbidden\n${idea.forbidden.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n` : '',
    '## Draft',
    '```',
    draft,
    '```',
    '',
    'List 5-10 concrete issues with line/phrase references where possible. Be specific. No preamble.',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

function buildReviseUserMessage(idea: IdeaBrief, draft: string, critique: string): string {
  return [
    'You wrote the draft and the critique below. Now revise the draft to address every issue in the critique.',
    '',
    'Rules:',
    '- Output the revised essay in full. No diff, no commentary.',
    '- Preserve the voice. Do not over-correct or sanitise.',
    '- Do not invent facts beyond the brief.',
    '',
    `Target length: ${idea.target_word_count ?? 2000} words (±15%).`,
    '',
    '## Draft',
    '```',
    draft,
    '```',
    '',
    '## Critique',
    '```',
    critique,
    '```',
    '',
    'Output only the revised essay prose.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveClient(): { client: Anthropic; modelOverride?: string } {
  if (process.env['ANTHROPIC_API_KEY']) {
    console.error('[baseline] auth: ANTHROPIC_API_KEY (direct)');
    return { client: new Anthropic() };
  }
  if (process.env['ANTHROPIC_AUTH_TOKEN']) {
    console.error('[baseline] auth: ANTHROPIC_AUTH_TOKEN (oauth bearer)');
    return { client: new Anthropic({ authToken: process.env['ANTHROPIC_AUTH_TOKEN']! }) };
  }
  if (process.env['OPENROUTER_API_KEY']) {
    console.error('[baseline] auth: OPENROUTER_API_KEY (via openrouter.ai)');
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

function extractText(response: Anthropic.Messages.Message): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('').trim();
}

function extractUsage(response: Anthropic.Messages.Message): Usage {
  return {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
  };
}

function estimateCost(usage: Usage): number {
  // Opus 4.6 rates. Same scheme as reviser/runner.
  const inputBase = usage.input_tokens / 1_000_000;
  const outputBase = usage.output_tokens / 1_000_000;
  const cacheCreate = usage.cache_creation_input_tokens / 1_000_000;
  const cacheRead = usage.cache_read_input_tokens / 1_000_000;
  return inputBase * 5 + outputBase * 25 + cacheCreate * 5 * 1.25 + cacheRead * 5 * 0.1;
}

function countWords(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 0).length;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function renderSummary(
  idea: IdeaBrief,
  outDir: string,
  totalCost: number,
  ceiling: number,
  stages: Record<string, number>,
): string {
  const lines: string[] = [];
  lines.push(`# Baseline OK — ${idea.id}`);
  lines.push('');
  lines.push(`Out dir: ${outDir}`);
  lines.push(`Total cost: $${totalCost.toFixed(4)} (ceiling $${ceiling.toFixed(2)})`);
  lines.push('');
  lines.push('## Stage costs');
  for (const [k, v] of Object.entries(stages)) {
    lines.push(`- ${k}: $${v.toFixed(4)}`);
  }
  lines.push('');
  lines.push(`Essay: ${outDir}/essay.md`);
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
