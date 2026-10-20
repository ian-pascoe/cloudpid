// The Workspace test Worker: the Workspace DO, counting the RPC stubs it hands out and how many of them its clients
// have disposed. Tests reach it through the `WORKSPACES` binding, as Session DOs will.
// @effect-diagnostics asyncFunction:off
import {
  type Workspace as ComputerWorkspace,
  WorkspaceRuntimeExecHandleStub,
  WorkspaceRuntimeStub,
  WorkspaceServiceProxy,
  WorkspaceStub,
} from "@cloudflare/computer";
import { RpcTarget } from "cloudflare:workers";
import { Workspace } from "./Workspace.ts";

/** Live counts of the stubs a `TestWorkspace` handed out. */
export type LiveStubs = {
  readonly opened: number;
  readonly workspaces: number;
  readonly execs: number;
};

type Counter = { opened: number; workspaces: number; execs: number };

/** An exec handle stub that counts itself until its client disposes it. */
class CountedExecHandle extends RpcTarget {
  readonly #inner: WorkspaceRuntimeExecHandleStub<"utf8" | undefined>;
  readonly #counter: Counter;
  #disposed = false;

  constructor(inner: WorkspaceRuntimeExecHandleStub<"utf8" | undefined>, counter: Counter) {
    super();
    this.#inner = inner;
    this.#counter = counter;
    counter.execs++;
  }

  get id() {
    return this.#inner.id;
  }

  get backend() {
    return this.#inner.backend;
  }

  result() {
    return this.#inner.result();
  }

  stream() {
    return this.#inner.stream();
  }

  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP") {
    return this.#inner.kill(signal);
  }

  [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#counter.execs--;
    this.#inner[Symbol.dispose]();
  }
}

class CountedRuntime extends WorkspaceRuntimeStub {
  readonly #counter: Counter;

  constructor(workspace: ComputerWorkspace, counter: Counter) {
    super(workspace);
    this.#counter = counter;
  }

  override async exec(source: string, options = {}) {
    // SAFETY: the counted handle answers every method and getter of the exec handle stub it wraps.
    return new CountedExecHandle(await super.exec(source, options), this.#counter) as never;
  }
}

class CountedWorkspaceStub extends WorkspaceStub {
  readonly #runtime: CountedRuntime;
  readonly #counter: Counter;
  #disposed = false;

  constructor(workspace: ComputerWorkspace, counter: Counter) {
    super(workspace);
    this.#runtime = new CountedRuntime(workspace, counter);
    this.#counter = counter;
    counter.opened++;
    counter.workspaces++;
  }

  override get runtime() {
    return this.#runtime;
  }

  override [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#counter.workspaces--;
    this.#runtime[Symbol.dispose]();
    super[Symbol.dispose]();
  }
}

export class TestWorkspace extends Workspace {
  readonly #counter: Counter = { opened: 0, workspaces: 0, execs: 0 };

  liveStubs(): LiveStubs {
    return { ...this.#counter };
  }

  protected override workspaceStub(workspace: ComputerWorkspace): WorkspaceStub {
    return new CountedWorkspaceStub(workspace, this.#counter);
  }
}

export { WorkspaceServiceProxy };

export default {
  fetch: () => new Response("cloudpid Workspace test worker"),
};
