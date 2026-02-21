/**
 * CLI Server — Unix socket interface for desktop interaction with Hal.
 * Shares agent context with WhatsApp via the same runAgent() path and session.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { ASSISTANT_NAME, CLI_SOCKET_PATH, DATA_DIR, MAIN_GROUP_FOLDER } from './config.js';
import { CliRequest, CliResponse, HistoryMessage } from './cli-protocol.js';
import { ContainerOutput } from './container-runner.js';
import { getRecentMessages } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { escapeXml, stripInternalTags } from './router.js';
import { RegisteredGroup } from './types.js';

export interface CliServerDeps {
  runAgent: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  sessions: () => Record<string, string>;
  queue: GroupQueue;
}

const CLI_JID = 'cli:main';

let server: net.Server | null = null;
let activeClient: net.Socket | null = null;

function send(socket: net.Socket, msg: CliResponse): void {
  try {
    socket.write(JSON.stringify(msg) + '\n');
  } catch {
    // Client disconnected
  }
}

function findMainGroup(
  registeredGroups: Record<string, RegisteredGroup>,
): { jid: string; group: RegisteredGroup } | null {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER) {
      return { jid, group };
    }
  }
  return null;
}

function buildHistory(chatJid: string): HistoryMessage[] {
  const rows = getRecentMessages(chatJid, 20);
  return rows.map((r) => ({
    sender: r.is_bot_message ? ASSISTANT_NAME : r.sender_name || 'You',
    text: r.content,
    time: r.timestamp,
    isBot: !!r.is_bot_message,
  }));
}

function formatCliPrompt(text: string): string {
  const time = new Date().toISOString();
  return `<messages>\n<message sender="Jaypaul (desktop)" time="${time}">${escapeXml(text)}</message>\n</messages>`;
}

export function startCliServer(deps: CliServerDeps): void {
  const socketDir = path.dirname(CLI_SOCKET_PATH);
  fs.mkdirSync(socketDir, { recursive: true });

  // Clean up stale socket file
  try {
    fs.unlinkSync(CLI_SOCKET_PATH);
  } catch {
    // Doesn't exist, fine
  }

  server = net.createServer((socket) => {
    logger.info('CLI client connected');

    // Only one CLI client at a time
    if (activeClient) {
      send(socket, { type: 'error', error: 'Another CLI client is already connected' });
      socket.end();
      return;
    }
    activeClient = socket;

    // Send history on connect
    const groups = deps.registeredGroups();
    const main = findMainGroup(groups);
    if (main) {
      const history = buildHistory(main.jid);
      send(socket, { type: 'history', messages: history });
    }

    // Start watching for ask_user questions from the container
    const questionsDir = path.join(DATA_DIR, 'ipc', MAIN_GROUP_FOLDER, 'questions');
    fs.mkdirSync(questionsDir, { recursive: true });
    const questionWatcher = startQuestionWatcher(questionsDir, socket);

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      // Keep incomplete last line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const req: CliRequest = JSON.parse(line);
          handleRequest(req, socket, deps);
        } catch (err) {
          send(socket, { type: 'error', error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    });

    socket.on('close', () => {
      logger.info('CLI client disconnected');
      activeClient = null;
      questionWatcher.stop();
      // Signal active container to wind down so the queue slot frees up
      deps.queue.closeStdin(CLI_JID);
    });

    socket.on('error', (err) => {
      logger.warn({ err }, 'CLI socket error');
      activeClient = null;
      questionWatcher.stop();
      deps.queue.closeStdin(CLI_JID);
    });
  });

  server.listen(CLI_SOCKET_PATH, () => {
    // Make socket accessible to the user
    try {
      fs.chmodSync(CLI_SOCKET_PATH, 0o600);
    } catch {
      // Non-fatal
    }
    logger.info({ path: CLI_SOCKET_PATH }, 'CLI server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'CLI server error');
  });
}

function handleRequest(
  req: CliRequest,
  socket: net.Socket,
  deps: CliServerDeps,
): void {
  switch (req.type) {
    case 'ping':
      send(socket, { type: 'pong' });
      break;

    case 'message':
      handleMessage(req.text, socket, deps);
      break;

    case 'ask_user_response':
      handleAskUserResponse(req.id, req.answer);
      break;
  }
}

function handleMessage(
  text: string,
  socket: net.Socket,
  deps: CliServerDeps,
): void {
  const groups = deps.registeredGroups();
  const main = findMainGroup(groups);

  if (!main) {
    send(socket, { type: 'error', error: 'No main group registered. Run /setup first.' });
    send(socket, { type: 'done' });
    return;
  }

  const prompt = formatCliPrompt(text);

  // Use GroupQueue.enqueueTask with synthetic JID for serialization
  const taskId = `cli-${Date.now()}`;
  deps.queue.enqueueTask(CLI_JID, taskId, async () => {
    try {
      const result = await deps.runAgent(
        main.group,
        prompt,
        main.jid,
        async (output: ContainerOutput) => {
          if (output.result) {
            const raw = typeof output.result === 'string'
              ? output.result
              : JSON.stringify(output.result);
            const text = stripInternalTags(raw);
            if (text) {
              send(socket, { type: 'chunk', text });
            }
          }
          if (output.status === 'error') {
            send(socket, { type: 'error', error: output.error || 'Agent error' });
          }
        },
      );

      if (result === 'error') {
        send(socket, { type: 'error', error: 'Agent returned an error' });
      }
    } catch (err) {
      send(socket, {
        type: 'error',
        error: `Agent failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    send(socket, { type: 'done' });
  });
}

function handleAskUserResponse(id: string, answer: string): void {
  const answersDir = path.join(DATA_DIR, 'ipc', MAIN_GROUP_FOLDER, 'answers');
  fs.mkdirSync(answersDir, { recursive: true });

  const filepath = path.join(answersDir, `${id}.json`);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ answer }));
  fs.renameSync(tempPath, filepath);

  logger.debug({ id }, 'CLI ask_user response written');
}

interface QuestionWatcher {
  stop: () => void;
}

function startQuestionWatcher(dir: string, socket: net.Socket): QuestionWatcher {
  let running = true;

  const poll = () => {
    if (!running) return;

    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const filepath = path.join(dir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
          send(socket, {
            type: 'ask_user',
            id: data.id,
            question: data.question,
            options: data.options,
          });
          fs.unlinkSync(filepath);
        } catch (err) {
          logger.warn({ file, err }, 'Error reading question file');
        }
      }
    } catch {
      // Directory may not exist yet
    }

    if (running) {
      setTimeout(poll, 500);
    }
  };

  poll();

  return {
    stop: () => { running = false; },
  };
}

export function stopCliServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  if (activeClient) {
    activeClient.destroy();
    activeClient = null;
  }
  try {
    fs.unlinkSync(CLI_SOCKET_PATH);
  } catch {
    // Already gone
  }
}
