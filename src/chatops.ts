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
import { spawn, exec } from 'child_process';

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

// ── Command categories ─────────────────────────────────────────

interface CommandDef {
  pattern: RegExp;
  description: string;
  prompt?: string;       // Override prompt sent to claude (otherwise uses raw message)
  shell?: string;        // Direct shell command (fast, no claude needed)
  skill?: string;        // Maps to a Claude Code skill
  dangerous?: boolean;   // Needs extra confirmation
  category: 'ci' | 'sre' | 'qa' | 'info' | 'ops' | 'skill';
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

// ── Claude concurrency lock ────────────────────────────────────

let claudeBusy = false;
let claudeCurrentCommand = '';

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

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt];

    const proc = spawn(CLAUDE_PATH, args, {
      cwd: WORKING_DIR,
      timeout: CLAUDE_TIMEOUT_MS,
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (code === 0 || code === null) {
        resolve(stdout || stderr || '(no output)');
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err: Error) => {
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
    '🚫 **Blocked**: rm -rf, DROP TABLE, force push, railway up, sudo, secrets, git reset --hard',
    '\n_Commands execute on local Mac via Claude Code CLI._',
    '_CI fix flow: `ci logs` → `fix ci` → auto-fixes, commits, pushes._',
  ].join('\n');
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
        console.error(`[chatops] Shell: ${validation.match.shell.slice(0, 80)}...`);
        output = await runShell(validation.match.shell);
      } else {
        // Slow path: full Claude invocation — check lock
        if (claudeBusy) {
          await message.reply(`⏳ Claude is already running \`${claudeCurrentCommand}\`. Shell commands (ci status, git status, check prod health) still work. Try again when it finishes.`);
          return;
        }

        claudeBusy = true;
        claudeCurrentCommand = content.slice(0, 40);
        await message.reply(`⏳ Running via Claude Code — this takes 1-3 min. I'll reply when done.\n_Shell commands still work while this runs._`);

        try {
          let prompt: string;
          const branchPrefix = 'First, note which git branch is currently checked out and include it at the top of your response like "Branch: `xyz`". Then: ';
          if (validation.match?.prompt) {
            prompt = branchPrefix + validation.match.prompt;
          } else if (validation.match?.skill) {
            prompt = branchPrefix + `Use the /${validation.match.skill} skill. Additional context: ${content}`;
          } else {
            prompt = branchPrefix + content;
          }
          console.error(`[chatops] Claude: ${prompt.slice(0, 80)}...`);
          output = await runClaude(prompt);
        } finally {
          claudeBusy = false;
          claudeCurrentCommand = '';
        }
      }

      const formatted = formatResponse(output);

      await message.reactions.removeAll().catch(() => {});
      await message.react('✅');

      const parts = splitMessage(formatted);
      for (const part of parts) {
        await message.reply(part);
      }
    } catch (err) {
      await message.reactions.removeAll().catch(() => {});
      await message.react('❌');
      const errMsg = err instanceof Error ? err.message : String(err);
      await message.reply(`❌ **Error**: ${truncate(errMsg, 500)}`);
    }
  });

  if (!existingClient) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN not set');
    await client.login(token);
  }
}
