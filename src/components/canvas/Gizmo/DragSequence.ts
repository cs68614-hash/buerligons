/** Serial native drag calls, coalescing intermediate positions but always committing the release position. */
export class DragSequence<T> {
  private latest?: T
  private draining?: Promise<void>
  private ended = false
  private ending?: Promise<void>

  constructor(
    private started: Promise<unknown>,
    private move: (value: T) => Promise<unknown>,
    private end: () => Promise<unknown>,
  ) {}

  update(value: T): void {
    if (this.ended) return
    this.latest = value
    this.drain()
  }

  finish(): Promise<void> {
    if (this.ending) return this.ending
    this.ended = true
    this.ending = (async () => {
      try {
        await this.started
        // drain includes any last pointer event received during an outstanding move.
        await this.draining
        while (this.latest !== undefined) {
          const value = this.latest
          this.latest = undefined
          await this.move(value)
        }
      } finally {
        await this.end()
      }
    })()
    return this.ending
  }

  private drain(): void {
    if (this.draining) return
    const task = (async () => {
      await this.started
      while (this.latest !== undefined) {
        const value = this.latest
        this.latest = undefined
        await this.move(value)
      }
    })()
    this.draining = task
    // Handle failed calls without an unhandled rejection during a pointer event.
    void task.catch(console.warn).finally(() => {
      this.draining = undefined
      if (this.latest !== undefined && !this.ended) this.drain()
    })
  }
}
