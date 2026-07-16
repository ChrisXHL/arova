export interface ProviderLimiterSnapshot {
	key: string;
	configuredConcurrency: number;
	effectiveConcurrency: number;
	inFlight: number;
	cooldownUntil: number;
	consecutiveSuccesses: number;
	rateLimitCount: number;
}

export interface ProviderLimiterOptions {
	configuredConcurrency?: number;
	now?: () => number;
	random?: () => number;
}

export class ProviderLimiter {
	readonly key: string;
	private configuredConcurrency: number;
	private effectiveConcurrency: number;
	private inFlight = 0;
	private cooldownUntil = 0;
	private consecutiveSuccesses = 0;
	private rateLimitCount = 0;
	private readonly now: () => number;
	private readonly random: () => number;

	constructor(key: string, options: ProviderLimiterOptions = {}) {
		this.key = key;
		this.configuredConcurrency = this.bound(options.configuredConcurrency ?? 1);
		this.effectiveConcurrency = this.configuredConcurrency;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
	}

	private bound(value: number): number {
		return Math.max(1, Math.min(4, Math.floor(value)));
	}

	setConfiguredConcurrency(value: number): void {
		this.configuredConcurrency = this.bound(value);
		this.effectiveConcurrency = Math.min(this.effectiveConcurrency, this.configuredConcurrency);
		if (this.rateLimitCount === 0) this.effectiveConcurrency = this.configuredConcurrency;
	}

	tryAcquire(now = this.now()): boolean {
		if (now < this.cooldownUntil || this.inFlight >= this.effectiveConcurrency) return false;
		this.inFlight++;
		return true;
	}

	release(): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
	}

	noteSuccess(): void {
		this.release();
		this.consecutiveSuccesses++;
		if (this.consecutiveSuccesses >= 10) {
			this.consecutiveSuccesses = 0;
			if (this.effectiveConcurrency < this.configuredConcurrency) this.effectiveConcurrency++;
			if (this.effectiveConcurrency === this.configuredConcurrency) this.rateLimitCount = 0;
		}
	}

	noteRateLimit(retryAfterMs?: number, now = this.now()): number {
		this.release();
		this.rateLimitCount++;
		this.consecutiveSuccesses = 0;
		this.effectiveConcurrency = 1;
		const base = Math.min(600_000, 30_000 * 2 ** Math.min(5, this.rateLimitCount - 1));
		const jittered = Math.max(1_000, Math.floor(base * (0.5 + this.random() * 0.5)));
		this.cooldownUntil = Math.max(this.cooldownUntil, now + Math.max(retryAfterMs ?? 0, jittered));
		return this.cooldownUntil;
	}

	nextAllowedAt(): number {
		return this.cooldownUntil;
	}

	getSnapshot(): ProviderLimiterSnapshot {
		return {
			key: this.key,
			configuredConcurrency: this.configuredConcurrency,
			effectiveConcurrency: this.effectiveConcurrency,
			inFlight: this.inFlight,
			cooldownUntil: this.cooldownUntil,
			consecutiveSuccesses: this.consecutiveSuccesses,
			rateLimitCount: this.rateLimitCount,
		};
	}
}

const limiters = new Map<string, ProviderLimiter>();

export function sharedProviderLimiter(key: string, configuredConcurrency = 1): ProviderLimiter {
	const existing = limiters.get(key);
	if (existing) {
		existing.setConfiguredConcurrency(configuredConcurrency);
		return existing;
	}
	const limiter = new ProviderLimiter(key, { configuredConcurrency });
	limiters.set(key, limiter);
	return limiter;
}

export function clearSharedProviderLimiters(): void {
	limiters.clear();
}

