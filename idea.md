Yes — you should **not rely only on video URLs**. A browser-like layer is a strong idea, but it should be a **capture/access layer**, not the whole product.

The winning architecture should be:

**DescribeOps = AI audio-description pipeline + browser/video access layer + offline review/player mode.**

## Why URL-only is too weak

Not all videos can be reliably processed from a URL.

Many videos are behind logins, LMS portals, company intranets, private Google Drive links, TikTok/Instagram/YouTube embeds, HLS/DASH streams, expiring signed URLs, or platforms that block direct file download. Some videos are rendered inside web apps, not exposed as a clean `.mp4`. Some may also be copyrighted or DRM-protected, so you must avoid anything that looks like bypassing access controls.

That matters because XPRIZE requires authorized third-party integrations and original/non-infringing submissions, so your product should only process content the customer owns or has permission to make accessible. ([Build with Gemini XPRIZE][1])

## The better idea: “accessibility browser layer”

Do not build a full browser from scratch. Build a **browser extension or controlled web viewer** that can detect and assist with videos wherever the user is already watching them.

It should do four things:

| Mode                                  | What it handles                                                | Why it matters                                                          |
| ------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **URL ingest**                        | Public YouTube/Vimeo/direct video links                        | Fastest MVP path. Best for Qwen demo.                                   |
| **File upload**                       | MP4, MOV, WebM, lecture recordings, training videos            | Best for paying XPRIZE customers.                                       |
| **Browser extension / browser agent** | LMS, intranets, embedded players, private training portals     | Makes the product feel “universal” instead of just another upload tool. |
| **Offline review/player**             | Cached videos, generated AD, reviewer edits, low-bandwidth use | Strong accessibility and enterprise/privacy story.                      |

This makes the product more defensible: competitors can copy “upload a video and generate description,” but a browser-level accessibility workflow is closer to infrastructure.

## Should it be browser-like?

**Yes, but narrowly.**

The browser layer should not be pitched as “a new browser.” That sounds too broad and risky. Pitch it as:

**“A permissioned browser agent that detects video, extracts accessible context, and overlays AI-generated audio description when no official audio-description track exists.”**

That is stronger for Qwen because the hackathon rewards sophisticated agents, multimodal workflows, human-in-the-loop checkpoints, and production-grade architecture. The Qwen Autopilot Agent track explicitly asks for agents that automate real-world workflows, handle ambiguous inputs, invoke tools, and include human checkpoints. ([AI Hackathon Series][2])

For XPRIZE, this also helps because the business is not just “AI content generation.” It becomes an AI-operated accessibility service that can work across customer video libraries, learning systems, internal portals, and public content. XPRIZE judges are looking for real businesses with users, revenue, AI-native operations, and category impact. ([Build with Gemini XPRIZE][1])

## Should there be offline support?

**Yes, but limited at first.**

Do not try to run the whole AI pipeline offline for the MVP. That will slow you down and conflict with the fact that Qwen Cloud and Gemini API usage are required or strategically important for the two hackathons. Qwen requires use of Qwen models on Qwen Cloud, and XPRIZE requires Gemini API use for at least one LLM call if the project includes LLM functionality. ([AI Hackathon Series][2]) ([Build with Gemini XPRIZE][1])

Build **offline support as resilience**, not as full offline generation.

Offline v1 should support:

* Downloading/caching already-generated audio descriptions.
* Playing video + AD without internet after processing.
* Letting reviewers edit descriptions offline and sync later.
* Queuing videos for processing when connection returns.
* Local TTS fallback for already-generated scripts.
* Low-bandwidth mode that samples fewer frames before cloud processing.

That is enough to say: **“DescribeOps works in weak-connectivity classrooms, workplaces, and field training environments.”**

Do not claim: **“All AI generation works offline.”**

## What I would build for each hackathon

### Qwen Cloud MVP

Build the browser/agent version because it is technically impressive.

Demo flow:

1. User opens a web page with an embedded video.
2. Browser extension detects the video.
3. Qwen agent extracts title, transcript/audio, sampled frames, visible text, and timing gaps.
4. Agent society creates AD candidates.
5. QA agent flags hallucination risk, missed on-screen text, overlap with speech, and timing problems.
6. User plays the video with an AD overlay.
7. Reviewer edits one line; memory stores that preference for future descriptions.

This maps well to Qwen’s judging criteria: technical depth, AI creativity, real-world impact, and clear demo/documentation. ([AI Hackathon Series][2])

### XPRIZE business product

Build the upload/API/customer workflow first, then show the browser layer as the moat.

Business flow:

1. A university or company uploads a training video library.
2. DescribeOps quotes the job automatically.
3. AI generates descriptions.
4. Risky segments go to human or BLV review.
5. Customer receives AD track, WebVTT, transcript notes, and compliance report.
6. Browser extension/player lets end users consume AD across LMS or internal portals.

The uploaded research supports this positioning: the core problem is not that audio description is impossible; it is that manual AD is too expensive and slow at internet scale, so the strongest answer is hybrid AI + human review with better publishing, metadata, and discoverability. 

## Final product positioning

Use this framing:

**DescribeOps is a universal AI accessibility layer for video. It can process videos by URL, upload, API, or browser extension; generate timed audio description; route uncertain moments to human review; and deliver accessible playback online or offline.**

That is much stronger than “AI audio-description generator.”

The MVP should prioritize:

**Qwen:** browser agent + multimodal pipeline + QA + reviewer memory.
**XPRIZE:** paying customers + upload/API workflow + revenue + browser layer as expansion path.

[1]: https://xprize.devpost.com/rules "Build with Gemini XPRIZE: $2,000,000 in prizes. Build with Gemini. Ship products that impact the world. - Devpost"
[2]: https://qwencloud-hackathon.devpost.com/ "Global AI Hackathon Series with Qwen Cloud : Build your own AI Agent on Qwen Cloud - compete for $70K in prizes across five tracks. - Devpost"
