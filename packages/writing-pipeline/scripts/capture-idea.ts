#!/usr/bin/env -S pnpm tsx
/**
 * capture-idea — Phase 3, Track B.
 *
 * Interactive CLI that prompts each IdeaBrief field and writes the result to
 * voice-loop-runs/ideas-real/<ulid>.json. Supports --from-file for non-
 * interactive testing.
 *
 * Phase 4 will add Whisper voice-note capture; that's not implemented here.
 *
 * Usage:
 *   pnpm tsx scripts/capture-idea.ts                 # interactive prompts
 *   pnpm tsx scripts/capture-idea.ts --from-file <p> # validate + copy
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import {
  generateUlid,
  loadIdeaBriefFromFile,
  validateIdeaBrief,
} from '../src/orchestration/idea-brief.js';
import type { IdeaBrief } from '../src/orchestration/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const IDEAS_DIR = join(PACKAGE_ROOT, 'voice-loop-runs', 'ideas-real');

interface Cli {
  fromFile?: string;
  outDir?: string;
}

function parseCli(argv: string[]): Cli {
  const out: Cli = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-file') out.fromFile = argv[++i];
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
      'Usage: pnpm tsx scripts/capture-idea.ts [options]',
      '',
      'Options:',
      '  --from-file <path>  Load IdeaBrief JSON from path and copy into ideas-real/<id>.json after validation.',
      '  --out-dir <path>    Override output dir (default: voice-loop-runs/ideas-real)',
      '',
      'Without --from-file, prompts each field interactively.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const outDir = cli.outDir ?? IDEAS_DIR;
  mkdirSync(outDir, { recursive: true });

  let idea: IdeaBrief;
  if (cli.fromFile) {
    idea = loadIdeaBriefFromFile(cli.fromFile);
  } else {
    idea = await promptInteractively();
  }

  const path = join(outDir, `${idea.id}.json`);
  writeFileSync(path, JSON.stringify(idea, null, 2) + '\n');
  console.error(`[capture-idea] wrote ${path}`);
  console.error(`[capture-idea] facts=${idea.facts.length} anchors=${idea.anchors.length} forbidden=${idea.forbidden.length}`);
  process.stdout.write(path + '\n');
}

async function promptInteractively(): Promise<IdeaBrief> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, (a) => res(a)));
  const askList = async (q: string, minLen = 0): Promise<string[]> => {
    console.error(`${q} (one per line, blank line to end)`);
    const items: string[] = [];
    for (;;) {
      const line = await ask('  > ');
      if (!line.trim()) break;
      items.push(line.trim());
    }
    if (items.length < minLen) {
      console.error(`(need at least ${minLen})`);
      return askList(q, minLen);
    }
    return items;
  };

  const id = generateUlid();
  console.error(`[capture-idea] new id: ${id}`);
  const title = (await ask('Title: ')).trim();
  console.error('Brief (2-5 sentences, end with a blank line):');
  const briefLines: string[] = [];
  for (;;) {
    const line = await ask('  > ');
    if (!line.trim() && briefLines.length > 0) break;
    briefLines.push(line);
  }
  const brief = briefLines.join('\n').trim();
  const facts = await askList('Facts', 1);
  const anchors = await askList('Anchors', 0);
  const forbidden = await askList('Forbidden directives', 0);
  const voice = (await ask('Voice constraint (optional, blank to skip): ')).trim();
  const targetWordCountRaw = (await ask('Target word count (optional): ')).trim();
  const target = (await ask('Publish target (optional): ')).trim();
  const thesis = (await ask('Thesis line (optional): ')).trim();
  rl.close();

  const idea: IdeaBrief = {
    id,
    title,
    brief,
    facts,
    anchors,
    forbidden,
  };
  if (voice) idea.voice = voice;
  if (targetWordCountRaw) {
    const n = parseInt(targetWordCountRaw, 10);
    if (!Number.isNaN(n)) idea.target_word_count = n;
  }
  if (target) idea.target = target;
  if (thesis) idea.thesis = thesis;

  const v = validateIdeaBrief(idea);
  if (!v.ok) {
    console.error('[capture-idea] validation failed:');
    for (const e of v.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  for (const w of v.warnings) console.error(`[capture-idea] warning: ${w}`);
  return idea;
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
