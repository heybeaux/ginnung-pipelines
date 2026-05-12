1. **Voice constraint violation — "we" in title and body.** The brief title uses "We Ran 400 Real Handoffs" but the voice constraint says first-person singular only. The draft correctly fixes the title to "I Ran" but then slips in the body: "inside our own Forge pipeline" (forbidden item #1 & #3 reference), and "I run heybeaux — a small dev shop where AI agents do real work in production" is fine, but the GitHub link text says "github.com/heybeaux/ops" which isn't an issue — however the facts reference in paragraph 2 says "These aren't cherry-picked horror stories" using a second-person-adjacent construction that's fine, but check: "the part that should bother you more" is direct address, not a violation, just noting it's a tonal shift toward newsletter-bro voice.

2. **"Didn't move the needle" (paragraph 3).** Pure cliché. Replace with something concrete — "barely changed the outcome" or just lean on the actual number ("less than 5%") which already does the work.

3. **"Here's where it gets real" (end of topline section).** AI-tell / LinkedIn-post cadence. This is the "buckle up" move. Cut it or replace with something that actually sets up the L2 finding.

4. **"In a different costume" (concurrency analogy paragraph).** Cliché metaphor. The analogy to threading primitives is strong on its own; "same problem in a different costume" weakens it.

5. **Possible invented number: "91 out of 100 L2 validations escalated to L3" in the opener, but later the text says "91.0% — 91 of those 100 escalated."** These match internally, but confirm this figure is in the supplied facts. If the facts only supply the 93% topline and per-step breakdowns, this L2→L3 escalation count may be derived rather than supplied. If it's derived from the audit log, that's defensible — but the brief says "Do not invent benchmark numbers beyond those in facts[]," so this needs verification.

6. **"Let me back up."** Filler transition. The draft already has a section break doing the work. This reads as a podcast verbal tic. Cut the line and start directly with the MAST citation.

7. **"That's the number I could have shipped alone and looked great."** Followed two paragraphs earlier by "That's the number that looks good on a landing page." The same rhetorical move (teasing vanity metric, then undercutting it) is deployed twice. The repetition dilutes impact. Pick one location — the opener is stronger — and cut the second instance.

8. **"What's next" paragraph — no date hedging needed, but the phrasing "I want to run this benchmark at larger scale" + "The honest version, not the flattering version" ends on a vaguely self-congratulatory note.** "The honest version, not the flattering version" is the kind of line that signals virtue rather than demonstrating it — the entire post already demonstrates it. Cut the last sentence or replace it with something concrete about what "larger scale" means (how many handoffs, which pipeline types).

9. **Opener pacing.** The first paragraph is 137 words before a full stop that lets the reader breathe. The sentence beginning "I didn't discover this by theorising about architecture" launches a 45-word sentence that restacks three clauses. The information density is good but the syntactic density makes the hook harder to land. Break at least one of those long sentences.

10. **"Earned its keep" (L1 discussion).** Minor cliché — anthropomorphising a validation tier with a stock phrase. Low severity but worth swapping for something more precise, e.g., "L1 justified its slot in the tier by costing nothing and confirming structure in under 200ms."
