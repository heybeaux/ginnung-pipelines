# Multi-agent systems fail 87% of the time. I ran 400 real handoffs through a coordination layer. Here's what I found.

Ninety-one out of a hundred.

That's the number I kept staring at in the audit log. Not the 93% overall pass rate, which is the number you'd put on a slide if you wanted to look impressive. The number that actually matters is the one that told me my middle validation tier was nearly useless for creative work. I'll get to that. But first, the problem that made me build the thing in the first place.

## The 87% problem

Multi-agent AI has a coordination problem that nobody wants to talk about honestly. The MAST paper out of NeurIPS 2025 studied over 1,600 multi-agent traces and found failure rates up to 87% [fact:0]. Runcycles published a study in March 2026 looking at production deployments and landed at the same number: up to 87% failure [fact:1]. Talyx ran an enterprise study in 2026 and found 80-90% failure rates [fact:2]. Three independent studies, three versions of the same ugly result.

Here's the part that should make you uncomfortable. The MAST paper found that better models improved success rates by less than 5% [fact:3]. Throwing a smarter model at the problem barely moves the needle. Gartner now predicts 40% of agentic AI projects will be cancelled by 2027 [fact:4], and whilst 80% of enterprise apps embed agents in some form, only 31% have anything actually running in production [fact:5]. The failures aren't about model capability. They're architectural. They're coordination problems.

If you've ever written concurrent software, this should feel familiar. Concurrent programming went through exactly this phase 60 years ago... shared state, race conditions, deadlocks nobody noticed until production fell over. The solution wasn't faster CPUs. It was mutexes, semaphores, message passing... boring infrastructure that managed how threads talked to each other. Multi-agent AI has the same category of problem. A 200 OK with garbage downstream is the agentic equivalent of a deadlock that doesn't throw an error. Everything looks fine. Everything is broken.

## What Lattice actually is

I built Lattice [fact:6], an open-source coordination layer for multi-agent AI pipelines. It's framework-agnostic [fact:11], wrapping any agent function in LangGraph, CrewAI, Mastra, or raw TypeScript/Python, and it gives you three primitives [fact:7].

State Contracts carry full lineage per action: inputs, decisions, outputs, constraints, assumptions [fact:30]. Every handoff within a run shares the same traceId [fact:32], and each of the 50 runs in my benchmark produced about 8 handoff validations on average including escalations [fact:31]. Circuit Breakers provide tiered validation across three levels [fact:7]. L1 is JSON Schema validation, sub-200ms, zero LLM calls [fact:8], and it answers one question: did the agent return the right shape? L2 is embedding similarity using text-embedding-3-small with a threshold of 0.85, running at roughly 600ms [fact:9], answering whether the output semantically matches the contract. L3 is LLM-as-judge using gpt-4o-mini with a confidence threshold of 0.7, costing about 25 seconds per call [fact:10], and it answers the hardest question: is this actually good? Pipeline orchestration ties them together.

The packages are @heybeaux/lattice-core, @heybeaux/lattice-provider-openai, @heybeaux/lattice-adapter-mastra, and lattice-langgraph for Python [fact:33]. The design principle was that each tier should do what it's actually good at, not what I wished it did. That distinction turned out to be the whole story.

## The benchmark, honestly

Fifty documentation topics. Five agent steps per topic. Four hundred handoff validations total [fact:12]. I ran the whole thing in shadow mode inside my production content pipeline, Forge [fact:13], which means every handoff produced a State Contract, got validated, got logged, but never blocked the pipeline. Total wall-clock time: 1 hour 43 minutes [fact:14]. Zero pipelines crashed [fact:16].

Overall pass rate: 93.0%, 372 out of 400 [fact:15].

Per-step, Research passed 78% of the time (39/50), Outline passed 94% (47/50), Drafter passed 87% (87/100), Reviewer passed 99% (99/100), and Formatter passed 100% (100/100) [fact:21]. Research is the weak link, and that makes sense... it's the step where the agent is most unconstrained, pulling information from external sources, making judgement calls about what's relevant. The further downstream you go, the more the pipeline constrains the output, and the higher the pass rate climbs.

Tier-level pass rates tell a different story. L1 was 100% [fact:17]. L2 was 91.0%, but that's 91 out of 100 actual L2 runs, because 150 handoffs skipped L2 entirely by policy [fact:18]. L3 passed 92.1% of the time, 222 out of 241 calls [fact:19].

Latency is where the cost lives. L1 mean was under 200ms, P95 under 200ms [fact:22]. Cheap. L2 mean was 627ms, but P95 hit 9.0 seconds with a max of 13.8s [fact:23]. L3 mean was 25.4 seconds, P95 was 63.2 seconds, and the max was 110.2 seconds [fact:24]. That max is nearly two minutes for a single validation call. If you're running L3 on every handoff in a five-step pipeline, you're adding serious minutes to wall-clock time, and it has to be worth it. The full audit log (all 400 entries) is public at github.com/heybeaux/ops/blob/main/reports/lattice-shadow-audit-50topics-2026-05-08.jsonl [fact:34], and the aggregated report is at github.com/heybeaux/ops/blob/main/reports/lattice-benchmark-50topics-2026-05-08.json [fact:35]. Go look. I'm not hiding the ugly parts.

## The L2 surprise and what it means

This is the finding I keep coming back to. Ninety-one of 100 L2 validations escalated to L3 [fact:26]. My middle tier, the one I'd designed to catch semantic drift without burning an LLM call, was punting almost everything upstairs.

It took me a bit to understand why, and then it was obvious. L2 uses embedding similarity [fact:9]. It measures whether the output is semantically close to what the contract specified, and for structural-consistency steps that works beautifully... does this outline faithfully organise what research produced? But for creative steps like drafting and reviewing, the output is supposed to diverge from the input. A good draft doesn't just reorganise the outline. It adds voice, examples, transitions, arguments the outline never specified. Embedding similarity punishes exactly that. It sees divergence and flags it as drift, which means L2 was escalating to L3 not because something was wrong, but because something was right.

That realisation is why 150 handoffs were configured to skip L2 entirely for the drafter, reviewer and formatter steps [fact:27], and why per-step L2 configuration was added mid-benchmark after I saw the data [fact:28]. I didn't plan that configuration. The data forced it. The right routing turned out to be: Research to Outline uses L1 plus L2, Outline to Draft uses L1 plus L3, Draft to Review uses L1 plus L3, Review to Format uses L1 only [fact:29].

Then there's the L3 confidence distribution. 99% of L3 calls (239 out of 241) landed in the 0.8 to 1.0 confidence band [fact:20]. Only 2 out of 241 landed in the uncertain 0.6 to 0.8 band [fact:25]. When L3 is confident, it's very confident. The distribution is bimodal with almost nothing in the middle, and that's actually reassuring... it means L3 isn't waffling. It knows when work is good and it knows when it isn't.

L2 catches drift. L3 catches quality. They aren't substitutes. They're complements, and you have to route work to the right one based on what the step actually does, not based on some idealised pipeline diagram where every handoff gets the same treatment. The threading-libraries people figured this out decades ago... different synchronisation primitives for different access patterns. Same principle. Different domain.

## What's next

I run heybeaux [fact:37], a small dev shop where AI agents do real work in production. The next thing I'm building is an observability dashboard [fact:38]... a web UI for the audit trail so I can stop reading JSONL files like some kind of animal.

Lattice is at github.com/heybeaux/lattice [fact:36]. The audit data and aggregated report are public, links above.

Ninety-three percent is the number that looks good on a slide. Ninety-one out of a hundred is the number that actually taught me something.
