/**
 * Extracts a human-readable, diagnostic-friendly message from any thrown value.
 *
 * `@cursor/sdk` errors carry extra fields (`code`, `status`, `requestId`,
 * `helpUrl`); we surface them so MCP clients get actionable failures instead of
 * an opaque "[object Object]".
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const extras: string[] = [];
    const anyErr = error as unknown as Record<string, unknown>;
    if (typeof anyErr.code === "string") extras.push(`code=${anyErr.code}`);
    if (typeof anyErr.status === "number") extras.push(`status=${anyErr.status}`);
    if (typeof anyErr.requestId === "string") extras.push(`requestId=${anyErr.requestId}`);
    if (typeof anyErr.helpUrl === "string") extras.push(`helpUrl=${anyErr.helpUrl}`);
    return extras.length > 0 ? `${error.message} (${extras.join(", ")})` : error.message;
  }
  return String(error);
}
