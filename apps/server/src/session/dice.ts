// The first Effect-defined tool: trivial on purpose, so a Session proves the Effect ↔ pi-durable adapters end to end.
// The model cannot know a roll without calling it.
import { defineEffectTool } from "@cloudpid/effect-durable";
import { defineExtension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

const RollDiceParameters = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
    description: "How many dice to roll",
  }),
  sides: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 100 })).annotate({
    description: "How many sides each die has",
  }),
});

/** `roll_dice`: roll `count` dice with `sides` sides each, and report each die and the total. */
export const RollDice = defineEffectTool({
  name: "roll_dice",
  description: "Roll dice and report each die's value and their total. Use it for any dice roll.",
  parameters: RollDiceParameters,
  execute: Effect.fnUntraced(function* ({ count, sides }) {
    const rolls = yield* Effect.forEach(Arr.range(1, count), () => Random.nextIntBetween(1, sides));

    const total = Arr.reduce(rolls, 0, (sum, roll) => sum + roll);

    return {
      output: [
        {
          type: "text",
          text: `Rolled ${count}d${sides}: ${Arr.join(Arr.map(rolls, String), ", ")} (total ${total})`,
        },
      ],
      details: { rolls, total },
    };
  }),
});

/** The `dice` extension, with `roll_dice`. */
export const Dice = Effect.map(RollDice, (rollDice) =>
  defineExtension({ name: "dice", tools: [rollDice] }),
);
