export class FakeClock {
  private current: number;

  constructor(initial = 0) {
    this.current = initial;
  }

  now(): number {
    return this.current;
  }

  advanceBy(ms: number): number {
    this.current += ms;
    return this.current;
  }
}
