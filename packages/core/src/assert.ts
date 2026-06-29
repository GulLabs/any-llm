/** Exhaustiveness guard for discriminated unions. Throws at runtime if reached. */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unhandled variant: ${String(value)}`)
}
