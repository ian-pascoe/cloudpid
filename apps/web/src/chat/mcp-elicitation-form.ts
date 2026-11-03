// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalDate:off missingPipeableSignature:off -- plain walks over a form's fields; a browser date's offset.
// What the MCP elicitation card keeps while the owner types (`docs/architecture/mcp-server-requests.md` → Elicitation
// requests, The form → Filling): each field's value as its widget holds it, and how those values become what the Session
// checks and the server gets. Typed values live in the card's state in the tab, and nowhere else.
import { type Entered } from "@cloudpid/mcp/types";
import type { ElicitationField, ElicitationForm, McpElicitationSource } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";

/** What a widget holds: text, a checkbox, or the checked options of a group. */
export type FieldValue = string | boolean | ReadonlyArray<string>;

/** The values by field name. */
export type FormValues = { readonly [name: string]: FieldValue };

/** A `datetime-local` value, `YYYY-MM-DDTHH:mm`, as RFC 3339 at the zone `offsetMinutes` east of UTC. */
export const toRfc3339 = (local: string, offsetMinutes: number): string => {
  if (local === "") return "";

  const withSeconds = /T\d{2}:\d{2}:\d{2}/.test(local) ? local : `${local}:00`;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);

  return `${withSeconds}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
};

/** A `datetime-local` value (the browser's own zone) as RFC 3339 with that zone's offset. */
export const localToRfc3339 = (local: string): string => {
  const moment = new Date(local);

  return Number.isNaN(moment.getTime()) ? local : toRfc3339(local, -moment.getTimezoneOffset());
};

const pad = (n: number) => String(n).padStart(2, "0");

/** An RFC 3339 default as the `datetime-local` value of the same moment in the browser's zone. */
export const rfc3339ToLocal = (value: string): string => {
  const moment = new Date(value);

  if (Number.isNaN(moment.getTime())) return "";

  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}T${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
};

/** The value a widget starts with: the field's default, or empty (an unchecked box, no options checked). */
const initialValue = (field: ElicitationField): FieldValue => {
  switch (field.kind) {
    case "boolean":
      return field.default ?? false;
    case "multi_choice":
      return field.default ?? [];
    case "number":
    case "integer":
      return field.default === undefined ? "" : String(field.default);
    case "date_time":
      return field.default === undefined ? "" : rfc3339ToLocal(field.default);
    default:
      return field.default ?? "";
  }
};

/** Every field's starting value: defaults prefilled. */
export const initialValues = (form: ElicitationForm): FormValues =>
  Record.fromEntries(Arr.map(form.fields, (field) => [field.name, initialValue(field)] as const));

/** What the Session checks and the server gets for one field, from what its widget holds. */
const enteredValue = (field: ElicitationField, value: FieldValue | undefined) => {
  if (value === undefined) return undefined;

  switch (field.kind) {
    case "number":
    case "integer": {
      if (!Predicate.isString(value) || value.trim() === "") return "";

      const parsed = Number(value);

      return Number.isFinite(parsed) ? parsed : value;
    }

    case "date_time":
      return Predicate.isString(value) ? localToRfc3339(value) : undefined;
    case "boolean":
      return Predicate.isBoolean(value) ? value : undefined;
    case "multi_choice":
      return Predicate.isString(value) || Predicate.isBoolean(value) ? [] : [...value];
    default:
      return Predicate.isString(value) ? value : undefined;
  }
};

/** The values as `validateElicitation` takes them. */
export const enteredOf = (form: ElicitationForm, values: FormValues): Entered =>
  Record.fromEntries(
    Arr.flatMap(form.fields, (field) => {
      const entered = enteredValue(field, values[field.name]);

      return entered === undefined ? [] : [[field.name, entered] as const];
    }),
  );

/** How long until `deadline`, as `m:ss`; `0:00` once it has passed. */
export const countdown = (deadline: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));

  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
};

/** `record[name]` when `name` is the record's own key (a field may be named `constructor` or `__proto__`). */
export const ownValue = <A>(record: { readonly [name: string]: A }, name: string): A | undefined =>
  Object.hasOwn(record, name) ? record[name] : undefined;

/**
 * How a refusal of an answer reads on the card: the Session says `<field>: <why>` for a value that does not fit, or that
 * matches a Secret, and a bare message for anything else (the request ended). `field` is the field it names, if one.
 */
export const refusalOf = (
  form: ElicitationForm,
  message: string,
): { readonly field?: string; readonly text: string } => {
  // The longest name first: `a: b` is a field named `a: b` before it is `a` with a reason.
  const named = Arr.sort(
    Arr.map(form.fields, (field) => field.name),
    Order.flip(Order.mapInput(Order.Number, (name: string) => name.length)),
  );

  const field = Arr.findFirst(named, (name) => message.startsWith(`${name}: `));

  return Option.isSome(field)
    ? { field: field.value, text: message.slice(field.value.length + 2) }
    : { text: message };
};

/** Where the owner's time zone is, as the browser names it (`Europe/Berlin`): a date and time is read in it. */
export const timeZoneName = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Where a server's definition is, for the card's badge; nothing for a kind this build does not know. */
export const sourceLabel = (source: McpElicitationSource | undefined): string | undefined => {
  if (source === undefined) return undefined;

  switch (source.kind) {
    case "global":
      return "Global";
    case "environment":
      return "This environment";
    case "repo":
      return source.slug === undefined ? undefined : `from ${source.slug}`;
    default:
      return undefined;
  }
};
