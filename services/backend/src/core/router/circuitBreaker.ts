export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before allowing one trial call. */
  cooldownMs: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = { failureThreshold: 3, cooldownMs: 30_000 };

/**
 * Per-provider circuit breaker (docs/architecture/08-deployment-architecture.md
 * §5). In-memory, single-process — matches the M1 topology (one backend
 * instance, docs/architecture/08-deployment-architecture.md §2.1).
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly options: CircuitBreakerOptions;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Whether a call should be allowed right now. Transitions open → half_open when the cooldown has elapsed. */
  canAttempt(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.options.cooldownMs) {
        this.state = "half_open";
        return true;
      }
      return false;
    }
    // half_open: allow exactly one trial call through; subsequent callers
    // wait for that trial to resolve via recordSuccess/recordFailure.
    return true;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "half_open" || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(providerId: string): CircuitBreaker {
  let breaker = breakers.get(providerId);
  if (!breaker) {
    breaker = new CircuitBreaker();
    breakers.set(providerId, breaker);
  }
  return breaker;
}

/** Test-only: clears all breaker state between test cases. */
export function resetAllCircuitBreakersForTests(): void {
  breakers.clear();
}
