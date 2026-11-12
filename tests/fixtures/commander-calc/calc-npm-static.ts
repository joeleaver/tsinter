// The --npm-static commander probe: the same CLI shape as calc.ts. The
// program types against commander's shipped typings (SEMANTICS.md S133)
// while commander's JS compiles; npm-static.test.ts pins the coverage.
import { Command } from "commander";
const program = new Command();
program.name("calc");
const add = program.command("add <a> <b>");
add.description("add two numbers");
add.action((a: string, b: string) => {
  console.log(parseInt(a, 10) + parseInt(b, 10));
});
program.parse();
