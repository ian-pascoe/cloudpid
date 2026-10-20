// Readers over the Workspace DO. A binary reader holds the DO's hard link to the opened file; a directory reader holds
// the names listed when it opened and reads each entry's metadata as it pages.
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type BinaryReader,
  type DirReader,
  err,
  FileError,
  type FileInfo,
  type LineScan,
  ok,
  type Result,
  StreamDecoder,
  type TextLine,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { abortedResult, type Call } from "./client.ts";

/** Bytes a text line reader asks for at a time. */
const TEXT_CHUNK = 64 * 1024;

const closed = <T>(what: string, path: string): Result<T, FileError> =>
  err(new FileError("invalid", `${what} is closed`, path));

export class ComputerBinaryReader implements BinaryReader {
  readonly #call: Call;
  readonly #handle: string;
  readonly #path: string;
  #closed = false;

  constructor(call: Call, handle: string, path: string) {
    this.#call = call;
    this.#handle = handle;
    this.#path = path;
  }

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    if (this.#closed) return closed("Binary reader", this.#path);

    const info = await this.#call(context, "readerInfo", this.#handle);

    // The opened file's metadata, named by the path it was opened at.
    return info.ok ? ok({ ...info.value, name: this.#name(), path: this.#path }) : info;
  }

  async read(
    offset: number,
    length: number,
    context: Context,
  ): Promise<Result<Uint8Array, FileError>> {
    const aborted = abortedResult<Uint8Array>(context, this.#path);

    if (aborted !== undefined) return aborted;

    if (this.#closed) return closed("Binary reader", this.#path);

    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      return err(
        new FileError(
          "invalid",
          "Offset and length must be non-negative safe integers",
          this.#path,
        ),
      );
    }

    return this.#call(context, "read", this.#handle, offset, length);
  }

  async scanLines(
    options: { startLine: number; endLine?: number },
    context: Context,
  ): Promise<Result<LineScan, FileError>> {
    const aborted = abortedResult<LineScan>(context, this.#path);

    if (aborted !== undefined) return aborted;

    if (this.#closed) return closed("Binary reader", this.#path);

    const { startLine, endLine } = options;

    if (
      !Number.isSafeInteger(startLine) ||
      startLine < 0 ||
      (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine <= startLine))
    ) {
      return err(new FileError("invalid", "Invalid line range", this.#path));
    }

    return this.#call(context, "scanLines", this.#handle, startLine, endLine ?? null);
  }

  async close(_context: Context): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Closing releases the Workspace DO's link, so it runs even for an aborted caller.
    await this.#call(BACKGROUND_CONTEXT, "closeReader", this.#handle);
  }

  #name(): string {
    return this.#path.slice(this.#path.lastIndexOf("/") + 1);
  }
}

export class ComputerDirReader implements DirReader {
  readonly #call: Call;
  readonly #path: string;
  readonly #names: readonly string[];
  #next = 0;
  #closed = false;

  constructor(call: Call, path: string, names: readonly string[]) {
    this.#call = call;
    this.#path = path;
    this.#names = names;
  }

  async next(
    maxEntries: number,
    context: Context,
  ): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const aborted = abortedResult<{ entries: FileInfo[]; done: boolean }>(context, this.#path);

    if (aborted !== undefined) return aborted;

    if (this.#closed) return closed("Directory reader", this.#path);

    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      return err(
        new FileError("invalid", "maxEntries must be a positive safe integer", this.#path),
      );
    }

    const entries: FileInfo[] = [];

    while (entries.length < maxEntries && this.#next < this.#names.length) {
      const page = this.#names.slice(this.#next, this.#next + maxEntries - entries.length);
      const base = this.#path === "/" ? "" : this.#path;

      const infos = await this.#call(
        context,
        "infos",
        page.map((name) => `${base}/${name}`),
      );

      if (!infos.ok) return infos;
      this.#next += page.length;

      // An entry removed since the reader opened is no longer part of the listing.
      for (const info of infos.value) if (info !== null) entries.push(info);
    }

    return ok({ entries, done: this.#next >= this.#names.length });
  }

  async close(_context: Context): Promise<void> {
    this.#closed = true;
  }
}

/** Strict LF lines of a file, read in chunks through a binary reader. */
export class ComputerTextLineReader implements TextLineReader {
  readonly #reader: BinaryReader;
  readonly #path: string;
  readonly #decoder = new StreamDecoder();
  #offset = 0;
  #buffered = "";
  #ended = false;
  #closed = false;

  constructor(reader: BinaryReader, path: string) {
    this.#reader = reader;
    this.#path = path;
  }

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const aborted = abortedResult<TextLine | undefined>(context, this.#path);

    if (aborted !== undefined) return aborted;

    if (this.#closed) return closed("Text line reader", this.#path);

    while (true) {
      const newline = this.#buffered.indexOf("\n");

      if (newline !== -1) {
        const text = this.#buffered.slice(0, newline);

        this.#buffered = this.#buffered.slice(newline + 1);

        return ok({ text, terminated: true });
      }

      if (this.#ended) {
        if (this.#buffered.length === 0) return ok(undefined);

        const text = this.#buffered;

        this.#buffered = "";

        return ok({ text, terminated: false });
      }

      const chunk = await this.#reader.read(this.#offset, TEXT_CHUNK, context);

      if (!chunk.ok) return chunk;
      this.#offset += chunk.value.length;

      if (chunk.value.length === 0) {
        this.#buffered += this.#decoder.decode();
        this.#ended = true;
      } else {
        this.#buffered += this.#decoder.decode(chunk.value);
      }
    }
  }

  async close(context: Context): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffered = "";
    await this.#reader.close(context);
  }
}
