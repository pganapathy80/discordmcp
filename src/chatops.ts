/**
 * Discord ChatOps Listener for Claude Code
 *
 * Watches a designated Discord channel for commands from an authorized user,
 * runs them via `claude -p` on the local machine, and posts results back.
 *
 * Security:
 * - Only responds to a single authorized Discord user ID
 * - Only listens in a specific channel (default: #claude-ops)
 * - Commands are validated against an allowlist before execution
 * - Dangerous commands (push, commit, deploy) blocked from Discord
 * - Max output length enforced to avoid Discord message limits
 */

import { Client, GatewayIntentBits, TextChannel, Message } from 'discord.js';
import { spawn, exec, ChildProcess } from 'child_process';

// ── Configuration ──────────────────────────────────────────────

// Comma-separated list of authorized Discord user IDs
const AUTHORIZED_USER_IDS = (process.env.DISCORD_AUTHORIZED_USER_IDS || process.env.DISCORD_AUTHORIZED_USER_ID || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);
const CHANNEL_NAME = process.env.DISCORD_OPS_CHANNEL || 'claude-ops';
const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || '/Users/pganapathy80/prepme';
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const MAX_OUTPUT_CHARS = 1900; // Discord limit is 2000, leave room for formatting
const SHELL_TIMEOUT_MS = 30_000;           // 30 seconds for shell commands
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;  // 10 minutes for claude -p
const PROGRESS_DEBOUNCE_MS = 15_000;       // Min 15s between progress updates

// ── Command categories ─────────────────────────────────────────

interface CommandDef {
  pattern: RegExp;
  description: string;
  prompt?: string;       // Override prompt sent to claude (otherwise uses raw message)
  shell?: string;        // Direct shell command (fast, no claude needed)
  skill?: string;        // Maps to a Claude Code skill
  dangerous?: boolean;   // Needs extra confirmation
  category: 'ci' | 'sre' | 'qa' | 'info' | 'ops' | 'skill' | 'review' | 'work';
}

const ALLOWED_COMMANDS: CommandDef[] = [
  // ── CI Failure Remediation ──
  {
    pattern: /^(fix ci|ci fix|\/ci-fix)\b/i,
    description: 'Analyze latest CI failure, apply fixes, commit & push',
    category: 'ci',
    skill: 'ci-fix',
  },
  {
    pattern: /^ci (status|check)\b/i,
    description: 'Check current CI/CD run status',
    shell: 'echo "Branch: $(git branch --show-current)" && echo "" && gh run list --limit 5',
    category: 'ci',
  },
  {
    pattern: /^ci logs?\b/i,
    description: 'Get latest CI failure logs',
    shell: 'echo "Branch: $(git branch --show-current)" && echo "" && FAILED_RUN=$(gh run list --limit 1 --status failure --json databaseId --jq ".[0].databaseId" 2>/dev/null) && if [ -n "$FAILED_RUN" ] && [ "$FAILED_RUN" != "null" ]; then gh run view "$FAILED_RUN" --log-failed 2>&1 | tail -80; else echo "No recent failed runs found"; fi',
    category: 'ci',
  },
  {
    pattern: /^(ruff fix|fix lint|lint fix)\b/i,
    description: 'Auto-fix ruff lint errors in backend and agent',
    prompt: 'Run ruff check --fix on backend/ and agent/ directories. Report what was fixed. Do NOT commit.',
    category: 'ci',
  },
  {
    pattern: /^(fix types?|type ?check|tsc fix)\b/i,
    description: 'Check and report TypeScript errors',
    prompt: 'Run cd frontend && npx tsc --noEmit. Report any type errors found.',
    category: 'ci',
  },
  {
    pattern: /^(fix tests?|test fix)\b/i,
    description: 'Run failing tests and attempt fixes',
    prompt: 'Run the test suites (backend pytest, frontend jest) to find failures. Report what failed. Do NOT auto-fix without showing what changed.',
    category: 'ci',
  },
  {
    pattern: /^(migration check|check migration|alembic check)\b/i,
    description: 'Validate alembic migrations',
    shell: 'echo "Branch: $(git branch --show-current)" && echo "" && cd backend && source .venv/bin/activate && echo "=== Alembic Heads ===" && alembic heads && echo "" && echo "=== Untracked Migrations ===" && git ls-files --others --exclude-standard alembic/versions/ && echo "(done)"',
    category: 'ci',
  },

  // ── SRE / Production ──
  {
    pattern: /^\/sre\b/i,
    description: 'Run SRE agent for production debugging',
    category: 'sre',
    skill: 'sre',
  },
  {
    pattern: /^check (prod|production) health/i,
    description: 'Hit production health endpoints',
    shell: 'echo "=== Production Health ===" && for ep in /health /health/db /health/redis; do CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "https://backend-production-c2a0.up.railway.app${ep}"); echo "  ${ep}: HTTP ${CODE}"; done && echo "" && CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "https://frontend-production-1a63.up.railway.app"); echo "  Frontend: HTTP ${CODE}"',
    category: 'sre',
  },
  {
    pattern: /^check staging health/i,
    description: 'Hit staging health endpoints',
    shell: 'echo "=== Staging Health ===" && for ep in /health /health/db /health/redis; do CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "https://backend-staging-bf00.up.railway.app${ep}"); echo "  ${ep}: HTTP ${CODE}"; done && echo "" && CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "https://frontend-staging-4fc1.up.railway.app"); echo "  Frontend: HTTP ${CODE}"',
    category: 'sre',
  },
  {
    pattern: /^(deploy|railway) (status|logs)\b/i,
    description: 'Check Railway deployment status or logs',
    shell: 'echo "Branch: $(git branch --show-current)" && echo "" && unset RAILWAY_TOKEN RAILWAY_TOKEN_STAGING RAILWAY_TOKEN_PRODUCTION && railway status 2>&1',
    category: 'sre',
  },

  // ── QA ──
  {
    pattern: /^\/qa\b/i,
    description: 'Run QA checks (commit mode)',
    category: 'qa',
    skill: 'qa',
  },
  {
    pattern: /^run tests?\b/i,
    description: 'Run test suites locally',
    prompt: 'Run backend pytest and frontend jest. Report pass/fail counts and any failures.',
    category: 'qa',
  },
  {
    pattern: /^run lint\b/i,
    description: 'Run linters without fixing',
    prompt: 'Run ruff check on backend/ and agent/, and eslint on frontend/. Report errors found but do NOT auto-fix.',
    category: 'qa',
  },

  // ── PR Management / Review ──
  {
    pattern: /^pr #?(\d+) summary\b/i,
    description: 'AI-summarize a PR: diff, risks, what to test',
    category: 'review',
  },
  {
    pattern: /^pr #?(\d+) approve\b/i,
    description: 'Approve a PR via GitHub CLI',
    shell: '__PR_APPROVE__', // placeholder — resolved dynamically
    dangerous: true,
    category: 'review',
  },
  {
    pattern: /^pr #?(\d+) merge\b/i,
    description: 'Squash-merge a PR and delete branch',
    shell: '__PR_MERGE__', // placeholder — resolved dynamically
    dangerous: true,
    category: 'review',
  },

  // ── Project Awareness / Work ──
  {
    pattern: /^whats? open\b/i,
    description: 'Open PRs + open issues in one view',
    shell: 'echo "=== Open PRs ===" && gh pr list --limit 10 && echo "" && echo "=== Open Issues ===" && gh issue list --limit 10',
    category: 'work',
  },
  {
    pattern: /^whats? next\b/i,
    description: 'AI triage: open issues, PRs needing review, CI status, priorities',
    prompt: 'Check: 1) Open PRs with `gh pr list` 2) Open issues with `gh issue list` 3) CI status with `gh run list --limit 3` 4) Current branch status. Then suggest what to work on next, prioritized by urgency.',
    category: 'work',
  },
  {
    pattern: /^diff main\b/i,
    description: 'Show diff stat vs main branch',
    shell: 'echo "Branch: $(git branch --show-current)" && echo "" && git diff --stat main...HEAD 2>/dev/null || git diff --stat main',
    category: 'work',
  },
  {
    pattern: /^recent commits\b/i,
    description: 'Show last 10 commits',
    shell: 'git log --oneline -10',
    category: 'work',
  },

  // ── Info / Read-only ──
  {
    pattern: /^git status\b/i,
    description: 'Show git status',
    shell: 'echo "Branch: $(git branch --show-current)" && echo "" && git status --short && echo "" && echo "=== Recent Commits ===" && git log --oneline -5',
    category: 'info',
  },
  {
    pattern: /^(show|list|find|search|what|how|where|which|describe|explain)\b/i,
    description: 'Read-only codebase queries',
    category: 'info',
  },
  {
    pattern: /^(summarize|summary|report)\b/i,
    description: 'Generate summaries and reports',
    category: 'info',
  },
  {
    pattern: /^(share|post) (latest )?(pr|pull request)/i,
    description: 'Share PR summaries to Discord',
    category: 'info',
  },
  {
    pattern: /^pr (status|list)\b/i,
    description: 'List open PRs',
    shell: 'echo "Branch: $(git branch --show-current)" && echo "" && gh pr list',
    category: 'info',
  },

  // ── Ops ──
  {
    pattern: /^\/restart\b/i,
    description: 'Restart local dev servers',
    category: 'ops',
    skill: 'restart',
  },

  // ── Dangerous (skill-gated) ──
  {
    pattern: /^\/pr\b/i,
    description: 'Create a PR (runs QA first)',
    category: 'skill',
    skill: 'pr',
    dangerous: true,
  },
];

const BLOCKED_PATTERNS = [
  /rm\s+-rf/i,
  /drop\s+table/i,
  /delete\s+from/i,
  /force.?push/i,
  /--force/i,
  /railway\s+up\b/i,
  /pip\s+uninstall/i,
  /npm\s+uninstall/i,
  /\bsudo\b/i,
  /\bcurl\b.*\|.*\bsh\b/i,
  /password|secret|token|api.?key/i,
  /git\s+reset\s+--hard/i,
  /git\s+push.*--force/i,
  /git\s+clean\s+-f/i,
];

// ── Special commands (not in allowlist) ─────────────────────────

const ABORT_PATTERN = /^(abort|stop|cancel)\b/i;
const FOCUS_PATTERN = /^focus\s+(.+)/i;

// ── Command validation ─────────────────────────────────────────

function validateCommand(content: string): { allowed: boolean; match?: CommandDef; reason?: string } {
  const trimmed = content.trim();

  for (const blocked of BLOCKED_PATTERNS) {
    if (blocked.test(trimmed)) {
      return { allowed: false, reason: `Blocked: \`${blocked.source}\`` };
    }
  }

  for (const cmd of ALLOWED_COMMANDS) {
    if (cmd.pattern.test(trimmed)) {
      return { allowed: true, match: cmd };
    }
  }

  return { allowed: false, reason: 'Command not in allowlist. Type `help` to see available commands.' };
}

// ── Extract PR number from command ──────────────────────────────

function extractPrNumber(content: string): string | null {
  const match = content.match(/pr #?(\d+)/i);
  return match ? match[1] : null;
}

// ── Resolve dynamic shell commands ──────────────────────────────

function resolveShellCommand(cmd: CommandDef, content: string): string | undefined {
  if (!cmd.shell) return undefined;

  const prNum = extractPrNumber(content);
  if (cmd.shell === '__PR_APPROVE__' && prNum) {
    return `gh pr review ${prNum} --approve`;
  }
  if (cmd.shell === '__PR_MERGE__' && prNum) {
    return `gh pr merge ${prNum} --squash --delete-branch`;
  }

  return cmd.shell;
}

// ── Claude concurrency lock & process tracking ──────────────────

let claudeBusy = false;
let claudeCurrentCommand = '';
let claudeStartTime: number | null = null;
let claudeProcess: ChildProcess | null = null;
let claudeLastActivity = '';
let claudePartialOutput = '';

// Queue for messages received while Claude is busy
let messageQueue: Message[] = [];

// ── Smart Progress Parsing ──────────────────────────────────────

interface ActivitySignal {
  summary: string;
  detail?: string;
}

function parseActivityFromChunk(chunk: string): ActivitySignal | null {
  const lines = chunk.split('\n').filter(l => l.trim());

  for (const line of lines) {
    // File operations
    const readMatch = line.match(/(?:Read|Reading)\s+(?:file:?\s*)?[`"']?([^\s`"']+)/i);
    if (readMatch) return { summary: `Reading \`${basename(readMatch[1])}\`` };

    const editMatch = line.match(/(?:Edit|Editing|Write|Writing)\s+(?:file:?\s*)?[`"']?([^\s`"']+)/i);
    if (editMatch) return { summary: `Editing \`${basename(editMatch[1])}\`` };

    // Shell/bash commands
    const bashMatch = line.match(/\$\s+(.+)/);
    if (bashMatch) {
      const cmd = bashMatch[1].trim();
      if (/pytest|py\.test/i.test(cmd)) return { summary: 'Running pytest...', detail: cmd.slice(0, 80) };
      if (/npm\s+test|jest|vitest/i.test(cmd)) return { summary: 'Running tests...', detail: cmd.slice(0, 80) };
      if (/ruff|eslint|flake8|mypy/i.test(cmd)) return { summary: 'Running linter...', detail: cmd.slice(0, 80) };
      if (/git\s+(add|commit|push|diff|log|status)/i.test(cmd)) return { summary: 'Running git commands...', detail: cmd.slice(0, 80) };
      if (/gh\s+/i.test(cmd)) return { summary: 'Running GitHub CLI...', detail: cmd.slice(0, 80) };
      if (/npm\s+|npx\s+|node\s+/i.test(cmd)) return { summary: 'Running Node command...', detail: cmd.slice(0, 80) };
      if (/pip\s+|python\s+/i.test(cmd)) return { summary: 'Running Python command...', detail: cmd.slice(0, 80) };
      return { summary: `Running: \`${cmd.slice(0, 60)}\`` };
    }

    // Test results
    if (/passed|failed|error/i.test(line) && /test/i.test(line)) {
      return { summary: `Test result: ${line.trim().slice(0, 80)}` };
    }

    // Tool use markers (Claude's streaming output format)
    const toolMatch = line.match(/(?:Using tool|Tool:)\s+(\w+)/i);
    if (toolMatch) return { summary: `Using ${toolMatch[1]}` };

    // Commit/push activity
    if (/\[[\w/]+\s+[\da-f]+\]/i.test(line)) return { summary: 'Created commit' };
    if (/branch .+ set up to track/i.test(line)) return { summary: 'Pushed to remote' };
  }

  return null;
}

function basename(filepath: string): string {
  return filepath.split('/').pop() || filepath;
}

// ── Direct shell execution (fast, no Claude needed) ────────────

function runShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, {
      cwd: WORKING_DIR,
      timeout: 30_000, // 30 seconds max for shell commands
      env: { ...process.env, NO_COLOR: '1', PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
    }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) {
        reject(new Error(`Shell error: ${error.message}`));
      } else {
        resolve(stdout || stderr || '(no output)');
      }
    });
  });
}

// ── Claude Code execution (slow, for complex tasks) ────────────

interface ClaudeRunOptions {
  onProgress?: (chunk: string) => void;
  onActivity?: (signal: ActivitySignal) => void;
}

function runClaude(prompt: string, options?: ClaudeRunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    // --dangerously-skip-permissions: required for non-interactive mode,
    // otherwise Claude hangs waiting for TTY permission prompts.
    const args = ['-p', '--dangerously-skip-permissions', prompt];

    const proc = spawn(CLAUDE_PATH, args, {
      cwd: WORKING_DIR,
      env: { ...process.env, NO_COLOR: '1' },
    });

    // Store reference for abort
    claudeProcess = proc;

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Manual kill timer — spawn's timeout option is unreliable
    const killTimer = setTimeout(() => {
      if (!killed) {
        killed = true;
        proc.kill('SIGKILL');
        reject(new Error(`Claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s. Partial output:\n${(stdout || stderr).slice(-500)}`));
      }
    }, CLAUDE_TIMEOUT_MS);

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      claudePartialOutput = stdout;
      options?.onProgress?.(chunk);

      // Parse for activity signals
      const signal = parseActivityFromChunk(chunk);
      if (signal) {
        claudeLastActivity = signal.summary;
        options?.onActivity?.(signal);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(killTimer);
      claudeProcess = null;
      if (killed) return; // already rejected by timeout
      if (code === 0 || code === null) {
        resolve(stdout || stderr || '(no output)');
      } else {
        reject(new Error(`claude exited with code ${code}: ${(stderr || stdout).slice(-500)}`));
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(killTimer);
      claudeProcess = null;
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

// ── Message formatting ─────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 50) + '\n\n... (truncated)';
}

function formatResponse(output: string): string {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  return truncate(clean, MAX_OUTPUT_CHARS);
}

function splitMessage(text: string): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    parts.push(remaining.slice(0, MAX_OUTPUT_CHARS));
    remaining = remaining.slice(MAX_OUTPUT_CHARS);
  }
  return parts;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec.toString().padStart(2, '0')}s`;
}

// ── Help message ───────────────────────────────────────────────

function getHelpMessage(): string {
  const categories: Record<string, CommandDef[]> = {};
  for (const cmd of ALLOWED_COMMANDS) {
    if (!categories[cmd.category]) categories[cmd.category] = [];
    categories[cmd.category].push(cmd);
  }

  const labels: Record<string, string> = {
    ci: '🔧 CI Failure Remediation',
    sre: '🚨 SRE / Production',
    qa: '✅ QA & Testing',
    review: '👀 PR Review',
    work: '📊 Project Awareness',
    info: '📋 Info & Read-only',
    ops: '⚙️ Ops',
    skill: '🚀 Skills (dangerous)',
  };

  const sections = Object.entries(categories).map(([cat, cmds]) => {
    const header = labels[cat] || cat;
    const items = cmds.map(cmd => {
      const icon = cmd.dangerous ? '⚠️' : '•';
      return `  ${icon} \`${cmd.pattern.source.replace(/\\/g, '').replace(/\^|\$/g, '').replace(/\\b/g, '').split('(').join('').split(')').join('').split('|').join(' / ')}\` — ${cmd.description}`;
    });
    return `**${header}**\n${items.join('\n')}`;
  });

  return [
    '**Claude Code ChatOps** — Available Commands\n',
    ...sections,
    '',
    '**🛑 Control Commands** (while Claude is running)',
    '  • `abort` / `stop` / `cancel` — Kill running Claude process',
    '  • `focus <instruction>` — Abort + restart with new focus',
    '',
    '🚫 **Blocked**: rm -rf, DROP TABLE, force push, railway up, sudo, secrets, git reset --hard',
    '\n_Commands execute on local Mac via Claude Code CLI._',
    '_CI fix flow: `ci logs` → `fix ci` → auto-fixes, commits, pushes._',
  ].join('\n');
}

// ── Abort handler ──────────────────────────────────────────────

function abortClaude(): { aborted: boolean; elapsed: string; lastActivity: string } {
  const elapsed = claudeStartTime ? formatElapsed(Date.now() - claudeStartTime) : '0s';
  const lastActivity = claudeLastActivity || 'unknown';

  if (claudeProcess) {
    claudeProcess.kill('SIGTERM');
    // Give SIGTERM 3s, then force kill
    setTimeout(() => {
      if (claudeProcess) {
        claudeProcess.kill('SIGKILL');
      }
    }, 3000);
  }

  claudeBusy = false;
  claudeCurrentCommand = '';
  claudeStartTime = null;
  claudeLastActivity = '';
  claudePartialOutput = '';
  claudeProcess = null;

  return { aborted: true, elapsed, lastActivity };
}

// ── Main listener ──────────────────────────────────────────────

export async function startChatOps(existingClient?: Client): Promise<void> {
  const client = existingClient || new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const onReady = () => {
    console.error(`[chatops] Listening in #${CHANNEL_NAME} for users: ${AUTHORIZED_USER_IDS.length > 0 ? AUTHORIZED_USER_IDS.join(', ') : '(any)'}`);
    console.error(`[chatops] Working directory: ${WORKING_DIR}`);
  };

  if (client.isReady()) {
    onReady();
  } else {
    client.once('ready', onReady);
  }

  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;
    if (!(message.channel instanceof TextChannel)) return;
    if (message.channel.name !== CHANNEL_NAME) return;

    // Only authorized users
    if (AUTHORIZED_USER_IDS.length > 0 && !AUTHORIZED_USER_IDS.includes(message.author.id)) {
      return;
    }

    const content = message.content.trim();
    if (!content) return;

    // Help command
    if (content.toLowerCase() === 'help') {
      await message.reply(getHelpMessage());
      return;
    }

    // ── Special: Abort/Stop/Cancel ──
    if (ABORT_PATTERN.test(content)) {
      if (!claudeBusy) {
        await message.reply('Nothing running to abort.');
        return;
      }
      const result = abortClaude();
      await message.reply(`🛑 Aborted \`${claudeCurrentCommand || 'command'}\` after ${result.elapsed}. Last activity: ${result.lastActivity}.`);
      return;
    }

    // ── Special: Focus (abort + restart with context) ──
    if (FOCUS_PATTERN.test(content)) {
      const focusMatch = content.match(FOCUS_PATTERN);
      const instruction = focusMatch ? focusMatch[1] : content;

      if (claudeBusy) {
        const lastOutput = claudePartialOutput.slice(-500);
        abortClaude();
        await message.reply(`🔄 Aborted previous run. Restarting with new focus...`);
        // Re-dispatch as a new claude command with context
        const focusPrompt = `Continue working on this codebase. Previous partial output (for context):\n\`\`\`\n${lastOutput}\n\`\`\`\n\nNew instruction: ${instruction}`;
        // Fake a message content and let it fall through to normal processing
        message.content = `show ${instruction}`; // Use 'show' prefix to match read-only pattern
        // Actually, let's handle it directly
        await handleClaudeCommand(message, focusPrompt, `focus: ${instruction.slice(0, 30)}`);
        return;
      } else {
        // Not busy — just treat focus as a regular command
        await handleClaudeCommand(message, instruction, `focus: ${instruction.slice(0, 30)}`);
        return;
      }
    }

    // ── Queue messages while Claude is busy ──
    if (claudeBusy) {
      // Check if it's a shell command that can run in parallel
      const validation = validateCommand(content);
      if (validation.allowed && validation.match?.shell) {
        // Shell commands can run while Claude is busy
        await message.react('⏳');
        try {
          const shellCmd = resolveShellCommand(validation.match, content);
          if (!shellCmd) {
            await message.reply('❌ Could not resolve command.');
            return;
          }
          console.error(`[chatops] Shell (parallel): ${shellCmd.slice(0, 80)}...`);
          const output = await runShell(shellCmd);
          const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
          await message.reactions.removeAll().catch(() => {});
          await message.react('✅');
          await message.reply(formatResponse(clean));
        } catch (err) {
          await message.reactions.removeAll().catch(() => {});
          await message.react('❌');
          const errMsg = err instanceof Error ? err.message : String(err);
          await message.reply(`❌ **Error**: ${truncate(errMsg, 500)}`);
        }
        return;
      }

      // Non-shell commands get queued
      const elapsed = claudeStartTime ? Math.round((Date.now() - claudeStartTime) / 1000) : 0;
      messageQueue.push(message);
      await message.reply(`⏳ Claude is running \`${claudeCurrentCommand}\` (${formatElapsed(elapsed * 1000)}). Your command is queued (#${messageQueue.length}). Shell commands still work.\n_Use \`abort\` to cancel, or \`focus <new instruction>\` to redirect._`);
      return;
    }

    // Validate
    const validation = validateCommand(content);
    if (!validation.allowed) {
      await message.reply(`❌ ${validation.reason}`);
      return;
    }

    // Thinking indicator
    await message.react('⏳');

    try {
      let output: string;

      if (validation.match?.shell) {
        // Fast path: direct shell command (seconds, not minutes)
        const shellCmd = resolveShellCommand(validation.match, content);
        if (!shellCmd) {
          await message.reply('❌ Could not resolve command (missing PR number?).');
          return;
        }
        console.error(`[chatops] Shell: ${shellCmd.slice(0, 80)}...`);
        output = await runShell(shellCmd);
      } else {
        // Slow path: full Claude invocation
        let prompt: string;
        const branchPrefix = 'First, note which git branch is currently checked out and include it at the top of your response like "Branch: `xyz`". Then: ';

        if (validation.match?.prompt) {
          prompt = branchPrefix + validation.match.prompt;
        } else if (validation.match?.skill) {
          prompt = branchPrefix + `Use the /${validation.match.skill} skill. Additional context: ${content}`;
        } else {
          // Handle PR summary command specially
          const prNum = extractPrNumber(content);
          if (/^pr #?\d+ summary/i.test(content) && prNum) {
            prompt = branchPrefix + `Summarize PR #${prNum}. Run \`gh pr view ${prNum}\` and \`gh pr diff ${prNum} --patch | head -200\`. Provide: 1) What changed and why 2) Risk areas 3) What to test. Be concise.`;
          } else {
            prompt = branchPrefix + content;
          }
        }

        await handleClaudeCommand(message, prompt, content.slice(0, 40));
        return; // handleClaudeCommand handles the reply
      }

      const clean = output.replace(/\x1b\[[0-9;]*m/g, '');

      await message.reactions.removeAll().catch(() => {});
      await message.react('✅');

      if (clean.length <= MAX_OUTPUT_CHARS) {
        await message.reply(clean);
      } else if (clean.length <= MAX_OUTPUT_CHARS * 3) {
        const parts = splitMessage(clean);
        for (const part of parts) {
          await message.reply(part);
        }
      } else {
        const head = clean.slice(0, 800);
        const tail = clean.slice(-1000);
        await message.reply(`${head}\n\n... _(${Math.round(clean.length / 1024)}KB output truncated)_ ...\n\n${tail}`);
      }
    } catch (err) {
      await message.reactions.removeAll().catch(() => {});
      await message.react('❌');
      const errMsg = err instanceof Error ? err.message : String(err);
      await message.reply(`❌ **Error**: ${truncate(errMsg, 500)}`);
    }
  });

  // ── Claude command handler with smart progress ──

  async function handleClaudeCommand(message: Message, prompt: string, label: string): Promise<void> {
    claudeBusy = true;
    claudeCurrentCommand = label;
    claudeStartTime = Date.now();
    claudeLastActivity = '';
    claudePartialOutput = '';
    messageQueue = [];

    await message.reply(`⏳ Running via Claude Code — I'll post progress updates as it works.\n_Shell commands still work. Use \`abort\` to cancel._`);

    // Failsafe: clear busy lock after CLAUDE_TIMEOUT_MS + 30s
    const busyFailsafe = setTimeout(() => {
      if (claudeBusy) {
        console.error('[chatops] Failsafe: clearing busy lock after timeout');
        claudeBusy = false;
        claudeCurrentCommand = '';
        claudeStartTime = null;
        claudeLastActivity = '';
        claudePartialOutput = '';
        claudeProcess = null;
      }
    }, CLAUDE_TIMEOUT_MS + 30_000);

    // Smart progress: debounced activity-based updates
    let lastProgressTime = 0;
    let lastProgressMessage = '';
    let activityCount = 0;

    const postProgress = async (signal: ActivitySignal) => {
      const now = Date.now();
      if (now - lastProgressTime < PROGRESS_DEBOUNCE_MS) return;
      if (signal.summary === lastProgressMessage) return; // Skip duplicate

      lastProgressTime = now;
      lastProgressMessage = signal.summary;
      activityCount++;

      const elapsed = claudeStartTime ? formatElapsed(now - claudeStartTime) : '0s';
      let progressMsg = `⚙️ ${signal.summary} (${elapsed})`;
      if (signal.detail) {
        progressMsg += `\n\`${signal.detail}\``;
      }

      try {
        await message.reply(progressMsg);
      } catch {
        // Message may have been deleted, ignore
      }
    };

    // Fallback timer: if no activity signal in 60s, post elapsed time
    const fallbackInterval = setInterval(async () => {
      if (!claudeBusy) {
        clearInterval(fallbackInterval);
        return;
      }
      const now = Date.now();
      // Only post fallback if no activity-based update in the last 45s
      if (now - lastProgressTime >= 45_000) {
        const elapsed = claudeStartTime ? formatElapsed(now - claudeStartTime) : '0s';
        const activity = claudeLastActivity ? ` Last: ${claudeLastActivity}` : '';
        try {
          await message.reply(`⏳ Still working... (${elapsed})${activity}`);
        } catch {
          // ignore
        }
        lastProgressTime = now;
      }
    }, 60_000);

    try {
      console.error(`[chatops] Claude: ${prompt.slice(0, 80)}...`);
      const output = await runClaude(prompt, {
        onActivity: postProgress,
      });

      const clean = output.replace(/\x1b\[[0-9;]*m/g, '');

      await message.reactions.removeAll().catch(() => {});
      await message.react('✅');

      const elapsed = claudeStartTime ? formatElapsed(Date.now() - claudeStartTime) : '';
      const donePrefix = elapsed ? `✅ Done in ${elapsed}.\n\n` : '';

      if (clean.length <= MAX_OUTPUT_CHARS - donePrefix.length) {
        await message.reply(donePrefix + clean);
      } else if (clean.length <= MAX_OUTPUT_CHARS * 3) {
        const parts = splitMessage(clean);
        await message.reply(donePrefix + parts[0]);
        for (let i = 1; i < parts.length; i++) {
          await message.reply(parts[i]);
        }
      } else {
        const head = clean.slice(0, 600);
        const tail = clean.slice(-1000);
        await message.reply(`${donePrefix}${head}\n\n... _(${Math.round(clean.length / 1024)}KB output truncated)_ ...\n\n${tail}`);
      }
    } catch (err) {
      await message.reactions.removeAll().catch(() => {});
      await message.react('❌');
      const errMsg = err instanceof Error ? err.message : String(err);
      await message.reply(`❌ **Error**: ${truncate(errMsg, 500)}`);
    } finally {
      claudeBusy = false;
      claudeCurrentCommand = '';
      claudeStartTime = null;
      claudeLastActivity = '';
      claudePartialOutput = '';
      claudeProcess = null;
      clearTimeout(busyFailsafe);
      clearInterval(fallbackInterval);

      // Process queued messages
      if (messageQueue.length > 0) {
        const nextMsg = messageQueue.shift()!;
        messageQueue = []; // Clear remaining queue — only process first
        try {
          await nextMsg.reply(`📤 Processing your queued command: \`${nextMsg.content.slice(0, 40)}\``);
          // Re-emit the message to trigger normal processing
          client.emit('messageCreate', nextMsg as any);
        } catch {
          // Queued message may have been deleted
        }
      }
    }
  }

  if (!existingClient) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN not set');
    await client.login(token);
  }
}
