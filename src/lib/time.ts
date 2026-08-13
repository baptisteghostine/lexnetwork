/**
 * Request-time clock for dynamic server components. Kept out of component
 * bodies so render code stays pure under the react-hooks/purity rule; every
 * caller is a force-dynamic page evaluated per request.
 */
export function now(): number {
  return Date.now();
}
