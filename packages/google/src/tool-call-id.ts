/**
 * Unique Gemini toolCallId allocation.
 *
 * Provider-supplied functionCall / functionResponse ids are reserved first so
 * fallbacks of the form `call_${name}_${n}` never collide with them — even
 * when the provider id appears after an id-less sibling.
 */

/** Collects non-empty provider-supplied ids so fallbacks skip them. */
export function reserveProviderToolCallIds(
  ids: Iterable<string | undefined>,
): Set<string> {
  const reserved = new Set<string>()
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) reserved.add(id)
  }
  return reserved
}

/**
 * Next `call_${toolName}_${n}` that is not in `reserved`.
 *
 * `counterKey` lets functionCall vs functionResponse keep independent
 * sequences so two id-less pairs of the same name still line up.
 */
export function nextFallbackToolCallId(
  toolName: string,
  counters: Map<string, number>,
  reserved: Set<string>,
  counterKey: string = toolName,
): string {
  let n = counters.get(counterKey) ?? 0
  let id: string
  do {
    n += 1
    id = `call_${toolName}_${n}`
  } while (reserved.has(id))
  counters.set(counterKey, n)
  return id
}

export function resolveToolCallId(
  providerId: string | undefined,
  toolName: string,
  counters: Map<string, number>,
  reserved: Set<string>,
  counterKey?: string,
): string {
  if (typeof providerId === 'string' && providerId.length > 0) {
    return providerId
  }
  return nextFallbackToolCallId(toolName, counters, reserved, counterKey ?? toolName)
}
