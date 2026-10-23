"use strict";
import referee from "@sinonjs/referee";

import { Semaphore } from "../../lib/util/semaphore.js";

const { assert } = referee;

/** Let pending promise continuations run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("semaphore - acquire", function () {
  it("should bound concurrency and queue length", async function () {
    const s = new Semaphore(1, 1);
    const r1 = await s.acquire();
    const pending = s.acquire();
    assert.isUndefined(await s.acquire());
    r1!();
    const r2 = await pending;
    assert.isFunction(r2);
    r2!();
  });

  it("should hand a released slot to the next waiter so a new caller cannot take it too", async function () {
    const s = new Semaphore(1, 1);
    const r1 = await s.acquire();
    const queued = s.acquire();
    // Release, then a new caller arrives before the woken waiter resumes.
    r1!();
    let lateGotSlot = false;
    const late = s.acquire().then((r) => {
      lateGotSlot = true;
      return r;
    });
    const r2 = await queued;
    await settle();
    assert.isFunction(r2);
    assert.isFalse(lateGotSlot, "new caller must wait behind the woken waiter");
    assert.equals(s.inUse, 1);
    r2!();
    const r3 = await late;
    assert.isFunction(r3);
    assert.equals(s.inUse, 1);
    r3!();
    assert.equals(s.inUse, 0);
  });

  it("should never exceed the limit under bursts of acquire and release", async function () {
    const max = 3;
    const s = new Semaphore(max, 100);
    let holders = 0;
    let peak = 0;
    const work = async () => {
      const release = await s.acquire();
      assert.isFunction(release);
      holders++;
      peak = Math.max(peak, holders, s.inUse);
      await settle();
      holders--;
      release!();
    };
    await Promise.all(Array.from({ length: 50 }, work));
    assert.equals(peak, max);
    assert.equals(s.inUse, 0);
  });

  it("should ignore a second call to the same release function", async function () {
    const s = new Semaphore(1, 0);
    const r1 = await s.acquire();
    r1!();
    r1!();
    assert.equals(s.inUse, 0);
    const r2 = await s.acquire();
    assert.isFunction(r2);
    assert.isUndefined(await s.acquire());
  });
});
