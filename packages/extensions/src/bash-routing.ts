// Which backend a `bash` command runs on when the model names none (docs/spec.md → Backends): the Worker Shell, unless
// the command needs something the Worker Shell does not have, and then the Container. The Container is the costly
// backend, so the Worker Shell gets every command it can run: a program neither list below holds is asked of the Worker
// Shell itself (`resolveRoute`), and a command that writes no file is run again on the Container when the Worker Shell
// turns out not to run it (`workerShellCannot`). A command that is not understood goes to the Container. So does one
// that names a Container-only path, which only the Container has (`commandPaths`, then the Workspace DO's answer), and
// one that writes no file runs again there when the Worker Shell did not find such a path (`missingPaths`).
//
// The command is read the way bash reads it (quotes, pipelines and lists, subshells, substitutions, heredocs, `case`),
// so a program named inside a string or a heredoc body does not count and one inside `$(…)` does. Every simple command
// in it must be one the Worker Shell runs, or the whole call goes to the Container: one call has one backend.
//
// What the Worker Shell runs is `@cloudflare/computer`'s (0.6.0) just-bash core, `jq` (the Workspace DO adds that
// module), the shell's built-ins, and a `git` over computer's isomorphic-git client. The sets below are that, copied: a
// workerd test in apps/server runs every name in `WORKER_SHELL_COMMANDS` through the real Worker Shell, so an upgrade
// that drops one fails there.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off
import type { BashBackend } from "./coding-tools.ts";

/** Where a command runs and why: the reason names the command that decided it. */
export type BashRoute = {
  readonly backend: BashBackend;
  readonly reason: string;
  /**
   * On the Worker Shell: the programs in it that neither list holds, so whether the Worker Shell has them is asked at
   * run time (`resolveRoute`). Empty for the Container.
   */
  readonly unknown: readonly string[];
  /**
   * What in it may write a file (a redirect, `rm`, `sed -i`, a program not known to be read-only); undefined when
   * nothing does: then it can run again on the Container, after the Worker Shell could not run it, without writing twice.
   */
  readonly writes: string | undefined;
};

const names = (list: string): readonly string[] => list.split(" ");

/** The programs of the Worker Shell (computer's just-bash core and `jq`) that are not shell built-ins, except `git`. */
export const WORKER_SHELL_COMMANDS: readonly string[] = names(
  [
    "cat ls mkdir rmdir touch rm cp mv ln chmod readlink stat head tail wc grep fgrep egrep rg sed awk",
    "sort uniq comm cut paste tr rev nl fold expand unexpand strings split column join tee find basename",
    "dirname tree du env printenv xargs base64 diff date sleep timeout seq expr md5sum sha1sum sha256sum",
    "which tac hostname whoami od gzip gunzip zcat tar bash sh jq clear",
  ].join(" "),
);

/** The shell's own commands, which run in the Worker Shell's interpreter. `source`, `.`, and `eval` run unseen text. */
export const WORKER_SHELL_BUILTINS: readonly string[] = names(
  [
    ": true false cd export unset exit local set break continue return shift getopts pushd popd dirs",
    "read mapfile readarray declare typeset readonly let test [ [[ echo printf pwd alias unalias type hash",
    "ulimit umask trap wait kill jobs fg bg history help builtin command exec shopt time",
  ].join(" "),
);

/**
 * Programs the Worker Shell is known not to have: real binaries the model runs often. They go to the Container without
 * asking the Worker Shell first; any other program neither list holds is asked about (`resolveRoute`).
 */
export const CONTAINER_PROGRAMS: readonly string[] = names(
  [
    "node npm npx pnpm pnpx yarn bun bunx deno corepack tsx ts-node tsc vitest jest mocha playwright eslint prettier",
    "oxlint oxfmt biome turbo nx vite webpack esbuild rollup wrangler alchemy python python3 pip pip3 pipx uv uvx",
    "poetry pytest ruff mypy black cargo rustc rustup go gofmt make cmake ninja gcc g++ cc c++ clang ld java javac",
    "mvn gradle kotlin dotnet ruby gem bundle rake php composer perl lua swift zig gh curl wget ssh scp rsync",
    "docker docker-compose kubectl terraform mise apt apt-get dpkg sudo su nohup nice ps top htop lsof pkill pgrep",
    "killall sqlite3 psql mysql redis-cli yq unzip zip 7z openssl cloudpid-dockerd",
  ].join(" "),
);

const CONTAINER_PROGRAM_SET: ReadonlySet<string> = new Set(CONTAINER_PROGRAMS);

/** Worker Shell programs that write files whatever their options; the others write only in the forms `writesOf` names. */
const WRITERS: ReadonlySet<string> = new Set(
  names("rm rmdir mkdir touch cp mv ln chmod tee split"),
);

const SHELL_BUILTINS: ReadonlySet<string> = new Set(WORKER_SHELL_BUILTINS);

const WORKER_COMMAND_SET: ReadonlySet<string> = new Set(WORKER_SHELL_COMMANDS);

/** What the Worker Shell's git is trusted with for one subcommand: the options it takes, and what else may follow. */
type GitSubcommand = {
  /** Options without a value. */
  readonly flags?: readonly string[];
  /** Options with a value, as the next word or after `=`. */
  readonly values?: readonly string[];
  /** At least one of these options must be there: the forms of the subcommand whose output is git's. */
  readonly oneOf?: readonly string[];
  /** The only words that may follow the options, when it takes any (`rev-parse HEAD`). */
  readonly arguments?: readonly string[];
};

/**
 * The subcommands git runs on the Worker Shell: the few read-only ones whose output is checked against real git's in
 * `apps/server/src/workspace/bash.workerd.test.ts`, in the forms checked. computer's git client is isomorphic-git, not
 * git, so everything else goes to the Container's real git: what writes the index or refs (`add`, `rm`, `commit`,
 * `tag`, `branch <name>`, `init`, `remote add`: two git implementations must not write one `.git`), what it gets
 * wrong (`diff` of a revision prints nothing, `show` has no patch, `log` dates and paths, `status -s`, `cat-file`), what
 * needs the network or credentials (`clone`, `fetch`, `pull`, `push`), and what rewrites the working tree (`checkout`,
 * `switch`, `reset`, `merge`, `stash`, `clean`). Bare `git status` prints one `XY path` line per changed file (`?` for
 * untracked), not git's long format, and `git status` of a repo that tracks files under the `ignore` paths shows them
 * deleted, since those never reach the Workspace.
 */
const GIT_ON_WORKER: ReadonlyMap<string, GitSubcommand> = new Map(
  Object.entries({
    status: { arguments: [] },
    log: { flags: ["--oneline"], values: ["-n"], oneOf: ["--oneline"], arguments: [] },
    "rev-parse": { flags: ["--abbrev-ref", "--show-toplevel"], arguments: ["HEAD"] },
    "ls-files": { arguments: [] },
    branch: { flags: ["--show-current"], arguments: [] },
  } satisfies Record<string, GitSubcommand>),
);

/** A word of a command: its text with quotes and escapes removed, and whether the shell computes part of it. */
type Word = {
  readonly text: string;
  /** A variable, substitution, or arithmetic in it: what the word is cannot be read from the command. */
  readonly dynamic: boolean;
  /** Any of it was quoted or escaped, so it is not a keyword. */
  readonly quoted: boolean;
  /** It starts `NAME=`, as a variable assignment does. */
  readonly assignment: boolean;
  /** It starts with an unquoted `~`, which the shell expands to a home directory. */
  readonly tilde: boolean;
};

/**
 * A simple command as the paths it names see it: its words, the files its redirects name, the subshell it runs in, and
 * whether a `cd` in it lasts past it.
 */
type SimpleCommand = {
  /** The program; undefined for the list of a `for` loop, whose words are its `args`. */
  readonly head: Word | undefined;
  readonly args: readonly Word[];
  /** The targets of its file redirects (`< in`, `> out`): not heredocs, here-strings or file descriptors. */
  readonly redirects: readonly Word[];
  /** The subshells it is in, outermost first (`( … )`, `$( … )`, a heredoc body): one id each. */
  readonly scope: readonly number[];
  /** In a pipeline or the background: it runs in a subshell of its own, so its `cd` changes nothing after it. */
  readonly piped: boolean;
};

/** What the readers of one command share: the simple commands read so far, and the next subshell id. */
type Shared = { readonly records: SimpleCommand[]; ids: number };

/** Words that start a command position again, or close a compound command, and run nothing themselves. */
const KEYWORDS: ReadonlySet<string> = new Set(
  names("if then else elif fi while until do done { } !"),
);

/** Compound commands the heuristic leaves to the Container's bash. */
const UNREAD_KEYWORDS: ReadonlySet<string> = new Set(names("select coproc"));

/**
 * Where the scan is in a `case`: before its word, before `in`, at a pattern (up to `)`), or in a clause's commands (up to
 * `;;`, `;&`, `;;&`, or `esac`).
 */
type CaseState = "word" | "in" | "pattern" | "body";

/** Redirect targets that are not files. */
const NOT_FILES: ReadonlySet<string> = new Set(names("/dev/null /dev/stdout /dev/stderr"));

const isBlank = (char: string) => char === " " || char === "\t";

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

const FILE_DESCRIPTOR = /\d+(?=[<>])/y;

type Heredoc = { readonly delimiter: string; readonly quoted: boolean; readonly strip: boolean };

/** What reading a command found. */
type Parsed = {
  readonly commands: readonly (readonly Word[])[];
  readonly functions: ReadonlySet<string>;
  /** Set when the command uses shell syntax the heuristic does not read. */
  readonly unreadable: string | undefined;
  /** The first redirect in it that writes a file. */
  readonly writes: string | undefined;
  /** Its simple commands in the order they were read, with their redirects. */
  readonly records: readonly SimpleCommand[];
};

/** Reads a command into its simple commands. A recursive-descent scan, because `$( … )` and heredocs nest. */
class Reader {
  readonly commands: Word[][];
  readonly functions: Set<string>;
  unreadable: string | undefined;
  writes: string | undefined;
  readonly #source: string;
  #at: number;
  readonly #shared: Shared;
  #scope: readonly number[];
  /** The scopes outside the subshells the scan is in, innermost last. */
  #outer: (readonly number[])[] = [];
  /** The command before the one being read piped into it. */
  #pipedIn = false;
  #words: Word[] = [];
  #redirects: Word[] = [];
  #discard = false;
  #functionName = false;
  #inConditional = false;
  #heredocs: Heredoc[] = [];
  #subshells = 0;
  /** The `case` commands the scan is in, innermost last. */
  #cases: CaseState[] = [];
  #stop: ")" | "`" | undefined;

  constructor(
    source: string,
    at = 0,
    commands: Word[][] = [],
    functions = new Set<string>(),
    shared: Shared = { records: [], ids: 0 },
    scope: readonly number[] = [],
  ) {
    this.#source = source;
    this.#at = at;
    this.commands = commands;
    this.functions = functions;
    this.#shared = shared;
    this.#scope = scope;
  }

  /** A reader of a part of this command that runs in a subshell of its own (a substitution, a heredoc body). */
  #child(source: string, at: number): Reader {
    return new Reader(source, at, this.commands, this.functions, this.#shared, this.#subshell());
  }

  /** The scope of a new subshell in the current one. */
  #subshell(): readonly number[] {
    return [...this.#scope, this.#shared.ids++];
  }

  /** Read the whole source; undefined when it ends inside a quote, substitution or subshell. */
  readAll(): Parsed | undefined {
    if (!this.#list(undefined) || this.#subshells > 0 || this.#cases.length > 0) return undefined;

    return {
      commands: this.commands,
      functions: this.functions,
      unreadable: this.unreadable,
      writes: this.writes,
      records: this.#shared.records,
    };
  }

  /** Read text that the shell expands but does not run, a heredoc body: only its substitutions run commands. */
  readExpansions(): boolean {
    return this.#expansions(undefined) !== undefined;
  }

  #peek(offset = 0): string {
    return this.#source.charAt(this.#at + offset);
  }

  #startsWith(text: string): boolean {
    return this.#source.startsWith(text, this.#at);
  }

  /** End the simple command being read; `separator` is the operator that ended it (none for a newline or `)`). */
  #flush(separator = ""): void {
    const words = this.#words;
    const redirects = this.#redirects;
    const pipe = separator === "|" || separator === "|&";
    const piped = this.#pipedIn || pipe || separator === "&";
    const record = { redirects, scope: this.#scope, piped };

    if (this.#discard) {
      // A `for` loop: the words after its `in` are its list.
      const list = words.findIndex((word) => word.text === "in" && !word.quoted);

      if (list !== -1) {
        this.#shared.records.push({ ...record, head: undefined, args: words.slice(list + 1) });
      }
    } else if (words.length > 0 || redirects.length > 0) {
      this.#shared.records.push({ ...record, head: words[0], args: words.slice(1) });
    }

    if (!this.#discard && words.length > 0) this.commands.push(words);

    if (words.length > 0 || redirects.length > 0 || separator !== "") this.#pipedIn = pipe;
    this.#words = [];
    this.#redirects = [];
    this.#discard = false;
    this.#inConditional = false;
  }

  /**
   * Read commands until the end of the source or, within a substitution, the `stop` character. False if `stop` never
   * came.
   */
  #list(stop: ")" | "`" | undefined): boolean {
    this.#stop = stop;

    for (;;) {
      if (this.#at >= this.#source.length) {
        this.#flush();

        return stop === undefined;
      }

      const char = this.#peek();

      if (isBlank(char)) {
        this.#at++;
      } else if (char === "\\" && this.#peek(1) === "\n") {
        this.#at += 2;
      } else if (char === "\n") {
        this.#at++;
        this.#flush();
        this.#readHeredocs();
      } else if (char === "#" && this.#atWordStart()) {
        while (this.#at < this.#source.length && this.#peek() !== "\n") this.#at++;
      } else if (char === "`" && stop === "`") {
        this.#at++;
        this.#flush();

        return true;
      } else if (char === ")" && this.#cases.at(-1) === "pattern") {
        // The end of a `case` pattern: the clause's commands follow.
        this.#at++;
        this.#flush();
        this.#setCase("body");
      } else if (char === ")" && this.#subshells > 0) {
        this.#at++;
        this.#flush();
        this.#subshells--;
        this.#scope = this.#outer.pop() ?? [];
      } else if (char === ")" && stop === ")") {
        this.#at++;
        this.#flush();

        return true;
      } else if (char === ")" && !this.#inConditional) {
        this.unreadable = "an unmatched )";
        this.#at++;
      } else if (!this.#operator(char) && !this.#word()) {
        return false;
      }
    }
  }

  #setCase(state: CaseState): void {
    this.#cases[this.#cases.length - 1] = state;
  }

  /** Whether the scan is at the start of a word: after a blank, operator, or the start. */
  #atWordStart(): boolean {
    return this.#at === 0 || /[\s;&|()<>]/.test(this.#source.charAt(this.#at - 1));
  }

  /** Handle an operator at the scan (a separator, redirect, or subshell); false if the char starts a word. */
  #operator(char: string): boolean {
    if (this.#inConditional) return false;

    if (char === ";" || char === "&" || char === "|") {
      if (char === "&" && this.#peek(1) === ">") {
        const operator = this.#peek(2) === ">" ? "&>>" : "&>";

        this.#at += operator.length;

        const target = this.#redirectTarget();

        this.#output(operator, target);
        this.#file(operator, target);

        return true;
      }

      const start = this.#at;

      this.#at++;

      while (this.#peek() === char || this.#peek() === "&") this.#at++;
      this.#flush(this.#source.slice(start, this.#at));

      // `;;`, `;&`, `;;&` end a `case` clause: a pattern follows.
      if (char === ";" && this.#at - start > 1 && this.#cases.at(-1) === "body") {
        this.#setCase("pattern");
      }

      return true;
    }

    if (char === "(" && this.#cases.at(-1) === "pattern") {
      // A `case` pattern may open with `(`.
      this.#at++;

      return true;
    }

    if (char === "(") {
      this.#at++;

      // `name()` defines a function, and `()` alone is empty.
      if (this.#words.length <= 1 && this.#nextNonBlank() === ")") {
        const [name] = this.#words;

        if (name !== undefined) this.functions.add(name.text);
        this.#words = [];
        this.#at = this.#source.indexOf(")", this.#at) + 1;

        return true;
      }

      if (this.#words.length > 0) this.unreadable = "a ( inside a command";
      this.#flush();
      this.#subshells++;
      this.#outer.push(this.#scope);
      this.#scope = this.#subshell();

      return true;
    }

    if (char === "<" || char === ">") {
      this.#redirect();

      return true;
    }

    return false;
  }

  #nextNonBlank(): string {
    let at = this.#at;

    while (isBlank(this.#source.charAt(at))) at++;

    return this.#source.charAt(at);
  }

  /** A redirect operator at the scan, and the word it takes. */
  #redirect(): void {
    if (this.#peek(1) === "(") {
      // Process substitution, `<(…)` or `>(…)`: its commands are read as a substitution's are, but
      // computer's Worker Shell does not parse it (just-bash 3.6 does), so the command is left to the Container.
      const inner = this.#child(this.#source, this.#at + 2);
      const ended = inner.#list(")");

      this.#at = inner.#at;
      this.#inherit(inner);

      this.unreadable ??= ended
        ? "process substitution"
        : "a process substitution that does not end";

      return;
    }

    if (this.#startsWith("<<<")) {
      this.#at += 3;
      this.#redirectTarget();

      return;
    }

    if (this.#startsWith("<<")) {
      const strip = this.#peek(2) === "-";

      this.#at += strip ? 3 : 2;
      this.#heredocTarget(strip);

      return;
    }

    // Two-character operators: >>, >&, >|, <>, <&
    const operator = this.#source.slice(
      this.#at,
      this.#at + (/[>&|<]/.test(this.#peek(1)) ? 2 : 1),
    );

    this.#at += operator.length;

    const target = this.#redirectTarget();

    if (operator.startsWith(">") || operator === "<>") this.#output(operator, target);
    this.#file(operator, target);
  }

  /** Record the target of a redirect as a file the command names, unless it is a file descriptor (`>&2`, `<&-`). */
  #file(operator: string, target: Word | undefined): void {
    if (target === undefined) return;

    if (operator.endsWith("&") && !target.dynamic && /^(\d+|-)$/.test(target.text)) return;

    this.#redirects.push(target);
  }

  /** Read the word of a redirect: a file or file descriptor, not a command. */
  #redirectTarget(): Word | undefined {
    while (isBlank(this.#peek())) this.#at++;

    return this.#wordText(false);
  }

  /** Record an output redirect to `target` when it writes a file: not a file descriptor or `/dev/null`. */
  #output(operator: string, target: Word | undefined): void {
    if (target === undefined) return;

    if (!target.dynamic && NOT_FILES.has(target.text)) return;

    if (operator.endsWith("&") && !target.dynamic && /^(\d+|-)$/.test(target.text)) return;

    this.writes ??= `${operator} ${target.text || "a file"}`;
  }

  /** What a reader of a part of this command (a substitution, a heredoc body) found that the whole command has. */
  #inherit(inner: Reader): void {
    this.unreadable ??= inner.unreadable;
    this.writes ??= inner.writes;
  }

  #heredocTarget(strip: boolean): void {
    while (isBlank(this.#peek())) this.#at++;

    const start = this.#at;
    const word = this.#wordText(false);

    if (word === undefined) return;

    const raw = this.#source.slice(start, this.#at);

    this.#heredocs.push({ delimiter: word.text, quoted: /['"\\]/.test(raw), strip });
  }

  /** At the start of a line: the bodies of the heredocs started on the line before. */
  #readHeredocs(): void {
    const pending = this.#heredocs;

    this.#heredocs = [];

    for (const heredoc of pending) {
      let body = "";

      while (this.#at < this.#source.length) {
        const end = this.#source.indexOf("\n", this.#at);
        const line = this.#source.slice(this.#at, end === -1 ? this.#source.length : end);

        this.#at = end === -1 ? this.#source.length : end + 1;

        if ((heredoc.strip ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;

        body += `${line}\n`;
      }

      // An unquoted heredoc expands what is in it, `$(…)` included.
      if (!heredoc.quoted && /[$`]/.test(body)) {
        const inner = this.#child(body, 0);

        if (!inner.readExpansions()) this.unreadable = "a heredoc body that does not parse";
        this.#inherit(inner);
      }
    }
  }

  /** A word of the command at the scan. False when it ends inside a quote or substitution. */
  #word(): boolean {
    FILE_DESCRIPTOR.lastIndex = this.#at;

    const descriptor = this.#inConditional ? null : FILE_DESCRIPTOR.exec(this.#source);

    if (descriptor !== null) {
      // A file descriptor before a redirect (`2>&1`), not a word.
      this.#at += descriptor[0].length;

      return true;
    }

    const start = this.#at;
    const word = this.#wordText(this.#inConditional);

    if (word === undefined) return false;

    // A character no rule took: move on rather than loop.
    if (this.#at === start) this.#at++;
    else this.#push(word);

    return true;
  }

  #push(word: Word): void {
    const first = this.#words.length === 0;
    const keyword = !word.quoted && !word.dynamic;
    const inCase = this.#cases.at(-1);

    // A `case`'s word, its `in`, and its patterns are not commands; a substitution in them was recorded as it was read.
    if (inCase === "word") {
      this.#setCase("in");

      return;
    }

    if (inCase === "in") {
      this.#setCase("pattern");

      return;
    }

    if (inCase === "pattern") {
      if (keyword && word.text === "esac") this.#cases.pop();

      return;
    }

    if (first && keyword && inCase === "body" && word.text === "esac") {
      this.#cases.pop();

      return;
    }

    if (first && keyword && word.text === "case") {
      this.#cases.push("word");

      return;
    }

    if (this.#functionName) {
      this.#functionName = false;
      this.functions.add(word.text);

      return;
    }

    if (first && !word.quoted && !word.dynamic) {
      if (KEYWORDS.has(word.text)) return;

      if (word.text === "for") {
        this.#discard = true;

        return;
      }

      if (word.text === "function") {
        this.#functionName = true;

        return;
      }

      if (UNREAD_KEYWORDS.has(word.text)) this.unreadable = `${word.text} is left to bash`;

      if (word.text === "[[") this.#inConditional = true;
    }

    // Assignments before the command (`FOO=1 node x`) are not it.
    if (word.assignment && this.#words.length === 0) return;

    this.#words.push(word);

    if (word.text === "]]" && !word.quoted) this.#inConditional = false;
  }

  /**
   * Read one word at the scan, resolving quotes, escapes, and substitutions; the commands in it are recorded.
   * `conditional` makes shell operators ordinary characters (inside `[[ ]]`). Undefined if it does not end.
   */
  #wordText(conditional: boolean): Word | undefined {
    const start = this.#at;
    let text = "";
    let dynamic = false;
    let quoted = false;

    while (this.#at < this.#source.length) {
      const char = this.#peek();

      if (char === "\n" || isBlank(char) || (!conditional && /[;&|()<>]/.test(char))) break;

      if (char === "`" && this.#stop === "`") break;

      if (char === "\\") {
        quoted = true;
        text += this.#peek(1) === "\n" ? "" : this.#peek(1);
        this.#at += 2;
      } else if (char === "'") {
        const end = this.#source.indexOf("'", this.#at + 1);

        if (end === -1) return undefined;
        quoted = true;
        text += this.#source.slice(this.#at + 1, end);
        this.#at = end + 1;
      } else if (char === '"') {
        quoted = true;
        this.#at++;

        const inner = this.#expansions('"');

        if (inner === undefined) return undefined;
        text += inner.text;
        dynamic ||= inner.dynamic;
      } else if (char === "$" && this.#peek(1) === "'") {
        const end = this.#ansiQuoteEnd();

        if (end === -1) return undefined;
        quoted = true;
        text += this.#source.slice(this.#at + 2, end);
        this.#at = end + 1;
      } else if (char === "$" || char === "`") {
        dynamic = true;

        if (!this.#expansion()) return undefined;
      } else {
        text += char;
        this.#at++;
      }
    }

    return {
      text,
      dynamic,
      quoted,
      assignment: ASSIGNMENT.test(this.#source.slice(start, this.#at)),
      tilde: this.#source.charAt(start) === "~",
    };
  }

  #ansiQuoteEnd(): number {
    let at = this.#at + 2;

    while (at < this.#source.length) {
      if (this.#source.charAt(at) === "\\") at += 2;
      else if (this.#source.charAt(at) === "'") return at;
      else at++;
    }

    return -1;
  }

  /**
   * The expansion at the scan, which starts with `$` or a backtick: a substitution (its commands recorded), arithmetic, or
   * a parameter. False if it does not end.
   */
  #expansion(): boolean {
    const next = this.#peek(1);

    if (this.#peek() === "`" || (next === "(" && this.#peek(2) !== "(")) {
      const backtick = this.#peek() === "`";

      const inner = this.#child(this.#source, this.#at + (backtick ? 1 : 2));

      const ended = inner.#list(backtick ? "`" : ")");

      this.#at = inner.#at;
      this.#inherit(inner);

      return ended;
    }

    if (next === "(") return this.#skipBalanced("(", ")");

    if (next === "{") return this.#skipBalanced("{", "}");

    // A parameter: `$NAME`, `$1`, `$@`.
    this.#at++;

    if (/[A-Za-z_]/.test(this.#peek())) {
      while (/[A-Za-z0-9_]/.test(this.#peek())) this.#at++;
    } else if (/[0-9@*#?!$-]/.test(this.#peek())) {
      this.#at++;
    }

    return true;
  }

  /**
   * Skip `$((…))` or `${…}`; false if unclosed. They run nothing themselves, but a substitution inside one does, and
   * that is not read: the command is left to bash.
   */
  #skipBalanced(open: string, close: string): boolean {
    const start = this.#at;

    this.#at++;

    let depth = 0;

    while (this.#at < this.#source.length) {
      const char = this.#peek();

      if (char === "\\") this.#at++;
      else if (char === open) depth++;
      else if (char === close && --depth === 0) {
        this.#at++;

        if (/\$\(|`/.test(this.#source.slice(start + 2, this.#at))) {
          this.unreadable ??= "a command substitution inside ${…} or $((…))";
        }

        return true;
      }

      this.#at++;
    }

    return false;
  }

  /**
   * Read text the shell expands, up to `quote` (a double-quoted string) or the end (a heredoc body): its commands are
   * recorded, and what it expands to is reported. Undefined if the quote never closes or a substitution does not end.
   */
  #expansions(quote: '"' | undefined): { text: string; dynamic: boolean } | undefined {
    let text = "";
    let dynamic = false;

    while (this.#at < this.#source.length) {
      const char = this.#peek();

      if (char === quote) {
        this.#at++;

        return { text, dynamic };
      }

      if (char === "\\") {
        text += this.#peek(1);
        this.#at += 2;
      } else if (char === "$" || char === "`") {
        dynamic = true;

        if (!this.#expansion()) return undefined;
      } else {
        text += char;
        this.#at++;
      }
    }

    return quote === undefined ? { text, dynamic } : undefined;
  }
}

/** Whether the Worker Shell is known to run `name`: one of its programs or built-ins, or a function the command defines. */
const knownOnWorker = (name: string, functions: ReadonlySet<string>): boolean =>
  name === "git" || WORKER_COMMAND_SET.has(name) || SHELL_BUILTINS.has(name) || functions.has(name);

/** The reason a command goes to the Container: `name` is not a program the Worker Shell has. */
const notOnWorker = (name: string): string => `${name} is not a Worker Shell command`;

/** A name the Worker Shell can be asked about with `command -v`: a plain program name. */
const PROGRAM_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

/**
 * Why `name` is not for the Worker Shell; undefined when it is or may be. A name neither list holds is recorded in
 * `context.unknown`, for the Worker Shell to be asked about.
 */
const nameNeeds = (name: string, context: Context): string | undefined => {
  if (knownOnWorker(name, context.functions)) return undefined;

  if (CONTAINER_PROGRAM_SET.has(name) || !PROGRAM_NAME.test(name)) return notOnWorker(name);

  context.found.unknown.add(name);

  return undefined;
};

/** The words of `args` that are not options. */
const operands = (args: readonly Word[]): readonly Word[] =>
  args.filter((arg) => arg.quoted || !arg.text.startsWith("-") || arg.text === "-");

/** Whether one of `args` is an option in `options`, or a cluster of short options (`-ni`) holding `short`. */
const hasOption = (args: readonly Word[], options: readonly string[], short?: string): boolean =>
  args.some(
    (arg) =>
      options.some((option) => arg.text === option || arg.text.startsWith(`${option}=`)) ||
      (short !== undefined && /^-[A-Za-z]+$/.test(arg.text) && arg.text.includes(short)),
  );

/**
 * Whether one of `args` may hold the short option `short`, alone, in a cluster, or with its value attached (`-i.bak`,
 * `-uo out`, `-ofile`), or the long option `long`. For options that write: it errs towards finding one.
 */
const mayHaveOption = (args: readonly Word[], short: string, long: string): boolean =>
  args.some(
    (arg) =>
      arg.text === long ||
      arg.text.startsWith(`${long}=`) ||
      new RegExp(`^-[A-Za-z0-9]*${short}`).test(arg.text),
  );

/**
 * What running `name` with `args` may write, for a command the Worker Shell runs; undefined when it writes no file.
 * Conservative: a form not known to be read-only counts as writing.
 */
const writesOf = (name: string, args: readonly Word[], context: Context): string | undefined => {
  if (WRITERS.has(name)) return name;

  switch (name) {
    case "sed":
      // `-i` edits in place; a `w` command writes a file.
      return mayHaveOption(args, "i", "--in-place") ||
        operands(args).some((arg) => /(^|[\s;}/])[wW]\s+\S/.test(arg.text))
        ? "sed writing a file"
        : undefined;

    case "sort":
      return mayHaveOption(args, "o", "--output") ? "sort -o" : undefined;

    case "uniq":
      return operands(args).length > 1 ? "uniq writing a file" : undefined;

    case "awk":
      // `print > "f"`, `| "cmd"`, `system()`: anything that may redirect inside the program, or a program it reads
      // from a file (`-f`), which cannot be seen.
      return mayHaveOption(args, "f", "--file") ||
        operands(args).some((arg) => /system\s*\(|\||>(?!=)/.test(arg.text))
        ? "awk writing a file"
        : undefined;

    case "find":
      return hasOption(args, ["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"])
        ? "find writing files"
        : undefined;

    case "tar": {
      const mode = args[0]?.text ?? "";

      return hasOption(args, ["--list"], "t") || /^[a-z]*t[a-z]*$/.test(mode)
        ? undefined
        : "tar writing files";
    }

    case "gzip":
    case "gunzip":
      return hasOption(args, ["--stdout", "--list", "--test"], "c") ||
        hasOption(args, [], "l") ||
        hasOption(args, [], "t")
        ? undefined
        : `${name} writing files`;

    default:
      return knownOnWorker(name, context.functions) ? undefined : `${name} may write files`;
  }
};

/** Why `git` with `args` is not for the Worker Shell's git; undefined when it is. */
const gitNeeds = (args: readonly Word[]): string | undefined => {
  let at = 0;

  if (args[0]?.text === "-C" && !args[0].quoted) {
    if (args.length < 2) return "git -C needs a directory";
    at = 2;
  }

  const sub = args[at];

  if (sub === undefined) return "git without a subcommand";

  const label = `git ${sub.text}`;
  const spec = sub.dynamic ? undefined : GIT_ON_WORKER.get(sub.text);

  if (spec === undefined) return `${label} is not a git command the Worker Shell runs`;

  let afterDashes = false;
  let oneOf = spec.oneOf === undefined;

  for (let i = at + 1; i < args.length; i++) {
    const text = args[i]?.text ?? "";

    if (afterDashes || text === "-" || !text.startsWith("-")) {
      if (spec.arguments?.includes(text) !== true) {
        return `${label} ${text}: the Worker Shell's git does not take that argument`;
      }
    } else if (text === "--") {
      afterDashes = true;
    } else if (sub.text === "log" && /^-\d+$/.test(text)) {
      // `git log -5`
    } else if (spec.flags?.includes(text) === true) {
      oneOf ||= spec.oneOf?.includes(text) === true;
    } else if (spec.values?.includes(text) === true) {
      i++;
    } else {
      return `${label} ${text}: the Worker Shell's git does not take that option`;
    }
  }

  return oneOf
    ? undefined
    : `${label} without ${spec.oneOf?.join(" or ")}: its output is not git's`;
};

/** What reading a command found besides whether it needs the Container. */
type Found = {
  /** The programs in it that neither list holds. */
  readonly unknown: Set<string>;
  /** The first thing in it that may write a file. */
  writes: string | undefined;
};

type Context = {
  readonly functions: ReadonlySet<string>;
  readonly depth: number;
  readonly found: Found;
};

/** The first of `words` (a command with its arguments) that the Worker Shell cannot run; undefined if none. */
const commandNeeds = (words: readonly Word[], context: Context): string | undefined => {
  const [head, ...args] = words;

  if (head === undefined) return undefined;

  if (head.dynamic) return `${head.text || "a command"} is chosen by the shell at run time`;

  const name = head.text;

  if (name.includes("/")) return `${name} is a program by path`;

  if (context.functions.has(name)) return undefined;

  context.found.writes ??= writesOf(name, args, context);

  switch (name) {
    case "git":
      return gitNeeds(args);

    case "source":
    case ".":
    case "eval":
      return `${name} runs text the heuristic cannot read`;

    case "env":
      return commandNeeds(args.slice(envWords(args)), context);

    case "command":
    case "builtin":
      return args[0]?.text === "-v" || args[0]?.text === "-V"
        ? namesNeed(args.slice(1), context)
        : commandNeeds(args.slice(args[0]?.text === "-p" ? 1 : 0), context);

    case "exec":
      return commandNeeds(args, context);

    case "time":
      return commandNeeds(args.slice(args[0]?.text.startsWith("-") === true ? 1 : 0), context);

    case "timeout":
      return commandNeeds(args.slice(timeoutWords(args)), context);

    case "xargs":
      return commandNeeds(args.slice(xargsWords(args)), context);

    case "find":
      return findNeeds(args, context);

    case "which":
    case "type":
    case "hash":
      return namesNeed(args, context);

    case "bash":
    case "sh":
      return shellNeeds(name, args, context);

    default:
      return nameNeeds(name, context);
  }
};

/** The names of `args` (not options) as commands: what `which`, `type`, and `command -v` look up. */
const namesNeed = (args: readonly Word[], context: Context): string | undefined => {
  for (const arg of args) {
    if (arg.text.startsWith("-") && !arg.quoted) continue;

    if (arg.dynamic) return `${arg.text || "a name"} is chosen by the shell at run time`;

    const needs = nameNeeds(arg.text, context);

    if (needs !== undefined) return needs;
  }

  return undefined;
};

/** How many of `env`'s words are its own: options (`-u NAME` takes a value) and `NAME=value` assignments. */
const envWords = (args: readonly Word[]): number => {
  let at = 0;

  for (; at < args.length; at++) {
    const text = args[at]?.text ?? "";

    if (text === "-u" || text === "--unset" || text === "-C" || text === "-S") at++;
    else if (!(text.startsWith("-") && text !== "-") && !ASSIGNMENT.test(text)) break;
  }

  return at;
};

/** How many of `timeout`'s words are its own: options (`-s SIGNAL`, `-k DURATION` take a value) and the duration. */
const timeoutWords = (args: readonly Word[]): number => {
  let at = 0;

  for (; at < args.length; at++) {
    const text = args[at]?.text ?? "";

    if (["-s", "-k", "--signal", "--kill-after"].includes(text)) at++;
    else if (!(text.startsWith("-") && text !== "-")) break;
  }

  return at + 1;
};

/** How many of `xargs`'s words are its own: options, some with a value as the next word. */
const xargsWords = (args: readonly Word[]): number => {
  let at = 0;

  for (; at < args.length; at++) {
    const text = args[at]?.text ?? "";

    if (["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a"].includes(text)) at++;
    else if (!(text.startsWith("-") && text !== "-")) break;
  }

  return at;
};

/** `find`: the commands after `-exec`, `-execdir`, `-ok`, `-okdir`, up to `;` or `+`. */
const findNeeds = (args: readonly Word[], context: Context): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]?.text ?? "")) continue;

    let end = i + 1;

    while (end < args.length && args[end]?.text !== ";" && args[end]?.text !== "+") end++;

    const needs = commandNeeds(args.slice(i + 1, end), context);

    if (needs !== undefined) return needs;

    i = end;
  }

  return undefined;
};

/** `bash` and `sh` run a script: `-c` takes one on the command line, which is read; any other is a file or stdin. */
const shellNeeds = (name: string, args: readonly Word[], context: Context): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];

    if (word === undefined) break;

    if (word.text === "-o" || word.text === "+o") {
      i++;
    } else if (/^-[a-zA-Z]+$/.test(word.text) && !word.quoted) {
      if (!word.text.includes("c")) continue;

      const script = args[i + 1];

      if (script === undefined || script.dynamic) {
        return `${name} -c runs a script the heuristic cannot read`;
      }

      return scriptNeeds(script.text, { ...context, depth: context.depth + 1 });
    } else {
      return `${name} runs a script file`;
    }
  }

  return `${name} reads its script from stdin`;
};

/** The first command of `source` that the Worker Shell cannot run; undefined if none. */
const scriptNeeds = (source: string, context: Context): string | undefined => {
  if (context.depth > 8) return "commands nested too deep to read";

  const parsed = new Reader(source).readAll();

  if (parsed === undefined) return "the command does not parse";

  if (parsed.unreadable !== undefined) return parsed.unreadable;

  context.found.writes ??= parsed.writes;

  const inner = {
    ...context,
    functions: new Set([...context.functions, ...parsed.functions]),
  };

  for (const words of parsed.commands) {
    const needs = commandNeeds(words, inner);

    if (needs !== undefined) return needs;
  }

  return undefined;
};

const ON_WORKER = "every command in it runs on the Worker Shell";

/**
 * Where `command` runs, as far as the command alone tells: the Container when something in it needs the Container or it
 * is not understood, and the Worker Shell otherwise, if the Worker Shell has the programs in `unknown`.
 */
export const routeCommand = (command: string): BashRoute => {
  const found: Found = { unknown: new Set(), writes: undefined };
  const needs = scriptNeeds(command, { functions: new Set(), depth: 0, found });

  if (needs !== undefined) {
    return { backend: "container", reason: needs, unknown: [], writes: found.writes };
  }

  const unknown = [...found.unknown];

  return {
    backend: "worker",
    reason:
      unknown.length === 0 ? ON_WORKER : `on the Worker Shell if it has ${unknown.join(", ")}`,
    unknown,
    writes: found.writes,
  };
};

/**
 * `route` settled: when it runs on the Worker Shell only if the Worker Shell has its `unknown` programs, `has` asks which
 * of them it has, and the route goes to the Container when one is missing.
 */
export const resolveRoute = async (
  route: BashRoute,
  has: (programs: readonly string[]) => Promise<ReadonlySet<string>>,
): Promise<BashRoute> => {
  if (route.backend === "container" || route.unknown.length === 0) return route;

  const present = await has(route.unknown);
  const missing = route.unknown.find((name) => !present.has(name));

  return missing === undefined
    ? { ...route, reason: ON_WORKER, unknown: [] }
    : { ...route, backend: "container", reason: notOnWorker(missing), unknown: [] };
};

/** The last line of the probe's output: an answer without it was cut short, and says nothing about what is missing. */
const PROBE_END = "-- end of probe --";

/**
 * A Worker Shell script that prints each of `programs` it has, one per line, then {@link PROBE_END}: what
 * `resolveRoute` asks it. Each is a plain program name (`routeCommand` sends any other to the Container).
 */
export const probeScript = (programs: readonly string[]): string =>
  [
    ...programs.map((name) => `command -v '${name}' >/dev/null 2>&1 && echo '${name}'`),
    `echo '${PROBE_END}'`,
  ].join("\n");

/**
 * Which of `programs` the Worker Shell has, from the stdout of {@link probeScript}; undefined when the output did not
 * end the way the script ends, so the answer cannot be trusted.
 */
export const probeAnswer = (
  programs: readonly string[],
  stdout: string,
): ReadonlySet<string> | undefined => {
  const lines = stdout.split("\n");

  if (!lines.includes(PROBE_END)) return undefined;

  return new Set(programs.filter((name) => lines.includes(name)));
};

/** A command's output on the Worker Shell, by stream. */
export type WorkerOutput = { readonly stdout: string; readonly stderr: string };

/**
 * What the Worker Shell writes to stderr when it cannot do what a command asks, where the Container can: a program it
 * lacks, a syntax its parser does not take, an option its version of a program does not take, a feature it does not
 * support, a repository too big for its git (`apps/server/src/workspace/git.ts`).
 */
const CANNOT: readonly RegExp[] = [
  /^bash: [^\n:]+: command not found$/m,
  /^bash: syntax error: .*$/m,
  /^[\w.-]+: (?:unrecognized option|invalid option)\b.*$/m,
  /^[\w.-]+: .*\bnot supported\b.*$/m,
  /^git: this repository's packfiles are .* Rerun with backend: "container"\.$/m,
];

/**
 * The shell's own lines among {@link CANNOT}, which a command that sends its stderr to stdout (`2>&1`) puts there; the
 * rest are looked for in stderr only, since a file the command prints may hold anything.
 */
const CANNOT_ON_STDOUT: readonly RegExp[] = CANNOT.slice(0, 2);

/**
 * The line of a command's `output` on the Worker Shell saying that the Worker Shell could not run it as the Container
 * would; undefined when there is none.
 */
export const workerShellCannot = (output: WorkerOutput): string | undefined => {
  const match =
    CANNOT.map((pattern) => pattern.exec(output.stderr)).find((found) => found !== null) ??
    CANNOT_ON_STDOUT.map((pattern) => pattern.exec(output.stdout)).find((found) => found !== null);

  return match?.[0].trim();
};

// Container-only paths (GLOSSARY.md): every path outside `/workspace`, and inside it the launch's dependency, build
// and cache directories, are on the Container's disk only, so the Worker Shell does not see them. Which paths those are
// is the Workspace DO's to say (`containerOnly`); what is read here is which paths a command names, so a command naming
// one goes to the Container before it runs (`commandPaths`), and which path a Worker Shell run found missing, so one
// that writes no file runs again there (`missingPaths`).

/** The Container's `HOME`, which a leading `~` stands for. */
const HOME = "/root";

/** Words that name a file the Worker Shell has too, whatever the directory. */
const SHARED_FILES: ReadonlySet<string> = new Set([...NOT_FILES, "/dev/stdin"]);

const WILDCARD = /[*?[]/;

/** `path` without `.`, `..` and repeated slashes; `path` is absolute. */
const normalize = (path: string): string => {
  const segments: string[] = [];

  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }

  return `/${segments.join("/")}`;
};

/**
 * `text`, a path as the command names it, made absolute: a leading `~` (when `tilde`, it was unquoted) is the
 * Container's home, and a relative path is under `cwd`. Undefined when that cannot be told: a relative path where the
 * directory is unknown, or `~user`.
 */
const resolvePath = (text: string, cwd: string | undefined, tilde: boolean): string | undefined => {
  let path = text;

  if (tilde) {
    if (path !== "~" && !path.startsWith("~/")) return undefined;
    path = `${HOME}${path.slice(1)}`;
  }

  if (path.startsWith("/")) return normalize(path);

  return cwd === undefined ? undefined : normalize(`${cwd}/${path}`);
};

/**
 * What a word with a wildcard is checked as: the literal directory before its first wildcard, and, when a literal
 * segment follows a wildcard, the word up to the last such segment, wildcards kept as they are
 * (`pkg/[ab]/node_modules/x?`: `pkg` and `pkg/[ab]/node_modules`). The Workspace DO matches its Container-only paths
 * against that as against any path, so a directory name it takes at any depth is found behind a wildcard; one it takes
 * at a set place only (an Environment's `apps/web/dist`) is not.
 */
const globPaths = (text: string): readonly string[] => {
  const segments = text.split("/");
  const first = segments.findIndex((segment) => WILDCARD.test(segment));
  const literal = segments.slice(0, first).join("/") || (text.startsWith("/") ? "/" : ".");

  const last = segments.findLastIndex(
    (segment, at) => at > first && segment !== "" && !WILDCARD.test(segment),
  );

  return last === -1 ? [literal] : [literal, segments.slice(0, last + 1).join("/")];
};

/**
 * The absolute paths `word` may name, run in `cwd`: none for what is not a path (an option, a word the shell computes,
 * `-`, `/dev/null`); the value of `--opt=value`; the literal part of a glob.
 */
const wordPaths = (word: Word, cwd: string | undefined): readonly string[] => {
  if (word.dynamic || /[$`]/.test(word.text)) return [];

  let text = word.text;
  let tilde = word.tilde;

  if (text.startsWith("-")) {
    const value = /^--[^=]+=(.*)$/s.exec(text)?.[1];

    if (value === undefined) return [];
    text = value;
    tilde = text.startsWith("~");
  }

  if (text === "" || text === "-" || SHARED_FILES.has(text)) return [];

  return (WILDCARD.test(text) ? globPaths(text) : [text]).flatMap(
    (path) => resolvePath(path, cwd, tilde) ?? [],
  );
};

/** Where `cd` or `pushd` with `args`, run in `cwd`, goes; undefined when that cannot be told. */
const cdTarget = (name: string, args: readonly Word[], cwd: string | undefined) => {
  const target = args.find((arg) => arg.quoted || !arg.text.startsWith("-") || arg.text === "-");

  // Bare `cd` goes home; bare `pushd` swaps with the directory stack, which is not read.
  if (target === undefined) return name === "cd" ? HOME : undefined;

  if (target.dynamic || target.text === "-" || /[$`]/.test(target.text)) return undefined;

  return resolvePath(target.text, cwd, target.tilde);
};

/** Whether `outer` is `inner` or a scope `inner` is nested in. */
const encloses = (outer: readonly number[], inner: readonly number[]): boolean =>
  outer.length <= inner.length && outer.every((id, at) => inner[at] === id);

/** What a command names: the paths of its words, and the directories it runs them in. */
export type CommandPaths = {
  /** The absolute, normalized paths its path words may name, each once, in the order they come. */
  readonly paths: readonly string[];
  /** The directories its commands run in, as far as its `cd`s tell: the one it starts in first. */
  readonly directories: readonly string[];
};

/** The deepest `bash -c` inside `bash -c` that is read. */
const MAX_SCRIPT_DEPTH = 8;

const collectPaths = (
  source: string,
  start: string | undefined,
  depth: number,
  into: { readonly paths: Set<string>; readonly directories: Set<string> },
): void => {
  if (depth > MAX_SCRIPT_DEPTH) return;

  const parsed = new Reader(source).readAll();

  if (parsed === undefined) return;

  /** The `cd`s read so far, each with the scope it changes the directory of; `cwd` undefined once it is unknown. */
  const moves: { readonly scope: readonly number[]; readonly cwd: string | undefined }[] = [];

  for (const { head, args, redirects, scope, piped } of parsed.records) {
    const move = moves.findLast((earlier) => encloses(earlier.scope, scope));
    const cwd = move === undefined ? start : move.cwd;

    const add = (word: Word) => {
      for (const path of wordPaths(word, cwd)) into.paths.add(path);
    };

    redirects.forEach(add);

    const name = head === undefined || head.dynamic ? undefined : head.text;
    // The word after `bash -c`, read as the script it is.
    let skip = false;

    for (const [at, arg] of args.entries()) {
      const script = args[at + 1];

      if (skip) {
        skip = false;
      } else if (
        (name === "bash" || name === "sh") &&
        /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg.text) &&
        script !== undefined &&
        !script.dynamic
      ) {
        // `bash -c` runs its script where it is.
        collectPaths(script.text, cwd, depth + 1, into);
        skip = true;
      } else {
        add(arg);
      }
    }

    if (name === "cd" || name === "pushd" || name === "popd") {
      const next = name === "popd" ? undefined : cdTarget(name, args, cwd);

      if (next !== undefined) into.directories.add(next);

      // A `cd` in a pipeline or the background runs in a subshell, and changes nothing after it.
      if (!piped) moves.push({ scope, cwd: next });
    }
  }
};

/**
 * The paths `command`, run in `cwd`, names (docs/spec.md → Backends): the argument words of every simple command,
 * those inside substitutions and `bash -c` scripts included, the targets of file redirects, the values of `--opt=value`,
 * and the literal part of a glob, each made absolute against the directory it runs in, following the command's `cd`s
 * (a `cd` whose target is unknown stops that). A leading `~` is the Container's home (`/root`). Words that are no path
 * are skipped: options, `-`, words the shell computes (`$x`, `` `…` ``), heredoc bodies and here-strings; others are
 * kept though they may be no path (`grep node_modules a.txt`), since a word too many costs only a Container start.
 */
export const commandPaths = (command: string, cwd: string): CommandPaths => {
  const into = { paths: new Set<string>(), directories: new Set([normalize(cwd)]) };

  collectPaths(command, normalize(cwd), 0, into);

  return { paths: [...into.paths], directories: [...into.directories] };
};

/**
 * The lines a program prints for a path it did not find, and the path in each: `cat: X: No such file or directory`,
 * `ls: cannot access 'X': …`, `stat: cannot stat 'X': …`, `bash: cd: X: …`, `tar: X: Cannot open: …`.
 */
const MISSING =
  /^([\w.+-]+): (?:(?:cd|pushd|source|\.): )?(?:cannot (?:access|stat|open) )?(.+?)(?:: Cannot open)?: No such file or directory$/gm;

/**
 * The paths a Worker Shell run said it did not find, made absolute against each of `directories` (the command's, from
 * {@link commandPaths}: which one a message is about cannot be told). Only the shell's own messages (`bash: …`) are read
 * on stdout, where `2>&1` puts them, since a file the command prints may hold any line.
 */
export const missingPaths = (
  output: WorkerOutput,
  directories: readonly string[],
): readonly string[] => {
  const named = [
    ...output.stderr.matchAll(MISSING),
    ...[...output.stdout.matchAll(MISSING)].filter((match) => match[1] === "bash"),
  ].map((match) => (match[2] ?? "").replace(/^'(.*)'$/s, "$1"));

  const paths = named.flatMap((path) => {
    const tilde = path.startsWith("~");

    return path.startsWith("/") || tilde
      ? (resolvePath(path, undefined, tilde) ?? [])
      : directories.flatMap((directory) => resolvePath(path, directory, false) ?? []);
  });

  return [...new Set(paths)];
};
