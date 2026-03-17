/**
 * Lightweight debug logger shared by all extension modules.
 *
 * When debug mode is disabled (the default) setLogFn() is never called and
 * log() is a strict no-op with zero allocations.
 *
 * Call setLogFn() from extension.ts once the OutputChannel is ready.
 * Call setLogFn(undefined) to disable logging again.
 */

let _fn: ((line: string) => void) | undefined;

export function setLogFn(fn: ((line: string) => void) | undefined): void {
    _fn = fn;
}

/** Write a timestamped line.  No-op when debug mode is off. */
export function log(msg: string): void {
    if (!_fn) { return; }
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    _fn(`[${ts}] ${msg}`);
}
