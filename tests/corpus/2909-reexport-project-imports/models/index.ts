console.log("models");
export class User {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
export function describeUser(u: User): string {
  return `user(${u.name})`;
}
