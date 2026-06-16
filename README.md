# Competitive Benchmarker (T031)

An Athlete Site Pixie (Tool Registry T031). A parent enters their name, email, the athlete's sport, event/position, key metric, and graduation year, and gets an honest read on where that number maps against real D1/D2/D3/NAIA recruiting standards: the division level it reaches, the gap to the next level up, and how coaches actually use the number. Every run captures a lead in Supabase, emails the parent their card, and fires an internal notification. Static page plus two Netlify Functions, so it scales to zero.

Forked file-for-file from T030 Scholarship Reality; only the engine, inputs, and card output changed.

The standards are **deterministic** from sourced tables (current 2025-26, pulled live at build from NCSA scholarship/recruiting-time pages and recruiting-service combine tables). Claude Haiku only writes the three narrative reads around the matched numbers; if the model call fails, templated reads are used so the tool never hard-fails. No web search, so cost and timeout risk are near zero.

## What's where

- `index.html` — the tool people use (sport -> event -> mark -> grad year)
- `report.html` — the shareable result card, with Download-as-PNG; reached at `/report.html?t=TOKEN`
- `netlify/functions/benchmark.js` — runs a report: validate, Turnstile, compute, Haiku reads, save to Supabase, email parent + notify you
- `netlify/functions/get-report.js` — reads one saved card by its token
- `supabase.sql` — the leads/results table (`benchmark_reports`)

## Sports & events in v1

- **Track & Field** — men's and women's 100/200/400/800/1600/3200, 110/100m hurdles, 400m hurdles, long jump, high jump, shot put. Cleanly measurable; benchmarked directly.
- **Swimming (SCY)** — men's and women's 50/100/200/500 free, 100 back/breast/fly, 200 IM. Division bars derived from NCSA recruiting-time tiers.
- **Football** — 40-yard dash by position (QB, RB, WR, OL, DL, LB, DB), with typical height/weight shown for context. Film and projectability outweigh raw numbers below FBS, and the card says so.

Subjective/team sports are intentionally out of v1; they belong on a "needs a coach's eye" path rather than a fake number.

## Setup (one time)

Reuses the existing `online-report-card` Supabase project (shared with T028/T030), so `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are already valid — the `benchmark_reports` table is already applied live.

### Netlify
1. Add a new site from this GitHub repo (the one manual OAuth step). Build settings come from `netlify.toml`.
2. Site configuration -> Environment variables:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic key (copy from the T030 site; omit to use templated reads) |
| `SUPABASE_URL` | the shared Project URL (copy from T030) |
| `SUPABASE_SERVICE_KEY` | the shared service_role key (copy from T030) |
| `TURNSTILE_SECRET` | a fresh Turnstile widget Secret key for this domain (verification skipped until set) |
| `DAILY_CAP` | e.g. `200` |
| `RESEND_API_KEY` | your Resend key — masked, must be pasted once (email skipped until set) |
| `EMAIL_FROM` | `Athlete Site <reports@rerev.io>` |
| `EMAIL_REPLY_TO` | `keyona@rerev.io` |
| `LEAD_NOTIFY_TO` | `keyona@rerev.io` |

3. In `index.html`, replace `YOUR_TURNSTILE_SITE_KEY` with the new widget's Site key.
4. Deploy. Env var changes only take effect on a new deploy.

## How the emails work
- The **parent** gets a clean-subject email: "{First}, where your athlete stands," with a link to their card.
- **You** get a second email on every lead, subject `[T031 · Competitive Benchmarker] New lead - {name}, {event} {mark}`, so every Pixie sorts itself in your inbox.

## Guards in place
All secrets server-side; required name + email gate; Cloudflare Turnstile; daily cap + per-IP rate limit (4 / 10 min); 30-day result cache (same email + event + mark); server-side validation + HTML-escaped rendering; shareable pages keyed by an unguessable token; leads table private behind RLS.

## Notes
- Standards are recruiting benchmarks, not guarantees; the card carries a "confirm with coaches" line and notes that coaches weigh trend, competition, and film.
- Engine swap vs T030: deterministic benchmark tables + a metric-to-division placement engine instead of the scholarship-money tables. Everything else mirrors the chassis.
