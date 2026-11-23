interface NamedToolCall {
  function: { name: string };
}

export function partitionToolCalls<T extends NamedToolCall>(
  calls: T[],
  parallelToolNames: ReadonlySet<string> = new Set(['search_document']),
): { parallel: T[]; serial: T[] } {
  const parallel: T[] = [];
  const serial: T[] = [];
  for (const call of calls) {
    (parallelToolNames.has(call.function.name) ? parallel : serial).push(call);
  }
  return { parallel, serial };
}
