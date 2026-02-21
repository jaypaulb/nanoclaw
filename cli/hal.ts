#!/usr/bin/env -S npx tsx
/**
 * hal — CLI client for NanoClaw
 *
 * Interactive:  hal
 * One-shot:     hal what time is my meeting?
 */
import net from 'net';
import path from 'path';
import readline from 'readline';

import { Marked } from 'marked';
import markedTerminal from 'marked-terminal';

import { CliRequest, CliResponse, HistoryMessage } from '../src/cli-protocol.js';

// --- Config ---

const HOME = process.env.HOME || '/home/user';
const SOCKET_PATH = path.join(HOME, '.config', 'nanoclaw', 'cli.sock');

// --- Colors (ANSI) ---

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

// --- Markdown renderer ---

const marked = new Marked(markedTerminal());

function renderMarkdown(text: string): string {
  try {
    const rendered = marked.parse(text);
    if (typeof rendered === 'string') {
      // Trim trailing newlines that marked adds
      return rendered.replace(/\n+$/, '');
    }
    return text;
  } catch {
    return text;
  }
}

// --- Socket communication ---

function send(socket: net.Socket, msg: CliRequest): void {
  socket.write(JSON.stringify(msg) + '\n');
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH, () => {
      resolve(socket);
    });
    socket.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('NanoClaw is not running. Start it with: npm run dev'));
      } else if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        reject(new Error('NanoClaw socket exists but connection refused. Try restarting: npm run dev'));
      } else {
        reject(err);
      }
    });
  });
}

// --- Display helpers ---

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return timestamp;
  }
}

function displayHistory(messages: HistoryMessage[]): void {
  if (messages.length === 0) return;

  console.log(`\n  ${DIM}── Recent ──────────────────────────${RESET}`);
  for (const msg of messages) {
    const time = formatTime(msg.time);
    const color = msg.isBot ? GREEN : CYAN;
    const name = msg.isBot ? msg.sender : `You`;
    // For history, show plain text (no markdown rendering for compactness)
    const preview = msg.text.length > 120 ? msg.text.slice(0, 120) + '...' : msg.text;
    console.log(`  ${DIM}[${time}]${RESET} ${color}${name}:${RESET} ${preview}`);
  }
  console.log(`  ${DIM}─────────────────────────────────────${RESET}\n`);
}

function displayAskUser(question: string, options?: string[]): void {
  console.log(`\n  ${YELLOW}${BOLD}${question}${RESET}`);
  if (options && options.length > 0) {
    for (let i = 0; i < options.length; i++) {
      console.log(`  ${YELLOW}[${i + 1}]${RESET} ${options[i]}`);
    }
  }
}

// --- Mode: Interactive ---

async function runInteractive(socket: net.Socket): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `  ${CYAN}You:${RESET} `,
  });

  let waitingForResponse = false;
  let waitingForAskUser: { id: string; options?: string[] } | null = null;
  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg: CliResponse = JSON.parse(line);
        handleResponse(msg);
      } catch {
        // Skip malformed lines
      }
    }
  });

  function handleResponse(msg: CliResponse): void {
    switch (msg.type) {
      case 'history':
        displayHistory(msg.messages);
        if (!waitingForResponse) rl.prompt();
        break;

      case 'chunk':
        if (waitingForResponse) {
          // First chunk — print the prefix
          process.stdout.write(`\n  ${GREEN}Hal:${RESET} `);
          waitingForResponse = false;
        }
        process.stdout.write(renderMarkdown(msg.text));
        break;

      case 'done':
        if (!waitingForResponse) {
          // We received chunks, add newlines
          process.stdout.write('\n\n');
        } else {
          // No output chunks received
          waitingForResponse = false;
          console.log(`\n  ${DIM}(no response)${RESET}\n`);
        }
        rl.prompt();
        break;

      case 'error':
        console.log(`\n  ${RED}Error: ${msg.error}${RESET}\n`);
        waitingForResponse = false;
        rl.prompt();
        break;

      case 'ask_user':
        waitingForAskUser = { id: msg.id, options: msg.options };
        displayAskUser(msg.question, msg.options);
        rl.setPrompt(`  ${YELLOW}>${RESET} `);
        rl.prompt();
        break;

      case 'pong':
        break;
    }
  }

  rl.on('line', (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (waitingForAskUser) {
      const { id, options } = waitingForAskUser;
      let answer = trimmed;

      // If options exist and user typed a number, resolve to the option text
      if (options && options.length > 0) {
        const num = parseInt(trimmed, 10);
        if (num >= 1 && num <= options.length) {
          answer = options[num - 1];
        }
      }

      send(socket, { type: 'ask_user_response', id, answer });
      waitingForAskUser = null;
      rl.setPrompt(`  ${CYAN}You:${RESET} `);
      // Don't prompt yet — wait for agent to continue
      return;
    }

    waitingForResponse = true;
    send(socket, { type: 'message', text: trimmed });
  });

  rl.on('close', () => {
    socket.end();
    process.exit(0);
  });

  socket.on('close', () => {
    console.log(`\n${DIM}Disconnected.${RESET}`);
    rl.close();
    process.exit(0);
  });

  rl.prompt();
}

// --- Mode: One-shot ---

async function runOneShot(socket: net.Socket, text: string): Promise<void> {
  let buffer = '';
  let hasOutput = false;
  let exitCode = 0;

  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg: CliResponse = JSON.parse(line);

        switch (msg.type) {
          case 'history':
            // Skip history in one-shot mode
            break;

          case 'chunk':
            if (!hasOutput) {
              process.stdout.write(`\n  ${GREEN}Hal:${RESET} `);
              hasOutput = true;
            }
            process.stdout.write(renderMarkdown(msg.text));
            break;

          case 'done':
            if (hasOutput) process.stdout.write('\n\n');
            socket.end();
            process.exit(exitCode);
            break;

          case 'error':
            console.error(`\n  ${RED}Error: ${msg.error}${RESET}\n`);
            exitCode = 1;
            break;

          case 'ask_user':
            // In one-shot mode, we can't handle interactive prompts
            console.error(`\n  ${YELLOW}Agent asked: ${msg.question}${RESET}`);
            if (msg.options) {
              console.error(`  Options: ${msg.options.join(', ')}`);
            }
            console.error(`  ${DIM}(Cannot answer in one-shot mode. Use interactive mode: hal)${RESET}\n`);
            break;

          case 'pong':
            break;
        }
      } catch {
        // Skip malformed lines
      }
    }
  });

  socket.on('close', () => {
    process.exit(exitCode);
  });

  // Wait a beat for history to arrive (and be ignored), then send
  setTimeout(() => {
    send(socket, { type: 'message', text });
  }, 100);
}

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isOneShot = args.length > 0;

  let socket: net.Socket;
  try {
    socket = await connect();
  } catch (err) {
    console.error(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`);
    process.exit(1);
  }

  if (isOneShot) {
    await runOneShot(socket, args.join(' '));
  } else {
    console.log(`${DIM}Connected to Hal. Type your message, Ctrl+C to exit.${RESET}`);
    await runInteractive(socket);
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
