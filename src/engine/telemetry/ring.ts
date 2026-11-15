/** Fixed-size buffer that keeps the newest `capacity` items. */
export class Ring<T> {
  #items: (T | undefined)[];
  #next = 0;
  #size = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Ring capacity must be a positive integer");
    this.capacity = capacity;
    this.#items = new Array(capacity);
  }

  get size() {
    return this.#size;
  }

  push(item: T) {
    this.#items[this.#next] = item;
    this.#next = (this.#next + 1) % this.capacity;
    this.#size = Math.min(this.#size + 1, this.capacity);
  }

  /** Oldest first. */
  toArray(): T[] {
    const start = (this.#next - this.#size + this.capacity) % this.capacity;
    const out: T[] = [];
    for (let i = 0; i < this.#size; i += 1) out.push(this.#items[(start + i) % this.capacity] as T);
    return out;
  }
}
