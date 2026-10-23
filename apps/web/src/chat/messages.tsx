// How a thread's messages render: the owner's, the agent's with its tool cards, and notices. The Session's thread and a
// subagent's card share them, each inside its own assistant-ui runtime.

import {
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import * as Arr from "effect/Array";
import { ChevronRight } from "lucide-react";
import * as Predicate from "effect/Predicate";
import { MarkdownText, ReasoningPart, ToolCallCard } from "./parts.tsx";
import { SubagentCard } from "./subagent-card.tsx";
import { subagentOf } from "./subagent.ts";
import { answerOf, entriesOf, type ShownSkill, shownSkills } from "../session/thread-messages.ts";
import { entryIdOf } from "../session/tree.ts";
import { AnswerBar, BranchChevrons, OwnerMessageBar } from "./tree-bar.tsx";

/**
 * A Skill the Session expanded into the owner's message: closed, under the typed text, so what the model got beyond it
 * stays in sight (docs/adr/0001-expand-skills-and-prompt-templates-at-submit.md).
 */
const SkillDisclosure = ({ skill }: { skill: ShownSkill }) => (
  <details className="group mt-1.5">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
      Skill · {skill.name}
    </summary>
    <pre className="mt-1.5 max-h-72 overflow-auto rounded-md border bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap">
      {skill.text}
    </pre>
  </details>
);

/** An image in the owner's message (an Attachment's), at most 256 px high. */
const UserImage = () => {
  const image = useAuiState((state) =>
    state.part.type === "image" ? state.part.image : undefined,
  );

  return image === undefined ? null : (
    <img
      src={image}
      alt="Attached image"
      className="my-1 max-h-64 max-w-full rounded-md border object-contain"
    />
  );
};

const USER_PARTS = { Image: UserImage };

const UserMessage = () => {
  const custom = useAuiState((state) => state.message.metadata.custom);
  const id = useAuiState((state) => state.message.id);
  const skills = shownSkills(custom);

  return (
    <MessagePrimitive.Root className="group/message flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-lg bg-muted px-4 py-2 break-words whitespace-pre-wrap">
        <MessagePrimitive.Parts components={USER_PARTS} />
        {Arr.map(skills, (skill) => (
          <SkillDisclosure key={skill.name} skill={skill} />
        ))}
      </div>
      <OwnerMessageBar messageId={id} />
    </MessagePrimitive.Root>
  );
};

/** Why the model's answer ended in an error, if it did. */
const FailureNotice = () => {
  const error = useAuiState((state) => {
    const status = state.message.status;

    return status?.type === "incomplete" && status.reason === "error" ? status.error : undefined;
  });

  return error === undefined ? null : (
    <p role="alert" className="mt-2 text-sm text-destructive">
      {Predicate.isString(error) ? error : "The model failed."}
    </p>
  );
};

/**
 * A `subagent` call that started an agent is its card, opening into the agent's thread; any other call, and a spawn that
 * has no agent yet or was refused, is an ordinary tool card.
 */
const SubagentToolCard: ToolCallMessagePartComponent = (props) => {
  const subagent = subagentOf(props.artifact);

  return subagent === undefined ? (
    <ToolCallCard {...props} />
  ) : (
    <SubagentCard subagent={subagent} args={props.args} messages={<Messages />} />
  );
};

const AssistantMessage = () => {
  const answer = useAuiState((state) =>
    state.message.status?.type === "running" ? undefined : answerOf(state.message.metadata.custom),
  );

  // The metadata itself, not a list made from it: a selector's result is compared by identity.
  const custom = useAuiState((state) => state.message.metadata.custom);
  const entries = entriesOf(custom);

  return (
    <MessagePrimitive.Root className="group/message min-w-0 break-words">
      <BranchChevrons ids={entries} />
      <MessagePrimitive.Parts
        components={{
          Text: MarkdownText,
          Reasoning: ReasoningPart,
          tools: { by_name: { subagent: SubagentToolCard }, Fallback: ToolCallCard },
        }}
      />
      <FailureNotice />
      <AnswerBar answer={answer} />
    </MessagePrimitive.Root>
  );
};

/**
 * A notice between turns: a Handoff, a compaction summary, or a Rollover request. Its title shows; the text it carried
 * (the Handoff the next context starts from) opens on demand.
 */
const NoticeMessage = () => {
  const title = useAuiState((state) => {
    const custom = state.message.metadata.custom.title;

    return Predicate.isString(custom) ? custom : "Notice";
  });

  const text = useAuiState((state) =>
    Arr.join(
      Arr.map(state.message.content, (part) => (part.type === "text" ? part.text : "")),
      "",
    ),
  );

  const id = useAuiState((state) => entryIdOf(state.message.id));

  return (
    <MessagePrimitive.Root className="flex items-center gap-3 text-xs text-muted-foreground">
      <BranchChevrons ids={id === undefined ? [] : [id]} />
      <span className="h-px flex-1 bg-border" aria-hidden />
      {text === "" ? (
        <span>{title}</span>
      ) : (
        <details className="max-w-[85%] min-w-0">
          <summary className="cursor-pointer text-center select-none">{title}</summary>
          <p className="mt-2 rounded-md bg-muted px-3 py-2 text-left text-sm break-words whitespace-pre-wrap text-foreground">
            {text}
          </p>
        </details>
      )}
      <span className="h-px flex-1 bg-border" aria-hidden />
    </MessagePrimitive.Root>
  );
};

/** What renders a message of each role. */
const BY_ROLE = { user: UserMessage, assistant: AssistantMessage, system: NoticeMessage } as const;

/** The messages of the thread this renders in. */
export const Messages = () => (
  <ThreadPrimitive.Messages>
    {({ message }) => {
      const Message = BY_ROLE[message.role];

      return <Message />;
    }}
  </ThreadPrimitive.Messages>
);
