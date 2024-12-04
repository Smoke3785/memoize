import mimicFunction from 'mimic-function';
const cacheStore = new WeakMap();
const cacheTimerStore = new WeakMap();
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
export default function memoize(function_, { cacheKey, cache = new Map(), maxAge, } = {}) {
    if (maxAge === 0) {
        return function_;
    }
    if (typeof maxAge === 'number') {
        const maxSetIntervalValue = 2_147_483_647;
        if (maxAge > maxSetIntervalValue) {
            throw new TypeError(`The \`maxAge\` option cannot exceed ${maxSetIntervalValue}.`);
        }
        if (maxAge < 0) {
            throw new TypeError('The `maxAge` option should not be a negative number.');
        }
    }
    const memoized = function (...arguments_) {
        const key = cacheKey
            ? cacheKey(arguments_)
            : arguments_[0];
        const cacheItem = cache.get(key);
        if (cacheItem) {
            return cacheItem.data;
        }
        const result = function_.apply(this, arguments_);
        cache.set(key, {
            data: result,
            maxAge: maxAge ? Date.now() + maxAge : Number.POSITIVE_INFINITY,
        });
        if (typeof maxAge === 'number' && maxAge !== Number.POSITIVE_INFINITY) {
            const timer = setTimeout(() => {
                cache.delete(key);
            }, maxAge);
            timer.unref?.();
            const timers = cacheTimerStore.get(function_) ?? new Set();
            timers.add(timer);
            cacheTimerStore.set(function_, timers);
        }
        return result;
    };
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
export function memoizeDecorator(options = {}) {
    return (
    // @ts-expect-error 'target' is declared but its value is never read.
    target, propertyKey, descriptor) => {
        const isGetter = Boolean(descriptor.get);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const originalMethod = descriptor.value || descriptor.get;
        if (typeof originalMethod !== 'function') {
            throw new TypeError('The decorated value must be a function or a getter');
        }
        if (!isGetter) {
            const memoizedKey = Symbol(`__memoized_${String(propertyKey)}`);
            descriptor.value = function (...arguments_) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                this[memoizedKey] ||= memoize(originalMethod.bind(this), options);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                return this[memoizedKey](...arguments_);
            };
            return;
        }
        const memoizedKey = Symbol(`__memoized_${String(propertyKey)}`);
        descriptor.get = function () {
            if (Object.hasOwn(this, memoizedKey)) {
                return this[memoizedKey];
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
            const value = originalMethod.call(this);
            Object.defineProperty(this, memoizedKey, {
                configurable: false,
                enumerable: false,
                writable: false,
                value,
            });
            return value;
        };
    };
}
/**
Clear all cached data of a memoized function.

@param fn - The memoized function.
*/
export function memoizeClear(function_) {
    const cache = cacheStore.get(function_);
    if (!cache) {
        // eslint-disable-next-line @typescript-eslint/quotes
        throw new TypeError("Can't clear a function that was not memoized!");
    }
    if (typeof cache.clear !== 'function') {
        // eslint-disable-next-line @typescript-eslint/quotes
        throw new TypeError("The cache Map can't be cleared!");
    }
    cache.clear();
    for (const timer of cacheTimerStore.get(function_) ?? []) {
        clearTimeout(timer);
    }
}
