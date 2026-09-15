// Mixins across module boundaries: an imported mixin function composes in
// an importer heritage clause, an imported premixed const constructs and
// extends, and nested compositions chain imported layers.
import { AgedAnimal, Animal, Serializable } from "./zoo.ts";

class Dog extends Serializable(Animal) {
  speak() {
    return `${this.name} barks`;
  }
  constructorName() {
    return "Dog";
  }
}

const rex = new Dog("Rex");
console.log(rex.speak());
console.log(rex.serialize());
console.log(rex instanceof Dog, rex instanceof Animal);

// The imported premixed const: construct, mutate its mixin layer, extend it.
const generic = new AgedAnimal("Generic");
console.log(generic.speak(), generic.birthday(), generic.birthday());
console.log(generic instanceof AgedAnimal, generic instanceof Animal, generic instanceof Dog);

class Elder extends AgedAnimal {
  constructor(name: string) {
    super(name);
    this.age = 90;
  }
  speak() {
    return `${this.name} speaks wisely at ${this.age}`;
  }
}
const sage = new Elder("Sage");
console.log(sage.speak(), sage.birthday());
console.log(sage instanceof Elder, sage instanceof AgedAnimal, sage instanceof Animal);

// Nested composition of imported mixins in one heritage clause.
class Robot extends Serializable(AgedAnimal) {
  constructorName() {
    return "Robot";
  }
}
const r2 = new Robot("R2");
console.log(r2.serialize(), r2.birthday(), r2.speak());
console.log(r2 instanceof Robot, r2 instanceof AgedAnimal, r2 instanceof Animal, r2 instanceof Elder);

// Virtual dispatch over the shared Animal base across mixin layers.
const zoo: Animal[] = [new Dog("Fido"), sage, r2];
for (const a of zoo) console.log(a.speak());
