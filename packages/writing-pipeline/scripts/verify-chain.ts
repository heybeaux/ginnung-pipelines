#!/usr/bin/env -S pnpm tsx
/**
 * verify-chain — walk a SonderEvent NDJSON file and verify the hash chain.
 *
 * For each event:
 *   - parses the NDJSON line
 *   - recomputes the canonical content_hash and compares to the stored value
 *   - checks that prev_hash points to the previous event's content_hash
 *     (or is null for the first event)
 *
 * Usage:
 *   pnpm tsx scripts/verify-chain.ts <path-to-sonderevent.ndjson>
 *   pnpm tsx scripts/verify-chain.ts voice-loop-runs/published/<id>/sonderevent.ndjson
 *
 * Exit code 0 if the chain verifies; non-zero with a report on stdout if not.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { verifyChain } from '../src/orchestration/sonder.js';
import type { SonderEvent } from '../src/orchestration/types.js';

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '-h' || args[0] === '--help') {
    printUsage();
    process.exit(args.length === 1 ? 0 : 2);
  }
  const path = resolve(args[0]!);

  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const events: SonderEvent[] = lines.map((l, i) => {
    try {
      return JSON.parse(l) as SonderEvent;
    } catch (err) {
      console.error(`FATAL: failed to parse line ${i + 1} as JSON: ${(err as Error).message}`);
      process.exit(1);
    }
  });

  const result = verifyChain(events);

  if (result.ok) {
    process.stdout.write(
      `chain OK — ${result.totalEvents} event(s) verified at ${path}\n`,
    );
    process.exit(0);
  }

  process.stdout.write(`chain FAILED — ${result.totalEvents} event(s), ${result.errors.length} error(s):\n`);
  for (const e of result.errors) {
    process.stdout.write(`  - [event ${e.eventIndex} id=${e.eventId}] ${e.error}\n`);
  }
  process.exit(1);
}

function printUsage(): void {
  console.error(
    [
      'Usage: pnpm tsx scripts/verify-chain.ts <path-to-sonderevent.ndjson>',
      '',
      'Walks the NDJSON, recomputes each content_hash, and checks that prev_hash',
      'links the chain. Exit 0 on success, non-zero with a per-error report on',
      'failure.',
    ].join('\n'),
  );
}

main();
