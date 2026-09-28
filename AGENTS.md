# Repository Guidelines

- Repo: https://github.com/iamvazghen/rubo
- Rubo is a CLI-based AI agent for deep financial research, built with TypeScript, `@mariozechner/pi-tui` (terminal UI), and LangChain.
- Reachable two ways: the interactive CLI, and an optional Telegram gateway.

## Project Structure

- Source code: `src/`
  - Agent core: `src/agent/` (agent loop, prompts, scratchpad, token counting, types)
  - CLI interface: `src/cli.ts` (pi-tui), entry point: `src/index.tsx`
  - Components: `src/components/` (pi-tui UI components, incl. `intro.ts` banner)
  - Controllers: `src/controllers/` (agent runner, model/search selection, input history)
  - Providers: `src/providers.ts` (provider registry); Model/LLM: `src/model/llm.ts`
  - Tools: `src/tools/` (finance, search, browser, fetch, memory, cron, subagent, skill)
  - Finance tools: `src/tools/finance/` (prices, fundamentals, filings, insider trades, FX rates, macro indicators, etc.)
  - Search tools: `src/tools/search/` (Exa -> Perplexity -> Tavily -> LangSearch)
  - Gateway/channels: `src/gateway/` (Telegram)
  - Browser: `src/tools/browser/` (Playwright-based web scraping)
  - Skills: `src/skills/` (SKILL.md-based extensible workflows, e.g. DCF valuation)
  - Utils: `src/utils/` (env, config, caching, token estimation, markdown tables)
  - Evals: `src/evals/` (LangSmith evaluation runner with Ink UI)
- Config: `.rubo/settings.json` (persisted model/provider selection), `.rubo/gateway.json` (channels)
- Environment: `.env` (API keys; see `env.example`)
- Global launcher: `rubo` (runs the CLI from any folder); see README "How to Run"
- Scripts: `scripts/release.sh`

## Build, Test, and Development Commands

- Runtime: Bun (primary). Use `bun` for all commands.
- Install deps: `bun install`
- Run: `npm start` (Node + tsx; Bun on Windows never reports terminal resizes, so the TUI must not run under Bun)
- Dev (watch mode): `npm run dev`
- Type-check: `bun run typecheck`
- Tests: `bun test`
- Evals: `bun run src/evals/run.ts` (full) or `bun run src/evals/run.ts --sample 10` (sampled)
- CI runs `bun run typecheck` and `bun test` on push/PR.

## Coding Style & Conventions

- Language: TypeScript (ESM, strict mode). JSX via React (Ink for CLI rendering).
- Prefer strict typing; avoid `any`.
- Keep files concise; extract helpers rather than duplicating code.
- Add brief comments for tricky or non-obvious logic.
- Do not add logging unless explicitly asked.
- Do not create README or documentation files unless explicitly asked.

## LLM Providers

- Single source of truth for provider metadata: `src/providers.ts` (`PROVIDERS`). Factories live in `src/model/llm.ts` (`MODEL_FACTORIES`).
- Supported: FreeLLMAPI (default), OpenAI, Anthropic, Google, xAI (Grok), Moonshot, DeepSeek, OpenRouter, Ollama (local).
- **Default model: `freellmapi:auto`** (provider `freellmapi`) — an OpenAI-compatible local proxy at `FREELLMAPI_BASE_URL` (default `http://localhost:3001/v1`) that auto-routes to a free model. See `DEFAULT_PROVIDER`/`DEFAULT_MODEL` in `src/model/llm.ts`.
- Provider detection is prefix-based (`claude-` -> Anthropic, `gemini-` -> Google, `freellmapi:` -> FreeLLMAPI, etc.); see `resolveProvider`.
- Fast model per provider: `fastModel` field in `src/providers.ts`.
- Anthropic uses explicit `cache_control` on system prompt for prompt caching cost savings.
- Users switch providers/models via the `/model` command in the CLI.

## Tools

- `get_financials`: financial statements, ratios, and metrics (multi-company/multi-metric in one call).
- `get_market_data`: stock/crypto prices, company news, insider trades, institutional holdings (router meta-tool).
- `read_filings`: SEC filing reader for 10-K, 10-Q, 8-K documents.
- `stock_screener`: screen stocks by financial criteria (P/E, growth, margins, etc.).
- `get_fx_rates`: foreign-exchange (currency) rates via ECB/Frankfurter — **no key required**.
- `get_economic_indicators`: macroeconomic indicators (GDP, inflation, unemployment, rates) via World Bank — **no key required**.
- `web_search`: general web search; fallback chain Exa -> Perplexity -> Tavily -> LangSearch (whichever keys are set).
- `web_fetch` / `browser`: fetch-and-summarize and Playwright-based interactive scraping.
- `x_search`: X/Twitter search (requires `X_BEARER_TOKEN`).
- `skill`: invokes SKILL.md-defined workflows (e.g. DCF valuation). Each skill runs at most once per query.
- Memory: `memory_search` / `memory_get` / `memory_update`. Scheduling: `cron`, `heartbeat`. Sub-agents: `spawn_subagent`.
- Tool registry: `src/tools/registry.ts`. Tools are conditionally included based on env vars.

## Channels (Gateway)

- Gateway entry: `src/gateway/index.ts` (`run` | `login` | `telegram`). Bootstrap: `src/gateway/gateway.ts`.
- Channels under `src/gateway/channels/`: `telegram/` (Bot API long-polling).
- Add a channel by implementing `ChannelPlugin` (`channels/types.ts`) and registering a manager in `startGateway`.
- Config + per-account resolution: `src/gateway/config.ts` (`.rubo/gateway.json`).

## Skills

- Skills live as `SKILL.md` files with YAML frontmatter (`name`, `description`) and markdown body (instructions).
- Built-in skills: `src/skills/dcf/SKILL.md`.
- Discovery: `src/skills/registry.ts` scans for SKILL.md files at startup.
- Skills are exposed to the LLM as metadata in the system prompt; the LLM invokes them via the `skill` tool.

## Agent Architecture

- Agent loop: `src/agent/agent.ts`. Iterative tool-calling loop with configurable max iterations (default 10).
- Scratchpad: `src/agent/scratchpad.ts`. Single source of truth for all tool results within a query.
- Context management: Anthropic-style. Full tool results kept in context; oldest results cleared when token threshold exceeded.
- Final answer: generated in a separate LLM call with full scratchpad context (no tools bound).
- Events: agent yields typed events (`tool_start`, `tool_end`, `thinking`, `answer_start`, `done`, etc.) for real-time UI updates.

## Environment Variables

- LLM (default): `FREELLMAPI_API_KEY`, `FREELLMAPI_BASE_URL`
- LLM (hosted): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`
- Ollama: `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- Finance: `FINANCIAL_DATASETS_API_KEY` (FX rates and macro indicators need no key)
- Search: `EXASEARCH_API_KEY`, `PERPLEXITY_API_KEY`, `TAVILY_API_KEY`, `LANGSEARCH_API_KEY`
- Social/messaging: `X_BEARER_TOKEN`, `TELEGRAM_BOT_TOKEN`
- Tracing: `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING`
- See `env.example` for the optional integrations roadmap (extra market/crypto/real-estate/central-bank providers).
- Never commit `.env` files or real API keys.

## Version & Release

- Version format: SemVer `MAJOR.MINOR.PATCH`. Tag prefix: `v`.
- Release script: `bash scripts/release.sh [version]` (defaults to today's date).
- Release flow: bump version in `package.json`, create git tag, push tag, create GitHub release via `gh`.
- Do not push or publish without user confirmation.

## Testing

- Framework: Bun's built-in test runner (primary), Jest config exists for legacy compatibility.
- Tests colocated as `*.test.ts`.
- Run `bun test` before pushing when you touch logic.

## Security

- API keys stored in `.env` (gitignored). Users can also enter keys interactively via the CLI.
- Config stored in `.rubo/settings.json` (gitignored).
- Never commit or expose real API keys, tokens, or credentials.
