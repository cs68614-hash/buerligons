/** One active computation and one replaceable pending snapshot; obsolete results never reach the UI. */
export class LatestAnalysis<T, R> {
  private serial = 0
  private latest?: { id: number; input: T }
  private running = false
  private timer?: ReturnType<typeof setTimeout>
  private completed?: { id: number; result: R }
  private waiters: { resolve: (result: R) => void; reject: (error: Error) => void }[] = []

  constructor(
    private compute: (input: T) => Promise<R>,
    private pending: () => void,
    private ready: (result: R) => void,
    private failed: (error: Error) => void,
    private interval = 100,
  ) {}

  schedule(input: T): void {
    this.latest = { id: ++this.serial, input }
    this.completed = undefined
    this.pending()
    this.startSoon()
  }

  /** Skip the sampling delay on release; existing work finishes before the final snapshot runs. */
  flush(): Promise<R> {
    if (!this.latest) return Promise.reject(new Error('没有待检查的装配。'))
    if (this.completed?.id === this.latest.id) return Promise.resolve(this.completed.result)
    const promise = new Promise<R>((resolve, reject) => this.waiters.push({ resolve, reject }))
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    void this.run()
    return promise
  }

  cancel(): void {
    ++this.serial
    this.latest = undefined
    this.completed = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.settle(new Error('干涉检查已取消。'))
  }

  private startSoon(): void {
    if (this.running || this.timer || !this.latest) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        void this.run()
      },
      this.waiters.length ? 0 : this.interval,
    )
  }

  private settle(error?: Error, result?: R): void {
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) {
      if (error) waiter.reject(error)
      else waiter.resolve(result!)
    }
  }

  private async run(): Promise<void> {
    if (this.running || !this.latest) return
    const snapshot = this.latest
    this.running = true
    try {
      const result = await this.compute(snapshot.input)
      if (snapshot.id === this.latest?.id) {
        this.completed = { id: snapshot.id, result }
        this.ready(result)
        this.settle(undefined, result)
      }
    } catch (cause) {
      if (snapshot.id === this.latest?.id) {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        this.failed(error)
        this.settle(error)
      }
    } finally {
      this.running = false
      // A failure is shown once, not retried forever. A newer pose remains eligible.
      if (this.latest && snapshot.id !== this.latest.id) this.startSoon()
    }
  }
}
