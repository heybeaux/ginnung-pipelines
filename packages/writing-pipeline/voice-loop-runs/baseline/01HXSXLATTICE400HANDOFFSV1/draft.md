# Multi-Agent Systems Fail 87% of the Time. I Ran 400 Real Handoffs Through a Coordination Layer. Here's What I Found.

I could lead with the 93% pass rate. That's the number that looks good on a landing page. Instead, here's the number that actually matters: 91 out of 100 L2 validations escalated to L3. My middle validation tier — the one I'd designed to be the workhorse, the cost-efficient semantic check that would catch drift without burning tokens on an LLM judge — was almost completely useless for creative pipeline steps. It waved through nearly everything or punted the decision upward. I didn't discover this by theorising about architecture. I discovered it by reading 400 lines of audit logs after running real handoffs through a coordination layer I built, in shadow mode, inside the production content pipeline that actually runs my shop.

That finding changed how I think about tiered validation, and it's the reason I'm writing this instead of just shipping a changelog.

---

Let me back up.

Multi-agent AI systems fail. A lot. The MAST paper at NeurIPS 2025 studied over 1,600 multi-agent traces and found failure rates up to 87%. The Runcycles study from March 2026 looked at production deployments specifically and landed at the same number — up to 87%. Talyx ran an enterprise study in 2026 and reported 80–90% failure rates. These aren't cherry-picked horror stories. They're the baseline.

Here's the part that should bother you more than the headline number: the MAST paper found that using better models improved success rates by less than 5%. Swapping in a stronger LLM barely moved the needle. The failures aren't happening because the models are too dumb. They're happening because the coordination between agents is broken — agents hand off malformed state, downstream agents accept it silently, and the pipeline returns 200 OK with garbage at the end. No crash. No error. Just confidently wrong output that looks fine until a human reads it.

Gartner predicts 40% of agentic AI projects will be cancelled by 2027. Right now, 80% of enterprise apps embed agents, but only 31% have anything running in production. The gap between "we added agents" and "agents do useful work" is enormous, and that gap is almost entirely a coordination problem.

I built Lattice to address this. It's an open-source coordination layer (MIT license) with three primitives: State Contracts, Circuit Breakers with tiered validation (L1/L2/L3), and Pipeline orchestration. State Contracts carry full lineage per action — inputs, decisions, outputs, constraints, assumptions — so every handoff between agents has an explicit, inspectable record of what was passed and why. The circuit breakers validate that handoff at up to three tiers before the next agent touches it. The pipeline orchestration wires the whole thing together. Lattice is framework-agnostic; it wraps any agent function whether you're running LangGraph, CrewAI, Mastra, or raw TypeScript/Python.

The three tiers work like this. L1 is JSON Schema validation — structural checks, no intelligence, sub-200ms, zero LLM calls. Did the agent return the fields the next agent needs? Are the types correct? Is the array non-empty? L2 is embedding similarity using text-embedding-3-small with a 0.85 cosine threshold, running at roughly 600ms. It checks whether the output is semantically consistent with what the state contract describes — a drift detector. L3 is LLM-as-judge using gpt-4o-mini with a 0.7 confidence threshold, taking about 25 seconds per call. It evaluates whether the output is actually good — not just present, not just on-topic, but qualitatively sufficient.

I designed these tiers with a clear mental model: L1 catches structural garbage, L2 catches semantic drift, L3 catches quality failures. Fast, medium, slow. Cheap, moderate, expensive. Each tier escalates to the next only when it can't make a confident determination. In theory, most handoffs would resolve at L1 or L2, and L3 would handle the hard cases.

The benchmark ran through my production content pipeline, Forge. Fifty documentation topics, five agent steps per topic (Research → Outline → Draft → Review → Format), 400 handoff validations total. Everything ran in shadow mode — every handoff produced a State Contract, was validated, and logged, but validation results didn't block the pipeline. I wanted honest data about what Lattice would catch, not a controlled demo where I could tune until it looked good. All 50 runs share traceable IDs. Total wall-clock time for the full benchmark: 1 hour and 43 minutes.

The topline: 93.0% pass rate. 372 of 400 handoffs validated successfully. Zero pipelines crashed. That's the number I could have shipped alone and looked great. Here's where it gets real.

---

L1 passed 100% of handoffs. Every single one. This makes sense — L1 is structural, and the agents in Forge are well-prompted enough to return valid JSON with the right fields. L1's job is to be a fast gate that catches the obvious stuff, and in a mature pipeline, the obvious stuff is already handled. L1 earned its keep not by catching failures but by costing nothing and confirming structure in under 200ms.

L2 is where things fell apart — not in a way that broke anything, but in a way that revealed my design assumptions were wrong.

Of the 400 handoffs, 150 were configured to skip L2 entirely (drafter, reviewer, and formatter steps). Of the remaining 250 that were eligible, 100 actually ran through L2. The L2 pass rate was 91.0% — 91 of those 100 escalated to L3 because L2 couldn't make a confident determination. Embedding similarity at a 0.85 threshold was almost useless for evaluating creative work. The research output and the outline were semantically related to the topic — of course they were — but "semantically similar to the expected output" isn't the same as "good enough to hand off." For steps where an agent is generating original prose, summarising research, or restructuring an argument, cosine similarity between the output embedding and a reference embedding tells you almost nothing. The output is on-topic. Great. Is it any good? L2 can't say.

This is the finding that matters. L2 catches drift — it can tell you when an agent has gone completely off the rails and started writing about something unrelated. But for creative steps, agents almost never go off the rails in that way. They go off the rails by being mediocre, repetitive, shallow, or structurally confused while staying perfectly on-topic. L2 can't see that. It's the wrong tool.

L3 handled the load. Of 241 L3 calls (including the 91 escalated from L2), 222 passed — a 92.1% pass rate. The confidence distribution was strikingly bimodal: 239 of 241 calls landed in the 0.8–1.0 confidence band. Only 2 of 241 fell in the uncertain 0.6–0.8 range. When L3 made a judgement, it was confident. There was almost no noise in the middle. This matters because it means L3 isn't agonising over borderline cases — the handoffs are either clearly good or clearly not, and L3 can tell the difference.

The per-step pass rates tell the rest of the story:

- **Research**: 78% (39/50) — the hardest step, where agents are synthesising external information and quality varies most
- **Outline**: 94% (47/50) — structural work, high pass rate
- **Drafter**: 87% (87/100) — creative generation, two drafting agents per topic
- **Reviewer**: 99% (99/100) — the agent that critiques the draft, almost always producing valid output
- **Formatter**: 100% (100/100) — mechanical transformation, never fails

Latency followed the tier structure as expected. L1 held under 200ms at mean and P95. L2 averaged 627ms with a P95 of 9.0 seconds and a max of 13.8 seconds — those tail cases are embedding API latency spikes, not computation. L3 averaged 25.4 seconds with a P95 of 63.2 seconds and a max of 110.2 seconds. The max L3 times are ugly for real-time use, but in a content pipeline running in shadow mode, they're acceptable. Each of the 50 runs produced 8 handoff validations on average, including escalations.

---

Mid-benchmark, after I saw the L2 escalation pattern in the logs, I added per-step L2 configuration. The correct setup turned out to be:

- **Research → Outline**: L1 + L2. The handoff is structural — did the research agent produce findings that are topically consistent with what the outline agent needs? Embedding similarity works here.
- **Outline → Draft**: L1 + L3. The handoff is creative — the drafter needs to turn an outline into prose. Only a judge can evaluate this.
- **Draft → Review**: L1 + L3. Same logic — the reviewer is making qualitative judgements about the draft.
- **Review → Format**: L1 only. The formatter is mechanical. If the schema validates, it's fine.

This is the configuration insight that fell out of the data: L2 is for structural-consistency steps, L3 is for creative steps, and they are not substitutes for each other. You can't save money by running L2 where you need L3. You'll just burn L2's latency budget and escalate anyway.

---

If you've ever worked with threading libraries — mutexes, semaphores, channels, the whole concurrent-programming toolkit — this should feel familiar. Sixty years of systems programming taught us that concurrency bugs aren't about the speed of individual threads. They're about what happens at the boundaries: race conditions, deadlocks, lost updates, silent corruption when two threads both think they own the same resource. Multi-agent coordination has the same problem in a different costume. The agents are fine individually. The handoffs are where everything breaks. State Contracts are the typed channels. Circuit breakers are the locks and condition variables. The coordination layer exists because the boundary is the failure mode, not the compute.

This is the thesis the data supports, and I want to state it plainly because the industry conversation keeps centering on model capability: coordination failures in multi-agent AI are architectural, not model-capability problems. The MAST paper showed that better models improved outcomes by less than 5%. My benchmark showed that 93% of handoffs pass when you validate them at the right tier — and that picking the wrong tier for a given step wastes time without improving outcomes. The fix isn't a smarter model. The fix is an explicit coordination layer that makes handoff state visible, validates it at the appropriate level, and logs everything so you can see what actually happened instead of guessing.

---

I want to be clear about what this benchmark is and isn't. It's 400 handoffs in a single content pipeline, run by one person's shop. It's not a controlled academic study with baselines and ablations. The 93% number doesn't mean Lattice will give you 93% in your pipeline — your agents, your prompts, your domain, your failure modes are different. What the data does show is that tiered validation with explicit state contracts can take the kind of pipeline that the literature says fails 80–87% of the time and make it work reliably, as long as you configure each tier for what it's actually good at. The L2 finding is the proof that configuration matters as much as architecture. I could have shipped a system with L1 → L2 → L3 for every step and reported a pass rate. It would have been slower, more expensive, and no more accurate than skipping L2 for creative steps entirely.

The full audit log — all 400 entries — is public at [github.com/heybeaux/ops](https://github.com/heybeaux/ops/blob/main/reports/lattice-shadow-audit-50topics-2026-05-08.jsonl). The aggregated report is at the same repo. Lattice itself is at [github.com/heybeaux/lattice](https://github.com/heybeaux/lattice), MIT licensed, with packages for TypeScript (`@heybeaux/lattice-core`, `@heybeaux/lattice-provider-openai`, `@heybeaux/lattice-adapter-mastra`) and Python (`lattice-langgraph`, merged).

I run heybeaux — a small dev shop where AI agents do real work in production. The agents are my teammates. The coordination layer exists because I needed it for my own pipelines before I needed it for anyone else's.

What's next: I'm building an observability dashboard — a web UI for the audit trail, so you can see handoff state, validation results, confidence distributions, and escalation patterns without grepping JSONL files. After that, I want to run this benchmark at larger scale, with more diverse pipelines, and publish the same level of raw data. The honest version, not the flattering version.
