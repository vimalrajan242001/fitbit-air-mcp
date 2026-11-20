/** MCP stdout is the protocol stream. Every log line goes to stderr. */
export function log(message: string): void {
  console.error(message);
}
