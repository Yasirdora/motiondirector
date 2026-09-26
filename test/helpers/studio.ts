import { EventEmitter } from "node:events";
import path from "node:path";
import { AfterEffects } from "../../src/ae/client.js";
import { MailboxTransport, type SpawnFn } from "../../src/ae/transport.js";
import { Store } from "../../src/director/store.js";
import { Studio } from "../../src/server/studio.js";
import { compFromReading, createFakeAfterEffects } from "./fake-ae.js";
import { keyedCarelessTitleCard } from "./scenes.js";

/** A studio wired to a fake After Effects through the real transport and dispatcher. */
export function fakeStudio(root: string, options: { previews?: boolean; readOnly?: boolean } = {}) {
  const ae = createFakeAfterEffects(path.join(root, "temp"));
  const mailbox = path.join(root, "mailbox");
  const spawn: SpawnFn = () => {
    const child = Object.assign(new EventEmitter(), { stderr: Object.assign(new EventEmitter(), { setEncoding() {} }), unref() {} });
    setImmediate(() => {
      ae.runDispatcher(mailbox);
      child.emit("exit", 0);
    });
    return child as unknown as ReturnType<SpawnFn>;
  };
  const transport = new MailboxTransport({ mailbox, locate: () => "/Applications/AE.app", spawn, platform: "darwin", pollMs: 2, relaunchAfterMs: 1000 });
  const client = new AfterEffects(transport);
  const studio = new Studio(client, { store: new Store(path.join(root, "store")), previews: options.previews ?? false, readOnly: options.readOnly ?? false });
  const comp = compFromReading(ae.project, keyedCarelessTitleCard());
  ae.project.activeItem = comp;
  return { ae, studio, comp, client };
}
