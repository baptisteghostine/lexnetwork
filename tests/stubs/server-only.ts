// Vitest stand-in for the `server-only` package: in Next it throws when a
// server module is pulled into a client bundle; under Vitest everything
// runs in Node, so the guard is a no-op. Aliased in vitest.config.ts.
export {};
