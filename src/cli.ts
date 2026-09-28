import { readFile } from 'node:fs/promises';
import { Container, Spacer, Text, TUI } from '@mariozechner/pi-tui';
import { RuboTerminal } from './terminal.js';
import { FINANCE_COMMANDS, runFinanceCommand } from './commands/finance.js';
import type {
  ApprovalDecision,
  ToolEndEvent,
  ToolErrorEvent,
  ToolStartEvent,
} from './agent/index.js';
import {
  getApiKeyNameForProvider,
  getApiKeyNameForSearchProvider,
  getProviderDisplayName,
  getSearchProviderDisplayName,
} from './utils/env.js';
import { ruboPath } from './utils/paths.js';
import { HelpPanelComponent } from './components/help-panel.js';
import { getModelCapabilities } from './model/capabilities.js';
import { defaultQueue } from './utils/message-queue.js';
import { logger } from './utils/logger.js';
import {
  AgentRunnerController,
  InputHistoryController,
  ModelSelectionController,
  SearchSelectionController,
} from './controllers/index.js';
import {
  ApiKeyInputComponent,
  ApprovalPromptComponent,
  QuestionPromptComponent,
  ChatLogComponent,
  CustomEditor,
  DebugPanelComponent,
  HintBarComponent,
  IntroComponent,
  WorkingIndicatorComponent,
  createApiKeyConfirmSelector,
  createChoiceSelector,
  createModelSelector,
  createProviderSelector,
  createSearchProviderSelector,
  StatusBarComponent,
  CommandPaletteComponent,
  buildDefaultPaletteItems,
  WatchlistComponent,
  CostCapOverlayComponent,
  type StatusStats,
  type PaletteAction,
} from './components/index.js';
import { editorTheme, theme, setActiveTheme, getActiveTheme, THEMES, type ThemeName } from './theme.js';
import { getSetting, setSetting } from './utils/config.js';
import { matchCommands, type SlashCommand } from './commands/index.js';
import { initSpinner } from './utils/spinner.js';
import {
  SessionStore,
  listSessions,
  latestSession,
  loadSession,
  type SessionFile,
  type SessionSummary,
} from './utils/session-store.js';
import { estimateCost, formatUsd } from './utils/cost.js';
import { getActiveProviderNames, getAllProviderNames } from './tools/finance/providers/index.js';
import { getActiveNewsProviderNames, getAllNewsProviderNames } from './tools/news/index.js';
import { PROVIDERS, getProviderById } from './providers.js';
import { PROVIDERS as MODEL_PROVIDERS, getModelsForProvider } from './utils/model.js';

/** Parse a `--resume [id]` / `-r [id]` / `resume [id]` startup request. */
function parseResumeArg(argv: string[]): { resume: boolean; id?: string } {
  const idx = argv.findIndex((a) => a === '--resume' || a === '-r' || a === 'resume');
  if (idx === -1) return { resume: false };
  const next = argv[idx + 1];
  const id = next && !next.startsWith('-') ? next : undefined;
  return { resume: true, id };
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function truncateForHistory(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= 3) return text;
  const firstLine = lines[0].trim() || lines[1]?.trim() || 'pasted content';
  const preview = firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine;
  return `${preview} [+${lines.length - 1} lines]`;
}

function truncateAtWord(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  const lastSpace = str.lastIndexOf(' ', maxLength);
  if (lastSpace > maxLength * 0.5) {
    return `${str.slice(0, lastSpace)}...`;
  }
  return `${str.slice(0, maxLength)}...`;
}

function summarizeToolResult(tool: string, args: Record<string, unknown>, result: string): string {
  if (tool === 'skill') {
    const skillName = args.skill as string;
    return `Loaded ${skillName} skill`;
  }
  try {
    const parsed = JSON.parse(result);
    if (parsed.data) {
      if (Array.isArray(parsed.data)) {
        return `Received ${parsed.data.length} items`;
      }
      if (typeof parsed.data === 'object') {
        const keys = Object.keys(parsed.data).filter((key) => !key.startsWith('_'));
        if (tool === 'get_financials' || tool === 'get_market_data' || tool === 'stock_screener') {
          if (keys.length === 0) return 'Done';
          return keys.length === 1 ? 'Called 1 data source' : `Called ${keys.length} data sources`;
        }
        if (tool === 'web_search') {
          return 'Did 1 search';
        }
        return `Received ${keys.length} fields`;
      }
    }
  } catch {
    return truncateAtWord(result, 50);
  }
  return 'Received data';
}

function createScreen(
  title: string,
  description: string,
  body: any,
  footer?: string,
): Container {
  const container = new Container();
  if (title) {
    container.addChild(new Text(theme.bold(theme.primary(title)), 0, 0));
  }
  if (description) {
    container.addChild(new Text(theme.muted(description), 0, 0));
  }
  container.addChild(new Spacer(1));
  container.addChild(body);
  if (footer) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.muted(footer), 0, 0));
  }
  return container;
}

/**
 * Render a single display event into the chat log (used by incremental history).
 */
function renderEvent(
  chatLog: ChatLogComponent,
  display: { event: any; id: string; completed?: boolean; endEvent?: any; progressMessage?: string },
  itemStatus: string,
) {
  const event = display.event;

  if (event.type === 'reasoning') {
    if (!showThinking) return;
    chatLog.addReasoning(event.content, event.model);
    return;
  }
  if (event.type === 'thinking') {
    const message = event.message.trim();
    if (message) {
      chatLog.addChild(
        new Text(message.length > 200 ? `${message.slice(0, 200)}...` : message, 0, 0),
      );
    }
    return;
  }

  if (event.type === 'tool_start') {
    const toolStart = event as ToolStartEvent;
    // ask_user_question has no tool row: the inline widget is its UI, and an
    // answered block is appended on submit. (matches the no-tool-message design)
    if (toolStart.tool === 'ask_user_question') {
      return;
    }
    const component = chatLog.startTool(display.id, toolStart.tool, toolStart.args);
    if (display.completed && display.endEvent?.type === 'tool_end') {
      const done = display.endEvent as ToolEndEvent;
      component.setComplete(
        summarizeToolResult(done.tool, toolStart.args, done.result),
        done.duration,
      );
    } else if (display.completed && display.endEvent?.type === 'tool_error') {
      const toolError = display.endEvent as ToolErrorEvent;
      component.setError(toolError.error);
    } else if (itemStatus === 'interrupted') {
      // Don't start spinner for tools in interrupted items
    } else if (display.progressMessage) {
      component.setActive(display.progressMessage);
    }
    return;
  }

  if (event.type === 'tool_approval') {
    chatLog.startTool(display.id, event.tool, event.args).setApproval(event.approved);
    return;
  }

  if (event.type === 'tool_denied') {
    const path = (event.args.path as string) ?? '';
    chatLog.startTool(display.id, event.tool, event.args).setDenied(path, event.tool);
    return;
  }

  if (event.type === 'tool_limit') return;

  if (event.type === 'context_cleared') {
    chatLog.addContextCleared(event.clearedCount, event.keptCount);
  }
  if (event.type === 'microcompact') {
    chatLog.addMicrocompact(event.cleared, event.tokensSaved);
  }
  if (event.type === 'queue_drain') {
    chatLog.addQueueDrain(event.messageCount);
  }
  if (event.type === 'compaction' && event.phase === 'end') {
    chatLog.addCompaction(event.success ?? false, event.preCompactTokens, event.postCompactTokens);
  }
}

/** Whether reasoning blocks are displayed. Toggled with /thinking. */
let showThinking = getSetting<boolean>('showThinking', true);

export async function runCli(argv: string[] = process.argv.slice(2)) {
  const resumeRequest = parseResumeArg(argv);
  // Apply the saved color theme before the first render.
  setActiveTheme(getSetting<ThemeName>('theme', 'emerald'));
  const tui = new TUI(new RuboTerminal());
  const root = new Container();
  const chatLog = new ChatLogComponent(tui);
  const inputHistory = new InputHistoryController(() => tui.requestRender());
  let lastError: string | null = null;
  // Persistent, resumable conversation thread. Assigned once the model is known
  // (below) and re-pointed if the user resumes a prior session via /resume.
  let sessionStore: SessionStore | undefined;

  const onError = (message: string) => {
    lastError = message;
    logger.error(message);
    tui.requestRender();
  };

  let agentRunner: AgentRunnerController;
  const modelSelection = new ModelSelectionController(onError, () => {
    intro.setModel(modelSelection.model);
    sessionStore?.setModel(modelSelection.model);
    agentRunner?.updateAgentConfig({
      model: modelSelection.model,
      modelProvider: modelSelection.provider,
    });
    renderSelectionOverlay();
    tui.requestRender();
  });
  const searchSelection = new SearchSelectionController(onError, () => {
    renderSelectionOverlay();
    tui.requestRender();
  });
  sessionStore = SessionStore.create(modelSelection.model, 'cli');

  // Incremental history tracking
  let lastRenderedEventCount = 0;
  let lastRenderedStatus = '';
  let lastRenderedAnswer = false;
  let lastRenderedQueryId: string | null = null;
  const finalizedToolIds = new Set<string>();
  const appliedToolProgress = new Map<string, string>();
  let lastPendingApproval: { tool: string; args: Record<string, unknown> } | null = null;
  let lastPendingQuestion: { questions: unknown[] } | null = null;
  // Cached so the stateful question overlay survives onChange-driven re-renders
  // (partial selections, active tab, in-progress text are kept across renders).
  let activeQuestionPrompt: QuestionPromptComponent | null = null;
  // Lightweight picker overlays for /theme and /sessions|/resume. Cached so the
  // highlighted row survives re-renders, mirroring activeQuestionPrompt.
  let activeOverlay: 'theme' | 'session' | null = null;
  let themeSelector: ReturnType<typeof createChoiceSelector> | null = null;
  let sessionSelector: ReturnType<typeof createChoiceSelector> | null = null;
  let sessionChoices: SessionSummary[] = [];

  agentRunner = new AgentRunnerController(
    { model: modelSelection.model, modelProvider: modelSelection.provider, maxIterations: 20 },
    modelSelection.inMemoryChatHistory,
    () => {
      // Incremental history update — only render new events
      const history = agentRunner.history;
      const lastItem = history[history.length - 1];
      if (lastItem) {
        // New query started — keyed by id so onChange storms don't re-render the header
        if (lastItem.id !== lastRenderedQueryId) {
          chatLog.addQuery(lastItem.query);
          chatLog.resetToolGrouping();
          lastRenderedQueryId = lastItem.id;
        }

        // Render new events only
        for (let i = lastRenderedEventCount; i < lastItem.events.length; i++) {
          renderEvent(chatLog, lastItem.events[i], lastItem.status);
        }
        lastRenderedEventCount = lastItem.events.length;

        // Update already-rendered tool events that may have completed
        for (const display of lastItem.events) {
          if (display.event.type === 'tool_start' && display.completed && display.endEvent && !finalizedToolIds.has(display.id)) {
            const component = chatLog.getToolById(display.id);
            if (component) {
              finalizedToolIds.add(display.id);
              if (display.endEvent.type === 'tool_end') {
                component.setComplete(
                  summarizeToolResult(display.endEvent.tool, display.event.args, display.endEvent.result),
                  display.endEvent.duration,
                );
              } else if (display.endEvent.type === 'tool_error') {
                component.setError(display.endEvent.error);
              }
            }
          }
        }

        // Apply live progress to already-rendered, still-running tools. Guarded
        // by change-detection so each unique message triggers exactly one update.
        for (const display of lastItem.events) {
          if (
            display.event.type === 'tool_start' &&
            !display.completed &&
            display.progressMessage &&
            appliedToolProgress.get(display.id) !== display.progressMessage
          ) {
            appliedToolProgress.set(display.id, display.progressMessage);
            chatLog.getToolById(display.id)?.setActive(display.progressMessage);
          }
        }

        // Handle completion
        if (lastItem.answer && !lastRenderedAnswer) {
          chatLog.finalizeAnswer(lastItem.answer);
          lastRenderedAnswer = true;
        }
        if (lastItem.status === 'complete' && lastRenderedStatus !== 'complete') {
          chatLog.addPerformanceStats(lastItem.duration ?? 0, lastItem.tokenUsage, lastItem.tokensPerSecond);
          // Append inline source citations + freshness stamp from this turn's tool results.
          const turnSources = collectTurnSourceUrls(lastItem);
          if (turnSources.length > 0) {
            chatLog.addSourceChips(turnSources);
          }
          const provenance = collectTurnProvenance(lastItem);
          if (provenance.provider || provenance.asOf) {
            chatLog.addFreshnessStamp(provenance.provider, provenance.asOf);
          }
          // Accumulate session-wide token usage + cost estimate.
          if (lastItem.tokenUsage) {
            sessionTokensIn += lastItem.tokenUsage.inputTokens ?? 0;
            sessionTokensOut += lastItem.tokenUsage.outputTokens ?? 0;
            const added = estimateCost(modelSelection.model, sessionTokensIn, sessionTokensOut);
            sessionCostUsd = added;
          }
          refreshStatusBar(lastItem);
          // Trigger cost-cap warning once per session.
          if (!costCapAcknowledged && sessionCostUsd >= costCapUsd) {
            costCapAcknowledged = true;
            costCapOverlayVisible = true;
            showCostCapOverlay();
          }
        }
        if (lastItem.status === 'interrupted' && lastRenderedStatus !== 'interrupted') {
          // Stop all active tool spinners on interrupt
          for (const display of lastItem.events) {
            if (display.event.type === 'tool_start' && !finalizedToolIds.has(display.id)) {
              const component = chatLog.getToolById(display.id);
              component?.dispose?.();
              finalizedToolIds.add(display.id);
            }
          }
          chatLog.addInterrupted();
        }
        lastRenderedStatus = lastItem.status;
      }

      workingIndicator.setState(agentRunner.workingState);
      updateView();
      if (agentRunner.pendingApproval !== lastPendingApproval) {
        lastPendingApproval = agentRunner.pendingApproval;
        renderSelectionOverlay();
      }
      if (agentRunner.pendingQuestion !== lastPendingQuestion) {
        lastPendingQuestion = agentRunner.pendingQuestion;
        renderSelectionOverlay();
      }
      throttledRender();
    },
  );

  const intro = new IntroComponent(
    modelSelection.model,
    getProviderById(modelSelection.provider)?.displayName ?? modelSelection.provider,
    new Set([...getActiveProviderNames(), ...getActiveNewsProviderNames()]).size,
  );
  const errorText = new Text('', 0, 0);
  const workingIndicator = new WorkingIndicatorComponent(tui);
  workingIndicator.setTurnStatsProvider(() => agentRunner.turnStats);
  const editor = new CustomEditor(tui, editorTheme);
  const hintBar = new HintBarComponent();
  // Debug panel is a developer aid (raw log lines under the input). Hidden by
  // default so end users see a single clean input; enable with RUBO_DEBUG=1.
  const debugPanel = new DebugPanelComponent(8, !!process.env.RUBO_DEBUG);
  const spacer = new Spacer(1);

  // Elite TUI additions
  const statusBar = new StatusBarComponent();
  const watchlist = new WatchlistComponent(22);
  // Session cost tracker — accumulates across all turns
  let sessionCostUsd = 0;
  let sessionTokensIn = 0;
  let sessionTokensOut = 0;
  // Cost cap (default $5; persisted via /cost cap)
  const costCapUsd = getSetting<number>('costCapUsd', 5);
  let costCapAcknowledged = false;
  let costCapOverlayVisible = false;

  // Watchlist state
  let watchedTickers: string[] = getSetting<string[]>('watchlist', []);
  watchlist.setTickers(watchedTickers);

  // Recent tickers mentioned (for command palette)
  const recentTickers: string[] = [];

  // Build the component tree ONCE — stable structure, no root.clear()
  root.addChild(intro);
  root.addChild(chatLog);
  root.addChild(errorText);
  root.addChild(workingIndicator);
  root.addChild(statusBar);
  root.addChild(watchlist);
  root.addChild(spacer);
  root.addChild(editor);
  root.addChild(hintBar);
  root.addChild(debugPanel);
  tui.addChild(root);
  initSpinner(tui);

  /** Update the persistent status bar with the latest stats. */
  const refreshStatusBar = (currentItem?: any) => {
    const providerName = getProviderById(modelSelection.provider)?.displayName ?? modelSelection.provider;
    const providerLabel = `${providerName} · ${modelSelection.model}`;
    const stats: StatusStats = {
      inputTokens: sessionTokensIn,
      outputTokens: sessionTokensOut,
      costUsd: sessionCostUsd,
      iter: currentItem?.iteration ?? 0,
      maxIter: 20,
      tokensPerSecond: currentItem?.tokensPerSecond ?? null,
    };
    statusBar.setProvider(providerLabel);
    statusBar.setModel(modelSelection.model);
    statusBar.setStats(stats);
  };
  refreshStatusBar();

  /** Collect unique sourceUrls from this turn's tool results (for inline citation chips). */
  const collectTurnSourceUrls = (item: any): Array<{ id: number; url: string; provider?: string }> => {
    const seen = new Set<string>();
    const out: Array<{ id: number; url: string; provider?: string }> = [];
    for (const display of item.events ?? []) {
      const ev = display?.endEvent;
      if (ev?.type === 'tool_end' && typeof ev.result === 'string') {
        try {
          const parsed = JSON.parse(ev.result);
          // Prefer the new `sources` field (numbered citations); fall back to plain URLs.
          if (Array.isArray(parsed?.sources)) {
            for (const s of parsed.sources) {
              if (typeof s?.url === 'string' && !seen.has(s.url)) {
                seen.add(s.url);
                out.push({
                  id: typeof s.id === 'number' ? s.id : out.length + 1,
                  url: s.url,
                  provider: typeof s.provider === 'string' ? s.provider : undefined,
                });
              }
            }
          } else if (Array.isArray(parsed?.sourceUrls)) {
            for (const u of parsed.sourceUrls) {
              if (typeof u === 'string' && !seen.has(u)) {
                seen.add(u);
                out.push({ id: out.length + 1, url: u });
              }
            }
          }
        } catch {
          // not JSON, skip
        }
      }
    }
    return out;
  };

  /** Collect freshness stamps (provider + asOf) for the freshness line. */
  const collectTurnProvenance = (item: any): { provider?: string; asOf?: string } => {
    const providers: string[] = [];
    let asOf: string | undefined;
    for (const display of item.events ?? []) {
      const ev = display?.endEvent;
      if (ev?.type === 'tool_end' && typeof ev.result === 'string') {
        try {
          const parsed = JSON.parse(ev.result);
          if (typeof parsed?.provider === 'string' && !providers.includes(parsed.provider)) {
            providers.push(parsed.provider);
          }
          if (!asOf && typeof parsed?.asOf === 'string') asOf = parsed.asOf;
        } catch {
          // skip
        }
      }
    }
    return { provider: providers.join(' · '), asOf };
  };

  /** Render the cost-cap warning as an overlay. */
  const showCostCapOverlay = () => {
    const overlay = new CostCapOverlayComponent(sessionCostUsd, costCapUsd);
    overlay.onSelect = (decision) => {
      if (decision === 'continue') {
        // Effectively disable the cap for this session.
        costCapAcknowledged = true;
      } else if (decision === 'switch-model') {
        modelSelection.startSelection();
      } else if (decision === 'end-session') {
        tui.stop();
        process.exit(0);
      }
      costCapOverlayVisible = false;
      renderSelectionOverlay();
      tui.requestRender();
    };
    overlay.onCancel = () => {
      costCapOverlayVisible = false;
      renderSelectionOverlay();
      tui.requestRender();
    };
    showScreenView('Cost cap reached', '', overlay, 'Choose an option above', overlay);
  };

  // Render throttle for agent events (~30fps max)
  let renderPending = false;
  const RENDER_THROTTLE_MS = 32;
  function throttledRender(): void {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      tui.requestRender();
    }, RENDER_THROTTLE_MS);
  }

  const refreshError = () => {
    const message = lastError ?? agentRunner.error;
    errorText.setText(message ? theme.error(`Error: ${message}`) : '');
  };

  // Slash command autocomplete state
  let slashSuggestions: SlashCommand[] = [];
  let slashSelectedIndex = 0;
  let slashActive = false;


  // A fresh session, like Telegram's /new: empty screen and model context, new id.
  // The previous session stays saved and resumable.
  const startFresh = () => {
    chatLog.clearAll();
    modelSelection.inMemoryChatHistory.clear();
    lastRenderedEventCount = 0;
    lastRenderedStatus = '';
    lastRenderedAnswer = false;
    lastRenderedQueryId = null;
    finalizedToolIds.clear();
    appliedToolProgress.clear();
    const previous = sessionStore?.turns.length ? sessionStore.id : null;
    sessionStore = SessionStore.create(modelSelection.model, 'cli');
    chatLog.addChild(new Spacer(1));
    chatLog.addChild(new Text(theme.muted(
      `✦ New session ${sessionStore.id}${previous ? ` · the previous one is saved: /resume ${previous}` : ''}`), 0, 0));
    tui.requestRender();
  };

  // Replay a saved session into the live view and re-seed model context, then
  // point the active store at it so new turns continue that thread.
  const resumeInto = (session: SessionFile) => {
    chatLog.clearAll();
    modelSelection.inMemoryChatHistory.clear();
    modelSelection.inMemoryChatHistory.loadTurns(session.turns);
    lastRenderedEventCount = 0;
    lastRenderedStatus = '';
    lastRenderedAnswer = false;
    lastRenderedQueryId = null;
    finalizedToolIds.clear();
    appliedToolProgress.clear();
    for (const turn of session.turns) {
      chatLog.addQuery(turn.query);
      chatLog.finalizeAnswer(turn.answer);
    }
    sessionStore = SessionStore.fromExisting(session);
    const count = session.turns.length;
    chatLog.addChild(new Spacer(1));
    chatLog.addChild(
      new Text(
        theme.muted(`↻ Resumed ${session.id} · ${session.title} · ${count} turn${count === 1 ? '' : 's'}`),
        0,
        0,
      ),
    );
    tui.requestRender();
  };

  const handleSlashCommand = async (command: string, rawQuery: string) => {
    // Extract arguments: everything after `/command ` (or just the command if no args).
    const rest = rawQuery.replace(/^\/\S+\s*/, '').trim();
    // Holdings, income and rebalancing: answered by code, identically to Telegram.
    if ((FINANCE_COMMANDS as readonly string[]).includes(command)) {
      const reply = await runFinanceCommand(command, rest);
      chatLog.addChild(new Spacer(1));
      chatLog.addChild(new Text(reply ?? '', 0, 0));
      tui.requestRender();
      return;
    }
    switch (command) {
      case 'model':
        modelSelection.startSelection();
        break;
      case 'search':
        searchSelection.startSelection();
        break;
      case 'theme': {
        themeSelector = null; // rebuilt with the current selection marker
        activeOverlay = 'theme';
        renderSelectionOverlay();
        tui.requestRender();
        break;
      }
      case 'rules': {
        try {
          const rulesContent = await readFile(ruboPath('RULES.md'), 'utf-8');
          chatLog.addChild(new Spacer(1));
          chatLog.addChild(new Text(theme.muted('Research Rules:'), 0, 0));
          chatLog.addChild(new Text(rulesContent, 0, 0));
        } catch {
          chatLog.addChild(new Spacer(1));
          chatLog.addChild(new Text(theme.muted('No research rules set. Use "add a rule <text>" to create one.'), 0, 0));
        }
        tui.requestRender();
        break;
      }
      case 'new':
      case 'clear':
        startFresh();
        break;
      case 'session':
        chatLog.addChild(new Spacer(1));
        chatLog.addChild(new Text(theme.muted(sessionStore?.turns.length
          ? `Current session: ${sessionStore.id} · /new starts another, /sessions lists them all.`
          : `Current session: ${sessionStore?.id} (saved after your first question).`), 0, 0));
        tui.requestRender();
        break;
      case 'memory':
        await agentRunner.runQuery('Show me what you know about me from memory. Use memory_search and memory_get.');
        break;
      case 'heartbeat':
        await agentRunner.runQuery('Show me my current heartbeat checklist from .rubo/HEARTBEAT.md');
        break;
      case 'history': {
        const messages = modelSelection.inMemoryChatHistory.getMessages();
        chatLog.addChild(new Spacer(1));
        if (messages.length === 0) {
          chatLog.addChild(new Text(theme.muted('No conversation history yet.'), 0, 0));
        } else {
          chatLog.addChild(new Text(theme.muted('Recent conversations:'), 0, 0));
          for (const msg of messages) {
            const summary = msg.summary ?? msg.answer?.slice(0, 100) ?? '(pending)';
            chatLog.addChild(new Text(theme.muted(`  ${msg.id + 1}. ${msg.query}`), 0, 0));
            chatLog.addChild(new Text(theme.muted(`     ${summary}`), 0, 0));
          }
        }
        tui.requestRender();
        break;
      }
      case 'sessions': {
        // Interactive picker of saved sessions; selecting one resumes it.
        const sessions = await listSessions();
        if (sessions.length === 0) {
          chatLog.addChild(new Spacer(1));
          chatLog.addChild(new Text(theme.muted('No saved sessions yet.'), 0, 0));
          tui.requestRender();
          break;
        }
        sessionChoices = sessions;
        sessionSelector = null; // rebuilt from the current list
        activeOverlay = 'session';
        renderSelectionOverlay();
        tui.requestRender();
        break;
      }
      case 'resume': {
        // `/resume <id>` continues that session (from the CLI or from Telegram);
        // bare `/resume` continues the most recent prior conversation.
        if (rest) {
          const full = await loadSession(rest);
          if (full) resumeInto(full);
          else {
            chatLog.addChild(new Spacer(1));
            chatLog.addChild(new Text(theme.warning(`No session "${rest}". /sessions lists them.`), 0, 0));
          }
          tui.requestRender();
          break;
        }
        const sessions = await listSessions();
        const target = sessions.find((s) => !sessionStore || s.id !== sessionStore.id) ?? sessions[0];
        if (!target) {
          chatLog.addChild(new Spacer(1));
          chatLog.addChild(new Text(theme.muted('No previous session to resume.'), 0, 0));
          tui.requestRender();
          break;
        }
        const full = await loadSession(target.id);
        if (full) resumeInto(full);
        tui.requestRender();
        break;
      }
      case 'help':
        // Generated from the command registry, so it cannot drift.
        chatLog.addChild(new HelpPanelComponent());
        tui.requestRender();
        break;
      case 'grade': {
        const ticker = rest.trim().toUpperCase();
        if (!ticker) {
          chatLog.addChild(new Text(theme.warning('Usage: /grade AAPL'), 0, 0));
          tui.requestRender();
          break;
        }
        // Hand it to the agent as a normal turn: the grade-investment skill
        // does the work, and the transcript reads the same as if typed.
        await handleSubmit(
          `Grade ${ticker} using grade_ticker. Give both horizons, the factors that drove each, and what would change your mind.`,
        );
        break;
      }
      case 'report': {
        const horizon = rest.trim().toLowerCase() === 'short' ? 'short' : 'long';
        await handleSubmit(
          `Run the periodic review: investment_report with horizon ${horizon}. Lead with what changed since the last run.`,
        );
        break;
      }
      case 'thinking': {
        const arg = rest.trim().toLowerCase();
        const caps = getModelCapabilities(modelSelection.model);
        if (arg === 'on' || arg === 'off') {
          setSetting('showThinking', arg === 'on');
          showThinking = arg === 'on';
        }
        chatLog.addChild(new Spacer(1));
        chatLog.addChild(
          new Text(
            `  ${theme.muted('Reasoning blocks:')} ${showThinking ? theme.success('shown') : theme.muted('hidden')}`,
            0,
            0,
          ),
        );
        chatLog.addChild(
          new Text(
            caps.reasoning
              ? `  ${theme.muted('Current model')} ${theme.primaryLight(modelSelection.model)} ${theme.muted('is a thinking model — it produces reasoning to show.')}`
              : `  ${theme.muted('Current model')} ${theme.primaryLight(modelSelection.model)} ${theme.muted('does not reason, so no blocks will appear either way.')}`,
            0,
            0,
          ),
        );
        chatLog.addChild(new Spacer(1));
        tui.requestRender();
        break;
      }
      case 'palette': {
        openCommandPalette();
        break;
      }
      case 'providers': {
        chatLog.addChild(new Spacer(1));
        chatLog.addChild(new Text(theme.primary('Roadmap data providers'), 0, 0));
        chatLog.addChild(new Spacer(1));
        const allNames = new Set([...getAllProviderNames(), ...getAllNewsProviderNames()]);
        const activeFinance = new Set(getActiveProviderNames());
        const activeNews = new Set(getActiveNewsProviderNames());
        for (const name of [...allNames].sort()) {
          const isActive = activeFinance.has(name) || activeNews.has(name);
          const marker = isActive ? theme.success('●') : theme.muted('○');
          const label = isActive ? theme.primary(name) : theme.muted(name);
          chatLog.addChild(new Text(`  ${marker} ${label}`, 0, 0));
        }
        chatLog.addChild(new Spacer(1));
        const activeCount = activeFinance.size + activeNews.size;
        chatLog.addChild(
          new Text(theme.muted(`  ${activeCount} of ${allNames.size} providers active`), 0, 0),
        );
        tui.requestRender();
        break;
      }
      case 'cost': {
        // /cost [cap N]
        const capMatch = rest.match(/^cap\s+(\d+(?:\.\d+)?)/i);
        if (capMatch) {
          const cap = Number(capMatch[1]);
          setSetting('costCapUsd', cap);
          chatLog.addChild(new Spacer(1));
          chatLog.addChild(new Text(`${theme.success('⏺')} ${theme.primary(`Cost cap set to ${formatUsd(cap)}`)}`, 0, 0));
        } else {
          chatLog.addChild(new Spacer(1));
          chatLog.addChild(new Text(`${theme.primary('Session cost')} ${formatUsd(sessionCostUsd)} · cap ${formatUsd(costCapUsd)}`, 0, 0));
          chatLog.addChild(new Text(theme.muted(`  ↓ ${sessionTokensIn} in · ↑ ${sessionTokensOut} out`), 0, 0));
        }
        tui.requestRender();
        break;
      }
      case 'watch': {
        // /watch AAPL NVDA MSFT
        const tickers = rest.split(/\s+/).filter(Boolean).map((t) => t.toUpperCase());
        if (tickers.length === 0) {
          chatLog.addChild(new Spacer(1));
          chatLog.addChild(new Text(theme.muted('Usage: /watch AAPL NVDA MSFT'), 0, 0));
        } else {
          for (const t of tickers) {
            if (!watchedTickers.includes(t)) watchedTickers.push(t);
            if (!recentTickers.includes(t)) recentTickers.unshift(t);
          }
          setSetting('watchlist', watchedTickers);
          watchlist.setTickers(watchedTickers);
          // Kick off an immediate refresh
          void refreshWatchlist();
          chatLog.addChild(new Spacer(1));
          chatLog.addChild(new Text(theme.primary(`Watching ${tickers.join(', ')}`), 0, 0));
        }
        tui.requestRender();
        break;
      }
      case 'unwatch': {
        const tickers = rest.split(/\s+/).filter(Boolean).map((t) => t.toUpperCase());
        for (const t of tickers) {
          watchedTickers = watchedTickers.filter((x) => x !== t);
        }
        setSetting('watchlist', watchedTickers);
        watchlist.setTickers(watchedTickers);
        chatLog.addChild(new Spacer(1));
        chatLog.addChild(new Text(theme.muted(`Stopped watching ${tickers.join(', ') || 'all'}`), 0, 0));
        tui.requestRender();
        break;
      }
      case 'watchlist': {
        chatLog.addChild(new Spacer(1));
        if (watchedTickers.length === 0) {
          chatLog.addChild(new Text(theme.muted('No tickers watched. /watch AAPL NVDA'), 0, 0));
        } else {
          chatLog.addChild(new Text(theme.primary(`Watchlist (${watchedTickers.length})`), 0, 0));
          chatLog.addChild(new Text(theme.muted(watchedTickers.join(' · ')), 0, 0));
        }
        tui.requestRender();
        break;
      }
      case 'cache': {
        chatLog.addChild(new Spacer(1));
        const subcommand = (rawQuery.replace(/^\/cache\s*/, '').trim().toLowerCase());
        if (subcommand === 'clear' || subcommand === 'reset') {
          const { clearToolCache, getToolCacheStats } = await import('./utils/tool-cache.js');
          const before = getToolCacheStats();
          clearToolCache();
          chatLog.addChild(
            new Text(theme.success(`⏺ Tool cache cleared (was ${before.size} entries, ${before.totalHits} hits)`), 0, 0),
          );
        } else {
          const { getToolCacheStats } = await import('./utils/tool-cache.js');
          const stats = getToolCacheStats();
          chatLog.addChild(
            new Text(theme.primary(`Tool cache: ${stats.size} / ${stats.maxEntries} entries, ${stats.totalHits} hits`), 0, 0),
          );
          chatLog.addChild(
            new Text(theme.muted('/cache clear — flush all cached tool results (forces fresh network calls).'), 0, 0),
          );
        }
        tui.requestRender();
        break;
      }
    }
  };

  // Slash callbacks are wired after renderSelectionOverlay is defined (below)

  /** Render and focus the command palette as a single-line overlay. */
  const openCommandPalette = async () => {
    let sessions: Array<{ id: string; title: string }> = [];
    try {
      const list = await listSessions();
      sessions = list.slice(0, 8).map((s) => ({ id: s.id, title: s.title }));
    } catch {
      // ignore
    }
    const items = buildDefaultPaletteItems({
      sessions,
      providers: PROVIDERS.map((p) => ({ id: p.id, displayName: p.displayName })),
      modelsByProvider: Object.fromEntries(
        MODEL_PROVIDERS.map((p) => [p.providerId, p.models]),
      ),
      recentTickers,
    });
    const palette = new CommandPaletteComponent(tui, items);
    palette.onSelect = (action: PaletteAction) => {
      void (async () => {
        switch (action.kind) {
          case 'slash':
            await handleSlashCommand(action.command, `/${action.command}`);
            break;
          case 'session':
            {
              const full = await loadSession(action.id);
              if (full) resumeInto(full);
            }
            break;
          case 'provider':
            modelSelection.startSelection();
            break;
          case 'model':
            modelSelection.startSelection();
            break;
          case 'ticker':
            await handleSubmit(`Show me the latest news and price for ${action.symbol}`);
            break;
        }
      })();
    };
    palette.onCancel = () => {
      renderSelectionOverlay();
      tui.requestRender();
    };
    showScreenView(
      'Command Palette',
      'Fuzzy search · slash, sessions, providers, models, tickers',
      palette,
      'Esc to close',
      palette,
    );
  };

  /** Fetch fresh quotes for every watched ticker. Best-effort; never throws. */
  const refreshWatchlist = async () => {
    if (watchedTickers.length === 0) return;
    // Ponytail: use the cheapest snapshot tool we have. Today that's
    // `get_stock_price` (Financial Datasets). Providers gracefully throw
    // when their key is missing, so a missing key just leaves the cell empty.
    try {
      const { getStockPrice } = await import('./tools/finance/stock-price.js');
      for (const t of watchedTickers) {
        try {
          const raw = await getStockPrice.invoke({ ticker: t });
          const parsed = JSON.parse(raw as string);
          const snap = parsed.data?.snapshot ?? parsed.data;
          const price = Number(snap?.price ?? snap?.close ?? snap?.last?.price ?? null);
          const previous = watchlist['quotes']?.get?.(t);
          const history = [...(previous?.history ?? []), price].filter((n) => Number.isFinite(n)).slice(-30);
          watchlist.setQuote(t, Number.isFinite(price) ? price : null, history);
        } catch {
          // ignore individual ticker errors
        }
      }
    } catch {
      // ignore
    }
  };

  // Kick off an initial watchlist refresh after refreshWatchlist is defined.
  if (watchedTickers.length > 0) {
    void refreshWatchlist();
  }

  const handleSubmit = async (query: string) => {
    if (query.toLowerCase() === 'exit' || query.toLowerCase() === 'quit') {
      tui.stop();
      process.exit(0);
      return;
    }

    // Handle all slash commands
    if (query.startsWith('/')) {
      const command = query.slice(1).split(/\s+/)[0].trim().toLowerCase();
      slashActive = false;
      slashSuggestions = [];
      await handleSlashCommand(command, query);
      return;
    }

    if (
      modelSelection.isInSelectionFlow() ||
      searchSelection.isInSelectionFlow() ||
      agentRunner.pendingApproval
    ) {
      return;
    }

    // If agent is busy, enqueue the message for mid-run injection
    if (agentRunner.isProcessing) {
      defaultQueue.enqueue({
        text: query,
        priority: 'next',
        enqueuedAt: Date.now(),
        source: 'cli',
      });
      await inputHistory.saveMessage(query);
      chatLog.addQueuedMessage(query);
      tui.requestRender();
      return;
    }

    await inputHistory.saveMessage(query);
    inputHistory.resetNavigation();
    lastRenderedEventCount = 0;
    lastRenderedStatus = '';
    lastRenderedAnswer = false;
    finalizedToolIds.clear();
    const result = await agentRunner.runQuery(query);
    if (result?.answer) {
      await inputHistory.updateAgentResponse(result.answer);
      await sessionStore?.appendTurn(query, result.answer);
    }
    refreshError();
    tui.requestRender();
  };

  editor.onSubmit = (text) => {
    const displayValue = text.trim();
    if (!displayValue) return;
    const fullValue = editor.getFullText(displayValue);
    editor.setText('');
    editor.addToHistoryWithTruncation(fullValue);
    void handleSubmit(fullValue);
  };

  let escPendingClear = false;
  let escPendingExit = false;
  let escTimeout: ReturnType<typeof setTimeout> | null = null;

  // onEscape is wired after renderSelectionOverlay is defined (below)

  editor.onCtrlC = () => {
    if (modelSelection.isInSelectionFlow()) {
      modelSelection.cancelSelection();
      return;
    }
    if (searchSelection.isInSelectionFlow()) {
      searchSelection.cancelSelection();
      return;
    }
    if (agentRunner.isProcessing || agentRunner.pendingApproval) {
      agentRunner.cancelExecution();
      return;
    }
    tui.stop();
    process.exit(0);
  };

  editor.onCtrlP = () => {
    // Open the command palette regardless of whether the editor has text.
    void openCommandPalette();
  };

  /**
   * Update component state without rebuilding the tree.
   * The root is built once at init — this only changes text/hints/visibility.
   */
  const updateView = () => {
    refreshError();
    if (slashActive && slashSuggestions.length > 0) {
      hintBar.setSuggestions(slashSuggestions, slashSelectedIndex);
    } else {
      hintBar.clearSuggestions();
      hintBar.update({
        isProcessing: agentRunner.isProcessing,
        hasPendingApproval: !!agentRunner.pendingApproval,
        hasInput: editor.getText().trim().length > 0,
        escPendingClear,
        escPendingExit,
        queueLength: defaultQueue.length(),
      });
    }
    if (
      !modelSelection.isInSelectionFlow() &&
      !searchSelection.isInSelectionFlow() &&
      !agentRunner.pendingApproval &&
      !agentRunner.pendingQuestion &&
      activeOverlay === null
    ) {
      tui.setFocus(editor);
    }
  };

  /**
   * Show a full-screen selection view by replacing the root content.
   * Used for infrequent user-initiated overlays (model selection, approval).
   */
  const showScreenView = (
    title: string,
    description: string,
    body: any,
    footer?: string,
    focusTarget?: any,
  ) => {
    root.clear();
    root.addChild(createScreen(title, description, body, footer));
    if (focusTarget) {
      tui.setFocus(focusTarget);
    }
  };

  /**
   * Restore the main view after an overlay screen closes.
   */
  const restoreMainView = () => {
    root.clear();
    root.addChild(intro);
    root.addChild(chatLog);
    root.addChild(errorText);
    root.addChild(workingIndicator);
    root.addChild(statusBar);
    root.addChild(watchlist);
    root.addChild(spacer);
    root.addChild(editor);
    root.addChild(hintBar);
    root.addChild(debugPanel);
    updateView();
  };

  // Render the question widget INLINE: keep the conversation (intro + chatLog)
  // visible and slot the widget where the input normally sits, instead of
  // replacing the whole screen via showScreenView.
  const showQuestionInline = () => {
    if (!activeQuestionPrompt) return;
    root.clear();
    root.addChild(intro);
    root.addChild(chatLog);
    root.addChild(errorText);
    root.addChild(spacer);
    root.addChild(activeQuestionPrompt);
    root.addChild(debugPanel);
    tui.setFocus(activeQuestionPrompt);
  };

  const renderSelectionOverlay = () => {
    const state = modelSelection.state;
    const searchState = searchSelection.state;

    // Lightweight pickers for /theme and /sessions|/resume. Handled before the
    // idle short-circuit so an onChange-driven re-render keeps them on screen.
    if (activeOverlay === 'theme') {
      if (!themeSelector) {
        themeSelector = createChoiceSelector(
          THEMES.map((t, i) => ({
            value: t.name,
            label: `${i + 1}. ${t.label}${getActiveTheme() === t.name ? ' ✓' : ''}`,
          })),
          (value) => {
            if (value) {
              setActiveTheme(value as ThemeName);
              setSetting('theme', value);
              // Components bake colors into strings at build time, so a plain
              // re-render won't recolor existing content. Rebuild the intro and
              // replay the saved transcript so the WHOLE screen adopts the new
              // theme — the conversation stays visible, just recolored.
              intro.refresh();
              chatLog.clearAll();
              lastRenderedEventCount = 0;
              lastRenderedStatus = '';
              lastRenderedAnswer = false;
              lastRenderedQueryId = null;
              finalizedToolIds.clear();
              appliedToolProgress.clear();
              for (const turn of sessionStore?.turns ?? []) {
                chatLog.addQuery(turn.query);
                chatLog.finalizeAnswer(turn.answer);
              }
            }
            activeOverlay = null;
            themeSelector = null;
            renderSelectionOverlay();
            tui.requestRender();
          },
          THEMES.length + 1,
        );
      }
      showScreenView(
        'Select a theme',
        'Changes apply immediately and are saved for next time.',
        themeSelector,
        'Enter to confirm · esc to cancel',
        themeSelector,
      );
      return;
    }

    if (activeOverlay === 'session') {
      if (!sessionSelector) {
        sessionSelector = createChoiceSelector(
          sessionChoices.map((s, i) => {
            const turns = `${s.turnCount} turn${s.turnCount === 1 ? '' : 's'}`;
            const current = sessionStore && s.id === sessionStore.id ? ' (current)' : '';
            return {
              value: s.id,
              label: `${s.id}  ${s.title}${current}  ·  ${formatRelativeTime(s.updatedAt)} · ${turns}`,
            };
          }),
          (value) => {
            activeOverlay = null;
            sessionSelector = null;
            if (value) {
              void loadSession(value).then((full) => {
                if (full) resumeInto(full);
                renderSelectionOverlay();
                tui.requestRender();
              });
            } else {
              renderSelectionOverlay();
              tui.requestRender();
            }
          },
        );
      }
      showScreenView(
        'Resume a session',
        'Pick a conversation to continue — full context is restored.',
        sessionSelector,
        'Enter to resume · esc to cancel',
        sessionSelector,
      );
      return;
    }

    if (
      state.appState === 'idle' &&
      searchState.appState === 'idle' &&
      !agentRunner.pendingApproval &&
      !agentRunner.pendingQuestion
    ) {
      activeQuestionPrompt = null;
      restoreMainView();
      tui.requestRender();
      return;
    }

    if (agentRunner.pendingApproval) {
      const prompt = new ApprovalPromptComponent(
        agentRunner.pendingApproval.tool,
        agentRunner.pendingApproval.args,
      );
      prompt.onSelect = (decision: ApprovalDecision) => {
        agentRunner.respondToApproval(decision);
      };
      showScreenView('', '', prompt, undefined, prompt.selector);
      return;
    }

    if (agentRunner.pendingQuestion) {
      if (!activeQuestionPrompt) {
        activeQuestionPrompt = new QuestionPromptComponent(
          agentRunner.pendingQuestion.questions,
          tui,
        );
        activeQuestionPrompt.onSubmit = (answers) => {
          chatLog.addAnsweredQuestions(answers.answers);
          agentRunner.respondToQuestion(answers);
        };
        activeQuestionPrompt.onCancel = () => {
          agentRunner.respondToQuestion({ answers: [], declined: true });
        };
        activeQuestionPrompt.onAbort = () => {
          agentRunner.cancelExecution();
        };
      }
      showQuestionInline();
      return;
    }

    if (state.appState === 'provider_select') {
      const selector = createProviderSelector(modelSelection.provider, (providerId) => {
        void modelSelection.handleProviderSelect(providerId);
      });
      showScreenView(
        'Select provider',
        'Switch between LLM providers. Applies to this session and future sessions.',
        selector,
        'Enter to confirm · esc to exit',
        selector,
      );
      return;
    }

    if (state.appState === 'model_select' && state.pendingProvider) {
      const selector = createModelSelector(
        state.pendingModels,
        modelSelection.provider === state.pendingProvider ? modelSelection.model : undefined,
        (modelId) => modelSelection.handleModelSelect(modelId),
        state.pendingProvider,
      );
      showScreenView(
        `Select model for ${getProviderDisplayName(state.pendingProvider)}`,
        '',
        selector,
        'Enter to confirm · esc to go back',
        selector,
      );
      return;
    }

    if (state.appState === 'model_input' && state.pendingProvider) {
      const input = new ApiKeyInputComponent();
      input.onSubmit = (value) => modelSelection.handleModelInputSubmit(value);
      input.onCancel = () => modelSelection.handleModelInputSubmit(null);
      showScreenView(
        `Enter model name for ${getProviderDisplayName(state.pendingProvider)}`,
        'Type or paste the model name from openrouter.ai/models',
        input,
        'Examples: anthropic/claude-3.5-sonnet, openai/gpt-4-turbo, meta-llama/llama-3-70b\nEnter to confirm · esc to go back',
        input,
      );
      return;
    }

    if (state.appState === 'api_key_confirm' && state.pendingProvider) {
      const selector = createApiKeyConfirmSelector((wantsToSet) =>
        modelSelection.handleApiKeyConfirm(wantsToSet),
      );
      showScreenView(
        'Set API Key',
        `Would you like to set your ${getProviderDisplayName(state.pendingProvider)} API key?`,
        selector,
        'Enter to confirm · esc to decline',
        selector,
      );
      return;
    }

    if (state.appState === 'api_key_input' && state.pendingProvider) {
      const input = new ApiKeyInputComponent(true);
      input.onSubmit = (apiKey) => modelSelection.handleApiKeySubmit(apiKey);
      input.onCancel = () => modelSelection.handleApiKeySubmit(null);
      const apiKeyName = getApiKeyNameForProvider(state.pendingProvider) ?? '';
      showScreenView(
        `Enter ${getProviderDisplayName(state.pendingProvider)} API Key`,
        apiKeyName ? `(${apiKeyName})` : '',
        input,
        'Enter to confirm · Esc to cancel',
        input,
      );
      return;
    }

    if (searchState.appState === 'provider_select') {
      const selector = createSearchProviderSelector(
        searchState.preferredProvider,
        (providerId) => searchSelection.handleProviderSelect(providerId),
        () => searchSelection.cancelSelection(),
      );
      showScreenView(
        'Select web search provider',
        'Rubo tries your preferred provider first and falls back to the others.',
        selector,
        'Enter to confirm · esc to exit',
        selector,
      );
      return;
    }

    if (searchState.appState === 'api_key_confirm' && searchState.pendingProvider) {
      const selector = createApiKeyConfirmSelector((wantsToSet) =>
        searchSelection.handleApiKeyConfirm(wantsToSet),
      );
      showScreenView(
        'Set API Key',
        `Would you like to set your ${getSearchProviderDisplayName(searchState.pendingProvider)} API key?`,
        selector,
        'Enter to confirm · esc to decline',
        selector,
      );
      return;
    }

    if (searchState.appState === 'api_key_input' && searchState.pendingProvider) {
      const input = new ApiKeyInputComponent(true);
      input.onSubmit = (apiKey) => searchSelection.handleApiKeySubmit(apiKey);
      input.onCancel = () => searchSelection.handleApiKeySubmit(null);
      const apiKeyName = getApiKeyNameForSearchProvider(searchState.pendingProvider);
      showScreenView(
        `Enter ${getSearchProviderDisplayName(searchState.pendingProvider)} API Key`,
        `(${apiKeyName})`,
        input,
        'Enter to confirm · Esc to cancel',
        input,
      );
    }
  };

  // Wire callbacks that need renderSelectionOverlay (defined above)
  editor.onEscape = () => {
    if (modelSelection.isInSelectionFlow()) {
      modelSelection.cancelSelection();
      return;
    }
    if (searchSelection.isInSelectionFlow()) {
      searchSelection.cancelSelection();
      return;
    }
    if (agentRunner.isProcessing || agentRunner.pendingApproval) {
      agentRunner.cancelExecution();
      return;
    }

    const hasText = editor.getText().trim().length > 0;
    if (hasText) {
      // Double-Esc to clear input
      if (escPendingClear) {
        editor.setText('');
        escPendingClear = false;
        escPendingExit = false;
        if (escTimeout) { clearTimeout(escTimeout); escTimeout = null; }
      } else {
        escPendingClear = true;
        escPendingExit = false;
        if (escTimeout) clearTimeout(escTimeout);
        escTimeout = setTimeout(() => {
          escPendingClear = false;
          updateView();
          tui.requestRender();
        }, 2000);
      }
    } else {
      // Double-Esc to exit
      if (escPendingExit) {
        tui.stop();
        process.exit(0);
      } else {
        escPendingExit = true;
        escPendingClear = false;
        if (escTimeout) clearTimeout(escTimeout);
        escTimeout = setTimeout(() => {
          escPendingExit = false;
          updateView();
          tui.requestRender();
        }, 2000);
      }
    }
    updateView();
    tui.requestRender();
  };

  editor.onSlashChange = (text: string) => {
    slashSuggestions = matchCommands(text);
    slashSelectedIndex = 0;
    slashActive = slashSuggestions.length > 0;
    updateView();
    tui.requestRender();
  };

  editor.onSlashNavigate = (direction: 'up' | 'down') => {
    if (direction === 'down') {
      slashSelectedIndex = Math.min(slashSelectedIndex + 1, slashSuggestions.length - 1);
    } else {
      slashSelectedIndex = Math.max(slashSelectedIndex - 1, 0);
    }
    updateView();
    tui.requestRender();
  };

  editor.onSlashSelect = () => {
    const selected = slashSuggestions[slashSelectedIndex];
    if (selected) {
      slashActive = false;
      slashSuggestions = [];
      editor.setText('');
      void handleSlashCommand(selected.name, `/${selected.name}`);
    }
    updateView();
    tui.requestRender();
  };

  editor.onSlashDismiss = () => {
    slashActive = false;
    slashSuggestions = [];
    updateView();
    tui.requestRender();
  };

  await inputHistory.init();
  for (const msg of inputHistory.getMessages().reverse()) {
    editor.addToHistoryWithTruncation(msg);
  }

  // Resume a prior session at startup if requested via `rubo --resume [id]`.
  if (resumeRequest.resume) {
    const target = resumeRequest.id ? await loadSession(resumeRequest.id) : await latestSession();
    if (target && target.turns.length > 0) {
      resumeInto(target);
    } else {
      chatLog.addChild(new Spacer(1));
      chatLog.addChild(
        new Text(
          theme.muted(
            resumeRequest.id
              ? `No session found with id "${resumeRequest.id}". Starting fresh.`
              : 'No previous session to resume. Starting fresh.',
          ),
          0,
          0,
        ),
      );
    }
  }

  renderSelectionOverlay();
  refreshError();

  tui.start();
  // pi-tui's first paint deliberately does NOT clear the screen ("assumes clean
  // screen"), and it leaves its UI on the terminal when a previous run exits.
  // That stranded a stale, empty input box above the welcome banner whenever
  // Rubo was relaunched in a dirty terminal. Force one clean full redraw
  // (clears scrollback + screen) so we always start pristine and never duplicate
  // the input box.
  tui.requestRender(true);
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    process.once('exit', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });

  workingIndicator.dispose();
  debugPanel.dispose();
}
