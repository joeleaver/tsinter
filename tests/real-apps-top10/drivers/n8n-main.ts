// n8n workload: packages/workflow (n8n-workflow), the engine-independent core every n8n process loads.
//   n8n-main.ts graph   -> a workflow's connection graph: parents, children, start nodes, highest nodes
//   n8n-main.ts params  -> NodeHelpers.getNodeParameters (defaults, displayOptions) + parameter issues
//   n8n-main.ts expr    -> expression evaluation on the default (legacy, tournament) engine, incl. extensions
import { Workflow } from "../src/workflow";
import * as NodeHelpers from "../src/node-helpers";
import type { INode, INodeType, INodeTypes, IConnections, INodeTypeDescription, IVersionedNodeType } from "../src/interfaces";

const setDescription: INodeTypeDescription = {
  displayName: "Set",
  name: "test.set",
  group: ["input"],
  version: 1,
  description: "Sets a value",
  defaults: { name: "Set" },
  inputs: ["main"],
  outputs: ["main"],
  properties: [
    { displayName: "Mode", name: "mode", type: "options", default: "manual", options: [{ name: "Manual", value: "manual" }, { name: "Raw", value: "raw" }] },
    { displayName: "Value 1", name: "value1", type: "string", default: "default-value1", displayOptions: { show: { mode: ["manual"] } } },
    { displayName: "JSON", name: "json", type: "json", default: "{}", displayOptions: { show: { mode: ["raw"] } } },
    { displayName: "Count", name: "count", type: "number", default: 3, required: true },
    {
      displayName: "Options", name: "options", type: "collection", default: {}, placeholder: "Add option",
      options: [
        { displayName: "Dot Notation", name: "dotNotation", type: "boolean", default: true },
        { displayName: "Prefix", name: "prefix", type: "string", default: "" },
      ],
    },
  ],
};
const setNode: INodeType = { description: setDescription };

const nodeTypes: INodeTypes = {
  getByName: (_type: string): INodeType | IVersionedNodeType => setNode,
  getByNameAndVersion: (_type: string, _version?: number): INodeType => setNode,
  getKnownTypes: () => ({}),
};

function node(name: string, parameters: Record<string, unknown> = {}, disabled = false): INode {
  return { id: "id-" + name, name, type: "test.set", typeVersion: 1, position: [0, 0], parameters: parameters as INode["parameters"], ...(disabled ? { disabled } : {}) };
}
const link = (to: string, index = 0) => ({ node: to, type: "main" as const, index });

const nodes = [node("Start"), node("A", { value1: "a" }), node("B", { mode: "raw" }), node("C"), node("D", {}, true), node("Merge"), node("Lonely")];
const connections: IConnections = {
  Start: { main: [[link("A"), link("B")]] },
  A: { main: [[link("C")], [link("D")]] },
  B: { main: [[link("Merge", 1)]] },
  C: { main: [[link("Merge", 0)]] },
  D: { main: [[link("Merge", 0)]] },
};

function makeWorkflow(): Workflow {
  return new Workflow({ id: "wf1", name: "top10", nodes, connections, active: false, nodeTypes });
}

function cmdGraph(): void {
  const wf = makeWorkflow();
  for (const n of nodes) {
    console.log(`${n.name}: parents=${JSON.stringify(wf.getParentNodes(n.name))} children=${JSON.stringify(wf.getChildNodes(n.name))}` +
      ` parents1=${JSON.stringify(wf.getParentNodes(n.name, "main", 1))} highest=${JSON.stringify(wf.getHighestNode(n.name))}`);
  }
  console.log("connectionsByDestination:", JSON.stringify(wf.connectionsByDestinationNode));
  console.log("node(C):", JSON.stringify(wf.getNode("C")));
  console.log("node(nope):", JSON.stringify(wf.getNode("nope")));
  wf.renameNode("C", "C2");
  console.log("after rename:", JSON.stringify(wf.connectionsBySourceNode));
}

function cmdParams(): void {
  for (const n of nodes.slice(0, 3)) {
    const p = NodeHelpers.getNodeParameters(setDescription.properties, n.parameters, true, false, n, setDescription);
    console.log(`${n.name} defaults: ${JSON.stringify(p)}`);
    const q = NodeHelpers.getNodeParameters(setDescription.properties, n.parameters, false, false, n, setDescription);
    console.log(`${n.name} non-defaults: ${JSON.stringify(q)}`);
  }
  const bad = node("Bad", { count: "", mode: "manual" });
  console.log("issues:", JSON.stringify(NodeHelpers.getNodeParametersIssues(setDescription.properties, bad, setDescription)));
}

async function cmdExpr(): Promise<void> {
  const wf = makeWorkflow();
  const expression = wf.expression;
  await expression.acquireIsolate();
  const exprs = [
    "plain text", "={{ 1 + 2 * 3 }}", "={{ 'abc'.toUpperCase() + '-' + 'x'.repeat(3) }}", "=Hello {{ 'world' }}!",
    "={{ [3, 1, 2].sort() }}", "={{ [1, 2, 3, 4].sum() }}", "={{ 'hello world'.toTitleCase() }}", "={{ 'a@b.co'.isEmail() }}",
    "={{ [1, 2, 2, 3].removeDuplicates() }}", "={{ ({ a: 1, b: { c: 2 } }).keys() }}", "={{ (12.3456).round(2) }}",
    "={{ 'https://n8n.io/path?q=1'.extractDomain() }}", "={{ $workflow.name }}", "={{ $node.A ? 1 : 0 }}",
    "={{ Math.max(4, 9, 2) }}", "={{ JSON.stringify({ x: [1, { y: null }] }) }}", "={{ undefinedThing.x }}", "={{ 1 + }}",
  ];
  for (const e of exprs) {
    let out: string;
    try {
      out = JSON.stringify(expression.getParameterValue(e, null, 0, 0, "A", [], "manual", {}));
    } catch (err) {
      out = `ERROR ${(err as Error).name}: ${(err as Error).message}`;
    }
    console.log(`${e} => ${out}`);
  }
  await expression.releaseIsolate();
}

const cmd = process.argv[2] ?? "graph";
if (cmd === "graph") cmdGraph();
else if (cmd === "params") cmdParams();
else if (cmd === "expr") await cmdExpr();
else {
  console.error("usage: n8n-main.ts graph|params|expr");
  process.exitCode = 2;
}
