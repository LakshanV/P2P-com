/**
 * K-13 AI Gateway — the immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored. Gateway records are append-only; the only defence against silent
 * mutation at the boundary is to make mutation throw.
 *
 * Owned by: K-13 AI Gateway.
 */

import type {
  AICost,
  AIDecision,
  AIRun,
  ModelBinding,
  TaskAuthority,
  TaskDefinition,
} from './types.ts';

/** A deep, frozen copy of a task definition. */
export function sealTask(task: TaskDefinition): TaskDefinition {
  return Object.freeze({
    ...task,
    inputSchema: Object.freeze({ ...task.inputSchema }),
    outputSchema: Object.freeze({ ...task.outputSchema }),
  });
}

/** A deep, frozen copy of a model binding. */
export function sealBinding(binding: ModelBinding): ModelBinding {
  return Object.freeze({
    ...binding,
    capabilities: Object.freeze([...binding.capabilities]),
  });
}

/** A deep, frozen copy of a cost. */
export function sealCost(cost: AICost): AICost {
  return Object.freeze({ ...cost });
}

/** A deep, frozen copy of an AI run. */
export function sealRun(run: AIRun): AIRun {
  return Object.freeze({
    ...run,
    input: Object.freeze({ ...run.input }),
    output: Object.freeze({ ...run.output }),
    cost: sealCost(run.cost),
  });
}

/** A deep, frozen copy of an AI decision. */
export function sealDecision(decision: AIDecision): AIDecision {
  return Object.freeze({ ...decision });
}

/** Frozen copies of a list. */
export function sealTasks(tasks: readonly TaskDefinition[]): readonly TaskDefinition[] {
  return Object.freeze(tasks.map(sealTask));
}

export function sealBindings(bindings: readonly ModelBinding[]): readonly ModelBinding[] {
  return Object.freeze(bindings.map(sealBinding));
}

export function sealRuns(runs: readonly AIRun[]): readonly AIRun[] {
  return Object.freeze(runs.map(sealRun));
}

export function sealDecisions(decisions: readonly AIDecision[]): readonly AIDecision[] {
  return Object.freeze(decisions.map(sealDecision));
}

/** Is this task sealed all the way down? */
export function isTaskSealed(task: TaskDefinition): boolean {
  return (
    Object.isFrozen(task) && Object.isFrozen(task.inputSchema) && Object.isFrozen(task.outputSchema)
  );
}

/** Is this binding sealed all the way down? */
export function isBindingSealed(binding: ModelBinding): boolean {
  return Object.isFrozen(binding) && Object.isFrozen(binding.capabilities);
}

/** Is this run sealed all the way down? */
export function isRunSealed(run: AIRun): boolean {
  return (
    Object.isFrozen(run) &&
    Object.isFrozen(run.input) &&
    Object.isFrozen(run.output) &&
    Object.isFrozen(run.cost)
  );
}

/** Is this decision sealed? */
export function isDecisionSealed(decision: AIDecision): boolean {
  return Object.isFrozen(decision);
}

/** A frozen copy of one authority grant. */
export function sealAuthority(authority: TaskAuthority): TaskAuthority {
  return Object.freeze({ ...authority });
}

/** Frozen copies of a list of authority grants. */
export function sealAuthorities(authorities: readonly TaskAuthority[]): readonly TaskAuthority[] {
  return Object.freeze(authorities.map(sealAuthority));
}

/** Is this authority grant sealed? */
export function isAuthoritySealed(authority: TaskAuthority): boolean {
  return Object.isFrozen(authority);
}
