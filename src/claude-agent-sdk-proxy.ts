import {
	calculateCost,
	createAssistantMessageEventStream,
	getModels,
	registerApiProvider,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Tool,
} from "@mariozechner/pi-ai";
import { createSdkMcpServer, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const API_ID = "claude-agent-sdk";
const MCP_SERVER_NAME = "custom-tools";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution is unavailable in this environment.";

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read",
	write: "write",
	edit: "edit",
	bash: "bash",
};

const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
};

const BUILTIN_TOOL_NAMES = new Set(Object.keys(PI_TO_SDK_TOOL_NAME));
const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Bash"];

let isRegistered = false;

function contentToText(
	content:
		| string
		| Array<{
				type: string;
				text?: string;
				thinking?: string;
				name?: string;
				arguments?: Record<string, unknown>;
		  }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "thinking") return block.thinking ?? "";
			if (block.type === "toolCall") {
				const args = block.arguments ? JSON.stringify(block.arguments) : "{}";
				return `Historical tool call (non-executable): ${block.name ?? "unknown"} args=${args}`;
			}
			return `[${block.type}]`;
		})
		.join("\n");
}

function buildPromptText(context: Context): string {
	const lines: string[] = [];

	if (context.systemPrompt?.trim()) {
		lines.push("SYSTEM:");
		lines.push(context.systemPrompt);
	}

	for (const message of context.messages) {
		if (message.role === "user") {
			lines.push("\nUSER:");
			if (typeof message.content === "string") {
				lines.push(message.content);
			} else {
				for (const block of message.content) {
					if (block.type === "text") lines.push(block.text);
					if (block.type === "image") lines.push("(image attachment)");
				}
			}
			continue;
		}

		if (message.role === "assistant") {
			lines.push("\nASSISTANT:");
			lines.push(contentToText(message.content));
			continue;
		}

		if (message.role === "toolResult") {
			lines.push(`\nTOOL RESULT (${message.toolName}):`);
			if (typeof message.content === "string") {
				lines.push(message.content);
			} else {
				for (const block of message.content) {
					if (block.type === "text") lines.push(block.text);
					if (block.type === "image") lines.push("(image output)");
				}
			}
		}
	}

	return lines.join("\n").trim();
}

function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

function mapToolArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
	const normalized = toolName.toLowerCase();
	const input = args ?? {};

	switch (normalized) {
		case "read":
			return {
				path: input.file_path ?? input.path,
				offset: input.offset,
				limit: input.limit,
			};
		case "write":
			return {
				path: input.file_path ?? input.path,
				content: input.content,
			};
		case "edit":
			return {
				path: input.file_path ?? input.path,
				oldText: input.old_string ?? input.oldText ?? input.old_text,
				newText: input.new_string ?? input.newText ?? input.new_text,
			};
		case "bash":
			return {
				command: input.command,
				timeout: input.timeout,
			};
		default:
			return input;
	}
}

function resolveSdkTools(context: Context): {
	sdkTools: string[];
	customTools: Tool[];
	customToolNameToPi: Map<string, string>;
} {
	if (!context.tools) {
		return {
			sdkTools: [...DEFAULT_TOOLS],
			customTools: [],
			customToolNameToPi: new Map(),
		};
	}

	const sdkTools = new Set<string>();
	const customTools: Tool[] = [];
	const customToolNameToPi = new Map<string, string>();

	for (const tool of context.tools) {
		const normalized = tool.name.toLowerCase();
		if (BUILTIN_TOOL_NAMES.has(normalized)) {
			const sdkName = PI_TO_SDK_TOOL_NAME[normalized];
			if (sdkName) sdkTools.add(sdkName);
			continue;
		}
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		customTools.push(tool);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { sdkTools: Array.from(sdkTools), customTools, customToolNameToPi };
}

function buildCustomToolServers(customTools: Tool[]): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!customTools.length) return undefined;

	const mcpTools = customTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as unknown,
		handler: async () => ({
			content: [{ type: "text" as const, text: TOOL_EXECUTION_DENIED_MESSAGE }],
			isError: true,
		}),
	}));

	const server = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		version: "1.0.0",
		tools: mcpTools,
	});

	return { [MCP_SERVER_NAME]: server };
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		default:
			return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try {
		return JSON.parse(input);
	} catch {
		return fallback;
	}
}

function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let started = false;
		let sdkQuery: ReturnType<typeof query> | undefined;

		try {
			const { sdkTools, customTools, customToolNameToPi } = resolveSdkTools(context);
			const promptText = buildPromptText(context);
			const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			const mcpServers = buildCustomToolServers(customTools);

			sdkQuery = query({
				prompt: promptText,
				options: {
					cwd,
					tools: sdkTools,
					permissionMode: "dontAsk",
					includePartialMessages: true,
					canUseTool: async () => ({
						behavior: "deny",
						message: TOOL_EXECUTION_DENIED_MESSAGE,
					}),
					systemPrompt: {
						type: "preset",
						preset: "claude_code",
					},
					...(mcpServers ? { mcpServers } : {}),
				},
			});

			const blocks = output.content as Array<
				| { type: "text"; text: string; index: number }
				| {
						type: "toolCall";
						id: string;
						name: string;
						arguments: Record<string, unknown>;
						partialJson: string;
						index: number;
				  }
			>;

			for await (const message of sdkQuery) {
				if (!started) {
					stream.push({ type: "start", partial: output });
					started = true;
				}

				if (message.type === "stream_event") {
					const event = (message as SDKMessage & { event: any }).event;

					if (event?.type === "message_start") {
						const usage = event.message?.usage;
						output.usage.input = usage?.input_tokens ?? 0;
						output.usage.output = usage?.output_tokens ?? 0;
						output.usage.cacheRead = usage?.cache_read_input_tokens ?? 0;
						output.usage.cacheWrite = usage?.cache_creation_input_tokens ?? 0;
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
						continue;
					}

					if (event?.type === "content_block_start") {
						if (event.content_block?.type === "text") {
							const block = { type: "text", text: "", index: event.index } as const;
							output.content.push(block);
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
							continue;
						}

						if (event.content_block?.type === "tool_use") {
							const block = {
								type: "toolCall",
								id: event.content_block.id,
								name: mapToolName(event.content_block.name, customToolNameToPi),
								arguments: (event.content_block.input as Record<string, unknown>) ?? {},
								partialJson: "",
								index: event.index,
							} as const;
							output.content.push(block);
							stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
							continue;
						}
					}

					if (event?.type === "content_block_delta") {
						if (event.delta?.type === "text_delta") {
							const index = blocks.findIndex((block) => block.index === event.index);
							const block = blocks[index];
							if (block?.type === "text") {
								block.text += event.delta.text;
								stream.push({
									type: "text_delta",
									contentIndex: index,
									delta: event.delta.text,
									partial: output,
								});
							}
							continue;
						}

						if (event.delta?.type === "input_json_delta") {
							const index = blocks.findIndex((block) => block.index === event.index);
							const block = blocks[index];
							if (block?.type === "toolCall") {
								block.partialJson += event.delta.partial_json;
								block.arguments = parsePartialJson(block.partialJson, block.arguments);
								stream.push({
									type: "toolcall_delta",
									contentIndex: index,
									delta: event.delta.partial_json,
									partial: output,
								});
							}
							continue;
						}
					}

					if (event?.type === "content_block_stop") {
						const index = blocks.findIndex((block) => block.index === event.index);
						const block = blocks[index];
						if (!block) continue;
						delete (block as any).index;

						if (block.type === "text") {
							stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
							continue;
						}

						if (block.type === "toolCall") {
							block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson, block.arguments));
							delete (block as any).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
							continue;
						}
					}

					if (event?.type === "message_delta") {
						output.stopReason = mapStopReason(event.delta?.stop_reason);
						const usage = event.usage ?? {};
						if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
						if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
						if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
						if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
						continue;
					}
				}

				if (message.type === "result" && message.subtype === "success" && output.content.length === 0) {
					output.content.push({ type: "text", text: message.result || "" });
				}
			}

			stream.push({
				type: "done",
				reason: output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "length" ? "length" : "stop",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		} finally {
			sdkQuery?.close();
		}
	})();

	return stream;
}

export interface ClaudeAgentSdkOptions {
	modelId?: string;
}

export function setupClaudeAgentSdkProxy(options?: ClaudeAgentSdkOptions): Model<any> {
	if (!isRegistered) {
		registerApiProvider(
			{
				api: API_ID,
				stream: streamClaudeAgentSdk as any,
				streamSimple: streamClaudeAgentSdk,
			},
			"icarus-claude-agent-sdk",
		);
		isRegistered = true;
	}

	const requestedModel = options?.modelId ?? "claude-sonnet-4-5";
	const anthropicModel = getModels("anthropic").find((m) => m.id === requestedModel) ?? getModels("anthropic")[0];

	return {
		...anthropicModel,
		provider: "claude-agent-sdk",
		api: API_ID,
	};
}
