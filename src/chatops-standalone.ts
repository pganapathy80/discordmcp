/**
 * Standalone ChatOps runner — runs independently of the MCP server.
 * Usage: node build/chatops-standalone.js
 */

import dotenv from 'dotenv';
import { startChatOps } from './chatops.js';

dotenv.config();

console.error('[chatops] Starting standalone ChatOps listener...');
startChatOps().catch(err => {
  console.error('[chatops] Fatal error:', err);
  process.exit(1);
});
