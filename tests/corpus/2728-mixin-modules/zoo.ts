// The exporter: a mixin function, a base class, and a premixed result.
export type Ctor<T = object> = new (...args: any[]) => T;

export class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  speak() {
    return `${this.name} makes a sound`;
  }
}

export function Serializable<T extends Ctor<object>>(Base: T) {
  return class extends Base {
    serialize() {
      return `[serialized ${this.constructorName()}]`;
    }
    constructorName() {
      return "value";
    }
  };
}

export function Aged<T extends Ctor<Animal>>(Base: T) {
  class WithAge extends Base {
    age = 0;
    birthday() {
      this.age++;
      return this.age;
    }
  }
  return WithAge;
}

export const AgedAnimal = Aged(Animal);
