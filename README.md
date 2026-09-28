# Rubo

**Rubo** is a self-hosted financial-research agent. It lives in your terminal and your Telegram, and it does the work of a junior analyst: pulling live data across **84 tools**, citing every claim, running a multi-agent debate on high-conviction trades, and remembering your portfolio between sessions.

What separates it from a chatbot with a stock API is the **grading engine**: every company gets a deterministic **0-100 score on two horizons** — 1-3 years and 20+ years — computed in code from a fixed factor set, so the same inputs give the same number in March and in September. Grades are written to a ledger with the price at the time, which turns a stream of opinions into a track record you can check.

Ships configured for **MiniMax M2.5**, and wired to 10 LLM providers (OpenAI · Anthropic · Google · xAI · DeepSeek · Moonshot · OpenRouter · MiniMax · FreeLLMAPI · Ollama) so you can pick the right model per query type.

---

## Table of Contents

- [What it does](#what-it-does)
- [Investment grading](#investment-grading)
- [Architecture](#architecture)
- [Tool inventory](#tool-inventory)
- [Skills](#skills)
- [Subagent system](#subagent-system)
- [Channel profiles](#channel-profiles)
- [Memory + portfolio](#memory--portfolio)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Run](#run)
- [Jev judgement layer](#jev-judgement-layer)
- [Slash commands](#slash-commands)
- [Evaluate](#evaluate)
- [Debug](#debug)
- [Telegram gateway](#telegram-gateway)
- [Deploying as a service](#deploying-as-a-service)
- [Provider health check](#provider-health-check)
- [Cost model](#cost-model)
- [Third-party data attribution + licenses](#third-party-data-attribution--licenses)
- [License](#license)
- [Disclaimer](#disclaimer)

---

## What it does

Rubo takes a question like *"is NVDA cheap relative to peers given the AI capex cycle?"* and runs an end-to-end research workflow:

1. **Plans** — picks the right tools (equity quotes? financials? news? filings?) and issues them in parallel where independent.
2. **Sources** — pulls from **84 financial tools** covering US equities, global equities across ~66 exchanges, crypto, FX, commodities, macro (FRED, World Bank, ECB, BIS), real estate, SEC filings, news from 4 providers, and on-chain crypto.
3. **Cross-checks** — when providers disagree, it surfaces both. Every data point carries a freshness stamp (`Polygon · 14:32 UTC`) and a numbered citation.
4. **Argues** — for any high-conviction trade it spawns a 4-specialist debate (bull / bear / quant / macro) and a judge subagent that synthesizes a structured `Decision · Conviction · Time horizon`.
5. **Grades** — scores the company 0-100 on both a 1-3 year and a 20+ year horizon from a fixed, weighted factor set, and records the grade so later runs report what *changed*.
6. **Remembers** — your portfolio, risk tolerance, prior trades, and stated rules live in `.rubo/` and are auto-injected into every system prompt.

The output is **opinionated, source-cited, falsifiable** — it leads with the answer, attaches citations to every claim, and includes bear-case risks for any recommendation. The agent is **explicitly permitted to disagree with the user's priors** and to call out weak theses.

---

## Investment grading

`grade_ticker` returns two scores and the full factor breakdown behind them. The
arithmetic is in `src/scoring/factors.ts` and runs in code, never in the model —
a grade is only useful if it is reproducible.

**Short horizon (1-3 years)** asks *will this re-rate?*

| Factor | Weight |
|---|---|
| Valuation vs its own history | 18 |
| Revenue growth (TTM YoY) | 12 |
| EPS growth (TTM YoY) | 12 |
| Balance-sheet safety | 12 |
| Growth-adjusted price (PEG) | 10 |
| Margin direction vs 5y average | 10 |
| 12-month price momentum | 10 |
| Relative strength vs S&P 500 | 8 |
| Current return on equity | 8 |

**Long horizon (20+ years)** asks *will this still compound?*

| Factor | Weight |
|---|---|
| Return on invested capital, through the cycle | 16 |
| Operating-margin durability | 12 |
| Balance-sheet survivability | 12 |
| Free-cash-flow conversion | 10 |
| Reinvestment and compounding runway | 10 |
| Behaviour through past crises | 10 |
| Consistency of returns on capital | 8 |
| Capital allocation | 8 |
| Valuation vs its own history | 8 |
| Length of the public record | 6 |

Each horizon's weights sum to 100 and are **renormalised over the factors that
actually had data**, so a missing input costs `coverage` rather than silently
scoring zero. Below 60% coverage the grade is thin and says so.

Sanity check on real data: AAPL long 71 (mean ROIC 34.6% over 20y), MSFT 84,
KO 60, Ford 24 (payout 475%, FCF margin 6.1%).

```bash
# one company, both horizons
grade_ticker { ticker: "MSFT" }

# the whole universe, ranked, diffed against last run, holdings reviewed
investment_report { horizon: "long", top_n: 10 }

# did the high grades actually outperform?
score_history { action: "calibration", horizon: "long" }
```

Grades append to `<rubo>/scores/<TICKER>.jsonl` with the price at grade time.
That ledger is what makes the periodic review a **diff** instead of a fresh
opinion, and what lets `calibration` eventually say whether the scoring works.

**Horizon note:** fundamental grading is US-listed only on the free data tiers.
A cross-listed ticker resolves to its US line automatically (`SAP.DE` → `SAP`)
and the result says so; one without a US line names the ADR to use instead.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Rubo CLI/Telegram                                              │
│   • pi-tui terminal UI (themeable, source chips, watchlist,        │
│     command palette, status bar, cost-cap overlay, diff viewer)    │
│   • Slash commands (/model /theme /cost /watch /run_debate …)       │
└──────────────────┬───────────────────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
   ┌────▼────┐         ┌─────▼──────┐
   │  Agent  │ ──────▶ │ Subagents │ (bull / bear / quant / macro / judge)
   │  loop   │         │           │
   └────┬────┘         └───────────┘
        │
   ┌────▼───────────────────────────────────────┐
   │  84 tools                                  │
   │   • Meta-tools (router)                    │
   │   • Leaf tools (per-provider)              │
   │   • Skills (multi-step workflows)          │
   └────┬───────────────────────────────────────┘
        │
   ┌────▼───────────────────────────────────────┐
   │  Providers (env-gated, all disk-cached,    │
   │  freshness-stamped, numbered citations)    │
   │   FinancialDatasets · Polygon · Finnhub ·  │
   │   FMP · Alpha Vantage · TwelveData ·       │
   │   Tiingo · EODHD · CoinGecko · CMC ·       │
   │   FRED · World Bank · ECB · RentCast ·     │
   │   Realtor · NewsAPI · Marketaux · Benzinga │
   └────────────────────────────────────────────┘
```

Key design choices:
- **Single-pass tool execution per turn** — the agent loop calls multiple tools in parallel when independent (via `Promise.all`), then merges results with numbered citations.
- **Per-provider disk cache** — `callProvider({ provider, endpoint, params, url, ttlMs })` keys by provider + endpoint + sorted params. Reduces API quota burn for repeat queries.
- **Provider fallback chains** — `withProviderFallback([Polygon, Finnhub, FMP, …])` for the meta-tools. Polygon rate-limits you? The next provider picks up.
- **Multi-region normalization** — non-US tickers use `TICKER.EXCHANGE` notation (`VOD.LSE`, `SAP.XETRA`, `PETR4.SA`, `NPN.JSE`). Prices are tagged with local currency, including the sub-unit venues that quote in pence (`GBp`) and cents (`ZAc`). The exchange table is generated from the provider's own list and verified ticker-by-ticker, not hand-written.

---

## Tool inventory

84 tools, all env-gated. With zero env keys set, only the system tools (memory, filesystem, browser, scheduling, subagents, skills) are available.

### Core meta-tools (always available)

| Tool | What it does |
|---|---|
| `get_financials` | NL → financial-statement fetcher. Routes to the best of 7 income/balance/cash-flow providers based on the query (FMP preferred for US, EODHD for global). |
| `get_market_data` | NL → price/news/insider fetcher. Routes across 8 quote providers, 3 crypto providers, 4 news providers with preference order. |
| `read_filings` | SEC 10-K / 10-Q / 8-K with item-level extraction. |
| `stock_screener` | NL → structured screener filters (PE, growth, margins, sector). |
| `get_news` | Routes ticker-specific news to Marketaux/Benzinga; broad topic to NewsAPI. |
| `get_global_stock` | Non-US tickers via EODHD with local-currency normalization. |
| `get_catalyst_calendar` | Upcoming earnings + EPS/revenue estimates (FMP → Finnhub fallback). |
| `get_commodity` | Oil/BRENT/NatGas/copper/wheat/etc. via Alpha Vantage + FRED fallback. |
| `get_fx_rates` | ECB/Frankfurter. No key required. |
| `get_economic_indicators` | World Bank. No key required. |
| `get_fred_series` | US Fed funds, Treasury yields, CPI, unemployment, GDP. |

### Leaf tools (one per provider, env-gated)

| Provider | Coverage |
|---|---|
| `polygon_stock_snapshot`, `polygon_stock_aggregates`, `polygon_forex_snapshot` | US stocks real-time + EOD |
| `finnhub_quote`, `finnhub_company_profile`, `finnhub_peers`, `finnhub_recommendation`, `finnhub_sentiment`, `finnhub_earnings_calendar`, `finnhub_insider_transactions`, `finnhub_insider_sentiment`, `finnhub_symbol_search` | Analyst sentiment, earnings, SEC Form 4 insider trades, name-to-ticker lookup |
| `fmp_company_profile`, `fmp_ratios`, `fmp_dcf_valuation`, `fmp_income_statement`, `fmp_balance_sheet`, `fmp_earnings_calendar`, `fmp_stock_screener`, `fmp_earnings_surprises`, `fmp_price_target` | Fundamentals + DCF + analyst targets |
| `alphavantage_stock_quote`, `alphavantage_stock_time_series`, `alphavantage_fx_rate`, `alphavantage_crypto_rating`, `alphavantage_commodity` | Equities, FX, crypto, commodities |
| `twelvedata_time_series`, `twelvedata_quote`, `twelvedata_fx_rate` | Global equities + FX |
| `tiingo_eod_prices`, `tiingo_fundamentals` | US EOD + fundamentals |
| `eodhd_eod_prices`, `eodhd_fundamentals` | Global (TICKER.EXCHANGE) |
| `coingecko_simple_price`, `coingecko_markets`, `coingecko_global_metrics` | Crypto |
| `cmc_listings`, `cmc_quotes`, `cmc_global_metrics` | Crypto (alt) |
| `rentcast_rent_estimate`, `rentcast_value_estimate` | US real estate |
| `realtor_properties_for_sale` | US real estate listings |
| `newsapi_everything`, `marketaux_news`, `benzinga_news`, `benzinga_analyst_ratings` | News + analyst upgrades/downgrades and price-target revisions |

### System tools

`memory_search`, `memory_get`, `memory_update`, `cron`, `heartbeat`, `spawn_subagent`, `run_debate`, `ask_user_question`, `web_search`, `web_fetch`, `browser`, `read_file`, `write_file`, `edit_file`, `skill`, plus 5 **portfolio tools** (`portfolio_view`, `portfolio_add`, `portfolio_remove`, `portfolio_journal`, `portfolio_set_risk`).

---

## Skills

Multi-step workflows invoked via the `skill` tool. Each is a `SKILL.md` with YAML frontmatter and a numbered workflow checklist.

| Skill | When it triggers |
|---|---|
| `dcf-valuation` | "fair value", "intrinsic value", "what is X worth", price target |
| `comps-valuation` | "comps", "peer multiples", "trading multiples", relative value |
| `ddm-valuation` | "DDM", "dividend discount", utilities/REITs/MLPs |
| `reverse-dcf` | "implied growth", "what does the market think", reverse-engineering consensus |
| `earnings-preview` | "earnings preview", "what to expect", within 4 weeks of print |
| `position-sizing` | "how much should I buy", "Kelly", "size this" — always reads portfolio_view first |
| `trade-review` | Closed-trade post-mortem; hit rate + profit factor + lessons |
| `macro-regime` | "what regime are we in" — goldilocks/reflation/stagflation/recession classification |
| `write-memo` | "write a memo", "long writeup" — buyside-style HTML memo |
| `x-research` | X/Twitter sentiment research |

---

## Subagent system

6 subagent types; the leader spawns them via `spawn_subagent` (single, parallel) or `run_debate` (structured 4-specialist + judge).

| Type | Job |
|---|---|
| `general-purpose` | Multi-step research / analysis on a focused sub-task |
| `research` | Web/news/filings synthesis with cross-checks |
| `analysis` | Quantitative financial analysis on specific companies |
| `devils-advocate` | Stress-test a thesis by falsifying load-bearing claims |
| `macro-overlay` | Pull FRED + FX + sector data, write 150-250 word macro block |
| `judge` | Read 4 specialist outputs, synthesize into `Decision · Conviction · Time horizon` |

Subagents are **isolated** (no main-conversation context, no further delegation), **read-only** by default (no `write_file` / `edit_file`), and have capped iteration budgets (4-8).

---

## Channel profiles

The agent adapts its response format per delivery channel.

| Channel | Style |
|---|---|
| CLI | Compact, lead with the answer, markdown tables OK, citations inline |
| Telegram | Casual texting tone, no headers, no tables, short paragraphs |

When the user enables another channel, set `channel` in the `AgentConfig` — the system prompt pulls the matching profile.

---

## Memory + portfolio

Three persistent stores under `.rubo/`:

| File | Format | Purpose |
|---|---|---|
| `memory/MEMORY.md` | Markdown | Long-term preferences, facts about the user |
| `memory/YYYY-MM-DD.md` | Markdown | Daily notes |
| `portfolio.json` | JSON | Open positions, closed history, journal, risk profile |

The **portfolio store** tracks thesis + conviction + target + stop per position; closed positions record realized P&L + lesson. The system prompt auto-injects a compact portfolio summary so the agent always knows your book without spending a tool call.

---

## Prerequisites

- [Bun](https://bun.com) runtime v1.0+
- A working internet connection (most data sources are HTTP)
- At minimum one LLM API key — see [LLM Providers](#llm-providers)
- (Optional) One or more data provider keys — see [Data providers](#data-providers)

---

## Install

```bash
git clone https://github.com/iamvazghen/rubo.git
cd rubo
bun install
cp env.example .env
$EDITOR .env   # fill in your keys
```

The first run will prompt for any missing keys.

---

## Run

```bash
npm start                 # interactive CLI (Node)
npm run dev               # watch mode for development
rubo                      # same, from any folder, once scripts/bin is on PATH
```

The interactive CLI runs on Node, not Bun: Bun on Windows never reports a terminal resize, so the layout could not follow the window. Tests still run with `bun test`.

### Sessions

Every conversation is saved and can be continued later, from the CLI or from Telegram. A session id says where it started and when, in your local time (`/setup timezone`, default: the machine's zone):

```
cli:2026-09-28_14-05-12
telegram:2026-09-28_18-40-03
```

| Where | Command | What it does |
|---|---|---|
| CLI | `rubo --resume [id]` | Start by continuing a session (the latest if no id) |
| CLI | `/sessions`, `/resume [id]` | Pick a session, or continue one by id |
| CLI | `/new` (or `/clear`), `/session` | Start a new session, show the current one |
| Telegram | `/sessions` | List saved sessions from both surfaces |
| Telegram | `/resume <id>`, `/new`, `/session` | Continue one, start a new one, show the current one |

Telegram sessions are saved on the machine that runs the gateway (your server), CLI sessions on your computer. With `RUBO_VPS=user@host` set, the CLI keeps both in step by itself: it syncs when it starts, before `/sessions` and `/resume`, and after every answer or finance command. Sessions, holdings, income plan, tax settings and targets take part; per file, the newer copy wins, and a session continued on both sides keeps the turns from both. Set `RUBO_AUTOSYNC=0` to turn it off. `rubo pull` / `rubo push` still copy everything by hand, including memory and scores.

### Holdings, income and rebalancing

Answered by code, identically in the CLI and on Telegram. Nothing in it is tied to one person: your country, brokers, currency, holdings, income plan and targets are all settings, so a fork works for anyone. Start with `/setup`, which lists what is set and what is missing:

```
/setup currency EUR                 # every amount is reported in this (default USD)
/setup timezone Europe/Paris        # reminder times and session ids
/import holdings.csv degiro         # any broker; the last word names the account
/tax set residence FR               # built-in rules: DE, AT
/tax set flat_rate 30%              # anywhere else: your own flat rate
/tax set degiro.w8ben yes           # per account: w8ben, domestic, allowance
/yieldplan set reinvest 70 withdraw 30
/targets set stock 70 etf 30
```

Sample exports with made-up holdings are in [`examples/`](examples/): an IBKR Activity Statement, a Trade Republic transaction list and a plain holdings table in four currencies. Import one to try everything without real data.

| Command | What it does |
|---|---|
| `/setup [currency X \| timezone Area/City]` | Your settings as a checklist |
| `/import <file.csv> [account]` (CLI) or send the CSV to the bot | Preview holdings from an **IBKR** Activity Statement, or any holdings or transactions table with ISIN or symbol and quantity columns (Trade Republic, DEGIRO, Scalable, …; English or German headers); nothing is saved until `/import confirm` |
| `/income [refresh]` | Dividends, distributions and coupons due in the next 90 days, gross and net |
| `/yieldplan` | Your plan for each payment: reinvest / cash reserve / withdraw / another asset (default 40/30/20/10, per-holding overrides) |
| `/done <id>` | Record a payment as handled: reserve, allowance used and reinvested shares are updated |
| `/reserve` | Balance of the down-market cash reserve |
| `/tax` | Tax residence, filing, jurisdiction options, per-account W-8BEN / domestic broker / allowance assigned, allowance left |
| `/judgements` | How well Jev's dividend-cut probabilities matched what happened ([details](#jev-judgement-layer)) |
| `/targets`, `/rebalance [cash N]` | Target weights (per holding, asset type, region or sector), band, minimum trade and fees; the tax-aware trades that bring holdings back into band, with the weights before and after |

How it works:

- **Listings.** Each ISIN is looked up on Yahoo and [OpenFIGI](https://www.openfigi.com/) (all exchanges; `OPENFIGI_API_KEY` optional). A symbol named in the export wins; otherwise the listing on an exchange that trades in the holding's currency, and one built from OpenFIGI only after Yahoo confirms it has a price.
- **Calendar.** Announced dates and amounts come from Yahoo; later payments are projected from each holding's payment rhythm and marked *estimated*. Bond coupons come from terms you enter on the position.
- **Tax** (estimates, labelled as such). Source withholding by issuer country (US 15 % with a W-8BEN, 30 % without; none for a resident of the issuer's country; IE/LU funds paid gross). Residence tax comes from `src/income/jurisdictions.ts`:
  - **DE**: Abgeltungsteuer 25 % + Soli (+ `church_tax_rate` 0.08/0.09), foreign tax credited up to 15 %, the €1,000/€2,000 allowance split across brokers (`<account>.allowance`), 30 % Teilfreistellung for equity funds.
  - **AT**: KESt 27.5 %, foreign tax credited up to 15 %.
  - **Anywhere else**: your own `flat_rate`, `allowance`, `credit_cap_rate`, `fund_exemption_pct`, `broker_withholds` via `/tax set`. With no residence set, only withholding is shown, and every figure says so.

  A domestic broker that withholds takes the tax at payment; otherwise it is due with your return and is set aside before your plan is applied. To add a country, add an entry to `jurisdictions.ts` with a test.
- **Reminders.** A nightly job (06:30 your time, on the gateway) refreshes the calendar and schedules two Telegram messages per payment: before the ex-date, and on the pay date with your plan already worked out. The numbers are computed and sent verbatim, never generated.
- **Rebalancing.** New cash and the reinvested part of income due in 30 days go to underweights first; only then are overweights sold, with the tax on the gain and the broker's fees estimated (`/targets fee 1 0.1`: a fixed amount plus a percentage per trade; fees also reduce the taxable gain). Sales are taxed on the oldest purchases first (FIFO), as German brokers must, whenever the holding came from a transaction export that lists them; otherwise on the average cost, and the reply says which. Targets can be per holding, asset type, region or sector: regions and sectors of companies come from Yahoo's company profile, funds are tagged by you (`/targets tag VT region world`). A quarterly job alerts only when something leaves its band. Rubo never places trades.
- **Jev** (optional). Probabilities for questions that are judgement, not arithmetic: will this dividend be cut, does the thesis still hold, does this news matter. See [Jev judgement layer](#jev-judgement-layer).

The gateway sends the reminders, so the server must know your holdings: import through Telegram, or import in the CLI (synced automatically with `RUBO_VPS` set, otherwise run `rubo push`). The launcher finds its checkout from its own location (or `RUBO_REPO`); `pull`, `push`, `vps` and `logs` need `RUBO_VPS=user@host`, and `RUBO_VPS_HOME` / `RUBO_VPS_UNIT` if your server does not use `~/.rubo` and `rubo-gateway`.

The CLI launches a TUI with a banner, status bar (model · tokens · cost · iter · t/s), command palette (`Ctrl+P`), watchlist sidebar, and input area. Slash commands are auto-completed.

---

## Jev judgement layer

[Jev](https://typesafe.ai) (TypeSafe System One) answers typed questions about a piece of state with calibrated probabilities. Rubo uses it for the few questions that are judgement rather than arithmetic. It is optional: without `TYPESAFE_API_KEY` in `.env`, the three tools below are not offered to the model and reminders simply omit the cut risk. Everything else works the same.

**What Jev may and may not do.** Jev adds a probability next to a result. It never changes a grade, a tax figure, an allocation or any other computed amount, and it is never asked to predict a price. The model must present its answers as probabilities ("Jev puts the chance of a cut at 29 %"), not as facts.

**How it is called.** Every request goes through one function, `judge()` in `src/judge/jev.ts`:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
{ "model": "jev-latest", "state": { …facts… }, "questions": { "<id>": { "type": "noul" | "choice" | "score", "instructions": "…", "criteria": … } } }
```

- `noul` returns the probability that a statement is true, `choice` picks one of named options (with a probability for each), `score` places the state on an ordered list of criteria.
- `state` holds only facts Rubo already has (Yahoo fundamentals, your stored thesis, the evidence or news the model gathered). Jev reasons over that and nothing else.
- Answers are cached per question and subject (a day by default, a week for dividend safety), so a nightly refresh does not pay twice.
- A failed call, a timeout (60 s) or a missing key returns nothing, and Rubo carries on without the judgement.
- Every answer is appended to `.rubo/judgements.jsonl` with its date, model version and token usage, so judgements can later be scored against what happened, the same way grades are.

**Where it is used.**

| Tool / place | Question asked | State given to Jev |
|---|---|---|
| `dividend_safety` | Will the company cut or suspend its dividend within 12 months? (`noul`) | Payout ratio, free-cash-flow cover of the dividend, debt/equity, earnings and revenue growth, yield vs its 5-year average |
| `thesis_check` | Is the thesis for this holding still intact? (`noul`), and does the new evidence strengthen, not change or weaken it? (`choice`) | The stored thesis, opening date, conviction, and the new evidence |
| `news_materiality` | Would this news plausibly change an investor's decision? (`noul`), and which direction? (`choice`) | The news item and the stored thesis |
| Income reminders | The `dividend_safety` question, for dividends paid in the next 45 days | As above; the reminder mentions it only at 20 % or more |
| `run_debate` | Will the thesis hold over its horizon? (`noul`), and which side made the better-supported case: bull, bear or neither? (`choice`) | The four specialists' views and the judge's synthesis (each cut to 4,000 characters); returned as `jev_verdict` next to the synthesis |
| Monthly thesis check (15th, 09:00 your time) | `thesis_check` for every holding with a real thesis, on the month's results and news the agent gathers | Reports only theses in doubt (intact below 50 % or weakening) and holdings still carrying the import placeholder thesis; silent otherwise |

Example ledger line:

```json
{"at":"2026-09-28T16:38:38Z","kind":"dividend_safety","subject":"KO","model":"jev-1.13.0","usage":{"input_tokens":648,"output_tokens":20},"answers":{"cut":{"type":"noul","noul":0.29}}}
```

**Is it any good?** `/judgements` scores Jev against what happened. A dividend-cut probability resolves a year after it was given: the payment history says whether the dividend was cut or suspended. The Brier score (mean squared error of the probability; lower is better) is shown next to the score of always guessing the observed base rate. Repeated weekly calls on the same company count once a month. Thesis, news and debate judgements have no automatic outcome, so they are counted, not scored.

A judgement is only as good as its state: a year with an unusually low free cash flow (a one-off tax payment, say) raises the cut probability even for a long-standing payer. Read it together with the fundamentals it was given, which `dividend_safety` returns alongside the probability.

---

## Slash commands

| Command | What it does |
|---|---|
| `/model` | Switch LLM provider and model |
| `/search` | Choose preferred web search provider |
| `/theme` | Switch color theme (emerald · sapphire · amethyst · obsidian) |
| `/rules` | Show research rules |
| `/clear` | Clear the conversation |
| `/memory` | Show what Rubo remembers about you |
| `/history` | Show recent conversation summaries |
| `/sessions` / `/resume` | List / resume saved sessions |
| `/palette` | Open the fuzzy command palette (also `Ctrl+P`) |
| `/providers` | Show which roadmap data providers are active |
| `/cost` | Show running session cost; `/cost cap 5` to set a $5 cap |
| `/watch` | `/watch AAPL NVDA` — add tickers to the live watchlist sidebar |
| `/unwatch` | `/unwatch AAPL` |
| `/watchlist` | Show current watchlist |
| `/help` | Show keyboard shortcuts |

Keyboard shortcuts: `Esc` interrupt · `Ctrl+C` exit · `Ctrl+P` command palette · `↑/↓` history.

---

## Evaluate

Rubo ships with a finance-specific eval suite (236 questions, LangSmith-backed):

```bash
bun run src/evals/run.ts            # full suite
bun run src/evals/run.ts --sample 10  # 10-question smoke test
```

The eval uses an LLM-as-judge to score correctness against ground-truth answers from the dataset.

---

## Debug

Every query creates a JSONL file in `.rubo/scratchpad/` with:
- The original query
- Every tool call (args + raw result + LLM summary)
- The agent's reasoning chain

This makes it easy to inspect exactly what data the agent pulled and how it interpreted each result. Set `RUBO_DEBUG=1` to also surface a live log panel in the TUI.

---

## Telegram gateway

```bash
bun run gateway:telegram # paste BotFather token, set DM allowlist
bun run gateway          # start the gateway
```

Telegram uses Bot API long-polling. In groups the bot replies only when mentioned
or replied to. The channel uses the Telegram profile (no headers, no tables).

The gateway process also runs the **cron scheduler**. Scheduled reviews only fire
while it is alive, which is the reason to run it as a service rather than in a
terminal.

---

## Deploying as a service

### Linux (systemd)

```bash
git clone https://github.com/iamvazghen/rubo.git ~/rubo && cd ~/rubo
npm install
cp env.example .env && $EDITOR .env       # keys
mkdir -p ~/.rubo                        # state: memory, portfolio, scores, cron
```

`~/.config/systemd/user/rubo-gateway.service`:

```ini
[Unit]
Description=Rubo gateway (Telegram + cron)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/rubo
Environment=RUBO_HOME=%h/.rubo
Environment=NODE_OPTIONS=--max-old-space-size=1024
EnvironmentFile=%h/rubo/.env
ExecStart=/usr/bin/npx tsx src/gateway/index.ts run
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now rubo-gateway
loginctl enable-linger $USER      # survive logout / reboot
journalctl --user -u rubo-gateway -f
```

`RUBO_HOME` is what makes this safe: state resolves to one absolute
directory regardless of the working directory the service starts in.

### A launcher on PATH

Copy `scripts/bin/rubo` (bash) and `scripts/bin/rubo.cmd` (PowerShell/cmd)
onto your `PATH` and set `RUBO_REPO` to the checkout. Both give the same
subcommands:

```
rubo                 # interactive UI (needs a real terminal)
rubo health          # provider health sweep
rubo test            # test suite
rubo gateway         # Telegram + cron locally
rubo logs            # tail the VPS gateway log
rubo vps restart     # control the VPS service
rubo pull / push     # sync memory + score ledger with the VPS
```

Two files rather than one because PowerShell resolves a bare `rubo` to the
`.cmd` through PATHEXT, while bash only matches an exact filename — without the
extensionless twin, `rubo` is "command not found" in Git Bash.

### The Windows shim, inline

Drop `rubo.cmd` somewhere on `PATH`:

```bat
@echo off
setlocal
if not defined RUBO_REPO set "RUBO_REPO=C:\path\to\rubo"
if not defined RUBO_HOME set "RUBO_HOME=%RUBO_REPO%\.rubo"
pushd "%RUBO_REPO%"
if /i "%~1"=="gateway" (shift & call bun run gateway & goto :done)
if /i "%~1"=="health"  (call bun run health & goto :done)
call node --import tsx src/index.tsx %*
:done
set "EXITCODE=%ERRORLEVEL%"
popd
exit /b %EXITCODE%
```

Then from any directory:

```powershell
rubo                 # interactive CLI
rubo health          # provider health sweep
rubo gateway         # Telegram + cron locally
```

---

## Provider health check

Free API tiers rot quietly: an endpoint is retired, a plan is downgraded, a
series ID changes. Unit tests do not catch it — they assert on shapes, not on
live responses.

```bash
bun run health
```

Calls every network-backed tool once with a realistic argument set and
classifies each as **ok**, **plan** (your subscription, not the code) or
**dead** (broken, fix it), with one retry so a throttled response is not
reported as a failure. Run it after touching a provider, or when the agent
starts claiming data is unavailable.

---

## Cost model

Per-call USD cost is estimated from a public list-price table (`src/utils/cost.ts`). The session bar shows running totals. Set a cap with `/cost cap 5` — a one-time overlay warns when you cross it and offers to continue, switch to a cheaper model, or end the session.

Real billing varies by tier, region, and provider discounts. The estimate is conservative.

---

## LLM Providers

Set any of these in `.env` to enable. Pick one — or several if you want to hot-swap per query.

| Provider | Env var | Notes |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | Default for gpt-5.x models |
| Anthropic | `ANTHROPIC_API_KEY` | Cache-control prompt caching saves ~90% on repeated system prompts |
| Google | `GOOGLE_API_KEY` | Gemini 1M-token context window |
| xAI | `XAI_API_KEY` | Grok |
| Moonshot | `MOONSHOT_API_KEY` | Kimi K2 |
| DeepSeek | `DEEPSEEK_API_KEY` | DeepSeek V4 Pro/Flash |
| OpenRouter | `OPENROUTER_API_KEY` | One key, any model |
| minimax | `MINIMAX_API_KEY` | Primary default provider |
| FreeLLMAPI | `FREELLMAPI_API_KEY` | Local proxy, no per-model key |
| Ollama | `OLLAMA_BASE_URL` | Fully local, no key needed |

Default model: `minimax:m2.5`.

---

## Data providers

All data providers are **optional**. Set the keys you care about; the rest stay dormant.

### Free (no key required)

| Provider | Coverage |
|---|---|
| Frankfurter / ECB | FX rates (all major currencies) |
| World Bank Open Data | Macro indicators for 200+ countries |
| FRED | ~841,000 series: Fed funds, the full Treasury curve, real yields, credit spreads, mortgage rates, CPI, GDP, plus non-US series (German/Japanese rates, EM GDP). Searchable with `fred_search`. |
| ECB SDMX | Eurozone policy rates, HICP inflation, FX |
| BIS | Cross-country central bank policy rates |
| Bitcoin via Blockchain.com | On-chain supply, block height, mempool |

### Free with API key (rate-limited)

Ceilings below are what each provider reported for this project's own keys
(`bun run health` re-checks them). Where a tier is exhausted, the health sweep
names the free tool to use instead rather than only reporting the failure.

| Provider | Coverage | Free tier |
|---|---|---|
| Alpha Vantage | US stocks, FX, crypto, **commodities** | 25 calls/day across all its tools — reserve for commodities |
| Finnhub | US stocks + earnings + sentiment | 60 calls/min |
| Polygon | US stocks, options, FX | 5 calls/min |
| FMP | US fundamentals + DCF + analyst targets | 250 calls/day (`/stable` endpoints only — `/api/v3` is 403 for accounts created after 2025-08-31) |
| Twelve Data | Global equities + FX + crypto | 800 calls/day |
| Tiingo | US EOD + fundamentals | 1000 calls/day |
| EODHD | **Global equities (TICKER.EXCHANGE)** + fundamentals | 20 calls/day across all EODHD tools combined — prefer `yahoo_history` |
| CoinGecko | Crypto prices + global metrics | 10-30 calls/min |
| CoinMarketCap | Crypto listings + quotes | 333 calls/day |
| FRED | US macro | 120 calls/min |
| RentCast | US rent estimates + AVM | requires an active subscription; returns 403 without one, and has no free equivalent |
| Realtor via RapidAPI | US listings | varies |
| NewsAPI | News headlines | 100 calls/day |
| Marketaux | News with entity sentiment | 100 calls/day |
| Benzinga | Market-moving news | varies |
| X / Twitter | Tweet search | Free tier exists |

See `env.example` for the full list with keys. **Paid providers** (Bloomberg, Trading Economics, Glassnode, etc.) are intentionally **not included** — this project ships with free tiers only.

---

## Third-party data attribution + licenses

This project integrates with the following third-party data providers. Each provider retains its own terms of service; the data they return is owned by them, not by Rubo. Use of each provider is governed by their respective license/terms:

| Provider | License / Terms |
|---|---|
| Alpha Vantage | https://www.alphavantage.co/terms_of_use/ |
| Financial Datasets | https://www.financialdatasets.ai/terms |
| Finnhub | https://finnhub.io/terms |
| FMP (Financial Modeling Prep) | https://site.financialmodelingprep.com/terms |
| Polygon.io | https://polygon.io/terms |
| Twelve Data | https://twelvedata.com/terms |
| Tiingo | https://api.tiingo.com/terms |
| EOD Historical Data | https://eodhd.com/terms |
| CoinGecko | https://www.coingecko.com/en/api_terms |
| CoinMarketCap | https://coinmarketcap.com/terms |
| FRED (Federal Reserve Bank of St. Louis) | FRED data is in the public domain; see https://fred.stlouisfed.org/ |
| World Bank Open Data | https://data.worldbank.org/summary-terms-of-use |
| ECB / Frankfurter | ECB data policy: https://www.ecb.europa.eu/services/ecb-data-policy/html/index.en.html |
| Bank of England (BoE) | https://www.bankofengland.co.uk/legal/terms-and-conditions |
| BIS (Bank for International Settlements) | https://www.bis.org/terms_policies.htm |
| Blockchain.com | Free public REST API — https://www.blockchain.com/explorer/api/blockchain_api |
| RentCast | https://www.rentcast.io/terms |
| RapidAPI | https://rapidapi.com/terms |
| NewsAPI | https://newsapi.org/terms |
| Marketaux | https://www.marketaux.com/terms |
| Benzinga | https://www.benzinga.com/terms |
| Exa | https://exa.ai/terms |
| Perplexity | https://www.perplexity.ai/terms |
| Tavily | https://tavily.com/terms |
| LangSearch | https://langsearch.com/terms |
| X / Twitter | https://twitter.com/en/tos |
| Playwright (browser automation) | Apache 2.0 — https://playwright.dev/ |
| LangChain (LLM framework) | MIT License |
| LangSmith (eval tracing) | https://smith.langchain.com/terms |
| pi-tui (terminal UI library) | MIT License — https://github.com/badlogic/pi-mono |

Open-source dependencies are listed in `package.json` with their respective licenses (mostly MIT, Apache 2.0, BSD).

---

## License

[MIT](LICENSE) © 2024–2026 Rubo contributors.

You are free to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the software, subject to the MIT License terms. **Data returned by the third-party providers above is not covered by the MIT license** — it remains governed by each provider's own terms.

---

## Disclaimer

⚠️ **This project is for educational, entertainment, and informational purposes only. It is not intended for real trading or investment.**

- Not financial, investment, tax, or legal advice
- No guarantees of accuracy, completeness, or fitness for any purpose
- Outputs may be incorrect, incomplete, or out of date — verify everything
- Creator and contributors assume no liability for any financial losses or damages
- Consult a licensed financial advisor before making investment decisions
- Past performance does not indicate future results

By using this software, you agree to use it solely for learning and informational purposes and accept all risks associated with its use.