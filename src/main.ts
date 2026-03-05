#!/usr/bin/env node

import { createDiscordAdapter } from "@chat-adapter/discord";
import { createRedisState } from "@chat-adapter/state-redis";
import { Chat, emoji } from "chat";
import { readFileSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { basename, join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import type { SlackContext } from "./slack.js";
import { ChannelStore } from "./store.js";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const DISCORD_APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	port: number;
}

interface ConversationState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let port = 3000;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--port=")) {
			port = parseInt(arg.slice("--port=".length), 10) || 3000;
		} else if (arg === "--port") {
			port = parseInt(args[++i] || "", 10) || 3000;
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		port,
	};
}

function sanitizeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getConversationId(thread: any, message: any): string {
	if (thread.isDM) {
		const userId = message.author?.userId || thread.channelId || thread.id;
		return `dm_${sanitizeId(userId)}`;
	}
	return sanitizeId(thread.id as string);
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks);
}

function writeResponse(nodeRes: ServerResponse, res: Response, body: Buffer): void {
	nodeRes.statusCode = res.status;
	res.headers.forEach((value, key) => nodeRes.setHeader(key, value));
	nodeRes.end(body);
}

function createChatContext(thread: any, message: any, conversationId: string, store: ChannelStore): SlackContext {
	let mainMessage: any | null = null;
	const threadMessages: any[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();
	let botResponseCounter = 0;

	const postOrUpdateMain = async (text: string): Promise<void> => {
		if (mainMessage) {
			await mainMessage.edit(text);
		} else {
			mainMessage = await thread.post(text);
		}
	};

	return {
		message: {
			text: message.text || "",
			rawText: message.text || "",
			user: message.author?.userId || "unknown",
			userName: message.author?.userName,
			channel: conversationId,
			ts: message.id || `${Date.now()}`,
			attachments: [],
		},
		channelName: undefined,
		channels: [],
		users: [],

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
				const displayText = isWorking ? `${accumulatedText}${workingIndicator}` : accumulatedText;
				await postOrUpdateMain(displayText);

				if (shouldLog) {
					botResponseCounter += 1;
					await store.logBotResponse(conversationId, text, `${Date.now()}-${botResponseCounter}`);
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = text;
				const displayText = isWorking ? `${accumulatedText}${workingIndicator}` : accumulatedText;
				await postOrUpdateMain(displayText);
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				const sent = await thread.post(text);
				threadMessages.push(sent);
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (!isTyping) return;
			updatePromise = updatePromise.then(async () => {
				await thread.startTyping();
				if (!mainMessage) {
					accumulatedText = "_Thinking_";
					await postOrUpdateMain(`${accumulatedText}${workingIndicator}`);
				}
			});
			await updatePromise;
		},

		uploadFile: async (filePath: string, title?: string) => {
			const buffer = readFileSync(filePath);
			await thread.post({
				markdown: title ? `Uploaded: ${title}` : `Uploaded: ${basename(filePath)}`,
				files: [{ data: buffer, filename: title || basename(filePath) }],
			});
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				isWorking = working;
				if (mainMessage) {
					const displayText = isWorking ? `${accumulatedText}${workingIndicator}` : accumulatedText;
					await postOrUpdateMain(displayText);
				}
			});
			await updatePromise;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				for (let i = threadMessages.length - 1; i >= 0; i--) {
					try {
						await threadMessages[i].delete();
					} catch {
						// ignore
					}
				}
				threadMessages.length = 0;

				if (mainMessage) {
					await mainMessage.delete();
					mainMessage = null;
				}
			});
			await updatePromise;
		},
	};
}

async function addWorkingReaction(thread: any, message: any): Promise<void> {
	if (thread.isDM) return;
	if (!message?.id) return;
	try {
		await thread.adapter.addReaction(thread.id, message.id, emoji.eyes);
	} catch (err) {
		log.logWarning("Failed to add 👀 reaction", err instanceof Error ? err.message : String(err));
	}
}

async function removeWorkingReaction(thread: any, message: any): Promise<void> {
	if (thread.isDM) return;
	if (!message?.id) return;
	try {
		await thread.adapter.removeReaction(thread.id, message.id, emoji.eyes);
	} catch {
		// best effort
	}
}

const parsedArgs = parseArgs();
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>] [--port=3000] <working-directory>");
	process.exit(1);
}

if (!DISCORD_BOT_TOKEN || !DISCORD_PUBLIC_KEY || !DISCORD_APPLICATION_ID) {
	console.error("Missing env: DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID");
	process.exit(1);
}

const { workingDir, sandbox, port } = parsedArgs;
await validateSandbox(sandbox);

const conversationStates = new Map<string, ConversationState>();
const sharedStore = new ChannelStore({ workingDir, botToken: DISCORD_BOT_TOKEN });

function getState(conversationId: string): ConversationState {
	let state = conversationStates.get(conversationId);
	if (!state) {
		const conversationDir = join(workingDir, conversationId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, conversationId, conversationDir),
			store: sharedStore,
			stopRequested: false,
		};
		conversationStates.set(conversationId, state);
	}
	return state;
}

const discordAdapter = createDiscordAdapter({
	botToken: DISCORD_BOT_TOKEN,
	publicKey: DISCORD_PUBLIC_KEY,
	applicationId: DISCORD_APPLICATION_ID,
});

const bot = new Chat({
	userName: "mom",
	adapters: {
		discord: discordAdapter,
	},
	state: createRedisState(),
});

const runThreadMessage = async (thread: any, message: any): Promise<void> => {
	if (message.author?.isMe) return;

	const conversationId = getConversationId(thread, message);
	const state = getState(conversationId);
	const text = (message.text || "").trim();

	if (text.toLowerCase() === "stop") {
		if (state.running) {
			state.stopRequested = true;
			state.runner.abort();
			await thread.post("_Stopping..._");
		} else {
			await thread.post("_Nothing running_");
		}
		return;
	}

	if (state.running) {
		await thread.post("_Already working. Say `stop` to cancel._");
		return;
	}

	await state.store.logMessage(conversationId, {
		date: new Date().toISOString(),
		ts: message.id || `${Date.now()}`,
		user: message.author?.userId || "unknown",
		userName: message.author?.userName,
		displayName: message.author?.fullName,
		text,
		attachments: [],
		isBot: false,
	});

	state.running = true;
	state.stopRequested = false;
	await addWorkingReaction(thread, message);

	log.logInfo(`[${conversationId}] Starting run: ${text.substring(0, 80)}`);

	try {
		const ctx = createChatContext(thread, message, conversationId, state.store);
		await ctx.setTyping(true);
		await ctx.setWorking(true);

		const result = await state.runner.run(ctx, state.store);

		await ctx.setWorking(false);

		if (result.stopReason === "aborted" && state.stopRequested) {
			await thread.post("_Stopped_");
		}
	} catch (err) {
		log.logWarning(`[${conversationId}] Run error`, err instanceof Error ? err.message : String(err));
		await thread.post("_Sorry, something went wrong._");
	} finally {
		await removeWorkingReaction(thread, message);
		state.running = false;
	}
};

bot.onNewMention(async (thread, message) => {
	await thread.subscribe();
	await runThreadMessage(thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
	await runThreadMessage(thread, message);
});

await bot.initialize();

const discordWebhookHandler = bot.webhooks.discord;

let shuttingDown = false;

const gatewayLoop = async (): Promise<void> => {
	while (!shuttingDown) {
		try {
			const response = await discordAdapter.startGatewayListener(
				{
					waitUntil: (task: Promise<unknown>) => {
						void task.catch((err) => log.logWarning("Gateway background task failed", String(err)));
					},
				},
				10 * 60 * 1000,
				undefined,
				DISCORD_WEBHOOK_URL,
			);

			if (!response.ok) {
				const text = await response.text();
				log.logWarning("Discord gateway listener ended with non-ok response", `${response.status}: ${text}`);
			}
		} catch (err) {
			log.logWarning("Discord gateway listener crashed", err instanceof Error ? err.message : String(err));
		}

		if (!shuttingDown) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
};

const server = createServer(async (req, res) => {
	try {
		if (!req.url || !req.method) {
			res.statusCode = 400;
			res.end("Bad Request");
			return;
		}

		if (req.method === "POST" && req.url.startsWith("/api/webhooks/discord")) {
			const body = await readRequestBody(req);
			const url = `http://${req.headers.host || `localhost:${port}`}${req.url}`;
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (value === undefined) continue;
				headers.set(key, Array.isArray(value) ? value.join(",") : value);
			}

			const request = new Request(url, {
				method: req.method,
				headers,
				body: body.length > 0 ? new Uint8Array(body) : undefined,
			});

			const response = await discordWebhookHandler(request, {
				waitUntil: (task: Promise<unknown>) => {
					void task.catch((err) => log.logWarning("Discord webhook background task failed", String(err)));
				},
			});
			const responseBody = Buffer.from(await response.arrayBuffer());
			writeResponse(res, response, responseBody);
			return;
		}

		res.statusCode = 404;
		res.end("Not Found");
	} catch (err) {
		log.logWarning("Webhook server error", err instanceof Error ? err.message : String(err));
		res.statusCode = 500;
		res.end("Internal Server Error");
	}
});

server.listen(port, () => {
	log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);
	log.logInfo(`Discord webhook server listening on :${port} (/api/webhooks/discord)`);
	void gatewayLoop();
});

const shutdown = () => {
	if (shuttingDown) return;
	shuttingDown = true;
	log.logInfo("Shutting down...");
	server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
