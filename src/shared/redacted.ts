// Wraps a secret so it cannot leak through logs, inspection, or JSON
// serialization. Call reveal() only at the boundary that needs the raw value.
export class Redacted<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return '<redacted>';
  }

  toJSON(): string {
    return '<redacted>';
  }
}

export function redact<T>(value: T): Redacted<T> {
  return new Redacted(value);
}
