// The Workspace DO's one alarm, which a spare's preparation, a Build and the idle stop share (docs/spec.md → Container
// and Toolchains → Idle stop): each step runs whatever became of the ones before it.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off

/** A step of the alarm: its name in a log line, and what it does. */
export type AlarmStep = readonly [name: string, run: () => Promise<void>];

/**
 * Run `steps` in order, each whatever the ones before it came to: a step that throws is logged through `warn` and the
 * next one runs, so a failed spare's preparation or Build never keeps the idle stop from stopping the Container. Once
 * all have run, the first failure is thrown again, so the platform retries the alarm.
 */
export const runAlarmSteps = async (
  steps: ReadonlyArray<AlarmStep>,
  warn: (message: string) => void,
): Promise<void> => {
  let failed: { readonly cause: unknown } | undefined;

  for (const [name, run] of steps) {
    try {
      await run();
    } catch (cause) {
      warn(
        `workspace.alarm: the ${name} step failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      failed ??= { cause };
    }
  }

  if (failed !== undefined) throw failed.cause;
};
