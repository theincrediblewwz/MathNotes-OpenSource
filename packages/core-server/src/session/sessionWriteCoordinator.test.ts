import { describe, expect, it } from "vitest";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";

function gate() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), release: () => resolve() }; }
describe("workspace write barrier", () => {
  it("drains earlier sessions, blocks later writes, and releases after rejection", async () => {
    const writes = new SessionWriteCoordinator(), first = gate(), directory = gate();
    const entered: string[] = [];
    const a = writes.run("book", "a", async () => { entered.push("a"); await first.promise; });
    const b = writes.run("book", "b", async () => { entered.push("b"); });
    const catalog = writes.runWorkspace(async () => { entered.push("catalog"); await directory.promise; throw new Error("injected"); });
    const rejection = expect(catalog).rejects.toThrow("injected");
    const later = writes.runMany([{ notebookId: "other", sessionId: "c" }], async () => { entered.push("later"); });
    await b; expect(entered).toEqual(["a", "b"]);
    first.release(); await a; await Promise.resolve(); await Promise.resolve();
    expect(entered).not.toContain("later");
    directory.release(); await rejection; await later;
    expect(entered).toEqual(["a", "b", "catalog", "later"]);
  });
  it("allows composed writes inside its barrier but not detached work after release", async () => {
    const writes = new SessionWriteCoordinator(), fire = gate(), hold = gate(), detachedDone = gate();
    const order: string[] = [];
    await writes.runWorkspace(async () => {
      await writes.runWorkspace(() => writes.run("book", "s", async () => { order.push("nested"); }));
      void fire.promise.then(() => writes.run("book", "s", async () => { order.push("detached"); })).then(detachedDone.release);
    });
    const second = writes.runWorkspace(async () => { order.push("second"); await hold.promise; });
    fire.release(); await Promise.resolve(); await Promise.resolve();
    expect(order).not.toContain("detached");
    hold.release(); await second; await detachedDone.promise;
    expect(order).toEqual(["nested", "second", "detached"]);
  });
});
