// Regex: test, global match, capture-group replace and split over generated log lines.
const lines: string[] = [];
for (let i = 0; i < 20_000; i++) lines.push(`2026-10-${(i % 28) + 10}T12:${i % 60}:00Z level=${i % 5 === 0 ? "error" : "info"} user=u${i % 97} msg="request ${i} took ${i % 300}ms"`);
const text = lines.join("\n");
let errors = 0;
let slow = 0;
const re = /level=error/;
const took = /took (\d+)ms/;
for (const l of lines) {
  if (re.test(l)) errors++;
  const m = l.match(took);
  if (m && Number(m[1]) > 250) slow++;
}
const users = text.match(/user=u\d+/g);
const nUsers = users === null ? 0 : users.length;
const swapped = text.replace(/(\d{4})-(\d{2})-(\d{2})/g, "$3/$2/$1");
const parts = swapped.split(/\s+/);
console.log(errors, slow, nUsers, swapped.length, parts.length);
