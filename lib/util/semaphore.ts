"use strict";
/**
 * A counting semaphore with a bounded wait queue.
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
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
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
      this.active--;
      const next = this.waiters.shift();
      if (next) {
        next();
      }
    };
  }
}
