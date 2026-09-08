/** Per-request backend timings, visible in the browser's Network panel. */
export class ServerTiming {
  private readonly started = performance.now();
  private readonly entries: string[] = [];

  async measure<T>(name: string, operation: PromiseLike<T>): Promise<T> {
    const start = performance.now();
    try {
      return await operation;
    } finally {
      this.entries.push(`${name};dur=${(performance.now() - start).toFixed(1)}`);
    }
  }

  // Names/descriptions are internal constants, never request parameters.
  describe(name: string, value: string): void {
    this.entries.push(`${name};desc="${value}"`);
  }

  header(): string {
    return [...this.entries, `total;dur=${(performance.now() - this.started).toFixed(1)}`].join(", ");
  }
}
