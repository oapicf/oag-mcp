// Minimal declarations for @sinonjs/referee (JavaScript-only package).
declare module "@sinonjs/referee" {
  interface Assert {
    (value: unknown, message?: string): void;
    equals(actual: unknown, expected: unknown, message?: string): void;
    same(actual: unknown, expected: unknown, message?: string): void;
    isTrue(value: unknown, message?: string): void;
    isFalse(value: unknown, message?: string): void;
    isNull(value: unknown, message?: string): void;
    isUndefined(value: unknown, message?: string): void;
    defined(value: unknown, message?: string): void;
    isString(value: unknown, message?: string): void;
    isFunction(value: unknown, message?: string): void;
    isObject(value: unknown, message?: string): void;
    isArray(value: unknown, message?: string): void;
    contains(haystack: unknown, needle: unknown, message?: string): void;
    match(actual: unknown, matcher: unknown, message?: string): void;
    greater(actual: number, expected: number, message?: string): void;
    less(actual: number, expected: number, message?: string): void;
    exception(fn: () => unknown, matcher?: unknown, message?: string): void;
    rejects(promise: Promise<unknown>, matcher?: unknown): Promise<void>;
  }
  interface Refute {
    (value: unknown, message?: string): void;
    equals(actual: unknown, expected: unknown, message?: string): void;
    contains(haystack: unknown, needle: unknown, message?: string): void;
    match(actual: unknown, matcher: unknown, message?: string): void;
    defined(value: unknown, message?: string): void;
    isNull(value: unknown, message?: string): void;
  }
  const referee: {
    assert: Assert;
    refute: Refute;
    /** Create a matcher, e.g. `match({ message: "boom" })`, for assertions. */
    match(expectation: unknown, message?: string): unknown;
  };
  export default referee;
}
