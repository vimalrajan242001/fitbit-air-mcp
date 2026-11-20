import { homedir } from 'node:os';
import { join } from 'node:path';

/** `%USERPROFILE%\.config\fitbit-air-mcp` on Windows, `~/.config/fitbit-air-mcp` elsewhere. */
export function defaultConfigDir(): string {
  return join(homedir(), '.config', 'fitbit-air-mcp');
}

export function envPath(configDir: string): string {
  return join(configDir, 'env');
}

export function tokenPath(configDir: string): string {
  return join(configDir, 'tokens.json');
}
