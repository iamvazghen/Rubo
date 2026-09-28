import { buildCompactToolDescriptions } from '../tools/registry.js';
import { buildSkillMetadataSection, discoverSkills } from '../skills/index.js';
import { PortfolioStore } from '../tools/portfolio/index.js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChannelProfile } from './channels.js';
import { ruboPath } from '../utils/paths.js';
import { getCurrentDate } from '../utils/format.js';
import { DEFAULT_SYSTEM_PROMPT } from './default-prompt.js';
import type { GroupContext } from './types.js';

export type { GroupContext };
export { DEFAULT_SYSTEM_PROMPT };

export { getCurrentDate };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Load SOUL.md content from user override or bundled file.
 */
export async function loadSoulDocument(): Promise<string | null> {
  const userSoulPath = ruboPath('SOUL.md');
  try {
    return await readFile(userSoulPath, 'utf-8');
  } catch {
    // Continue to bundled fallback when user override is missing/unreadable.
  }

  const bundledSoulPath = join(__dirname, '../../SOUL.md');
  try {
    return await readFile(bundledSoulPath, 'utf-8');
  } catch {
    // SOUL.md is optional; keep prompt behavior unchanged when absent.
  }

  return null;
}

/**
 * Load user-defined research rules from .rubo/RULES.md.
 * Returns null if the file doesn't exist (rules are optional).
 */
export async function loadRulesDocument(): Promise<string | null> {
  const rulesPath = ruboPath('RULES.md');
  try {
    return await readFile(rulesPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Build the skills section for the system prompt.
 * Only includes skill metadata if skills are available.
 */
function buildSkillsSection(): string {
  const skills = discoverSkills();
  
  if (skills.length === 0) {
    return '';
  }

  const skillList = buildSkillMetadataSection();
  
  return `## Available Skills

${skillList}

## Skill Usage Policy

- Check if available skills can help complete the task more effectively
- When a skill is relevant, invoke it IMMEDIATELY as your first action
- Skills provide specialized workflows for complex tasks (e.g., DCF valuation)
- Do not invoke a skill that has already been invoked for the current query`;
}

function buildMemorySection(memoryFiles: string[], memoryContext?: string | null): string {
  const fileListSection = memoryFiles.length > 0
    ? `\nMemory files on disk: ${memoryFiles.join(', ')}`
    : '';

  const contextSection = memoryContext
    ? `\n\n### What you know about the user\n\n${memoryContext}`
    : '';

  return `## Memory

You have persistent memory stored as Markdown files in .rubo/memory/.${fileListSection}${contextSection}

### Recalling memories
Use memory_search to recall stored facts, preferences, or notes. The search covers all
memory files (long-term and daily logs) AND past conversation transcripts.

**IMPORTANT:** Before giving any personalized financial advice — buy/sell decisions,
portfolio suggestions, stock recommendations, or trade sizing — ALWAYS call memory_search
first to recall the user's goals, risk tolerance, position limits, and prior decisions.
The user expects you to know them. Do not give generic advice when personalized context exists.

Follow up with memory_get to read full sections when you need exact text.

### Storing and managing memories
Use **memory_update** to add, edit, or delete memories. Do NOT use write_file or
edit_file for memory files.
- To remember something, just pass content (defaults to appending to long-term memory).
- For daily notes, pass file="daily".
- For edits/deletes, pass action="edit" or action="delete" with old_text.
Before editing or deleting, use memory_get to verify the exact text to match.`;
}

/**
 * Build a compact portfolio summary to inject into the system prompt. Empty
 * when the user has no positions, so the prompt stays short. Reads live
 * from the portfolio store every call — cheap JSON file read on the main
 * thread.
 *
 * The agent should always call `portfolio_view` (the tool) for the canonical,
 * full data; this summary is just a hint so the agent has context without
 * spending a tool call.
 */
function buildPortfolioSection(): string {
  const portfolio = new PortfolioStore().read();
  if (portfolio.positions.length === 0 && portfolio.notes.length === 0 && !portfolio.total_capital_usd) {
    return '';
  }

  const lines: string[] = ['## User Portfolio (summary)', ''];

  if (portfolio.total_capital_usd || portfolio.risk_budget_pct || portfolio.max_drawdown_pct) {
    const parts: string[] = [];
    if (portfolio.total_capital_usd) parts.push(`Capital: $${portfolio.total_capital_usd.toLocaleString()}`);
    if (portfolio.risk_budget_pct) parts.push(`Risk/trade: ${portfolio.risk_budget_pct}%`);
    if (portfolio.max_drawdown_pct) parts.push(`Max DD: ${portfolio.max_drawdown_pct}%`);
    lines.push(parts.join(' · '));
  }

  if (portfolio.positions.length > 0) {
    lines.push(`Open positions: ${portfolio.positions.length}`);
    for (const pos of portfolio.positions) {
      const target = pos.target_price ? `tgt ${pos.target_price} ${pos.currency}` : 'no target';
      const stop = pos.stop_loss ? `stop ${pos.stop_loss}` : 'no stop';
      lines.push(`- ${pos.ticker} ${pos.shares} @ ${pos.avg_cost} ${pos.currency} · ${pos.conviction} · ${target} · ${stop} · "${pos.thesis}"`);
    }
  }

  if (portfolio.notes.length > 0) {
    lines.push('');
    lines.push('User notes:');
    for (const note of portfolio.notes.slice(0, 5)) {
      lines.push(`- ${note}`);
    }
  }

  lines.push('');
  lines.push('Call `portfolio_view` for the full structured data. `memory_search` for past conversations. `portfolio_remove` to close a trade (records P&L + lesson).');

  return lines.join('\n');
}

// ============================================================================
// Group Chat Context
// ============================================================================


/**
 * Build a system prompt section for group chat context.
 */
export function buildGroupSection(ctx: GroupContext): string {
  const lines: string[] = ['## Group Chat'];
  lines.push('');
  if (ctx.groupName) {
    lines.push(`You are participating in the group chat "${ctx.groupName}".`);
  } else {
    lines.push('You are participating in a group chat.');
  }
  lines.push('You were activated because someone @-mentioned you.');
  lines.push('');
  lines.push('### Group behavior');
  lines.push('- Address the person who mentioned you by name');
  lines.push('- Reference recent group context when relevant');
  lines.push('- Keep responses concise — this is a group chat, not a 1:1 conversation');
  lines.push('- Do not repeat information that was already shared in the group');

  if (ctx.membersList) {
    lines.push('');
    lines.push('### Group members');
    lines.push(ctx.membersList);
  }

  return lines.join('\n');
}

// ============================================================================
// System Prompt
// ============================================================================

/**
 * Build the system prompt for the agent.
 * @param model - The model name (used to get appropriate tool descriptions)
 * @param soulContent - Optional SOUL.md identity content
 * @param channel - Delivery channel (e.g., 'telegram', 'cli') — selects formatting profile
 */
export function buildSystemPrompt(
  model: string,
  soulContent?: string | null,
  channel?: string,
  groupContext?: GroupContext,
  memoryFiles?: string[],
  memoryContext?: string | null,
  rulesContent?: string | null,
): string {
  const toolDescriptions = buildCompactToolDescriptions(model);
  const profile = getChannelProfile(channel);

  const behaviorBullets = profile.behavior.map(b => `- ${b}`).join('\n');
  const formatBullets = profile.responseFormat.map(b => `- ${b}`).join('\n');

  const tablesSection = profile.tables
    ? `\n## Tables (for comparative/tabular data)\n\n${profile.tables}`
    : '';

  // Everything above the first volatile character is a cacheable prefix, and
  // MiniMax caches automatically on prefix match. "Current date" used to sit on
  // line 3, above the ~20k tokens of tool list, policy and skills - so at every
  // midnight the date changed and the entire block behind it was re-billed.
  // Measured: an identical prompt caches 93%, the same prompt with tomorrow's
  // date caches 0%. It lives in the volatile tail now, with memory and the
  // portfolio, so a rollover costs only the tail.
  return `You are Rubo, a ${profile.label} assistant with access to research tools.

${profile.preamble}

## Available Tools

${toolDescriptions}

## Tool Usage Policy

- Call get_financials or get_market_data ONCE with the full natural language query — they handle multi-company/multi-metric requests internally. Do NOT break up queries into multiple calls.
- Only use web_fetch when headlines are insufficient (need quotes, deal specifics, earnings details).
- Tool results are automatically capped. If a result says "persisted to file", use read_file to access specific sections rather than processing the full dataset.
- Use spawn_subagent to delegate a focused, self-contained sub-task (deep research on one topic, analysis of one company) when it keeps your own context clean or when sub-tasks are independent.
- For INDEPENDENT sub-tasks, emit multiple spawn_subagent calls in a SINGLE turn — they run in parallel. Chain across turns only when one sub-task depends on another's output.
- Each subagent runs in isolation and cannot see this conversation; put everything it needs in the task (and context), and give a short 3-5 word description for the UI. It returns one final answer for you to synthesize. Don't delegate trivial single-tool lookups you can do directly.
- Only respond directly for conceptual definitions, stable historical facts, or conversational queries.

${buildSkillsSection()}

## Current Context

Current date: ${getCurrentDate()}

${buildMemorySection(memoryFiles ?? [], memoryContext)}

${buildPortfolioSection()}

## Behavior

${behaviorBullets}

${rulesContent ? `## Research Rules

The following rules were set by the user. Follow them on every query.

${rulesContent}
` : ''}
## Rule Management

To manage research rules, the user can say "add a rule", "show my rules", "remove rule about X".
Rules are stored in .rubo/RULES.md — use write_file or edit_file to modify them.

${soulContent ? `## Identity

${soulContent}

Embody the identity and investing philosophy described above. Let it shape your tone, your values, and how you engage with financial questions.
` : ''}

## Response Format

${formatBullets}${tablesSection}${groupContext ? '\n\n' + buildGroupSection(groupContext) : ''}`;
}

// ============================================================================
// User Prompts
// ============================================================================


