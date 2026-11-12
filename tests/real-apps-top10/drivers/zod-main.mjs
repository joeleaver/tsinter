// Unit U3+U4's real-world acceptance driver: zod 4 schemas shaped like the
// ones paperclip and rea build at startup (config files, CLI options,
// tagged API payloads), parsed against valid and invalid inputs. Every
// result and every error message is printed, so the run compares byte for
// byte against Node. Written for this repo; it imports zod but carries no
// zod code. Third-party code runs only on nico-top (README, NICO.md).
import { z } from "zod";

const Port = z.number().int().min(1).max(65535);

const ServerConfig = z
  .object({
    host: z.string().trim().min(1).default("127.0.0.1"),
    port: Port.default(3100),
    mode: z.enum(["local", "remote", "hybrid"]),
    tags: z.array(z.string().min(2)).max(4).optional(),
    labels: z.record(z.string(), z.string()).optional(),
    retries: z.number().int().nonnegative().catch(3),
    timeoutMs: z.number().positive().nullable(),
  })
  .strict();

const Issue = z.object({
  id: z.string().min(3),
  title: z.string().trim().max(40),
  priority: z.union([z.literal("low"), z.literal("medium"), z.literal("high")]),
  assignee: z.string().nullable().optional(),
  estimate: z.number().refine((n) => n % 0.5 === 0, { message: "estimate must be a multiple of 0.5" }),
});

const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("created"), issue: Issue }),
  z.object({ type: z.literal("moved"), from: z.string(), to: z.string() }),
  z.object({ type: z.literal("deleted"), id: z.string(), reason: z.string().optional() }),
]);

const Range = z
  .object({ start: z.number(), end: z.number() })
  .superRefine((r, ctx) => {
    if (r.end < r.start) ctx.addIssue({ code: "custom", message: "end before start", path: ["end"] });
  });

const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/[^a-z0-9]+/g, "-"));

// JavaScript, as most code that imports zod at startup is once built: with
// zod compiled from its JS (--npm-static), its declaration-only types are
// not part of the surface a TypeScript driver could check against.
function show(label, schema, input) {
  const r = schema.safeParse(input);
  if (r.success) {
    console.log(`${label}: ok ${JSON.stringify(r.data)}`);
  } else {
    console.log(`${label}: fail`);
    for (const issue of r.error.issues) {
      console.log(`  [${issue.code}] ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }
}

show("config-min", ServerConfig, { mode: "local", timeoutMs: null });
show("config-full", ServerConfig, {
  host: "  example.com ",
  port: 8080,
  mode: "hybrid",
  tags: ["ab", "cd"],
  labels: { team: "core", env: "dev" },
  retries: 2,
  timeoutMs: 1500,
});
show("config-bad", ServerConfig, { host: "", port: 70000, mode: "cloud", tags: ["x"], retries: -1, timeoutMs: 0 });
show("config-extra", ServerConfig, { mode: "remote", timeoutMs: 5, debug: true });
show("config-type", ServerConfig, "not an object");

show("issue-ok", Issue, { id: "PC-1", title: "  Fix the build  ", priority: "high", estimate: 1.5 });
show("issue-bad", Issue, { id: "x", title: "y".repeat(50), priority: "urgent", assignee: 7, estimate: 0.3 });

show("event-created", Event, { type: "created", issue: { id: "PC-2", title: "New", priority: "low", estimate: 2 } });
show("event-moved", Event, { type: "moved", from: "todo", to: "done" });
show("event-unknown", Event, { type: "renamed", id: "PC-3" });
show("event-missing", Event, { type: "deleted" });

show("range-ok", Range, { start: 1, end: 5 });
show("range-bad", Range, { start: 9, end: 2 });

show("slug", Slug, "  Hello, World!  ");
show("slug-bad", Slug, 42);

const parsed = ServerConfig.parse({ mode: "local", timeoutMs: 10 });
console.log("parse:", parsed.host, parsed.port, parsed.retries);
try {
  Issue.parse({ id: 1 });
} catch (e) {
  const err = e;
  console.log("thrown:", err.name, err.issues.length);
  console.log(err.message);
}
