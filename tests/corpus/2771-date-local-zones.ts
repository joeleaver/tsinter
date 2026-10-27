// An offset-less date-time string is LOCAL time (SEMANTICS.md S113): its
// value depends on the zone, which this program chooses itself — Node
// re-reads its zone whenever process.env.TZ is assigned, and so does every
// lane (the wasm tier through its host's tzCall ZONE). Each zone below is
// asked about its DST gap (the offset before the transition applies),
// its overlap (the earlier of the two instants), local mean time before
// 1900 (seconds kept), 24:00, and the edges of the Date range.
const rows = [
  "2020-03-08T02:30:00", // US spring-forward gap
  "2020-03-08T03:30:00",
  "2020-11-01T01:30:00", // US fall-back overlap
  "2020-11-01T01:59:59.999",
  "2020-11-01T02:00:00",
  "2020-03-29T01:30:00", // EU gap
  "2020-10-25T01:30:00", // EU overlap
  "2020-10-04T02:15:00", // Lord Howe's half-hour gap
  "2020-04-05T01:45:00", // Lord Howe's half-hour overlap
  "1880-01-01T00:00:00", // local mean time
  "1800-06-15T12:34:56.789",
  "1970-01-01T00:00",
  "2020-06-01T24:00",
  "2020-06-01T24:00:01", // NaN, as in Node
  "2020-02-30T12:00", // rolls into March, as in Node
  "+275760-09-12T23:00",
  "+275760-09-13T00:00",
  "-271821-04-20T00:00",
  "-271821-04-19T23:59",
  "+002020-06-01T12:00:00.500",
  "0099-12-31T23:59:59",
  "2020T12:00",
  "2020-06T12:00",
];
const zones = ["America/Chicago", "Asia/Kolkata", "Australia/Lord_Howe", "Europe/London", "UTC", "America/St_Johns", "Invalid/Zone"];
for (const z of zones) {
  process.env.TZ = z;
  console.log(`-- ${z}`);
  for (const s of rows) console.log(s, new Date(s).getTime());
}
// The explicit-offset and date-only forms do not move with the zone.
for (const z of ["Asia/Kolkata", "America/Chicago"]) {
  process.env.TZ = z;
  console.log(z, new Date("2020-03-08T02:30:00Z").getTime(), new Date("2020-03-08T02:30:00-06:00").getTime(), new Date("2020-03-08").getTime());
}
// Deleting TZ returns to the system zone; setting it again is honoured.
delete process.env.TZ;
process.env.TZ = "Pacific/Chatham";
console.log("Chatham", new Date("2020-04-05T02:50:00").getTime(), new Date("2020-09-27T02:50:00").getTime());
