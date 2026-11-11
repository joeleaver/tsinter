// Vue 2.7 workload: the template compiler and the server renderer, from source.
//   main.ts compile   -> render-function code for a set of templates
//   main.ts ssr       -> renderToString of components (props, computed, v-for, v-if, slots, filters-free)
//   main.ts bad       -> a template with errors: the compiler's error list
import "./vue-globals.ts";
import Vue from "../src/platforms/web/entry-runtime-with-compiler";
import { compile } from "../src/platforms/web/compiler/index";
import { createRenderer } from "../packages/server-renderer/src/index";

const TEMPLATES = [
  `<div id="app" :class="{ active: isActive, 'text-danger': hasError }">{{ message | upper }}</div>`,
  `<ul><li v-for="(item, i) in items" :key="item.id" @click="pick(i)">{{ i }}: {{ item.name }}</li></ul>`,
  `<div><p v-if="ok">yes</p><p v-else-if="maybe">maybe</p><p v-else>no</p><input v-model="text"></div>`,
  `<my-card title="t"><template #header="{ user }"><b>{{ user.name }}</b></template>body</my-card>`,
];

function cmdCompile(): void {
  for (const t of TEMPLATES) {
    const r = compile(t, { whitespace: "condense" });
    console.log("## " + t);
    console.log("render: " + r.render);
    console.log("staticRenderFns: " + r.staticRenderFns.length);
    console.log("errors: " + JSON.stringify(r.errors));
  }
}

function cmdBad(): void {
  const r = compile(`<div><span v-for="x in">{{ a + }}</span></div><p>two roots</p>`, {});
  console.log(JSON.stringify(r.errors, null, 1));
  console.log(JSON.stringify(r.tips, null, 1));
}

async function cmdSsr(): Promise<void> {
  const Card = Vue.extend({
    props: { title: String, items: { type: Array, default: () => [] } },
    data: () => ({ open: true }),
    computed: {
      count(): number {
        return (this as unknown as { items: unknown[] }).items.length;
      },
    },
    template: `<section class="card"><h2>{{ title }} ({{ count }})</h2><slot name="header" :user="{ name: 'ada' }"></slot>
      <ul v-if="open"><li v-for="it in items" :key="it" :class="{ odd: it % 2 }">{{ it * 2 }}</li></ul><slot>default</slot></section>`,
  });
  const app = new Vue({
    components: { Card },
    data: () => ({ n: 5, name: "<world & co>", flags: { a: true, b: false } }),
    computed: {
      list(): number[] {
        const n = (this as unknown as { n: number }).n;
        return Array.from({ length: n }, (_, i) => i + 1);
      },
    },
    template: `<div id="root" :data-n="n"><card title="Numbers" :items="list"><template #header="{ user }"><em>{{ user.name }}</em></template>
      <p v-for="(v, k) in flags" :key="k">{{ k }}={{ v }}</p></card><span v-html="'<i>raw</i>'"></span><p>{{ name }}</p>
      <input type="checkbox" :checked="flags.a"><button :disabled="!flags.b">go</button></div>`,
  });
  const renderer = createRenderer();
  const html = await renderer.renderToString(app);
  console.log(html);
  for (const n of [0, 1, 3]) {
    const vm = new Vue({ data: { n }, template: `<ol><li v-for="i in n">{{ i }}</li><li v-if="n === 0">none</li></ol>` });
    console.log(await renderer.renderToString(vm));
  }
}

const cmd = process.argv[2] ?? "ssr";
if (cmd === "compile") cmdCompile();
else if (cmd === "bad") cmdBad();
else if (cmd === "ssr") await cmdSsr();
else {
  console.error("usage: main.ts compile|ssr|bad");
  process.exitCode = 2;
}
