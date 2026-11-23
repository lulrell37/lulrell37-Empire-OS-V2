# Replacing OpenAI Whisper (`whisper-1`) — options compared

Prepared by worker #43, 2026-11-23. Research only: no server code was changed.
Prices and limits are from the vendors' own pages fetched today; where a figure comes from a third party it is marked.

## What the code needs today (`server/llm.js`)

All three calls POST to `https://api.openai.com/v1/audio/transcriptions` with `model=whisper-1`:

| Function | Used by | Needs |
| --- | --- | --- |
| `transcribe` | Telegram voice notes (~5–30 s) | `text`, `language=en`, `prompt` (persona names) |
| `transcribeSegments` | `[TRANSCRIBE]`, clip scan, raw edit (10-min chunks of multi-hour streams) | `verbose_json` → `segments[{start,end,text}]`, `prompt` |
| `transcribeWords` | clip captions, raw-edit captions | `timestamp_granularities[]=word,segment`, `temperature=0`, and per-segment `no_speech_prob`, `avg_logprob`, `compression_ratio` (the hallucination filter) |

The OpenAI-compatible shape (multipart `file`, `model`, `response_format`, `timestamp_granularities[]`, `prompt`) is what matters for a drop-in swap.

## Can a ChatGPT subscription be used? No.

OpenAI's help center says ChatGPT Plus does not include API usage: API usage is billed separately on an API account and is not covered by Plus ([help.openai.com — What is ChatGPT Plus](https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus)). A community thread says the same ([community.openai.com](https://community.openai.com/t/api-chatgpt-subscription-cannot-use-api-with-chatgpt-subscription/875542)). The current API price for `whisper-1` / `gpt-4o-transcribe` is **$0.006/min = $0.36/h** and `gpt-4o-mini-transcribe` is $0.003/min = $0.18/h ([OpenAI pricing](https://developers.openai.com/api/docs/pricing)). The baseline is $0.36 per audio hour.

## Options

| | Price per audio hour | Free tier / caps | Word + segment timestamps | Accuracy vs whisper-1 | Code change in `llm.js` |
| --- | --- | --- | --- | --- | --- |
| **OpenAI whisper-1** (today) | $0.36 | none | yes | baseline (large-v2) | — |
| **Groq `whisper-large-v3-turbo`** | **$0.04** (min bill 10 s/request) | Free tier, no card: 20 req/min, 2,000 req/day, 7,200 audio-s/hour, 28,800 audio-s/day (official rate-limits page lists these numbers; column mapping confirmed by a third-party guide, so check the account's Limits page); 25 MB/file free, 100 MB dev tier | yes — word and segment, `verbose_json`, segments carry `avg_logprob`, `compression_ratio`, `no_speech_prob` | Groq lists 12% WER (v3-turbo) vs 10.3% (v3); v3 family is generally ≥ whisper-1 | change URL, key and model only |
| **Groq `whisper-large-v3`** | **$0.111** | same free caps | same | best of the Whisper family | same |
| **faster-whisper on GitHub Actions** | $0 (repo is public → standard runners free; private would be $0.006/min) | 6 h job limit per run, 20 concurrent jobs on free plans | yes (word + segment + per-word probability) | large-v3-turbo ≈ v3 | big: new workflow, upload/download plumbing, async job model |
| **Deepgram Nova-3** (pre-recorded) | $0.26 mono; Whisper Large cloud $0.29 | $200 signup credit, doesn't expire | words with timestamps; no segment/`avg_logprob` | strong English, not Whisper | new response mapper, no `no_speech_prob` filter |
| **AssemblyAI Universal-2** | $0.15 | $50 signup credit | words with timestamps | strong | async (upload → poll), new mapper |
| **Cloudflare Workers AI whisper-large-v3-turbo** | $0.000513/min = **$0.031** | free daily Neuron allowance (not shown on model page) | `text`, `segments`, `vtt`; per-word not documented on the page | v3-turbo | different request/response shape (base64/array audio), small input limits |
| **Hugging Face Inference Providers** | provider pass-through | free users get no credits; PRO $2/month | n/a | n/a | not credible for hours of audio |

Sources: [Groq speech-to-text docs](https://console.groq.com/docs/speech-to-text), [Groq rate limits](https://console.groq.com/docs/rate-limits), [Deepgram pricing](https://deepgram.com/pricing), [AssemblyAI pricing](https://www.assemblyai.com/pricing), [Cloudflare model page](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/), [HF pricing](https://huggingface.co/docs/inference-providers/pricing), [GitHub Actions billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions).

## Real test: faster-whisper on a standard runner

Runner: 4 vCPU, 16 GB, Linux. `faster-whisper` 1.2.1, int8, CPU, `beam_size=1`, `word_timestamps=True`. Audio is the public Whisper-repo `jfk.flac` sample (11 s) and a 220 s loop of it (a synthetic, repetitive file, so only the speed is meaningful).

| Model | 11 s clip | 220 s | Real-time factor | Words found |
| --- | --- | --- | --- | --- |
| small.en | 1.2 s (RTF 0.11) | 117 s | 0.53 | 22 / 440 |
| large-v3-turbo | 7.3 s (RTF 0.66) incl. warm-up | 111 s | 0.50 | 22 / 440 |

Model download+load: turbo took 17.5 s the first time. Output was correct with per-word start/end/probability.

Reading: about **0.5× real time on 4 cores**, so 1 h of audio takes about 30 min and a 3 h stream about 90 min of runner time, before checkout, install and model download (~1–2 min). Splitting one stream into parallel jobs of 1 h each would bring a 3 h stream to ~35 min wall-clock. Caveats: the sample is synthetic and repetitive; real speech with music or crosstalk is slower; `vad_filter` would help. A 30 s voice note would take ~5 s of compute, but a workflow dispatch takes 20–60 s to even start, so voice notes can't use it.

Hand-off to Actions (not built): server uploads the chunk to a GitHub release or a worker-file endpoint, fires `repository_dispatch`, polls an issue comment for the result — the same pattern `server/workers.js` already uses. It works, but it adds minutes of latency and a lot of moving parts, and a free public-repo runner is a shared service with no SLA.

## Latency for his two cases

- **3 h stream:** whisper-1 today is 18 chunks sent in sequence. Groq turbo is 189–216× real time per Groq's docs, so the whole 3 h is a few minutes of API time; on the free tier it is paced by the 7,200 audio-s/hour cap (3 h = 10,800 s, so ~1.5 h of wall-clock, or no wait on the dev tier). Actions: ~1.5 h serial, ~35 min parallel. Deepgram/AssemblyAI: minutes.
- **30 s voice note:** Groq ~1 s (billed as 30 s). Deepgram ~1 s. Actions: unusable (dispatch latency alone).

## Estimated monthly cost

Assumptions (guessed from the code paths, not measured; no usage log was available to this worker):
- Voice notes: 20 a day × 30 s ≈ 5 h/month.
- Clip scans: up to 3 auto clips/day (`AUTO_CLIP_MAX_PER_DAY`) plus manual; assume 1 scan/day of a 1.5 h video ≈ 45 h/month. Caption passes (`transcribeWords`) on ~4 clips × 60 s per scan ≈ 2 h/month.
- `[TRANSCRIBE]` and raw edits: ≈ 8 h/month.
- **Total ≈ 60 audio hours/month.**

| Option | Monthly |
| --- | --- |
| OpenAI whisper-1 (today) | ~$21.60 |
| Groq turbo, paid | ~$2.40 (the 10 s minimum adds a few cents for voice notes) |
| Groq large-v3, paid | ~$6.70 |
| Groq free tier | $0 — 60 h/month is far under the 28,800 s/day (8 h) cap, but a single 3 h stream needs pacing, and a busy day can hit 429 |
| Cloudflare turbo | ~$1.90 (before free allowance) |
| Deepgram Nova-3 | ~$15.60, or free for ~12 months of this usage from the $200 credit |
| Actions | $0 |

Even at 3× this usage Groq turbo paid is about $7/month.

## Recommendation

**Primary: Groq `whisper-large-v3-turbo`** (free tier first, with a card on file for the dev tier as soon as 429s appear). It is the same Whisper model family; it supports exactly the parameters the code sends (`verbose_json`, `timestamp_granularities[]` word + segment, `prompt`, `temperature`); it returns the segment fields the caption hallucination filter uses; and it is ~9× cheaper than whisper-1 even when paid. If a task needs the best accuracy, `whisper-large-v3` at $0.111/h is still 3× cheaper than OpenAI. The persona-name `prompt` is supported, but v3-turbo reacts to prompts a bit differently, so check that "Ara" isn't heard as "Aura" (`fixNames` is already the safety net).

**Fallback: keep OpenAI whisper-1** as an automatic second step when Groq returns 429/5xx or is out of quota. It is already wired, so there is nothing to build, and it costs only when Groq fails. Second choice, if he wants a non-OpenAI fallback: Deepgram Nova-3 (the $200 credit covers about a year), but it needs a response mapper and has no `no_speech_prob`.

Not recommended: GitHub Actions (works and is free, but 0.5× real time, minutes of start-up latency, and an async hand-off for every call, and it can't serve voice notes); Hugging Face (no free ASR credits); Cloudflare (cheap, but the request shape differs and word timestamps aren't documented).

## What would change in `server/llm.js` (not done here)

1. One shared helper replacing the three inline `fetch`es: `base = process.env.GROQ_API_KEY ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1'`, model `whisper-large-v3-turbo` vs `whisper-1`; the multipart body is unchanged.
2. On 429/5xx/timeouts from Groq, retry once after `retry-after`, then fall back to OpenAI; log `transcription failed: …` so the sentinel sees it. The sentinel already watches AI keys for credit errors — add Groq.
3. Free-tier pacing: with the 7,200 audio-s/hour cap, `clipScan`'s 10-min chunk loop must wait on 429 (`retry-after`) rather than fail the scan, and the job progress shows the wait.
4. Keep chunks under 25 MB (10-min mp3 at 64 kbps is ~5 MB) and send audio ≥ 1 s so the 10 s minimum bill isn't wasted. Voice notes (OGG) are accepted as is.
5. Add `GROQ_API_KEY` to the server secrets; no app change, since the app doesn't call Whisper.
6. Verify before relying on it: Groq's page contradicts itself on whether word timestamps need `verbose_json` (the parameter table says yes), so run one real call and confirm `words` and the segment confidence fields come back. No Groq key was available to this worker, so this is untested.
