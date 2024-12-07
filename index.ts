import mimicFunction from 'mimic-function';

type AnyFunction = (...arguments_: readonly any[]) => unknown;

const cacheStore = new WeakMap<AnyFunction, CacheStorage<any, any>>();
const cacheTimerStore = new WeakMap<AnyFunction, Set<number>>();

type CacheStorageContent<ValueType> = {
	data: ValueType;
	maxAge: number;
};

type CacheStorage<KeyType, ValueType> = {
	has: (key: KeyType) => boolean;
	get: (key: KeyType) => CacheStorageContent<ValueType> | undefined;
	set: (key: KeyType, value: CacheStorageContent<ValueType>) => void;
	delete: (key: KeyType) => void;
	clear?: () => void;
};

export type Options<
	FunctionToMemoize extends AnyFunction,
	CacheKeyType,
> = {
	/**
	Milliseconds until the cache entry expires.

	@default Infinity
	*/
	readonly maxAge?: number;

	/**
	Determines the cache key for storing the result based on the function arguments. By default, __only the first argument is considered__ and it only works with [primitives](https://developer.mozilla.org/en-US/docs/Glossary/Primitive).

	A `cacheKey` function can return any type supported by `Map` (or whatever structure you use in the `cache` option).

	You can have it cache **all** the arguments by value with `JSON.stringify`, if they are compatible:

	```
	import memoize from 'memoize';

	memoize(function_, {cacheKey: JSON.stringify});
	```

	Or you can use a more full-featured serializer like [serialize-javascript](https://github.com/yahoo/serialize-javascript) to add support for `RegExp`, `Date` and so on.

	```
	import memoize from 'memoize';
	import serializeJavascript from 'serialize-javascript';

	memoize(function_, {cacheKey: serializeJavascript});
	```

	@default arguments_ => arguments_[0]
	@example arguments_ => JSON.stringify(arguments_)
	*/
	readonly cacheKey?: (
		arguments_: Parameters<FunctionToMemoize>,
	) => CacheKeyType;

	/**
	Use a different cache storage. Must implement the following methods: `.has(key)`, `.get(key)`, `.set(key, value)`, `.delete(key)`, and optionally `.clear()`. You could for example use a `WeakMap` instead or [`quick-lru`](https://github.com/sindresorhus/quick-lru) for a LRU cache.

	@default new Map()
	@example new WeakMap()
	*/
	readonly cache?: CacheStorage<CacheKeyType, ReturnType<FunctionToMemoize>>;
};

/**
[Memoize](https://en.wikipedia.org/wiki/Memoization) functions - An optimization used to speed up consecutive function calls by caching the result of calls with identical input.

@param fn - The function to be memoized.

@example
```
import memoize from 'memoize';

let index = 0;
const counter = () => ++index;
const memoized = memoize(counter);

memoized('foo');
//=> 1

// Cached as it's the same argument
memoized('foo');
//=> 1

// Not cached anymore as the arguments changed
memoized('bar');
//=> 2

memoized('bar');
//=> 2
```
*/
export default function memoize<
	FunctionToMemoize extends AnyFunction,
	CacheKeyType,
>(
	function_: FunctionToMemoize,
	{
		cacheKey,
		cache = new Map(),
		maxAge,
	}: Options<FunctionToMemoize, CacheKeyType> = {},
): FunctionToMemoize {
	if (maxAge === 0) {
		return function_;
	}

	if (typeof maxAge === 'number') {
		const maxSetIntervalValue = 2_147_483_647;
		if (maxAge > maxSetIntervalValue) {
			throw new TypeError(
				`The \`maxAge\` option cannot exceed ${maxSetIntervalValue}.`,
			);
		}

		if (maxAge < 0) {
			throw new TypeError(
				'The `maxAge` option should not be a negative number.',
			);
		}
	}

	const memoized = function (
		this: any,
		...arguments_: Parameters<FunctionToMemoize>
	): ReturnType<FunctionToMemoize> {
		const key = cacheKey
			? cacheKey(arguments_)
			: (arguments_[0] as CacheKeyType);

		const cacheItem = cache.get(key);
		if (cacheItem) {
			return cacheItem.data;
		}

		const result = function_.apply(
			this,
			arguments_,
		) as ReturnType<FunctionToMemoize>;

		cache.set(key, {
			data: result,
			maxAge: maxAge ? Date.now() + maxAge : Number.POSITIVE_INFINITY,
		});

		if (typeof maxAge === 'number' && maxAge !== Number.POSITIVE_INFINITY) {
			const timer = setTimeout(() => {
				cache.delete(key);
			}, maxAge);

			timer.unref?.();

			const timers = cacheTimerStore.get(function_) ?? new Set<number>();
			timers.add(timer as unknown as number);
			cacheTimerStore.set(function_, timers);
		}

		return result;
	} as FunctionToMemoize;

	mimicFunction(memoized, function_, {
		ignoreNonConfigurable: true,
	});

	cacheStore.set(memoized, cache);

	return memoized;
}

/**
@returns A [decorator](https://github.com/tc39/proposal-decorators) to memoize class methods or static class methods.

@example
```
import {memoizeDecorator} from 'memoize';

class Example {
	index = 0

	@memoizeDecorator()
	counter() {
		return ++this.index;
	}
}

class ExampleWithOptions {
	index = 0

	@memoizeDecorator({maxAge: 1000})
	counter() {
		return ++this.index;
	}
}
```
*/
export function memoizeDecorator<
	FunctionToMemoize extends AnyFunction,
	CacheKeyType,
>(options: Options<FunctionToMemoize, CacheKeyType> = {}): MethodDecorator {
	const memoizedMethodsMap = new WeakMap<any, AnyFunction>();
	const memoizedValuesMap = new WeakMap<any, unknown>();

	return (
		_target: any,
		_propertyKey: string | symbol,
		descriptor: PropertyDescriptor,
	): void => {
		const originalIsGetter = typeof descriptor.get === 'function';
		const originalIsValue = descriptor.value !== undefined;

		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const originalMethod = descriptor.value ?? descriptor.get;

		if (typeof originalMethod !== 'function') {
			throw new TypeError('The decorated value must be a function or a getter');
		}

		if (originalIsGetter) {
			// This was originally a getter. We must not specify `value` or `writable`.
			delete descriptor.value;
			delete descriptor.writable;

			descriptor.get = function (this: any): unknown {
				if (memoizedValuesMap.has(this)) {
					return memoizedValuesMap.get(this);
				}

				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
				const value = originalMethod.call(this);

				memoizedValuesMap.set(this, value);
				return value;
			};
		} else if (originalIsValue) {
			// This was originally a regular method. We must not specify `get` or `set`.
			delete descriptor.get;
			delete descriptor.set;

			descriptor.value = function (this: any, ...arguments_: any[]) {
				let memoizedFunction = memoizedMethodsMap.get(this);
				if (memoizedFunction !== undefined) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
					return memoizedFunction(...arguments_);
				}

				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
				memoizedFunction = memoize(originalMethod.bind(this), options);

				if (memoizedFunction === undefined) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-call
					return originalMethod.call(this, ...arguments_);
				}

				memoizedMethodsMap.set(this, memoizedFunction);

				// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
				return memoizedFunction(...arguments_);
			};
		} else {
			// In case there's a scenario with no get/value, handle gracefully by defining a value property.
			delete descriptor.get;
			delete descriptor.set;

			descriptor.value = function (this: any, ...arguments_: any[]) {
				let memoizedFunction = memoizedMethodsMap.get(this);
				if (memoizedFunction !== undefined) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
					return memoizedFunction(...arguments_);
				}

				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
				memoizedFunction = memoize(originalMethod.bind(this), options);

				if (memoizedFunction === undefined) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-call
					return originalMethod.call(this, ...arguments_);
				}

				memoizedMethodsMap.set(this, memoizedFunction);

				// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
				return memoizedFunction(...arguments_);
			};
		}
	};
}

/**
Clear all cached data of a memoized function.

@param fn - The memoized function.
*/
export function memoizeClear(function_: AnyFunction): void {
	const cache = cacheStore.get(function_);
	if (!cache) {
		throw new TypeError('Can\'t clear a function that was not memoized!');
	}

	if (typeof cache.clear !== 'function') {
		throw new TypeError('The cache Map can\'t be cleared!');
	}

	cache.clear();

	for (const timer of cacheTimerStore.get(function_) ?? []) {
		clearTimeout(timer);
	}
}
