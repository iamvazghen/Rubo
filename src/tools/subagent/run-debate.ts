/**
 * Multi-agent debate orchestrator. Spawns 4 specialist subagents in PARALLEL:
 *   1. bull    - general-purpose research view
 *   2. bear    - devils-advocate view
 *   3. quant   - numerical analysis (comps, dcf, position-sizing)
 *   4. macro   - macro overlay
 * Then a `judge` subagent synthesizes the four into one conclusion.
 *
 * Phase 4 fix #3: runs specialists in parallel (was sequential). On a 90-second
 * subagent budget, parallel execution drops total wall time from ~7min to ~90s.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { debateVerdict, jevAvailable, type DebateVerdict } from '../../judge/jev.js';
import {
  SUBAGENT_TYPES,
  DEFAULT_SUBAGENT_TYPE,
  resolveSubagentTools,
} from './types.js';

export const RUN_DEBATE_DESCRIPTION = `
Run a full multi-agent debate on a single investment thesis. Spawns 4 specialist
subagents IN PARALLEL (bull / bear / quant / macro) and a judge subagent to
synthesize. Wall time is roughly the slowest specialist + judge (~60-120s),
not the sum of all four.

Returns the four specialist views plus the judge's structured conclusion
(BULL / BEAR / NEUTRAL with conviction + time horizon).

Use this for high-conviction trades where the user wants the strongest possible
counter-argument surfaced before committing capital.
`.trim();

const RunDebateInputSchema = z.object({
  thesis: z.string().describe('The investment thesis to debate (e.g., "Long NVDA: AI capex cycle extends through FY27, datacenters build out doubles again").'),
  ticker: z.string().optional().describe('Optional ticker for context.'),
  context: z.string().optional().describe('Optional additional context (current price, position size, etc.).'),
  /** Per-specialist time budget in milliseconds (default 5 minutes). */
  specialist_timeout_ms: z.number().int().min(30000).max(600000).default(300000).optional(),
});

interface SpecialistOutput {
  role: 'bull' | 'bear' | 'quant' | 'macro' | 'judge';
  answer: string;
  duration_ms: number;
  /** True if the specialist timed out and returned partial output. */
  timed_out?: boolean;
}

async function runSpecialistWithTimeout(
  model: string,
  type: string,
  prompt: string,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  onProgress?: (msg: string) => void,
): Promise<SpecialistOutput> {
  const t0 = Date.now();
  const { Agent } = await import('../../agent/agent.js');
  const typeCfg = SUBAGENT_TYPES[type] ?? SUBAGENT_TYPES[DEFAULT_SUBAGENT_TYPE];
  const toolAllowlist = resolveSubagentTools(type);
  // Per-subagent AbortController that we abort on timeout. Combined with the
  // parent's signal so cancellation cascades.
  const subController = new AbortController();
  const chainedSignal = parentSignal
    ? anySignal([parentSignal, subController.signal])
    : subController.signal;

  const subagent = await Agent.create({
    model,
    maxIterations: typeCfg.maxIterations,
    signal: chainedSignal,
    memoryEnabled: false,
    toolAllowlist,
    systemPromptOverride: typeCfg.systemPrompt,
    agentLabel: type,
  });

  let answer = '';
  let timedOut = false;

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  try {
    const iterPromise = (async () => {
      for await (const ev of subagent.run(prompt)) {
        if (ev.type === 'done') answer = ev.answer;
      }
    })();

    await Promise.race([iterPromise, timeoutPromise]);
  } catch {
    // Swallow — fall through with whatever we got.
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // Best-effort abort of the subagent so it doesn't keep running.
    try { subController.abort(); } catch { /* ignore */ }
  }

  return {
    role: type === 'devils-advocate' ? 'bear' : (type as never),
    answer: answer || `(specialist timed out after ${Math.round(timeoutMs / 1000)}s without producing an answer)`,
    duration_ms: Date.now() - t0,
    timed_out: timedOut,
  };
}

/** Combine multiple AbortSignals into one that fires when any does. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) ctrl.abort();
    else s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

export function createRunDebate(model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'run_debate',
    description: 'Run a 4-specialist investment debate + judge synthesis. High cost; reserve for high-conviction trades.',
    schema: RunDebateInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
      const signal = config?.signal as AbortSignal | undefined;
      const timeoutMs = input.specialist_timeout_ms ?? 300_000;

      const baseContext = [
        input.ticker ? `Ticker: ${input.ticker}` : null,
        input.context ? `Context: ${input.context}` : null,
      ].filter(Boolean).join('\n');

      const specialists: Array<{ role: SpecialistOutput['role']; type: string; prompt: string }> = [
        {
          role: 'bull',
          type: 'general-purpose',
          prompt: `Construct the strongest possible BULL case for this thesis. Use data, precedent, and named catalysts. Do NOT acknowledge the bear case - your job is to make the strongest affirmative argument.\n\nThesis: ${input.thesis}${baseContext ? `\n\n${baseContext}` : ''}`,
        },
        {
          role: 'bear',
          type: 'devils-advocate',
          prompt: `${input.thesis}${baseContext ? `\n\n${baseContext}` : ''}`,
        },
        {
          role: 'quant',
          type: 'analysis',
          prompt: `Provide a QUANTITATIVE analysis of this thesis. Use comps, DCF, reverse-DCF, or position-sizing math. Be specific with numbers.\n\nThesis: ${input.thesis}${baseContext ? `\n\n${baseContext}` : ''}`,
        },
        {
          role: 'macro',
          type: 'macro-overlay',
          prompt: `${input.thesis}${baseContext ? `\n\n${baseContext}` : ''}`,
        },
      ];

      const t0All = Date.now();
      onProgress?.(`Debate: launching ${specialists.length} specialists in parallel…`);

      // PARALLEL execution: Promise.all. The slowest specialist defines the
      // wall time. Total budget = max(specialist) + judge.
      const specialistOutputs = await Promise.all(
        specialists.map(async (s, i) => {
          const tStart = Date.now();
          onProgress?.(`Debate: ${s.role} started (${i + 1}/${specialists.length})…`);
          const result = await runSpecialistWithTimeout(model, s.type, s.prompt, signal, timeoutMs);
          const elapsed = Date.now() - tStart;
          onProgress?.(`Debate: ${s.role} done in ${Math.round(elapsed / 1000)}s`);
          return result;
        }),
      );

      // Run the judge sequentially after all specialists complete (the judge
      // needs their outputs as input).
      const t1Judge = Date.now();
      const judgeTask = `Investment debate to synthesize:

Thesis: ${input.thesis}${baseContext ? `\n\n${baseContext}` : ''}

${specialistOutputs.map((o) => `### ${o.role.toUpperCase()} VIEW\n${o.answer}`).join('\n\n')}

Synthesize the four specialist views above into one coherent conclusion. Follow your standard judge workflow.`;

      let judgeAnswer = '';
      let judgeTimedOut = false;
      try {
        const { Agent } = await import('../../agent/agent.js');
        const judgeCfg = SUBAGENT_TYPES['judge'] ?? SUBAGENT_TYPES[DEFAULT_SUBAGENT_TYPE];
        const judgeAllowlist = resolveSubagentTools('judge');
        const judgeController = new AbortController();
        const judgeSignal = signal
          ? anySignal([signal, judgeController.signal])
          : judgeController.signal;
        const judge = await Agent.create({
          model,
          maxIterations: judgeCfg.maxIterations,
          signal: judgeSignal,
          memoryEnabled: false,
          toolAllowlist: judgeAllowlist,
          systemPromptOverride: judgeCfg.systemPrompt,
          agentLabel: 'judge',
        });

        const judgeTimeoutHandle = setTimeout(() => { judgeTimedOut = true; }, timeoutMs);
        try {
          const iterPromise = (async () => {
            for await (const ev of judge.run(judgeTask)) {
              if (ev.type === 'done') judgeAnswer = ev.answer;
            }
          })();
          await Promise.race([
            iterPromise,
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
          ]);
        } finally {
          clearTimeout(judgeTimeoutHandle);
          try { judgeController.abort(); } catch { /* ignore */ }
        }
      } catch (err) {
        judgeAnswer = `Judge synthesis failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      const total_ms = Date.now() - t0All;
      const outputs: SpecialistOutput[] = [
        ...specialistOutputs,
        { role: 'judge', answer: judgeAnswer, duration_ms: Date.now() - t1Judge, timed_out: judgeTimedOut },
      ];

      // Jev's calibrated verdict next to the judge's prose, when a key is set.
      // A probability, never a replacement for the synthesis.
      let jevVerdict: DebateVerdict | null = null;
      if (jevAvailable() && !judgeTimedOut) {
        onProgress?.('Debate: asking Jev for a calibrated verdict…');
        const view = (role: SpecialistOutput['role']) => outputs.find((o) => o.role === role)?.answer ?? '';
        jevVerdict = await debateVerdict({
          thesis: input.thesis,
          ticker: input.ticker,
          views: { bull: view('bull'), bear: view('bear'), quant: view('quant'), macro: view('macro'), judge: view('judge') },
        });
      }

      return formatToolResult({
        thesis: input.thesis,
        ticker: input.ticker,
        specialist_outputs: outputs,
        judge_synthesis: judgeAnswer,
        ...(jevVerdict ? { jev_verdict: { ...jevVerdict, note: 'Jev (TypeSafe) probabilities over the debate as argued; present as probabilities' } } : {}),
        total_duration_ms: total_ms,
        parallel_execution: true,
        timed_out_count: outputs.filter((o) => o.timed_out).length,
      });
    },
  });
}