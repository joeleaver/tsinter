// stdout redirected to a file/pipe: Node's non-TTY WriteStream has no isTTY property (undefined)
console.log(process.stdout.isTTY, typeof process.stdout.isTTY, String(process.stderr.isTTY));
