"use strict";
/**
 * A counting semaphore with a bounded FIFO wait queue. A released slot is
 * handed directly to the longest-waiting acquirer, so the number of holders
 * never exceeds the limit and new callers cannot overtake queued ones.
 *
 * @module util/semaphore
 */

/**
 * Bounded concurrency gate.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  /**
   * @param {Number} max - concurrent holders
   * @param {Number} maxQueue - maximum waiting acquirers
   */
  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  /** Number of slots currently held. */
  get inUse(): number {
    return this.active;
  }

  /**
   * Acquire a slot.
   *
   * @return {Promise} release function, or undefined when the queue is full
   */
  async acquire(): Promise<(() => void) | undefined> {
    if (this.active < this.max) {
      this.active++;
      return this._release();
    }
    if (this.waiters.length >= this.maxQueue) {
      return undefined;
    }
    // The releasing holder hands its slot over directly (see _release), so
    // `active` already counts this waiter when it resumes. Incrementing
    // here instead would let a caller arriving between the release and the
    // resumption take the same slot.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this._release();
  }

  /**
   * Build a one-shot release function.
   *
   * @private
   */
  private _release(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Transfer the slot: `active` is unchanged, FIFO order is kept.
        next();
      } else {
        this.active--;
      }
    };
  }
}
