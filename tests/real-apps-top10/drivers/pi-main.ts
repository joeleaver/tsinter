// pi workload: packages/agent (@earendil-works/pi-agent-core), the agent loop under pi's coding-agent CLI,
// driven offline by a scripted model (the CLI itself needs generated model data and a provider, see README).
//   pi-main.ts loop     -> a 3-turn conversation: text, two parallel tool calls, a tool error, final answer
//   pi-main.ts badargs  -> a tool call whose arguments fail the tool's pi-schema validation
//   pi-main.ts steer    -> a follow-up message queued while the agent runs
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { obj, str, num, arr, type Static } from "@earendil-works/pi-schema";
import { Agent } from "../src/agent.ts";
import type { AgentEvent, AgentMessage, AgentTool } from "../src/types.ts";

const usage = () => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const model: Model<"openai-responses"> = {
  id: "scripted", name: "scripted", api: "openai-responses", provider: "openai", baseUrl: "https://example.invalid",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 2048,
};
let clock = 1_700_000_000_000;
const tick = () => (clock += 1000);
function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: "openai-responses", provider: "openai", model: "scripted", usage: usage(), stopReason, timestamp: tick() };
}

// The scripted "model": answers by turn number, streaming text deltas like a provider would.
function scriptedStream(script: Array<(messages: Message[]) => AssistantMessage>) {
  let turn = 0;
  return (_m: Model<any>, context: { messages: Message[] }) => {
    const stream = createAssistantMessageEventStream();
    const msg = script[Math.min(turn++, script.length - 1)]!(context.messages);
    queueMicrotask(() => {
      const partial = { ...msg, content: [] as AssistantMessage["content"] };
      stream.push({ type: "start", partial });
      msg.content.forEach((c, i) => {
        if (c.type === "text") {
          stream.push({ type: "text_start", contentIndex: i, partial });
          for (const word of c.text.split(/(?<= )/)) stream.push({ type: "text_delta", contentIndex: i, delta: word, partial });
          stream.push({ type: "text_end", contentIndex: i, content: c.text, partial });
        } else if (c.type === "toolCall") {
          stream.push({ type: "toolcall_start", contentIndex: i, partial });
          stream.push({ type: "toolcall_end", contentIndex: i, toolCall: c, partial });
        }
      });
      stream.push({ type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg });
    });
    return stream;
  };
}

const wordCountSchema = obj({ text: str({ description: "text to count" }) });
const wordCount: AgentTool<typeof wordCountSchema, { words: number }> = {
  label: "Word count", name: "word_count", description: "Counts words", parameters: wordCountSchema,
  execute: async (_id: string, args: Static<typeof wordCountSchema>) => {
    const words = args.text.split(/\s+/).filter(Boolean).length;
    return { content: [{ type: "text", text: `${words} words` }], details: { words } };
  },
};
const statsSchema = obj({ values: arr(num()), op: str() });
const stats: AgentTool<typeof statsSchema, { result: number }> = {
  label: "Stats", name: "stats", description: "Sum or mean of numbers", parameters: statsSchema,
  execute: async (_id: string, args: Static<typeof statsSchema>) => {
    if (args.op !== "sum" && args.op !== "mean") throw new Error(`unknown op '${args.op}'`);
    const sum = args.values.reduce((a, b) => a + b, 0);
    const result = args.op === "sum" ? sum : sum / args.values.length;
    return { content: [{ type: "text", text: `${args.op} = ${result}` }], details: { result } };
  },
};

function show(e: AgentEvent): string {
  switch (e.type) {
    case "message_update":
      return e.assistantMessageEvent.type === "text_delta" ? `delta ${JSON.stringify(e.assistantMessageEvent.delta)}` : `update ${e.assistantMessageEvent.type}`;
    case "message_start":
    case "message_end":
      return `${e.type} ${e.message.role}`;
    case "tool_execution_start":
      return `tool_start ${e.toolName} ${JSON.stringify(e.args)}`;
    case "tool_execution_end":
      return `tool_end ${e.toolName} error=${e.isError} ${JSON.stringify((e.result as { content?: unknown }).content ?? e.result)}`;
    default:
      return e.type;
  }
}
function dump(messages: AgentMessage[]): void {
  for (const m of messages) {
    // timestamp and durationMs are clock readings: left out so the output is deterministic
    const { timestamp: _t, usage: _u, durationMs: _d, ...rest } = m as unknown as Record<string, unknown>;
    console.log("  " + JSON.stringify(rest));
  }
}
function makeAgent(script: Array<(messages: Message[]) => AssistantMessage>): Agent {
  const agent = new Agent({
    initialState: { systemPrompt: "You are a scripted test agent.", model, tools: [wordCount, stats] },
    streamFn: scriptedStream(script) as never,
  });
  agent.subscribe((e) => console.log(show(e)));
  return agent;
}

async function cmdLoop(): Promise<void> {
  const agent = makeAgent([
    () => assistant([{ type: "text", text: "Let me count and add. " }, { type: "toolCall", id: "c1", name: "word_count", arguments: { text: "the quick brown fox" } },
      { type: "toolCall", id: "c2", name: "stats", arguments: { values: [1, 2, 3.5], op: "sum" } }], "toolUse"),
    (ms) => assistant([{ type: "text", text: `Got ${ms.filter((m) => m.role === "toolResult").length} results; now a bad op.` },
      { type: "toolCall", id: "c3", name: "stats", arguments: { values: [4], op: "median" } }], "toolUse"),
    () => assistant([{ type: "text", text: "Done: 4 words, sum 6.5." }], "stop"),
  ]);
  await agent.prompt("Count the words and add the numbers.");
  console.log("final messages:");
  dump(agent.state.messages);
}

async function cmdBadArgs(): Promise<void> {
  const agent = makeAgent([
    () => assistant([{ type: "toolCall", id: "b1", name: "stats", arguments: { values: "not-an-array", op: 3 } }], "toolUse"),
    () => assistant([{ type: "toolCall", id: "b2", name: "nope", arguments: {} }], "toolUse"),
    () => assistant([{ type: "text", text: "Gave up." }], "stop"),
  ]);
  await agent.prompt("Break things.");
  dump(agent.state.messages);
}

async function cmdSteer(): Promise<void> {
  const agent = makeAgent([
    () => assistant([{ type: "toolCall", id: "s1", name: "word_count", arguments: { text: "one two" } }], "toolUse"),
    (ms) => assistant([{ type: "text", text: `Seen ${ms.length} messages.` }], "stop"),
  ]);
  const run = agent.prompt("First task.");
  agent.followUp({ role: "user", content: "And a follow-up.", timestamp: tick() });
  await run;
  dump(agent.state.messages);
}

const cmd = process.argv[2] ?? "loop";
if (cmd === "loop") await cmdLoop();
else if (cmd === "badargs") await cmdBadArgs();
else if (cmd === "steer") await cmdSteer();
else {
  console.error("usage: pi-main.ts loop|badargs|steer");
  process.exitCode = 2;
}
