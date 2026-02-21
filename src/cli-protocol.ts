/**
 * CLI Protocol — shared types between cli-server.ts and cli/hal.ts
 * Newline-delimited JSON over Unix socket.
 */

// --- Client → Server ---

export type CliRequest =
  | { type: 'message'; text: string }
  | { type: 'ask_user_response'; id: string; answer: string }
  | { type: 'ping' };

// --- Server → Client ---

export interface HistoryMessage {
  sender: string;
  text: string;
  time: string;
  isBot: boolean;
}

export type CliResponse =
  | { type: 'history'; messages: HistoryMessage[] }
  | { type: 'chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: string }
  | { type: 'ask_user'; id: string; question: string; options?: string[] }
  | { type: 'pong' };
