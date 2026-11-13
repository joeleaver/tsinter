// No profile: string crosses as (ptr, len); the alloc export is
// tsinter_alloc.
import { log } from "pw";

export function greet(name: string): string {
  log("hi " + name);
  return name + "!";
}
