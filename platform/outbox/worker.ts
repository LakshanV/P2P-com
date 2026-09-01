/**
 * The outbox relay worker: the long-running process that keeps the relay running.
 *
 * `runOutboxRelay` does one pass. This is what calls it repeatedly, forever, in a way that can be
 * stopped without losing work and observed without attaching a debugger.
 *
 * **The clock and the sleep are injected.** A worker that called `Date.now()` and `setTimeout`
 * directly could only be tested by waiting, and a test that waits is a test somebody eventually
 * deletes. Here a test supplies a clock that returns known instants and a sleep that returns
 * immediately, and the whole loop runs in microseconds with entirely predictable behaviour.
 *
 * **Shutdown is cooperative and finishes the pass.** `stop()` asks the worker to stop after the pass
 * it is in; it does not abandon rows mid-dispatch. A relay killed between publishing a fact and
 * marking the row would republish it on restart, which the lease and the downstream's own
 * idempotency should survive — but choosing not to do that on every deploy is cheap.
 *
 * Owned by: platform substrate.
 */

import { runOutboxRelay, type RelayOptions, type RelayResult } from './relay.ts';

/** What the worker needs from the outside world, so none of it is reached for directly. */
export interface WorkerEnvironment {
  /** The current instant, as a UTC string. */
  now(): string;
  /** Wait, then resolve. A test supplies one that resolves immediately. */
  sleep(millis: number): Promise<void>;
  /** Called after every pass, with what that pass did. */
  onPass?(summary: PassSummary): void;
}

export interface PassSummary extends RelayResult {
  /** Which pass this was, counting from 1. */
  readonly pass: number;
  readonly startedAt: string;
  /** True when the pass ended because the relay itself threw. */
  readonly errored: boolean;
  readonly error: string | null;
}

export interface WorkerOptions extends RelayOptions {
  /** How long to wait after a pass that dispatched nothing. */
  readonly idleMillis?: number;
  /**
   * How long to wait after a pass that dispatched something.
   *
   * Shorter than `idleMillis`, because a pass that found work probably has more waiting: a backlog
   * is drained by polling promptly, and an empty table is best left alone.
   */
  readonly busyMillis?: number;
  /**
   * How long to wait after a pass that threw.
   *
   * The relay already swallows a single unreachable source, so an exception here means something
   * broader — the process cannot reach any database. Backing off further stops a hard-down
   * dependency being hammered by a loop that cannot succeed anyway.
   */
  readonly errorMillis?: number;
  /** Stop after this many passes. Omitted means run until stopped. */
  readonly maxPasses?: number;
}

const DEFAULT_IDLE_MILLIS = 1_000;
const DEFAULT_BUSY_MILLIS = 50;
const DEFAULT_ERROR_MILLIS = 5_000;

export interface WorkerReport {
  readonly passes: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly deadLettered: number;
  /** Passes in which at least one source could not be polled. */
  readonly sourceFailures: number;
  readonly errors: number;
  /** True when the loop ended because `stop()` was called rather than by reaching `maxPasses`. */
  readonly stopped: boolean;
}

/**
 * A relay that keeps running.
 *
 * One instance is one loop. Run several against the same tables if one cannot keep up: the source's
 * `FOR UPDATE SKIP LOCKED` claim is what makes that safe, and it is the only reason it is safe.
 */
export class OutboxRelayWorker {
  readonly #options: WorkerOptions;
  readonly #environment: WorkerEnvironment;
  #running = false;
  #stopRequested = false;

  constructor(options: WorkerOptions, environment: WorkerEnvironment) {
    this.#options = options;
    this.#environment = environment;
  }

  /** True while a `run()` is in progress. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * Ask the worker to stop after the pass it is in.
   *
   * **A stop is permanent for this worker.** Calling it before `run()` means no pass ever starts,
   * which is what a process that receives a signal during startup wants; calling it during a run
   * ends the loop after the pass in progress. To run again, construct another worker — one instance
   * is one loop, and a `run()` that quietly cleared an earlier stop would restart a process
   * somebody had already asked to shut down.
   */
  stop(): void {
    this.#stopRequested = true;
  }

  /**
   * Run until stopped, or until `maxPasses` passes have completed.
   *
   * Returns what the whole run did, so a caller that stops the worker can log one line rather than
   * accumulating counts itself.
   */
  async run(): Promise<WorkerReport> {
    if (this.#running) {
      throw new Error('this worker is already running; construct a second one to run two loops');
    }
    this.#running = true;

    const idle = this.#options.idleMillis ?? DEFAULT_IDLE_MILLIS;
    const busy = this.#options.busyMillis ?? DEFAULT_BUSY_MILLIS;
    const onError = this.#options.errorMillis ?? DEFAULT_ERROR_MILLIS;

    let passes = 0;
    let dispatched = 0;
    let failed = 0;
    let deadLettered = 0;
    let sourceFailures = 0;
    let errors = 0;

    try {
      while (!this.#stopRequested) {
        if (this.#options.maxPasses !== undefined && passes >= this.#options.maxPasses) break;

        const startedAt = this.#environment.now();
        passes += 1;

        let summary: PassSummary;
        try {
          const result = await runOutboxRelay(this.#options, startedAt);
          dispatched += result.dispatched;
          failed += result.failed;
          deadLettered += result.deadLettered;
          sourceFailures += result.sourceFailures;
          summary = { ...result, pass: passes, startedAt, errored: false, error: null };
        } catch (error) {
          errors += 1;
          summary = {
            dispatched: 0,
            failed: 0,
            skipped: 0,
            deadLettered: 0,
            sourceFailures: 0,
            pass: passes,
            startedAt,
            errored: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        this.#environment.onPass?.(summary);

        // Checked again here: a pass can be long, and a stop requested during it should not be
        // followed by a sleep nobody is waiting out.
        if (this.#stopRequested) break;
        if (this.#options.maxPasses !== undefined && passes >= this.#options.maxPasses) break;

        const wait = summary.errored ? onError : summary.dispatched > 0 ? busy : idle;
        await this.#environment.sleep(wait);
      }
    } finally {
      this.#running = false;
    }

    return {
      passes,
      dispatched,
      failed,
      deadLettered,
      sourceFailures,
      errors,
      stopped: this.#stopRequested,
    };
  }
}

/**
 * The environment a real process uses: the system clock and a real timer.
 *
 * Deliberately the only place in the outbox substrate that reads a clock. Everything else is handed
 * an instant, which is what makes the rest of it testable.
 */
export function systemEnvironment(onPass?: (summary: PassSummary) => void): WorkerEnvironment {
  return {
    now: () =>
      new Date()
        .toISOString()
        .replace('Z', '000Z')
        .replace(/\.(\d{6})\d*000Z$/, '.$1Z'),
    sleep: (millis: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, millis);
        // Do not hold the process open for a sleep: a worker that has been asked to stop should let
        // the process exit rather than waiting out its own idle delay.
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ...(onPass === undefined ? {} : { onPass }),
  };
}
