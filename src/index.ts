import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from 'dotenv';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits, TextChannel, ChannelType, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { startChatOps } from './chatops.js';

// Load environment variables
dotenv.config();

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Helper function to find a guild by name or ID
async function findGuild(guildIdentifier?: string) {
  if (!guildIdentifier) {
    // If no guild specified and bot is only in one guild, use that
    if (client.guilds.cache.size === 1) {
      return client.guilds.cache.first()!;
    }
    // List available guilds
    const guildList = Array.from(client.guilds.cache.values())
      .map(g => `"${g.name}"`).join(', ');
    throw new Error(`Bot is in multiple servers. Please specify server name or ID. Available servers: ${guildList}`);
  }

  // Try to fetch by ID first
  try {
    const guild = await client.guilds.fetch(guildIdentifier);
    if (guild) return guild;
  } catch {
    // If ID fetch fails, search by name
    const guilds = client.guilds.cache.filter(
      g => g.name.toLowerCase() === guildIdentifier.toLowerCase()
    );
    
    if (guilds.size === 0) {
      const availableGuilds = Array.from(client.guilds.cache.values())
        .map(g => `"${g.name}"`).join(', ');
      throw new Error(`Server "${guildIdentifier}" not found. Available servers: ${availableGuilds}`);
    }
    if (guilds.size > 1) {
      const guildList = guilds.map(g => `${g.name} (ID: ${g.id})`).join(', ');
      throw new Error(`Multiple servers found with name "${guildIdentifier}": ${guildList}. Please specify the server ID.`);
    }
    return guilds.first()!;
  }
  throw new Error(`Server "${guildIdentifier}" not found`);
}

// Helper function to find a channel by name or ID within a specific guild
async function findChannel(channelIdentifier: string, guildIdentifier?: string): Promise<TextChannel> {
  const guild = await findGuild(guildIdentifier);
  
  // First try to fetch by ID
  try {
    const channel = await client.channels.fetch(channelIdentifier);
    if (channel instanceof TextChannel && channel.guild.id === guild.id) {
      return channel;
    }
  } catch {
    // If fetching by ID fails, search by name in the specified guild
    const channels = guild.channels.cache.filter(
      (channel): channel is TextChannel =>
        channel instanceof TextChannel &&
        (channel.name.toLowerCase() === channelIdentifier.toLowerCase() ||
         channel.name.toLowerCase() === channelIdentifier.toLowerCase().replace('#', ''))
    );

    if (channels.size === 0) {
      const availableChannels = guild.channels.cache
        .filter((c): c is TextChannel => c instanceof TextChannel)
        .map(c => `"#${c.name}"`).join(', ');
      throw new Error(`Channel "${channelIdentifier}" not found in server "${guild.name}". Available channels: ${availableChannels}`);
    }
    if (channels.size > 1) {
      const channelList = channels.map(c => `#${c.name} (${c.id})`).join(', ');
      throw new Error(`Multiple channels found with name "${channelIdentifier}" in server "${guild.name}": ${channelList}. Please specify the channel ID.`);
    }
    return channels.first()!;
  }
  throw new Error(`Channel "${channelIdentifier}" is not a text channel or not found in server "${guild.name}"`);
}

// Updated validation schemas
const SendMessageSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  message: z.string(),
});

const ReadMessagesSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  limit: z.number().min(1).max(100).default(50),
});

const CreateChannelSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  name: z.string().describe('Channel name (e.g., "updates")'),
  topic: z.string().optional().describe('Channel topic/description'),
});

const CreateWebhookSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name or ID to create webhook for'),
  name: z.string().default('PrepMe Bot').describe('Webhook display name'),
});

const ListChannelsSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
});

const SendEmbedFieldSchema = z.object({
  name: z.string().describe('Field name/title'),
  value: z.string().describe('Field value'),
  inline: z.boolean().optional().default(false).describe('Display field inline'),
});

const SendEmbedSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name (e.g., "deployments") or ID'),
  title: z.string().describe('Embed title'),
  description: z.string().optional().describe('Embed description (markdown supported)'),
  color: z.number().optional().describe('Embed color as decimal (e.g., 3066993 for green, 15158332 for red, 3447003 for blue)'),
  fields: z.array(SendEmbedFieldSchema).optional().describe('Embed fields'),
  footer: z.string().optional().describe('Footer text'),
  url: z.string().optional().describe('URL to link the title to'),
});

// Create server instance
const server = new Server(
  {
    name: "discord",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "send-message",
        description: "Send a message to a Discord channel",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: 'Channel name (e.g., "general") or ID',
            },
            message: {
              type: "string",
              description: "Message content to send",
            },
          },
          required: ["channel", "message"],
        },
      },
      {
        name: "read-messages",
        description: "Read recent messages from a Discord channel",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: 'Channel name (e.g., "general") or ID',
            },
            limit: {
              type: "number",
              description: "Number of messages to fetch (max 100)",
              default: 50,
            },
          },
          required: ["channel"],
        },
      },
      {
        name: "create-channel",
        description: "Create a new text channel in a Discord server",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            name: {
              type: "string",
              description: 'Channel name (e.g., "updates")',
            },
            topic: {
              type: "string",
              description: "Channel topic/description",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "create-webhook",
        description: "Create a webhook for a Discord channel. Returns the webhook URL.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: 'Channel name or ID to create webhook for',
            },
            name: {
              type: "string",
              description: 'Webhook display name (default: "PrepMe Bot")',
            },
          },
          required: ["channel"],
        },
      },
      {
        name: "list-channels",
        description: "List all text channels in a Discord server",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
          },
        },
      },
      {
        name: "send-embed",
        description: "Send a rich embed message to a Discord channel. Use for structured results with title, colored sidebar, fields, and footer.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: 'Channel name (e.g., "deployments") or ID',
            },
            title: {
              type: "string",
              description: "Embed title",
            },
            description: {
              type: "string",
              description: "Embed description (markdown supported)",
            },
            color: {
              type: "number",
              description: "Embed color as decimal (3066993=green, 15158332=red, 3447003=blue, 16776960=yellow)",
            },
            fields: {
              type: "array",
              description: "Embed fields",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Field name" },
                  value: { type: "string", description: "Field value" },
                  inline: { type: "boolean", description: "Display inline (default: false)" },
                },
                required: ["name", "value"],
              },
            },
            footer: {
              type: "string",
              description: "Footer text",
            },
            url: {
              type: "string",
              description: "URL to link the embed title to",
            },
          },
          required: ["channel", "title"],
        },
      },
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "send-message": {
        const { channel: channelIdentifier, message } = SendMessageSchema.parse(args);
        const channel = await findChannel(channelIdentifier);
        
        const sent = await channel.send(message);
        return {
          content: [{
            type: "text",
            text: `Message sent successfully to #${channel.name} in ${channel.guild.name}. Message ID: ${sent.id}`,
          }],
        };
      }

      case "read-messages": {
        const { channel: channelIdentifier, limit } = ReadMessagesSchema.parse(args);
        const channel = await findChannel(channelIdentifier);
        
        const messages = await channel.messages.fetch({ limit });
        const formattedMessages = Array.from(messages.values()).map(msg => ({
          channel: `#${channel.name}`,
          server: channel.guild.name,
          author: msg.author.tag,
          content: msg.content,
          timestamp: msg.createdAt.toISOString(),
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify(formattedMessages, null, 2),
          }],
        };
      }

      case "create-channel": {
        const { server: serverIdentifier, name: channelName, topic } = CreateChannelSchema.parse(args);
        const guild = await findGuild(serverIdentifier);

        const channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          topic: topic || undefined,
        });

        return {
          content: [{
            type: "text",
            text: `Channel #${channel.name} created in ${guild.name}. Channel ID: ${channel.id}`,
          }],
        };
      }

      case "create-webhook": {
        const { server: serverIdentifier, channel: channelIdentifier, name: webhookName } = CreateWebhookSchema.parse(args);
        const channel = await findChannel(channelIdentifier, serverIdentifier);

        const webhook = await channel.createWebhook({
          name: webhookName,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: `Webhook "${webhookName}" created for #${channel.name}`,
              webhookUrl: webhook.url,
              webhookId: webhook.id,
              channel: channel.name,
              server: channel.guild.name,
            }, null, 2),
          }],
        };
      }

      case "list-channels": {
        const { server: serverIdentifier } = ListChannelsSchema.parse(args);
        const guild = await findGuild(serverIdentifier);

        const channels = guild.channels.cache
          .filter((c): c is TextChannel => c instanceof TextChannel)
          .map(c => ({
            name: `#${c.name}`,
            id: c.id,
            topic: c.topic || '',
          }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify(channels, null, 2),
          }],
        };
      }

      case "send-embed": {
        const {
          server: serverIdentifier,
          channel: channelIdentifier,
          title,
          description,
          color,
          fields,
          footer,
          url,
        } = SendEmbedSchema.parse(args);
        const channel = await findChannel(channelIdentifier, serverIdentifier);

        const embed: Record<string, unknown> = { title };
        if (description) embed.description = description;
        if (color !== undefined) embed.color = color;
        if (url) embed.url = url;
        if (fields && fields.length > 0) {
          embed.fields = fields.map(f => ({
            name: f.name,
            value: f.value,
            inline: f.inline ?? false,
          }));
        }
        if (footer) embed.footer = { text: footer };

        const sent = await channel.send({ embeds: [embed as any] });
        return {
          content: [{
            type: "text",
            text: `Embed sent to #${channel.name} in ${channel.guild.name}. Message ID: ${sent.id}`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    }
    throw error;
  }
});

// Discord client login and error handling
client.once('ready', () => {
  console.error('Discord bot is ready!');
});

// Start the server
async function main() {
  // Check for Discord token
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN environment variable is not set');
  }
  
  try {
    // Login to Discord
    await client.login(token);

    // Start ChatOps listener (runs alongside MCP server)
    if (process.env.DISCORD_AUTHORIZED_USER_ID) {
      await startChatOps(client);
      console.error("ChatOps listener enabled");
    } else {
      console.error("ChatOps disabled (set DISCORD_AUTHORIZED_USER_ID to enable)");
    }

    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Discord MCP Server running on stdio");
  } catch (error) {
    console.error("Fatal error in main():", error);
    process.exit(1);
  }
}

main();