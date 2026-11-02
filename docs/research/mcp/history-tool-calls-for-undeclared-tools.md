# History tool calls for tools the request does not declare

Read 2026-11-02. Question: when a request's message history holds tool calls and tool results for tools that are **not** in that request's `tools` list (while it declares other tools), does each provider accept, reject, or degrade? And what does pi-ai (the provider layer cloudpid uses) do about it?

**Why it matters**: the cloudpid importer turns a local pi Session transcript into a cloud Session. The history names laptop-only tools (MCP servers, extensions) that the cloud agent does not offer. Can the importer keep those calls verbatim, or must it flatten them to text?

## Short answer

| Provider API             | Other tools declared, history names an undeclared tool                                                                                                                   | No tools declared at all, history has tool calls                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic Messages       | **Accepts** (not documented; no name check found; pi relies on it)                                                                                                       | **Accepts** since Mar 2025 (was 400: "Requests which include `tool_use` or `tool_result` blocks must define tools"). Proxies in front (LiteLLM) may still reject                                                      |
| OpenAI Responses         | **Accepts** (not documented; first-party Agents SDK sends such history by default; pi relies on it)                                                                      | **Accepts** (omit `tools`; do not send `tools: []`)                                                                                                                                                                   |
| OpenAI Chat Completions  | **Accepts** (not documented; same evidence)                                                                                                                              | **Accepts** with `tools` omitted. `tools: []` is rejected by some backends (DashScope 400 `[] is too short - 'tools'`); pi-ai nevertheless sends `tools: []` here (see below)                                         |
| Gemini `generateContent` | **Accepts** (not documented; no name check found; pi sends it verbatim). Gemini 3 has a separate thought-signature rule for `functionCall` parts of the **current turn** | **Accepts** (omit `tools`)                                                                                                                                                                                            |
| Bedrock Converse         | **Accepts, probably** (not documented, not tested)                                                                                                                       | **Rejects**: `ValidationException: The toolConfig field must be defined when using toolUse and toolResult content blocks.` `toolConfig.tools` needs at least 1 item, so the fix is a declared stub tool or flattening |

Nothing here was verified against a live provider (no API keys in the research environment). "Accepts" for the undeclared-name case is **inferred** from (a) no documented validation, (b) no reports of a rejection, (c) first-party SDK defaults, and (d) pi relying on it. Run one live probe per provider before shipping (a request with `tools: [cloud_tool]` and a history `tool_use` named `laptop_only_tool`).

**Degradation, not rejection**, is the real cost. The model sees a call to a tool it cannot call; it may imitate it (emit a call to the undeclared name). pi-ai handles this with a text notice ("The following tools are no longer available. Do not call them") on OpenAI Responses and native `tool_removal` blocks on Anthropic's beta; the other transports send nothing.

**Recommendation**: keep calls and results verbatim for every provider **when the request declares at least one tool**. Flatten to text when the request declares **no** tools on Bedrock (and on any Anthropic/OpenAI-compatible proxy such as LiteLLM; that is a cheap safety net everywhere). Add a short "these tools are not available here" notice to the context for the undeclared names, appended at the end (cloudpid's prompt-cache rule). Details under _Recommendation_.

## Provider evidence

### Anthropic Messages API

- **No tools declared**: was rejected, now accepted. The error in May 2024 was `Requests which include tool_use or tool_result blocks must define tools.` ([anthropic-sdk-python#494](https://github.com/anthropics/anthropic-sdk-python/issues/494), an Anthropic maintainer's reply: the definitions "aid the model in understanding what those tool_uses and tool_requests actually mean"). On 2025-03-03 an Anthropic maintainer wrote: "we recently added support for this in the API. You may both skip providing tools when sending tool results and/or explicitly specify tool_choice={"type":"none"}" ([anthropic-sdk-python#849](https://github.com/anthropics/anthropic-sdk-python/issues/849)). `tool_choice: none` is "the default value when no `tools` are provided" ([Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)). opencode#8246 records the current split: "Anthropic's native API now handles this gracefully, but many users route through LiteLLM proxies which enforce stricter validation" ([anomalyco/opencode#8246](https://github.com/anomalyco/opencode/issues/8246)).
- **Other tools declared, history names an undeclared tool**: no doc page states a name check or a rejection. The Messages API docs describe only the opposite direction (tool changes by reference): `tool_removal`/`tool_addition` blocks "offer a tool to the model, or withdraw it, from a specific point in the conversation onward", and "earlier turns stay byte-identical" ([Mid-conversation system messages and tool changes](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)). A withdrawn tool's earlier `tool_use` blocks stay in `messages`, so the API must accept history for a tool that is withdrawn (**inferred**; the page does not say it in so many words). `tool_reference` to a name **not declared in `tools`** is a 400 (`tool_reference_unresolved`), but that is a different block, not `tool_use`.
- **Exception (documented)**: server tools. A paused turn's `server_tool_use` block needs its tool defined on resume: "the resume request no longer defines that server tool (the message then ends with `but no <name> tool was provided`)" ([Troubleshooting tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/troubleshooting-tool-use)). Client `tool_use` blocks (what MCP/laptop tools are) are not server tools.

### OpenAI Responses API

- Reference: a `function_call` input/output item has `call_id`, `name`, `arguments`; nothing ties `name` to the request's `tools` ([Responses object](https://developers.openai.com/api/docs/api-reference/responses/object), [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling.md)). The guide's loop re-sends the model's prior `function_call` items plus `function_call_output` items. Not documented either way for undeclared names.
- First-party behaviour that implies acceptance (**inferred**): the OpenAI Agents SDK hands the receiving agent "the entire previous conversation history" on a handoff, by default, and each agent has its own `tools`. `handoff_filters.remove_all_tools` ("Filters out all tool items: file search, web search and function calls+output") is an opt-in cleanup, not a requirement ([Handoffs](https://openai.github.io/openai-agents-python/handoffs/), [handoff_filters.py](https://raw.githubusercontent.com/openai/openai-agents-python/main/src/agents/extensions/handoff_filters.py)).
- The documented failure is the orphan: a `function_call` without its `function_call_output` (and the reverse). That is about pairing, not declaration.

### OpenAI Chat Completions

- Reference: assistant `tool_calls[].function.name` is "the name of the function to call", and `role: "tool"` messages answer by `tool_call_id`; `tool_choice` is "`none` ... the default when no tools are present" ([Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)). No rule ties history names to `tools`.
- Empty array: DashScope (an OpenAI-compatible backend) returns HTTP 400 `"[] is too short - 'tools'"` for `tools: []` (pi-ai CHANGELOG line 1325, [pi #3650](https://github.com/badlogic/pi-mono/pull/3650)). Omit the field instead.
- Anthropic behind an OpenAI-compatible proxy (LiteLLM) rejects tool history without `tools` (`UnsupportedParamsError: Anthropic doesn't support tool calling without tools= param specified`, opencode#8246 above). That is why pi-ai sends `tools: []` in that one case; it trades the DashScope problem for the LiteLLM one.

### Gemini `generateContent`

- Docs say nothing about matching history `functionCall` names to `function_declarations`; `tool_config` mode `NONE` "is equivalent to sending a request without any function declarations" ([Function calling](https://ai.google.dev/gemini-api/docs/function-calling)). The documented 400s are about structure: parallel calls must be followed by all responses, in order, in one `Content` ([Vertex function calling](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling)). "The model called a tool that was not declared in the request" is the Interactions API's `unexpected_tool_call`, a **response**-side error ([API errors](https://ai.google.dev/gemini-api/docs/api-errors)).
- **Gemini 3 thought signatures**: "a required thought signature" missing means a 400, validated "on all steps in the current turn" ("A turn begins with the most recent user message that is not a `functionResponse`"). Calls the API did not generate "(for example, when transferring history from a model that does not include thought signatures)" can use `thought_signature: "skip_thought_signature_validator"`, "a last resort as it will negatively impact model" quality ([Thought signatures](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thought-signatures)). For an import whose last user turn is a plain user message, earlier unsigned calls are outside the validated turn (**inferred** from the "current turn" wording). pi-ai sends unsigned foreign calls without the dummy value (`ai/test/google-shared-gemini3-unsigned-tool-call.test.ts:76-100`). An import that ends mid-turn (a trailing tool call/result) needs a decision.
- This is separate from declaration, but it is the one Gemini rule that can reject an imported tool call.

### AWS Bedrock Converse

- API reference: `toolConfig` is "Required: No"; inside it `tools` is "Array Members: Minimum number of 1 item. Required: Yes" ([Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html), [ToolConfiguration](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolConfiguration.html)). The pairing rule is **not** in the reference.
- Observed (undocumented in the API reference): with `toolUse`/`toolResult` blocks in `messages` and no `toolConfig`, Converse and ConverseStream return `ValidationException: The toolConfig field must be defined when using toolUse and toolResult content blocks.` ([dify#16421](https://github.com/langgenius/dify/issues/16421), [langchain-aws#591](https://github.com/langchain-ai/langchain-aws/issues/591)). langchain-aws's own proposed fixes: "Add a dummy toolConfig when tool blocks exist but no tools are supplied" or "Strip tool blocks ... (convert toolResult to plain text)".
- With `toolConfig` present and a history `toolUse` whose name is not in it: not documented, no report found. Treat as accepted (**inferred**, untested). Bedrock's mid-conversation tool changes for Claude are by reference ("Amazon Bedrock" is listed for `mid-conversation-tool-changes-2026-07-01`, same Anthropic page as above), which implies withdrawn tools' history stays valid there too.

## What pi-ai does

Source: `.repos/pi` at `ddbe02cd2` (v1.4.0 + 300 commits). The installed `@earendil-works/pi-ai@1.4.0` (cloudpid's dependency, `packages/protocol/package.json:19`) has the same transcript design (`dist/utils/transcript.js`, `hasToolHistory` at `dist/api/openai-completions.js:41`).

**It passes history tool calls through unchanged.** There is no flattening of calls to tools that are absent from the tool list.

- `transformMessages` (`packages/ai/src/api/transform-messages.ts:91-256`) changes thinking blocks, tool call IDs (when the source model differs), and drops errored/aborted assistant turns. For `toolCall` blocks it only normalizes the ID and strips a foreign `thoughtSignature` (`:148-166`). It never looks at the tool list. Its second pass adds a synthetic `No result provided` error result for an orphaned call (`:179-253`): a pairing fix, not a declaration fix.
- Tools reach a provider as the **current tool set**, replayed from system messages: `getCurrentTools` applies each `toolsAdded`/`toolsRemoved` in order (`packages/ai/src/utils/transcript.ts:58-66`). History is a separate list that nothing reconciles with it.
  - Anthropic: `tools` = current tools (`anthropic-messages.ts:1257-1268`), or the initial tools plus a placeholder with native `tool_addition`/`tool_removal` blocks (`:1195-1262`, `:1380-1394`). History becomes `tool_use` blocks as is (`:1473-1479`).
  - OpenAI Responses: history becomes `function_call` / `function_call_output` items (`openai-responses-shared.ts:355-412`). A removal is announced as text: "The following tools are no longer available. Do not call them:" (`:188-190`, `:286-293`). README `packages/ai/README.md:1648`: "calls to removed tools fail at execution".
  - OpenAI Chat Completions: `tool_calls` as is (`openai-completions.ts:1300-1350`); `tools` = current tools (`:840-847`).
  - Gemini: `functionCall` parts as is (`google-shared.ts:266-276`); `tools` from `getCurrentTools`, omitted when empty (`google-generative-ai.ts:371-392`).
  - Bedrock: `toolUse` blocks as is (`bedrock-converse-stream.ts:1072-1076`); `toolConfig` = `undefined` when no current tools (`:1186-1193`, `:279-296`).
- **No tools declared, tool history present**: pi-ai omits `tools` everywhere except OpenAI Chat Completions, where it sends `tools: []` because "Anthropic (via LiteLLM/proxy) requires tools param when conversation has tool_calls/tool_results" (`openai-completions.ts:99-110`, `:845-847`). It does **nothing** for Bedrock: a no-tools request with tool history goes out with no `toolConfig`, i.e. the documented-by-issue `ValidationException` above (**inferred** from code; not run).
- Empirical check (installed `@earendil-works/pi-ai@1.4.0`, payloads captured with `onPayload`, nothing sent): a history call to `laptop_only_tool` plus `tools: [cloud_tool]` produced, for Anthropic, OpenAI Responses, OpenAI Chat Completions, Gemini and Bedrock, a payload with the `laptop_only_tool` call and result verbatim and only `cloud_tool` declared. With no tools: Anthropic, Responses, Gemini and Bedrock had no tools field; Chat Completions had `tools: []`. Script in _Appendix_.

## Does pi's coding agent already rely on this?

Yes. Every path that removes tools leaves their earlier calls in the transcript:

- `declareToolChanges` (`packages/agent/src/agent-loop.ts:342-372`, called at `:119` and `:220`): before each request, the difference between the transcript's tools and `context.tools` becomes `toolsRemoved`/`toolsAdded` on a system message. Messages are never rewritten. "`context.tools` is what the runtime can execute; the transcript's system messages declare what the model may call" (`:333-337`).
- Session resume (`packages/coding-agent/src/core/agent-session.ts:1851-1870`): `_restoreToolsFromTranscript` replays the branch's tool declarations; "Removed tools stay inactive" (`:1860`). Extension and MCP tools that are gone on resume are simply absent from `tools`, with their calls in history. `agent-session-mcp.test.ts` (~`:1150-1262`) covers resume with MCP tools that connect later or not at all.
- `prepareLoadout` hidden declarations (`agent-session.ts:1808-1826`): strips tools from `toolsAdded`/`toolsRemoved` on every request, never from calls in messages.
- Tests pin the wire shape: `packages/ai/test/transcript-tool-changes.test.ts:402,442,490` (removal notice, tools still in prefix; history untouched).
- The one place pi flattens is **summarization with no tools**: `serializeConversation` (`packages/coding-agent/src/core/compaction/utils.ts:120-`) renders history into one text block for compaction, branch summaries and bug reports (`compaction.ts:722,1077`, `branch-summarization.ts:339`, `bug-report.ts:339`). That sidesteps the no-tools rules (Bedrock, proxies) by design.

## Recommendation

1. **Keep calls and results verbatim** when the cloud request declares at least one tool, on all five APIs. pi-ai, the library cloudpid sends through, does this for every removed/hidden tool today, so the importer flattening them would diverge from how a cloud Session already behaves after its own tool changes. Keep the `toolCall` id and `toolResult.toolName` unchanged so orphan/pairing rules hold.
2. **Say which tools are gone.** Verbatim history alone invites the model to call a laptop-only tool. Declare the loadout the cloud agent really has (pi's `toolsRemoved` for the laptop-only names, or a system message at the end of the context: cloudpid's prompt-cache rule). pi-ai renders that as the OpenAI Responses "no longer available" notice and Anthropic `tool_removal` on the beta; elsewhere only the text in your message helps.
3. **Flatten to text** (as `serializeConversation` does) when:
   - the request will declare **no tools** and the target is **Bedrock** (hard `ValidationException`), or any LiteLLM/Anthropic-compatible proxy; or
   - a Gemini 3 request's current turn would contain unsigned foreign `functionCall` parts (otherwise `skip_thought_signature_validator`, at a quality cost).
     Do not send `tools: []` to OpenAI-compatible Chat Completions backends.
4. **Before shipping**, probe each provider once (live) for the declared-other-tools case, which is the part this note could only infer. A one-turn request per provider is enough; record the result in this file.

## Appendix: payload probe

Run from the cloudpid root (`bun probe.mjs`), imports the installed `@earendil-works/pi-ai@1.4.0` compat entry, captures the payload with `onPayload` (throws before any network call):

```js
const root =
  ".../node_modules/.bun/@earendil-works+pi-ai@1.4.0+71adedcc4ba27b46/node_modules/@earendil-works/pi-ai/dist/compat.js";
const { getModel, streamSimple } = await import(root);
// history: user, assistant toolCall "laptop_only_tool", toolResult, user
// context.tools: [cloud_tool] or omitted
// onPayload: (p) => { got = p; throw new Error("captured"); }
// models: anthropic/claude-sonnet-4-5, openai/gpt-5.1 (responses + completions),
//         google/gemini-2.5-flash, amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

Result: `laptop_only_tool` present in every payload; `tools`/`toolConfig` held only `cloud_tool` (or was absent, or `[]` for Chat Completions with no tools).
