// Polls the V8 heap of a workerd isolate through its inspector, for the Changes measurements (`docs/spec.md` → Known
// risks and spikes). workerd reports no memory to the code it runs (`process.memoryUsage()` is all zeros), so the heap is
// read from outside: run the workerd tests with `--inspect --no-file-parallelism`, then this script, which writes one
// `<epoch ms> <used bytes> <total bytes> <after gc: 0 or 1>` line per sample to stdout until the inspector goes away.
// With a `gc` every (say 10), every that many samples is taken after a full garbage collection, so it is the live heap:
// what the isolate's memory limit is held to. A collection costs time, so not every sample has one.
//
//   node scripts/heap-poll.mjs [target id] [interval ms] [gc every] > heap.log
const target = process.argv[2] ?? "core:user:vitest-plugin-runner-workerd-session";
const interval = Number(process.argv[3] ?? 20);
const collectEvery = Number(process.argv[4] ?? 0);
const url = `ws://127.0.0.1:9229/${target}`;

const connect = async () => {
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      const socket = new WebSocket(url);

      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });

      return socket;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`No inspector at ${url}`);
};

const socket = await connect();
let id = 0;
let samples = 0;

/** The ids of the samples taken after a collection. */
const collected = new Set();

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));

  if (message.result?.usedSize !== undefined) {
    const gc = collected.delete(message.id) ? 1 : 0;

    process.stdout.write(
      `${Date.now()} ${message.result.usedSize} ${message.result.totalSize} ${gc}\n`,
    );
  }
});

socket.addEventListener("close", () => process.exit(0));

setInterval(() => {
  const collect = collectEvery > 0 && ++samples % collectEvery === 0;

  if (collect) socket.send(JSON.stringify({ id: ++id, method: "HeapProfiler.collectGarbage" }));

  socket.send(JSON.stringify({ id: ++id, method: "Runtime.getHeapUsage" }));

  if (collect) collected.add(id);
}, interval);
