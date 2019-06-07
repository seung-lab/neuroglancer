interface AbortController {
    readonly signal: AbortSignal;
    abort(): void;
}

declare var AbortController: {
    prototype: AbortController;
    new(): AbortController;
};

interface AbortSignal extends EventTarget {
    readonly aborted: boolean;
    onabort: (ev: Event) => any;
}
