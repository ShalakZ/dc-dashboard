/**
 * jsdom swaps in its own AbortController, but Node's built-in Request (undici) rejects an AbortSignal that is not its own.
 * Every navigation of a React Router data router builds a `new Request(url, { signal })`, so under jsdom it throws
 * "Expected signal to be an instance of AbortSignal" and the navigation never happens. When that exact refusal occurs the
 * Request is built again without the signal; nothing in these tests loads data, so there is nothing it would have cancelled.
 * Imported by render.tsx, so it applies to the tests that mount a router and to no others.
 */
const NodeRequest = globalThis.Request;

globalThis.Request = new Proxy(NodeRequest, {
  construct(target, args: ConstructorParameters<typeof Request>, newTarget) {
    try {
      return Reflect.construct(target, args, newTarget);
    } catch (error) {
      const [input, init] = args;
      if (!(error instanceof TypeError) || !init?.signal || !/signal/i.test(error.message)) throw error;
      const { signal: _foreign, ...rest } = init;
      return Reflect.construct(target, [input, rest], newTarget);
    }
  },
});
