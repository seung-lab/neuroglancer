var Module = typeof Module !== "undefined" ? Module : {};
nbind = null;
Module.onRuntimeInitialized = (function(init, cb) {
    return (function() {
        if (init) init.apply(this, arguments);
        Module._nbind_init();
        nbind = Module._nbind_value;
        nbind.lib = Module
    })
})(Module.onRuntimeInitialized, null);
var moduleOverrides = {};
var key;
for (key in Module) {
    if (Module.hasOwnProperty(key)) {
        moduleOverrides[key] = Module[key]
    }
}
Module["arguments"] = [];
Module["thisProgram"] = "./this.program";
Module["quit"] = (function(status, toThrow) {
    throw toThrow
});
Module["preRun"] = [];
Module["postRun"] = [];
var ENVIRONMENT_IS_WEB = true;
var ENVIRONMENT_IS_WORKER = false;
var ENVIRONMENT_IS_NODE = false;
var ENVIRONMENT_IS_SHELL = false;

Module["print"] = typeof console !== "undefined" ? console.log.bind(console) : typeof print !== "undefined" ? print : null;
Module["printErr"] = typeof printErr !== "undefined" ? printErr : typeof console !== "undefined" && console.warn.bind(console) || Module["print"];
Module.print = Module["print"];
Module.printErr = Module["printErr"];
for (key in moduleOverrides) {
    if (moduleOverrides.hasOwnProperty(key)) {
        Module[key] = moduleOverrides[key]
    }
}
moduleOverrides = undefined;
var STACK_ALIGN = 16;

function staticAlloc(size) {
    assert(!staticSealed);
    var ret = STATICTOP;
    STATICTOP = STATICTOP + size + 15 & -16;
    return ret
}

function alignMemory(size, factor) {
    if (!factor) factor = STACK_ALIGN;
    var ret = size = Math.ceil(size / factor) * factor;
    return ret
}

function warnOnce(text) {
    if (!warnOnce.shown) warnOnce.shown = {};
    if (!warnOnce.shown[text]) {
        warnOnce.shown[text] = 1;
        Module.printErr(text)
    }
}
var asm2wasmImports = {
    "f64-rem": (function(x, y) {
        return x % y
    }),
    "debugger": (function() {
        debugger
    })
};
var functionPointers = new Array(0);
var GLOBAL_BASE = 1024;
var ABORT = 0;
var EXITSTATUS = 0;

function assert(condition, text) {
    if (!condition) {
        abort("Assertion failed: " + text)
    }
}

function Pointer_stringify(ptr, length) {
    if (length === 0 || !ptr) return "";
    var hasUtf = 0;
    var t;
    var i = 0;
    while (1) {
        t = HEAPU8[ptr + i >> 0];
        hasUtf |= t;
        if (t == 0 && !length) break;
        i++;
        if (length && i == length) break
    }
    if (!length) length = i;
    var ret = "";
    if (hasUtf < 128) {
        var MAX_CHUNK = 1024;
        var curr;
        while (length > 0) {
            curr = String.fromCharCode.apply(String, HEAPU8.subarray(ptr, ptr + Math.min(length, MAX_CHUNK)));
            ret = ret ? ret + curr : curr;
            ptr += MAX_CHUNK;
            length -= MAX_CHUNK
        }
        return ret
    }
    return UTF8ToString(ptr)
}
var UTF8Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf8") : undefined;

function UTF8ArrayToString(u8Array, idx) {
    var endPtr = idx;
    while (u8Array[endPtr]) ++endPtr;
    if (endPtr - idx > 16 && u8Array.subarray && UTF8Decoder) {
        return UTF8Decoder.decode(u8Array.subarray(idx, endPtr))
    } else {
        var u0, u1, u2, u3, u4, u5;
        var str = "";
        while (1) {
            u0 = u8Array[idx++];
            if (!u0) return str;
            if (!(u0 & 128)) {
                str += String.fromCharCode(u0);
                continue
            }
            u1 = u8Array[idx++] & 63;
            if ((u0 & 224) == 192) {
                str += String.fromCharCode((u0 & 31) << 6 | u1);
                continue
            }
            u2 = u8Array[idx++] & 63;
            if ((u0 & 240) == 224) {
                u0 = (u0 & 15) << 12 | u1 << 6 | u2
            } else {
                u3 = u8Array[idx++] & 63;
                if ((u0 & 248) == 240) {
                    u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | u3
                } else {
                    u4 = u8Array[idx++] & 63;
                    if ((u0 & 252) == 248) {
                        u0 = (u0 & 3) << 24 | u1 << 18 | u2 << 12 | u3 << 6 | u4
                    } else {
                        u5 = u8Array[idx++] & 63;
                        u0 = (u0 & 1) << 30 | u1 << 24 | u2 << 18 | u3 << 12 | u4 << 6 | u5
                    }
                }
            }
            if (u0 < 65536) {
                str += String.fromCharCode(u0)
            } else {
                var ch = u0 - 65536;
                str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023)
            }
        }
    }
}

function UTF8ToString(ptr) {
    return UTF8ArrayToString(HEAPU8, ptr)
}
var UTF16Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-16le") : undefined;
var WASM_PAGE_SIZE = 65536;
var ASMJS_PAGE_SIZE = 16777216;

function alignUp(x, multiple) {
    if (x % multiple > 0) {
        x += multiple - x % multiple
    }
    return x
}
var buffer, HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;

function updateGlobalBuffer(buf) {
    Module["buffer"] = buffer = buf
}

function updateGlobalBufferViews() {
    Module["HEAP8"] = HEAP8 = new Int8Array(buffer);
    Module["HEAP16"] = HEAP16 = new Int16Array(buffer);
    Module["HEAP32"] = HEAP32 = new Int32Array(buffer);
    Module["HEAPU8"] = HEAPU8 = new Uint8Array(buffer);
    Module["HEAPU16"] = HEAPU16 = new Uint16Array(buffer);
    Module["HEAPU32"] = HEAPU32 = new Uint32Array(buffer);
    Module["HEAPF32"] = HEAPF32 = new Float32Array(buffer);
    Module["HEAPF64"] = HEAPF64 = new Float64Array(buffer)
}
var STATIC_BASE, STATICTOP, staticSealed;
var STACK_BASE, STACKTOP, STACK_MAX;
var DYNAMIC_BASE, DYNAMICTOP_PTR;
STATIC_BASE = STATICTOP = STACK_BASE = STACKTOP = STACK_MAX = DYNAMIC_BASE = DYNAMICTOP_PTR = 0;
staticSealed = false;

function abortOnCannotGrowMemory() {
    abort("Cannot enlarge memory arrays. Either (1) compile with  -s TOTAL_MEMORY=X  with X higher than the current value " + TOTAL_MEMORY + ", (2) compile with  -s ALLOW_MEMORY_GROWTH=1  which allows increasing the size at runtime, or (3) if you want malloc to return NULL (0) instead of this abort, compile with  -s ABORTING_MALLOC=0 ")
}

function enlargeMemory() {
    abortOnCannotGrowMemory()
}
var TOTAL_STACK = Module["TOTAL_STACK"] || 5242880;
var TOTAL_MEMORY = Module["TOTAL_MEMORY"] || 16777216;
if (TOTAL_MEMORY < TOTAL_STACK) Module.printErr("TOTAL_MEMORY should be larger than TOTAL_STACK, was " + TOTAL_MEMORY + "! (TOTAL_STACK=" + TOTAL_STACK + ")");
if (Module["buffer"]) {
    buffer = Module["buffer"]
} else {
    if (typeof WebAssembly === "object" && typeof WebAssembly.Memory === "function") {
        Module["wasmMemory"] = new WebAssembly.Memory({
            "initial": TOTAL_MEMORY / WASM_PAGE_SIZE,
            "maximum": TOTAL_MEMORY / WASM_PAGE_SIZE
        });
        buffer = Module["wasmMemory"].buffer
    } else {
        buffer = new ArrayBuffer(TOTAL_MEMORY)
    }
    Module["buffer"] = buffer
}
updateGlobalBufferViews();

function getTotalMemory() {
    return TOTAL_MEMORY
}
HEAP32[0] = 1668509029;
HEAP16[1] = 25459;
if (HEAPU8[2] !== 115 || HEAPU8[3] !== 99) throw "Runtime error: expected the system to be little-endian!";

function callRuntimeCallbacks(callbacks) {
    while (callbacks.length > 0) {
        var callback = callbacks.shift();
        if (typeof callback == "function") {
            callback();
            continue
        }
        var func = callback.func;
        if (typeof func === "number") {
            if (callback.arg === undefined) {
                Module["dynCall_v"](func)
            } else {
                Module["dynCall_vi"](func, callback.arg)
            }
        } else {
            func(callback.arg === undefined ? null : callback.arg)
        }
    }
}
var __ATPRERUN__ = [];
var __ATINIT__ = [];
var __ATMAIN__ = [];
var __ATEXIT__ = [];
var __ATPOSTRUN__ = [];
var runtimeInitialized = false;
var runtimeExited = false;

function preRun() {
    if (Module["preRun"]) {
        if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
        while (Module["preRun"].length) {
            addOnPreRun(Module["preRun"].shift())
        }
    }
    callRuntimeCallbacks(__ATPRERUN__)
}

function ensureInitRuntime() {
    if (runtimeInitialized) return;
    runtimeInitialized = true;
    callRuntimeCallbacks(__ATINIT__)
}

function preMain() {
    callRuntimeCallbacks(__ATMAIN__)
}

function exitRuntime() {
    callRuntimeCallbacks(__ATEXIT__);
    runtimeExited = true
}

function postRun() {
    if (Module["postRun"]) {
        if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
        while (Module["postRun"].length) {
            addOnPostRun(Module["postRun"].shift())
        }
    }
    callRuntimeCallbacks(__ATPOSTRUN__)
}

function addOnPreRun(cb) {
    __ATPRERUN__.unshift(cb)
}

function addOnPostRun(cb) {
    __ATPOSTRUN__.unshift(cb)
}
var Math_abs = Math.abs;
var Math_cos = Math.cos;
var Math_sin = Math.sin;
var Math_tan = Math.tan;
var Math_acos = Math.acos;
var Math_asin = Math.asin;
var Math_atan = Math.atan;
var Math_atan2 = Math.atan2;
var Math_exp = Math.exp;
var Math_log = Math.log;
var Math_sqrt = Math.sqrt;
var Math_ceil = Math.ceil;
var Math_floor = Math.floor;
var Math_pow = Math.pow;
var Math_imul = Math.imul;
var Math_fround = Math.fround;
var Math_round = Math.round;
var Math_min = Math.min;
var Math_max = Math.max;
var Math_clz32 = Math.clz32;
var Math_trunc = Math.trunc;
var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null;

function getUniqueRunDependency(id) {
    return id
}

function addRunDependency(id) {
    runDependencies++;
    if (Module["monitorRunDependencies"]) {
        Module["monitorRunDependencies"](runDependencies)
    }
}

function removeRunDependency(id) {
    runDependencies--;
    if (Module["monitorRunDependencies"]) {
        Module["monitorRunDependencies"](runDependencies)
    }
    if (runDependencies == 0) {
        if (runDependencyWatcher !== null) {
            clearInterval(runDependencyWatcher);
            runDependencyWatcher = null
        }
        if (dependenciesFulfilled) {
            var callback = dependenciesFulfilled;
            dependenciesFulfilled = null;
            callback()
        }
    }
}
Module["preloadedImages"] = {};
Module["preloadedAudios"] = {};
var dataURIPrefix = "data:application/octet-stream;base64,";

function isDataURI(filename) {
    return String.prototype.startsWith ? filename.startsWith(dataURIPrefix) : filename.indexOf(dataURIPrefix) === 0
}

function integrateWasmJS() {
    var wasmTextFile = "nbind.wast";
    var wasmBinaryFile = "nbind.wasm";
    var asmjsCodeFile = "nbind.temp.asm.js";
    if (typeof Module["locateFile"] === "function") {
        if (!isDataURI(wasmTextFile)) {
            wasmTextFile = Module["locateFile"](wasmTextFile)
        }
        if (!isDataURI(wasmBinaryFile)) {
            wasmBinaryFile = Module["locateFile"](wasmBinaryFile)
        }
        if (!isDataURI(asmjsCodeFile)) {
            asmjsCodeFile = Module["locateFile"](asmjsCodeFile)
        }
    }
    var wasmPageSize = 64 * 1024;
    var info = {
        "global": null,
        "env": null,
        "asm2wasm": asm2wasmImports,
        "parent": Module
    };
    var exports = null;

    function mergeMemory(newBuffer) {
        var oldBuffer = Module["buffer"];
        if (newBuffer.byteLength < oldBuffer.byteLength) {
            Module["printErr"]("the new buffer in mergeMemory is smaller than the previous one. in native wasm, we should grow memory here")
        }
        var oldView = new Int8Array(oldBuffer);
        var newView = new Int8Array(newBuffer);
        newView.set(oldView);
        updateGlobalBuffer(newBuffer);
        updateGlobalBufferViews()
    }

    function fixImports(imports) {
        return imports
    }

    function getBinary() {
        try {
            if (Module["wasmBinary"]) {
                return new Uint8Array(Module["wasmBinary"])
            }
            if (Module["readBinary"]) {
                return Module["readBinary"](wasmBinaryFile)
            } else {
                throw "on the web, we need the wasm binary to be preloaded and set on Module['wasmBinary']. emcc.py will do that for you when generating HTML (but not JS)"
            }
        } catch (err) {
            abort(err)
        }
    }

    function getBinaryPromise() {
        if (!Module["wasmBinary"] && (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) && typeof fetch === "function") {
            return fetch(wasmBinaryFile, {
                credentials: "same-origin"
            }).then((function(response) {
                if (!response["ok"]) {
                    throw "failed to load wasm binary file at '" + wasmBinaryFile + "'"
                }
                return response["arrayBuffer"]()
            })).catch((function() {
                return getBinary()
            }))
        }
        return new Promise((function(resolve, reject) {
            resolve(getBinary())
        }))
    }

    function doNativeWasm(global, env, providedBuffer) {
        if (typeof WebAssembly !== "object") {
            Module["printErr"]("no native wasm support detected");
            return false
        }
        if (!(Module["wasmMemory"] instanceof WebAssembly.Memory)) {
            Module["printErr"]("no native wasm Memory in use");
            return false
        }
        env["memory"] = Module["wasmMemory"];
        info["global"] = {
            "NaN": NaN,
            "Infinity": Infinity
        };
        info["global.Math"] = Math;
        info["env"] = env;

        function receiveInstance(instance, module) {
            exports = instance.exports;
            if (exports.memory) mergeMemory(exports.memory);
            Module["asm"] = exports;
            Module["usingWasm"] = true;
            removeRunDependency("wasm-instantiate")
        }
        addRunDependency("wasm-instantiate");
        if (Module["instantiateWasm"]) {
            try {
                return Module["instantiateWasm"](info, receiveInstance)
            } catch (e) {
                Module["printErr"]("Module.instantiateWasm callback failed with error: " + e);
                return false
            }
        }

        function receiveInstantiatedSource(output) {
            receiveInstance(output["instance"], output["module"])
        }

        function instantiateArrayBuffer(receiver) {
            getBinaryPromise().then((function(binary) {
                return WebAssembly.instantiate(binary, info)
            })).then(receiver).catch((function(reason) {
                Module["printErr"]("failed to asynchronously prepare wasm: " + reason);
                abort(reason)
            }))
        }
        if (!Module["wasmBinary"] && typeof WebAssembly.instantiateStreaming === "function" && !isDataURI(wasmBinaryFile) && typeof fetch === "function") {
            WebAssembly.instantiateStreaming(fetch(wasmBinaryFile, {
                credentials: "same-origin"
            }), info).then(receiveInstantiatedSource).catch((function(reason) {
                Module["printErr"]("wasm streaming compile failed: " + reason);
                Module["printErr"]("falling back to ArrayBuffer instantiation");
                instantiateArrayBuffer(receiveInstantiatedSource)
            }))
        } else {
            instantiateArrayBuffer(receiveInstantiatedSource)
        }
        return {}
    }
    Module["asmPreload"] = Module["asm"];
    var asmjsReallocBuffer = Module["reallocBuffer"];
    var wasmReallocBuffer = (function(size) {
        var PAGE_MULTIPLE = Module["usingWasm"] ? WASM_PAGE_SIZE : ASMJS_PAGE_SIZE;
        size = alignUp(size, PAGE_MULTIPLE);
        var old = Module["buffer"];
        var oldSize = old.byteLength;
        if (Module["usingWasm"]) {
            try {
                var result = Module["wasmMemory"].grow((size - oldSize) / wasmPageSize);
                if (result !== (-1 | 0)) {
                    return Module["buffer"] = Module["wasmMemory"].buffer
                } else {
                    return null
                }
            } catch (e) {
                return null
            }
        }
    });
    Module["reallocBuffer"] = (function(size) {
        if (finalMethod === "asmjs") {
            return asmjsReallocBuffer(size)
        } else {
            return wasmReallocBuffer(size)
        }
    });
    var finalMethod = "";
    Module["asm"] = (function(global, env, providedBuffer) {
        env = fixImports(env);
        if (!env["table"]) {
            var TABLE_SIZE = Module["wasmTableSize"];
            if (TABLE_SIZE === undefined) TABLE_SIZE = 1024;
            var MAX_TABLE_SIZE = Module["wasmMaxTableSize"];
            if (typeof WebAssembly === "object" && typeof WebAssembly.Table === "function") {
                if (MAX_TABLE_SIZE !== undefined) {
                    env["table"] = new WebAssembly.Table({
                        "initial": TABLE_SIZE,
                        "maximum": MAX_TABLE_SIZE,
                        "element": "anyfunc"
                    })
                } else {
                    env["table"] = new WebAssembly.Table({
                        "initial": TABLE_SIZE,
                        element: "anyfunc"
                    })
                }
            } else {
                env["table"] = new Array(TABLE_SIZE)
            }
            Module["wasmTable"] = env["table"]
        }
        if (!env["memoryBase"]) {
            env["memoryBase"] = Module["STATIC_BASE"]
        }
        if (!env["tableBase"]) {
            env["tableBase"] = 0
        }
        var exports;
        exports = doNativeWasm(global, env, providedBuffer);
        assert(exports, "no binaryen method succeeded.");
        return exports
    })
}
integrateWasmJS();
var ASM_CONSTS = [(function($0, $1, $2) {
    _nbind.commitBuffer($0, $1, $2)
}), (function($0, $1, $2, $3, $4, $5, $6) {
    return _nbind.callbackSignatureList[$0].apply(this, arguments)
})];

function _emscripten_asm_const_iiii(code, a0, a1, a2) {
    return ASM_CONSTS[code](a0, a1, a2)
}

function _emscripten_asm_const_iiiii(code, a0, a1, a2, a3) {
    return ASM_CONSTS[code](a0, a1, a2, a3)
}

function _emscripten_asm_const_iiiiii(code, a0, a1, a2, a3, a4) {
    return ASM_CONSTS[code](a0, a1, a2, a3, a4)
}

function _emscripten_asm_const_iiiiiiii(code, a0, a1, a2, a3, a4, a5, a6) {
    return ASM_CONSTS[code](a0, a1, a2, a3, a4, a5, a6)
}
STATIC_BASE = GLOBAL_BASE;
STATICTOP = STATIC_BASE + 6672;
__ATINIT__.push({
    func: (function() {
        __GLOBAL__sub_I_fpzip_interface_cpp()
    })
}, {
    func: (function() {
        __GLOBAL__sub_I_common_cc()
    })
}, {
    func: (function() {
        __GLOBAL__sub_I_Binding_cc()
    })
});
var STATIC_BUMP = 6672;
Module["STATIC_BASE"] = STATIC_BASE;
Module["STATIC_BUMP"] = STATIC_BUMP;
STATICTOP += 16;

function _emscripten_set_main_loop_timing(mode, value) {
    Browser.mainLoop.timingMode = mode;
    Browser.mainLoop.timingValue = value;
    if (!Browser.mainLoop.func) {
        return 1
    }
    if (mode == 0) {
        Browser.mainLoop.scheduler = function Browser_mainLoop_scheduler_setTimeout() {
            var timeUntilNextTick = Math.max(0, Browser.mainLoop.tickStartTime + value - _emscripten_get_now()) | 0;
            setTimeout(Browser.mainLoop.runner, timeUntilNextTick)
        };
        Browser.mainLoop.method = "timeout"
    } else if (mode == 1) {
        Browser.mainLoop.scheduler = function Browser_mainLoop_scheduler_rAF() {
            Browser.requestAnimationFrame(Browser.mainLoop.runner)
        };
        Browser.mainLoop.method = "rAF"
    } else if (mode == 2) {
        if (typeof setImmediate === "undefined") {
            var setImmediates = [];
            var emscriptenMainLoopMessageId = "setimmediate";

            function Browser_setImmediate_messageHandler(event) {
                if (event.data === emscriptenMainLoopMessageId || event.data.target === emscriptenMainLoopMessageId) {
                    event.stopPropagation();
                    setImmediates.shift()()
                }
            }
            addEventListener("message", Browser_setImmediate_messageHandler, true);
            setImmediate = function Browser_emulated_setImmediate(func) {
                setImmediates.push(func);
                if (ENVIRONMENT_IS_WORKER) {
                    if (Module["setImmediates"] === undefined) Module["setImmediates"] = [];
                    Module["setImmediates"].push(func);
                    postMessage({
                        target: emscriptenMainLoopMessageId
                    })
                } else postMessage(emscriptenMainLoopMessageId, "*")
            }
        }
        Browser.mainLoop.scheduler = function Browser_mainLoop_scheduler_setImmediate() {
            setImmediate(Browser.mainLoop.runner)
        };
        Browser.mainLoop.method = "immediate"
    }
    return 0
}

function _emscripten_get_now() {
    abort()
}

function _emscripten_set_main_loop(func, fps, simulateInfiniteLoop, arg, noSetTiming) {
    Module["noExitRuntime"] = true;
    assert(!Browser.mainLoop.func, "emscripten_set_main_loop: there can only be one main loop function at once: call emscripten_cancel_main_loop to cancel the previous one before setting a new one with different parameters.");
    Browser.mainLoop.func = func;
    Browser.mainLoop.arg = arg;
    var browserIterationFunc;
    if (typeof arg !== "undefined") {
        browserIterationFunc = (function() {
            Module["dynCall_vi"](func, arg)
        })
    } else {
        browserIterationFunc = (function() {
            Module["dynCall_v"](func)
        })
    }
    var thisMainLoopId = Browser.mainLoop.currentlyRunningMainloop;
    Browser.mainLoop.runner = function Browser_mainLoop_runner() {
        if (ABORT) return;
        if (Browser.mainLoop.queue.length > 0) {
            var start = Date.now();
            var blocker = Browser.mainLoop.queue.shift();
            blocker.func(blocker.arg);
            if (Browser.mainLoop.remainingBlockers) {
                var remaining = Browser.mainLoop.remainingBlockers;
                var next = remaining % 1 == 0 ? remaining - 1 : Math.floor(remaining);
                if (blocker.counted) {
                    Browser.mainLoop.remainingBlockers = next
                } else {
                    next = next + .5;
                    Browser.mainLoop.remainingBlockers = (8 * remaining + next) / 9
                }
            }
            console.log('main loop blocker "' + blocker.name + '" took ' + (Date.now() - start) + " ms");
            Browser.mainLoop.updateStatus();
            if (thisMainLoopId < Browser.mainLoop.currentlyRunningMainloop) return;
            setTimeout(Browser.mainLoop.runner, 0);
            return
        }
        if (thisMainLoopId < Browser.mainLoop.currentlyRunningMainloop) return;
        Browser.mainLoop.currentFrameNumber = Browser.mainLoop.currentFrameNumber + 1 | 0;
        if (Browser.mainLoop.timingMode == 1 && Browser.mainLoop.timingValue > 1 && Browser.mainLoop.currentFrameNumber % Browser.mainLoop.timingValue != 0) {
            Browser.mainLoop.scheduler();
            return
        } else if (Browser.mainLoop.timingMode == 0) {
            Browser.mainLoop.tickStartTime = _emscripten_get_now()
        }
        if (Browser.mainLoop.method === "timeout" && Module.ctx) {
            Module.printErr("Looks like you are rendering without using requestAnimationFrame for the main loop. You should use 0 for the frame rate in emscripten_set_main_loop in order to use requestAnimationFrame, as that can greatly improve your frame rates!");
            Browser.mainLoop.method = ""
        }
        Browser.mainLoop.runIter(browserIterationFunc);
        if (thisMainLoopId < Browser.mainLoop.currentlyRunningMainloop) return;
        if (typeof SDL === "object" && SDL.audio && SDL.audio.queueNewAudioData) SDL.audio.queueNewAudioData();
        Browser.mainLoop.scheduler()
    };
    if (!noSetTiming) {
        if (fps && fps > 0) _emscripten_set_main_loop_timing(0, 1e3 / fps);
        else _emscripten_set_main_loop_timing(1, 1);
        Browser.mainLoop.scheduler()
    }
    if (simulateInfiniteLoop) {
        throw "SimulateInfiniteLoop"
    }
}
var Browser = {
    mainLoop: {
        scheduler: null,
        method: "",
        currentlyRunningMainloop: 0,
        func: null,
        arg: 0,
        timingMode: 0,
        timingValue: 0,
        currentFrameNumber: 0,
        queue: [],
        pause: (function() {
            Browser.mainLoop.scheduler = null;
            Browser.mainLoop.currentlyRunningMainloop++
        }),
        resume: (function() {
            Browser.mainLoop.currentlyRunningMainloop++;
            var timingMode = Browser.mainLoop.timingMode;
            var timingValue = Browser.mainLoop.timingValue;
            var func = Browser.mainLoop.func;
            Browser.mainLoop.func = null;
            _emscripten_set_main_loop(func, 0, false, Browser.mainLoop.arg, true);
            _emscripten_set_main_loop_timing(timingMode, timingValue);
            Browser.mainLoop.scheduler()
        }),
        updateStatus: (function() {
            if (Module["setStatus"]) {
                var message = Module["statusMessage"] || "Please wait...";
                var remaining = Browser.mainLoop.remainingBlockers;
                var expected = Browser.mainLoop.expectedBlockers;
                if (remaining) {
                    if (remaining < expected) {
                        Module["setStatus"](message + " (" + (expected - remaining) + "/" + expected + ")")
                    } else {
                        Module["setStatus"](message)
                    }
                } else {
                    Module["setStatus"]("")
                }
            }
        }),
        runIter: (function(func) {
            if (ABORT) return;
            if (Module["preMainLoop"]) {
                var preRet = Module["preMainLoop"]();
                if (preRet === false) {
                    return
                }
            }
            try {
                func()
            } catch (e) {
                if (e instanceof ExitStatus) {
                    return
                } else {
                    if (e && typeof e === "object" && e.stack) Module.printErr("exception thrown: " + [e, e.stack]);
                    throw e
                }
            }
            if (Module["postMainLoop"]) Module["postMainLoop"]()
        })
    },
    isFullscreen: false,
    pointerLock: false,
    moduleContextCreatedCallbacks: [],
    workers: [],
    init: (function() {
        if (!Module["preloadPlugins"]) Module["preloadPlugins"] = [];
        if (Browser.initted) return;
        Browser.initted = true;
        try {
            new Blob;
            Browser.hasBlobConstructor = true
        } catch (e) {
            Browser.hasBlobConstructor = false;
            console.log("warning: no blob constructor, cannot create blobs with mimetypes")
        }
        Browser.BlobBuilder = typeof MozBlobBuilder != "undefined" ? MozBlobBuilder : typeof WebKitBlobBuilder != "undefined" ? WebKitBlobBuilder : !Browser.hasBlobConstructor ? console.log("warning: no BlobBuilder") : null;
        Browser.URLObject = typeof window != "undefined" ? window.URL ? window.URL : window.webkitURL : undefined;
        if (!Module.noImageDecoding && typeof Browser.URLObject === "undefined") {
            console.log("warning: Browser does not support creating object URLs. Built-in browser image decoding will not be available.");
            Module.noImageDecoding = true
        }
        var imagePlugin = {};
        imagePlugin["canHandle"] = function imagePlugin_canHandle(name) {
            return !Module.noImageDecoding && /\.(jpg|jpeg|png|bmp)$/i.test(name)
        };
        imagePlugin["handle"] = function imagePlugin_handle(byteArray, name, onload, onerror) {
            var b = null;
            if (Browser.hasBlobConstructor) {
                try {
                    b = new Blob([byteArray], {
                        type: Browser.getMimetype(name)
                    });
                    if (b.size !== byteArray.length) {
                        b = new Blob([(new Uint8Array(byteArray)).buffer], {
                            type: Browser.getMimetype(name)
                        })
                    }
                } catch (e) {
                    warnOnce("Blob constructor present but fails: " + e + "; falling back to blob builder")
                }
            }
            if (!b) {
                var bb = new Browser.BlobBuilder;
                bb.append((new Uint8Array(byteArray)).buffer);
                b = bb.getBlob()
            }
            var url = Browser.URLObject.createObjectURL(b);
            var img = new Image;
            img.onload = function img_onload() {
                assert(img.complete, "Image " + name + " could not be decoded");
                var canvas = document.createElement("canvas");
                canvas.width = img.width;
                canvas.height = img.height;
                var ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0);
                Module["preloadedImages"][name] = canvas;
                Browser.URLObject.revokeObjectURL(url);
                if (onload) onload(byteArray)
            };
            img.onerror = function img_onerror(event) {
                console.log("Image " + url + " could not be decoded");
                if (onerror) onerror()
            };
            img.src = url
        };
        Module["preloadPlugins"].push(imagePlugin);
        var audioPlugin = {};
        audioPlugin["canHandle"] = function audioPlugin_canHandle(name) {
            return !Module.noAudioDecoding && name.substr(-4) in {
                ".ogg": 1,
                ".wav": 1,
                ".mp3": 1
            }
        };
        audioPlugin["handle"] = function audioPlugin_handle(byteArray, name, onload, onerror) {
            var done = false;

            function finish(audio) {
                if (done) return;
                done = true;
                Module["preloadedAudios"][name] = audio;
                if (onload) onload(byteArray)
            }

            function fail() {
                if (done) return;
                done = true;
                Module["preloadedAudios"][name] = new Audio;
                if (onerror) onerror()
            }
            if (Browser.hasBlobConstructor) {
                try {
                    var b = new Blob([byteArray], {
                        type: Browser.getMimetype(name)
                    })
                } catch (e) {
                    return fail()
                }
                var url = Browser.URLObject.createObjectURL(b);
                var audio = new Audio;
                audio.addEventListener("canplaythrough", (function() {
                    finish(audio)
                }), false);
                audio.onerror = function audio_onerror(event) {
                    if (done) return;
                    console.log("warning: browser could not fully decode audio " + name + ", trying slower base64 approach");

                    function encode64(data) {
                        var BASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                        var PAD = "=";
                        var ret = "";
                        var leftchar = 0;
                        var leftbits = 0;
                        for (var i = 0; i < data.length; i++) {
                            leftchar = leftchar << 8 | data[i];
                            leftbits += 8;
                            while (leftbits >= 6) {
                                var curr = leftchar >> leftbits - 6 & 63;
                                leftbits -= 6;
                                ret += BASE[curr]
                            }
                        }
                        if (leftbits == 2) {
                            ret += BASE[(leftchar & 3) << 4];
                            ret += PAD + PAD
                        } else if (leftbits == 4) {
                            ret += BASE[(leftchar & 15) << 2];
                            ret += PAD
                        }
                        return ret
                    }
                    audio.src = "data:audio/x-" + name.substr(-3) + ";base64," + encode64(byteArray);
                    finish(audio)
                };
                audio.src = url;
                Browser.safeSetTimeout((function() {
                    finish(audio)
                }), 1e4)
            } else {
                return fail()
            }
        };
        Module["preloadPlugins"].push(audioPlugin);

        function pointerLockChange() {
            Browser.pointerLock = document["pointerLockElement"] === Module["canvas"] || document["mozPointerLockElement"] === Module["canvas"] || document["webkitPointerLockElement"] === Module["canvas"] || document["msPointerLockElement"] === Module["canvas"]
        }
        var canvas = Module["canvas"];
        if (canvas) {
            canvas.requestPointerLock = canvas["requestPointerLock"] || canvas["mozRequestPointerLock"] || canvas["webkitRequestPointerLock"] || canvas["msRequestPointerLock"] || (function() {});
            canvas.exitPointerLock = document["exitPointerLock"] || document["mozExitPointerLock"] || document["webkitExitPointerLock"] || document["msExitPointerLock"] || (function() {});
            canvas.exitPointerLock = canvas.exitPointerLock.bind(document);
            document.addEventListener("pointerlockchange", pointerLockChange, false);
            document.addEventListener("mozpointerlockchange", pointerLockChange, false);
            document.addEventListener("webkitpointerlockchange", pointerLockChange, false);
            document.addEventListener("mspointerlockchange", pointerLockChange, false);
            if (Module["elementPointerLock"]) {
                canvas.addEventListener("click", (function(ev) {
                    if (!Browser.pointerLock && Module["canvas"].requestPointerLock) {
                        Module["canvas"].requestPointerLock();
                        ev.preventDefault()
                    }
                }), false)
            }
        }
    }),
    createContext: (function(canvas, useWebGL, setInModule, webGLContextAttributes) {
        if (useWebGL && Module.ctx && canvas == Module.canvas) return Module.ctx;
        var ctx;
        var contextHandle;
        if (useWebGL) {
            var contextAttributes = {
                antialias: false,
                alpha: false
            };
            if (webGLContextAttributes) {
                for (var attribute in webGLContextAttributes) {
                    contextAttributes[attribute] = webGLContextAttributes[attribute]
                }
            }
            contextHandle = GL.createContext(canvas, contextAttributes);
            if (contextHandle) {
                ctx = GL.getContext(contextHandle).GLctx
            }
        } else {
            ctx = canvas.getContext("2d")
        }
        if (!ctx) return null;
        if (setInModule) {
            if (!useWebGL) assert(typeof GLctx === "undefined", "cannot set in module if GLctx is used, but we are a non-GL context that would replace it");
            Module.ctx = ctx;
            if (useWebGL) GL.makeContextCurrent(contextHandle);
            Module.useWebGL = useWebGL;
            Browser.moduleContextCreatedCallbacks.forEach((function(callback) {
                callback()
            }));
            Browser.init()
        }
        return ctx
    }),
    destroyContext: (function(canvas, useWebGL, setInModule) {}),
    fullscreenHandlersInstalled: false,
    lockPointer: undefined,
    resizeCanvas: undefined,
    requestFullscreen: (function(lockPointer, resizeCanvas, vrDevice) {
        Browser.lockPointer = lockPointer;
        Browser.resizeCanvas = resizeCanvas;
        Browser.vrDevice = vrDevice;
        if (typeof Browser.lockPointer === "undefined") Browser.lockPointer = true;
        if (typeof Browser.resizeCanvas === "undefined") Browser.resizeCanvas = false;
        if (typeof Browser.vrDevice === "undefined") Browser.vrDevice = null;
        var canvas = Module["canvas"];

        function fullscreenChange() {
            Browser.isFullscreen = false;
            var canvasContainer = canvas.parentNode;
            if ((document["fullscreenElement"] || document["mozFullScreenElement"] || document["msFullscreenElement"] || document["webkitFullscreenElement"] || document["webkitCurrentFullScreenElement"]) === canvasContainer) {
                canvas.exitFullscreen = document["exitFullscreen"] || document["cancelFullScreen"] || document["mozCancelFullScreen"] || document["msExitFullscreen"] || document["webkitCancelFullScreen"] || (function() {});
                canvas.exitFullscreen = canvas.exitFullscreen.bind(document);
                if (Browser.lockPointer) canvas.requestPointerLock();
                Browser.isFullscreen = true;
                if (Browser.resizeCanvas) {
                    Browser.setFullscreenCanvasSize()
                } else {
                    Browser.updateCanvasDimensions(canvas)
                }
            } else {
                canvasContainer.parentNode.insertBefore(canvas, canvasContainer);
                canvasContainer.parentNode.removeChild(canvasContainer);
                if (Browser.resizeCanvas) {
                    Browser.setWindowedCanvasSize()
                } else {
                    Browser.updateCanvasDimensions(canvas)
                }
            }
            if (Module["onFullScreen"]) Module["onFullScreen"](Browser.isFullscreen);
            if (Module["onFullscreen"]) Module["onFullscreen"](Browser.isFullscreen)
        }
        if (!Browser.fullscreenHandlersInstalled) {
            Browser.fullscreenHandlersInstalled = true;
            document.addEventListener("fullscreenchange", fullscreenChange, false);
            document.addEventListener("mozfullscreenchange", fullscreenChange, false);
            document.addEventListener("webkitfullscreenchange", fullscreenChange, false);
            document.addEventListener("MSFullscreenChange", fullscreenChange, false)
        }
        var canvasContainer = document.createElement("div");
        canvas.parentNode.insertBefore(canvasContainer, canvas);
        canvasContainer.appendChild(canvas);
        canvasContainer.requestFullscreen = canvasContainer["requestFullscreen"] || canvasContainer["mozRequestFullScreen"] || canvasContainer["msRequestFullscreen"] || (canvasContainer["webkitRequestFullscreen"] ? (function() {
            canvasContainer["webkitRequestFullscreen"](Element["ALLOW_KEYBOARD_INPUT"])
        }) : null) || (canvasContainer["webkitRequestFullScreen"] ? (function() {
            canvasContainer["webkitRequestFullScreen"](Element["ALLOW_KEYBOARD_INPUT"])
        }) : null);
        if (vrDevice) {
            canvasContainer.requestFullscreen({
                vrDisplay: vrDevice
            })
        } else {
            canvasContainer.requestFullscreen()
        }
    }),
    requestFullScreen: (function(lockPointer, resizeCanvas, vrDevice) {
        Module.printErr("Browser.requestFullScreen() is deprecated. Please call Browser.requestFullscreen instead.");
        Browser.requestFullScreen = (function(lockPointer, resizeCanvas, vrDevice) {
            return Browser.requestFullscreen(lockPointer, resizeCanvas, vrDevice)
        });
        return Browser.requestFullscreen(lockPointer, resizeCanvas, vrDevice)
    }),
    nextRAF: 0,
    fakeRequestAnimationFrame: (function(func) {
        var now = Date.now();
        if (Browser.nextRAF === 0) {
            Browser.nextRAF = now + 1e3 / 60
        } else {
            while (now + 2 >= Browser.nextRAF) {
                Browser.nextRAF += 1e3 / 60
            }
        }
        var delay = Math.max(Browser.nextRAF - now, 0);
        setTimeout(func, delay)
    }),
    requestAnimationFrame: function requestAnimationFrame(func) {
        if (typeof window === "undefined") {
            Browser.fakeRequestAnimationFrame(func)
        } else {
            if (!window.requestAnimationFrame) {
                window.requestAnimationFrame = window["requestAnimationFrame"] || window["mozRequestAnimationFrame"] || window["webkitRequestAnimationFrame"] || window["msRequestAnimationFrame"] || window["oRequestAnimationFrame"] || Browser.fakeRequestAnimationFrame
            }
            window.requestAnimationFrame(func)
        }
    },
    safeCallback: (function(func) {
        return (function() {
            if (!ABORT) return func.apply(null, arguments)
        })
    }),
    allowAsyncCallbacks: true,
    queuedAsyncCallbacks: [],
    pauseAsyncCallbacks: (function() {
        Browser.allowAsyncCallbacks = false
    }),
    resumeAsyncCallbacks: (function() {
        Browser.allowAsyncCallbacks = true;
        if (Browser.queuedAsyncCallbacks.length > 0) {
            var callbacks = Browser.queuedAsyncCallbacks;
            Browser.queuedAsyncCallbacks = [];
            callbacks.forEach((function(func) {
                func()
            }))
        }
    }),
    safeRequestAnimationFrame: (function(func) {
        return Browser.requestAnimationFrame((function() {
            if (ABORT) return;
            if (Browser.allowAsyncCallbacks) {
                func()
            } else {
                Browser.queuedAsyncCallbacks.push(func)
            }
        }))
    }),
    safeSetTimeout: (function(func, timeout) {
        Module["noExitRuntime"] = true;
        return setTimeout((function() {
            if (ABORT) return;
            if (Browser.allowAsyncCallbacks) {
                func()
            } else {
                Browser.queuedAsyncCallbacks.push(func)
            }
        }), timeout)
    }),
    safeSetInterval: (function(func, timeout) {
        Module["noExitRuntime"] = true;
        return setInterval((function() {
            if (ABORT) return;
            if (Browser.allowAsyncCallbacks) {
                func()
            }
        }), timeout)
    }),
    getMimetype: (function(name) {
        return {
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "png": "image/png",
            "bmp": "image/bmp",
            "ogg": "audio/ogg",
            "wav": "audio/wav",
            "mp3": "audio/mpeg"
        }[name.substr(name.lastIndexOf(".") + 1)]
    }),
    getUserMedia: (function(func) {
        if (!window.getUserMedia) {
            window.getUserMedia = navigator["getUserMedia"] || navigator["mozGetUserMedia"]
        }
        window.getUserMedia(func)
    }),
    getMovementX: (function(event) {
        return event["movementX"] || event["mozMovementX"] || event["webkitMovementX"] || 0
    }),
    getMovementY: (function(event) {
        return event["movementY"] || event["mozMovementY"] || event["webkitMovementY"] || 0
    }),
    getMouseWheelDelta: (function(event) {
        var delta = 0;
        switch (event.type) {
            case "DOMMouseScroll":
                delta = event.detail;
                break;
            case "mousewheel":
                delta = event.wheelDelta;
                break;
            case "wheel":
                delta = event["deltaY"];
                break;
            default:
                throw "unrecognized mouse wheel event: " + event.type
        }
        return delta
    }),
    mouseX: 0,
    mouseY: 0,
    mouseMovementX: 0,
    mouseMovementY: 0,
    touches: {},
    lastTouches: {},
    calculateMouseEvent: (function(event) {
        if (Browser.pointerLock) {
            if (event.type != "mousemove" && "mozMovementX" in event) {
                Browser.mouseMovementX = Browser.mouseMovementY = 0
            } else {
                Browser.mouseMovementX = Browser.getMovementX(event);
                Browser.mouseMovementY = Browser.getMovementY(event)
            }
            if (typeof SDL != "undefined") {
                Browser.mouseX = SDL.mouseX + Browser.mouseMovementX;
                Browser.mouseY = SDL.mouseY + Browser.mouseMovementY
            } else {
                Browser.mouseX += Browser.mouseMovementX;
                Browser.mouseY += Browser.mouseMovementY
            }
        } else {
            var rect = Module["canvas"].getBoundingClientRect();
            var cw = Module["canvas"].width;
            var ch = Module["canvas"].height;
            var scrollX = typeof window.scrollX !== "undefined" ? window.scrollX : window.pageXOffset;
            var scrollY = typeof window.scrollY !== "undefined" ? window.scrollY : window.pageYOffset;
            if (event.type === "touchstart" || event.type === "touchend" || event.type === "touchmove") {
                var touch = event.touch;
                if (touch === undefined) {
                    return
                }
                var adjustedX = touch.pageX - (scrollX + rect.left);
                var adjustedY = touch.pageY - (scrollY + rect.top);
                adjustedX = adjustedX * (cw / rect.width);
                adjustedY = adjustedY * (ch / rect.height);
                var coords = {
                    x: adjustedX,
                    y: adjustedY
                };
                if (event.type === "touchstart") {
                    Browser.lastTouches[touch.identifier] = coords;
                    Browser.touches[touch.identifier] = coords
                } else if (event.type === "touchend" || event.type === "touchmove") {
                    var last = Browser.touches[touch.identifier];
                    if (!last) last = coords;
                    Browser.lastTouches[touch.identifier] = last;
                    Browser.touches[touch.identifier] = coords
                }
                return
            }
            var x = event.pageX - (scrollX + rect.left);
            var y = event.pageY - (scrollY + rect.top);
            x = x * (cw / rect.width);
            y = y * (ch / rect.height);
            Browser.mouseMovementX = x - Browser.mouseX;
            Browser.mouseMovementY = y - Browser.mouseY;
            Browser.mouseX = x;
            Browser.mouseY = y
        }
    }),
    asyncLoad: (function(url, onload, onerror, noRunDep) {
        var dep = !noRunDep ? getUniqueRunDependency("al " + url) : "";
        Module["readAsync"](url, (function(arrayBuffer) {
            assert(arrayBuffer, 'Loading data file "' + url + '" failed (no arrayBuffer).');
            onload(new Uint8Array(arrayBuffer));
            if (dep) removeRunDependency(dep)
        }), (function(event) {
            if (onerror) {
                onerror()
            } else {
                throw 'Loading data file "' + url + '" failed.'
            }
        }));
        if (dep) addRunDependency(dep)
    }),
    resizeListeners: [],
    updateResizeListeners: (function() {
        var canvas = Module["canvas"];
        Browser.resizeListeners.forEach((function(listener) {
            listener(canvas.width, canvas.height)
        }))
    }),
    setCanvasSize: (function(width, height, noUpdates) {
        var canvas = Module["canvas"];
        Browser.updateCanvasDimensions(canvas, width, height);
        if (!noUpdates) Browser.updateResizeListeners()
    }),
    windowedWidth: 0,
    windowedHeight: 0,
    setFullscreenCanvasSize: (function() {
        if (typeof SDL != "undefined") {
            var flags = HEAPU32[SDL.screen >> 2];
            flags = flags | 8388608;
            HEAP32[SDL.screen >> 2] = flags
        }
        Browser.updateCanvasDimensions(Module["canvas"]);
        Browser.updateResizeListeners()
    }),
    setWindowedCanvasSize: (function() {
        if (typeof SDL != "undefined") {
            var flags = HEAPU32[SDL.screen >> 2];
            flags = flags & ~8388608;
            HEAP32[SDL.screen >> 2] = flags
        }
        Browser.updateCanvasDimensions(Module["canvas"]);
        Browser.updateResizeListeners()
    }),
    updateCanvasDimensions: (function(canvas, wNative, hNative) {
        if (wNative && hNative) {
            canvas.widthNative = wNative;
            canvas.heightNative = hNative
        } else {
            wNative = canvas.widthNative;
            hNative = canvas.heightNative
        }
        var w = wNative;
        var h = hNative;
        if (Module["forcedAspectRatio"] && Module["forcedAspectRatio"] > 0) {
            if (w / h < Module["forcedAspectRatio"]) {
                w = Math.round(h * Module["forcedAspectRatio"])
            } else {
                h = Math.round(w / Module["forcedAspectRatio"])
            }
        }
        if ((document["fullscreenElement"] || document["mozFullScreenElement"] || document["msFullscreenElement"] || document["webkitFullscreenElement"] || document["webkitCurrentFullScreenElement"]) === canvas.parentNode && typeof screen != "undefined") {
            var factor = Math.min(screen.width / w, screen.height / h);
            w = Math.round(w * factor);
            h = Math.round(h * factor)
        }
        if (Browser.resizeCanvas) {
            if (canvas.width != w) canvas.width = w;
            if (canvas.height != h) canvas.height = h;
            if (typeof canvas.style != "undefined") {
                canvas.style.removeProperty("width");
                canvas.style.removeProperty("height")
            }
        } else {
            if (canvas.width != wNative) canvas.width = wNative;
            if (canvas.height != hNative) canvas.height = hNative;
            if (typeof canvas.style != "undefined") {
                if (w != wNative || h != hNative) {
                    canvas.style.setProperty("width", w + "px", "important");
                    canvas.style.setProperty("height", h + "px", "important")
                } else {
                    canvas.style.removeProperty("width");
                    canvas.style.removeProperty("height")
                }
            }
        }
    }),
    wgetRequests: {},
    nextWgetRequestHandle: 0,
    getNextWgetRequestHandle: (function() {
        var handle = Browser.nextWgetRequestHandle;
        Browser.nextWgetRequestHandle++;
        return handle
    })
};

function ___assert_fail(condition, filename, line, func) {
    abort("Assertion failed: " + Pointer_stringify(condition) + ", at: " + [filename ? Pointer_stringify(filename) : "unknown filename", line, func ? Pointer_stringify(func) : "unknown function"])
}

function __decorate(decorators, target, key, desc) {
    var c = arguments.length,
        r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc,
        d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else
        for (var i = decorators.length - 1; i >= 0; i--)
            if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r
}

function _defineHidden(value) {
    return (function(target, key) {
        Object.defineProperty(target, key, {
            configurable: false,
            enumerable: false,
            value: value,
            writable: true
        })
    })
}
var _nbind = {};

function __nbind_finish() {
    for (var _i = 0, _a = _nbind.BindClass.list; _i < _a.length; _i++) {
        var bindClass = _a[_i];
        bindClass.finish()
    }
}

function __nbind_free_external(num) {
    _nbind.externalList[num].dereference(num)
}

function __nbind_get_value_object(num, ptr) {
    var obj = _nbind.popValue(num);
    if (!obj.fromJS) {
        throw new Error("Object " + obj + " has no fromJS function")
    }
    obj.fromJS((function() {
        obj.__nbindValueConstructor.apply(this, Array.prototype.concat.apply([ptr], arguments))
    }))
}

function __nbind_reference_external(num) {
    _nbind.externalList[num].reference()
}

function __nbind_register_callback_signature(typeListPtr, typeCount) {
    var typeList = _nbind.readTypeIdList(typeListPtr, typeCount);
    var num = _nbind.callbackSignatureList.length;
    _nbind.callbackSignatureList[num] = _nbind.makeJSCaller(typeList);
    return num
}

function __extends(Class, Parent) {
    for (var key in Parent)
        if (Parent.hasOwnProperty(key)) Class[key] = Parent[key];

    function Base() {
        this.constructor = Class
    }
    Base.prototype = Parent.prototype;
    Class.prototype = new Base
}

function __nbind_register_class(idListPtr, policyListPtr, superListPtr, upcastListPtr, superCount, destructorPtr, namePtr) {
    var name = _nbind.readAsciiString(namePtr);
    var policyTbl = _nbind.readPolicyList(policyListPtr);
    var idList = HEAPU32.subarray(idListPtr / 4, idListPtr / 4 + 2);
    var spec = {
        flags: 2048 | (policyTbl["Value"] ? 2 : 0),
        id: idList[0],
        name: name
    };
    var bindClass = _nbind.makeType(_nbind.constructType, spec);
    bindClass.ptrType = _nbind.getComplexType(idList[1], _nbind.constructType, _nbind.getType, _nbind.queryType);
    bindClass.destroy = _nbind.makeMethodCaller(bindClass.ptrType, {
        boundID: spec.id,
        flags: 0,
        name: "destroy",
        num: 0,
        ptr: destructorPtr,
        title: bindClass.name + ".free",
        typeList: ["void", "uint32_t", "uint32_t"]
    });
    if (superCount) {
        bindClass.superIdList = Array.prototype.slice.call(HEAPU32.subarray(superListPtr / 4, superListPtr / 4 + superCount));
        bindClass.upcastList = Array.prototype.slice.call(HEAPU32.subarray(upcastListPtr / 4, upcastListPtr / 4 + superCount))
    }
    Module[bindClass.name] = bindClass.makeBound(policyTbl);
    _nbind.BindClass.list.push(bindClass)
}

function _removeAccessorPrefix(name) {
    var prefixMatcher = /^[Gg]et_?([A-Z]?([A-Z]?))/;
    return name.replace(prefixMatcher, (function(match, initial, second) {
        return second ? initial : initial.toLowerCase()
    }))
}

function __nbind_register_function(boundID, policyListPtr, typeListPtr, typeCount, ptr, direct, signatureType, namePtr, num, flags) {
    var bindClass = _nbind.getType(boundID);
    var policyTbl = _nbind.readPolicyList(policyListPtr);
    var typeList = _nbind.readTypeIdList(typeListPtr, typeCount);
    var specList;
    if (signatureType == 5) {
        specList = [{
            direct: ptr,
            name: "__nbindConstructor",
            ptr: 0,
            title: bindClass.name + " constructor",
            typeList: ["uint32_t"].concat(typeList.slice(1))
        }, {
            direct: direct,
            name: "__nbindValueConstructor",
            ptr: 0,
            title: bindClass.name + " value constructor",
            typeList: ["void", "uint32_t"].concat(typeList.slice(1))
        }]
    } else {
        var name = _nbind.readAsciiString(namePtr);
        var title = (bindClass.name && bindClass.name + ".") + name;
        if (signatureType == 3 || signatureType == 4) {
            name = _removeAccessorPrefix(name)
        }
        specList = [{
            boundID: boundID,
            direct: direct,
            name: name,
            ptr: ptr,
            title: title,
            typeList: typeList
        }]
    }
    for (var _i = 0, specList_1 = specList; _i < specList_1.length; _i++) {
        var spec = specList_1[_i];
        spec.signatureType = signatureType;
        spec.policyTbl = policyTbl;
        spec.num = num;
        spec.flags = flags;
        bindClass.addMethod(spec)
    }
}

function __nbind_register_pool(pageSize, usedPtr, rootPtr, pagePtr) {
    _nbind.Pool.pageSize = pageSize;
    _nbind.Pool.usedPtr = usedPtr / 4;
    _nbind.Pool.rootPtr = rootPtr;
    _nbind.Pool.pagePtr = pagePtr / 4;
    HEAP32[usedPtr / 4] = 16909060;
    if (HEAP8[usedPtr] == 1) _nbind.bigEndian = true;
    HEAP32[usedPtr / 4] = 0;
    _nbind.makeTypeKindTbl = (_a = {}, _a[1024] = _nbind.PrimitiveType, _a[64] = _nbind.Int64Type, _a[2048] = _nbind.BindClass, _a[3072] = _nbind.BindClassPtr, _a[4096] = _nbind.SharedClassPtr, _a[5120] = _nbind.ArrayType, _a[6144] = _nbind.ArrayType, _a[7168] = _nbind.CStringType, _a[9216] = _nbind.CallbackType, _a[10240] = _nbind.BindType, _a);
    _nbind.makeTypeNameTbl = {
        "Buffer": _nbind.BufferType,
        "External": _nbind.ExternalType,
        "Int64": _nbind.Int64Type,
        "_nbind_new": _nbind.CreateValueType,
        "bool": _nbind.BooleanType,
        "cbFunction &": _nbind.CallbackType,
        "const cbFunction &": _nbind.CallbackType,
        "const std::string &": _nbind.StringType,
        "std::string": _nbind.StringType
    };
    Module["toggleLightGC"] = _nbind.toggleLightGC;
    _nbind.callUpcast = Module["dynCall_ii"];
    var globalScope = _nbind.makeType(_nbind.constructType, {
        flags: 2048,
        id: 0,
        name: ""
    });
    globalScope.proto = Module;
    _nbind.BindClass.list.push(globalScope);
    var _a
}

function __nbind_register_primitive(id, size, flags) {
    var spec = {
        flags: 1024 | flags,
        id: id,
        ptrSize: size
    };
    _nbind.makeType(_nbind.constructType, spec)
}

function _typeModule(self) {
    var structureList = [
        [0, 1, "X"],
        [1, 1, "const X"],
        [128, 1, "X *"],
        [256, 1, "X &"],
        [384, 1, "X &&"],
        [512, 1, "std::shared_ptr<X>"],
        [640, 1, "std::unique_ptr<X>"],
        [5120, 1, "std::vector<X>"],
        [6144, 2, "std::array<X, Y>"],
        [9216, -1, "std::function<X (Y)>"]
    ];

    function applyStructure(outerName, outerFlags, innerName, innerFlags, param, flip) {
        if (outerFlags == 1) {
            var ref = innerFlags & 896;
            if (ref == 128 || ref == 256 || ref == 384) outerName = "X const"
        }
        var name;
        if (flip) {
            name = innerName.replace("X", outerName).replace("Y", param)
        } else {
            name = outerName.replace("X", innerName).replace("Y", param)
        }
        return name.replace(/([*&]) (?=[*&])/g, "$1")
    }

    function reportProblem(problem, id, kind, structureType, place) {
        throw new Error(problem + " type " + kind.replace("X", id + "?") + (structureType ? " with flag " + structureType : "") + " in " + place)
    }

    function getComplexType(id, constructType, getType, queryType, place, kind, prevStructure, depth) {
        if (kind === void 0) {
            kind = "X"
        }
        if (depth === void 0) {
            depth = 1
        }
        var result = getType(id);
        if (result) return result;
        var query = queryType(id);
        var structureType = query.placeholderFlag;
        var structure = structureList[structureType];
        if (prevStructure && structure) {
            kind = applyStructure(prevStructure[2], prevStructure[0], kind, structure[0], "?", true)
        }
        var problem;
        if (structureType == 0) problem = "Unbound";
        if (structureType >= 10) problem = "Corrupt";
        if (depth > 20) problem = "Deeply nested";
        if (problem) reportProblem(problem, id, kind, structureType, place || "?");
        var subId = query.paramList[0];
        var subType = getComplexType(subId, constructType, getType, queryType, place, kind, structure, depth + 1);
        var srcSpec;
        var spec = {
            flags: structure[0],
            id: id,
            name: "",
            paramList: [subType]
        };
        var argList = [];
        var structureParam = "?";
        switch (query.placeholderFlag) {
            case 1:
                srcSpec = subType.spec;
                break;
            case 2:
                if ((subType.flags & 15360) == 1024 && subType.spec.ptrSize == 1) {
                    spec.flags = 7168;
                    break
                };
            case 3:
            case 6:
            case 5:
                srcSpec = subType.spec;
                if ((subType.flags & 15360) != 2048) {}
                break;
            case 8:
                structureParam = "" + query.paramList[1];
                spec.paramList.push(query.paramList[1]);
                break;
            case 9:
                for (var _i = 0, _a = query.paramList[1]; _i < _a.length; _i++) {
                    var paramId = _a[_i];
                    var paramType = getComplexType(paramId, constructType, getType, queryType, place, kind, structure, depth + 1);
                    argList.push(paramType.name);
                    spec.paramList.push(paramType)
                }
                structureParam = argList.join(", ");
                break;
            default:
                break
        }
        spec.name = applyStructure(structure[2], structure[0], subType.name, subType.flags, structureParam);
        if (srcSpec) {
            for (var _b = 0, _c = Object.keys(srcSpec); _b < _c.length; _b++) {
                var key = _c[_b];
                spec[key] = spec[key] || srcSpec[key]
            }
            spec.flags |= srcSpec.flags
        }
        return makeType(constructType, spec)
    }

    function makeType(constructType, spec) {
        var flags = spec.flags;
        var refKind = flags & 896;
        var kind = flags & 15360;
        if (!spec.name && kind == 1024) {
            if (spec.ptrSize == 1) {
                spec.name = (flags & 16 ? "" : (flags & 8 ? "un" : "") + "signed ") + "char"
            } else {
                spec.name = (flags & 8 ? "u" : "") + (flags & 32 ? "float" : "int") + (spec.ptrSize * 8 + "_t")
            }
        }
        if (spec.ptrSize == 8 && !(flags & 32)) kind = 64;
        if (kind == 2048) {
            if (refKind == 512 || refKind == 640) {
                kind = 4096
            } else if (refKind) kind = 3072
        }
        return constructType(kind, spec)
    }
    var Type = (function() {
        function Type(spec) {
            this.id = spec.id;
            this.name = spec.name;
            this.flags = spec.flags;
            this.spec = spec
        }
        Type.prototype.toString = (function() {
            return this.name
        });
        return Type
    })();
    var output = {
        Type: Type,
        getComplexType: getComplexType,
        makeType: makeType,
        structureList: structureList
    };
    self.output = output;
    return self.output || output
}

function __nbind_register_type(id, namePtr) {
    var name = _nbind.readAsciiString(namePtr);
    var spec = {
        flags: 10240,
        id: id,
        name: name
    };
    _nbind.makeType(_nbind.constructType, spec)
}

function _abort() {
    Module["abort"]()
}

function _llvm_stackrestore(p) {
    var self = _llvm_stacksave;
    var ret = self.LLVM_SAVEDSTACKS[p];
    self.LLVM_SAVEDSTACKS.splice(p, 1);
    stackRestore(ret)
}

function _llvm_stacksave() {
    var self = _llvm_stacksave;
    if (!self.LLVM_SAVEDSTACKS) {
        self.LLVM_SAVEDSTACKS = []
    }
    self.LLVM_SAVEDSTACKS.push(stackSave());
    return self.LLVM_SAVEDSTACKS.length - 1
}

function _emscripten_memcpy_big(dest, src, num) {
    HEAPU8.set(HEAPU8.subarray(src, src + num), dest);
    return dest
}

function _nbind_value(name, proto) {
    if (!_nbind.typeNameTbl[name]) _nbind.throwError("Unknown value type " + name);
    Module["NBind"].bind_value(name, proto);
    _defineHidden(_nbind.typeNameTbl[name].proto.prototype.__nbindValueConstructor)(proto.prototype, "__nbindValueConstructor")
}
Module["_nbind_value"] = _nbind_value;

function ___setErrNo(value) {
    if (Module["___errno_location"]) HEAP32[Module["___errno_location"]() >> 2] = value;
    return value
}
Module["requestFullScreen"] = function Module_requestFullScreen(lockPointer, resizeCanvas, vrDevice) {
    Module.printErr("Module.requestFullScreen is deprecated. Please call Module.requestFullscreen instead.");
    Module["requestFullScreen"] = Module["requestFullscreen"];
    Browser.requestFullScreen(lockPointer, resizeCanvas, vrDevice)
};
Module["requestFullscreen"] = function Module_requestFullscreen(lockPointer, resizeCanvas, vrDevice) {
    Browser.requestFullscreen(lockPointer, resizeCanvas, vrDevice)
};
Module["requestAnimationFrame"] = function Module_requestAnimationFrame(func) {
    Browser.requestAnimationFrame(func)
};
Module["setCanvasSize"] = function Module_setCanvasSize(width, height, noUpdates) {
    Browser.setCanvasSize(width, height, noUpdates)
};
Module["pauseMainLoop"] = function Module_pauseMainLoop() {
    Browser.mainLoop.pause()
};
Module["resumeMainLoop"] = function Module_resumeMainLoop() {
    Browser.mainLoop.resume()
};
Module["getUserMedia"] = function Module_getUserMedia() {
    Browser.getUserMedia()
};
Module["createContext"] = function Module_createContext(canvas, useWebGL, setInModule, webGLContextAttributes) {
    return Browser.createContext(canvas, useWebGL, setInModule, webGLContextAttributes)
};
if (ENVIRONMENT_IS_NODE) {
    _emscripten_get_now = function _emscripten_get_now_actual() {
        var t = process["hrtime"]();
        return t[0] * 1e3 + t[1] / 1e6
    }
} else if (typeof dateNow !== "undefined") {
    _emscripten_get_now = dateNow
} else if (typeof self === "object" && self["performance"] && typeof self["performance"]["now"] === "function") {
    _emscripten_get_now = (function() {
        return self["performance"]["now"]()
    })
} else if (typeof performance === "object" && typeof performance["now"] === "function") {
    _emscripten_get_now = (function() {
        return performance["now"]()
    })
} else {
    _emscripten_get_now = Date.now
}((function(_nbind) {
    var typeIdTbl = {};
    _nbind.typeNameTbl = {};
    var Pool = (function() {
        function Pool() {}
        Pool.lalloc = (function(size) {
            size = size + 7 & ~7;
            var used = HEAPU32[Pool.usedPtr];
            if (size > Pool.pageSize / 2 || size > Pool.pageSize - used) {
                var NBind = _nbind.typeNameTbl["NBind"].proto;
                return NBind.lalloc(size)
            } else {
                HEAPU32[Pool.usedPtr] = used + size;
                return Pool.rootPtr + used
            }
        });
        Pool.lreset = (function(used, page) {
            var topPage = HEAPU32[Pool.pagePtr];
            if (topPage) {
                var NBind = _nbind.typeNameTbl["NBind"].proto;
                NBind.lreset(used, page)
            } else {
                HEAPU32[Pool.usedPtr] = used
            }
        });
        return Pool
    })();
    _nbind.Pool = Pool;

    function constructType(kind, spec) {
        var construct = kind == 10240 ? _nbind.makeTypeNameTbl[spec.name] || _nbind.BindType : _nbind.makeTypeKindTbl[kind];
        var bindType = new construct(spec);
        typeIdTbl[spec.id] = bindType;
        _nbind.typeNameTbl[spec.name] = bindType;
        return bindType
    }
    _nbind.constructType = constructType;

    function getType(id) {
        return typeIdTbl[id]
    }
    _nbind.getType = getType;

    function queryType(id) {
        var placeholderFlag = HEAPU8[id];
        var paramCount = _nbind.structureList[placeholderFlag][1];
        id /= 4;
        if (paramCount < 0) {
            ++id;
            paramCount = HEAPU32[id] + 1
        }
        var paramList = Array.prototype.slice.call(HEAPU32.subarray(id + 1, id + 1 + paramCount));
        if (placeholderFlag == 9) {
            paramList = [paramList[0], paramList.slice(1)]
        }
        return {
            paramList: paramList,
            placeholderFlag: placeholderFlag
        }
    }
    _nbind.queryType = queryType;

    function getTypes(idList, place) {
        return idList.map((function(id) {
            return typeof id == "number" ? _nbind.getComplexType(id, constructType, getType, queryType, place) : _nbind.typeNameTbl[id]
        }))
    }
    _nbind.getTypes = getTypes;

    function readTypeIdList(typeListPtr, typeCount) {
        return Array.prototype.slice.call(HEAPU32, typeListPtr / 4, typeListPtr / 4 + typeCount)
    }
    _nbind.readTypeIdList = readTypeIdList;

    function readAsciiString(ptr) {
        var endPtr = ptr;
        while (HEAPU8[endPtr++]);
        return String.fromCharCode.apply("", HEAPU8.subarray(ptr, endPtr - 1))
    }
    _nbind.readAsciiString = readAsciiString;

    function readPolicyList(policyListPtr) {
        var policyTbl = {};
        if (policyListPtr) {
            while (1) {
                var namePtr = HEAPU32[policyListPtr / 4];
                if (!namePtr) break;
                policyTbl[readAsciiString(namePtr)] = true;
                policyListPtr += 4
            }
        }
        return policyTbl
    }
    _nbind.readPolicyList = readPolicyList;

    function getDynCall(typeList, name) {
        var mangleMap = {
            float32_t: "d",
            float64_t: "d",
            int64_t: "d",
            uint64_t: "d",
            "void": "v"
        };
        var signature = typeList.map((function(type) {
            return mangleMap[type.name] || "i"
        })).join("");
        var dynCall = Module["dynCall_" + signature];
        if (!dynCall) {
            throw new Error("dynCall_" + signature + " not found for " + name + "(" + typeList.map((function(type) {
                return type.name
            })).join(", ") + ")")
        }
        return dynCall
    }
    _nbind.getDynCall = getDynCall;

    function addMethod(obj, name, func, arity) {
        var overload = obj[name];
        if (obj.hasOwnProperty(name) && overload) {
            if (overload.arity || overload.arity === 0) {
                overload = _nbind.makeOverloader(overload, overload.arity);
                obj[name] = overload
            }
            overload.addMethod(func, arity)
        } else {
            func.arity = arity;
            obj[name] = func
        }
    }
    _nbind.addMethod = addMethod;

    function throwError(message) {
        throw new Error(message)
    }
    _nbind.throwError = throwError;
    _nbind.bigEndian = false;
    _a = _typeModule(_typeModule), _nbind.Type = _a.Type, _nbind.makeType = _a.makeType, _nbind.getComplexType = _a.getComplexType, _nbind.structureList = _a.structureList;
    var BindType = (function(_super) {
        __extends(BindType, _super);

        function BindType() {
            var _this = _super !== null && _super.apply(this, arguments) || this;
            _this.heap = HEAPU32;
            _this.ptrSize = 4;
            return _this
        }
        BindType.prototype.needsWireRead = (function(policyTbl) {
            return !!this.wireRead || !!this.makeWireRead
        });
        BindType.prototype.needsWireWrite = (function(policyTbl) {
            return !!this.wireWrite || !!this.makeWireWrite
        });
        return BindType
    })(_nbind.Type);
    _nbind.BindType = BindType;
    var PrimitiveType = (function(_super) {
        __extends(PrimitiveType, _super);

        function PrimitiveType(spec) {
            var _this = _super.call(this, spec) || this;
            var heapTbl = spec.flags & 32 ? {
                32: HEAPF32,
                64: HEAPF64
            } : spec.flags & 8 ? {
                8: HEAPU8,
                16: HEAPU16,
                32: HEAPU32
            } : {
                8: HEAP8,
                16: HEAP16,
                32: HEAP32
            };
            _this.heap = heapTbl[spec.ptrSize * 8];
            _this.ptrSize = spec.ptrSize;
            return _this
        }
        PrimitiveType.prototype.needsWireWrite = (function(policyTbl) {
            return !!policyTbl && !!policyTbl["Strict"]
        });
        PrimitiveType.prototype.makeWireWrite = (function(expr, policyTbl) {
            return policyTbl && policyTbl["Strict"] && (function(arg) {
                if (typeof arg == "number") return arg;
                throw new Error("Type mismatch")
            })
        });
        return PrimitiveType
    })(BindType);
    _nbind.PrimitiveType = PrimitiveType;

    function pushCString(str, policyTbl) {
        if (str === null || str === undefined) {
            if (policyTbl && policyTbl["Nullable"]) {
                return 0
            } else throw new Error("Type mismatch")
        }
        if (policyTbl && policyTbl["Strict"]) {
            if (typeof str != "string") throw new Error("Type mismatch")
        } else str = str.toString();
        var length = Module.lengthBytesUTF8(str) + 1;
        var result = _nbind.Pool.lalloc(length);
        Module.stringToUTF8Array(str, HEAPU8, result, length);
        return result
    }
    _nbind.pushCString = pushCString;

    function popCString(ptr) {
        if (ptr === 0) return null;
        return Module.Pointer_stringify(ptr)
    }
    _nbind.popCString = popCString;
    var CStringType = (function(_super) {
        __extends(CStringType, _super);

        function CStringType() {
            var _this = _super !== null && _super.apply(this, arguments) || this;
            _this.wireRead = popCString;
            _this.wireWrite = pushCString;
            _this.readResources = [_nbind.resources.pool];
            _this.writeResources = [_nbind.resources.pool];
            return _this
        }
        CStringType.prototype.makeWireWrite = (function(expr, policyTbl) {
            return (function(arg) {
                return pushCString(arg, policyTbl)
            })
        });
        return CStringType
    })(BindType);
    _nbind.CStringType = CStringType;
    var BooleanType = (function(_super) {
        __extends(BooleanType, _super);

        function BooleanType() {
            var _this = _super !== null && _super.apply(this, arguments) || this;
            _this.wireRead = (function(arg) {
                return !!arg
            });
            return _this
        }
        BooleanType.prototype.needsWireWrite = (function(policyTbl) {
            return !!policyTbl && !!policyTbl["Strict"]
        });
        BooleanType.prototype.makeWireRead = (function(expr) {
            return "!!(" + expr + ")"
        });
        BooleanType.prototype.makeWireWrite = (function(expr, policyTbl) {
            return policyTbl && policyTbl["Strict"] && (function(arg) {
                if (typeof arg == "boolean") return arg;
                throw new Error("Type mismatch")
            }) || expr
        });
        return BooleanType
    })(BindType);
    _nbind.BooleanType = BooleanType;
    var Wrapper = (function() {
        function Wrapper() {}
        Wrapper.prototype.persist = (function() {
            this.__nbindState |= 1
        });
        return Wrapper
    })();
    _nbind.Wrapper = Wrapper;

    function makeBound(policyTbl, bindClass) {
        var Bound = (function(_super) {
            __extends(Bound, _super);

            function Bound(marker, flags, ptr, shared) {
                var _this = _super.call(this) || this;
                if (!(_this instanceof Bound)) {
                    return new(Function.prototype.bind.apply(Bound, Array.prototype.concat.apply([null], arguments)))
                }
                var nbindFlags = flags;
                var nbindPtr = ptr;
                var nbindShared = shared;
                if (marker !== _nbind.ptrMarker) {
                    var wirePtr = _this.__nbindConstructor.apply(_this, arguments);
                    nbindFlags = 4096 | 512;
                    nbindShared = HEAPU32[wirePtr / 4];
                    nbindPtr = HEAPU32[wirePtr / 4 + 1]
                }
                var spec = {
                    configurable: true,
                    enumerable: false,
                    value: null,
                    writable: false
                };
                var propTbl = {
                    "__nbindFlags": nbindFlags,
                    "__nbindPtr": nbindPtr
                };
                if (nbindShared) {
                    propTbl["__nbindShared"] = nbindShared;
                    _nbind.mark(_this)
                }
                for (var _i = 0, _a = Object.keys(propTbl); _i < _a.length; _i++) {
                    var key = _a[_i];
                    spec.value = propTbl[key];
                    Object.defineProperty(_this, key, spec)
                }
                _defineHidden(0)(_this, "__nbindState");
                return _this
            }
            Bound.prototype.free = (function() {
                bindClass.destroy.call(this, this.__nbindShared, this.__nbindFlags);
                this.__nbindState |= 2;
                disableMember(this, "__nbindShared");
                disableMember(this, "__nbindPtr")
            });
            return Bound
        })(Wrapper);
        __decorate([_defineHidden()], Bound.prototype, "__nbindConstructor", void 0);
        __decorate([_defineHidden()], Bound.prototype, "__nbindValueConstructor", void 0);
        __decorate([_defineHidden(policyTbl)], Bound.prototype, "__nbindPolicies", void 0);
        return Bound
    }
    _nbind.makeBound = makeBound;

    function disableMember(obj, name) {
        function die() {
            throw new Error("Accessing deleted object")
        }
        Object.defineProperty(obj, name, {
            configurable: false,
            enumerable: false,
            get: die,
            set: die
        })
    }
    _nbind.ptrMarker = {};
    var BindClass = (function(_super) {
        __extends(BindClass, _super);

        function BindClass(spec) {
            var _this = _super.call(this, spec) || this;
            _this.wireRead = (function(arg) {
                return _nbind.popValue(arg, _this.ptrType)
            });
            _this.wireWrite = (function(arg) {
                return pushPointer(arg, _this.ptrType, true)
            });
            _this.pendingSuperCount = 0;
            _this.ready = false;
            _this.methodTbl = {};
            if (spec.paramList) {
                _this.classType = spec.paramList[0].classType;
                _this.proto = _this.classType.proto
            } else _this.classType = _this;
            return _this
        }
        BindClass.prototype.makeBound = (function(policyTbl) {
            var Bound = _nbind.makeBound(policyTbl, this);
            this.proto = Bound;
            this.ptrType.proto = Bound;
            return Bound
        });
        BindClass.prototype.addMethod = (function(spec) {
            var overloadList = this.methodTbl[spec.name] || [];
            overloadList.push(spec);
            this.methodTbl[spec.name] = overloadList
        });
        BindClass.prototype.registerMethods = (function(src, staticOnly) {
            var setter;
            for (var _i = 0, _a = Object.keys(src.methodTbl); _i < _a.length; _i++) {
                var name = _a[_i];
                var overloadList = src.methodTbl[name];
                for (var _b = 0, overloadList_1 = overloadList; _b < overloadList_1.length; _b++) {
                    var spec = overloadList_1[_b];
                    var target = void 0;
                    var caller = void 0;
                    target = this.proto.prototype;
                    if (staticOnly && spec.signatureType != 1) continue;
                    switch (spec.signatureType) {
                        case 1:
                            target = this.proto;
                        case 5:
                            caller = _nbind.makeCaller(spec);
                            _nbind.addMethod(target, spec.name, caller, spec.typeList.length - 1);
                            break;
                        case 4:
                            setter = _nbind.makeMethodCaller(src.ptrType, spec);
                            break;
                        case 3:
                            Object.defineProperty(target, spec.name, {
                                configurable: true,
                                enumerable: false,
                                get: _nbind.makeMethodCaller(src.ptrType, spec),
                                set: setter
                            });
                            break;
                        case 2:
                            caller = _nbind.makeMethodCaller(src.ptrType, spec);
                            _nbind.addMethod(target, spec.name, caller, spec.typeList.length - 1);
                            break;
                        default:
                            break
                    }
                }
            }
        });
        BindClass.prototype.registerSuperMethods = (function(src, firstSuper, visitTbl) {
            if (visitTbl[src.name]) return;
            visitTbl[src.name] = true;
            var superNum = 0;
            var nextFirst;
            for (var _i = 0, _a = src.superIdList || []; _i < _a.length; _i++) {
                var superId = _a[_i];
                var superClass = _nbind.getType(superId);
                if (superNum++ < firstSuper || firstSuper < 0) {
                    nextFirst = -1
                } else {
                    nextFirst = 0
                }
                this.registerSuperMethods(superClass, nextFirst, visitTbl)
            }
            this.registerMethods(src, firstSuper < 0)
        });
        BindClass.prototype.finish = (function() {
            if (this.ready) return this;
            this.ready = true;
            this.superList = (this.superIdList || []).map((function(superId) {
                return _nbind.getType(superId).finish()
            }));
            var Bound = this.proto;
            if (this.superList.length) {
                var Proto = (function() {
                    this.constructor = Bound
                });
                Proto.prototype = this.superList[0].proto.prototype;
                Bound.prototype = new Proto
            }
            if (Bound != Module) Bound.prototype.__nbindType = this;
            this.registerSuperMethods(this, 1, {});
            return this
        });
        BindClass.prototype.upcastStep = (function(dst, ptr) {
            if (dst == this) return ptr;
            for (var i = 0; i < this.superList.length; ++i) {
                var superPtr = this.superList[i].upcastStep(dst, _nbind.callUpcast(this.upcastList[i], ptr));
                if (superPtr) return superPtr
            }
            return 0
        });
        return BindClass
    })(_nbind.BindType);
    BindClass.list = [];
    _nbind.BindClass = BindClass;

    function popPointer(ptr, type) {
        return ptr ? new type.proto(_nbind.ptrMarker, type.flags, ptr) : null
    }
    _nbind.popPointer = popPointer;

    function pushPointer(obj, type, tryValue) {
        if (!(obj instanceof _nbind.Wrapper)) {
            if (tryValue) {
                return _nbind.pushValue(obj)
            } else throw new Error("Type mismatch")
        }
        var ptr = obj.__nbindPtr;
        var objType = obj.__nbindType.classType;
        var classType = type.classType;
        if (obj instanceof type.proto) {
            while (objType != classType) {
                ptr = _nbind.callUpcast(objType.upcastList[0], ptr);
                objType = objType.superList[0]
            }
        } else {
            ptr = objType.upcastStep(classType, ptr);
            if (!ptr) throw new Error("Type mismatch")
        }
        return ptr
    }
    _nbind.pushPointer = pushPointer;

    function pushMutablePointer(obj, type) {
        var ptr = pushPointer(obj, type);
        if (obj.__nbindFlags & 1) {
            throw new Error("Passing a const value as a non-const argument")
        }
        return ptr
    }
    var BindClassPtr = (function(_super) {
        __extends(BindClassPtr, _super);

        function BindClassPtr(spec) {
            var _this = _super.call(this, spec) || this;
            _this.classType = spec.paramList[0].classType;
            _this.proto = _this.classType.proto;
            var isConst = spec.flags & 1;
            var isValue = (_this.flags & 896) == 256 && spec.flags & 2;
            var push = isConst ? pushPointer : pushMutablePointer;
            var pop = isValue ? _nbind.popValue : popPointer;
            _this.makeWireWrite = (function(expr, policyTbl) {
                return policyTbl["Nullable"] ? (function(arg) {
                    return arg ? push(arg, _this) : 0
                }) : (function(arg) {
                    return push(arg, _this)
                })
            });
            _this.wireRead = (function(arg) {
                return pop(arg, _this)
            });
            _this.wireWrite = (function(arg) {
                return push(arg, _this)
            });
            return _this
        }
        return BindClassPtr
    })(_nbind.BindType);
    _nbind.BindClassPtr = BindClassPtr;

    function popShared(ptr, type) {
        var shared = HEAPU32[ptr / 4];
        var unsafe = HEAPU32[ptr / 4 + 1];
        return unsafe ? new type.proto(_nbind.ptrMarker, type.flags, unsafe, shared) : null
    }
    _nbind.popShared = popShared;

    function pushShared(obj, type) {
        if (!(obj instanceof type.proto)) throw new Error("Type mismatch");
        return obj.__nbindShared
    }

    function pushMutableShared(obj, type) {
        if (!(obj instanceof type.proto)) throw new Error("Type mismatch");
        if (obj.__nbindFlags & 1) {
            throw new Error("Passing a const value as a non-const argument")
        }
        return obj.__nbindShared
    }
    var SharedClassPtr = (function(_super) {
        __extends(SharedClassPtr, _super);

        function SharedClassPtr(spec) {
            var _this = _super.call(this, spec) || this;
            _this.readResources = [_nbind.resources.pool];
            _this.classType = spec.paramList[0].classType;
            _this.proto = _this.classType.proto;
            var isConst = spec.flags & 1;
            var push = isConst ? pushShared : pushMutableShared;
            _this.wireRead = (function(arg) {
                return popShared(arg, _this)
            });
            _this.wireWrite = (function(arg) {
                return push(arg, _this)
            });
            return _this
        }
        return SharedClassPtr
    })(_nbind.BindType);
    _nbind.SharedClassPtr = SharedClassPtr;
    _nbind.externalList = [0];
    var firstFreeExternal = 0;
    var External = (function() {
        function External(data) {
            this.refCount = 1;
            this.data = data
        }
        External.prototype.register = (function() {
            var num = firstFreeExternal;
            if (num) {
                firstFreeExternal = _nbind.externalList[num]
            } else num = _nbind.externalList.length;
            _nbind.externalList[num] = this;
            return num
        });
        External.prototype.reference = (function() {
            ++this.refCount
        });
        External.prototype.dereference = (function(num) {
            if (--this.refCount == 0) {
                if (this.free) this.free();
                _nbind.externalList[num] = firstFreeExternal;
                firstFreeExternal = num
            }
        });
        return External
    })();
    _nbind.External = External;

    function popExternal(num) {
        var obj = _nbind.externalList[num];
        obj.dereference(num);
        return obj.data
    }

    function pushExternal(obj) {
        var external = new External(obj);
        external.reference();
        return external.register()
    }
    var ExternalType = (function(_super) {
        __extends(ExternalType, _super);

        function ExternalType() {
            var _this = _super !== null && _super.apply(this, arguments) || this;
            _this.wireRead = popExternal;
            _this.wireWrite = pushExternal;
            return _this
        }
        return ExternalType
    })(_nbind.BindType);
    _nbind.ExternalType = ExternalType;
    _nbind.callbackSignatureList = [];
    var CallbackType = (function(_super) {
        __extends(CallbackType, _super);

        function CallbackType() {
            var _this = _super !== null && _super.apply(this, arguments) || this;
            _this.wireWrite = (function(func) {
                if (typeof func != "function") _nbind.throwError("Type mismatch");
                return (new _nbind.External(func)).register()
            });
            return _this
        }
        return CallbackType
    })(_nbind.BindType);
    _nbind.CallbackType = CallbackType;
    _nbind.valueList = [0];
    var firstFreeValue = 0;

    function pushValue(value) {
        var num = firstFreeValue;
        if (num) {
            firstFreeValue = _nbind.valueList[num]
        } else num = _nbind.valueList.length;
        _nbind.valueList[num] = value;
        return num * 2 + 1
    }
    _nbind.pushValue = pushValue;

    function popValue(num, type) {
        if (!num) _nbind.throwError("Value type JavaScript class is missing or not registered");
        if (num & 1) {
            num >>= 1;
            var obj = _nbind.valueList[num];
            _nbind.valueList[num] = firstFreeValue;
            firstFreeValue = num;
            return obj
        } else if (type) {
            return _nbind.popShared(num, type)
        } else throw new Error("Invalid value slot " + num)
    }
    _nbind.popValue = popValue;
    var valueBase = 0x10000000000000000;

    function push64(num) {
        if (typeof num == "number") return num;
        return pushValue(num) * 4096 + valueBase
    }

    function pop64(num) {
        if (num < valueBase) return num;
        return popValue((num - valueBase) / 4096)
    }
    var CreateValueType = (function(_super) {
        __extends(CreateValueType, _super);

        function CreateValueType() {
            return _super !== null && _super.apply(this, arguments) || this
        }
        CreateValueType.prototype.makeWireWrite = (function(expr) {
            return "(_nbind.pushValue(new " + expr + "))"
        });
        return CreateValueType
    })(_nbind.BindType);
    _nbind.CreateValueType = CreateValueType;
    var Int64Type = (function(_super) {
        __extends(Int64Type, _super);

        function Int64Type() {
            var _this = _super !== null && _super.apply(this, arguments) || this;
            _this.wireWrite = push64;
            _this.wireRead = pop64;
            return _this
        }
        return Int64Type
    })(_nbind.BindType);
    _nbind.Int64Type = Int64Type;

    function pushArray(arr, type) {
        if (!arr) return 0;
        var length = arr.length;
        if ((type.size || type.size === 0) && length < type.size) {
            throw new Error("Type mismatch")
        }
        var ptrSize = type.memberType.ptrSize;
        var result = _nbind.Pool.lalloc(4 + length * ptrSize);
        HEAPU32[result / 4] = length;
        var heap = type.memberType.heap;
        var ptr = (result + 4) / ptrSize;
        var wireWrite = type.memberType.wireWrite;
        var num = 0;
        if (wireWrite) {
            while (num < length) {
                heap[ptr++] = wireWrite(arr[num++])
            }
        } else {
            while (num < length) {
                heap[ptr++] = arr[num++]
            }
        }
        return result
    }
    _nbind.pushArray = pushArray;

    function popArray(ptr, type) {
        if (ptr === 0) return null;
        var length = HEAPU32[ptr / 4];
        var arr = new Array(length);
        var heap = type.memberType.heap;
        ptr = (ptr + 4) / type.memberType.ptrSize;
        var wireRead = type.memberType.wireRead;
        var num = 0;
        if (wireRead) {
            while (num < length) {
                arr[num++] = wireRead(heap[ptr++])
            }
        } else {
            while (num < length) {
                arr[num++] = heap[ptr++]
            }
        }
        return arr
    }
    _nbind.popArray = popArray;
    var ArrayType = (function(_super) {
        __extends(ArrayType, _super);

        function ArrayType(spec) {
            var _this = _super.call(this, spec) || this;
            _this.wireRead = (function(arg) {
                return popArray(arg, _this)
            });
            _this.wireWrite = (function(arg) {
                return pushArray(arg, _this)
            });
            _this.readResources = [_nbind.resources.pool];
            _this.writeResources = [_nbind.resources.pool];
            _this.memberType = spec.paramList[0];
            if (spec.paramList[1]) _this.size = spec.paramList[1];
            return _this
        }
        return ArrayType
    })(_nbind.BindType);
    _nbind.ArrayType = ArrayType;

    function pushString(str, policyTbl) {
        if (str === null || str === undefined) {
            if (policyTbl && policyTbl["Nullable"]) {
                str = ""
            } else throw new Error("Type mismatch")
        }
        if (policyTbl && policyTbl["Strict"]) {
            if (typeof str != "string") throw new Error("Type mismatch")
        } else str = str.toString();
        var length = Module.lengthBytesUTF8(str);
        var result = _nbind.Pool.lalloc(4 + length + 1);
        HEAPU32[result / 4] = length;
        Module.stringToUTF8Array(str, HEAPU8, result + 4, length + 1);
        return result
    }
    _nbind.pushString = pushString;

    function popString(ptr) {
        if (ptr === 0) return null;
        var length = HEAPU32[ptr / 4];
        return Module.Pointer_stringify(ptr + 4, length)
    }
    _nbind.popString = popString;
    var StringType = (function(_super) {
        __extends(StringType, _super);

        function StringType() {
            var _this = _super !== null && _super.apply(this, arguments) || this;
            _this.wireRead = popString;
            _this.wireWrite = pushString;
            _this.readResources = [_nbind.resources.pool];
            _this.writeResources = [_nbind.resources.pool];
            return _this
        }
        StringType.prototype.makeWireWrite = (function(expr, policyTbl) {
            return (function(arg) {
                return pushString(arg, policyTbl)
            })
        });
        return StringType
    })(_nbind.BindType);
    _nbind.StringType = StringType;

    function makeArgList(argCount) {
        return Array.apply(null, Array(argCount)).map((function(dummy, num) {
            return "a" + (num + 1)
        }))
    }

    function anyNeedsWireWrite(typeList, policyTbl) {
        return typeList.reduce((function(result, type) {
            return result || type.needsWireWrite(policyTbl)
        }), false)
    }

    function anyNeedsWireRead(typeList, policyTbl) {
        return typeList.reduce((function(result, type) {
            return result || !!type.needsWireRead(policyTbl)
        }), false)
    }

    function makeWireRead(convertParamList, policyTbl, type, expr) {
        var paramNum = convertParamList.length;
        if (type.makeWireRead) {
            return type.makeWireRead(expr, convertParamList, paramNum)
        } else if (type.wireRead) {
            convertParamList[paramNum] = type.wireRead;
            return "(convertParamList[" + paramNum + "](" + expr + "))"
        } else return expr
    }

    function makeWireWrite(convertParamList, policyTbl, type, expr) {
        var wireWrite;
        var paramNum = convertParamList.length;
        if (type.makeWireWrite) {
            wireWrite = type.makeWireWrite(expr, policyTbl, convertParamList, paramNum)
        } else wireWrite = type.wireWrite;
        if (wireWrite) {
            if (typeof wireWrite == "string") {
                return wireWrite
            } else {
                convertParamList[paramNum] = wireWrite;
                return "(convertParamList[" + paramNum + "](" + expr + "))"
            }
        } else return expr
    }

    function buildCallerFunction(dynCall, ptrType, ptr, num, policyTbl, needsWireWrite, prefix, returnType, argTypeList, mask, err) {
        var argList = makeArgList(argTypeList.length);
        var convertParamList = [];
        var callExpression = makeWireRead(convertParamList, policyTbl, returnType, "dynCall(" + [prefix].concat(argList.map((function(name, index) {
            return makeWireWrite(convertParamList, policyTbl, argTypeList[index], name)
        }))).join(",") + ")");
        var resourceSet = _nbind.listResources([returnType], argTypeList);
        var sourceCode = "function(" + argList.join(",") + "){" + (mask ? "this.__nbindFlags&mask&&err();" : "") + resourceSet.makeOpen() + "var r=" + callExpression + ";" + resourceSet.makeClose() + "return r;" + "}";
        return eval("(" + sourceCode + ")")
    }

    function buildJSCallerFunction(returnType, argTypeList) {
        var argList = makeArgList(argTypeList.length);
        var convertParamList = [];
        var callExpression = makeWireWrite(convertParamList, null, returnType, "_nbind.externalList[num].data(" + argList.map((function(name, index) {
            return makeWireRead(convertParamList, null, argTypeList[index], name)
        })).join(",") + ")");
        var resourceSet = _nbind.listResources(argTypeList, [returnType]);
        resourceSet.remove(_nbind.resources.pool);
        var sourceCode = "function(" + ["dummy", "num"].concat(argList).join(",") + "){" + resourceSet.makeOpen() + "var r=" + callExpression + ";" + resourceSet.makeClose() + "return r;" + "}";
        return eval("(" + sourceCode + ")")
    }
    _nbind.buildJSCallerFunction = buildJSCallerFunction;

    function makeJSCaller(idList) {
        var argCount = idList.length - 1;
        var typeList = _nbind.getTypes(idList, "callback");
        var returnType = typeList[0];
        var argTypeList = typeList.slice(1);
        var needsWireRead = anyNeedsWireRead(argTypeList, null);
        var needsWireWrite = returnType.needsWireWrite(null);
        if (!needsWireWrite && !needsWireRead) {
            switch (argCount) {
                case 0:
                    return (function(dummy, num) {
                        return _nbind.externalList[num].data()
                    });
                case 1:
                    return (function(dummy, num, a1) {
                        return _nbind.externalList[num].data(a1)
                    });
                case 2:
                    return (function(dummy, num, a1, a2) {
                        return _nbind.externalList[num].data(a1, a2)
                    });
                case 3:
                    return (function(dummy, num, a1, a2, a3) {
                        return _nbind.externalList[num].data(a1, a2, a3)
                    });
                default:
                    break
            }
        }
        return buildJSCallerFunction(returnType, argTypeList)
    }
    _nbind.makeJSCaller = makeJSCaller;

    function makeMethodCaller(ptrType, spec) {
        var argCount = spec.typeList.length - 1;
        var typeIdList = spec.typeList.slice(0);
        typeIdList.splice(1, 0, "uint32_t", spec.boundID);
        var typeList = _nbind.getTypes(typeIdList, spec.title);
        var returnType = typeList[0];
        var argTypeList = typeList.slice(3);
        var needsWireRead = returnType.needsWireRead(spec.policyTbl);
        var needsWireWrite = anyNeedsWireWrite(argTypeList, spec.policyTbl);
        var ptr = spec.ptr;
        var num = spec.num;
        var dynCall = _nbind.getDynCall(typeList, spec.title);
        var mask = ~spec.flags & 1;

        function err() {
            throw new Error("Calling a non-const method on a const object")
        }
        if (!needsWireRead && !needsWireWrite) {
            switch (argCount) {
                case 0:
                    return (function() {
                        return this.__nbindFlags & mask ? err() : dynCall(ptr, num, _nbind.pushPointer(this, ptrType))
                    });
                case 1:
                    return (function(a1) {
                        return this.__nbindFlags & mask ? err() : dynCall(ptr, num, _nbind.pushPointer(this, ptrType), a1)
                    });
                case 2:
                    return (function(a1, a2) {
                        return this.__nbindFlags & mask ? err() : dynCall(ptr, num, _nbind.pushPointer(this, ptrType), a1, a2)
                    });
                case 3:
                    return (function(a1, a2, a3) {
                        return this.__nbindFlags & mask ? err() : dynCall(ptr, num, _nbind.pushPointer(this, ptrType), a1, a2, a3)
                    });
                default:
                    break
            }
        }
        return buildCallerFunction(dynCall, ptrType, ptr, num, spec.policyTbl, needsWireWrite, "ptr,num,pushPointer(this,ptrType)", returnType, argTypeList, mask, err)
    }
    _nbind.makeMethodCaller = makeMethodCaller;

    function makeCaller(spec) {
        var argCount = spec.typeList.length - 1;
        var typeList = _nbind.getTypes(spec.typeList, spec.title);
        var returnType = typeList[0];
        var argTypeList = typeList.slice(1);
        var needsWireRead = returnType.needsWireRead(spec.policyTbl);
        var needsWireWrite = anyNeedsWireWrite(argTypeList, spec.policyTbl);
        var direct = spec.direct;
        var dynCall;
        var ptr = spec.ptr;
        if (spec.direct && !needsWireRead && !needsWireWrite) {
            dynCall = _nbind.getDynCall(typeList, spec.title);
            switch (argCount) {
                case 0:
                    return (function() {
                        return dynCall(direct)
                    });
                case 1:
                    return (function(a1) {
                        return dynCall(direct, a1)
                    });
                case 2:
                    return (function(a1, a2) {
                        return dynCall(direct, a1, a2)
                    });
                case 3:
                    return (function(a1, a2, a3) {
                        return dynCall(direct, a1, a2, a3)
                    });
                default:
                    break
            }
            ptr = 0
        }
        var prefix;
        if (ptr) {
            var typeIdList = spec.typeList.slice(0);
            typeIdList.splice(1, 0, "uint32_t");
            typeList = _nbind.getTypes(typeIdList, spec.title);
            prefix = "ptr,num"
        } else {
            ptr = direct;
            prefix = "ptr"
        }
        dynCall = _nbind.getDynCall(typeList, spec.title);
        return buildCallerFunction(dynCall, null, ptr, spec.num, spec.policyTbl, needsWireWrite, prefix, returnType, argTypeList)
    }
    _nbind.makeCaller = makeCaller;

    function makeOverloader(func, arity) {
        var callerList = [];

        function call() {
            return callerList[arguments.length].apply(this, arguments)
        }
        call.addMethod = (function(_func, _arity) {
            callerList[_arity] = _func
        });
        call.addMethod(func, arity);
        return call
    }
    _nbind.makeOverloader = makeOverloader;
    var Resource = (function() {
        function Resource(open, close) {
            var _this = this;
            this.makeOpen = (function() {
                return Object.keys(_this.openTbl).join("")
            });
            this.makeClose = (function() {
                return Object.keys(_this.closeTbl).join("")
            });
            this.openTbl = {};
            this.closeTbl = {};
            if (open) this.openTbl[open] = true;
            if (close) this.closeTbl[close] = true
        }
        Resource.prototype.add = (function(other) {
            for (var _i = 0, _a = Object.keys(other.openTbl); _i < _a.length; _i++) {
                var key = _a[_i];
                this.openTbl[key] = true
            }
            for (var _b = 0, _c = Object.keys(other.closeTbl); _b < _c.length; _b++) {
                var key = _c[_b];
                this.closeTbl[key] = true
            }
        });
        Resource.prototype.remove = (function(other) {
            for (var _i = 0, _a = Object.keys(other.openTbl); _i < _a.length; _i++) {
                var key = _a[_i];
                delete this.openTbl[key]
            }
            for (var _b = 0, _c = Object.keys(other.closeTbl); _b < _c.length; _b++) {
                var key = _c[_b];
                delete this.closeTbl[key]
            }
        });
        return Resource
    })();
    _nbind.Resource = Resource;

    function listResources(readList, writeList) {
        var result = new Resource;
        for (var _i = 0, readList_1 = readList; _i < readList_1.length; _i++) {
            var bindType = readList_1[_i];
            for (var _a = 0, _b = bindType.readResources || []; _a < _b.length; _a++) {
                var resource = _b[_a];
                result.add(resource)
            }
        }
        for (var _c = 0, writeList_1 = writeList; _c < writeList_1.length; _c++) {
            var bindType = writeList_1[_c];
            for (var _d = 0, _e = bindType.writeResources || []; _d < _e.length; _d++) {
                var resource = _e[_d];
                result.add(resource)
            }
        }
        return result
    }
    _nbind.listResources = listResources;
    _nbind.resources = {
        pool: new Resource("var used=HEAPU32[_nbind.Pool.usedPtr],page=HEAPU32[_nbind.Pool.pagePtr];", "_nbind.Pool.lreset(used,page);")
    };
    var ExternalBuffer = (function(_super) {
        __extends(ExternalBuffer, _super);

        function ExternalBuffer(buf, ptr) {
            var _this = _super.call(this, buf) || this;
            _this.ptr = ptr;
            return _this
        }
        ExternalBuffer.prototype.free = (function() {
            _free(this.ptr)
        });
        return ExternalBuffer
    })(_nbind.External);

    function getBuffer(buf) {
        if (buf instanceof ArrayBuffer) {
            return new Uint8Array(buf)
        } else if (buf instanceof DataView) {
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        } else return buf
    }

    function pushBuffer(buf, policyTbl) {
        if (buf === null || buf === undefined) {
            if (policyTbl && policyTbl["Nullable"]) buf = []
        }
        if (typeof buf != "object") throw new Error("Type mismatch");
        var b = buf;
        var length = b.byteLength || b.length;
        if (!length && length !== 0 && b.byteLength !== 0) throw new Error("Type mismatch");
        var result = _nbind.Pool.lalloc(8);
        var data = _malloc(length);
        var ptr = result / 4;
        HEAPU32[ptr++] = length;
        HEAPU32[ptr++] = data;
        HEAPU32[ptr++] = (new ExternalBuffer(buf, data)).register();
        HEAPU8.set(getBuffer(buf), data);
        return result
    }
    var BufferType = (function(_super) {
        __extends(BufferType, _super);

        function BufferType() {
            var _this = _super !== null && _super.apply(this, arguments) || this;
            _this.wireWrite = pushBuffer;
            _this.readResources = [_nbind.resources.pool];
            _this.writeResources = [_nbind.resources.pool];
            return _this
        }
        BufferType.prototype.makeWireWrite = (function(expr, policyTbl) {
            return (function(arg) {
                return pushBuffer(arg, policyTbl)
            })
        });
        return BufferType
    })(_nbind.BindType);
    _nbind.BufferType = BufferType;

    function commitBuffer(num, data, length) {
        var buf = _nbind.externalList[num].data;
        var NodeBuffer = Buffer;
        if (typeof Buffer != "function") NodeBuffer = (function() {});
        if (buf instanceof Array) {} else {
            var src = HEAPU8.subarray(data, data + length);
            if (buf instanceof NodeBuffer) {
                var srcBuf = void 0;
                if (typeof Buffer.from == "function" && Buffer.from.length >= 3) {
                    srcBuf = Buffer.from(src)
                } else srcBuf = new Buffer(src);
                srcBuf.copy(buf)
            } else getBuffer(buf).set(src)
        }
    }
    _nbind.commitBuffer = commitBuffer;
    var dirtyList = [];
    var gcTimer = 0;

    function sweep() {
        for (var _i = 0, dirtyList_1 = dirtyList; _i < dirtyList_1.length; _i++) {
            var obj = dirtyList_1[_i];
            if (!(obj.__nbindState & (1 | 2))) {
                obj.free()
            }
        }
        dirtyList = [];
        gcTimer = 0
    }
    _nbind.mark = (function(obj) {});

    function toggleLightGC(enable) {
        if (enable) {
            _nbind.mark = (function(obj) {
                dirtyList.push(obj);
                if (!gcTimer) gcTimer = setTimeout(sweep, 0)
            })
        } else {
            _nbind.mark = (function(obj) {})
        }
    }
    _nbind.toggleLightGC = toggleLightGC
}))(_nbind);
DYNAMICTOP_PTR = staticAlloc(4);
STACK_BASE = STACKTOP = alignMemory(STATICTOP);
STACK_MAX = STACK_BASE + TOTAL_STACK;
DYNAMIC_BASE = alignMemory(STACK_MAX);
HEAP32[DYNAMICTOP_PTR >> 2] = DYNAMIC_BASE;
staticSealed = true;
Module["wasmTableSize"] = 89;
Module["wasmMaxTableSize"] = 89;
Module.asmGlobalArg = {};
Module.asmLibraryArg = {
    "abort": abort,
    "enlargeMemory": enlargeMemory,
    "getTotalMemory": getTotalMemory,
    "abortOnCannotGrowMemory": abortOnCannotGrowMemory,
    "___assert_fail": ___assert_fail,
    "___setErrNo": ___setErrNo,
    "__nbind_finish": __nbind_finish,
    "__nbind_free_external": __nbind_free_external,
    "__nbind_get_value_object": __nbind_get_value_object,
    "__nbind_reference_external": __nbind_reference_external,
    "__nbind_register_callback_signature": __nbind_register_callback_signature,
    "__nbind_register_class": __nbind_register_class,
    "__nbind_register_function": __nbind_register_function,
    "__nbind_register_pool": __nbind_register_pool,
    "__nbind_register_primitive": __nbind_register_primitive,
    "__nbind_register_type": __nbind_register_type,
    "_abort": _abort,
    "_emscripten_asm_const_iiii": _emscripten_asm_const_iiii,
    "_emscripten_asm_const_iiiii": _emscripten_asm_const_iiiii,
    "_emscripten_asm_const_iiiiii": _emscripten_asm_const_iiiiii,
    "_emscripten_asm_const_iiiiiiii": _emscripten_asm_const_iiiiiiii,
    "_emscripten_memcpy_big": _emscripten_memcpy_big,
    "_llvm_stackrestore": _llvm_stackrestore,
    "_llvm_stacksave": _llvm_stacksave,
    "DYNAMICTOP_PTR": DYNAMICTOP_PTR,
    "STACKTOP": STACKTOP
};
var asm = Module["asm"](Module.asmGlobalArg, Module.asmLibraryArg, buffer);
Module["asm"] = asm;
var __GLOBAL__sub_I_Binding_cc = Module["__GLOBAL__sub_I_Binding_cc"] = (function() {
    return Module["asm"]["__GLOBAL__sub_I_Binding_cc"].apply(null, arguments)
});
var __GLOBAL__sub_I_common_cc = Module["__GLOBAL__sub_I_common_cc"] = (function() {
    return Module["asm"]["__GLOBAL__sub_I_common_cc"].apply(null, arguments)
});
var __GLOBAL__sub_I_fpzip_interface_cpp = Module["__GLOBAL__sub_I_fpzip_interface_cpp"] = (function() {
    return Module["asm"]["__GLOBAL__sub_I_fpzip_interface_cpp"].apply(null, arguments)
});
var _free = Module["_free"] = (function() {
    return Module["asm"]["_free"].apply(null, arguments)
});
var _malloc = Module["_malloc"] = (function() {
    return Module["asm"]["_malloc"].apply(null, arguments)
});
var _nbind_init = Module["_nbind_init"] = (function() {
    return Module["asm"]["_nbind_init"].apply(null, arguments)
});
var stackRestore = Module["stackRestore"] = (function() {
    return Module["asm"]["stackRestore"].apply(null, arguments)
});
var stackSave = Module["stackSave"] = (function() {
    return Module["asm"]["stackSave"].apply(null, arguments)
});
var dynCall_i = Module["dynCall_i"] = (function() {
    return Module["asm"]["dynCall_i"].apply(null, arguments)
});
var dynCall_ii = Module["dynCall_ii"] = (function() {
    return Module["asm"]["dynCall_ii"].apply(null, arguments)
});
var dynCall_iii = Module["dynCall_iii"] = (function() {
    return Module["asm"]["dynCall_iii"].apply(null, arguments)
});
var dynCall_iiii = Module["dynCall_iiii"] = (function() {
    return Module["asm"]["dynCall_iiii"].apply(null, arguments)
});
var dynCall_v = Module["dynCall_v"] = (function() {
    return Module["asm"]["dynCall_v"].apply(null, arguments)
});
var dynCall_vi = Module["dynCall_vi"] = (function() {
    return Module["asm"]["dynCall_vi"].apply(null, arguments)
});
var dynCall_vii = Module["dynCall_vii"] = (function() {
    return Module["asm"]["dynCall_vii"].apply(null, arguments)
});
var dynCall_viii = Module["dynCall_viii"] = (function() {
    return Module["asm"]["dynCall_viii"].apply(null, arguments)
});
var dynCall_viiii = Module["dynCall_viiii"] = (function() {
    return Module["asm"]["dynCall_viiii"].apply(null, arguments)
});
var dynCall_viiiii = Module["dynCall_viiiii"] = (function() {
    return Module["asm"]["dynCall_viiiii"].apply(null, arguments)
});
var dynCall_viiiiii = Module["dynCall_viiiiii"] = (function() {
    return Module["asm"]["dynCall_viiiiii"].apply(null, arguments)
});
Module["asm"] = asm;

function ExitStatus(status) {
    this.name = "ExitStatus";
    this.message = "Program terminated with exit(" + status + ")";
    this.status = status
}
ExitStatus.prototype = new Error;
ExitStatus.prototype.constructor = ExitStatus;
var initialStackTop;
dependenciesFulfilled = function runCaller() {
    if (!Module["calledRun"]) run();
    if (!Module["calledRun"]) dependenciesFulfilled = runCaller
};

function run(args) {
    args = args || Module["arguments"];
    if (runDependencies > 0) {
        return
    }
    preRun();
    if (runDependencies > 0) return;
    if (Module["calledRun"]) return;

    function doRun() {
        if (Module["calledRun"]) return;
        Module["calledRun"] = true;
        if (ABORT) return;
        ensureInitRuntime();
        preMain();
        if (Module["onRuntimeInitialized"]) Module["onRuntimeInitialized"]();
        postRun()
    }
    if (Module["setStatus"]) {
        Module["setStatus"]("Running...");
        setTimeout((function() {
            setTimeout((function() {
                Module["setStatus"]("")
            }), 1);
            doRun()
        }), 1)
    } else {
        doRun()
    }
}
Module["run"] = run;

function exit(status, implicit) {
    if (implicit && Module["noExitRuntime"] && status === 0) {
        return
    }
    if (Module["noExitRuntime"]) {} else {
        ABORT = true;
        EXITSTATUS = status;
        STACKTOP = initialStackTop;
        exitRuntime();
        if (Module["onExit"]) Module["onExit"](status)
    }
    if (ENVIRONMENT_IS_NODE) {
        process["exit"](status)
    }
    Module["quit"](status, new ExitStatus(status))
}
Module["exit"] = exit;

function abort(what) {
    if (Module["onAbort"]) {
        Module["onAbort"](what)
    }
    if (what !== undefined) {
        Module.print(what);
        Module.printErr(what);
        what = JSON.stringify(what)
    } else {
        what = ""
    }
    ABORT = true;
    EXITSTATUS = 1;
    throw "abort(" + what + "). Build with -s ASSERTIONS=1 for more info."
}
Module["abort"] = abort;
if (Module["preInit"]) {
    if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
    while (Module["preInit"].length > 0) {
        Module["preInit"].pop()()
    }
}
Module["noExitRuntime"] = true;
run()