import { EventEmitter } from "events";
import { workerBuilder } from "../src/wfs-service";

/** A worker thread that exits only when the test lets it. */
class MockWorker extends EventEmitter {
  exit: () => void = () => undefined;
  readonly exited = new Promise<number>((resolve) => {
    this.exit = () => resolve(1);
  });
  terminate(): Promise<number> {
    return this.exited;
  }
}

const mockWorkers: MockWorker[] = [];

jest.mock("worker_threads", () => ({
  Worker: jest.fn(() => {
    const w = new MockWorker();
    mockWorkers.push(w);
    return w;
  })
}));

const job = { dirs: [], leafZoom: 18, indexDir: "/tmp/index" };
const settle = () => new Promise((r) => setImmediate(r));

test("a build after an abort waits for the aborted worker to exit, and the aborted one never resolves", async () => {
  const first = new AbortController();
  const aborted = workerBuilder(job, first.signal);
  await settle();
  expect(mockWorkers).toHaveLength(1);
  first.abort();
  void workerBuilder(job, new AbortController().signal);
  await settle();
  expect(mockWorkers).toHaveLength(1);
  mockWorkers[0]?.emit("message", { ok: true });
  mockWorkers[0]?.exit();
  await expect(aborted).rejects.toThrow("aborted");
  await settle();
  expect(mockWorkers).toHaveLength(2);
});
