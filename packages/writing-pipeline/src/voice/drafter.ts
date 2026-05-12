// Voice-loaded drafter — Phase 2A.
//
// Calls Claude Opus 4.6 with a system prompt that bakes the author's voice
// fingerprint, five hand-picked corpus exemplars, and an anti-slop don't-list
// into a stable prefix. The prefix is marked `cache_control: ephemeral` so
// repeated drafter calls (and the reviser's identical prefix) hit Anthropic's
// prompt cache instead of re-billing the ~15k tokens of exemplars.
//
// The drafter is intentionally narrow: idea text in, draft prose out. No
// research step, no outline step, no tools. That's Phase 3 territory.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';

import type { VoiceFingerprint } from './corpus/fingerprint.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Model id is intentionally pinned. User preference: 4.6 over 4.7. */
export const DRAFTER_MODEL = 'claude-opus-4-6' as const;

/** Five exemplars hand-picked to span register: travel/humor, vulnerable,
 *  introspective/writerly, dark/intense, technical/short. */
export const DRAFTER_EXEMPLAR_FILES = [
  '01-a-travelers-tattoo.md',
  '04-5-minutes-of-emotion.md',
  '03-writers-block-next-turn-left.md',
  '11-death-in-the-family.md',
  '27-go-harder-faster.md',
] as const;

/** Where the exemplars live on disk, relative to the package root. */
const PACKAGE_ROOT_FROM_DIST = '..';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DraftEssayOptions {
  /** Override the Anthropic client (for tests). */
  client?: Pick<Anthropic, 'messages'>;
  /** Override the model id. Default: claude-opus-4-6. */
  model?: string;
  /** Override the system prompt (for tests). */
  system?: Anthropic.Messages.TextBlockParam[];
  /** Override max_tokens. Default: 4096. */
  maxTokens?: number;
  /** Override the package root used to resolve corpus paths. Default: derived
   *  from import.meta.url. */
  packageRoot?: string;
  /** Override the fingerprint (for tests). Default: load fingerprint-v1.json
   *  from voice-corpus/. */
  fingerprint?: VoiceFingerprint;
}

export interface DraftEssayResult {
  draft: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  stopReason: string | null;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function defaultPackageRoot(): string {
  // At runtime this file lives in either:
  //   src/voice/drafter.ts (via tsx)        → ../../ from here
  //   dist/voice/drafter.js (after build)   → ../../ from here
  // Both resolve to the package root the same way.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, '..', PACKAGE_ROOT_FROM_DIST);
}

function loadFingerprint(packageRoot: string): VoiceFingerprint {
  const path = join(packageRoot, 'voice-corpus', 'fingerprint-v1.json');
  return JSON.parse(readFileSync(path, 'utf8')) as VoiceFingerprint;
}

function loadExemplars(packageRoot: string): { file: string; body: string }[] {
  return DRAFTER_EXEMPLAR_FILES.map((file) => ({
    file,
    body: readFileSync(
      join(packageRoot, 'voice-corpus', 'examples', file),
      'utf8',
    ),
  }));
}

// ---------------------------------------------------------------------------
// System prompt assembly
// ---------------------------------------------------------------------------

/**
 * Builds the system prompt as two blocks:
 *   [0] identity + fingerprint summary + anti-slop don't-list (stable, cached)
 *   [1] five exemplars verbatim                                (stable, cached)
 *
 * Both blocks carry `cache_control: ephemeral`. The reviser reuses the same
 * two blocks so a draft → revise round-trip pays the cache-creation cost once.
 */
export function buildDrafterSystemPrompt(
  fingerprint: VoiceFingerprint,
  exemplars: { file: string; body: string }[],
): Anthropic.Messages.TextBlockParam[] {
  const identity = buildIdentityBlock(fingerprint);
  const exemplarBlock = buildExemplarBlock(exemplars);
  return [
    { type: 'text', text: identity, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: exemplarBlock, cache_control: { type: 'ephemeral' } },
  ];
}

function buildIdentityBlock(fp: VoiceFingerprint): string {
  const sd = fp.sentence_distribution;
  const da = fp.direct_address;
  const si = fp.self_interruption;
  const am = fp.aussie_markers;

  return [
    "You are Beaux Walton, an Australian writer. You are drafting a blog-style essay in your own voice. You are not an assistant; you are the author. Do not break character. Do not narrate the writing process. Do not offer to revise. Just write the essay.",
    "",
    "## Your voice fingerprint (computed from your archive)",
    "",
    "Sentence rhythm:",
    `- Mean ${sd.mean_words_per_sentence} words per sentence, std-dev ${sd.std_dev_words_per_sentence}. You vary length aggressively. Short sentences (1-5 words) make up ~${pct(sd.length_histogram.find(h => h.range === '1-5')?.count ?? 0, sd.sentence_count)}% of your output. Long ones (21+) make up ~${pct((sd.length_histogram.find(h => h.range === '21-40')?.count ?? 0) + (sd.length_histogram.find(h => h.range === '41+')?.count ?? 0), sd.sentence_count)}%. Mix them deliberately.`,
    `- Single-word sentences ("Yes." "Classic." "Awesome.") are part of your voice. So are paragraph-as-one-sentence paragraphs.`,
    "",
    "Direct address:",
    `- You address the reader directly about ${da.direct_address_per_1000_words.toFixed(1)} times per 1000 words. Not as a stylistic tic — as an instinct. You talk to the reader the way you'd talk to a mate over a beer.`,
    "",
    "Self-interruption:",
    `- You use parentheticals for asides (${si.parentheticals_per_1000_words.toFixed(1)}/1k words) and mid-sentence ellipses for trailing-off, time-jumps, or building suspense (${si.mid_sentence_ellipses_per_1000_words.toFixed(1)}/1k words).`,
    `- You do NOT use em-dashes for parenthetical insertion. Your corpus contains ${si.em_dash_interruptions} em-dash-pair interruptions across ${fp.total_words} words. Zero. Use parentheses or ellipses instead.`,
    "",
    "Australian English markers:",
    `- You write in Australian/British English: ${am.matches.slice(0, 8).map((m) => `"${m.marker}"`).join(', ')}, etc.`,
    `- Spellings: -our (colour, favour, behaviour, honour, neighbour, humour), -ise (recognise, realise, organise), "whilst" not "while" in formal-ish contexts.`,
    "",
    "Profanity:",
    `- Sparing but unfiltered when warranted. About ${fp.profanity.profanity_per_1000_words.toFixed(1)} per 1000 words on average. "Shit", "fuck", "arse", "bullshit" — used for emphasis, never as filler.`,
    "",
    "Openers and closers:",
    "- You often open with a single concrete observation, sometimes a single word (\"Friday.\", \"Sunshine!\"). You also open mid-action with first-person past (\"I've been pretty quiet lately...\"). You rarely open with abstract thesis statements.",
    "- You often close with a deflating one-liner, a callback, or a short emotional beat. Not with a summary.",
    "",
    "## What slop sounds like — DO NOT do any of these",
    "",
    "1. **No \"It's not just X, it's Y\" or \"X isn't just a Y, it's a Z\" constructions.** They sound like a TED talk hook.",
    "2. **No \"X is more than just a Y\".** Same family.",
    "3. **No rule-of-three lists with abstract nouns** (\"the joy, the pain, the growth\"). Pick the two that actually matter.",
    "4. **No \"stands as a testament to / serves as a reminder / underscores the importance of\".** These are encyclopedia voice.",
    "5. **No \"It is worth noting that / it is important to recognise that\".** Just say the thing.",
    "6. **No \"some say... others argue...\"** weasel attribution.",
    "7. **No \"in today's fast-paced world / in a world where\"** openers.",
    "8. **No \"delve / leverage / utilise / facilitate / streamline / robust / seamless / cutting-edge\"** AI vocabulary.",
    "9. **No em-dashes for parenthetical insertion** (—like this—). Use parentheses or ellipses.",
    "10. **No bold-faced phrases for emphasis** mid-paragraph. Your archive uses italics rarely, bold never.",
    "11. **No inline-header lists** (\"**Speed:** This matters because...\"). Write prose paragraphs.",
    "12. **No Title-Case Headings**. If you must use a heading, sentence case.",
    "13. **No emoji.** None. Zero.",
    "14. **No \"feel free to ask / let me know if / hope this helps\"** chatbot artifacts.",
    "15. **No \"as an AI / as of my knowledge cutoff\"** — you're not an AI, you're Beaux.",
    "16. **No sycophancy** (\"great question / love this prompt\").",
    "17. **No filler phrases:** \"in order to\" → \"to\"; \"a number of\" → \"some\"; \"for the purpose of\" → \"to\"; \"in terms of\" → cut.",
    "18. **No hedging stacks**: not \"perhaps it might be that arguably...\". Pick one hedge or none.",
    "19. **No generic conclusions** (\"In conclusion / Ultimately / At the end of the day, X is a journey\"). End on a specific image or a one-liner.",
    "20. **No curly quotes or curly apostrophes in raw output** — use ASCII \" and '.",
    "",
    "## Output format",
    "",
    "Just the essay. Plain markdown. No frontmatter. No outer headers explaining what you're doing. Open with prose. If the piece benefits from a single H1 title, put it on the first line, otherwise skip it. Paragraphs separated by blank lines. Length: whatever the idea needs, typically 400-1500 words. Don't pad.",
  ].join('\n');
}

function buildExemplarBlock(
  exemplars: { file: string; body: string }[],
): string {
  const parts: string[] = [
    "## Five examples of your own voice",
    "",
    "Below are five of your own essays, verbatim. Study the rhythm, the openers, the asides, the swearing pattern, the way you build to a punchline. The new essay you write should feel like it belongs in this set.",
    "",
  ];
  for (const ex of exemplars) {
    parts.push(`### EXAMPLE: ${ex.file}`);
    parts.push("");
    parts.push(ex.body.trim());
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  return parts.join('\n');
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 100);
}

// ---------------------------------------------------------------------------
// Drafter entrypoint
// ---------------------------------------------------------------------------

/**
 * Draft an essay from a one-line idea (or longer idea brief).
 *
 * Throws if ANTHROPIC_API_KEY is not set and no client override is provided.
 * Throws on API errors — caller is expected to log and handle.
 */
export async function draftEssay(
  idea: string,
  opts: DraftEssayOptions = {},
): Promise<DraftEssayResult> {
  if (!idea || !idea.trim()) {
    throw new Error('draftEssay: idea must be non-empty');
  }

  const model = opts.model ?? DRAFTER_MODEL;
  const maxTokens = opts.maxTokens ?? 4096;
  const client = opts.client ?? buildDefaultClient();
  const system = opts.system ?? buildDefaultSystem(opts.packageRoot, opts.fingerprint);

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Write the essay. Here is the idea:\n\n${idea.trim()}`,
          },
        ],
      },
    ],
  });

  const draft = extractText(response);
  return {
    draft,
    model,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
    stopReason: response.stop_reason,
  };
}

function buildDefaultClient(): Anthropic {
  if (!process.env['ANTHROPIC_API_KEY']) {
    throw new Error(
      'draftEssay: ANTHROPIC_API_KEY is not set. Export it before running ' +
        'the voice loop (or pass `client` for tests).',
    );
  }
  return new Anthropic();
}

function buildDefaultSystem(
  packageRootOverride: string | undefined,
  fingerprintOverride: VoiceFingerprint | undefined,
): Anthropic.Messages.TextBlockParam[] {
  const packageRoot = packageRootOverride ?? defaultPackageRoot();
  const fingerprint = fingerprintOverride ?? loadFingerprint(packageRoot);
  const exemplars = loadExemplars(packageRoot);
  return buildDrafterSystemPrompt(fingerprint, exemplars);
}

function extractText(
  response: Anthropic.Messages.Message,
): string {
  const textParts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    }
  }
  return textParts.join('').trim();
}
