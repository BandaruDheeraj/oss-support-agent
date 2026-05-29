/**
 * Tool registry composition factories per agent role.
 *
 * Each factory returns a fresh ToolRegistry with the right tier of tools
 * registered and budgets sized for that agent.
 */

import { ToolRegistry } from './registry';
import { READ_TOOLS } from './read';
import { NOTE_META_TOOLS, note, stateHypothesis, recordEvidence, writeInvestigationNotes, commitPlan, revisePlan, deepenInvestigation, done, abandon } from './note-meta';
import { WRITE_TEST_TOOLS } from './write-test';
import { MUTATION_TOOLS } from './mutation';
import { SANDBOX_TOOLS } from './sandbox';
import { deriveVerifiedState, renderVerifiedState } from '../repro-loop-v2/verified-state';
import type { ToolContext, RegistryBudgets, TranscriptEntry } from './types';

export interface RegistryFactoryArgs {
  ctx: Omit<ToolContext, 'recordTranscript' | 'getTranscript'>;
}

function defaultBudgets(overrides: Partial<RegistryBudgets> = {}): RegistryBudgets {
  return {
    total: overrides.total ?? 80,
    perTier: {
      read: 60,
      note: 20,
      'write-test': 6,
      mutation: 10,
      sandbox: 12,
      meta: 8,
      ...overrides.perTier,
    },
  };
}

export function makeAnalystRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    {
      budgets: defaultBudgets({ total: 40, perTier: { mutation: 0, 'write-test': 0, sandbox: 0 } }),
      maxTurns: 14,
      abandonGate: (transcript) => {
        const readCalls = transcript.filter((t) => t.tier === 'read' && t.ok).length;
        const usedSymbolSearch = transcript.some(
          (t) => t.ok && (t.tool === 'grep' || t.tool === 'find_symbol' || t.tool === 'find_callers'),
        );
        if (readCalls < 4) {
          return `abandon is forbidden before you have made at least 4 successful read-tier tool calls (you have ${readCalls}). Use gh_issue, grep, find_symbol, read_file to gather evidence first. record_evidence with low confidence is preferred over abandon.`;
        }
        if (!usedSymbolSearch) {
          return 'abandon is forbidden before you have searched for symbols. Call grep or find_symbol to locate the code referenced in the issue. record_evidence with low confidence is preferred over abandon.';
        }
        return null;
      },
    },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, recordEvidence, abandon]);
}

export function makeFixInvestigatorRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    {
      budgets: defaultBudgets({ total: 50, perTier: { mutation: 0, 'write-test': 0, sandbox: 0 } }),
      maxTurns: 18,
      abandonGate: (transcript) => {
        const reads = transcript.filter((t) => t.tier === 'read' && t.ok).length;
        const wroteNotes = transcript.some((t) => t.tool === 'write_investigation_notes' && t.ok);
        if (reads < 4) {
          return `abandon is forbidden before you have made at least 4 successful read-tier tool calls (you have ${reads}). Investigate the dossier suspects with grep/find_symbol/read_file first.`;
        }
        if (!wroteNotes) {
          return 'abandon is forbidden before you have written investigation notes. Call write_investigation_notes with your best root-cause hypothesis (low confidence is acceptable) instead of abandoning.';
        }
        return null;
      },
    },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, stateHypothesis, writeInvestigationNotes, abandon]);
}

export function makeFixPlannerRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    {
      budgets: defaultBudgets({ total: 35, perTier: { mutation: 0, 'write-test': 0, sandbox: 0 } }),
      maxTurns: 10,
      abandonGate: (transcript) => {
        const reads = transcript.filter((t) => t.tier === 'read' && t.ok).length;
        const committed = transcript.some((t) => t.tool === 'commit_plan' && t.ok);
        if (reads < 2) {
          return `abandon is forbidden before you have made at least 2 successful read-tier tool calls (you have ${reads}). Read the dossier evidence first.`;
        }
        if (!committed) {
          return 'abandon is forbidden before you have called commit_plan with at least one step. Author a minimal plan from the investigation notes — the executor and critic will refine it.';
        }
        return null;
      },
    },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, commitPlan, abandon]);
}

export function makeFixExecutorRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    {
      budgets: defaultBudgets({ total: 120 }),
      maxTurns: 30,
      abandonGate: (transcript) => {
        const patched = transcript.some((t) => t.tool === 'apply_patch' && t.ok);
        const ranTests = transcript.filter(
          (t) => t.ok && (t.tool === 'run_repro' || t.tool === 'run_tests'),
        ).length;
        if (!patched) {
          return 'abandon is forbidden before you have applied at least one patch with apply_patch. Make your best attempt at the fix from the plan, then run_repro/run_tests to validate.';
        }
        if (ranTests < 1) {
          return 'abandon is forbidden before you have run the tests at least once. Call run_repro or run_tests to observe the result of your patch.';
        }
        return null;
      },
    },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([...NOTE_META_TOOLS])
    .registerMany([...WRITE_TEST_TOOLS])
    .registerMany([...MUTATION_TOOLS])
    .registerMany([...SANDBOX_TOOLS]);
}

export function makeFixCriticRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    {
      budgets: defaultBudgets({ total: 40, perTier: { mutation: 0, 'write-test': 0 } }),
      maxTurns: 12,
      abandonGate: (transcript) => {
        const sawDiff = transcript.some((t) => t.tool === 'read_diff' && t.ok);
        if (!sawDiff) {
          return 'abandon is forbidden before you have called read_diff. Read the diff first — the orchestrator needs a verdict (reject/revise), not an abandon, even if the diff looks bad.';
        }
        return null;
      },
    },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, abandon])
    .registerMany([...SANDBOX_TOOLS]);
}

export function makeReproPlannerRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    { budgets: defaultBudgets({ total: 30, perTier: { mutation: 0, 'write-test': 0, sandbox: 0 } }), maxTurns: 8 },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, abandon]);
}

export function makeReproExecutorRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    {
      // sandbox cap raised from default 12 → 30: the Prober/Executor
      // legitimately needs probes (python_module_check, run_python, pip_install)
      // PLUS many run_repro iterations against the candidate test. At 12 the
      // probe phase alone exhausts the budget and every subsequent run_repro
      // is rejected with budget_exhausted (result.exitCode undefined → counted
      // as run_repro_errored), so pytest never actually runs.
      budgets: defaultBudgets({ total: 70, perTier: { mutation: 0, sandbox: 30 } }),
      maxTurns: 22,
      // Probe-first soft gates (Commit B). Forces the Executor to actually
      // exercise its tools before authoring/revising a test, AND to observe
      // a run_repro between rewrites — so it can't default to the legacy
      // "write the whole test first, hope it works" pattern, nor blind-loop
      // on write_test/revise_test. Rejection messages embed the rendered
      // verified-state ledger so the model sees what's been established.
      toolGates: {
        write_test: (transcript) =>
          gateRequirePriorProbe(transcript) ?? gateRequireRunReproSinceLastWrite(transcript),
        revise_test: (transcript) =>
          gateRequirePriorProbe(transcript) ?? gateRequireRunReproSinceLastWrite(transcript),
      },
      abandonGate: (transcript) => {
        const wroteTest = transcript.some(
          (t) => (t.tool === 'write_test' || t.tool === 'revise_test') && t.ok,
        );
        const ranRepro = transcript.filter((t) => t.tool === 'run_repro' && t.ok).length;
        if (!wroteTest) {
          return 'abandon is forbidden before you have authored a candidate test. Call write_test to create the candidate test file, then run_repro at least twice, before considering abandon.';
        }
        if (ranRepro < 2) {
          return `abandon is forbidden before you have run_repro at least twice (you have ${ranRepro}). Revise the test and run_repro again before considering abandon.`;
        }
        // Install-fatigue gate: if pip_install has failed 2+ times and the
        // model has never revised the test OR hasn't run_repro AFTER the
        // most recent revise_test, block abandon. Forces an architectural
        // pivot (typically a direct-call path that bypasses the heavy
        // framework) before giving up. The previous gate only required
        // write_test + 2*run_repro, which is satisfied by the failing
        // verbatim attempt alone — and the next stricter version was
        // bypassable by a trivial revise_test.
        const failedInstalls = transcript.filter(
          (t) => t.tool === 'pip_install' && (!t.ok || (t.result as any)?.exitCode !== 0)
        ).length;
        const lastRevise = transcript
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => t.tool === 'revise_test' && t.ok)
          .pop();
        const ranReproAfterRevise = lastRevise
          ? transcript.slice(lastRevise.i + 1).some((t) => t.tool === 'run_repro' && t.ok)
          : false;
        if (failedInstalls >= 2 && !ranReproAfterRevise) {
          return (
            `abandon is forbidden: you have ${failedInstalls} failed pip_install attempts ` +
            `but no revise_test followed by a fresh run_repro. Install-fatigue is treated as environmental ` +
            `incompatibility — STOP installing the heavy framework and instead revise_test to a direct-call ` +
            `path that imports the suspect symbol straight from its underlying package (e.g. ` +
            `opentelemetry.trace.NonRecordingSpan instead of the framework wrapper). Then run_repro on the ` +
            `revised test. Abandon becomes available only after that observation.`
          );
        }
        return null;
      },
    },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, deepenInvestigation, done, abandon])
    .registerMany([...WRITE_TEST_TOOLS])
    .registerMany([...SANDBOX_TOOLS]);
}

/**
 * Prober `done`-gate logic — exported for unit testing. Returns null when
 * the transcript carries a structurally-valid recipe and the done call may
 * proceed; otherwise returns a guidance string the registry surfaces as a
 * ToolGuardError. The contract enforced:
 *   1. There is a successful record_evidence call with recipe_recorded=true.
 *   2. That call's args.reproRecipe has candidateTestPath + sentinelString.
 *   3. Some prior successful write_test/revise_test wrote to that path.
 *   4. After that write and before the record_evidence call, ≥2 successful
 *      run_repro calls produced exit≠0 with sentinelString in stdout+stderr.
 */
export function reproProberDoneGate(transcript: TranscriptEntry[]): string | null {
  type RecipeArgs = { reproRecipe?: { candidateTestPath?: string; sentinelString?: string } };
  let recipeEntryIdx = -1;
  let recipeArgs: RecipeArgs | undefined;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.tool !== 'record_evidence' || !e.ok) continue;
    if ((e.result as any)?.recipe_recorded !== true) continue;
    recipeEntryIdx = i;
    recipeArgs = (e.args ?? undefined) as RecipeArgs | undefined;
    break;
  }
  if (recipeEntryIdx < 0 || !recipeArgs?.reproRecipe) {
    return (
      `done is blocked: you have not yet emitted a ReproRecipe via record_evidence. ` +
      `Once your candidate test has produced two consecutive failing run_repro calls ` +
      `with the sentinel in stderr/stdout, call record_evidence with the full reproRecipe ` +
      `payload (candidateTestPath, testSource, sentinelString, expectedFailureSignature, ` +
      `pipInstalls, requiresCredentials, verbatimSnippetIncompatible, and a provenance ` +
      `block including observedProbe populated from your most recent run_repro). Only ` +
      `then call done.`
    );
  }
  const candidateTestPath = recipeArgs.reproRecipe.candidateTestPath;
  const sentinelString = recipeArgs.reproRecipe.sentinelString;
  if (!candidateTestPath || !sentinelString) {
    return `done is blocked: the recorded reproRecipe is missing candidateTestPath or sentinelString. Re-emit record_evidence with a complete recipe payload before calling done.`;
  }
  let writeIdx = -1;
  for (let i = recipeEntryIdx - 1; i >= 0; i--) {
    const e = transcript[i];
    if ((e.tool === 'write_test' || e.tool === 'revise_test') && e.ok) {
      const path = (e.args as any)?.path;
      if (typeof path === 'string' && path === candidateTestPath) {
        writeIdx = i;
        break;
      }
    }
  }
  if (writeIdx < 0) {
    return `done is blocked: reproRecipe.candidateTestPath="${candidateTestPath}" does not match the path of any prior successful write_test/revise_test call. Either fix the recipe path or write the test at the recipe path, then re-emit record_evidence.`;
  }
  let failingWithSentinel = 0;
  for (let i = writeIdx + 1; i < recipeEntryIdx; i++) {
    const e = transcript[i];
    if (e.tool !== 'run_repro' || !e.ok) continue;
    const res = e.result as { exitCode?: number; stdout?: string; stderr?: string } | null;
    if (!res || typeof res.exitCode !== 'number' || res.exitCode === 0) continue;
    const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    if (combined.includes(sentinelString)) failingWithSentinel += 1;
  }
  if (failingWithSentinel < 2) {
    return (
      `done is blocked: the reproRecipe requires two consecutive failing run_repro calls ` +
      `with sentinel "${sentinelString}" in combined stdout+stderr after the write of ` +
      `"${candidateTestPath}". Observed only ${failingWithSentinel} such call(s). Run run_repro ` +
      `until you see two failing observations with the sentinel, then re-emit record_evidence ` +
      `with provenance.observedProbe populated from the latest run.`
    );
  }
  return null;
}

/**
 * Prober `abandon`-gate logic — exported for unit testing. Returns null when
 * the registry should allow the abandon call to proceed; otherwise returns a
 * guidance string the registry surfaces as a ToolGuardError. Contract:
 *   1. Must have authored at least one test (write_test or revise_test).
 *   2. Must have called run_repro at least twice (e.ok).
 *   3. POSITIVE-signal gate: if the derived verified state shows ≥1
 *      run_repro since the latest test write with exitCode!=0 AND the
 *      sentinel present in stdout+stderr, abandon is forbidden — the
 *      model must record_evidence (after one more confirming run if it
 *      only has 1 positive observation) instead of bailing.
 *   4. Install-fatigue fallback: if pip_install has failed ≥2 times and
 *      there's been no revise_test+run_repro since, the model must pivot
 *      to a direct-call path before considering abandon.
 */
export function reproProberAbandonGate(transcript: TranscriptEntry[]): string | null {
  const wroteTest = transcript.some(
    (t) => (t.tool === 'write_test' || t.tool === 'revise_test') && t.ok,
  );
  const ranRepro = transcript.filter((t) => t.tool === 'run_repro' && t.ok).length;
  if (!wroteTest) {
    return 'abandon is forbidden before you have authored a candidate test. Call write_test to create the candidate test file, then run_repro at least twice, before considering abandon.';
  }
  if (ranRepro < 2) {
    return `abandon is forbidden before you have run_repro at least twice (you have ${ranRepro}). Revise the test and run_repro again before considering abandon.`;
  }
  const state = deriveVerifiedState(transcript);
  if (state.runReproPositiveSinceWrite >= 1) {
    return (
      `abandon is forbidden: you have ${state.runReproPositiveSinceWrite} POSITIVE run_repro observation(s) ` +
      `(exit!=0 AND sentinel "${state.derivedSentinel}" in stdout/stderr) since your last test write — ` +
      `this PROVES the test triggers the bug. ` +
      (state.runReproPositiveSinceWrite >= 2
        ? `You have ≥2 positive observations — your NEXT tool call MUST be record_evidence with a complete reproRecipe (candidateTestPath, testSource, sentinelString, expectedFailureSignature, pipInstalls, provenance.observedProbe populated from your latest run_repro), then done on the following turn.`
        : `Run run_repro once more to confirm consistency (you need 2 positive observations to record_evidence), then call record_evidence.`) +
      ` Abandon is reserved for environmental dead-ends where no repro signal exists.\n\n${renderVerifiedState(state)}`
    );
  }
  const failedInstalls = transcript.filter(
    (t) => t.tool === 'pip_install' && (!t.ok || (t.result as any)?.exitCode !== 0)
  ).length;
  const lastRevise = transcript
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.tool === 'revise_test' && t.ok)
    .pop();
  const ranReproAfterRevise = lastRevise
    ? transcript.slice(lastRevise.i + 1).some((t) => t.tool === 'run_repro' && t.ok)
    : false;
  if (failedInstalls >= 2 && !ranReproAfterRevise) {
    return (
      `abandon is forbidden: you have ${failedInstalls} failed pip_install attempts ` +
      `but no revise_test followed by a fresh run_repro. Install-fatigue is treated as environmental ` +
      `incompatibility — STOP installing the heavy framework and instead revise_test to a direct-call ` +
      `path that imports the suspect symbol straight from its underlying package (e.g. ` +
      `opentelemetry.trace.NonRecordingSpan instead of the framework wrapper). Then run_repro on the ` +
      `revised test. Abandon becomes available only after that observation.`
    );
  }
  return null;
}

/**
 * Repro Prober — same shape as the Executor (LLM loop with read + note +
 * write-test + sandbox), plus `record_evidence` so it can emit the
 * ReproRecipe that the deterministic Executor will transcribe. Done gate
 * additionally requires a structurally-valid recipe (path + sentinel match
 * a recent write_test + ≥2 failing run_repro calls) so the run cannot
 * terminate with a hallucinated recipe.
 */
export function makeReproProberRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    {
      // sandbox cap raised from default 12 → 30 (same reason as Repro Executor).
      // The Prober's probe phase + candidate run_repro iterations comfortably
      // exceed 12 sandbox calls; rejected calls would otherwise look like
      // run_repro_errored to the verified-state classifier.
      budgets: defaultBudgets({ total: 70, perTier: { mutation: 0, sandbox: 30 } }),
      maxTurns: 22,
      toolGates: {
        write_test: (transcript) =>
          gateRequirePriorProbe(transcript) ?? gateRequireRunReproSinceLastWrite(transcript),
        revise_test: (transcript) =>
          gateRequirePriorProbe(transcript) ?? gateRequireRunReproSinceLastWrite(transcript),
        done: reproProberDoneGate,
      },
      abandonGate: reproProberAbandonGate,
    },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, recordEvidence, deepenInvestigation, done, abandon])
    .registerMany([...WRITE_TEST_TOOLS])
    .registerMany([...SANDBOX_TOOLS]);
}

export function makeReproCriticRegistry({ ctx }: RegistryFactoryArgs): ToolRegistry {
  return new ToolRegistry(
    {
      budgets: defaultBudgets({ total: 25, perTier: { mutation: 0, 'write-test': 0 } }),
      maxTurns: 8,
      abandonGate: (transcript) => {
        const ranRepro = transcript.some((t) => t.tool === 'run_repro' && t.ok);
        if (!ranRepro) {
          return 'abandon is forbidden before you have called run_repro. The orchestrator needs a verdict on whether the test reproduces — run_repro at least once before considering abandon.';
        }
        return null;
      },
    },
    ctx
  )
    .registerMany([...READ_TOOLS])
    .registerMany([note, abandon])
    .registerMany([...SANDBOX_TOOLS]);
}

export * from './types';
export * from './handles';
export { ToolRegistry } from './registry';
export { READ_TOOLS, NOTE_META_TOOLS, WRITE_TEST_TOOLS, MUTATION_TOOLS, SANDBOX_TOOLS };

/**
 * write_test/revise_test probe gate: reject if the verified-state ledger
 * shows no successfully importable module. We deliberately use
 * `state.importable` (populated from python_module_check importable=true OR
 * a successful run_python whose snippet contained `from X import …` or
 * `import X`) instead of `runPythonSuccessCount`, because the latter would
 * accept noise like `run_python("print(1)")` as a "probe". An import-shaped
 * probe is the only thing that proves the sandbox can actually load the
 * suspect symbols.
 *
 * verified-state.ts also credits the imports from a run_python that FAILS
 * for non-import reasons (e.g. the bug itself raised) — so a strong probe
 * that reaches the bug still satisfies the gate.
 *
 * The rendered ledger is embedded in the error message so the model sees
 * exactly what's verified vs not when corrected.
 */
export function gateRequirePriorProbe(transcript: TranscriptEntry[]): string | null {
  const state = deriveVerifiedState(transcript);
  if (state.importable.length > 0) return null;
  return (
    `write_test/revise_test is blocked: no successful import probe yet. Probe at least one ` +
    `import via python_module_check("X") OR run_python("from X import Y") so the verified-state ` +
    `ledger shows the sandbox can actually load the suspect symbols before you commit the test. ` +
    `print(1) and other non-import run_python calls do not count. Big-bang authoring is what ` +
    `we are explicitly avoiding.\n\n${renderVerifiedState(state)}`
  );
}

/**
 * revise_test gate: reject if there has been a successful write_test or
 * revise_test but no successful run_repro since the most recent of those.
 * Forces an observation between rewrites — no "blind revise" loops.
 *
 * Allowed on the FIRST revise_test if no prior write succeeded (the model
 * may be using revise_test as a write_test alias; the write_test gate will
 * still apply on its own.) and allowed if the most recent commit was
 * followed by a successful run_repro.
 */
export function gateRequireRunReproSinceLastWrite(
  transcript: TranscriptEntry[]
): string | null {
  let lastWriteIdx = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if ((e.tool === 'write_test' || e.tool === 'revise_test') && e.ok) {
      lastWriteIdx = i;
      break;
    }
  }
  if (lastWriteIdx < 0) return null;
  const ranReproSince = transcript
    .slice(lastWriteIdx + 1)
    .some((e) => e.tool === 'run_repro' && e.ok);
  if (ranReproSince) return null;
  const state = deriveVerifiedState(transcript);
  return (
    `revise_test is blocked: you have not run run_repro since your last successful ` +
    `write_test/revise_test. Call run_repro first so you have an observation to react to — ` +
    `blind revise loops burn budget without producing new evidence.\n\n${renderVerifiedState(state)}`
  );
}
