// rea workload: the `rea` CLI from source. scripts/rea.mjs is the published bin; it admits the Node
// release, then imports the BUILT cli runtime (dist/cli-runtime/cli.js) and serves it. This driver does the
// same against src/ (createCli(env, output).serve(argv)), without the runtime-admission and SIGPIPE handling
// around it, so `rea <args>` runs as the bin would.
import { createCli, closeCliResources } from "../src/cli.ts";

const args = process.argv.slice(2);
let exiting = false;
await createCli(process.env, undefined).serve(args, {
  stdout: (output: string) => {
    process.stdout.write(output);
  },
  exit: (code?: number) => {
    exiting = true;
    void closeCliResources().finally(() => process.exit(typeof code === "number" ? code : 0));
  },
});
if (!exiting) await closeCliResources();
