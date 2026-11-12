// commander workload (SEMANTICS.md S133): a CLI written the way paperclip's cli/src/index.ts writes its
// commander program — new Command() chained through name/description/version, subcommands with aliases,
// options with defaults, negations, parsers and required options, Option objects with choices/default/
// conflicts through addOption, arguments, a preAction hook reading optsWithGlobals() and the action
// command's options, addHelpText, an exitOverride + configureOutput pair on one subcommand, and
// parseAsync() inside a try/catch that prints the error message and exits 1. The program types against
// commander's shipped typings; commander's own JS is what compiles. It runs inside paperclip's tree on
// nico-top (workloads.json "commander": srcProject paperclip), so it resolves the commander paperclip
// installed (15.0.0, --ignore-scripts, lockfile integrity checked).
import { Command, CommanderError, Option } from "commander";

interface GlobalOpts {
  config?: string;
  dataDir?: string;
  verbose?: boolean;
}

interface DeployOpts extends GlobalOpts {
  target: string;
  region: string;
  retries: number;
  dryRun?: boolean;
  backup: boolean;
  apiKey?: string;
  apiKeyEnv?: string;
}

const HARNESSES = ["claude", "codex", "gemini"] as const;
const log: string[] = [];

const program = new Command();

program.enablePositionalOptions();

program
  .name("shipit")
  .description("A small deployment CLI shaped like paperclip's")
  .version("1.4.2")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", "Data directory root")
  .option("-v, --verbose", "Print hook traces", false);

program.addHelpText("after", "\nExamples:\n  $ shipit deploy web --target prod\n  $ shipit env");

program.hook("preAction", async (_thisCommand, actionCommand) => {
  if (actionCommand.parent?.name() === "runtime") return;
  const options = actionCommand.optsWithGlobals() as GlobalOpts;
  const optionNames = new Set(actionCommand.options.map((option) => option.attributeName()));
  if (options.verbose === true) {
    log.push(`preAction ${actionCommand.name()} config=${options.config ?? "-"} names=${[...optionNames].sort().join(",")}`);
  }
});

program
  .command("deploy")
  .alias("ship")
  .description("Deploy an app to a target")
  .argument("<app>", "App to deploy")
  .argument("[extra...]", "Extra labels")
  .requiredOption("-t, --target <target>", "Deployment target")
  .option("-r, --region <region>", "Region to deploy to", "us-east-1")
  .option("--retries <n>", "Retry count", (value: string) => Number(value), 2)
  .option("--dry-run", "Print the plan without deploying")
  .option("--no-backup", "Skip the pre-deploy backup")
  .addOption(new Option("--harness <harness>", "Agent harness").choices(HARNESSES).default("claude"))
  .addOption(new Option("--api-key-env <variable>", "Read the key from an environment variable").conflicts("apiKey"))
  .addOption(new Option("--api-key <value>", "Provider API key").conflicts("apiKeyEnv"))
  .action(async (app: string, extra: string[], opts: DeployOpts & { harness: string }) => {
    await Promise.resolve();
    const plan = [
      `deploy ${app} -> ${opts.target} (${opts.region})`,
      `retries=${opts.retries} backup=${opts.backup} dryRun=${opts.dryRun === true} harness=${opts.harness}`,
      `extra=${extra.length > 0 ? extra.join("+") : "none"} key=${opts.apiKey !== undefined ? "inline" : opts.apiKeyEnv ?? "none"}`,
    ];
    for (const line of plan) console.log(line);
  });

program
  .command("env")
  .description("Print environment variables for deployment")
  .option("--json", "Machine-readable output")
  .action(async (opts: { json?: boolean }) => {
    const vars = { SHIPIT_HOME: "/srv/shipit", SHIPIT_MODE: "local" };
    if (opts.json === true) console.log(JSON.stringify(vars));
    else for (const [k, v] of Object.entries(vars)) console.log(`${k}=${v}`);
  });

const heartbeat = program.command("heartbeat").description("Heartbeat utilities");

heartbeat
  .command("run")
  .description("Run one heartbeat")
  .requiredOption("-a, --agent-id <agentId>", "Agent ID to invoke")
  .option("--source <source>", "Invocation source (timer | assignment | on_demand)", "on_demand")
  .option("--timeout-ms <ms>", "Max time to wait", "0")
  .action((opts: { agentId: string; source: string; timeoutMs: string }) => {
    console.log(`heartbeat agent=${opts.agentId} source=${opts.source} timeout=${opts.timeoutMs}`);
  });

// A subcommand that handles its own errors: exitOverride turns commander's exits into thrown
// CommanderErrors, configureOutput redirects what it writes.
program
  .command("strict")
  .description("Validate a level with self-handled errors")
  .argument("<level>", "Level from 1 to 3")
  .exitOverride((err) => {
    throw err;
  })
  .configureOutput({
    writeErr: (str) => process.stdout.write(`[strict] ${str}`),
    outputError: (str, write) => write(`!! ${str}`),
  })
  .action((level: string) => {
    const n = Number(level);
    if (!(n >= 1 && n <= 3)) program.commands.find((c) => c.name() === "strict")!.error(`level out of range: ${level}`, { exitCode: 4, code: "shipit.level" });
    console.log(`level ${n} ok`);
  });

async function main(): Promise<void> {
  let failed = false;
  try {
    await program.parseAsync();
  } catch (err) {
    failed = true;
    if (err instanceof CommanderError) console.error(`commander error ${err.code} exit=${err.exitCode}: ${err.message}`);
    else console.error(err instanceof Error ? err.message : String(err));
  } finally {
    for (const line of log) console.log(line);
  }
  if (failed) process.exit(1);
}

void main();
