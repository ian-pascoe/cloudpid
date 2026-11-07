// The name of a Trigger's object (`docs/architecture/triggers.md` → The Trigger object and the Registry):
// `trigger:<trigger id>`.
const PREFIX = "trigger:";

/** The name of the `Trigger` object of Trigger `id`. */
export const triggerObjectName = (id: string): string => `${PREFIX}${id}`;

/** The Trigger whose object is named `name`, or undefined for a name no Trigger's object has. */
export const triggerOfObject = (name: string | undefined): string | undefined =>
  name?.startsWith(PREFIX) === true && name.length > PREFIX.length
    ? name.slice(PREFIX.length)
    : undefined;
