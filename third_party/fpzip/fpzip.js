// Note: For maximum-speed code, see "Optimizing Code" on the Emscripten wiki, https://github.com/kripken/emscripten/wiki/Optimizing-Code
// Note: Some Emscripten settings may limit the speed of the generated code.
// The Module object: Our interface to the outside world. We import
// and export values on it, and do the work to get that through
// closure compiler if necessary. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(Module) { ..generated code.. }
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to do an eval in order to handle the closure compiler
// case, where this code here is minified but Module was defined
// elsewhere (e.g. case 4 above). We also need to check if Module
// already exists (e.g. case 3 above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module;
if (!Module) Module = eval('(function() { try { return Module || {} } catch(e) { return {} } })()');

// Sometimes an existing Module object exists with properties
// meant to overwrite the default module functionality. Here
// we collect those properties and reapply _after_ we configure
// the current environment's defaults to avoid having to be so
// defensive during initialization.
var moduleOverrides = {};
for (var key in Module) {
  if (Module.hasOwnProperty(key)) {
    moduleOverrides[key] = Module[key];
  }
}

// The environment setup code below is customized to use Module.
// *** Environment setup code ***
var ENVIRONMENT_IS_NODE = typeof process === 'object' && typeof require === 'function';
var ENVIRONMENT_IS_WEB = typeof window === 'object';
var ENVIRONMENT_IS_WORKER = typeof importScripts === 'function';
var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

if (ENVIRONMENT_IS_NODE) {
  // Expose functionality in the same simple way that the shells work
  // Note that we pollute the global namespace here, otherwise we break in node
  if (!Module['print']) Module['print'] = function print(x) {
    process['stdout'].write(x + '\n');
  };
  if (!Module['printErr']) Module['printErr'] = function printErr(x) {
    process['stderr'].write(x + '\n');
  };

  var nodeFS = require('fs');
  var nodePath = require('path');

  Module['read'] = function read(filename, binary) {
    filename = nodePath['normalize'](filename);
    var ret = nodeFS['readFileSync'](filename);
    // The path is absolute if the normalized version is the same as the resolved.
    if (!ret && filename != nodePath['resolve'](filename)) {
      filename = path.join(__dirname, '..', 'src', filename);
      ret = nodeFS['readFileSync'](filename);
    }
    if (ret && !binary) ret = ret.toString();
    return ret;
  };

  Module['readBinary'] = function readBinary(filename) { return Module['read'](filename, true) };

  Module['load'] = function load(f) {
    globalEval(read(f));
  };

  Module['arguments'] = process['argv'].slice(2);

  module['exports'] = Module;
}
else if (ENVIRONMENT_IS_SHELL) {
  if (!Module['print']) Module['print'] = print;
  if (typeof printErr != 'undefined') Module['printErr'] = printErr; // not present in v8 or older sm

  if (typeof read != 'undefined') {
    Module['read'] = read;
  } else {
    Module['read'] = function read() { throw 'no read() available (jsc?)' };
  }

  Module['readBinary'] = function readBinary(f) {
    return read(f, 'binary');
  };

  if (typeof scriptArgs != 'undefined') {
    Module['arguments'] = scriptArgs;
  } else if (typeof arguments != 'undefined') {
    Module['arguments'] = arguments;
  }

  this['Module'] = Module;

  eval("if (typeof gc === 'function' && gc.toString().indexOf('[native code]') > 0) var gc = undefined"); // wipe out the SpiderMonkey shell 'gc' function, which can confuse closure (uses it as a minified name, and it is then initted to a non-falsey value unexpectedly)
}
else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  Module['read'] = function read(url) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send(null);
    return xhr.responseText;
  };

  if (typeof arguments != 'undefined') {
    Module['arguments'] = arguments;
  }

  if (typeof console !== 'undefined') {
    if (!Module['print']) Module['print'] = function print(x) {
      console.log(x);
    };
    if (!Module['printErr']) Module['printErr'] = function printErr(x) {
      console.log(x);
    };
  } else {
    // Probably a worker, and without console.log. We can do very little here...
    var TRY_USE_DUMP = false;
    if (!Module['print']) Module['print'] = (TRY_USE_DUMP && (typeof(dump) !== "undefined") ? (function(x) {
      dump(x);
    }) : (function(x) {
      // self.postMessage(x); // enable this if you want stdout to be sent as messages
    }));
  }

  if (ENVIRONMENT_IS_WEB) {
    this['Module'] = Module;
  } else {
    Module['load'] = importScripts;
  }
}
else {
  // Unreachable because SHELL is dependant on the others
  throw 'Unknown runtime environment. Where are we?';
}

function globalEval(x) {
  eval.call(null, x);
}
if (!Module['load'] == 'undefined' && Module['read']) {
  Module['load'] = function load(f) {
    globalEval(Module['read'](f));
  };
}
if (!Module['print']) {
  Module['print'] = function(){};
}
if (!Module['printErr']) {
  Module['printErr'] = Module['print'];
}
if (!Module['arguments']) {
  Module['arguments'] = [];
}
// *** Environment setup code ***

// Closure helpers
Module.print = Module['print'];
Module.printErr = Module['printErr'];

// Callbacks
Module['preRun'] = [];
Module['postRun'] = [];

// Merge back in the overrides
for (var key in moduleOverrides) {
  if (moduleOverrides.hasOwnProperty(key)) {
    Module[key] = moduleOverrides[key];
  }
}



// === Auto-generated preamble library stuff ===

//========================================
// Runtime code shared with compiler
//========================================

var Runtime = {
  stackSave: function() {
    return STACKTOP;
  },
  stackRestore: function(stackTop) {
    STACKTOP = stackTop;
  },
  forceAlign: function(target, quantum) {
    quantum = quantum || 4;
    if (quantum == 1) return target;
    if (isNumber(target) && isNumber(quantum)) {
      return Math.ceil(target/quantum)*quantum;
    } else if (isNumber(quantum) && isPowerOfTwo(quantum)) {
      return '(((' +target + ')+' + (quantum-1) + ')&' + -quantum + ')';
    }
    return 'Math.ceil((' + target + ')/' + quantum + ')*' + quantum;
  },
  isNumberType: function(type) {
    return type in Runtime.INT_TYPES || type in Runtime.FLOAT_TYPES;
  },
  isPointerType: function isPointerType(type) {
  return type[type.length-1] == '*';
},
  isStructType: function isStructType(type) {
  if (isPointerType(type)) return false;
  if (isArrayType(type)) return true;
  if (/<?{ ?[^}]* ?}>?/.test(type)) return true; // { i32, i8 } etc. - anonymous struct types
  // See comment in isStructPointerType()
  return type[0] == '%';
},
  INT_TYPES: {"i1":0,"i8":0,"i16":0,"i32":0,"i64":0},
  FLOAT_TYPES: {"float":0,"double":0},
  or64: function(x, y) {
    var l = (x | 0) | (y | 0);
    var h = (Math.round(x / 4294967296) | Math.round(y / 4294967296)) * 4294967296;
    return l + h;
  },
  and64: function(x, y) {
    var l = (x | 0) & (y | 0);
    var h = (Math.round(x / 4294967296) & Math.round(y / 4294967296)) * 4294967296;
    return l + h;
  },
  xor64: function(x, y) {
    var l = (x | 0) ^ (y | 0);
    var h = (Math.round(x / 4294967296) ^ Math.round(y / 4294967296)) * 4294967296;
    return l + h;
  },
  getNativeTypeSize: function(type) {
    switch (type) {
      case 'i1': case 'i8': return 1;
      case 'i16': return 2;
      case 'i32': return 4;
      case 'i64': return 8;
      case 'float': return 4;
      case 'double': return 8;
      default: {
        if (type[type.length-1] === '*') {
          return Runtime.QUANTUM_SIZE; // A pointer
        } else if (type[0] === 'i') {
          var bits = parseInt(type.substr(1));
          assert(bits % 8 === 0);
          return bits/8;
        } else {
          return 0;
        }
      }
    }
  },
  getNativeFieldSize: function(type) {
    return Math.max(Runtime.getNativeTypeSize(type), Runtime.QUANTUM_SIZE);
  },
  dedup: function dedup(items, ident) {
  var seen = {};
  if (ident) {
    return items.filter(function(item) {
      if (seen[item[ident]]) return false;
      seen[item[ident]] = true;
      return true;
    });
  } else {
    return items.filter(function(item) {
      if (seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }
},
  set: function set() {
  var args = typeof arguments[0] === 'object' ? arguments[0] : arguments;
  var ret = {};
  for (var i = 0; i < args.length; i++) {
    ret[args[i]] = 0;
  }
  return ret;
},
  STACK_ALIGN: 8,
  getAlignSize: function(type, size, vararg) {
    // we align i64s and doubles on 64-bit boundaries, unlike x86
    if (vararg) return 8;
    if (!vararg && (type == 'i64' || type == 'double')) return 8;
    if (!type) return Math.min(size, 8); // align structures internally to 64 bits
    return Math.min(size || (type ? Runtime.getNativeFieldSize(type) : 0), Runtime.QUANTUM_SIZE);
  },
  calculateStructAlignment: function calculateStructAlignment(type) {
    type.flatSize = 0;
    type.alignSize = 0;
    var diffs = [];
    var prev = -1;
    var index = 0;
    type.flatIndexes = type.fields.map(function(field) {
      index++;
      var size, alignSize;
      if (Runtime.isNumberType(field) || Runtime.isPointerType(field)) {
        size = Runtime.getNativeTypeSize(field); // pack char; char; in structs, also char[X]s.
        alignSize = Runtime.getAlignSize(field, size);
      } else if (Runtime.isStructType(field)) {
        if (field[1] === '0') {
          // this is [0 x something]. When inside another structure like here, it must be at the end,
          // and it adds no size
          // XXX this happens in java-nbody for example... assert(index === type.fields.length, 'zero-length in the middle!');
          size = 0;
          if (Types.types[field]) {
            alignSize = Runtime.getAlignSize(null, Types.types[field].alignSize);
          } else {
            alignSize = type.alignSize || QUANTUM_SIZE;
          }
        } else {
          size = Types.types[field].flatSize;
          alignSize = Runtime.getAlignSize(null, Types.types[field].alignSize);
        }
      } else if (field[0] == 'b') {
        // bN, large number field, like a [N x i8]
        size = field.substr(1)|0;
        alignSize = 1;
      } else if (field[0] === '<') {
        // vector type
        size = alignSize = Types.types[field].flatSize; // fully aligned
      } else if (field[0] === 'i') {
        // illegal integer field, that could not be legalized because it is an internal structure field
        // it is ok to have such fields, if we just use them as markers of field size and nothing more complex
        size = alignSize = parseInt(field.substr(1))/8;
        assert(size % 1 === 0, 'cannot handle non-byte-size field ' + field);
      } else {
        assert(false, 'invalid type for calculateStructAlignment');
      }
      if (type.packed) alignSize = 1;
      type.alignSize = Math.max(type.alignSize, alignSize);
      var curr = Runtime.alignMemory(type.flatSize, alignSize); // if necessary, place this on aligned memory
      type.flatSize = curr + size;
      if (prev >= 0) {
        diffs.push(curr-prev);
      }
      prev = curr;
      return curr;
    });
    if (type.name_ && type.name_[0] === '[') {
      // arrays have 2 elements, so we get the proper difference. then we scale here. that way we avoid
      // allocating a potentially huge array for [999999 x i8] etc.
      type.flatSize = parseInt(type.name_.substr(1))*type.flatSize/2;
    }
    type.flatSize = Runtime.alignMemory(type.flatSize, type.alignSize);
    if (diffs.length == 0) {
      type.flatFactor = type.flatSize;
    } else if (Runtime.dedup(diffs).length == 1) {
      type.flatFactor = diffs[0];
    }
    type.needsFlattening = (type.flatFactor != 1);
    return type.flatIndexes;
  },
  generateStructInfo: function(struct, typeName, offset) {
    var type, alignment;
    if (typeName) {
      offset = offset || 0;
      type = (typeof Types === 'undefined' ? Runtime.typeInfo : Types.types)[typeName];
      if (!type) return null;
      if (type.fields.length != struct.length) {
        printErr('Number of named fields must match the type for ' + typeName + ': possibly duplicate struct names. Cannot return structInfo');
        return null;
      }
      alignment = type.flatIndexes;
    } else {
      var type = { fields: struct.map(function(item) { return item[0] }) };
      alignment = Runtime.calculateStructAlignment(type);
    }
    var ret = {
      __size__: type.flatSize
    };
    if (typeName) {
      struct.forEach(function(item, i) {
        if (typeof item === 'string') {
          ret[item] = alignment[i] + offset;
        } else {
          // embedded struct
          var key;
          for (var k in item) key = k;
          ret[key] = Runtime.generateStructInfo(item[key], type.fields[i], alignment[i]);
        }
      });
    } else {
      struct.forEach(function(item, i) {
        ret[item[1]] = alignment[i];
      });
    }
    return ret;
  },
  dynCall: function(sig, ptr, args) {
    if (args && args.length) {
      return FUNCTION_TABLE[ptr].apply(null, args);
    } else {
      return FUNCTION_TABLE[ptr]();
    }
  },
  addFunction: function(func) {
    var table = FUNCTION_TABLE;
    var ret = table.length;
    assert(ret % 2 === 0);
    table.push(func);
    for (var i = 0; i < 2-1; i++) table.push(0);
    return ret;
  },
  removeFunction: function(index) {
    var table = FUNCTION_TABLE;
    table[index] = null;
  },
  getAsmConst: function(code, numArgs) {
    // code is a constant string on the heap, so we can cache these
    if (!Runtime.asmConstCache) Runtime.asmConstCache = {};
    var func = Runtime.asmConstCache[code];
    if (func) return func;
    var args = [];
    for (var i = 0; i < numArgs; i++) {
      args.push(String.fromCharCode(36) + i); // $0, $1 etc
    }
    code = Pointer_stringify(code);
    if (code[0] === '"') {
      // tolerate EM_ASM("..code..") even though EM_ASM(..code..) is correct
      if (code.indexOf('"', 1) === code.length-1) {
        code = code.substr(1, code.length-2);
      } else {
        // something invalid happened, e.g. EM_ASM("..code($0)..", input)
        abort('invalid EM_ASM input |' + code + '|. Please use EM_ASM(..code..) (no quotes) or EM_ASM({ ..code($0).. }, input) (to input values)');
      }
    }
    return Runtime.asmConstCache[code] = eval('(function(' + args.join(',') + '){ ' + code + ' })'); // new Function does not allow upvars in node
  },
  warnOnce: function(text) {
    if (!Runtime.warnOnce.shown) Runtime.warnOnce.shown = {};
    if (!Runtime.warnOnce.shown[text]) {
      Runtime.warnOnce.shown[text] = 1;
      Module.printErr(text);
    }
  },
  funcWrappers: {},
  getFuncWrapper: function(func, sig) {
    assert(sig);
    if (!Runtime.funcWrappers[func]) {
      Runtime.funcWrappers[func] = function dynCall_wrapper() {
        return Runtime.dynCall(sig, func, arguments);
      };
    }
    return Runtime.funcWrappers[func];
  },
  UTF8Processor: function() {
    var buffer = [];
    var needed = 0;
    this.processCChar = function (code) {
      code = code & 0xFF;

      if (buffer.length == 0) {
        if ((code & 0x80) == 0x00) {        // 0xxxxxxx
          return String.fromCharCode(code);
        }
        buffer.push(code);
        if ((code & 0xE0) == 0xC0) {        // 110xxxxx
          needed = 1;
        } else if ((code & 0xF0) == 0xE0) { // 1110xxxx
          needed = 2;
        } else {                            // 11110xxx
          needed = 3;
        }
        return '';
      }

      if (needed) {
        buffer.push(code);
        needed--;
        if (needed > 0) return '';
      }

      var c1 = buffer[0];
      var c2 = buffer[1];
      var c3 = buffer[2];
      var c4 = buffer[3];
      var ret;
      if (buffer.length == 2) {
        ret = String.fromCharCode(((c1 & 0x1F) << 6)  | (c2 & 0x3F));
      } else if (buffer.length == 3) {
        ret = String.fromCharCode(((c1 & 0x0F) << 12) | ((c2 & 0x3F) << 6)  | (c3 & 0x3F));
      } else {
        // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
        var codePoint = ((c1 & 0x07) << 18) | ((c2 & 0x3F) << 12) |
                        ((c3 & 0x3F) << 6)  | (c4 & 0x3F);
        ret = String.fromCharCode(
          Math.floor((codePoint - 0x10000) / 0x400) + 0xD800,
          (codePoint - 0x10000) % 0x400 + 0xDC00);
      }
      buffer.length = 0;
      return ret;
    }
    this.processJSString = function processJSString(string) {
      string = unescape(encodeURIComponent(string));
      var ret = [];
      for (var i = 0; i < string.length; i++) {
        ret.push(string.charCodeAt(i));
      }
      return ret;
    }
  },
  stackAlloc: function(size) { var ret = STACKTOP;STACKTOP = (STACKTOP + size)|0;STACKTOP = (((STACKTOP)+7)&-8); return ret; },
  staticAlloc: function(size) { var ret = STATICTOP;STATICTOP = (STATICTOP + size)|0;STATICTOP = (((STATICTOP)+7)&-8); return ret; },
  dynamicAlloc: function(size) { var ret = DYNAMICTOP;DYNAMICTOP = (DYNAMICTOP + size)|0;DYNAMICTOP = (((DYNAMICTOP)+7)&-8); if (DYNAMICTOP >= TOTAL_MEMORY) enlargeMemory();; return ret; },
  alignMemory: function(size,quantum) { var ret = size = Math.ceil((size)/(quantum ? quantum : 8))*(quantum ? quantum : 8); return ret; },
  makeBigInt: function(low,high,unsigned) { var ret = (unsigned ? ((low>>>0)+((high>>>0)*4294967296)) : ((low>>>0)+((high|0)*4294967296))); return ret; },
  GLOBAL_BASE: 8,
  QUANTUM_SIZE: 4,
  __dummy__: 0
}


Module['Runtime'] = Runtime;









//========================================
// Runtime essentials
//========================================

var __THREW__ = 0; // Used in checking for thrown exceptions.
var setjmpId = 1; // Used in setjmp/longjmp
var setjmpLabels = {};

var ABORT = false; // whether we are quitting the application. no code should run after this. set in exit() and abort()
var EXITSTATUS = 0;

var undef = 0;
// tempInt is used for 32-bit signed values or smaller. tempBigInt is used
// for 32-bit unsigned values or more than 32 bits. TODO: audit all uses of tempInt
var tempValue, tempInt, tempBigInt, tempInt2, tempBigInt2, tempPair, tempBigIntI, tempBigIntR, tempBigIntS, tempBigIntP, tempBigIntD, tempDouble, tempFloat;
var tempI64, tempI64b;
var tempRet0, tempRet1, tempRet2, tempRet3, tempRet4, tempRet5, tempRet6, tempRet7, tempRet8, tempRet9;

function assert(condition, text) {
  if (!condition) {
    abort('Assertion failed: ' + text);
  }
}

var globalScope = this;

// C calling interface. A convenient way to call C functions (in C files, or
// defined with extern "C").
//
// Note: LLVM optimizations can inline and remove functions, after which you will not be
//       able to call them. Closure can also do so. To avoid that, add your function to
//       the exports using something like
//
//         -s EXPORTED_FUNCTIONS='["_main", "_myfunc"]'
//
// @param ident      The name of the C function (note that C++ functions will be name-mangled - use extern "C")
// @param returnType The return type of the function, one of the JS types 'number', 'string' or 'array' (use 'number' for any C pointer, and
//                   'array' for JavaScript arrays and typed arrays; note that arrays are 8-bit).
// @param argTypes   An array of the types of arguments for the function (if there are no arguments, this can be ommitted). Types are as in returnType,
//                   except that 'array' is not possible (there is no way for us to know the length of the array)
// @param args       An array of the arguments to the function, as native JS values (as in returnType)
//                   Note that string arguments will be stored on the stack (the JS string will become a C string on the stack).
// @return           The return value, as a native JS value (as in returnType)
function ccall(ident, returnType, argTypes, args) {
  return ccallFunc(getCFunc(ident), returnType, argTypes, args);
}
Module["ccall"] = ccall;

// Returns the C function with a specified identifier (for C++, you need to do manual name mangling)
function getCFunc(ident) {
  try {
    var func = Module['_' + ident]; // closure exported function
    if (!func) func = eval('_' + ident); // explicit lookup
  } catch(e) {
  }
  assert(func, 'Cannot call unknown function ' + ident + ' (perhaps LLVM optimizations or closure removed it?)');
  return func;
}

// Internal function that does a C call using a function, not an identifier
function ccallFunc(func, returnType, argTypes, args) {
  var stack = 0;
  function toC(value, type) {
    if (type == 'string') {
      if (value === null || value === undefined || value === 0) return 0; // null string
      value = intArrayFromString(value);
      type = 'array';
    }
    if (type == 'array') {
      if (!stack) stack = Runtime.stackSave();
      var ret = Runtime.stackAlloc(value.length);
      writeArrayToMemory(value, ret);
      return ret;
    }
    return value;
  }
  function fromC(value, type) {
    if (type == 'string') {
      return Pointer_stringify(value);
    }
    assert(type != 'array');
    return value;
  }
  var i = 0;
  var cArgs = args ? args.map(function(arg) {
    return toC(arg, argTypes[i++]);
  }) : [];
  var ret = fromC(func.apply(null, cArgs), returnType);
  if (stack) Runtime.stackRestore(stack);
  return ret;
}

// Returns a native JS wrapper for a C function. This is similar to ccall, but
// returns a function you can call repeatedly in a normal way. For example:
//
//   var my_function = cwrap('my_c_function', 'number', ['number', 'number']);
//   alert(my_function(5, 22));
//   alert(my_function(99, 12));
//
function cwrap(ident, returnType, argTypes) {
  var func = getCFunc(ident);
  return function() {
    return ccallFunc(func, returnType, argTypes, Array.prototype.slice.call(arguments));
  }
}
Module["cwrap"] = cwrap;

// Sets a value in memory in a dynamic way at run-time. Uses the
// type data. This is the same as makeSetValue, except that
// makeSetValue is done at compile-time and generates the needed
// code then, whereas this function picks the right code at
// run-time.
// Note that setValue and getValue only do *aligned* writes and reads!
// Note that ccall uses JS types as for defining types, while setValue and
// getValue need LLVM types ('i8', 'i32') - this is a lower-level operation
function setValue(ptr, value, type, noSafe) {
  type = type || 'i8';
  if (type.charAt(type.length-1) === '*') type = 'i32'; // pointers are 32-bit
    switch(type) {
      case 'i1': HEAP8[(ptr)]=value; break;
      case 'i8': HEAP8[(ptr)]=value; break;
      case 'i16': HEAP16[((ptr)>>1)]=value; break;
      case 'i32': HEAP32[((ptr)>>2)]=value; break;
      case 'i64': (tempI64 = [value>>>0,(tempDouble=value,Math_abs(tempDouble) >= 1 ? (tempDouble > 0 ? Math_min(Math_floor((tempDouble)/4294967296), 4294967295)>>>0 : (~~(Math_ceil((tempDouble - +(((~~(tempDouble)))>>>0))/4294967296)))>>>0) : 0)],HEAP32[((ptr)>>2)]=tempI64[0],HEAP32[(((ptr)+(4))>>2)]=tempI64[1]); break;
      case 'float': HEAPF32[((ptr)>>2)]=value; break;
      case 'double': HEAPF64[((ptr)>>3)]=value; break;
      default: abort('invalid type for setValue: ' + type);
    }
}
Module['setValue'] = setValue;

// Parallel to setValue.
function getValue(ptr, type, noSafe) {
  type = type || 'i8';
  if (type.charAt(type.length-1) === '*') type = 'i32'; // pointers are 32-bit
    switch(type) {
      case 'i1': return HEAP8[(ptr)];
      case 'i8': return HEAP8[(ptr)];
      case 'i16': return HEAP16[((ptr)>>1)];
      case 'i32': return HEAP32[((ptr)>>2)];
      case 'i64': return HEAP32[((ptr)>>2)];
      case 'float': return HEAPF32[((ptr)>>2)];
      case 'double': return HEAPF64[((ptr)>>3)];
      default: abort('invalid type for setValue: ' + type);
    }
  return null;
}
Module['getValue'] = getValue;

var ALLOC_NORMAL = 0; // Tries to use _malloc()
var ALLOC_STACK = 1; // Lives for the duration of the current function call
var ALLOC_STATIC = 2; // Cannot be freed
var ALLOC_DYNAMIC = 3; // Cannot be freed except through sbrk
var ALLOC_NONE = 4; // Do not allocate
Module['ALLOC_NORMAL'] = ALLOC_NORMAL;
Module['ALLOC_STACK'] = ALLOC_STACK;
Module['ALLOC_STATIC'] = ALLOC_STATIC;
Module['ALLOC_DYNAMIC'] = ALLOC_DYNAMIC;
Module['ALLOC_NONE'] = ALLOC_NONE;

// allocate(): This is for internal use. You can use it yourself as well, but the interface
//             is a little tricky (see docs right below). The reason is that it is optimized
//             for multiple syntaxes to save space in generated code. So you should
//             normally not use allocate(), and instead allocate memory using _malloc(),
//             initialize it with setValue(), and so forth.
// @slab: An array of data, or a number. If a number, then the size of the block to allocate,
//        in *bytes* (note that this is sometimes confusing: the next parameter does not
//        affect this!)
// @types: Either an array of types, one for each byte (or 0 if no type at that position),
//         or a single type which is used for the entire block. This only matters if there
//         is initial data - if @slab is a number, then this does not matter at all and is
//         ignored.
// @allocator: How to allocate memory, see ALLOC_*
function allocate(slab, types, allocator, ptr) {
  var zeroinit, size;
  if (typeof slab === 'number') {
    zeroinit = true;
    size = slab;
  } else {
    zeroinit = false;
    size = slab.length;
  }

  var singleType = typeof types === 'string' ? types : null;

  var ret;
  if (allocator == ALLOC_NONE) {
    ret = ptr;
  } else {
    ret = [_malloc, Runtime.stackAlloc, Runtime.staticAlloc, Runtime.dynamicAlloc][allocator === undefined ? ALLOC_STATIC : allocator](Math.max(size, singleType ? 1 : types.length));
  }

  if (zeroinit) {
    var ptr = ret, stop;
    assert((ret & 3) == 0);
    stop = ret + (size & ~3);
    for (; ptr < stop; ptr += 4) {
      HEAP32[((ptr)>>2)]=0;
    }
    stop = ret + size;
    while (ptr < stop) {
      HEAP8[((ptr++)|0)]=0;
    }
    return ret;
  }

  if (singleType === 'i8') {
    if (slab.subarray || slab.slice) {
      HEAPU8.set(slab, ret);
    } else {
      HEAPU8.set(new Uint8Array(slab), ret);
    }
    return ret;
  }

  var i = 0, type, typeSize, previousType;
  while (i < size) {
    var curr = slab[i];

    if (typeof curr === 'function') {
      curr = Runtime.getFunctionIndex(curr);
    }

    type = singleType || types[i];
    if (type === 0) {
      i++;
      continue;
    }

    if (type == 'i64') type = 'i32'; // special case: we have one i32 here, and one i32 later

    setValue(ret+i, curr, type);

    // no need to look up size unless type changes, so cache it
    if (previousType !== type) {
      typeSize = Runtime.getNativeTypeSize(type);
      previousType = type;
    }
    i += typeSize;
  }

  return ret;
}
Module['allocate'] = allocate;

function Pointer_stringify(ptr, /* optional */ length) {
  // TODO: use TextDecoder
  // Find the length, and check for UTF while doing so
  var hasUtf = false;
  var t;
  var i = 0;
  while (1) {
    t = HEAPU8[(((ptr)+(i))|0)];
    if (t >= 128) hasUtf = true;
    else if (t == 0 && !length) break;
    i++;
    if (length && i == length) break;
  }
  if (!length) length = i;

  var ret = '';

  if (!hasUtf) {
    var MAX_CHUNK = 1024; // split up into chunks, because .apply on a huge string can overflow the stack
    var curr;
    while (length > 0) {
      curr = String.fromCharCode.apply(String, HEAPU8.subarray(ptr, ptr + Math.min(length, MAX_CHUNK)));
      ret = ret ? ret + curr : curr;
      ptr += MAX_CHUNK;
      length -= MAX_CHUNK;
    }
    return ret;
  }

  var utf8 = new Runtime.UTF8Processor();
  for (i = 0; i < length; i++) {
    t = HEAPU8[(((ptr)+(i))|0)];
    ret += utf8.processCChar(t);
  }
  return ret;
}
Module['Pointer_stringify'] = Pointer_stringify;

// Given a pointer 'ptr' to a null-terminated UTF16LE-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.
function UTF16ToString(ptr) {
  var i = 0;

  var str = '';
  while (1) {
    var codeUnit = HEAP16[(((ptr)+(i*2))>>1)];
    if (codeUnit == 0)
      return str;
    ++i;
    // fromCharCode constructs a character from a UTF-16 code unit, so we can pass the UTF16 string right through.
    str += String.fromCharCode(codeUnit);
  }
}
Module['UTF16ToString'] = UTF16ToString;

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF16LE form. The copy will require at most (str.length*2+1)*2 bytes of space in the HEAP.
function stringToUTF16(str, outPtr) {
  for(var i = 0; i < str.length; ++i) {
    // charCodeAt returns a UTF-16 encoded code unit, so it can be directly written to the HEAP.
    var codeUnit = str.charCodeAt(i); // possibly a lead surrogate
    HEAP16[(((outPtr)+(i*2))>>1)]=codeUnit;
  }
  // Null-terminate the pointer to the HEAP.
  HEAP16[(((outPtr)+(str.length*2))>>1)]=0;
}
Module['stringToUTF16'] = stringToUTF16;

// Given a pointer 'ptr' to a null-terminated UTF32LE-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.
function UTF32ToString(ptr) {
  var i = 0;

  var str = '';
  while (1) {
    var utf32 = HEAP32[(((ptr)+(i*4))>>2)];
    if (utf32 == 0)
      return str;
    ++i;
    // Gotcha: fromCharCode constructs a character from a UTF-16 encoded code (pair), not from a Unicode code point! So encode the code point to UTF-16 for constructing.
    if (utf32 >= 0x10000) {
      var ch = utf32 - 0x10000;
      str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
    } else {
      str += String.fromCharCode(utf32);
    }
  }
}
Module['UTF32ToString'] = UTF32ToString;

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF32LE form. The copy will require at most (str.length+1)*4 bytes of space in the HEAP,
// but can use less, since str.length does not return the number of characters in the string, but the number of UTF-16 code units in the string.
function stringToUTF32(str, outPtr) {
  var iChar = 0;
  for(var iCodeUnit = 0; iCodeUnit < str.length; ++iCodeUnit) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! We must decode the string to UTF-32 to the heap.
    var codeUnit = str.charCodeAt(iCodeUnit); // possibly a lead surrogate
    if (codeUnit >= 0xD800 && codeUnit <= 0xDFFF) {
      var trailSurrogate = str.charCodeAt(++iCodeUnit);
      codeUnit = 0x10000 + ((codeUnit & 0x3FF) << 10) | (trailSurrogate & 0x3FF);
    }
    HEAP32[(((outPtr)+(iChar*4))>>2)]=codeUnit;
    ++iChar;
  }
  // Null-terminate the pointer to the HEAP.
  HEAP32[(((outPtr)+(iChar*4))>>2)]=0;
}
Module['stringToUTF32'] = stringToUTF32;

function demangle(func) {
  try {
    // Special-case the entry point, since its name differs from other name mangling.
    if (func == 'Object._main' || func == '_main') {
      return 'main()';
    }
    if (typeof func === 'number') func = Pointer_stringify(func);
    if (func[0] !== '_') return func;
    if (func[1] !== '_') return func; // C function
    if (func[2] !== 'Z') return func;
    switch (func[3]) {
      case 'n': return 'operator new()';
      case 'd': return 'operator delete()';
    }
    var i = 3;
    // params, etc.
    var basicTypes = {
      'v': 'void',
      'b': 'bool',
      'c': 'char',
      's': 'short',
      'i': 'int',
      'l': 'long',
      'f': 'float',
      'd': 'double',
      'w': 'wchar_t',
      'a': 'signed char',
      'h': 'unsigned char',
      't': 'unsigned short',
      'j': 'unsigned int',
      'm': 'unsigned long',
      'x': 'long long',
      'y': 'unsigned long long',
      'z': '...'
    };
    function dump(x) {
      //return;
      if (x) Module.print(x);
      Module.print(func);
      var pre = '';
      for (var a = 0; a < i; a++) pre += ' ';
      Module.print (pre + '^');
    }
    var subs = [];
    function parseNested() {
      i++;
      if (func[i] === 'K') i++; // ignore const
      var parts = [];
      while (func[i] !== 'E') {
        if (func[i] === 'S') { // substitution
          i++;
          var next = func.indexOf('_', i);
          var num = func.substring(i, next) || 0;
          parts.push(subs[num] || '?');
          i = next+1;
          continue;
        }
        if (func[i] === 'C') { // constructor
          parts.push(parts[parts.length-1]);
          i += 2;
          continue;
        }
        var size = parseInt(func.substr(i));
        var pre = size.toString().length;
        if (!size || !pre) { i--; break; } // counter i++ below us
        var curr = func.substr(i + pre, size);
        parts.push(curr);
        subs.push(curr);
        i += pre + size;
      }
      i++; // skip E
      return parts;
    }
    var first = true;
    function parse(rawList, limit, allowVoid) { // main parser
      limit = limit || Infinity;
      var ret = '', list = [];
      function flushList() {
        return '(' + list.join(', ') + ')';
      }
      var name;
      if (func[i] === 'N') {
        // namespaced N-E
        name = parseNested().join('::');
        limit--;
        if (limit === 0) return rawList ? [name] : name;
      } else {
        // not namespaced
        if (func[i] === 'K' || (first && func[i] === 'L')) i++; // ignore const and first 'L'
        var size = parseInt(func.substr(i));
        if (size) {
          var pre = size.toString().length;
          name = func.substr(i + pre, size);
          i += pre + size;
        }
      }
      first = false;
      if (func[i] === 'I') {
        i++;
        var iList = parse(true);
        var iRet = parse(true, 1, true);
        ret += iRet[0] + ' ' + name + '<' + iList.join(', ') + '>';
      } else {
        ret = name;
      }
      paramLoop: while (i < func.length && limit-- > 0) {
        //dump('paramLoop');
        var c = func[i++];
        if (c in basicTypes) {
          list.push(basicTypes[c]);
        } else {
          switch (c) {
            case 'P': list.push(parse(true, 1, true)[0] + '*'); break; // pointer
            case 'R': list.push(parse(true, 1, true)[0] + '&'); break; // reference
            case 'L': { // literal
              i++; // skip basic type
              var end = func.indexOf('E', i);
              var size = end - i;
              list.push(func.substr(i, size));
              i += size + 2; // size + 'EE'
              break;
            }
            case 'A': { // array
              var size = parseInt(func.substr(i));
              i += size.toString().length;
              if (func[i] !== '_') throw '?';
              i++; // skip _
              list.push(parse(true, 1, true)[0] + ' [' + size + ']');
              break;
            }
            case 'E': break paramLoop;
            default: ret += '?' + c; break paramLoop;
          }
        }
      }
      if (!allowVoid && list.length === 1 && list[0] === 'void') list = []; // avoid (void)
      return rawList ? list : ret + flushList();
    }
    return parse();
  } catch(e) {
    return func;
  }
}

function demangleAll(text) {
  return text.replace(/__Z[\w\d_]+/g, function(x) { var y = demangle(x); return x === y ? x : (x + ' [' + y + ']') });
}

function stackTrace() {
  var stack = new Error().stack;
  return stack ? demangleAll(stack) : '(no stack trace available)'; // Stack trace is not available at least on IE10 and Safari 6.
}

// Memory management

var PAGE_SIZE = 4096;
function alignMemoryPage(x) {
  return (x+4095)&-4096;
}

var HEAP;
var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;

var STATIC_BASE = 0, STATICTOP = 0, staticSealed = false; // static area
var STACK_BASE = 0, STACKTOP = 0, STACK_MAX = 0; // stack area
var DYNAMIC_BASE = 0, DYNAMICTOP = 0; // dynamic area handled by sbrk

function enlargeMemory() {
  abort('Cannot enlarge memory arrays. Either (1) compile with -s TOTAL_MEMORY=X with X higher than the current value ' + TOTAL_MEMORY + ', (2) compile with ALLOW_MEMORY_GROWTH which adjusts the size at runtime but prevents some optimizations, or (3) set Module.TOTAL_MEMORY before the program runs.');
}

var TOTAL_STACK = Module['TOTAL_STACK'] || 5242880;
var TOTAL_MEMORY = Module['TOTAL_MEMORY'] || 16777216;
var FAST_MEMORY = Module['FAST_MEMORY'] || 2097152;


// Initialize the runtime's memory
// check for full engine support (use string 'subarray' to avoid closure compiler confusion)
assert(typeof Int32Array !== 'undefined' && typeof Float64Array !== 'undefined' && !!(new Int32Array(1)['subarray']) && !!(new Int32Array(1)['set']),
       'Cannot fallback to non-typed array case: Code is too specialized');

var buffer = new ArrayBuffer(TOTAL_MEMORY);
HEAP8 = new Int8Array(buffer);
HEAP16 = new Int16Array(buffer);
HEAP32 = new Int32Array(buffer);
HEAPU8 = new Uint8Array(buffer);
HEAPU16 = new Uint16Array(buffer);
HEAPU32 = new Uint32Array(buffer);
HEAPF32 = new Float32Array(buffer);
HEAPF64 = new Float64Array(buffer);

// Endianness check (note: assumes compiler arch was little-endian)
HEAP32[0] = 255;
assert(HEAPU8[0] === 255 && HEAPU8[3] === 0, 'Typed arrays 2 must be run on a little-endian system');

Module['HEAP'] = HEAP;
Module['HEAP8'] = HEAP8;
Module['HEAP16'] = HEAP16;
Module['HEAP32'] = HEAP32;
Module['HEAPU8'] = HEAPU8;
Module['HEAPU16'] = HEAPU16;
Module['HEAPU32'] = HEAPU32;
Module['HEAPF32'] = HEAPF32;
Module['HEAPF64'] = HEAPF64;

function callRuntimeCallbacks(callbacks) {
  while(callbacks.length > 0) {
    var callback = callbacks.shift();
    if (typeof callback == 'function') {
      callback();
      continue;
    }
    var func = callback.func;
    if (typeof func === 'number') {
      if (callback.arg === undefined) {
        Runtime.dynCall('v', func);
      } else {
        Runtime.dynCall('vi', func, [callback.arg]);
      }
    } else {
      func(callback.arg === undefined ? null : callback.arg);
    }
  }
}

var __ATPRERUN__  = []; // functions called before the runtime is initialized
var __ATINIT__    = []; // functions called during startup
var __ATMAIN__    = []; // functions called when main() is to be run
var __ATEXIT__    = []; // functions called during shutdown
var __ATPOSTRUN__ = []; // functions called after the runtime has exited

var runtimeInitialized = false;

function preRun() {
  // compatibility - merge in anything from Module['preRun'] at this time
  if (Module['preRun']) {
    if (typeof Module['preRun'] == 'function') Module['preRun'] = [Module['preRun']];
    while (Module['preRun'].length) {
      addOnPreRun(Module['preRun'].shift());
    }
  }
  callRuntimeCallbacks(__ATPRERUN__);
}

function ensureInitRuntime() {
  if (runtimeInitialized) return;
  runtimeInitialized = true;
  callRuntimeCallbacks(__ATINIT__);
}

function preMain() {
  callRuntimeCallbacks(__ATMAIN__);
}

function exitRuntime() {
  callRuntimeCallbacks(__ATEXIT__);
}

function postRun() {
  // compatibility - merge in anything from Module['postRun'] at this time
  if (Module['postRun']) {
    if (typeof Module['postRun'] == 'function') Module['postRun'] = [Module['postRun']];
    while (Module['postRun'].length) {
      addOnPostRun(Module['postRun'].shift());
    }
  }
  callRuntimeCallbacks(__ATPOSTRUN__);
}

function addOnPreRun(cb) {
  __ATPRERUN__.unshift(cb);
}
Module['addOnPreRun'] = Module.addOnPreRun = addOnPreRun;

function addOnInit(cb) {
  __ATINIT__.unshift(cb);
}
Module['addOnInit'] = Module.addOnInit = addOnInit;

function addOnPreMain(cb) {
  __ATMAIN__.unshift(cb);
}
Module['addOnPreMain'] = Module.addOnPreMain = addOnPreMain;

function addOnExit(cb) {
  __ATEXIT__.unshift(cb);
}
Module['addOnExit'] = Module.addOnExit = addOnExit;

function addOnPostRun(cb) {
  __ATPOSTRUN__.unshift(cb);
}
Module['addOnPostRun'] = Module.addOnPostRun = addOnPostRun;

// Tools

// This processes a JS string into a C-line array of numbers, 0-terminated.
// For LLVM-originating strings, see parser.js:parseLLVMString function
function intArrayFromString(stringy, dontAddNull, length /* optional */) {
  var ret = (new Runtime.UTF8Processor()).processJSString(stringy);
  if (length) {
    ret.length = length;
  }
  if (!dontAddNull) {
    ret.push(0);
  }
  return ret;
}
Module['intArrayFromString'] = intArrayFromString;

function intArrayToString(array) {
  var ret = [];
  for (var i = 0; i < array.length; i++) {
    var chr = array[i];
    if (chr > 0xFF) {
      chr &= 0xFF;
    }
    ret.push(String.fromCharCode(chr));
  }
  return ret.join('');
}
Module['intArrayToString'] = intArrayToString;

// Write a Javascript array to somewhere in the heap
function writeStringToMemory(string, buffer, dontAddNull) {
  var array = intArrayFromString(string, dontAddNull);
  var i = 0;
  while (i < array.length) {
    var chr = array[i];
    HEAP8[(((buffer)+(i))|0)]=chr;
    i = i + 1;
  }
}
Module['writeStringToMemory'] = writeStringToMemory;

function writeArrayToMemory(array, buffer) {
  for (var i = 0; i < array.length; i++) {
    HEAP8[(((buffer)+(i))|0)]=array[i];
  }
}
Module['writeArrayToMemory'] = writeArrayToMemory;

function writeAsciiToMemory(str, buffer, dontAddNull) {
  for (var i = 0; i < str.length; i++) {
    HEAP8[(((buffer)+(i))|0)]=str.charCodeAt(i);
  }
  if (!dontAddNull) HEAP8[(((buffer)+(str.length))|0)]=0;
}
Module['writeAsciiToMemory'] = writeAsciiToMemory;

function unSign(value, bits, ignore, sig) {
  if (value >= 0) {
    return value;
  }
  return bits <= 32 ? 2*Math.abs(1 << (bits-1)) + value // Need some trickery, since if bits == 32, we are right at the limit of the bits JS uses in bitshifts
                    : Math.pow(2, bits)         + value;
}
function reSign(value, bits, ignore, sig) {
  if (value <= 0) {
    return value;
  }
  var half = bits <= 32 ? Math.abs(1 << (bits-1)) // abs is needed if bits == 32
                        : Math.pow(2, bits-1);
  if (value >= half && (bits <= 32 || value > half)) { // for huge values, we can hit the precision limit and always get true here. so don't do that
                                                       // but, in general there is no perfect solution here. With 64-bit ints, we get rounding and errors
                                                       // TODO: In i64 mode 1, resign the two parts separately and safely
    value = -2*half + value; // Cannot bitshift half, as it may be at the limit of the bits JS uses in bitshifts
  }
  return value;
}

// check for imul support, and also for correctness ( https://bugs.webkit.org/show_bug.cgi?id=126345 )
if (!Math['imul'] || Math['imul'](0xffffffff, 5) !== -5) Math['imul'] = function imul(a, b) {
  var ah  = a >>> 16;
  var al = a & 0xffff;
  var bh  = b >>> 16;
  var bl = b & 0xffff;
  return (al*bl + ((ah*bl + al*bh) << 16))|0;
};
Math.imul = Math['imul'];


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
var Math_min = Math.min;

// A counter of dependencies for calling run(). If we need to
// do asynchronous work before running, increment this and
// decrement it. Incrementing must happen in a place like
// PRE_RUN_ADDITIONS (used by emcc to add file preloading).
// Note that you can add dependencies in preRun, even though
// it happens right before run - run will be postponed until
// the dependencies are met.
var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null; // overridden to take different actions when all run dependencies are fulfilled

function addRunDependency(id) {
  runDependencies++;
  if (Module['monitorRunDependencies']) {
    Module['monitorRunDependencies'](runDependencies);
  }
}
Module['addRunDependency'] = addRunDependency;
function removeRunDependency(id) {
  runDependencies--;
  if (Module['monitorRunDependencies']) {
    Module['monitorRunDependencies'](runDependencies);
  }
  if (runDependencies == 0) {
    if (runDependencyWatcher !== null) {
      clearInterval(runDependencyWatcher);
      runDependencyWatcher = null;
    }
    if (dependenciesFulfilled) {
      var callback = dependenciesFulfilled;
      dependenciesFulfilled = null;
      callback(); // can add another dependenciesFulfilled
    }
  }
}
Module['removeRunDependency'] = removeRunDependency;

Module["preloadedImages"] = {}; // maps url to image data
Module["preloadedAudios"] = {}; // maps url to audio data


var memoryInitializer = null;

// === Body ===



STATIC_BASE = 8;

STATICTOP = STATIC_BASE + 2216;


/* global initializers */ __ATINIT__.push({ func: function() { runPostSets() } },{ func: function() { __GLOBAL__I_a() } },{ func: function() { __GLOBAL__I_a19() } });

var _fpzip_errstr;
var _fpzip_errno;


























































var __ZTVN10__cxxabiv120__si_class_type_infoE;
__ZTVN10__cxxabiv120__si_class_type_infoE=allocate([0,0,0,0,32,6,0,0,4,0,0,0,70,0,0,0,42,0,0,0,56,0,0,0,32,0,0,0,8,0,0,0,24,0,0,0,78,0,0,0,0,0,0,0,0,0,0,0], "i8", ALLOC_STATIC);;
var __ZTVN10__cxxabiv119__pointer_type_infoE;
__ZTVN10__cxxabiv119__pointer_type_infoE=allocate([0,0,0,0,48,6,0,0,62,0,0,0,46,0,0,0,42,0,0,0,56,0,0,0,12,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], "i8", ALLOC_STATIC);;
var __ZTVN10__cxxabiv117__class_type_infoE;
__ZTVN10__cxxabiv117__class_type_infoE=allocate([0,0,0,0,80,6,0,0,10,0,0,0,18,0,0,0,42,0,0,0,56,0,0,0,32,0,0,0,34,0,0,0,74,0,0,0,64,0,0,0,0,0,0,0,0,0,0,0], "i8", ALLOC_STATIC);;














































































var __ZTIt;
__ZTIt=allocate([208,1,0,0,112,2,0,0], "i8", ALLOC_STATIC);;
var __ZTIs;
__ZTIs=allocate([208,1,0,0,120,2,0,0], "i8", ALLOC_STATIC);;
var __ZTIm;
__ZTIm=allocate([208,1,0,0,128,2,0,0], "i8", ALLOC_STATIC);;
var __ZTIl;
__ZTIl=allocate([208,1,0,0,136,2,0,0], "i8", ALLOC_STATIC);;
var __ZTIj;
__ZTIj=allocate([208,1,0,0,144,2,0,0], "i8", ALLOC_STATIC);;
var __ZTIi;
__ZTIi=allocate([208,1,0,0,152,2,0,0], "i8", ALLOC_STATIC);;
var __ZTIh;
__ZTIh=allocate([208,1,0,0,160,2,0,0], "i8", ALLOC_STATIC);;
var __ZTIf;
__ZTIf=allocate([208,1,0,0,168,2,0,0], "i8", ALLOC_STATIC);;
var __ZTId;
__ZTId=allocate([208,1,0,0,176,2,0,0], "i8", ALLOC_STATIC);;
var __ZTIc;
__ZTIc=allocate([208,1,0,0,184,2,0,0], "i8", ALLOC_STATIC);;


var __ZTIa;
__ZTIa=allocate([208,1,0,0,200,2,0,0], "i8", ALLOC_STATIC);;


var __ZTISt9exception;
















































/* memory initializer */ allocate([108,111,110,103,0,0,0,0,117,110,115,105,103,110,101,100,32,105,110,116,0,0,0,0,105,110,116,0,0,0,0,0,98,105,116,115,32,60,61,32,49,54,0,0,0,0,0,0,117,110,115,105,103,110,101,100,32,115,104,111,114,116,0,0,115,104,111,114,116,0,0,0,117,110,115,105,103,110,101,100,32,99,104,97,114,0,0,0,115,116,100,58,58,98,97,100,95,97,108,108,111,99,0,0,115,105,103,110,101,100,32,99,104,97,114,0,0,0,0,0,100,101,107,101,109,112,114,101,115,115,0,0,0,0,0,0,116,97,114,103,101,116,114,101,115,99,97,108,101,32,60,32,40,49,117,32,60,60,32,40,98,105,116,115,32,43,32,49,41,41,0,0,0,0,0,0,99,104,97,114,0,0,0,0,100,101,99,111,109,112,114,101,115,115,0,0,0,0,0,0,115,114,99,47,114,99,113,115,109,111,100,101,108,46,99,112,112,0,0,0,0,0,0,0,101,109,115,99,114,105,112,116,101,110,58,58,109,101,109,111,114,121,95,118,105,101,119,0,101,109,115,99,114,105,112,116,101,110,58,58,118,97,108,0,115,116,100,58,58,119,115,116,114,105,110,103,0,0,0,0,115,116,100,58,58,115,116,114,105,110,103,0,0,0,0,0,100,111,117,98,108,101,0,0,118,111,105,100,0,0,0,0,98,111,111,108,0,0,0,0,102,108,111,97,116,0,0,0,117,110,115,105,103,110,101,100,32,108,111,110,103,0,0,0,100,101,99,111,109,112,114,101,115,115,105,111,110,32,102,97,105,108,101,100,58,32,37,115,10,0,0,0,0,0,0,0,99,97,110,110,111,116,32,114,101,97,100,32,104,101,97,100,101,114,58,32,37,115,10,0,82,67,113,115,109,111,100,101,108,0,0,0,0,0,0,0,0,0,0,0,120,5,0,0,60,0,0,0,14,0,0,0,22,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,6,0,0,48,0,0,0,76,0,0,0,42,0,0,0,56,0,0,0,26,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,16,6,0,0,44,0,0,0,58,0,0,0,42,0,0,0,56,0,0,0,32,0,0,0,30,0,0,0,40,0,0,0,6,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,120,6,0,0,66,0,0,0,68,0,0,0,54,0,0,0,52,0,0,0,36,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,152,6,0,0,28,0,0,0,2,0,0,0,72,0,0,0,38,0,0,0,0,0,0,0,0,0,0,0,118,0,0,0,0,0,0,0,116,0,0,0,0,0,0,0,115,0,0,0,0,0,0,0,109,0,0,0,0,0,0,0,108,0,0,0,0,0,0,0,106,0,0,0,0,0,0,0,105,0,0,0,0,0,0,0,104,0,0,0,0,0,0,0,102,0,0,0,0,0,0,0,100,0,0,0,0,0,0,0,99,0,0,0,0,0,0,0,98,0,0,0,0,0,0,0,97,0,0,0,0,0,0,0,83,116,57,116,121,112,101,95,105,110,102,111,0,0,0,0,83,116,57,98,97,100,95,97,108,108,111,99,0,0,0,0,80,118,0,0,0,0,0,0,80,99,0,0,0,0,0,0,80,49,50,68,101,99,111,100,101,100,73,109,97,103,101,0,78,83,116,51,95,95,49,50,49,95,95,98,97,115,105,99,95,115,116,114,105,110,103,95,99,111,109,109,111,110,73,76,98,49,69,69,69,0,0,0,78,83,116,51,95,95,49,49,50,98,97,115,105,99,95,115,116,114,105,110,103,73,119,78,83,95,49,49,99,104,97,114,95,116,114,97,105,116,115,73,119,69,69,78,83,95,57,97,108,108,111,99,97,116,111,114,73,119,69,69,69,69,0,0,78,83,116,51,95,95,49,49,50,98,97,115,105,99,95,115,116,114,105,110,103,73,99,78,83,95,49,49,99,104,97,114,95,116,114,97,105,116,115,73,99,69,69,78,83,95,57,97,108,108,111,99,97,116,111,114,73,99,69,69,69,69,0,0,78,49,48,101,109,115,99,114,105,112,116,101,110,51,118,97,108,69,0,0,0,0,0,0,78,49,48,101,109,115,99,114,105,112,116,101,110,49,49,109,101,109,111,114,121,95,118,105,101,119,69,0,0,0,0,0,78,49,48,95,95,99,120,120,97,98,105,118,49,50,51,95,95,102,117,110,100,97,109,101,110,116,97,108,95,116,121,112,101,95,105,110,102,111,69,0,78,49,48,95,95,99,120,120,97,98,105,118,49,50,49,95,95,118,109,105,95,99,108,97,115,115,95,116,121,112,101,95,105,110,102,111,69,0,0,0,78,49,48,95,95,99,120,120,97,98,105,118,49,50,48,95,95,115,105,95,99,108,97,115,115,95,116,121,112,101,95,105,110,102,111,69,0,0,0,0,78,49,48,95,95,99,120,120,97,98,105,118,49,49,57,95,95,112,111,105,110,116,101,114,95,116,121,112,101,95,105,110,102,111,69,0,0,0,0,0,78,49,48,95,95,99,120,120,97,98,105,118,49,49,55,95,95,112,98,97,115,101,95,116,121,112,101,95,105,110,102,111,69,0,0,0,0,0,0,0,78,49,48,95,95,99,120,120,97,98,105,118,49,49,55,95,95,99,108,97,115,115,95,116,121,112,101,95,105,110,102,111,69,0,0,0,0,0,0,0,78,49,48,95,95,99,120,120,97,98,105,118,49,49,54,95,95,115,104,105,109,95,116,121,112,101,95,105,110,102,111,69,0,0,0,0,0,0,0,0,68,110,0,0,0,0,0,0,57,82,67,113,115,109,111,100,101,108,0,0,0,0,0,0,57,82,67,100,101,99,111,100,101,114,0,0,0,0,0,0,55,82,67,109,111,100,101,108,0,0,0,0,0,0,0,0,49,50,82,67,109,101,109,100,101,99,111,100,101,114,0,0,49,50,68,101,99,111,100,101,100,73,109,97,103,101,0,0,208,1,0,0,104,2,0,0,208,1,0,0,192,2,0,0,0,0,0,0,208,2,0,0,0,0,0,0,224,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,240,2,0,0,0,0,0,0,96,5,0,0,0,0,0,0,248,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3,0,0,0,0,0,0,168,6,0,0,0,0,0,0,16,3,0,0,248,1,0,0,56,3,0,0,0,0,0,0,1,0,0,0,184,5,0,0,0,0,0,0,248,1,0,0,120,3,0,0,0,0,0,0,1,0,0,0,184,5,0,0,0,0,0,0,0,0,0,0,184,3,0,0,0,0,0,0,208,3,0,0,0,0,0,0,240,3,0,0,96,6,0,0,0,0,0,0,0,0,0,0,24,4,0,0,80,6,0,0,0,0,0,0,0,0,0,0,64,4,0,0,80,6,0,0,0,0,0,0,0,0,0,0,104,4,0,0,64,6,0,0,0,0,0,0,0,0,0,0,144,4,0,0,96,6,0,0,0,0,0,0,0,0,0,0,184,4,0,0,96,6,0,0,0,0,0,0,0,0,0,0,224,4,0,0,112,5,0,0,0,0,0,0,208,1,0,0,8,5,0,0,0,0,0,0,16,5,0,0,144,6,0,0,0,0,0,0,0,0,0,0,32,5,0,0,0,0,0,0,48,5,0,0,0,0,0,0,64,5,0,0,136,6,0,0,0,0,0,0,0,0,0,0,80,5,0,0], "i8", ALLOC_NONE, Runtime.GLOBAL_BASE);
function runPostSets() {

HEAP32[((1392 )>>2)]=(((__ZTVN10__cxxabiv117__class_type_infoE+8)|0));
HEAP32[((1400 )>>2)]=(((__ZTVN10__cxxabiv120__si_class_type_infoE+8)|0));
HEAP32[((1408 )>>2)]=__ZTISt9exception;
HEAP32[((1416 )>>2)]=(((__ZTVN10__cxxabiv119__pointer_type_infoE+8)|0));
HEAP32[((1432 )>>2)]=(((__ZTVN10__cxxabiv119__pointer_type_infoE+8)|0));
HEAP32[((1444 )>>2)]=__ZTIc;
HEAP32[((1448 )>>2)]=(((__ZTVN10__cxxabiv119__pointer_type_infoE+8)|0));
HEAP32[((1464 )>>2)]=(((__ZTVN10__cxxabiv117__class_type_infoE+8)|0));
HEAP32[((1520 )>>2)]=(((__ZTVN10__cxxabiv117__class_type_infoE+8)|0));
HEAP32[((1528 )>>2)]=(((__ZTVN10__cxxabiv117__class_type_infoE+8)|0));
HEAP32[((1536 )>>2)]=(((__ZTVN10__cxxabiv120__si_class_type_infoE+8)|0));
HEAP32[((1552 )>>2)]=(((__ZTVN10__cxxabiv120__si_class_type_infoE+8)|0));
HEAP32[((1568 )>>2)]=(((__ZTVN10__cxxabiv120__si_class_type_infoE+8)|0));
HEAP32[((1584 )>>2)]=(((__ZTVN10__cxxabiv120__si_class_type_infoE+8)|0));
HEAP32[((1600 )>>2)]=(((__ZTVN10__cxxabiv120__si_class_type_infoE+8)|0));
HEAP32[((1616 )>>2)]=(((__ZTVN10__cxxabiv120__si_class_type_infoE+8)|0));
HEAP32[((1632 )>>2)]=(((__ZTVN10__cxxabiv120__si_class_type_infoE+8)|0));
HEAP32[((1656 )>>2)]=(((__ZTVN10__cxxabiv120__si_class_type_infoE+8)|0));
HEAP32[((1672 )>>2)]=(((__ZTVN10__cxxabiv117__class_type_infoE+8)|0));
HEAP32[((1680 )>>2)]=(((__ZTVN10__cxxabiv117__class_type_infoE+8)|0));
HEAP32[((1688 )>>2)]=(((__ZTVN10__cxxabiv120__si_class_type_infoE+8)|0));
HEAP32[((1704 )>>2)]=(((__ZTVN10__cxxabiv117__class_type_infoE+8)|0));
}

var tempDoublePtr = Runtime.alignMemory(allocate(12, "i8", ALLOC_STATIC), 8);

assert(tempDoublePtr % 8 == 0);

function copyTempFloat(ptr) { // functions, because inlining this code increases code size too much

  HEAP8[tempDoublePtr] = HEAP8[ptr];

  HEAP8[tempDoublePtr+1] = HEAP8[ptr+1];

  HEAP8[tempDoublePtr+2] = HEAP8[ptr+2];

  HEAP8[tempDoublePtr+3] = HEAP8[ptr+3];

}

function copyTempDouble(ptr) {

  HEAP8[tempDoublePtr] = HEAP8[ptr];

  HEAP8[tempDoublePtr+1] = HEAP8[ptr+1];

  HEAP8[tempDoublePtr+2] = HEAP8[ptr+2];

  HEAP8[tempDoublePtr+3] = HEAP8[ptr+3];

  HEAP8[tempDoublePtr+4] = HEAP8[ptr+4];

  HEAP8[tempDoublePtr+5] = HEAP8[ptr+5];

  HEAP8[tempDoublePtr+6] = HEAP8[ptr+6];

  HEAP8[tempDoublePtr+7] = HEAP8[ptr+7];

}


  
  function __ZSt18uncaught_exceptionv() { // std::uncaught_exception()
      return !!__ZSt18uncaught_exceptionv.uncaught_exception;
    }
  
  
  
  function ___cxa_is_number_type(type) {
      var isNumber = false;
      try { if (type == __ZTIi) isNumber = true } catch(e){}
      try { if (type == __ZTIj) isNumber = true } catch(e){}
      try { if (type == __ZTIl) isNumber = true } catch(e){}
      try { if (type == __ZTIm) isNumber = true } catch(e){}
      try { if (type == __ZTIx) isNumber = true } catch(e){}
      try { if (type == __ZTIy) isNumber = true } catch(e){}
      try { if (type == __ZTIf) isNumber = true } catch(e){}
      try { if (type == __ZTId) isNumber = true } catch(e){}
      try { if (type == __ZTIe) isNumber = true } catch(e){}
      try { if (type == __ZTIc) isNumber = true } catch(e){}
      try { if (type == __ZTIa) isNumber = true } catch(e){}
      try { if (type == __ZTIh) isNumber = true } catch(e){}
      try { if (type == __ZTIs) isNumber = true } catch(e){}
      try { if (type == __ZTIt) isNumber = true } catch(e){}
      return isNumber;
    }function ___cxa_does_inherit(definiteType, possibilityType, possibility) {
      if (possibility == 0) return false;
      if (possibilityType == 0 || possibilityType == definiteType)
        return true;
      var possibility_type_info;
      if (___cxa_is_number_type(possibilityType)) {
        possibility_type_info = possibilityType;
      } else {
        var possibility_type_infoAddr = HEAP32[((possibilityType)>>2)] - 8;
        possibility_type_info = HEAP32[((possibility_type_infoAddr)>>2)];
      }
      switch (possibility_type_info) {
      case 0: // possibility is a pointer
        // See if definite type is a pointer
        var definite_type_infoAddr = HEAP32[((definiteType)>>2)] - 8;
        var definite_type_info = HEAP32[((definite_type_infoAddr)>>2)];
        if (definite_type_info == 0) {
          // Also a pointer; compare base types of pointers
          var defPointerBaseAddr = definiteType+8;
          var defPointerBaseType = HEAP32[((defPointerBaseAddr)>>2)];
          var possPointerBaseAddr = possibilityType+8;
          var possPointerBaseType = HEAP32[((possPointerBaseAddr)>>2)];
          return ___cxa_does_inherit(defPointerBaseType, possPointerBaseType, possibility);
        } else
          return false; // one pointer and one non-pointer
      case 1: // class with no base class
        return false;
      case 2: // class with base class
        var parentTypeAddr = possibilityType + 8;
        var parentType = HEAP32[((parentTypeAddr)>>2)];
        return ___cxa_does_inherit(definiteType, parentType, possibility);
      default:
        return false; // some unencountered type
      }
    }
  
  function ___resumeException(ptr) {
      if (!___cxa_last_thrown_exception) { ___cxa_last_thrown_exception = ptr; }
      throw ptr + " - Exception catching is disabled, this exception cannot be caught. Compile with -s DISABLE_EXCEPTION_CATCHING=0 or DISABLE_EXCEPTION_CATCHING=2 to catch.";
    }
  
  var ___cxa_last_thrown_exception=0;
  
  var ___cxa_exception_header_size=8;function ___cxa_find_matching_catch(thrown, throwntype) {
      if (thrown == -1) thrown = ___cxa_last_thrown_exception;
      header = thrown - ___cxa_exception_header_size;
      if (throwntype == -1) throwntype = HEAP32[((header)>>2)];
      var typeArray = Array.prototype.slice.call(arguments, 2);
  
      // If throwntype is a pointer, this means a pointer has been
      // thrown. When a pointer is thrown, actually what's thrown
      // is a pointer to the pointer. We'll dereference it.
      if (throwntype != 0 && !___cxa_is_number_type(throwntype)) {
        var throwntypeInfoAddr= HEAP32[((throwntype)>>2)] - 8;
        var throwntypeInfo= HEAP32[((throwntypeInfoAddr)>>2)];
        if (throwntypeInfo == 0)
          thrown = HEAP32[((thrown)>>2)];
      }
      // The different catch blocks are denoted by different types.
      // Due to inheritance, those types may not precisely match the
      // type of the thrown object. Find one which matches, and
      // return the type of the catch block which should be called.
      for (var i = 0; i < typeArray.length; i++) {
        if (___cxa_does_inherit(typeArray[i], throwntype, thrown))
          return tempRet0 = typeArray[i],thrown;
      }
      // Shouldn't happen unless we have bogus data in typeArray
      // or encounter a type for which emscripten doesn't have suitable
      // typeinfo defined. Best-efforts match just in case.
      return tempRet0 = throwntype,thrown;
    }function ___gxx_personality_v0() {
    }

  function _llvm_umul_with_overflow_i32(x, y) {
      x = x>>>0;
      y = y>>>0;
      return tempRet0 = x*y > 4294967295,(x*y)>>>0;
    }

  function _llvm_lifetime_start() {}

  function _llvm_lifetime_end() {}

  
  
  
  function _strlen(ptr) {
      ptr = ptr|0;
      var curr = 0;
      curr = ptr;
      while (HEAP8[(curr)]) {
        curr = (curr + 1)|0;
      }
      return (curr - ptr)|0;
    }
  
  function __reallyNegative(x) {
      return x < 0 || (x === 0 && (1/x) === -Infinity);
    }function __formatString(format, varargs) {
      var textIndex = format;
      var argIndex = 0;
      function getNextArg(type) {
        // NOTE: Explicitly ignoring type safety. Otherwise this fails:
        //       int x = 4; printf("%c\n", (char)x);
        var ret;
        if (type === 'double') {
          ret = HEAPF64[(((varargs)+(argIndex))>>3)];
        } else if (type == 'i64') {
          ret = [HEAP32[(((varargs)+(argIndex))>>2)],
                 HEAP32[(((varargs)+(argIndex+8))>>2)]];
          argIndex += 8; // each 32-bit chunk is in a 64-bit block
  
        } else {
          type = 'i32'; // varargs are always i32, i64, or double
          ret = HEAP32[(((varargs)+(argIndex))>>2)];
        }
        argIndex += Math.max(Runtime.getNativeFieldSize(type), Runtime.getAlignSize(type, null, true));
        return ret;
      }
  
      var ret = [];
      var curr, next, currArg;
      while(1) {
        var startTextIndex = textIndex;
        curr = HEAP8[(textIndex)];
        if (curr === 0) break;
        next = HEAP8[((textIndex+1)|0)];
        if (curr == 37) {
          // Handle flags.
          var flagAlwaysSigned = false;
          var flagLeftAlign = false;
          var flagAlternative = false;
          var flagZeroPad = false;
          var flagPadSign = false;
          flagsLoop: while (1) {
            switch (next) {
              case 43:
                flagAlwaysSigned = true;
                break;
              case 45:
                flagLeftAlign = true;
                break;
              case 35:
                flagAlternative = true;
                break;
              case 48:
                if (flagZeroPad) {
                  break flagsLoop;
                } else {
                  flagZeroPad = true;
                  break;
                }
              case 32:
                flagPadSign = true;
                break;
              default:
                break flagsLoop;
            }
            textIndex++;
            next = HEAP8[((textIndex+1)|0)];
          }
  
          // Handle width.
          var width = 0;
          if (next == 42) {
            width = getNextArg('i32');
            textIndex++;
            next = HEAP8[((textIndex+1)|0)];
          } else {
            while (next >= 48 && next <= 57) {
              width = width * 10 + (next - 48);
              textIndex++;
              next = HEAP8[((textIndex+1)|0)];
            }
          }
  
          // Handle precision.
          var precisionSet = false, precision = -1;
          if (next == 46) {
            precision = 0;
            precisionSet = true;
            textIndex++;
            next = HEAP8[((textIndex+1)|0)];
            if (next == 42) {
              precision = getNextArg('i32');
              textIndex++;
            } else {
              while(1) {
                var precisionChr = HEAP8[((textIndex+1)|0)];
                if (precisionChr < 48 ||
                    precisionChr > 57) break;
                precision = precision * 10 + (precisionChr - 48);
                textIndex++;
              }
            }
            next = HEAP8[((textIndex+1)|0)];
          }
          if (precision === -1) {
            precision = 6; // Standard default.
            precisionSet = false;
          }
  
          // Handle integer sizes. WARNING: These assume a 32-bit architecture!
          var argSize;
          switch (String.fromCharCode(next)) {
            case 'h':
              var nextNext = HEAP8[((textIndex+2)|0)];
              if (nextNext == 104) {
                textIndex++;
                argSize = 1; // char (actually i32 in varargs)
              } else {
                argSize = 2; // short (actually i32 in varargs)
              }
              break;
            case 'l':
              var nextNext = HEAP8[((textIndex+2)|0)];
              if (nextNext == 108) {
                textIndex++;
                argSize = 8; // long long
              } else {
                argSize = 4; // long
              }
              break;
            case 'L': // long long
            case 'q': // int64_t
            case 'j': // intmax_t
              argSize = 8;
              break;
            case 'z': // size_t
            case 't': // ptrdiff_t
            case 'I': // signed ptrdiff_t or unsigned size_t
              argSize = 4;
              break;
            default:
              argSize = null;
          }
          if (argSize) textIndex++;
          next = HEAP8[((textIndex+1)|0)];
  
          // Handle type specifier.
          switch (String.fromCharCode(next)) {
            case 'd': case 'i': case 'u': case 'o': case 'x': case 'X': case 'p': {
              // Integer.
              var signed = next == 100 || next == 105;
              argSize = argSize || 4;
              var currArg = getNextArg('i' + (argSize * 8));
              var origArg = currArg;
              var argText;
              // Flatten i64-1 [low, high] into a (slightly rounded) double
              if (argSize == 8) {
                currArg = Runtime.makeBigInt(currArg[0], currArg[1], next == 117);
              }
              // Truncate to requested size.
              if (argSize <= 4) {
                var limit = Math.pow(256, argSize) - 1;
                currArg = (signed ? reSign : unSign)(currArg & limit, argSize * 8);
              }
              // Format the number.
              var currAbsArg = Math.abs(currArg);
              var prefix = '';
              if (next == 100 || next == 105) {
                if (argSize == 8 && i64Math) argText = i64Math.stringify(origArg[0], origArg[1], null); else
                argText = reSign(currArg, 8 * argSize, 1).toString(10);
              } else if (next == 117) {
                if (argSize == 8 && i64Math) argText = i64Math.stringify(origArg[0], origArg[1], true); else
                argText = unSign(currArg, 8 * argSize, 1).toString(10);
                currArg = Math.abs(currArg);
              } else if (next == 111) {
                argText = (flagAlternative ? '0' : '') + currAbsArg.toString(8);
              } else if (next == 120 || next == 88) {
                prefix = (flagAlternative && currArg != 0) ? '0x' : '';
                if (argSize == 8 && i64Math) {
                  if (origArg[1]) {
                    argText = (origArg[1]>>>0).toString(16);
                    var lower = (origArg[0]>>>0).toString(16);
                    while (lower.length < 8) lower = '0' + lower;
                    argText += lower;
                  } else {
                    argText = (origArg[0]>>>0).toString(16);
                  }
                } else
                if (currArg < 0) {
                  // Represent negative numbers in hex as 2's complement.
                  currArg = -currArg;
                  argText = (currAbsArg - 1).toString(16);
                  var buffer = [];
                  for (var i = 0; i < argText.length; i++) {
                    buffer.push((0xF - parseInt(argText[i], 16)).toString(16));
                  }
                  argText = buffer.join('');
                  while (argText.length < argSize * 2) argText = 'f' + argText;
                } else {
                  argText = currAbsArg.toString(16);
                }
                if (next == 88) {
                  prefix = prefix.toUpperCase();
                  argText = argText.toUpperCase();
                }
              } else if (next == 112) {
                if (currAbsArg === 0) {
                  argText = '(nil)';
                } else {
                  prefix = '0x';
                  argText = currAbsArg.toString(16);
                }
              }
              if (precisionSet) {
                while (argText.length < precision) {
                  argText = '0' + argText;
                }
              }
  
              // Add sign if needed
              if (currArg >= 0) {
                if (flagAlwaysSigned) {
                  prefix = '+' + prefix;
                } else if (flagPadSign) {
                  prefix = ' ' + prefix;
                }
              }
  
              // Move sign to prefix so we zero-pad after the sign
              if (argText.charAt(0) == '-') {
                prefix = '-' + prefix;
                argText = argText.substr(1);
              }
  
              // Add padding.
              while (prefix.length + argText.length < width) {
                if (flagLeftAlign) {
                  argText += ' ';
                } else {
                  if (flagZeroPad) {
                    argText = '0' + argText;
                  } else {
                    prefix = ' ' + prefix;
                  }
                }
              }
  
              // Insert the result into the buffer.
              argText = prefix + argText;
              argText.split('').forEach(function(chr) {
                ret.push(chr.charCodeAt(0));
              });
              break;
            }
            case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': {
              // Float.
              var currArg = getNextArg('double');
              var argText;
              if (isNaN(currArg)) {
                argText = 'nan';
                flagZeroPad = false;
              } else if (!isFinite(currArg)) {
                argText = (currArg < 0 ? '-' : '') + 'inf';
                flagZeroPad = false;
              } else {
                var isGeneral = false;
                var effectivePrecision = Math.min(precision, 20);
  
                // Convert g/G to f/F or e/E, as per:
                // http://pubs.opengroup.org/onlinepubs/9699919799/functions/printf.html
                if (next == 103 || next == 71) {
                  isGeneral = true;
                  precision = precision || 1;
                  var exponent = parseInt(currArg.toExponential(effectivePrecision).split('e')[1], 10);
                  if (precision > exponent && exponent >= -4) {
                    next = ((next == 103) ? 'f' : 'F').charCodeAt(0);
                    precision -= exponent + 1;
                  } else {
                    next = ((next == 103) ? 'e' : 'E').charCodeAt(0);
                    precision--;
                  }
                  effectivePrecision = Math.min(precision, 20);
                }
  
                if (next == 101 || next == 69) {
                  argText = currArg.toExponential(effectivePrecision);
                  // Make sure the exponent has at least 2 digits.
                  if (/[eE][-+]\d$/.test(argText)) {
                    argText = argText.slice(0, -1) + '0' + argText.slice(-1);
                  }
                } else if (next == 102 || next == 70) {
                  argText = currArg.toFixed(effectivePrecision);
                  if (currArg === 0 && __reallyNegative(currArg)) {
                    argText = '-' + argText;
                  }
                }
  
                var parts = argText.split('e');
                if (isGeneral && !flagAlternative) {
                  // Discard trailing zeros and periods.
                  while (parts[0].length > 1 && parts[0].indexOf('.') != -1 &&
                         (parts[0].slice(-1) == '0' || parts[0].slice(-1) == '.')) {
                    parts[0] = parts[0].slice(0, -1);
                  }
                } else {
                  // Make sure we have a period in alternative mode.
                  if (flagAlternative && argText.indexOf('.') == -1) parts[0] += '.';
                  // Zero pad until required precision.
                  while (precision > effectivePrecision++) parts[0] += '0';
                }
                argText = parts[0] + (parts.length > 1 ? 'e' + parts[1] : '');
  
                // Capitalize 'E' if needed.
                if (next == 69) argText = argText.toUpperCase();
  
                // Add sign.
                if (currArg >= 0) {
                  if (flagAlwaysSigned) {
                    argText = '+' + argText;
                  } else if (flagPadSign) {
                    argText = ' ' + argText;
                  }
                }
              }
  
              // Add padding.
              while (argText.length < width) {
                if (flagLeftAlign) {
                  argText += ' ';
                } else {
                  if (flagZeroPad && (argText[0] == '-' || argText[0] == '+')) {
                    argText = argText[0] + '0' + argText.slice(1);
                  } else {
                    argText = (flagZeroPad ? '0' : ' ') + argText;
                  }
                }
              }
  
              // Adjust case.
              if (next < 97) argText = argText.toUpperCase();
  
              // Insert the result into the buffer.
              argText.split('').forEach(function(chr) {
                ret.push(chr.charCodeAt(0));
              });
              break;
            }
            case 's': {
              // String.
              var arg = getNextArg('i8*');
              var argLength = arg ? _strlen(arg) : '(null)'.length;
              if (precisionSet) argLength = Math.min(argLength, precision);
              if (!flagLeftAlign) {
                while (argLength < width--) {
                  ret.push(32);
                }
              }
              if (arg) {
                for (var i = 0; i < argLength; i++) {
                  ret.push(HEAPU8[((arg++)|0)]);
                }
              } else {
                ret = ret.concat(intArrayFromString('(null)'.substr(0, argLength), true));
              }
              if (flagLeftAlign) {
                while (argLength < width--) {
                  ret.push(32);
                }
              }
              break;
            }
            case 'c': {
              // Character.
              if (flagLeftAlign) ret.push(getNextArg('i8'));
              while (--width > 0) {
                ret.push(32);
              }
              if (!flagLeftAlign) ret.push(getNextArg('i8'));
              break;
            }
            case 'n': {
              // Write the length written so far to the next parameter.
              var ptr = getNextArg('i32*');
              HEAP32[((ptr)>>2)]=ret.length;
              break;
            }
            case '%': {
              // Literal percent sign.
              ret.push(curr);
              break;
            }
            default: {
              // Unknown specifiers remain untouched.
              for (var i = startTextIndex; i < textIndex + 2; i++) {
                ret.push(HEAP8[(i)]);
              }
            }
          }
          textIndex += 2;
          // TODO: Support a/A (hex float) and m (last error) specifiers.
          // TODO: Support %1${specifier} for arg selection.
        } else {
          ret.push(curr);
          textIndex += 1;
        }
      }
      return ret;
    }function _snprintf(s, n, format, varargs) {
      // int snprintf(char *restrict s, size_t n, const char *restrict format, ...);
      // http://pubs.opengroup.org/onlinepubs/000095399/functions/printf.html
      var result = __formatString(format, varargs);
      var limit = (n === undefined) ? result.length
                                    : Math.min(result.length, Math.max(n - 1, 0));
      if (s < 0) {
        s = -s;
        var buf = _malloc(limit+1);
        HEAP32[((s)>>2)]=buf;
        s = buf;
      }
      for (var i = 0; i < limit; i++) {
        HEAP8[(((s)+(i))|0)]=result[i];
      }
      if (limit < n || (n === undefined)) HEAP8[(((s)+(i))|0)]=0;
      return result.length;
    }function _sprintf(s, format, varargs) {
      // int sprintf(char *restrict s, const char *restrict format, ...);
      // http://pubs.opengroup.org/onlinepubs/000095399/functions/printf.html
      return _snprintf(s, undefined, format, varargs);
    }

  function ___cxa_allocate_exception(size) {
      var ptr = _malloc(size + ___cxa_exception_header_size);
      return ptr + ___cxa_exception_header_size;
    }

  function ___cxa_throw(ptr, type, destructor) {
      if (!___cxa_throw.initialized) {
        try {
          HEAP32[((__ZTVN10__cxxabiv119__pointer_type_infoE)>>2)]=0; // Workaround for libcxxabi integration bug
        } catch(e){}
        try {
          HEAP32[((__ZTVN10__cxxabiv117__class_type_infoE)>>2)]=1; // Workaround for libcxxabi integration bug
        } catch(e){}
        try {
          HEAP32[((__ZTVN10__cxxabiv120__si_class_type_infoE)>>2)]=2; // Workaround for libcxxabi integration bug
        } catch(e){}
        ___cxa_throw.initialized = true;
      }
      var header = ptr - ___cxa_exception_header_size;
      HEAP32[((header)>>2)]=type;
      HEAP32[(((header)+(4))>>2)]=destructor;
      ___cxa_last_thrown_exception = ptr;
      if (!("uncaught_exception" in __ZSt18uncaught_exceptionv)) {
        __ZSt18uncaught_exceptionv.uncaught_exception = 1;
      } else {
        __ZSt18uncaught_exceptionv.uncaught_exception++;
      }
      throw ptr + " - Exception catching is disabled, this exception cannot be caught. Compile with -s DISABLE_EXCEPTION_CATCHING=0 or DISABLE_EXCEPTION_CATCHING=2 to catch.";
    }

  
  function _memset(ptr, value, num) {
      ptr = ptr|0; value = value|0; num = num|0;
      var stop = 0, value4 = 0, stop4 = 0, unaligned = 0;
      stop = (ptr + num)|0;
      if ((num|0) >= 20) {
        // This is unaligned, but quite large, so work hard to get to aligned settings
        value = value & 0xff;
        unaligned = ptr & 3;
        value4 = value | (value << 8) | (value << 16) | (value << 24);
        stop4 = stop & ~3;
        if (unaligned) {
          unaligned = (ptr + 4 - unaligned)|0;
          while ((ptr|0) < (unaligned|0)) { // no need to check for stop, since we have large num
            HEAP8[(ptr)]=value;
            ptr = (ptr+1)|0;
          }
        }
        while ((ptr|0) < (stop4|0)) {
          HEAP32[((ptr)>>2)]=value4;
          ptr = (ptr+4)|0;
        }
      }
      while ((ptr|0) < (stop|0)) {
        HEAP8[(ptr)]=value;
        ptr = (ptr+1)|0;
      }
      return (ptr-num)|0;
    }var _llvm_memset_p0i8_i32=_memset;
;

  
  function _memcpy(dest, src, num) {
      dest = dest|0; src = src|0; num = num|0;
      var ret = 0;
      ret = dest|0;
      if ((dest&3) == (src&3)) {
        while (dest & 3) {
          if ((num|0) == 0) return ret|0;
          HEAP8[(dest)]=HEAP8[(src)];
          dest = (dest+1)|0;
          src = (src+1)|0;
          num = (num-1)|0;
        }
        while ((num|0) >= 4) {
          HEAP32[((dest)>>2)]=HEAP32[((src)>>2)];
          dest = (dest+4)|0;
          src = (src+4)|0;
          num = (num-4)|0;
        }
      }
      while ((num|0) > 0) {
        HEAP8[(dest)]=HEAP8[(src)];
        dest = (dest+1)|0;
        src = (src+1)|0;
        num = (num-1)|0;
      }
      return ret|0;
    }var _llvm_memcpy_p0i8_p0i8_i32=_memcpy;

  function ___assert_fail(condition, filename, line, func) {
      ABORT = true;
      throw 'Assertion failed: ' + Pointer_stringify(condition) + ', at: ' + [filename ? Pointer_stringify(filename) : 'unknown filename', line, func ? Pointer_stringify(func) : 'unknown function'] + ' at ' + stackTrace();
    }

  function _strdup(ptr) {
      var len = _strlen(ptr);
      var newStr = _malloc(len + 1);
      (_memcpy(newStr, ptr, len)|0);
      HEAP8[(((newStr)+(len))|0)]=0;
      return newStr;
    }
;
;
;
;
;
;
;
;

  function __ZNSt9exceptionD2Ev() {}

  var _llvm_memset_p0i8_i64=_memset;

  function _abort() {
      Module['abort']();
    }

  
  
  var ___errno_state=0;function ___setErrNo(value) {
      // For convenient setting and returning of errno.
      HEAP32[((___errno_state)>>2)]=value;
      return value;
    }function ___errno_location() {
      return ___errno_state;
    }

  function _sbrk(bytes) {
      // Implement a Linux-like 'memory area' for our 'process'.
      // Changes the size of the memory area by |bytes|; returns the
      // address of the previous top ('break') of the memory area
      // We control the "dynamic" memory - DYNAMIC_BASE to DYNAMICTOP
      var self = _sbrk;
      if (!self.called) {
        DYNAMICTOP = alignMemoryPage(DYNAMICTOP); // make sure we start out aligned
        self.called = true;
        assert(Runtime.dynamicAlloc);
        self.alloc = Runtime.dynamicAlloc;
        Runtime.dynamicAlloc = function() { abort('cannot dynamically allocate, sbrk now has control') };
      }
      var ret = DYNAMICTOP;
      if (bytes != 0) self.alloc(bytes);
      return ret;  // Previous break location.
    }

  
  var ERRNO_CODES={EPERM:1,ENOENT:2,ESRCH:3,EINTR:4,EIO:5,ENXIO:6,E2BIG:7,ENOEXEC:8,EBADF:9,ECHILD:10,EAGAIN:11,EWOULDBLOCK:11,ENOMEM:12,EACCES:13,EFAULT:14,ENOTBLK:15,EBUSY:16,EEXIST:17,EXDEV:18,ENODEV:19,ENOTDIR:20,EISDIR:21,EINVAL:22,ENFILE:23,EMFILE:24,ENOTTY:25,ETXTBSY:26,EFBIG:27,ENOSPC:28,ESPIPE:29,EROFS:30,EMLINK:31,EPIPE:32,EDOM:33,ERANGE:34,ENOMSG:42,EIDRM:43,ECHRNG:44,EL2NSYNC:45,EL3HLT:46,EL3RST:47,ELNRNG:48,EUNATCH:49,ENOCSI:50,EL2HLT:51,EDEADLK:35,ENOLCK:37,EBADE:52,EBADR:53,EXFULL:54,ENOANO:55,EBADRQC:56,EBADSLT:57,EDEADLOCK:35,EBFONT:59,ENOSTR:60,ENODATA:61,ETIME:62,ENOSR:63,ENONET:64,ENOPKG:65,EREMOTE:66,ENOLINK:67,EADV:68,ESRMNT:69,ECOMM:70,EPROTO:71,EMULTIHOP:72,EDOTDOT:73,EBADMSG:74,ENOTUNIQ:76,EBADFD:77,EREMCHG:78,ELIBACC:79,ELIBBAD:80,ELIBSCN:81,ELIBMAX:82,ELIBEXEC:83,ENOSYS:38,ENOTEMPTY:39,ENAMETOOLONG:36,ELOOP:40,EOPNOTSUPP:95,EPFNOSUPPORT:96,ECONNRESET:104,ENOBUFS:105,EAFNOSUPPORT:97,EPROTOTYPE:91,ENOTSOCK:88,ENOPROTOOPT:92,ESHUTDOWN:108,ECONNREFUSED:111,EADDRINUSE:98,ECONNABORTED:103,ENETUNREACH:101,ENETDOWN:100,ETIMEDOUT:110,EHOSTDOWN:112,EHOSTUNREACH:113,EINPROGRESS:115,EALREADY:114,EDESTADDRREQ:89,EMSGSIZE:90,EPROTONOSUPPORT:93,ESOCKTNOSUPPORT:94,EADDRNOTAVAIL:99,ENETRESET:102,EISCONN:106,ENOTCONN:107,ETOOMANYREFS:109,EUSERS:87,EDQUOT:122,ESTALE:116,ENOTSUP:95,ENOMEDIUM:123,EILSEQ:84,EOVERFLOW:75,ECANCELED:125,ENOTRECOVERABLE:131,EOWNERDEAD:130,ESTRPIPE:86};function _sysconf(name) {
      // long sysconf(int name);
      // http://pubs.opengroup.org/onlinepubs/009695399/functions/sysconf.html
      switch(name) {
        case 30: return PAGE_SIZE;
        case 132:
        case 133:
        case 12:
        case 137:
        case 138:
        case 15:
        case 235:
        case 16:
        case 17:
        case 18:
        case 19:
        case 20:
        case 149:
        case 13:
        case 10:
        case 236:
        case 153:
        case 9:
        case 21:
        case 22:
        case 159:
        case 154:
        case 14:
        case 77:
        case 78:
        case 139:
        case 80:
        case 81:
        case 79:
        case 82:
        case 68:
        case 67:
        case 164:
        case 11:
        case 29:
        case 47:
        case 48:
        case 95:
        case 52:
        case 51:
        case 46:
          return 200809;
        case 27:
        case 246:
        case 127:
        case 128:
        case 23:
        case 24:
        case 160:
        case 161:
        case 181:
        case 182:
        case 242:
        case 183:
        case 184:
        case 243:
        case 244:
        case 245:
        case 165:
        case 178:
        case 179:
        case 49:
        case 50:
        case 168:
        case 169:
        case 175:
        case 170:
        case 171:
        case 172:
        case 97:
        case 76:
        case 32:
        case 173:
        case 35:
          return -1;
        case 176:
        case 177:
        case 7:
        case 155:
        case 8:
        case 157:
        case 125:
        case 126:
        case 92:
        case 93:
        case 129:
        case 130:
        case 131:
        case 94:
        case 91:
          return 1;
        case 74:
        case 60:
        case 69:
        case 70:
        case 4:
          return 1024;
        case 31:
        case 42:
        case 72:
          return 32;
        case 87:
        case 26:
        case 33:
          return 2147483647;
        case 34:
        case 1:
          return 47839;
        case 38:
        case 36:
          return 99;
        case 43:
        case 37:
          return 2048;
        case 0: return 2097152;
        case 3: return 65536;
        case 28: return 32768;
        case 44: return 32767;
        case 75: return 16384;
        case 39: return 1000;
        case 89: return 700;
        case 71: return 256;
        case 40: return 255;
        case 2: return 100;
        case 180: return 64;
        case 25: return 20;
        case 5: return 16;
        case 6: return 6;
        case 73: return 4;
        case 84: return 1;
      }
      ___setErrNo(ERRNO_CODES.EINVAL);
      return -1;
    }

  function _time(ptr) {
      var ret = Math.floor(Date.now()/1000);
      if (ptr) {
        HEAP32[((ptr)>>2)]=ret;
      }
      return ret;
    }

  function ___cxa_call_unexpected(exception) {
      Module.printErr('Unexpected exception thrown, this is not properly supported - aborting');
      ABORT = true;
      throw exception;
    }






  
  
  
  var ERRNO_MESSAGES={0:"Success",1:"Not super-user",2:"No such file or directory",3:"No such process",4:"Interrupted system call",5:"I/O error",6:"No such device or address",7:"Arg list too long",8:"Exec format error",9:"Bad file number",10:"No children",11:"No more processes",12:"Not enough core",13:"Permission denied",14:"Bad address",15:"Block device required",16:"Mount device busy",17:"File exists",18:"Cross-device link",19:"No such device",20:"Not a directory",21:"Is a directory",22:"Invalid argument",23:"Too many open files in system",24:"Too many open files",25:"Not a typewriter",26:"Text file busy",27:"File too large",28:"No space left on device",29:"Illegal seek",30:"Read only file system",31:"Too many links",32:"Broken pipe",33:"Math arg out of domain of func",34:"Math result not representable",35:"File locking deadlock error",36:"File or path name too long",37:"No record locks available",38:"Function not implemented",39:"Directory not empty",40:"Too many symbolic links",42:"No message of desired type",43:"Identifier removed",44:"Channel number out of range",45:"Level 2 not synchronized",46:"Level 3 halted",47:"Level 3 reset",48:"Link number out of range",49:"Protocol driver not attached",50:"No CSI structure available",51:"Level 2 halted",52:"Invalid exchange",53:"Invalid request descriptor",54:"Exchange full",55:"No anode",56:"Invalid request code",57:"Invalid slot",59:"Bad font file fmt",60:"Device not a stream",61:"No data (for no delay io)",62:"Timer expired",63:"Out of streams resources",64:"Machine is not on the network",65:"Package not installed",66:"The object is remote",67:"The link has been severed",68:"Advertise error",69:"Srmount error",70:"Communication error on send",71:"Protocol error",72:"Multihop attempted",73:"Cross mount point (not really error)",74:"Trying to read unreadable message",75:"Value too large for defined data type",76:"Given log. name not unique",77:"f.d. invalid for this operation",78:"Remote address changed",79:"Can   access a needed shared lib",80:"Accessing a corrupted shared lib",81:".lib section in a.out corrupted",82:"Attempting to link in too many libs",83:"Attempting to exec a shared library",84:"Illegal byte sequence",86:"Streams pipe error",87:"Too many users",88:"Socket operation on non-socket",89:"Destination address required",90:"Message too long",91:"Protocol wrong type for socket",92:"Protocol not available",93:"Unknown protocol",94:"Socket type not supported",95:"Not supported",96:"Protocol family not supported",97:"Address family not supported by protocol family",98:"Address already in use",99:"Address not available",100:"Network interface is not configured",101:"Network is unreachable",102:"Connection reset by network",103:"Connection aborted",104:"Connection reset by peer",105:"No buffer space available",106:"Socket is already connected",107:"Socket is not connected",108:"Can't send after socket shutdown",109:"Too many references",110:"Connection timed out",111:"Connection refused",112:"Host is down",113:"Host is unreachable",114:"Socket already connected",115:"Connection already in progress",116:"Stale file handle",122:"Quota exceeded",123:"No medium (in tape drive)",125:"Operation canceled",130:"Previous owner died",131:"State not recoverable"};
  
  var TTY={ttys:[],init:function () {
        // https://github.com/kripken/emscripten/pull/1555
        // if (ENVIRONMENT_IS_NODE) {
        //   // currently, FS.init does not distinguish if process.stdin is a file or TTY
        //   // device, it always assumes it's a TTY device. because of this, we're forcing
        //   // process.stdin to UTF8 encoding to at least make stdin reading compatible
        //   // with text files until FS.init can be refactored.
        //   process['stdin']['setEncoding']('utf8');
        // }
      },shutdown:function() {
        // https://github.com/kripken/emscripten/pull/1555
        // if (ENVIRONMENT_IS_NODE) {
        //   // inolen: any idea as to why node -e 'process.stdin.read()' wouldn't exit immediately (with process.stdin being a tty)?
        //   // isaacs: because now it's reading from the stream, you've expressed interest in it, so that read() kicks off a _read() which creates a ReadReq operation
        //   // inolen: I thought read() in that case was a synchronous operation that just grabbed some amount of buffered data if it exists?
        //   // isaacs: it is. but it also triggers a _read() call, which calls readStart() on the handle
        //   // isaacs: do process.stdin.pause() and i'd think it'd probably close the pending call
        //   process['stdin']['pause']();
        // }
      },register:function(dev, ops) {
        TTY.ttys[dev] = { input: [], output: [], ops: ops };
        FS.registerDevice(dev, TTY.stream_ops);
      },stream_ops:{open:function(stream) {
          var tty = TTY.ttys[stream.node.rdev];
          if (!tty) {
            throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
          }
          stream.tty = tty;
          stream.seekable = false;
        },close:function(stream) {
          // flush any pending line data
          if (stream.tty.output.length) {
            stream.tty.ops.put_char(stream.tty, 10);
          }
        },read:function(stream, buffer, offset, length, pos /* ignored */) {
          if (!stream.tty || !stream.tty.ops.get_char) {
            throw new FS.ErrnoError(ERRNO_CODES.ENXIO);
          }
          var bytesRead = 0;
          for (var i = 0; i < length; i++) {
            var result;
            try {
              result = stream.tty.ops.get_char(stream.tty);
            } catch (e) {
              throw new FS.ErrnoError(ERRNO_CODES.EIO);
            }
            if (result === undefined && bytesRead === 0) {
              throw new FS.ErrnoError(ERRNO_CODES.EAGAIN);
            }
            if (result === null || result === undefined) break;
            bytesRead++;
            buffer[offset+i] = result;
          }
          if (bytesRead) {
            stream.node.timestamp = Date.now();
          }
          return bytesRead;
        },write:function(stream, buffer, offset, length, pos) {
          if (!stream.tty || !stream.tty.ops.put_char) {
            throw new FS.ErrnoError(ERRNO_CODES.ENXIO);
          }
          for (var i = 0; i < length; i++) {
            try {
              stream.tty.ops.put_char(stream.tty, buffer[offset+i]);
            } catch (e) {
              throw new FS.ErrnoError(ERRNO_CODES.EIO);
            }
          }
          if (length) {
            stream.node.timestamp = Date.now();
          }
          return i;
        }},default_tty_ops:{get_char:function(tty) {
          if (!tty.input.length) {
            var result = null;
            if (ENVIRONMENT_IS_NODE) {
              result = process['stdin']['read']();
              if (!result) {
                if (process['stdin']['_readableState'] && process['stdin']['_readableState']['ended']) {
                  return null;  // EOF
                }
                return undefined;  // no data available
              }
            } else if (typeof window != 'undefined' &&
              typeof window.prompt == 'function') {
              // Browser.
              result = window.prompt('Input: ');  // returns null on cancel
              if (result !== null) {
                result += '\n';
              }
            } else if (typeof readline == 'function') {
              // Command line.
              result = readline();
              if (result !== null) {
                result += '\n';
              }
            }
            if (!result) {
              return null;
            }
            tty.input = intArrayFromString(result, true);
          }
          return tty.input.shift();
        },put_char:function(tty, val) {
          if (val === null || val === 10) {
            Module['print'](tty.output.join(''));
            tty.output = [];
          } else {
            tty.output.push(TTY.utf8.processCChar(val));
          }
        }},default_tty1_ops:{put_char:function(tty, val) {
          if (val === null || val === 10) {
            Module['printErr'](tty.output.join(''));
            tty.output = [];
          } else {
            tty.output.push(TTY.utf8.processCChar(val));
          }
        }}};
  
  var MEMFS={ops_table:null,CONTENT_OWNING:1,CONTENT_FLEXIBLE:2,CONTENT_FIXED:3,mount:function(mount) {
        return MEMFS.createNode(null, '/', 16384 | 0777, 0);
      },createNode:function(parent, name, mode, dev) {
        if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
          // no supported
          throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        if (!MEMFS.ops_table) {
          MEMFS.ops_table = {
            dir: {
              node: {
                getattr: MEMFS.node_ops.getattr,
                setattr: MEMFS.node_ops.setattr,
                lookup: MEMFS.node_ops.lookup,
                mknod: MEMFS.node_ops.mknod,
                mknod: MEMFS.node_ops.mknod,
                rename: MEMFS.node_ops.rename,
                unlink: MEMFS.node_ops.unlink,
                rmdir: MEMFS.node_ops.rmdir,
                readdir: MEMFS.node_ops.readdir,
                symlink: MEMFS.node_ops.symlink
              },
              stream: {
                llseek: MEMFS.stream_ops.llseek
              }
            },
            file: {
              node: {
                getattr: MEMFS.node_ops.getattr,
                setattr: MEMFS.node_ops.setattr
              },
              stream: {
                llseek: MEMFS.stream_ops.llseek,
                read: MEMFS.stream_ops.read,
                write: MEMFS.stream_ops.write,
                allocate: MEMFS.stream_ops.allocate,
                mmap: MEMFS.stream_ops.mmap
              }
            },
            link: {
              node: {
                getattr: MEMFS.node_ops.getattr,
                setattr: MEMFS.node_ops.setattr,
                readlink: MEMFS.node_ops.readlink
              },
              stream: {}
            },
            chrdev: {
              node: {
                getattr: MEMFS.node_ops.getattr,
                setattr: MEMFS.node_ops.setattr
              },
              stream: FS.chrdev_stream_ops
            },
          };
        }
        var node = FS.createNode(parent, name, mode, dev);
        if (FS.isDir(node.mode)) {
          node.node_ops = MEMFS.ops_table.dir.node;
          node.stream_ops = MEMFS.ops_table.dir.stream;
          node.contents = {};
        } else if (FS.isFile(node.mode)) {
          node.node_ops = MEMFS.ops_table.file.node;
          node.stream_ops = MEMFS.ops_table.file.stream;
          node.contents = [];
          node.contentMode = MEMFS.CONTENT_FLEXIBLE;
        } else if (FS.isLink(node.mode)) {
          node.node_ops = MEMFS.ops_table.link.node;
          node.stream_ops = MEMFS.ops_table.link.stream;
        } else if (FS.isChrdev(node.mode)) {
          node.node_ops = MEMFS.ops_table.chrdev.node;
          node.stream_ops = MEMFS.ops_table.chrdev.stream;
        }
        node.timestamp = Date.now();
        // add the new node to the parent
        if (parent) {
          parent.contents[name] = node;
        }
        return node;
      },ensureFlexible:function(node) {
        if (node.contentMode !== MEMFS.CONTENT_FLEXIBLE) {
          var contents = node.contents;
          node.contents = Array.prototype.slice.call(contents);
          node.contentMode = MEMFS.CONTENT_FLEXIBLE;
        }
      },node_ops:{getattr:function(node) {
          var attr = {};
          // device numbers reuse inode numbers.
          attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
          attr.ino = node.id;
          attr.mode = node.mode;
          attr.nlink = 1;
          attr.uid = 0;
          attr.gid = 0;
          attr.rdev = node.rdev;
          if (FS.isDir(node.mode)) {
            attr.size = 4096;
          } else if (FS.isFile(node.mode)) {
            attr.size = node.contents.length;
          } else if (FS.isLink(node.mode)) {
            attr.size = node.link.length;
          } else {
            attr.size = 0;
          }
          attr.atime = new Date(node.timestamp);
          attr.mtime = new Date(node.timestamp);
          attr.ctime = new Date(node.timestamp);
          // NOTE: In our implementation, st_blocks = Math.ceil(st_size/st_blksize),
          //       but this is not required by the standard.
          attr.blksize = 4096;
          attr.blocks = Math.ceil(attr.size / attr.blksize);
          return attr;
        },setattr:function(node, attr) {
          if (attr.mode !== undefined) {
            node.mode = attr.mode;
          }
          if (attr.timestamp !== undefined) {
            node.timestamp = attr.timestamp;
          }
          if (attr.size !== undefined) {
            MEMFS.ensureFlexible(node);
            var contents = node.contents;
            if (attr.size < contents.length) contents.length = attr.size;
            else while (attr.size > contents.length) contents.push(0);
          }
        },lookup:function(parent, name) {
          throw FS.genericErrors[ERRNO_CODES.ENOENT];
        },mknod:function(parent, name, mode, dev) {
          return MEMFS.createNode(parent, name, mode, dev);
        },rename:function(old_node, new_dir, new_name) {
          // if we're overwriting a directory at new_name, make sure it's empty.
          if (FS.isDir(old_node.mode)) {
            var new_node;
            try {
              new_node = FS.lookupNode(new_dir, new_name);
            } catch (e) {
            }
            if (new_node) {
              for (var i in new_node.contents) {
                throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
              }
            }
          }
          // do the internal rewiring
          delete old_node.parent.contents[old_node.name];
          old_node.name = new_name;
          new_dir.contents[new_name] = old_node;
          old_node.parent = new_dir;
        },unlink:function(parent, name) {
          delete parent.contents[name];
        },rmdir:function(parent, name) {
          var node = FS.lookupNode(parent, name);
          for (var i in node.contents) {
            throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
          }
          delete parent.contents[name];
        },readdir:function(node) {
          var entries = ['.', '..']
          for (var key in node.contents) {
            if (!node.contents.hasOwnProperty(key)) {
              continue;
            }
            entries.push(key);
          }
          return entries;
        },symlink:function(parent, newname, oldpath) {
          var node = MEMFS.createNode(parent, newname, 0777 | 40960, 0);
          node.link = oldpath;
          return node;
        },readlink:function(node) {
          if (!FS.isLink(node.mode)) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
          }
          return node.link;
        }},stream_ops:{read:function(stream, buffer, offset, length, position) {
          var contents = stream.node.contents;
          if (position >= contents.length)
            return 0;
          var size = Math.min(contents.length - position, length);
          assert(size >= 0);
          if (size > 8 && contents.subarray) { // non-trivial, and typed array
            buffer.set(contents.subarray(position, position + size), offset);
          } else
          {
            for (var i = 0; i < size; i++) {
              buffer[offset + i] = contents[position + i];
            }
          }
          return size;
        },write:function(stream, buffer, offset, length, position, canOwn) {
          var node = stream.node;
          node.timestamp = Date.now();
          var contents = node.contents;
          if (length && contents.length === 0 && position === 0 && buffer.subarray) {
            // just replace it with the new data
            if (canOwn && offset === 0) {
              node.contents = buffer; // this could be a subarray of Emscripten HEAP, or allocated from some other source.
              node.contentMode = (buffer.buffer === HEAP8.buffer) ? MEMFS.CONTENT_OWNING : MEMFS.CONTENT_FIXED;
            } else {
              node.contents = new Uint8Array(buffer.subarray(offset, offset+length));
              node.contentMode = MEMFS.CONTENT_FIXED;
            }
            return length;
          }
          MEMFS.ensureFlexible(node);
          var contents = node.contents;
          while (contents.length < position) contents.push(0);
          for (var i = 0; i < length; i++) {
            contents[position + i] = buffer[offset + i];
          }
          return length;
        },llseek:function(stream, offset, whence) {
          var position = offset;
          if (whence === 1) {  // SEEK_CUR.
            position += stream.position;
          } else if (whence === 2) {  // SEEK_END.
            if (FS.isFile(stream.node.mode)) {
              position += stream.node.contents.length;
            }
          }
          if (position < 0) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
          }
          stream.ungotten = [];
          stream.position = position;
          return position;
        },allocate:function(stream, offset, length) {
          MEMFS.ensureFlexible(stream.node);
          var contents = stream.node.contents;
          var limit = offset + length;
          while (limit > contents.length) contents.push(0);
        },mmap:function(stream, buffer, offset, length, position, prot, flags) {
          if (!FS.isFile(stream.node.mode)) {
            throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
          }
          var ptr;
          var allocated;
          var contents = stream.node.contents;
          // Only make a new copy when MAP_PRIVATE is specified.
          if ( !(flags & 2) &&
                (contents.buffer === buffer || contents.buffer === buffer.buffer) ) {
            // We can't emulate MAP_SHARED when the file is not backed by the buffer
            // we're mapping to (e.g. the HEAP buffer).
            allocated = false;
            ptr = contents.byteOffset;
          } else {
            // Try to avoid unnecessary slices.
            if (position > 0 || position + length < contents.length) {
              if (contents.subarray) {
                contents = contents.subarray(position, position + length);
              } else {
                contents = Array.prototype.slice.call(contents, position, position + length);
              }
            }
            allocated = true;
            ptr = _malloc(length);
            if (!ptr) {
              throw new FS.ErrnoError(ERRNO_CODES.ENOMEM);
            }
            buffer.set(contents, ptr);
          }
          return { ptr: ptr, allocated: allocated };
        }}};
  
  var IDBFS={dbs:{},indexedDB:function() {
        return window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
      },DB_VERSION:20,DB_STORE_NAME:"FILE_DATA",mount:function(mount) {
        return MEMFS.mount.apply(null, arguments);
      },syncfs:function(mount, populate, callback) {
        IDBFS.getLocalSet(mount, function(err, local) {
          if (err) return callback(err);
  
          IDBFS.getRemoteSet(mount, function(err, remote) {
            if (err) return callback(err);
  
            var src = populate ? remote : local;
            var dst = populate ? local : remote;
  
            IDBFS.reconcile(src, dst, callback);
          });
        });
      },reconcile:function(src, dst, callback) {
        var total = 0;
  
        var create = {};
        for (var key in src.files) {
          if (!src.files.hasOwnProperty(key)) continue;
          var e = src.files[key];
          var e2 = dst.files[key];
          if (!e2 || e.timestamp > e2.timestamp) {
            create[key] = e;
            total++;
          }
        }
  
        var remove = {};
        for (var key in dst.files) {
          if (!dst.files.hasOwnProperty(key)) continue;
          var e = dst.files[key];
          var e2 = src.files[key];
          if (!e2) {
            remove[key] = e;
            total++;
          }
        }
  
        if (!total) {
          // early out
          return callback(null);
        }
  
        var completed = 0;
        function done(err) {
          if (err) return callback(err);
          if (++completed >= total) {
            return callback(null);
          }
        };
  
        // create a single transaction to handle and IDB reads / writes we'll need to do
        var db = src.type === 'remote' ? src.db : dst.db;
        var transaction = db.transaction([IDBFS.DB_STORE_NAME], 'readwrite');
        transaction.onerror = function transaction_onerror() { callback(this.error); };
        var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
  
        for (var path in create) {
          if (!create.hasOwnProperty(path)) continue;
          var entry = create[path];
  
          if (dst.type === 'local') {
            // save file to local
            try {
              if (FS.isDir(entry.mode)) {
                FS.mkdir(path, entry.mode);
              } else if (FS.isFile(entry.mode)) {
                var stream = FS.open(path, 'w+', 0666);
                FS.write(stream, entry.contents, 0, entry.contents.length, 0, true /* canOwn */);
                FS.close(stream);
              }
              done(null);
            } catch (e) {
              return done(e);
            }
          } else {
            // save file to IDB
            var req = store.put(entry, path);
            req.onsuccess = function req_onsuccess() { done(null); };
            req.onerror = function req_onerror() { done(this.error); };
          }
        }
  
        for (var path in remove) {
          if (!remove.hasOwnProperty(path)) continue;
          var entry = remove[path];
  
          if (dst.type === 'local') {
            // delete file from local
            try {
              if (FS.isDir(entry.mode)) {
                // TODO recursive delete?
                FS.rmdir(path);
              } else if (FS.isFile(entry.mode)) {
                FS.unlink(path);
              }
              done(null);
            } catch (e) {
              return done(e);
            }
          } else {
            // delete file from IDB
            var req = store.delete(path);
            req.onsuccess = function req_onsuccess() { done(null); };
            req.onerror = function req_onerror() { done(this.error); };
          }
        }
      },getLocalSet:function(mount, callback) {
        var files = {};
  
        function isRealDir(p) {
          return p !== '.' && p !== '..';
        };
        function toAbsolute(root) {
          return function(p) {
            return PATH.join2(root, p);
          }
        };
  
        var check = FS.readdir(mount.mountpoint)
          .filter(isRealDir)
          .map(toAbsolute(mount.mountpoint));
  
        while (check.length) {
          var path = check.pop();
          var stat, node;
  
          try {
            var lookup = FS.lookupPath(path);
            node = lookup.node;
            stat = FS.stat(path);
          } catch (e) {
            return callback(e);
          }
  
          if (FS.isDir(stat.mode)) {
            check.push.apply(check, FS.readdir(path)
              .filter(isRealDir)
              .map(toAbsolute(path)));
  
            files[path] = { mode: stat.mode, timestamp: stat.mtime };
          } else if (FS.isFile(stat.mode)) {
            files[path] = { contents: node.contents, mode: stat.mode, timestamp: stat.mtime };
          } else {
            return callback(new Error('node type not supported'));
          }
        }
  
        return callback(null, { type: 'local', files: files });
      },getDB:function(name, callback) {
        // look it up in the cache
        var db = IDBFS.dbs[name];
        if (db) {
          return callback(null, db);
        }
        var req;
        try {
          req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION);
        } catch (e) {
          return onerror(e);
        }
        req.onupgradeneeded = function req_onupgradeneeded() {
          db = req.result;
          db.createObjectStore(IDBFS.DB_STORE_NAME);
        };
        req.onsuccess = function req_onsuccess() {
          db = req.result;
          // add to the cache
          IDBFS.dbs[name] = db;
          callback(null, db);
        };
        req.onerror = function req_onerror() {
          callback(this.error);
        };
      },getRemoteSet:function(mount, callback) {
        var files = {};
  
        IDBFS.getDB(mount.mountpoint, function(err, db) {
          if (err) return callback(err);
  
          var transaction = db.transaction([IDBFS.DB_STORE_NAME], 'readonly');
          transaction.onerror = function transaction_onerror() { callback(this.error); };
  
          var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
          store.openCursor().onsuccess = function store_openCursor_onsuccess(event) {
            var cursor = event.target.result;
            if (!cursor) {
              return callback(null, { type: 'remote', db: db, files: files });
            }
  
            files[cursor.key] = cursor.value;
            cursor.continue();
          };
        });
      }};
  
  var NODEFS={isWindows:false,staticInit:function() {
        NODEFS.isWindows = !!process.platform.match(/^win/);
      },mount:function (mount) {
        assert(ENVIRONMENT_IS_NODE);
        return NODEFS.createNode(null, '/', NODEFS.getMode(mount.opts.root), 0);
      },createNode:function (parent, name, mode, dev) {
        if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        var node = FS.createNode(parent, name, mode);
        node.node_ops = NODEFS.node_ops;
        node.stream_ops = NODEFS.stream_ops;
        return node;
      },getMode:function (path) {
        var stat;
        try {
          stat = fs.lstatSync(path);
          if (NODEFS.isWindows) {
            // On Windows, directories return permission bits 'rw-rw-rw-', even though they have 'rwxrwxrwx', so 
            // propagate write bits to execute bits.
            stat.mode = stat.mode | ((stat.mode & 146) >> 1);
          }
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(ERRNO_CODES[e.code]);
        }
        return stat.mode;
      },realPath:function (node) {
        var parts = [];
        while (node.parent !== node) {
          parts.push(node.name);
          node = node.parent;
        }
        parts.push(node.mount.opts.root);
        parts.reverse();
        return PATH.join.apply(null, parts);
      },flagsToPermissionStringMap:{0:"r",1:"r+",2:"r+",64:"r",65:"r+",66:"r+",129:"rx+",193:"rx+",514:"w+",577:"w",578:"w+",705:"wx",706:"wx+",1024:"a",1025:"a",1026:"a+",1089:"a",1090:"a+",1153:"ax",1154:"ax+",1217:"ax",1218:"ax+",4096:"rs",4098:"rs+"},flagsToPermissionString:function(flags) {
        if (flags in NODEFS.flagsToPermissionStringMap) {
          return NODEFS.flagsToPermissionStringMap[flags];
        } else {
          return flags;
        }
      },node_ops:{getattr:function(node) {
          var path = NODEFS.realPath(node);
          var stat;
          try {
            stat = fs.lstatSync(path);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
          // node.js v0.10.20 doesn't report blksize and blocks on Windows. Fake them with default blksize of 4096.
          // See http://support.microsoft.com/kb/140365
          if (NODEFS.isWindows && !stat.blksize) {
            stat.blksize = 4096;
          }
          if (NODEFS.isWindows && !stat.blocks) {
            stat.blocks = (stat.size+stat.blksize-1)/stat.blksize|0;
          }
          return {
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode,
            nlink: stat.nlink,
            uid: stat.uid,
            gid: stat.gid,
            rdev: stat.rdev,
            size: stat.size,
            atime: stat.atime,
            mtime: stat.mtime,
            ctime: stat.ctime,
            blksize: stat.blksize,
            blocks: stat.blocks
          };
        },setattr:function(node, attr) {
          var path = NODEFS.realPath(node);
          try {
            if (attr.mode !== undefined) {
              fs.chmodSync(path, attr.mode);
              // update the common node structure mode as well
              node.mode = attr.mode;
            }
            if (attr.timestamp !== undefined) {
              var date = new Date(attr.timestamp);
              fs.utimesSync(path, date, date);
            }
            if (attr.size !== undefined) {
              fs.truncateSync(path, attr.size);
            }
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
        },lookup:function (parent, name) {
          var path = PATH.join2(NODEFS.realPath(parent), name);
          var mode = NODEFS.getMode(path);
          return NODEFS.createNode(parent, name, mode);
        },mknod:function (parent, name, mode, dev) {
          var node = NODEFS.createNode(parent, name, mode, dev);
          // create the backing node for this in the fs root as well
          var path = NODEFS.realPath(node);
          try {
            if (FS.isDir(node.mode)) {
              fs.mkdirSync(path, node.mode);
            } else {
              fs.writeFileSync(path, '', { mode: node.mode });
            }
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
          return node;
        },rename:function (oldNode, newDir, newName) {
          var oldPath = NODEFS.realPath(oldNode);
          var newPath = PATH.join2(NODEFS.realPath(newDir), newName);
          try {
            fs.renameSync(oldPath, newPath);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
        },unlink:function(parent, name) {
          var path = PATH.join2(NODEFS.realPath(parent), name);
          try {
            fs.unlinkSync(path);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
        },rmdir:function(parent, name) {
          var path = PATH.join2(NODEFS.realPath(parent), name);
          try {
            fs.rmdirSync(path);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
        },readdir:function(node) {
          var path = NODEFS.realPath(node);
          try {
            return fs.readdirSync(path);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
        },symlink:function(parent, newName, oldPath) {
          var newPath = PATH.join2(NODEFS.realPath(parent), newName);
          try {
            fs.symlinkSync(oldPath, newPath);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
        },readlink:function(node) {
          var path = NODEFS.realPath(node);
          try {
            return fs.readlinkSync(path);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
        }},stream_ops:{open:function (stream) {
          var path = NODEFS.realPath(stream.node);
          try {
            if (FS.isFile(stream.node.mode)) {
              stream.nfd = fs.openSync(path, NODEFS.flagsToPermissionString(stream.flags));
            }
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
        },close:function (stream) {
          try {
            if (FS.isFile(stream.node.mode) && stream.nfd) {
              fs.closeSync(stream.nfd);
            }
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
        },read:function (stream, buffer, offset, length, position) {
          // FIXME this is terrible.
          var nbuffer = new Buffer(length);
          var res;
          try {
            res = fs.readSync(stream.nfd, nbuffer, 0, length, position);
          } catch (e) {
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
          if (res > 0) {
            for (var i = 0; i < res; i++) {
              buffer[offset + i] = nbuffer[i];
            }
          }
          return res;
        },write:function (stream, buffer, offset, length, position) {
          // FIXME this is terrible.
          var nbuffer = new Buffer(buffer.subarray(offset, offset + length));
          var res;
          try {
            res = fs.writeSync(stream.nfd, nbuffer, 0, length, position);
          } catch (e) {
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
          }
          return res;
        },llseek:function (stream, offset, whence) {
          var position = offset;
          if (whence === 1) {  // SEEK_CUR.
            position += stream.position;
          } else if (whence === 2) {  // SEEK_END.
            if (FS.isFile(stream.node.mode)) {
              try {
                var stat = fs.fstatSync(stream.nfd);
                position += stat.size;
              } catch (e) {
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
              }
            }
          }
  
          if (position < 0) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
          }
  
          stream.position = position;
          return position;
        }}};
  
  var _stdin=allocate(1, "i32*", ALLOC_STATIC);
  
  var _stdout=allocate(1, "i32*", ALLOC_STATIC);
  
  var _stderr=allocate(1, "i32*", ALLOC_STATIC);
  
  function _fflush(stream) {
      // int fflush(FILE *stream);
      // http://pubs.opengroup.org/onlinepubs/000095399/functions/fflush.html
      // we don't currently perform any user-space buffering of data
    }var FS={root:null,mounts:[],devices:[null],streams:[null],nextInode:1,nameTable:null,currentPath:"/",initialized:false,ignorePermissions:true,ErrnoError:null,genericErrors:{},handleFSError:function(e) {
        if (!(e instanceof FS.ErrnoError)) throw e + ' : ' + stackTrace();
        return ___setErrNo(e.errno);
      },lookupPath:function(path, opts) {
        path = PATH.resolve(FS.cwd(), path);
        opts = opts || { recurse_count: 0 };
  
        if (opts.recurse_count > 8) {  // max recursive lookup of 8
          throw new FS.ErrnoError(ERRNO_CODES.ELOOP);
        }
  
        // split the path
        var parts = PATH.normalizeArray(path.split('/').filter(function(p) {
          return !!p;
        }), false);
  
        // start at the root
        var current = FS.root;
        var current_path = '/';
  
        for (var i = 0; i < parts.length; i++) {
          var islast = (i === parts.length-1);
          if (islast && opts.parent) {
            // stop resolving
            break;
          }
  
          current = FS.lookupNode(current, parts[i]);
          current_path = PATH.join2(current_path, parts[i]);
  
          // jump to the mount's root node if this is a mountpoint
          if (FS.isMountpoint(current)) {
            current = current.mount.root;
          }
  
          // follow symlinks
          // by default, lookupPath will not follow a symlink if it is the final path component.
          // setting opts.follow = true will override this behavior.
          if (!islast || opts.follow) {
            var count = 0;
            while (FS.isLink(current.mode)) {
              var link = FS.readlink(current_path);
              current_path = PATH.resolve(PATH.dirname(current_path), link);
              
              var lookup = FS.lookupPath(current_path, { recurse_count: opts.recurse_count });
              current = lookup.node;
  
              if (count++ > 40) {  // limit max consecutive symlinks to 40 (SYMLOOP_MAX).
                throw new FS.ErrnoError(ERRNO_CODES.ELOOP);
              }
            }
          }
        }
  
        return { path: current_path, node: current };
      },getPath:function(node) {
        var path;
        while (true) {
          if (FS.isRoot(node)) {
            var mount = node.mount.mountpoint;
            if (!path) return mount;
            return mount[mount.length-1] !== '/' ? mount + '/' + path : mount + path;
          }
          path = path ? node.name + '/' + path : node.name;
          node = node.parent;
        }
      },hashName:function(parentid, name) {
        var hash = 0;
  
  
        for (var i = 0; i < name.length; i++) {
          hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
        }
        return ((parentid + hash) >>> 0) % FS.nameTable.length;
      },hashAddNode:function(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        node.name_next = FS.nameTable[hash];
        FS.nameTable[hash] = node;
      },hashRemoveNode:function(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        if (FS.nameTable[hash] === node) {
          FS.nameTable[hash] = node.name_next;
        } else {
          var current = FS.nameTable[hash];
          while (current) {
            if (current.name_next === node) {
              current.name_next = node.name_next;
              break;
            }
            current = current.name_next;
          }
        }
      },lookupNode:function(parent, name) {
        var err = FS.mayLookup(parent);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        var hash = FS.hashName(parent.id, name);
        for (var node = FS.nameTable[hash]; node; node = node.name_next) {
          var nodeName = node.name;
          if (node.parent.id === parent.id && nodeName === name) {
            return node;
          }
        }
        // if we failed to find it in the cache, call into the VFS
        return FS.lookup(parent, name);
      },createNode:function(parent, name, mode, rdev) {
        if (!FS.FSNode) {
          FS.FSNode = function(parent, name, mode, rdev) {
            this.id = FS.nextInode++;
            this.name = name;
            this.mode = mode;
            this.node_ops = {};
            this.stream_ops = {};
            this.rdev = rdev;
            this.parent = null;
            this.mount = null;
            if (!parent) {
              parent = this;  // root node sets parent to itself
            }
            this.parent = parent;
            this.mount = parent.mount;
            FS.hashAddNode(this);
          };
  
          // compatibility
          var readMode = 292 | 73;
          var writeMode = 146;
  
          FS.FSNode.prototype = {};
  
          // NOTE we must use Object.defineProperties instead of individual calls to
          // Object.defineProperty in order to make closure compiler happy
          Object.defineProperties(FS.FSNode.prototype, {
            read: {
              get: function() { return (this.mode & readMode) === readMode; },
              set: function(val) { val ? this.mode |= readMode : this.mode &= ~readMode; }
            },
            write: {
              get: function() { return (this.mode & writeMode) === writeMode; },
              set: function(val) { val ? this.mode |= writeMode : this.mode &= ~writeMode; }
            },
            isFolder: {
              get: function() { return FS.isDir(this.mode); },
            },
            isDevice: {
              get: function() { return FS.isChrdev(this.mode); },
            },
          });
        }
        return new FS.FSNode(parent, name, mode, rdev);
      },destroyNode:function(node) {
        FS.hashRemoveNode(node);
      },isRoot:function(node) {
        return node === node.parent;
      },isMountpoint:function(node) {
        return node.mounted;
      },isFile:function(mode) {
        return (mode & 61440) === 32768;
      },isDir:function(mode) {
        return (mode & 61440) === 16384;
      },isLink:function(mode) {
        return (mode & 61440) === 40960;
      },isChrdev:function(mode) {
        return (mode & 61440) === 8192;
      },isBlkdev:function(mode) {
        return (mode & 61440) === 24576;
      },isFIFO:function(mode) {
        return (mode & 61440) === 4096;
      },isSocket:function(mode) {
        return (mode & 49152) === 49152;
      },flagModes:{"r":0,"rs":1052672,"r+":2,"w":577,"wx":705,"xw":705,"w+":578,"wx+":706,"xw+":706,"a":1089,"ax":1217,"xa":1217,"a+":1090,"ax+":1218,"xa+":1218},modeStringToFlags:function(str) {
        var flags = FS.flagModes[str];
        if (typeof flags === 'undefined') {
          throw new Error('Unknown file open mode: ' + str);
        }
        return flags;
      },flagsToPermissionString:function(flag) {
        var accmode = flag & 2097155;
        var perms = ['r', 'w', 'rw'][accmode];
        if ((flag & 512)) {
          perms += 'w';
        }
        return perms;
      },nodePermissions:function(node, perms) {
        if (FS.ignorePermissions) {
          return 0;
        }
        // return 0 if any user, group or owner bits are set.
        if (perms.indexOf('r') !== -1 && !(node.mode & 292)) {
          return ERRNO_CODES.EACCES;
        } else if (perms.indexOf('w') !== -1 && !(node.mode & 146)) {
          return ERRNO_CODES.EACCES;
        } else if (perms.indexOf('x') !== -1 && !(node.mode & 73)) {
          return ERRNO_CODES.EACCES;
        }
        return 0;
      },mayLookup:function(dir) {
        return FS.nodePermissions(dir, 'x');
      },mayCreate:function(dir, name) {
        try {
          var node = FS.lookupNode(dir, name);
          return ERRNO_CODES.EEXIST;
        } catch (e) {
        }
        return FS.nodePermissions(dir, 'wx');
      },mayDelete:function(dir, name, isdir) {
        var node;
        try {
          node = FS.lookupNode(dir, name);
        } catch (e) {
          return e.errno;
        }
        var err = FS.nodePermissions(dir, 'wx');
        if (err) {
          return err;
        }
        if (isdir) {
          if (!FS.isDir(node.mode)) {
            return ERRNO_CODES.ENOTDIR;
          }
          if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
            return ERRNO_CODES.EBUSY;
          }
        } else {
          if (FS.isDir(node.mode)) {
            return ERRNO_CODES.EISDIR;
          }
        }
        return 0;
      },mayOpen:function(node, flags) {
        if (!node) {
          return ERRNO_CODES.ENOENT;
        }
        if (FS.isLink(node.mode)) {
          return ERRNO_CODES.ELOOP;
        } else if (FS.isDir(node.mode)) {
          if ((flags & 2097155) !== 0 ||  // opening for write
              (flags & 512)) {
            return ERRNO_CODES.EISDIR;
          }
        }
        return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
      },MAX_OPEN_FDS:4096,nextfd:function(fd_start, fd_end) {
        fd_start = fd_start || 1;
        fd_end = fd_end || FS.MAX_OPEN_FDS;
        for (var fd = fd_start; fd <= fd_end; fd++) {
          if (!FS.streams[fd]) {
            return fd;
          }
        }
        throw new FS.ErrnoError(ERRNO_CODES.EMFILE);
      },getStream:function(fd) {
        return FS.streams[fd];
      },createStream:function(stream, fd_start, fd_end) {
        if (!FS.FSStream) {
          FS.FSStream = function(){};
          FS.FSStream.prototype = {};
          // compatibility
          Object.defineProperties(FS.FSStream.prototype, {
            object: {
              get: function() { return this.node; },
              set: function(val) { this.node = val; }
            },
            isRead: {
              get: function() { return (this.flags & 2097155) !== 1; }
            },
            isWrite: {
              get: function() { return (this.flags & 2097155) !== 0; }
            },
            isAppend: {
              get: function() { return (this.flags & 1024); }
            }
          });
        }
        if (stream.__proto__) {
          // reuse the object
          stream.__proto__ = FS.FSStream.prototype;
        } else {
          var newStream = new FS.FSStream();
          for (var p in stream) {
            newStream[p] = stream[p];
          }
          stream = newStream;
        }
        var fd = FS.nextfd(fd_start, fd_end);
        stream.fd = fd;
        FS.streams[fd] = stream;
        return stream;
      },closeStream:function(fd) {
        FS.streams[fd] = null;
      },chrdev_stream_ops:{open:function(stream) {
          var device = FS.getDevice(stream.node.rdev);
          // override node's stream ops with the device's
          stream.stream_ops = device.stream_ops;
          // forward the open call
          if (stream.stream_ops.open) {
            stream.stream_ops.open(stream);
          }
        },llseek:function() {
          throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
        }},major:function(dev) {
        return ((dev) >> 8);
      },minor:function(dev) {
        return ((dev) & 0xff);
      },makedev:function(ma, mi) {
        return ((ma) << 8 | (mi));
      },registerDevice:function(dev, ops) {
        FS.devices[dev] = { stream_ops: ops };
      },getDevice:function(dev) {
        return FS.devices[dev];
      },syncfs:function(populate, callback) {
        if (typeof(populate) === 'function') {
          callback = populate;
          populate = false;
        }
  
        var completed = 0;
        var total = FS.mounts.length;
        function done(err) {
          if (err) {
            return callback(err);
          }
          if (++completed >= total) {
            callback(null);
          }
        };
  
        // sync all mounts
        for (var i = 0; i < FS.mounts.length; i++) {
          var mount = FS.mounts[i];
          if (!mount.type.syncfs) {
            done(null);
            continue;
          }
          mount.type.syncfs(mount, populate, done);
        }
      },mount:function(type, opts, mountpoint) {
        var lookup;
        if (mountpoint) {
          lookup = FS.lookupPath(mountpoint, { follow: false });
          mountpoint = lookup.path;  // use the absolute path
        }
        var mount = {
          type: type,
          opts: opts,
          mountpoint: mountpoint,
          root: null
        };
        // create a root node for the fs
        var root = type.mount(mount);
        root.mount = mount;
        mount.root = root;
        // assign the mount info to the mountpoint's node
        if (lookup) {
          lookup.node.mount = mount;
          lookup.node.mounted = true;
          // compatibility update FS.root if we mount to /
          if (mountpoint === '/') {
            FS.root = mount.root;
          }
        }
        // add to our cached list of mounts
        FS.mounts.push(mount);
        return root;
      },lookup:function(parent, name) {
        return parent.node_ops.lookup(parent, name);
      },mknod:function(path, mode, dev) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var err = FS.mayCreate(parent, name);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.mknod) {
          throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        return parent.node_ops.mknod(parent, name, mode, dev);
      },create:function(path, mode) {
        mode = mode !== undefined ? mode : 0666;
        mode &= 4095;
        mode |= 32768;
        return FS.mknod(path, mode, 0);
      },mkdir:function(path, mode) {
        mode = mode !== undefined ? mode : 0777;
        mode &= 511 | 512;
        mode |= 16384;
        return FS.mknod(path, mode, 0);
      },mkdev:function(path, mode, dev) {
        if (typeof(dev) === 'undefined') {
          dev = mode;
          mode = 0666;
        }
        mode |= 8192;
        return FS.mknod(path, mode, dev);
      },symlink:function(oldpath, newpath) {
        var lookup = FS.lookupPath(newpath, { parent: true });
        var parent = lookup.node;
        var newname = PATH.basename(newpath);
        var err = FS.mayCreate(parent, newname);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.symlink) {
          throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        return parent.node_ops.symlink(parent, newname, oldpath);
      },rename:function(old_path, new_path) {
        var old_dirname = PATH.dirname(old_path);
        var new_dirname = PATH.dirname(new_path);
        var old_name = PATH.basename(old_path);
        var new_name = PATH.basename(new_path);
        // parents must exist
        var lookup, old_dir, new_dir;
        try {
          lookup = FS.lookupPath(old_path, { parent: true });
          old_dir = lookup.node;
          lookup = FS.lookupPath(new_path, { parent: true });
          new_dir = lookup.node;
        } catch (e) {
          throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
        }
        // need to be part of the same mount
        if (old_dir.mount !== new_dir.mount) {
          throw new FS.ErrnoError(ERRNO_CODES.EXDEV);
        }
        // source must exist
        var old_node = FS.lookupNode(old_dir, old_name);
        // old path should not be an ancestor of the new path
        var relative = PATH.relative(old_path, new_dirname);
        if (relative.charAt(0) !== '.') {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        // new path should not be an ancestor of the old path
        relative = PATH.relative(new_path, old_dirname);
        if (relative.charAt(0) !== '.') {
          throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
        }
        // see if the new path already exists
        var new_node;
        try {
          new_node = FS.lookupNode(new_dir, new_name);
        } catch (e) {
          // not fatal
        }
        // early out if nothing needs to change
        if (old_node === new_node) {
          return;
        }
        // we'll need to delete the old entry
        var isdir = FS.isDir(old_node.mode);
        var err = FS.mayDelete(old_dir, old_name, isdir);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        // need delete permissions if we'll be overwriting.
        // need create permissions if new doesn't already exist.
        err = new_node ?
          FS.mayDelete(new_dir, new_name, isdir) :
          FS.mayCreate(new_dir, new_name);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        if (!old_dir.node_ops.rename) {
          throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        if (FS.isMountpoint(old_node) || (new_node && FS.isMountpoint(new_node))) {
          throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
        }
        // if we are going to change the parent, check write permissions
        if (new_dir !== old_dir) {
          err = FS.nodePermissions(old_dir, 'w');
          if (err) {
            throw new FS.ErrnoError(err);
          }
        }
        // remove the node from the lookup hash
        FS.hashRemoveNode(old_node);
        // do the underlying fs rename
        try {
          old_dir.node_ops.rename(old_node, new_dir, new_name);
        } catch (e) {
          throw e;
        } finally {
          // add the node back to the hash (in case node_ops.rename
          // changed its name)
          FS.hashAddNode(old_node);
        }
      },rmdir:function(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var err = FS.mayDelete(parent, name, true);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.rmdir) {
          throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
        }
        parent.node_ops.rmdir(parent, name);
        FS.destroyNode(node);
      },readdir:function(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        if (!node.node_ops.readdir) {
          throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
        }
        return node.node_ops.readdir(node);
      },unlink:function(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var err = FS.mayDelete(parent, name, false);
        if (err) {
          // POSIX says unlink should set EPERM, not EISDIR
          if (err === ERRNO_CODES.EISDIR) err = ERRNO_CODES.EPERM;
          throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.unlink) {
          throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
        }
        parent.node_ops.unlink(parent, name);
        FS.destroyNode(node);
      },readlink:function(path) {
        var lookup = FS.lookupPath(path, { follow: false });
        var link = lookup.node;
        if (!link.node_ops.readlink) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        return link.node_ops.readlink(link);
      },stat:function(path, dontFollow) {
        var lookup = FS.lookupPath(path, { follow: !dontFollow });
        var node = lookup.node;
        if (!node.node_ops.getattr) {
          throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        return node.node_ops.getattr(node);
      },lstat:function(path) {
        return FS.stat(path, true);
      },chmod:function(path, mode, dontFollow) {
        var node;
        if (typeof path === 'string') {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          node = lookup.node;
        } else {
          node = path;
        }
        if (!node.node_ops.setattr) {
          throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        node.node_ops.setattr(node, {
          mode: (mode & 4095) | (node.mode & ~4095),
          timestamp: Date.now()
        });
      },lchmod:function(path, mode) {
        FS.chmod(path, mode, true);
      },fchmod:function(fd, mode) {
        var stream = FS.getStream(fd);
        if (!stream) {
          throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        FS.chmod(stream.node, mode);
      },chown:function(path, uid, gid, dontFollow) {
        var node;
        if (typeof path === 'string') {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          node = lookup.node;
        } else {
          node = path;
        }
        if (!node.node_ops.setattr) {
          throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        node.node_ops.setattr(node, {
          timestamp: Date.now()
          // we ignore the uid / gid for now
        });
      },lchown:function(path, uid, gid) {
        FS.chown(path, uid, gid, true);
      },fchown:function(fd, uid, gid) {
        var stream = FS.getStream(fd);
        if (!stream) {
          throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        FS.chown(stream.node, uid, gid);
      },truncate:function(path, len) {
        if (len < 0) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        var node;
        if (typeof path === 'string') {
          var lookup = FS.lookupPath(path, { follow: true });
          node = lookup.node;
        } else {
          node = path;
        }
        if (!node.node_ops.setattr) {
          throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        if (FS.isDir(node.mode)) {
          throw new FS.ErrnoError(ERRNO_CODES.EISDIR);
        }
        if (!FS.isFile(node.mode)) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        var err = FS.nodePermissions(node, 'w');
        if (err) {
          throw new FS.ErrnoError(err);
        }
        node.node_ops.setattr(node, {
          size: len,
          timestamp: Date.now()
        });
      },ftruncate:function(fd, len) {
        var stream = FS.getStream(fd);
        if (!stream) {
          throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        FS.truncate(stream.node, len);
      },utime:function(path, atime, mtime) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        node.node_ops.setattr(node, {
          timestamp: Math.max(atime, mtime)
        });
      },open:function(path, flags, mode, fd_start, fd_end) {
        flags = typeof flags === 'string' ? FS.modeStringToFlags(flags) : flags;
        mode = typeof mode === 'undefined' ? 0666 : mode;
        if ((flags & 64)) {
          mode = (mode & 4095) | 32768;
        } else {
          mode = 0;
        }
        var node;
        if (typeof path === 'object') {
          node = path;
        } else {
          path = PATH.normalize(path);
          try {
            var lookup = FS.lookupPath(path, {
              follow: !(flags & 131072)
            });
            node = lookup.node;
          } catch (e) {
            // ignore
          }
        }
        // perhaps we need to create the node
        if ((flags & 64)) {
          if (node) {
            // if O_CREAT and O_EXCL are set, error out if the node already exists
            if ((flags & 128)) {
              throw new FS.ErrnoError(ERRNO_CODES.EEXIST);
            }
          } else {
            // node doesn't exist, try to create it
            node = FS.mknod(path, mode, 0);
          }
        }
        if (!node) {
          throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
        }
        // can't truncate a device
        if (FS.isChrdev(node.mode)) {
          flags &= ~512;
        }
        // check permissions
        var err = FS.mayOpen(node, flags);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        // do truncation if necessary
        if ((flags & 512)) {
          FS.truncate(node, 0);
        }
        // we've already handled these, don't pass down to the underlying vfs
        flags &= ~(128 | 512);
  
        // register the stream with the filesystem
        var stream = FS.createStream({
          node: node,
          path: FS.getPath(node),  // we want the absolute path to the node
          flags: flags,
          seekable: true,
          position: 0,
          stream_ops: node.stream_ops,
          // used by the file family libc calls (fopen, fwrite, ferror, etc.)
          ungotten: [],
          error: false
        }, fd_start, fd_end);
        // call the new stream's open function
        if (stream.stream_ops.open) {
          stream.stream_ops.open(stream);
        }
        if (Module['logReadFiles'] && !(flags & 1)) {
          if (!FS.readFiles) FS.readFiles = {};
          if (!(path in FS.readFiles)) {
            FS.readFiles[path] = 1;
            Module['printErr']('read file: ' + path);
          }
        }
        return stream;
      },close:function(stream) {
        try {
          if (stream.stream_ops.close) {
            stream.stream_ops.close(stream);
          }
        } catch (e) {
          throw e;
        } finally {
          FS.closeStream(stream.fd);
        }
      },llseek:function(stream, offset, whence) {
        if (!stream.seekable || !stream.stream_ops.llseek) {
          throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
        }
        return stream.stream_ops.llseek(stream, offset, whence);
      },read:function(stream, buffer, offset, length, position) {
        if (length < 0 || position < 0) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        if ((stream.flags & 2097155) === 1) {
          throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        if (FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(ERRNO_CODES.EISDIR);
        }
        if (!stream.stream_ops.read) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        var seeking = true;
        if (typeof position === 'undefined') {
          position = stream.position;
          seeking = false;
        } else if (!stream.seekable) {
          throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
        }
        var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
        if (!seeking) stream.position += bytesRead;
        return bytesRead;
      },write:function(stream, buffer, offset, length, position, canOwn) {
        if (length < 0 || position < 0) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        if (FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(ERRNO_CODES.EISDIR);
        }
        if (!stream.stream_ops.write) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        var seeking = true;
        if (typeof position === 'undefined') {
          position = stream.position;
          seeking = false;
        } else if (!stream.seekable) {
          throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
        }
        if (stream.flags & 1024) {
          // seek to the end before writing in append mode
          FS.llseek(stream, 0, 2);
        }
        var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
        if (!seeking) stream.position += bytesWritten;
        return bytesWritten;
      },allocate:function(stream, offset, length) {
        if (offset < 0 || length <= 0) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        if (!FS.isFile(stream.node.mode) && !FS.isDir(node.mode)) {
          throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
        }
        if (!stream.stream_ops.allocate) {
          throw new FS.ErrnoError(ERRNO_CODES.EOPNOTSUPP);
        }
        stream.stream_ops.allocate(stream, offset, length);
      },mmap:function(stream, buffer, offset, length, position, prot, flags) {
        // TODO if PROT is PROT_WRITE, make sure we have write access
        if ((stream.flags & 2097155) === 1) {
          throw new FS.ErrnoError(ERRNO_CODES.EACCES);
        }
        if (!stream.stream_ops.mmap) {
          throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
        }
        return stream.stream_ops.mmap(stream, buffer, offset, length, position, prot, flags);
      },ioctl:function(stream, cmd, arg) {
        if (!stream.stream_ops.ioctl) {
          throw new FS.ErrnoError(ERRNO_CODES.ENOTTY);
        }
        return stream.stream_ops.ioctl(stream, cmd, arg);
      },readFile:function(path, opts) {
        opts = opts || {};
        opts.flags = opts.flags || 'r';
        opts.encoding = opts.encoding || 'binary';
        var ret;
        var stream = FS.open(path, opts.flags);
        var stat = FS.stat(path);
        var length = stat.size;
        var buf = new Uint8Array(length);
        FS.read(stream, buf, 0, length, 0);
        if (opts.encoding === 'utf8') {
          ret = '';
          var utf8 = new Runtime.UTF8Processor();
          for (var i = 0; i < length; i++) {
            ret += utf8.processCChar(buf[i]);
          }
        } else if (opts.encoding === 'binary') {
          ret = buf;
        } else {
          throw new Error('Invalid encoding type "' + opts.encoding + '"');
        }
        FS.close(stream);
        return ret;
      },writeFile:function(path, data, opts) {
        opts = opts || {};
        opts.flags = opts.flags || 'w';
        opts.encoding = opts.encoding || 'utf8';
        var stream = FS.open(path, opts.flags, opts.mode);
        if (opts.encoding === 'utf8') {
          var utf8 = new Runtime.UTF8Processor();
          var buf = new Uint8Array(utf8.processJSString(data));
          FS.write(stream, buf, 0, buf.length, 0);
        } else if (opts.encoding === 'binary') {
          FS.write(stream, data, 0, data.length, 0);
        } else {
          throw new Error('Invalid encoding type "' + opts.encoding + '"');
        }
        FS.close(stream);
      },cwd:function() {
        return FS.currentPath;
      },chdir:function(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        if (!FS.isDir(lookup.node.mode)) {
          throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
        }
        var err = FS.nodePermissions(lookup.node, 'x');
        if (err) {
          throw new FS.ErrnoError(err);
        }
        FS.currentPath = lookup.path;
      },createDefaultDirectories:function() {
        FS.mkdir('/tmp');
      },createDefaultDevices:function() {
        // create /dev
        FS.mkdir('/dev');
        // setup /dev/null
        FS.registerDevice(FS.makedev(1, 3), {
          read: function() { return 0; },
          write: function() { return 0; }
        });
        FS.mkdev('/dev/null', FS.makedev(1, 3));
        // setup /dev/tty and /dev/tty1
        // stderr needs to print output using Module['printErr']
        // so we register a second tty just for it.
        TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
        TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
        FS.mkdev('/dev/tty', FS.makedev(5, 0));
        FS.mkdev('/dev/tty1', FS.makedev(6, 0));
        // we're not going to emulate the actual shm device,
        // just create the tmp dirs that reside in it commonly
        FS.mkdir('/dev/shm');
        FS.mkdir('/dev/shm/tmp');
      },createStandardStreams:function() {
        // TODO deprecate the old functionality of a single
        // input / output callback and that utilizes FS.createDevice
        // and instead require a unique set of stream ops
  
        // by default, we symlink the standard streams to the
        // default tty devices. however, if the standard streams
        // have been overwritten we create a unique device for
        // them instead.
        if (Module['stdin']) {
          FS.createDevice('/dev', 'stdin', Module['stdin']);
        } else {
          FS.symlink('/dev/tty', '/dev/stdin');
        }
        if (Module['stdout']) {
          FS.createDevice('/dev', 'stdout', null, Module['stdout']);
        } else {
          FS.symlink('/dev/tty', '/dev/stdout');
        }
        if (Module['stderr']) {
          FS.createDevice('/dev', 'stderr', null, Module['stderr']);
        } else {
          FS.symlink('/dev/tty1', '/dev/stderr');
        }
  
        // open default streams for the stdin, stdout and stderr devices
        var stdin = FS.open('/dev/stdin', 'r');
        HEAP32[((_stdin)>>2)]=stdin.fd;
        assert(stdin.fd === 1, 'invalid handle for stdin (' + stdin.fd + ')');
  
        var stdout = FS.open('/dev/stdout', 'w');
        HEAP32[((_stdout)>>2)]=stdout.fd;
        assert(stdout.fd === 2, 'invalid handle for stdout (' + stdout.fd + ')');
  
        var stderr = FS.open('/dev/stderr', 'w');
        HEAP32[((_stderr)>>2)]=stderr.fd;
        assert(stderr.fd === 3, 'invalid handle for stderr (' + stderr.fd + ')');
      },ensureErrnoError:function() {
        if (FS.ErrnoError) return;
        FS.ErrnoError = function ErrnoError(errno) {
          this.errno = errno;
          for (var key in ERRNO_CODES) {
            if (ERRNO_CODES[key] === errno) {
              this.code = key;
              break;
            }
          }
          this.message = ERRNO_MESSAGES[errno];
        };
        FS.ErrnoError.prototype = new Error();
        FS.ErrnoError.prototype.constructor = FS.ErrnoError;
        // Some errors may happen quite a bit, to avoid overhead we reuse them (and suffer a lack of stack info)
        [ERRNO_CODES.ENOENT].forEach(function(code) {
          FS.genericErrors[code] = new FS.ErrnoError(code);
          FS.genericErrors[code].stack = '<generic error, no stack>';
        });
      },staticInit:function() {
        FS.ensureErrnoError();
  
        FS.nameTable = new Array(4096);
  
        FS.root = FS.createNode(null, '/', 16384 | 0777, 0);
        FS.mount(MEMFS, {}, '/');
  
        FS.createDefaultDirectories();
        FS.createDefaultDevices();
      },init:function(input, output, error) {
        assert(!FS.init.initialized, 'FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)');
        FS.init.initialized = true;
  
        FS.ensureErrnoError();
  
        // Allow Module.stdin etc. to provide defaults, if none explicitly passed to us here
        Module['stdin'] = input || Module['stdin'];
        Module['stdout'] = output || Module['stdout'];
        Module['stderr'] = error || Module['stderr'];
  
        FS.createStandardStreams();
      },quit:function() {
        FS.init.initialized = false;
        for (var i = 0; i < FS.streams.length; i++) {
          var stream = FS.streams[i];
          if (!stream) {
            continue;
          }
          FS.close(stream);
        }
      },getMode:function(canRead, canWrite) {
        var mode = 0;
        if (canRead) mode |= 292 | 73;
        if (canWrite) mode |= 146;
        return mode;
      },joinPath:function(parts, forceRelative) {
        var path = PATH.join.apply(null, parts);
        if (forceRelative && path[0] == '/') path = path.substr(1);
        return path;
      },absolutePath:function(relative, base) {
        return PATH.resolve(base, relative);
      },standardizePath:function(path) {
        return PATH.normalize(path);
      },findObject:function(path, dontResolveLastLink) {
        var ret = FS.analyzePath(path, dontResolveLastLink);
        if (ret.exists) {
          return ret.object;
        } else {
          ___setErrNo(ret.error);
          return null;
        }
      },analyzePath:function(path, dontResolveLastLink) {
        // operate from within the context of the symlink's target
        try {
          var lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
          path = lookup.path;
        } catch (e) {
        }
        var ret = {
          isRoot: false, exists: false, error: 0, name: null, path: null, object: null,
          parentExists: false, parentPath: null, parentObject: null
        };
        try {
          var lookup = FS.lookupPath(path, { parent: true });
          ret.parentExists = true;
          ret.parentPath = lookup.path;
          ret.parentObject = lookup.node;
          ret.name = PATH.basename(path);
          lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
          ret.exists = true;
          ret.path = lookup.path;
          ret.object = lookup.node;
          ret.name = lookup.node.name;
          ret.isRoot = lookup.path === '/';
        } catch (e) {
          ret.error = e.errno;
        };
        return ret;
      },createFolder:function(parent, name, canRead, canWrite) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        var mode = FS.getMode(canRead, canWrite);
        return FS.mkdir(path, mode);
      },createPath:function(parent, path, canRead, canWrite) {
        parent = typeof parent === 'string' ? parent : FS.getPath(parent);
        var parts = path.split('/').reverse();
        while (parts.length) {
          var part = parts.pop();
          if (!part) continue;
          var current = PATH.join2(parent, part);
          try {
            FS.mkdir(current);
          } catch (e) {
            // ignore EEXIST
          }
          parent = current;
        }
        return current;
      },createFile:function(parent, name, properties, canRead, canWrite) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        var mode = FS.getMode(canRead, canWrite);
        return FS.create(path, mode);
      },createDataFile:function(parent, name, data, canRead, canWrite, canOwn) {
        var path = name ? PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name) : parent;
        var mode = FS.getMode(canRead, canWrite);
        var node = FS.create(path, mode);
        if (data) {
          if (typeof data === 'string') {
            var arr = new Array(data.length);
            for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
            data = arr;
          }
          // make sure we can write to the file
          FS.chmod(node, mode | 146);
          var stream = FS.open(node, 'w');
          FS.write(stream, data, 0, data.length, 0, canOwn);
          FS.close(stream);
          FS.chmod(node, mode);
        }
        return node;
      },createDevice:function(parent, name, input, output) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        var mode = FS.getMode(!!input, !!output);
        if (!FS.createDevice.major) FS.createDevice.major = 64;
        var dev = FS.makedev(FS.createDevice.major++, 0);
        // Create a fake device that a set of stream ops to emulate
        // the old behavior.
        FS.registerDevice(dev, {
          open: function(stream) {
            stream.seekable = false;
          },
          close: function(stream) {
            // flush any pending line data
            if (output && output.buffer && output.buffer.length) {
              output(10);
            }
          },
          read: function(stream, buffer, offset, length, pos /* ignored */) {
            var bytesRead = 0;
            for (var i = 0; i < length; i++) {
              var result;
              try {
                result = input();
              } catch (e) {
                throw new FS.ErrnoError(ERRNO_CODES.EIO);
              }
              if (result === undefined && bytesRead === 0) {
                throw new FS.ErrnoError(ERRNO_CODES.EAGAIN);
              }
              if (result === null || result === undefined) break;
              bytesRead++;
              buffer[offset+i] = result;
            }
            if (bytesRead) {
              stream.node.timestamp = Date.now();
            }
            return bytesRead;
          },
          write: function(stream, buffer, offset, length, pos) {
            for (var i = 0; i < length; i++) {
              try {
                output(buffer[offset+i]);
              } catch (e) {
                throw new FS.ErrnoError(ERRNO_CODES.EIO);
              }
            }
            if (length) {
              stream.node.timestamp = Date.now();
            }
            return i;
          }
        });
        return FS.mkdev(path, mode, dev);
      },createLink:function(parent, name, target, canRead, canWrite) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        return FS.symlink(target, path);
      },forceLoadFile:function(obj) {
        if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
        var success = true;
        if (typeof XMLHttpRequest !== 'undefined') {
          throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
        } else if (Module['read']) {
          // Command-line.
          try {
            // WARNING: Can't read binary files in V8's d8 or tracemonkey's js, as
            //          read() will try to parse UTF8.
            obj.contents = intArrayFromString(Module['read'](obj.url), true);
          } catch (e) {
            success = false;
          }
        } else {
          throw new Error('Cannot load without read() or XMLHttpRequest.');
        }
        if (!success) ___setErrNo(ERRNO_CODES.EIO);
        return success;
      },createLazyFile:function(parent, name, url, canRead, canWrite) {
        if (typeof XMLHttpRequest !== 'undefined') {
          if (!ENVIRONMENT_IS_WORKER) throw 'Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc';
          // Lazy chunked Uint8Array (implements get and length from Uint8Array). Actual getting is abstracted away for eventual reuse.
          function LazyUint8Array() {
            this.lengthKnown = false;
            this.chunks = []; // Loaded chunks. Index is the chunk number
          }
          LazyUint8Array.prototype.get = function LazyUint8Array_get(idx) {
            if (idx > this.length-1 || idx < 0) {
              return undefined;
            }
            var chunkOffset = idx % this.chunkSize;
            var chunkNum = Math.floor(idx / this.chunkSize);
            return this.getter(chunkNum)[chunkOffset];
          }
          LazyUint8Array.prototype.setDataGetter = function LazyUint8Array_setDataGetter(getter) {
            this.getter = getter;
          }
          LazyUint8Array.prototype.cacheLength = function LazyUint8Array_cacheLength() {
              // Find length
              var xhr = new XMLHttpRequest();
              xhr.open('HEAD', url, false);
              xhr.send(null);
              if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
              var datalength = Number(xhr.getResponseHeader("Content-length"));
              var header;
              var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
              var chunkSize = 1024*1024; // Chunk size in bytes
  
              if (!hasByteServing) chunkSize = datalength;
  
              // Function to get a range from the remote URL.
              var doXHR = (function(from, to) {
                if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
                if (to > datalength-1) throw new Error("only " + datalength + " bytes available! programmer error!");
  
                // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
                var xhr = new XMLHttpRequest();
                xhr.open('GET', url, false);
                if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
  
                // Some hints to the browser that we want binary data.
                if (typeof Uint8Array != 'undefined') xhr.responseType = 'arraybuffer';
                if (xhr.overrideMimeType) {
                  xhr.overrideMimeType('text/plain; charset=x-user-defined');
                }
  
                xhr.send(null);
                if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
                if (xhr.response !== undefined) {
                  return new Uint8Array(xhr.response || []);
                } else {
                  return intArrayFromString(xhr.responseText || '', true);
                }
              });
              var lazyArray = this;
              lazyArray.setDataGetter(function(chunkNum) {
                var start = chunkNum * chunkSize;
                var end = (chunkNum+1) * chunkSize - 1; // including this byte
                end = Math.min(end, datalength-1); // if datalength-1 is selected, this is the last block
                if (typeof(lazyArray.chunks[chunkNum]) === "undefined") {
                  lazyArray.chunks[chunkNum] = doXHR(start, end);
                }
                if (typeof(lazyArray.chunks[chunkNum]) === "undefined") throw new Error("doXHR failed!");
                return lazyArray.chunks[chunkNum];
              });
  
              this._length = datalength;
              this._chunkSize = chunkSize;
              this.lengthKnown = true;
          }
  
          var lazyArray = new LazyUint8Array();
          Object.defineProperty(lazyArray, "length", {
              get: function() {
                  if(!this.lengthKnown) {
                      this.cacheLength();
                  }
                  return this._length;
              }
          });
          Object.defineProperty(lazyArray, "chunkSize", {
              get: function() {
                  if(!this.lengthKnown) {
                      this.cacheLength();
                  }
                  return this._chunkSize;
              }
          });
  
          var properties = { isDevice: false, contents: lazyArray };
        } else {
          var properties = { isDevice: false, url: url };
        }
  
        var node = FS.createFile(parent, name, properties, canRead, canWrite);
        // This is a total hack, but I want to get this lazy file code out of the
        // core of MEMFS. If we want to keep this lazy file concept I feel it should
        // be its own thin LAZYFS proxying calls to MEMFS.
        if (properties.contents) {
          node.contents = properties.contents;
        } else if (properties.url) {
          node.contents = null;
          node.url = properties.url;
        }
        // override each stream op with one that tries to force load the lazy file first
        var stream_ops = {};
        var keys = Object.keys(node.stream_ops);
        keys.forEach(function(key) {
          var fn = node.stream_ops[key];
          stream_ops[key] = function forceLoadLazyFile() {
            if (!FS.forceLoadFile(node)) {
              throw new FS.ErrnoError(ERRNO_CODES.EIO);
            }
            return fn.apply(null, arguments);
          };
        });
        // use a custom read function
        stream_ops.read = function stream_ops_read(stream, buffer, offset, length, position) {
          if (!FS.forceLoadFile(node)) {
            throw new FS.ErrnoError(ERRNO_CODES.EIO);
          }
          var contents = stream.node.contents;
          if (position >= contents.length)
            return 0;
          var size = Math.min(contents.length - position, length);
          assert(size >= 0);
          if (contents.slice) { // normal array
            for (var i = 0; i < size; i++) {
              buffer[offset + i] = contents[position + i];
            }
          } else {
            for (var i = 0; i < size; i++) { // LazyUint8Array from sync binary XHR
              buffer[offset + i] = contents.get(position + i);
            }
          }
          return size;
        };
        node.stream_ops = stream_ops;
        return node;
      },createPreloadedFile:function(parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn) {
        Browser.init();
        // TODO we should allow people to just pass in a complete filename instead
        // of parent and name being that we just join them anyways
        var fullname = name ? PATH.resolve(PATH.join2(parent, name)) : parent;
        function processData(byteArray) {
          function finish(byteArray) {
            if (!dontCreateFile) {
              FS.createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
            }
            if (onload) onload();
            removeRunDependency('cp ' + fullname);
          }
          var handled = false;
          Module['preloadPlugins'].forEach(function(plugin) {
            if (handled) return;
            if (plugin['canHandle'](fullname)) {
              plugin['handle'](byteArray, fullname, finish, function() {
                if (onerror) onerror();
                removeRunDependency('cp ' + fullname);
              });
              handled = true;
            }
          });
          if (!handled) finish(byteArray);
        }
        addRunDependency('cp ' + fullname);
        if (typeof url == 'string') {
          Browser.asyncLoad(url, function(byteArray) {
            processData(byteArray);
          }, onerror);
        } else {
          processData(url);
        }
      },indexedDB:function() {
        return window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
      },DB_NAME:function() {
        return 'EM_FS_' + window.location.pathname;
      },DB_VERSION:20,DB_STORE_NAME:"FILE_DATA",saveFilesToDB:function(paths, onload, onerror) {
        onload = onload || function(){};
        onerror = onerror || function(){};
        var indexedDB = FS.indexedDB();
        try {
          var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION);
        } catch (e) {
          return onerror(e);
        }
        openRequest.onupgradeneeded = function openRequest_onupgradeneeded() {
          console.log('creating db');
          var db = openRequest.result;
          db.createObjectStore(FS.DB_STORE_NAME);
        };
        openRequest.onsuccess = function openRequest_onsuccess() {
          var db = openRequest.result;
          var transaction = db.transaction([FS.DB_STORE_NAME], 'readwrite');
          var files = transaction.objectStore(FS.DB_STORE_NAME);
          var ok = 0, fail = 0, total = paths.length;
          function finish() {
            if (fail == 0) onload(); else onerror();
          }
          paths.forEach(function(path) {
            var putRequest = files.put(FS.analyzePath(path).object.contents, path);
            putRequest.onsuccess = function putRequest_onsuccess() { ok++; if (ok + fail == total) finish() };
            putRequest.onerror = function putRequest_onerror() { fail++; if (ok + fail == total) finish() };
          });
          transaction.onerror = onerror;
        };
        openRequest.onerror = onerror;
      },loadFilesFromDB:function(paths, onload, onerror) {
        onload = onload || function(){};
        onerror = onerror || function(){};
        var indexedDB = FS.indexedDB();
        try {
          var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION);
        } catch (e) {
          return onerror(e);
        }
        openRequest.onupgradeneeded = onerror; // no database to load from
        openRequest.onsuccess = function openRequest_onsuccess() {
          var db = openRequest.result;
          try {
            var transaction = db.transaction([FS.DB_STORE_NAME], 'readonly');
          } catch(e) {
            onerror(e);
            return;
          }
          var files = transaction.objectStore(FS.DB_STORE_NAME);
          var ok = 0, fail = 0, total = paths.length;
          function finish() {
            if (fail == 0) onload(); else onerror();
          }
          paths.forEach(function(path) {
            var getRequest = files.get(path);
            getRequest.onsuccess = function getRequest_onsuccess() {
              if (FS.analyzePath(path).exists) {
                FS.unlink(path);
              }
              FS.createDataFile(PATH.dirname(path), PATH.basename(path), getRequest.result, true, true, true);
              ok++;
              if (ok + fail == total) finish();
            };
            getRequest.onerror = function getRequest_onerror() { fail++; if (ok + fail == total) finish() };
          });
          transaction.onerror = onerror;
        };
        openRequest.onerror = onerror;
      }};var PATH={splitPath:function(filename) {
        var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
        return splitPathRe.exec(filename).slice(1);
      },normalizeArray:function(parts, allowAboveRoot) {
        // if the path tries to go above the root, `up` ends up > 0
        var up = 0;
        for (var i = parts.length - 1; i >= 0; i--) {
          var last = parts[i];
          if (last === '.') {
            parts.splice(i, 1);
          } else if (last === '..') {
            parts.splice(i, 1);
            up++;
          } else if (up) {
            parts.splice(i, 1);
            up--;
          }
        }
        // if the path is allowed to go above the root, restore leading ..s
        if (allowAboveRoot) {
          for (; up--; up) {
            parts.unshift('..');
          }
        }
        return parts;
      },normalize:function(path) {
        var isAbsolute = path.charAt(0) === '/',
            trailingSlash = path.substr(-1) === '/';
        // Normalize the path
        path = PATH.normalizeArray(path.split('/').filter(function(p) {
          return !!p;
        }), !isAbsolute).join('/');
        if (!path && !isAbsolute) {
          path = '.';
        }
        if (path && trailingSlash) {
          path += '/';
        }
        return (isAbsolute ? '/' : '') + path;
      },dirname:function(path) {
        var result = PATH.splitPath(path),
            root = result[0],
            dir = result[1];
        if (!root && !dir) {
          // No dirname whatsoever
          return '.';
        }
        if (dir) {
          // It has a dirname, strip trailing slash
          dir = dir.substr(0, dir.length - 1);
        }
        return root + dir;
      },basename:function(path) {
        // EMSCRIPTEN return '/'' for '/', not an empty string
        if (path === '/') return '/';
        var lastSlash = path.lastIndexOf('/');
        if (lastSlash === -1) return path;
        return path.substr(lastSlash+1);
      },extname:function(path) {
        return PATH.splitPath(path)[3];
      },join:function() {
        var paths = Array.prototype.slice.call(arguments, 0);
        return PATH.normalize(paths.join('/'));
      },join2:function(l, r) {
        return PATH.normalize(l + '/' + r);
      },resolve:function() {
        var resolvedPath = '',
          resolvedAbsolute = false;
        for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
          var path = (i >= 0) ? arguments[i] : FS.cwd();
          // Skip empty and invalid entries
          if (typeof path !== 'string') {
            throw new TypeError('Arguments to path.resolve must be strings');
          } else if (!path) {
            continue;
          }
          resolvedPath = path + '/' + resolvedPath;
          resolvedAbsolute = path.charAt(0) === '/';
        }
        // At this point the path should be resolved to a full absolute path, but
        // handle relative paths to be safe (might happen when process.cwd() fails)
        resolvedPath = PATH.normalizeArray(resolvedPath.split('/').filter(function(p) {
          return !!p;
        }), !resolvedAbsolute).join('/');
        return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
      },relative:function(from, to) {
        from = PATH.resolve(from).substr(1);
        to = PATH.resolve(to).substr(1);
        function trim(arr) {
          var start = 0;
          for (; start < arr.length; start++) {
            if (arr[start] !== '') break;
          }
          var end = arr.length - 1;
          for (; end >= 0; end--) {
            if (arr[end] !== '') break;
          }
          if (start > end) return [];
          return arr.slice(start, end - start + 1);
        }
        var fromParts = trim(from.split('/'));
        var toParts = trim(to.split('/'));
        var length = Math.min(fromParts.length, toParts.length);
        var samePartsLength = length;
        for (var i = 0; i < length; i++) {
          if (fromParts[i] !== toParts[i]) {
            samePartsLength = i;
            break;
          }
        }
        var outputParts = [];
        for (var i = samePartsLength; i < fromParts.length; i++) {
          outputParts.push('..');
        }
        outputParts = outputParts.concat(toParts.slice(samePartsLength));
        return outputParts.join('/');
      }};var Browser={mainLoop:{scheduler:null,shouldPause:false,paused:false,queue:[],pause:function() {
          Browser.mainLoop.shouldPause = true;
        },resume:function() {
          if (Browser.mainLoop.paused) {
            Browser.mainLoop.paused = false;
            Browser.mainLoop.scheduler();
          }
          Browser.mainLoop.shouldPause = false;
        },updateStatus:function() {
          if (Module['setStatus']) {
            var message = Module['statusMessage'] || 'Please wait...';
            var remaining = Browser.mainLoop.remainingBlockers;
            var expected = Browser.mainLoop.expectedBlockers;
            if (remaining) {
              if (remaining < expected) {
                Module['setStatus'](message + ' (' + (expected - remaining) + '/' + expected + ')');
              } else {
                Module['setStatus'](message);
              }
            } else {
              Module['setStatus']('');
            }
          }
        }},isFullScreen:false,pointerLock:false,moduleContextCreatedCallbacks:[],workers:[],init:function() {
        if (!Module["preloadPlugins"]) Module["preloadPlugins"] = []; // needs to exist even in workers
  
        if (Browser.initted || ENVIRONMENT_IS_WORKER) return;
        Browser.initted = true;
  
        try {
          new Blob();
          Browser.hasBlobConstructor = true;
        } catch(e) {
          Browser.hasBlobConstructor = false;
          console.log("warning: no blob constructor, cannot create blobs with mimetypes");
        }
        Browser.BlobBuilder = typeof MozBlobBuilder != "undefined" ? MozBlobBuilder : (typeof WebKitBlobBuilder != "undefined" ? WebKitBlobBuilder : (!Browser.hasBlobConstructor ? console.log("warning: no BlobBuilder") : null));
        Browser.URLObject = typeof window != "undefined" ? (window.URL ? window.URL : window.webkitURL) : undefined;
        if (!Module.noImageDecoding && typeof Browser.URLObject === 'undefined') {
          console.log("warning: Browser does not support creating object URLs. Built-in browser image decoding will not be available.");
          Module.noImageDecoding = true;
        }
  
        // Support for plugins that can process preloaded files. You can add more of these to
        // your app by creating and appending to Module.preloadPlugins.
        //
        // Each plugin is asked if it can handle a file based on the file's name. If it can,
        // it is given the file's raw data. When it is done, it calls a callback with the file's
        // (possibly modified) data. For example, a plugin might decompress a file, or it
        // might create some side data structure for use later (like an Image element, etc.).
  
        var imagePlugin = {};
        imagePlugin['canHandle'] = function imagePlugin_canHandle(name) {
          return !Module.noImageDecoding && /\.(jpg|jpeg|png|bmp)$/i.test(name);
        };
        imagePlugin['handle'] = function imagePlugin_handle(byteArray, name, onload, onerror) {
          var b = null;
          if (Browser.hasBlobConstructor) {
            try {
              b = new Blob([byteArray], { type: Browser.getMimetype(name) });
              if (b.size !== byteArray.length) { // Safari bug #118630
                // Safari's Blob can only take an ArrayBuffer
                b = new Blob([(new Uint8Array(byteArray)).buffer], { type: Browser.getMimetype(name) });
              }
            } catch(e) {
              Runtime.warnOnce('Blob constructor present but fails: ' + e + '; falling back to blob builder');
            }
          }
          if (!b) {
            var bb = new Browser.BlobBuilder();
            bb.append((new Uint8Array(byteArray)).buffer); // we need to pass a buffer, and must copy the array to get the right data range
            b = bb.getBlob();
          }
          var url = Browser.URLObject.createObjectURL(b);
          var img = new Image();
          img.onload = function img_onload() {
            assert(img.complete, 'Image ' + name + ' could not be decoded');
            var canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            Module["preloadedImages"][name] = canvas;
            Browser.URLObject.revokeObjectURL(url);
            if (onload) onload(byteArray);
          };
          img.onerror = function img_onerror(event) {
            console.log('Image ' + url + ' could not be decoded');
            if (onerror) onerror();
          };
          img.src = url;
        };
        Module['preloadPlugins'].push(imagePlugin);
  
        var audioPlugin = {};
        audioPlugin['canHandle'] = function audioPlugin_canHandle(name) {
          return !Module.noAudioDecoding && name.substr(-4) in { '.ogg': 1, '.wav': 1, '.mp3': 1 };
        };
        audioPlugin['handle'] = function audioPlugin_handle(byteArray, name, onload, onerror) {
          var done = false;
          function finish(audio) {
            if (done) return;
            done = true;
            Module["preloadedAudios"][name] = audio;
            if (onload) onload(byteArray);
          }
          function fail() {
            if (done) return;
            done = true;
            Module["preloadedAudios"][name] = new Audio(); // empty shim
            if (onerror) onerror();
          }
          if (Browser.hasBlobConstructor) {
            try {
              var b = new Blob([byteArray], { type: Browser.getMimetype(name) });
            } catch(e) {
              return fail();
            }
            var url = Browser.URLObject.createObjectURL(b); // XXX we never revoke this!
            var audio = new Audio();
            audio.addEventListener('canplaythrough', function() { finish(audio) }, false); // use addEventListener due to chromium bug 124926
            audio.onerror = function audio_onerror(event) {
              if (done) return;
              console.log('warning: browser could not fully decode audio ' + name + ', trying slower base64 approach');
              function encode64(data) {
                var BASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
                var PAD = '=';
                var ret = '';
                var leftchar = 0;
                var leftbits = 0;
                for (var i = 0; i < data.length; i++) {
                  leftchar = (leftchar << 8) | data[i];
                  leftbits += 8;
                  while (leftbits >= 6) {
                    var curr = (leftchar >> (leftbits-6)) & 0x3f;
                    leftbits -= 6;
                    ret += BASE[curr];
                  }
                }
                if (leftbits == 2) {
                  ret += BASE[(leftchar&3) << 4];
                  ret += PAD + PAD;
                } else if (leftbits == 4) {
                  ret += BASE[(leftchar&0xf) << 2];
                  ret += PAD;
                }
                return ret;
              }
              audio.src = 'data:audio/x-' + name.substr(-3) + ';base64,' + encode64(byteArray);
              finish(audio); // we don't wait for confirmation this worked - but it's worth trying
            };
            audio.src = url;
            // workaround for chrome bug 124926 - we do not always get oncanplaythrough or onerror
            Browser.safeSetTimeout(function() {
              finish(audio); // try to use it even though it is not necessarily ready to play
            }, 10000);
          } else {
            return fail();
          }
        };
        Module['preloadPlugins'].push(audioPlugin);
  
        // Canvas event setup
  
        var canvas = Module['canvas'];
        canvas.requestPointerLock = canvas['requestPointerLock'] ||
                                    canvas['mozRequestPointerLock'] ||
                                    canvas['webkitRequestPointerLock'];
        canvas.exitPointerLock = document['exitPointerLock'] ||
                                 document['mozExitPointerLock'] ||
                                 document['webkitExitPointerLock'] ||
                                 function(){}; // no-op if function does not exist
        canvas.exitPointerLock = canvas.exitPointerLock.bind(document);
  
        function pointerLockChange() {
          Browser.pointerLock = document['pointerLockElement'] === canvas ||
                                document['mozPointerLockElement'] === canvas ||
                                document['webkitPointerLockElement'] === canvas;
        }
  
        document.addEventListener('pointerlockchange', pointerLockChange, false);
        document.addEventListener('mozpointerlockchange', pointerLockChange, false);
        document.addEventListener('webkitpointerlockchange', pointerLockChange, false);
  
        if (Module['elementPointerLock']) {
          canvas.addEventListener("click", function(ev) {
            if (!Browser.pointerLock && canvas.requestPointerLock) {
              canvas.requestPointerLock();
              ev.preventDefault();
            }
          }, false);
        }
      },createContext:function(canvas, useWebGL, setInModule, webGLContextAttributes) {
        var ctx;
        try {
          if (useWebGL) {
            var contextAttributes = {
              antialias: false,
              alpha: false
            };
  
            if (webGLContextAttributes) {
              for (var attribute in webGLContextAttributes) {
                contextAttributes[attribute] = webGLContextAttributes[attribute];
              }
            }
  
  
            var errorInfo = '?';
            function onContextCreationError(event) {
              errorInfo = event.statusMessage || errorInfo;
            }
            canvas.addEventListener('webglcontextcreationerror', onContextCreationError, false);
            try {
              ['experimental-webgl', 'webgl'].some(function(webglId) {
                return ctx = canvas.getContext(webglId, contextAttributes);
              });
            } finally {
              canvas.removeEventListener('webglcontextcreationerror', onContextCreationError, false);
            }
          } else {
            ctx = canvas.getContext('2d');
          }
          if (!ctx) throw ':(';
        } catch (e) {
          Module.print('Could not create canvas: ' + [errorInfo, e]);
          return null;
        }
        if (useWebGL) {
          // Set the background of the WebGL canvas to black
          canvas.style.backgroundColor = "black";
  
          // Warn on context loss
          canvas.addEventListener('webglcontextlost', function(event) {
            alert('WebGL context lost. You will need to reload the page.');
          }, false);
        }
        if (setInModule) {
          GLctx = Module.ctx = ctx;
          Module.useWebGL = useWebGL;
          Browser.moduleContextCreatedCallbacks.forEach(function(callback) { callback() });
          Browser.init();
        }
        return ctx;
      },destroyContext:function(canvas, useWebGL, setInModule) {},fullScreenHandlersInstalled:false,lockPointer:undefined,resizeCanvas:undefined,requestFullScreen:function(lockPointer, resizeCanvas) {
        Browser.lockPointer = lockPointer;
        Browser.resizeCanvas = resizeCanvas;
        if (typeof Browser.lockPointer === 'undefined') Browser.lockPointer = true;
        if (typeof Browser.resizeCanvas === 'undefined') Browser.resizeCanvas = false;
  
        var canvas = Module['canvas'];
        function fullScreenChange() {
          Browser.isFullScreen = false;
          if ((document['webkitFullScreenElement'] || document['webkitFullscreenElement'] ||
               document['mozFullScreenElement'] || document['mozFullscreenElement'] ||
               document['fullScreenElement'] || document['fullscreenElement']) === canvas) {
            canvas.cancelFullScreen = document['cancelFullScreen'] ||
                                      document['mozCancelFullScreen'] ||
                                      document['webkitCancelFullScreen'];
            canvas.cancelFullScreen = canvas.cancelFullScreen.bind(document);
            if (Browser.lockPointer) canvas.requestPointerLock();
            Browser.isFullScreen = true;
            if (Browser.resizeCanvas) Browser.setFullScreenCanvasSize();
          } else if (Browser.resizeCanvas){
            Browser.setWindowedCanvasSize();
          }
          if (Module['onFullScreen']) Module['onFullScreen'](Browser.isFullScreen);
        }
  
        if (!Browser.fullScreenHandlersInstalled) {
          Browser.fullScreenHandlersInstalled = true;
          document.addEventListener('fullscreenchange', fullScreenChange, false);
          document.addEventListener('mozfullscreenchange', fullScreenChange, false);
          document.addEventListener('webkitfullscreenchange', fullScreenChange, false);
        }
  
        canvas.requestFullScreen = canvas['requestFullScreen'] ||
                                   canvas['mozRequestFullScreen'] ||
                                   (canvas['webkitRequestFullScreen'] ? function() { canvas['webkitRequestFullScreen'](Element['ALLOW_KEYBOARD_INPUT']) } : null);
        canvas.requestFullScreen();
      },requestAnimationFrame:function requestAnimationFrame(func) {
        if (typeof window === 'undefined') { // Provide fallback to setTimeout if window is undefined (e.g. in Node.js)
          setTimeout(func, 1000/60);
        } else {
          if (!window.requestAnimationFrame) {
            window.requestAnimationFrame = window['requestAnimationFrame'] ||
                                           window['mozRequestAnimationFrame'] ||
                                           window['webkitRequestAnimationFrame'] ||
                                           window['msRequestAnimationFrame'] ||
                                           window['oRequestAnimationFrame'] ||
                                           window['setTimeout'];
          }
          window.requestAnimationFrame(func);
        }
      },safeCallback:function(func) {
        return function() {
          if (!ABORT) return func.apply(null, arguments);
        };
      },safeRequestAnimationFrame:function(func) {
        return Browser.requestAnimationFrame(function() {
          if (!ABORT) func();
        });
      },safeSetTimeout:function(func, timeout) {
        return setTimeout(function() {
          if (!ABORT) func();
        }, timeout);
      },safeSetInterval:function(func, timeout) {
        return setInterval(function() {
          if (!ABORT) func();
        }, timeout);
      },getMimetype:function(name) {
        return {
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'png': 'image/png',
          'bmp': 'image/bmp',
          'ogg': 'audio/ogg',
          'wav': 'audio/wav',
          'mp3': 'audio/mpeg'
        }[name.substr(name.lastIndexOf('.')+1)];
      },getUserMedia:function(func) {
        if(!window.getUserMedia) {
          window.getUserMedia = navigator['getUserMedia'] ||
                                navigator['mozGetUserMedia'];
        }
        window.getUserMedia(func);
      },getMovementX:function(event) {
        return event['movementX'] ||
               event['mozMovementX'] ||
               event['webkitMovementX'] ||
               0;
      },getMovementY:function(event) {
        return event['movementY'] ||
               event['mozMovementY'] ||
               event['webkitMovementY'] ||
               0;
      },mouseX:0,mouseY:0,mouseMovementX:0,mouseMovementY:0,calculateMouseEvent:function(event) { // event should be mousemove, mousedown or mouseup
        if (Browser.pointerLock) {
          // When the pointer is locked, calculate the coordinates
          // based on the movement of the mouse.
          // Workaround for Firefox bug 764498
          if (event.type != 'mousemove' &&
              ('mozMovementX' in event)) {
            Browser.mouseMovementX = Browser.mouseMovementY = 0;
          } else {
            Browser.mouseMovementX = Browser.getMovementX(event);
            Browser.mouseMovementY = Browser.getMovementY(event);
          }
          
          // check if SDL is available
          if (typeof SDL != "undefined") {
          	Browser.mouseX = SDL.mouseX + Browser.mouseMovementX;
          	Browser.mouseY = SDL.mouseY + Browser.mouseMovementY;
          } else {
          	// just add the mouse delta to the current absolut mouse position
          	// FIXME: ideally this should be clamped against the canvas size and zero
          	Browser.mouseX += Browser.mouseMovementX;
          	Browser.mouseY += Browser.mouseMovementY;
          }        
        } else {
          // Otherwise, calculate the movement based on the changes
          // in the coordinates.
          var rect = Module["canvas"].getBoundingClientRect();
          var x, y;
          
          // Neither .scrollX or .pageXOffset are defined in a spec, but
          // we prefer .scrollX because it is currently in a spec draft.
          // (see: http://www.w3.org/TR/2013/WD-cssom-view-20131217/)
          var scrollX = ((typeof window.scrollX !== 'undefined') ? window.scrollX : window.pageXOffset);
          var scrollY = ((typeof window.scrollY !== 'undefined') ? window.scrollY : window.pageYOffset);
          if (event.type == 'touchstart' ||
              event.type == 'touchend' ||
              event.type == 'touchmove') {
            var t = event.touches.item(0);
            if (t) {
              x = t.pageX - (scrollX + rect.left);
              y = t.pageY - (scrollY + rect.top);
            } else {
              return;
            }
          } else {
            x = event.pageX - (scrollX + rect.left);
            y = event.pageY - (scrollY + rect.top);
          }
  
          // the canvas might be CSS-scaled compared to its backbuffer;
          // SDL-using content will want mouse coordinates in terms
          // of backbuffer units.
          var cw = Module["canvas"].width;
          var ch = Module["canvas"].height;
          x = x * (cw / rect.width);
          y = y * (ch / rect.height);
  
          Browser.mouseMovementX = x - Browser.mouseX;
          Browser.mouseMovementY = y - Browser.mouseY;
          Browser.mouseX = x;
          Browser.mouseY = y;
        }
      },xhrLoad:function(url, onload, onerror) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function xhr_onload() {
          if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) { // file URLs can return 0
            onload(xhr.response);
          } else {
            onerror();
          }
        };
        xhr.onerror = onerror;
        xhr.send(null);
      },asyncLoad:function(url, onload, onerror, noRunDep) {
        Browser.xhrLoad(url, function(arrayBuffer) {
          assert(arrayBuffer, 'Loading data file "' + url + '" failed (no arrayBuffer).');
          onload(new Uint8Array(arrayBuffer));
          if (!noRunDep) removeRunDependency('al ' + url);
        }, function(event) {
          if (onerror) {
            onerror();
          } else {
            throw 'Loading data file "' + url + '" failed.';
          }
        });
        if (!noRunDep) addRunDependency('al ' + url);
      },resizeListeners:[],updateResizeListeners:function() {
        var canvas = Module['canvas'];
        Browser.resizeListeners.forEach(function(listener) {
          listener(canvas.width, canvas.height);
        });
      },setCanvasSize:function(width, height, noUpdates) {
        var canvas = Module['canvas'];
        canvas.width = width;
        canvas.height = height;
        if (!noUpdates) Browser.updateResizeListeners();
      },windowedWidth:0,windowedHeight:0,setFullScreenCanvasSize:function() {
        var canvas = Module['canvas'];
        this.windowedWidth = canvas.width;
        this.windowedHeight = canvas.height;
        canvas.width = screen.width;
        canvas.height = screen.height;
        // check if SDL is available   
        if (typeof SDL != "undefined") {
        	var flags = HEAPU32[((SDL.screen+Runtime.QUANTUM_SIZE*0)>>2)];
        	flags = flags | 0x00800000; // set SDL_FULLSCREEN flag
        	HEAP32[((SDL.screen+Runtime.QUANTUM_SIZE*0)>>2)]=flags
        }
        Browser.updateResizeListeners();
      },setWindowedCanvasSize:function() {
        var canvas = Module['canvas'];
        canvas.width = this.windowedWidth;
        canvas.height = this.windowedHeight;
        // check if SDL is available       
        if (typeof SDL != "undefined") {
        	var flags = HEAPU32[((SDL.screen+Runtime.QUANTUM_SIZE*0)>>2)];
        	flags = flags & ~0x00800000; // clear SDL_FULLSCREEN flag
        	HEAP32[((SDL.screen+Runtime.QUANTUM_SIZE*0)>>2)]=flags
        }
        Browser.updateResizeListeners();
      }};
___errno_state = Runtime.staticAlloc(4); HEAP32[((___errno_state)>>2)]=0;
Module["requestFullScreen"] = function Module_requestFullScreen(lockPointer, resizeCanvas) { Browser.requestFullScreen(lockPointer, resizeCanvas) };
  Module["requestAnimationFrame"] = function Module_requestAnimationFrame(func) { Browser.requestAnimationFrame(func) };
  Module["setCanvasSize"] = function Module_setCanvasSize(width, height, noUpdates) { Browser.setCanvasSize(width, height, noUpdates) };
  Module["pauseMainLoop"] = function Module_pauseMainLoop() { Browser.mainLoop.pause() };
  Module["resumeMainLoop"] = function Module_resumeMainLoop() { Browser.mainLoop.resume() };
  Module["getUserMedia"] = function Module_getUserMedia() { Browser.getUserMedia() }
FS.staticInit();__ATINIT__.unshift({ func: function() { if (!Module["noFSInit"] && !FS.init.initialized) FS.init() } });__ATMAIN__.push({ func: function() { FS.ignorePermissions = false } });__ATEXIT__.push({ func: function() { FS.quit() } });Module["FS_createFolder"] = FS.createFolder;Module["FS_createPath"] = FS.createPath;Module["FS_createDataFile"] = FS.createDataFile;Module["FS_createPreloadedFile"] = FS.createPreloadedFile;Module["FS_createLazyFile"] = FS.createLazyFile;Module["FS_createLink"] = FS.createLink;Module["FS_createDevice"] = FS.createDevice;
__ATINIT__.unshift({ func: function() { TTY.init() } });__ATEXIT__.push({ func: function() { TTY.shutdown() } });TTY.utf8 = new Runtime.UTF8Processor();
if (ENVIRONMENT_IS_NODE) { var fs = require("fs"); NODEFS.staticInit(); }
STACK_BASE = STACKTOP = Runtime.alignMemory(STATICTOP);

staticSealed = true; // seal the static portion of memory

STACK_MAX = STACK_BASE + 5242880;

DYNAMIC_BASE = DYNAMICTOP = Runtime.alignMemory(STACK_MAX);

assert(DYNAMIC_BASE < TOTAL_MEMORY, "TOTAL_MEMORY not big enough for stack");



var FUNCTION_TABLE = [0,0,__ZN12RCmemdecoderD0Ev,0,__ZN10__cxxabiv120__si_class_type_infoD2Ev,0,__ZNK10__cxxabiv121__vmi_class_type_info27has_unambiguous_public_baseEPNS_19__dynamic_cast_infoEPvi,0,__ZNK10__cxxabiv120__si_class_type_info16search_above_dstEPNS_19__dynamic_cast_infoEPKvS4_ib,0,__ZN10__cxxabiv117__class_type_infoD2Ev,0,__ZNK10__cxxabiv119__pointer_type_info9can_catchEPKNS_16__shim_type_infoERPv,0,__ZNSt9bad_allocD0Ev,0,__Z10dekempressPv,0,__ZN10__cxxabiv117__class_type_infoD0Ev,0,__ZN10emscripten8internal7InvokerIP12DecodedImageJPvEE6invokeEPFS3_S4_ES4_,0,__ZNKSt9bad_alloc4whatEv,0,__ZNK10__cxxabiv120__si_class_type_info16search_below_dstEPNS_19__dynamic_cast_infoEPKvib,0,__ZNK10__cxxabiv123__fundamental_type_info9can_catchEPKNS_16__shim_type_infoERPv,0,__ZN12RCmemdecoderD2Ev,0,__ZNK10__cxxabiv121__vmi_class_type_info16search_above_dstEPNS_19__dynamic_cast_infoEPKvS4_ib,0,__ZNK10__cxxabiv117__class_type_info9can_catchEPKNS_16__shim_type_infoERPv,0,__ZNK10__cxxabiv117__class_type_info16search_above_dstEPNS_19__dynamic_cast_infoEPKvS4_ib,0,__ZN9RCqsmodel9normalizeERj,0,__ZNK12RCmemdecoder5bytesEv,0,__ZNK10__cxxabiv121__vmi_class_type_info16search_below_dstEPNS_19__dynamic_cast_infoEPKvib,0,__ZNK10__cxxabiv116__shim_type_info5noop1Ev,0,__ZN10__cxxabiv121__vmi_class_type_infoD2Ev,0,__ZN10__cxxabiv119__pointer_type_infoD0Ev,0,__ZN10__cxxabiv123__fundamental_type_infoD2Ev,0,__Z10decompressPv,0,__ZN9RCqsmodel6decodeERjS0_,0,__ZN9RCqsmodel6encodeEjRjS0_,0,__ZNK10__cxxabiv116__shim_type_info5noop2Ev,0,__ZN10__cxxabiv121__vmi_class_type_infoD0Ev,0,__ZNSt9bad_allocD2Ev,0,__ZN10__cxxabiv119__pointer_type_infoD2Ev,0,__ZNK10__cxxabiv117__class_type_info27has_unambiguous_public_baseEPNS_19__dynamic_cast_infoEPvi,0,__ZN9RCqsmodelD2Ev,0,__ZN9RCqsmodelD0Ev,0,__ZN10__cxxabiv120__si_class_type_infoD0Ev,0,__ZN12RCmemdecoder7getbyteEv,0,__ZNK10__cxxabiv117__class_type_info16search_below_dstEPNS_19__dynamic_cast_infoEPKvib,0,__ZN10__cxxabiv123__fundamental_type_infoD0Ev,0,__ZNK10__cxxabiv120__si_class_type_info27has_unambiguous_public_baseEPNS_19__dynamic_cast_infoEPvi,0];

// EMSCRIPTEN_START_FUNCS
function __ZL12decompress4dIdEbP8FPZinputPT_(r1,r2){var r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18,r19,r20,r21,r22,r23,r24,r25,r26,r27,r28,r29,r30,r31,r32,r33,r34,r35,r36,r37,r38,r39,r40,r41,r42,r43,r44,r45,r46,r47,r48,r49,r50,r51,r52,r53,r54,r55,r56,r57,r58,r59,r60,r61,r62,r63,r64,r65,r66,r67,r68,r69,r70,r71,r72,r73,r74,r75,r76,r77,r78,r79,r80,r81,r82,r83,r84,r85,r86,r87,r88,r89,r90,r91,r92,r93,r94,r95,r96,r97,r98,r99,r100,r101,r102,r103,r104,r105,r106,r107,r108,r109,r110,r111,r112,r113,r114,r115,r116,r117,r118,r119,r120,r121,r122,r123,r124,r125,r126,r127,r128,r129,r130,r131,r132,r133,r134,r135,r136,r137,r138,r139,r140,r141,r142,r143,r144,r145,r146,r147,r148,r149,r150,r151,r152,r153,r154,r155,r156,r157,r158,r159,r160,r161,r162,r163,r164,r165,r166,r167,r168,r169,r170,r171,r172,r173,r174,r175,r176,r177,r178,r179,r180,r181,r182,r183,r184,r185,r186,r187,r188,r189,r190,r191,r192,r193,r194,r195,r196,r197,r198,r199,r200,r201,r202,r203,r204,r205,r206,r207,r208,r209,r210,r211,r212,r213,r214,r215,r216,r217,r218,r219,r220,r221,r222,r223,r224,r225,r226,r227,r228,r229,r230,r231,r232,r233,r234,r235,r236,r237,r238,r239,r240,r241,r242,r243,r244,r245,r246,r247,r248,r249,r250,r251,r252,r253,r254,r255,r256,r257,r258,r259,r260,r261,r262,r263,r264,r265,r266,r267,r268,r269,r270,r271,r272,r273,r274,r275,r276,r277,r278,r279,r280,r281,r282,r283,r284,r285,r286,r287,r288,r289,r290,r291,r292,r293,r294,r295,r296,r297,r298,r299,r300,r301,r302,r303,r304,r305,r306,r307,r308,r309,r310,r311,r312,r313,r314,r315,r316,r317,r318,r319,r320,r321,r322,r323,r324,r325,r326,r327,r328,r329,r330,r331,r332,r333,r334,r335,r336,r337,r338,r339,r340,r341,r342,r343,r344,r345,r346,r347,r348,r349,r350,r351,r352,r353,r354,r355,r356,r357,r358,r359,r360,r361,r362,r363,r364,r365,r366,r367,r368,r369,r370,r371,r372,r373,r374,r375,r376,r377,r378,r379,r380,r381,r382,r383,r384,r385,r386,r387,r388,r389,r390,r391,r392,r393,r394,r395,r396,r397,r398,r399,r400,r401,r402,r403,r404,r405,r406,r407,r408,r409,r410,r411,r412,r413,r414,r415,r416,r417,r418,r419,r420,r421,r422,r423,r424,r425,r426,r427,r428,r429,r430,r431,r432,r433,r434,r435,r436,r437,r438,r439,r440,r441,r442,r443,r444,r445,r446,r447,r448,r449,r450,r451,r452,r453,r454,r455,r456,r457,r458,r459,r460,r461,r462,r463,r464,r465,r466,r467,r468,r469,r470,r471,r472,r473,r474,r475,r476,r477,r478,r479,r480,r481,r482,r483,r484,r485,r486,r487,r488,r489,r490,r491,r492,r493,r494,r495,r496,r497,r498,r499,r500,r501,r502,r503,r504,r505,r506,r507,r508,r509,r510,r511,r512,r513,r514,r515,r516,r517,r518,r519,r520,r521,r522,r523,r524,r525,r526,r527,r528,r529,r530,r531,r532,r533,r534,r535,r536,r537,r538,r539,r540,r541,r542,r543,r544,r545,r546,r547,r548,r549,r550,r551,r552,r553,r554,r555,r556,r557,r558,r559,r560,r561,r562,r563,r564,r565,r566,r567,r568,r569,r570,r571,r572,r573,r574,r575,r576,r577,r578,r579,r580,r581,r582,r583,r584,r585,r586,r587,r588,r589,r590,r591,r592,r593,r594,r595,r596,r597,r598,r599,r600,r601,r602,r603,r604,r605,r606,r607,r608,r609,r610,r611,r612,r613,r614,r615,r616,r617,r618,r619,r620,r621,r622,r623,r624,r625,r626,r627,r628,r629,r630,r631,r632,r633,r634,r635,r636,r637,r638,r639,r640,r641,r642,r643,r644,r645,r646,r647,r648,r649,r650,r651,r652,r653,r654,r655,r656,r657,r658,r659,r660,r661,r662,r663,r664,r665,r666,r667,r668,r669,r670,r671,r672,r673,r674,r675,r676,r677,r678,r679,r680,r681,r682,r683,r684,r685,r686,r687,r688,r689,r690,r691,r692,r693,r694,r695,r696,r697,r698,r699,r700,r701,r702,r703,r704,r705,r706,r707,r708,r709,r710,r711,r712,r713,r714,r715,r716,r717,r718,r719,r720,r721,r722,r723,r724,r725,r726,r727,r728,r729,r730,r731,r732,r733,r734,r735,r736,r737,r738,r739,r740,r741,r742,r743,r744,r745,r746,r747,r748,r749,r750,r751,r752,r753,r754,r755,r756,r757,r758,r759,r760,r761,r762,r763,r764,r765,r766,r767,r768,r769,r770,r771,r772,r773,r774,r775,r776,r777,r778,r779,r780,r781,r782,r783,r784,r785,r786,r787,r788,r789,r790,r791,r792,r793,r794,r795,r796,r797,r798,r799,r800,r801,r802,r803,r804,r805,r806,r807,r808,r809,r810,r811,r812,r813,r814,r815,r816,r817,r818,r819,r820,r821,r822,r823,r824,r825,r826,r827,r828,r829,r830,r831,r832,r833,r834,r835,r836,r837,r838,r839,r840,r841,r842,r843,r844,r845,r846,r847,r848,r849,r850,r851,r852,r853,r854,r855,r856,r857,r858,r859,r860,r861,r862,r863,r864,r865,r866,r867,r868,r869,r870,r871,r872,r873,r874,r875,r876,r877,r878,r879,r880,r881,r882,r883,r884,r885,r886,r887,r888,r889,r890,r891,r892,r893,r894,r895,r896,r897,r898,r899,r900,r901,r902,r903,r904,r905,r906,r907,r908,r909,r910,r911,r912,r913,r914,r915,r916,r917,r918,r919,r920,r921,r922,r923,r924,r925,r926,r927,r928,r929,r930,r931,r932,r933,r934,r935,r936,r937,r938,r939,r940,r941,r942,r943,r944,r945,r946,r947,r948,r949,r950,r951,r952,r953,r954,r955,r956,r957,r958,r959,r960,r961,r962,r963,r964,r965,r966,r967,r968,r969,r970,r971,r972,r973,r974,r975,r976,r977,r978,r979,r980,r981,r982,r983,r984,r985,r986,r987,r988,r989,r990,r991,r992,r993,r994,r995,r996,r997,r998,r999,r1000,r1001,r1002,r1003,r1004,r1005,r1006,r1007,r1008,r1009,r1010,r1011,r1012,r1013,r1014,r1015,r1016,r1017,r1018,r1019,r1020,r1021,r1022,r1023,r1024,r1025,r1026,r1027,r1028,r1029,r1030,r1031,r1032,r1033,r1034,r1035,r1036,r1037,r1038,r1039,r1040,r1041,r1042,r1043,r1044,r1045,r1046,r1047,r1048,r1049,r1050,r1051,r1052,r1053,r1054,r1055,r1056,r1057,r1058,r1059,r1060,r1061,r1062,r1063,r1064,r1065,r1066,r1067,r1068,r1069,r1070,r1071,r1072,r1073,r1074,r1075,r1076,r1077,r1078,r1079,r1080,r1081,r1082,r1083,r1084,r1085,r1086,r1087,r1088,r1089,r1090,r1091,r1092,r1093,r1094,r1095,r1096,r1097,r1098,r1099,r1100,r1101,r1102,r1103,r1104,r1105,r1106,r1107,r1108,r1109,r1110,r1111,r1112,r1113,r1114,r1115,r1116,r1117,r1118,r1119,r1120,r1121,r1122,r1123,r1124,r1125,r1126,r1127,r1128,r1129,r1130,r1131,r1132,r1133,r1134,r1135,r1136,r1137,r1138,r1139,r1140,r1141,r1142,r1143,r1144,r1145,r1146,r1147,r1148,r1149,r1150,r1151,r1152,r1153,r1154,r1155,r1156,r1157,r1158,r1159,r1160,r1161,r1162,r1163,r1164,r1165,r1166,r1167,r1168,r1169,r1170,r1171,r1172,r1173,r1174,r1175,r1176,r1177,r1178,r1179,r1180,r1181,r1182,r1183,r1184,r1185,r1186,r1187,r1188,r1189,r1190,r1191,r1192,r1193,r1194,r1195,r1196,r1197,r1198,r1199,r1200,r1201,r1202,r1203,r1204,r1205,r1206,r1207,r1208,r1209,r1210,r1211,r1212,r1213,r1214,r1215,r1216,r1217,r1218,r1219,r1220,r1221,r1222,r1223,r1224,r1225,r1226,r1227,r1228,r1229,r1230,r1231,r1232,r1233,r1234,r1235,r1236,r1237,r1238,r1239,r1240,r1241,r1242,r1243,r1244,r1245,r1246,r1247,r1248,r1249,r1250,r1251,r1252,r1253,r1254,r1255,r1256,r1257,r1258,r1259,r1260,r1261,r1262,r1263,r1264,r1265,r1266,r1267,r1268,r1269,r1270,r1271,r1272,r1273,r1274,r1275,r1276,r1277,r1278,r1279,r1280,r1281,r1282,r1283,r1284,r1285,r1286,r1287,r1288,r1289,r1290,r1291,r1292,r1293,r1294,r1295,r1296,r1297,r1298,r1299,r1300,r1301,r1302,r1303,r1304,r1305,r1306,r1307,r1308,r1309,r1310,r1311,r1312,r1313,r1314,r1315,r1316,r1317,r1318,r1319,r1320,r1321,r1322,r1323,r1324,r1325,r1326,r1327,r1328,r1329,r1330,r1331,r1332,r1333,r1334,r1335,r1336,r1337,r1338,r1339,r1340,r1341,r1342,r1343,r1344,r1345,r1346,r1347,r1348,r1349,r1350,r1351,r1352,r1353,r1354,r1355,r1356,r1357,r1358,r1359,r1360,r1361,r1362,r1363,r1364,r1365,r1366,r1367,r1368,r1369,r1370,r1371,r1372,r1373,r1374,r1375,r1376,r1377,r1378,r1379,r1380,r1381,r1382,r1383,r1384,r1385,r1386,r1387,r1388,r1389,r1390,r1391,r1392,r1393,r1394,r1395,r1396,r1397,r1398,r1399,r1400,r1401,r1402,r1403,r1404,r1405,r1406,r1407,r1408,r1409,r1410,r1411,r1412,r1413,r1414,r1415,r1416,r1417,r1418,r1419,r1420,r1421,r1422,r1423,r1424,r1425,r1426,r1427,r1428,r1429,r1430,r1431,r1432,r1433,r1434,r1435,r1436,r1437,r1438,r1439,r1440,r1441,r1442,r1443,r1444,r1445,r1446,r1447,r1448,r1449,r1450,r1451,r1452,r1453,r1454,r1455,r1456,r1457,r1458,r1459,r1460,r1461,r1462,r1463,r1464,r1465,r1466,r1467,r1468,r1469,r1470,r1471,r1472,r1473,r1474,r1475,r1476,r1477,r1478,r1479,r1480,r1481,r1482,r1483,r1484,r1485,r1486,r1487,r1488,r1489,r1490,r1491,r1492,r1493,r1494,r1495,r1496,r1497,r1498,r1499,r1500,r1501,r1502,r1503,r1504,r1505,r1506,r1507,r1508,r1509,r1510,r1511,r1512,r1513,r1514,r1515,r1516,r1517,r1518,r1519,r1520,r1521,r1522,r1523,r1524,r1525,r1526,r1527,r1528,r1529,r1530,r1531,r1532,r1533,r1534,r1535,r1536,r1537,r1538,r1539,r1540,r1541,r1542,r1543,r1544,r1545,r1546,r1547,r1548,r1549,r1550,r1551,r1552,r1553,r1554,r1555,r1556,r1557,r1558,r1559,r1560,r1561,r1562,r1563,r1564,r1565,r1566,r1567,r1568,r1569,r1570,r1571,r1572,r1573,r1574,r1575,r1576,r1577,r1578,r1579,r1580,r1581,r1582,r1583,r1584,r1585,r1586,r1587,r1588,r1589,r1590,r1591,r1592,r1593,r1594,r1595,r1596,r1597,r1598,r1599,r1600,r1601,r1602,r1603,r1604,r1605,r1606,r1607,r1608,r1609,r1610,r1611,r1612,r1613,r1614,r1615,r1616,r1617,r1618,r1619,r1620,r1621,r1622,r1623,r1624,r1625,r1626,r1627,r1628,r1629,r1630,r1631,r1632,r1633,r1634,r1635,r1636,r1637,r1638,r1639,r1640,r1641,r1642,r1643,r1644,r1645,r1646,r1647,r1648,r1649,r1650,r1651,r1652,r1653,r1654,r1655,r1656,r1657,r1658,r1659,r1660,r1661,r1662,r1663,r1664,r1665,r1666,r1667,r1668,r1669,r1670,r1671,r1672,r1673,r1674,r1675,r1676,r1677,r1678,r1679,r1680,r1681,r1682,r1683,r1684,r1685,r1686,r1687,r1688,r1689,r1690,r1691,r1692,r1693,r1694,r1695,r1696,r1697,r1698,r1699,r1700,r1701,r1702,r1703,r1704,r1705,r1706,r1707,r1708,r1709,r1710,r1711,r1712,r1713,r1714,r1715,r1716,r1717,r1718,r1719,r1720,r1721,r1722,r1723,r1724,r1725,r1726,r1727,r1728,r1729,r1730,r1731,r1732,r1733,r1734,r1735,r1736,r1737,r1738,r1739,r1740,r1741,r1742,r1743,r1744,r1745,r1746,r1747,r1748,r1749,r1750,r1751,r1752,r1753,r1754,r1755,r1756,r1757,r1758,r1759,r1760,r1761,r1762,r1763,r1764,r1765,r1766,r1767,r1768,r1769,r1770,r1771,r1772,r1773,r1774,r1775,r1776,r1777,r1778,r1779,r1780,r1781,r1782,r1783,r1784,r1785,r1786,r1787,r1788,r1789,r1790,r1791,r1792,r1793,r1794,r1795,r1796,r1797,r1798,r1799,r1800,r1801,r1802,r1803,r1804,r1805,r1806,r1807,r1808,r1809,r1810,r1811,r1812,r1813,r1814,r1815,r1816,r1817,r1818,r1819,r1820,r1821,r1822,r1823,r1824,r1825,r1826,r1827,r1828,r1829,r1830,r1831,r1832,r1833,r1834,r1835,r1836,r1837,r1838,r1839,r1840,r1841,r1842,r1843,r1844,r1845,r1846,r1847,r1848,r1849,r1850,r1851,r1852,r1853,r1854,r1855,r1856,r1857,r1858,r1859,r1860,r1861,r1862,r1863,r1864,r1865,r1866,r1867,r1868,r1869,r1870,r1871,r1872,r1873,r1874,r1875,r1876,r1877,r1878,r1879,r1880,r1881,r1882,r1883,r1884,r1885,r1886,r1887,r1888,r1889,r1890,r1891,r1892,r1893,r1894,r1895,r1896,r1897,r1898,r1899,r1900,r1901,r1902,r1903,r1904,r1905,r1906,r1907,r1908,r1909,r1910,r1911,r1912,r1913,r1914,r1915,r1916,r1917,r1918,r1919,r1920,r1921,r1922,r1923,r1924,r1925,r1926,r1927,r1928,r1929,r1930,r1931,r1932,r1933,r1934,r1935,r1936,r1937,r1938,r1939,r1940,r1941,r1942,r1943,r1944,r1945,r1946,r1947,r1948,r1949,r1950,r1951,r1952,r1953,r1954,r1955,r1956,r1957,r1958,r1959,r1960,r1961,r1962,r1963,r1964,r1965,r1966,r1967,r1968,r1969,r1970,r1971,r1972,r1973,r1974,r1975,r1976,r1977,r1978,r1979,r1980,r1981,r1982,r1983,r1984,r1985,r1986,r1987,r1988,r1989,r1990,r1991,r1992,r1993,r1994,r1995,r1996,r1997,r1998,r1999,r2000,r2001,r2002,r2003,r2004,r2005,r2006,r2007,r2008,r2009,r2010,r2011,r2012,r2013,r2014,r2015,r2016,r2017,r2018,r2019,r2020,r2021,r2022,r2023,r2024,r2025,r2026,r2027,r2028,r2029,r2030,r2031,r2032,r2033,r2034,r2035,r2036,r2037,r2038,r2039,r2040,r2041,r2042,r2043,r2044,r2045,r2046,r2047,r2048,r2049,r2050,r2051,r2052,r2053,r2054,r2055,r2056,r2057,r2058,r2059,r2060,r2061,r2062,r2063,r2064,r2065,r2066,r2067,r2068,r2069,r2070,r2071,r2072,r2073,r2074,r2075,r2076,r2077,r2078,r2079,r2080,r2081,r2082,r2083,r2084,r2085,r2086,r2087,r2088,r2089,r2090,r2091,r2092,r2093,r2094,r2095,r2096,r2097,r2098,r2099,r2100,r2101,r2102,r2103,r2104,r2105,r2106,r2107,r2108,r2109,r2110,r2111,r2112,r2113,r2114,r2115,r2116,r2117,r2118,r2119,r2120,r2121,r2122,r2123,r2124,r2125,r2126,r2127,r2128,r2129,r2130,r2131,r2132,r2133,r2134,r2135,r2136,r2137,r2138,r2139,r2140,r2141,r2142,r2143,r2144,r2145,r2146,r2147,r2148,r2149,r2150,r2151,r2152,r2153,r2154,r2155,r2156,r2157,r2158,r2159,r2160,r2161,r2162,r2163,r2164,r2165,r2166,r2167,r2168,r2169,r2170,r2171,r2172,r2173,r2174,r2175,r2176,r2177,r2178,r2179,r2180,r2181,r2182,r2183,r2184,r2185,r2186,r2187,r2188,r2189,r2190,r2191,r2192,r2193,r2194,r2195,r2196,r2197,r2198,r2199,r2200,r2201,r2202,r2203,r2204,r2205,r2206,r2207,r2208,r2209,r2210,r2211,r2212,r2213,r2214,r2215,r2216,r2217,r2218,r2219,r2220,r2221,r2222,r2223,r2224,r2225,r2226,r2227,r2228,r2229,r2230,r2231,r2232,r2233,r2234,r2235,r2236,r2237,r2238,r2239,r2240,r2241,r2242,r2243,r2244,r2245,r2246,r2247,r2248,r2249,r2250,r2251,r2252,r2253,r2254,r2255,r2256,r2257,r2258,r2259,r2260,r2261,r2262,r2263,r2264,r2265,r2266,r2267,r2268,r2269,r2270,r2271,r2272,r2273,r2274,r2275,r2276,r2277,r2278,r2279,r2280,r2281,r2282,r2283,r2284,r2285,r2286,r2287,r2288,r2289,r2290,r2291,r2292,r2293,r2294,r2295,r2296,r2297,r2298,r2299,r2300,r2301,r2302,r2303,r2304,r2305,r2306,r2307,r2308,r2309,r2310,r2311,r2312,r2313,r2314,r2315,r2316,r2317,r2318,r2319,r2320,r2321,r2322,r2323,r2324,r2325,r2326,r2327,r2328,r2329,r2330,r2331,r2332,r2333,r2334,r2335,r2336,r2337,r2338,r2339,r2340,r2341,r2342,r2343,r2344,r2345,r2346,r2347,r2348,r2349,r2350,r2351,r2352,r2353,r2354,r2355,r2356,r2357,r2358,r2359,r2360,r2361,r2362,r2363,r2364,r2365,r2366,r2367,r2368,r2369,r2370,r2371,r2372,r2373,r2374,r2375,r2376,r2377,r2378,r2379,r2380,r2381,r2382,r2383,r2384,r2385,r2386,r2387,r2388,r2389,r2390,r2391,r2392,r2393,r2394,r2395,r2396,r2397,r2398,r2399,r2400,r2401,r2402,r2403,r2404,r2405,r2406,r2407,r2408,r2409,r2410,r2411,r2412,r2413,r2414,r2415,r2416,r2417,r2418,r2419,r2420,r2421,r2422,r2423,r2424,r2425,r2426,r2427,r2428,r2429,r2430,r2431,r2432,r2433,r2434,r2435,r2436,r2437,r2438,r2439,r2440,r2441,r2442,r2443,r2444,r2445,r2446,r2447,r2448,r2449,r2450,r2451,r2452,r2453,r2454,r2455,r2456,r2457,r2458,r2459,r2460,r2461,r2462,r2463,r2464,r2465,r2466,r2467,r2468,r2469,r2470,r2471,r2472,r2473,r2474,r2475,r2476,r2477,r2478,r2479,r2480,r2481,r2482,r2483,r2484,r2485,r2486,r2487,r2488,r2489,r2490,r2491,r2492,r2493,r2494,r2495,r2496,r2497,r2498,r2499,r2500,r2501,r2502,r2503,r2504,r2505,r2506,r2507,r2508,r2509,r2510,r2511,r2512,r2513,r2514,r2515,r2516,r2517,r2518,r2519,r2520,r2521,r2522,r2523,r2524,r2525,r2526,r2527,r2528,r2529,r2530,r2531,r2532,r2533,r2534,r2535,r2536,r2537,r2538,r2539,r2540,r2541,r2542,r2543,r2544,r2545,r2546,r2547,r2548,r2549,r2550,r2551,r2552,r2553,r2554,r2555,r2556,r2557,r2558,r2559,r2560,r2561,r2562,r2563,r2564,r2565,r2566,r2567,r2568,r2569,r2570,r2571,r2572,r2573,r2574,r2575,r2576,r2577,r2578,r2579,r2580,r2581,r2582,r2583,r2584,r2585,r2586,r2587,r2588,r2589,r2590,r2591,r2592,r2593,r2594,r2595,r2596,r2597,r2598,r2599,r2600,r2601,r2602,r2603,r2604,r2605,r2606,r2607,r2608,r2609,r2610,r2611,r2612,r2613,r2614,r2615,r2616,r2617,r2618,r2619,r2620,r2621,r2622,r2623,r2624,r2625,r2626,r2627,r2628,r2629,r2630,r2631,r2632,r2633,r2634,r2635,r2636,r2637,r2638,r2639,r2640,r2641,r2642,r2643,r2644,r2645,r2646,r2647,r2648,r2649,r2650,r2651,r2652,r2653,r2654,r2655,r2656,r2657,r2658,r2659,r2660,r2661,r2662,r2663,r2664,r2665,r2666,r2667,r2668,r2669,r2670,r2671,r2672,r2673,r2674,r2675,r2676,r2677,r2678,r2679,r2680,r2681,r2682,r2683,r2684,r2685,r2686,r2687,r2688,r2689,r2690,r2691,r2692,r2693,r2694,r2695,r2696,r2697,r2698,r2699,r2700,r2701,r2702,r2703,r2704,r2705,r2706,r2707,r2708,r2709,r2710,r2711,r2712,r2713,r2714,r2715,r2716,r2717,r2718,r2719,r2720,r2721,r2722,r2723,r2724,r2725,r2726,r2727,r2728,r2729,r2730,r2731,r2732,r2733,r2734,r2735,r2736,r2737,r2738,r2739,r2740,r2741,r2742,r2743,r2744,r2745,r2746,r2747,r2748,r2749,r2750,r2751,r2752,r2753,r2754,r2755,r2756,r2757,r2758,r2759,r2760,r2761,r2762,r2763,r2764,r2765,r2766,r2767,r2768,r2769,r2770,r2771,r2772,r2773,r2774,r2775,r2776,r2777,r2778,r2779,r2780,r2781,r2782,r2783,r2784,r2785,r2786,r2787,r2788,r2789,r2790,r2791,r2792,r2793,r2794,r2795,r2796,r2797,r2798,r2799,r2800,r2801,r2802,r2803,r2804,r2805,r2806,r2807,r2808,r2809,r2810,r2811,r2812,r2813,r2814,r2815,r2816,r2817,r2818,r2819,r2820,r2821,r2822,r2823,r2824,r2825,r2826,r2827,r2828,r2829,r2830,r2831,r2832,r2833,r2834,r2835,r2836,r2837,r2838,r2839,r2840,r2841,r2842,r2843,r2844,r2845,r2846,r2847,r2848,r2849,r2850,r2851,r2852,r2853,r2854,r2855,r2856,r2857,r2858,r2859,r2860,r2861,r2862,r2863,r2864,r2865,r2866,r2867,r2868,r2869,r2870,r2871,r2872,r2873,r2874,r2875,r2876,r2877,r2878,r2879,r2880,r2881,r2882,r2883,r2884,r2885,r2886,r2887,r2888,r2889,r2890,r2891,r2892,r2893,r2894,r2895,r2896,r2897,r2898,r2899,r2900,r2901,r2902,r2903,r2904,r2905,r2906,r2907,r2908,r2909,r2910,r2911,r2912,r2913,r2914,r2915,r2916,r2917,r2918,r2919,r2920,r2921,r2922,r2923,r2924,r2925,r2926,r2927,r2928,r2929,r2930,r2931,r2932,r2933,r2934,r2935,r2936,r2937,r2938,r2939,r2940,r2941,r2942,r2943,r2944,r2945,r2946,r2947,r2948,r2949,r2950,r2951,r2952,r2953,r2954,r2955,r2956,r2957,r2958,r2959,r2960,r2961,r2962,r2963,r2964,r2965,r2966,r2967,r2968,r2969,r2970,r2971,r2972,r2973,r2974,r2975,r2976,r2977,r2978,r2979,r2980,r2981,r2982,r2983,r2984,r2985,r2986,r2987,r2988,r2989,r2990,r2991,r2992,r2993,r2994,r2995,r2996,r2997,r2998,r2999,r3000,r3001,r3002,r3003,r3004,r3005,r3006,r3007,r3008,r3009,r3010,r3011,r3012,r3013,r3014,r3015,r3016,r3017,r3018,r3019,r3020,r3021,r3022,r3023,r3024,r3025,r3026,r3027,r3028,r3029,r3030,r3031,r3032,r3033,r3034,r3035,r3036,r3037,r3038,r3039,r3040,r3041,r3042,r3043,r3044,r3045,r3046,r3047,r3048,r3049,r3050,r3051,r3052,r3053,r3054,r3055,r3056,r3057,r3058,r3059,r3060,r3061,r3062,r3063,r3064,r3065,r3066,r3067,r3068,r3069,r3070,r3071,r3072,r3073,r3074,r3075,r3076,r3077,r3078,r3079,r3080,r3081,r3082,r3083,r3084,r3085,r3086,r3087,r3088,r3089,r3090,r3091,r3092,r3093,r3094,r3095,r3096,r3097,r3098,r3099,r3100,r3101,r3102,r3103,r3104,r3105,r3106,r3107,r3108,r3109,r3110,r3111,r3112,r3113,r3114,r3115,r3116,r3117,r3118,r3119,r3120,r3121,r3122,r3123,r3124,r3125,r3126,r3127,r3128,r3129,r3130,r3131,r3132,r3133,r3134,r3135,r3136,r3137,r3138,r3139,r3140,r3141,r3142,r3143,r3144,r3145,r3146,r3147,r3148,r3149,r3150,r3151,r3152,r3153,r3154,r3155,r3156,r3157,r3158,r3159,r3160,r3161,r3162,r3163,r3164,r3165,r3166,r3167,r3168,r3169,r3170,r3171,r3172,r3173,r3174,r3175,r3176,r3177,r3178,r3179,r3180,r3181,r3182,r3183,r3184,r3185,r3186,r3187,r3188,r3189,r3190,r3191,r3192,r3193,r3194,r3195,r3196,r3197,r3198,r3199,r3200,r3201,r3202,r3203,r3204,r3205,r3206,r3207,r3208,r3209,r3210,r3211,r3212,r3213,r3214,r3215,r3216,r3217,r3218,r3219,r3220,r3221,r3222,r3223,r3224,r3225,r3226,r3227,r3228,r3229,r3230,r3231,r3232,r3233,r3234,r3235,r3236,r3237,r3238,r3239,r3240,r3241,r3242,r3243,r3244,r3245,r3246,r3247,r3248,r3249,r3250,r3251,r3252,r3253,r3254,r3255,r3256,r3257,r3258,r3259,r3260,r3261,r3262,r3263,r3264,r3265,r3266,r3267,r3268,r3269,r3270,r3271,r3272,r3273,r3274,r3275,r3276,r3277,r3278,r3279,r3280,r3281,r3282,r3283,r3284,r3285,r3286,r3287,r3288,r3289,r3290,r3291,r3292,r3293,r3294,r3295,r3296,r3297,r3298,r3299,r3300,r3301,r3302,r3303,r3304,r3305,r3306,r3307,r3308,r3309,r3310,r3311,r3312,r3313,r3314,r3315,r3316,r3317,r3318,r3319,r3320,r3321,r3322,r3323,r3324,r3325,r3326,r3327,r3328,r3329,r3330,r3331,r3332,r3333,r3334,r3335,r3336,r3337,r3338,r3339,r3340,r3341,r3342,r3343,r3344,r3345,r3346,r3347,r3348,r3349,r3350,r3351,r3352,r3353,r3354,r3355,r3356,r3357,r3358,r3359,r3360,r3361,r3362,r3363,r3364,r3365,r3366,r3367,r3368,r3369,r3370,r3371,r3372,r3373,r3374,r3375,r3376,r3377,r3378,r3379,r3380,r3381,r3382,r3383,r3384,r3385,r3386,r3387,r3388,r3389,r3390,r3391,r3392,r3393,r3394,r3395,r3396,r3397,r3398,r3399,r3400,r3401,r3402,r3403,r3404,r3405,r3406,r3407,r3408,r3409,r3410,r3411,r3412,r3413,r3414,r3415,r3416,r3417,r3418,r3419,r3420,r3421,r3422,r3423,r3424,r3425,r3426,r3427,r3428,r3429,r3430,r3431,r3432,r3433,r3434,r3435,r3436,r3437,r3438,r3439,r3440,r3441,r3442,r3443,r3444,r3445,r3446,r3447,r3448,r3449,r3450,r3451,r3452,r3453,r3454,r3455,r3456,r3457,r3458,r3459,r3460,r3461,r3462,r3463,r3464,r3465,r3466,r3467,r3468,r3469,r3470,r3471,r3472,r3473,r3474,r3475,r3476,r3477,r3478,r3479,r3480,r3481,r3482,r3483,r3484,r3485,r3486,r3487,r3488,r3489,r3490,r3491,r3492,r3493,r3494,r3495,r3496,r3497,r3498,r3499,r3500,r3501,r3502,r3503,r3504,r3505,r3506,r3507,r3508,r3509,r3510,r3511,r3512,r3513,r3514,r3515,r3516,r3517,r3518,r3519,r3520,r3521,r3522,r3523,r3524,r3525,r3526,r3527,r3528,r3529,r3530,r3531,r3532,r3533,r3534,r3535,r3536,r3537,r3538,r3539,r3540,r3541,r3542,r3543,r3544,r3545,r3546,r3547,r3548,r3549,r3550,r3551,r3552,r3553,r3554,r3555,r3556,r3557,r3558,r3559,r3560,r3561,r3562,r3563,r3564,r3565,r3566,r3567,r3568,r3569,r3570,r3571,r3572,r3573,r3574,r3575,r3576,r3577,r3578,r3579,r3580,r3581,r3582,r3583,r3584,r3585,r3586,r3587,r3588,r3589,r3590,r3591,r3592,r3593,r3594,r3595,r3596,r3597,r3598,r3599,r3600,r3601,r3602,r3603,r3604,r3605,r3606,r3607,r3608,r3609,r3610,r3611,r3612,r3613,r3614,r3615,r3616,r3617,r3618,r3619,r3620,r3621,r3622,r3623,r3624,r3625,r3626,r3627,r3628,r3629,r3630,r3631,r3632,r3633,r3634,r3635,r3636,r3637,r3638,r3639,r3640,r3641,r3642,r3643,r3644,r3645,r3646,r3647,r3648,r3649,r3650,r3651,r3652,r3653,r3654,r3655,r3656,r3657,r3658,r3659,r3660,r3661,r3662,r3663,r3664,r3665,r3666,r3667,r3668,r3669,r3670,r3671,r3672,r3673,r3674,r3675,r3676,r3677,r3678,r3679,r3680,r3681,r3682,r3683,r3684,r3685,r3686,r3687,r3688,r3689,r3690,r3691,r3692,r3693,r3694,r3695,r3696,r3697,r3698,r3699,r3700,r3701,r3702,r3703,r3704,r3705,r3706,r3707,r3708,r3709,r3710,r3711,r3712,r3713,r3714,r3715,r3716,r3717,r3718,r3719,r3720,r3721,r3722,r3723,r3724,r3725,r3726,r3727,r3728,r3729,r3730,r3731,r3732,r3733,r3734,r3735,r3736,r3737,r3738,r3739,r3740,r3741,r3742,r3743,r3744,r3745,r3746,r3747,r3748,r3749,r3750,r3751,r3752,r3753,r3754,r3755,r3756,r3757,r3758,r3759,r3760,r3761,r3762,r3763,r3764,r3765,r3766,r3767,r3768,r3769,r3770,r3771,r3772,r3773,r3774,r3775,r3776,r3777,r3778,r3779,r3780,r3781,r3782,r3783,r3784,r3785,r3786,r3787,r3788,r3789,r3790,r3791,r3792,r3793,r3794,r3795,r3796,r3797,r3798,r3799,r3800,r3801,r3802,r3803,r3804,r3805,r3806,r3807,r3808,r3809,r3810,r3811,r3812,r3813,r3814,r3815,r3816,r3817,r3818,r3819,r3820,r3821,r3822,r3823,r3824,r3825,r3826,r3827,r3828,r3829,r3830,r3831,r3832,r3833,r3834,r3835,r3836,r3837,r3838,r3839,r3840,r3841,r3842,r3843,r3844,r3845,r3846,r3847,r3848,r3849,r3850,r3851,r3852,r3853,r3854,r3855,r3856,r3857,r3858,r3859,r3860,r3861,r3862,r3863,r3864,r3865,r3866,r3867,r3868,r3869,r3870,r3871,r3872,r3873,r3874,r3875,r3876,r3877,r3878,r3879,r3880,r3881,r3882,r3883,r3884,r3885,r3886,r3887,r3888,r3889,r3890,r3891,r3892,r3893,r3894,r3895,r3896,r3897,r3898,r3899,r3900,r3901,r3902,r3903,r3904,r3905,r3906,r3907,r3908,r3909,r3910,r3911,r3912,r3913,r3914,r3915,r3916,r3917,r3918,r3919,r3920,r3921,r3922,r3923,r3924,r3925,r3926,r3927,r3928,r3929,r3930,r3931,r3932,r3933,r3934,r3935,r3936,r3937,r3938,r3939,r3940,r3941,r3942,r3943,r3944,r3945,r3946,r3947,r3948,r3949,r3950,r3951,r3952,r3953,r3954,r3955,r3956,r3957,r3958,r3959,r3960,r3961,r3962,r3963,r3964,r3965,r3966,r3967,r3968,r3969,r3970,r3971,r3972,r3973,r3974,r3975,r3976,r3977,r3978,r3979,r3980,r3981,r3982,r3983,r3984,r3985,r3986,r3987,r3988,r3989,r3990,r3991,r3992,r3993,r3994,r3995,r3996,r3997,r3998,r3999,r4000,r4001,r4002,r4003,r4004,r4005,r4006,r4007,r4008,r4009,r4010,r4011,r4012,r4013,r4014,r4015,r4016,r4017,r4018,r4019,r4020,r4021,r4022,r4023,r4024,r4025,r4026,r4027,r4028,r4029,r4030,r4031,r4032,r4033,r4034,r4035,r4036,r4037,r4038,r4039,r4040,r4041,r4042,r4043,r4044,r4045,r4046,r4047,r4048,r4049,r4050,r4051,r4052,r4053,r4054,r4055,r4056,r4057,r4058,r4059,r4060,r4061,r4062,r4063,r4064,r4065,r4066,r4067,r4068,r4069,r4070,r4071,r4072,r4073,r4074,r4075,r4076,r4077,r4078,r4079,r4080,r4081,r4082,r4083,r4084,r4085,r4086,r4087,r4088,r4089,r4090,r4091,r4092,r4093,r4094,r4095,r4096,r4097,r4098,r4099,r4100,r4101,r4102,r4103,r4104,r4105,r4106,r4107,r4108,r4109,r4110,r4111,r4112,r4113,r4114,r4115,r4116,r4117,r4118,r4119,r4120,r4121,r4122,r4123,r4124,r4125,r4126,r4127,r4128,r4129,r4130,r4131,r4132,r4133,r4134,r4135,r4136,r4137,r4138,r4139,r4140,r4141,r4142,r4143,r4144,r4145,r4146,r4147,r4148,r4149,r4150,r4151,r4152,r4153,r4154,r4155,r4156,r4157,r4158,r4159,r4160,r4161,r4162,r4163,r4164,r4165,r4166,r4167,r4168,r4169,r4170,r4171,r4172,r4173,r4174,r4175,r4176,r4177,r4178,r4179,r4180,r4181,r4182,r4183,r4184,r4185,r4186,r4187,r4188,r4189,r4190,r4191,r4192,r4193,r4194,r4195,r4196,r4197,r4198,r4199,r4200,r4201,r4202,r4203,r4204,r4205,r4206,r4207,r4208,r4209,r4210,r4211,r4212,r4213,r4214,r4215,r4216,r4217,r4218,r4219,r4220,r4221,r4222,r4223,r4224,r4225,r4226,r4227,r4228,r4229,r4230,r4231,r4232,r4233,r4234,r4235,r4236,r4237,r4238,r4239,r4240,r4241,r4242,r4243,r4244,r4245,r4246,r4247,r4248,r4249,r4250,r4251,r4252,r4253,r4254,r4255,r4256,r4257,r4258,r4259,r4260,r4261,r4262,r4263,r4264,r4265,r4266,r4267,r4268,r4269,r4270,r4271,r4272,r4273,r4274,r4275,r4276,r4277,r4278,r4279,r4280,r4281,r4282,r4283,r4284,r4285,r4286,r4287,r4288,r4289,r4290,r4291,r4292,r4293,r4294,r4295,r4296,r4297,r4298,r4299,r4300,r4301,r4302,r4303,r4304,r4305,r4306,r4307,r4308,r4309,r4310,r4311,r4312,r4313,r4314,r4315,r4316,r4317,r4318,r4319,r4320,r4321,r4322,r4323,r4324,r4325,r4326,r4327,r4328,r4329,r4330,r4331,r4332,r4333,r4334,r4335,r4336,r4337,r4338,r4339,r4340,r4341,r4342,r4343,r4344,r4345,r4346,r4347,r4348,r4349,r4350,r4351,r4352,r4353,r4354,r4355,r4356,r4357,r4358,r4359,r4360,r4361,r4362,r4363,r4364,r4365,r4366,r4367,r4368,r4369,r4370,r4371,r4372,r4373,r4374,r4375,r4376,r4377,r4378,r4379,r4380,r4381,r4382,r4383,r4384,r4385,r4386,r4387,r4388,r4389,r4390,r4391,r4392,r4393,r4394,r4395,r4396,r4397,r4398,r4399,r4400,r4401,r4402,r4403,r4404,r4405,r4406,r4407,r4408,r4409,r4410,r4411,r4412,r4413,r4414,r4415,r4416,r4417,r4418,r4419,r4420,r4421,r4422,r4423,r4424,r4425,r4426,r4427,r4428,r4429,r4430,r4431,r4432,r4433,r4434,r4435,r4436,r4437,r4438,r4439,r4440,r4441,r4442,r4443,r4444,r4445,r4446,r4447,r4448,r4449,r4450,r4451,r4452,r4453,r4454,r4455,r4456,r4457,r4458,r4459,r4460,r4461,r4462,r4463,r4464,r4465,r4466,r4467,r4468,r4469,r4470,r4471,r4472,r4473,r4474,r4475,r4476,r4477,r4478,r4479,r4480,r4481,r4482,r4483,r4484,r4485,r4486,r4487,r4488,r4489,r4490,r4491,r4492,r4493,r4494,r4495,r4496,r4497,r4498,r4499,r4500,r4501,r4502,r4503,r4504,r4505,r4506,r4507,r4508,r4509,r4510,r4511,r4512,r4513,r4514,r4515,r4516,r4517,r4518,r4519,r4520,r4521,r4522,r4523,r4524,r4525,r4526,r4527,r4528,r4529,r4530,r4531,r4532,r4533,r4534,r4535,r4536,r4537,r4538,r4539,r4540,r4541,r4542,r4543,r4544,r4545,r4546,r4547,r4548,r4549,r4550,r4551,r4552,r4553,r4554,r4555,r4556,r4557,r4558,r4559,r4560,r4561,r4562,r4563,r4564,r4565,r4566,r4567,r4568,r4569,r4570,r4571,r4572,r4573,r4574,r4575,r4576,r4577,r4578,r4579,r4580,r4581,r4582,r4583,r4584,r4585,r4586,r4587,r4588,r4589,r4590,r4591,r4592,r4593,r4594,r4595,r4596,r4597,r4598,r4599,r4600,r4601,r4602,r4603,r4604,r4605,r4606,r4607,r4608,r4609,r4610,r4611,r4612,r4613,r4614,r4615,r4616,r4617,r4618,r4619,r4620,r4621,r4622,r4623,r4624,r4625,r4626,r4627,r4628,r4629,r4630,r4631,r4632,r4633,r4634,r4635,r4636,r4637,r4638,r4639,r4640,r4641,r4642,r4643,r4644,r4645,r4646,r4647,r4648,r4649,r4650,r4651,r4652,r4653,r4654,r4655,r4656,r4657,r4658,r4659,r4660,r4661,r4662,r4663,r4664,r4665,r4666,r4667,r4668,r4669,r4670,r4671,r4672,r4673,r4674,r4675,r4676,r4677,r4678,r4679,r4680,r4681,r4682,r4683,r4684,r4685,r4686,r4687,r4688,r4689,r4690,r4691,r4692,r4693,r4694,r4695,r4696,r4697,r4698,r4699,r4700,r4701,r4702,r4703,r4704,r4705,r4706,r4707,r4708,r4709,r4710,r4711,r4712,r4713,r4714,r4715,r4716,r4717,r4718,r4719,r4720,r4721,r4722,r4723,r4724,r4725,r4726,r4727,r4728,r4729,r4730,r4731,r4732,r4733,r4734,r4735,r4736,r4737,r4738,r4739,r4740,r4741,r4742,r4743,r4744,r4745,r4746,r4747,r4748,r4749,r4750,r4751,r4752,r4753,r4754,r4755,r4756,r4757,r4758,r4759,r4760,r4761,r4762,r4763,r4764,r4765,r4766,r4767,r4768,r4769,r4770,r4771,r4772,r4773,r4774,r4775,r4776,r4777,r4778,r4779,r4780,r4781,r4782,r4783,r4784,r4785,r4786,r4787,r4788,r4789,r4790,r4791,r4792,r4793,r4794,r4795,r4796,r4797,r4798,r4799,r4800,r4801,r4802,r4803,r4804,r4805,r4806,r4807,r4808,r4809,r4810,r4811,r4812,r4813,r4814,r4815,r4816,r4817,r4818,r4819,r4820,r4821,r4822,r4823,r4824,r4825,r4826,r4827,r4828,r4829,r4830,r4831,r4832,r4833,r4834,r4835,r4836,r4837,r4838,r4839,r4840,r4841,r4842,r4843,r4844,r4845,r4846,r4847,r4848,r4849,r4850,r4851,r4852,r4853,r4854,r4855,r4856,r4857,r4858,r4859,r4860,r4861,r4862,r4863,r4864,r4865,r4866,r4867,r4868,r4869,r4870,r4871,r4872,r4873,r4874,r4875,r4876,r4877,r4878,r4879,r4880,r4881,r4882,r4883,r4884,r4885,r4886,r4887,r4888,r4889,r4890,r4891,r4892,r4893,r4894,r4895,r4896,r4897,r4898,r4899,r4900,r4901,r4902,r4903,r4904,r4905,r4906,r4907,r4908,r4909,r4910,r4911,r4912,r4913,r4914,r4915,r4916,r4917,r4918,r4919,r4920,r4921,r4922,r4923,r4924,r4925,r4926,r4927,r4928,r4929,r4930,r4931,r4932,r4933,r4934,r4935,r4936,r4937,r4938,r4939,r4940,r4941,r4942,r4943,r4944,r4945,r4946,r4947,r4948,r4949,r4950,r4951,r4952,r4953,r4954,r4955,r4956,r4957,r4958,r4959,r4960,r4961,r4962,r4963,r4964,r4965,r4966,r4967,r4968,r4969,r4970,r4971,r4972,r4973,r4974,r4975,r4976,r4977,r4978,r4979,r4980,r4981,r4982,r4983,r4984,r4985,r4986,r4987,r4988,r4989,r4990,r4991,r4992,r4993,r4994,r4995,r4996,r4997,r4998,r4999,r5000,r5001,r5002,r5003,r5004,r5005,r5006,r5007,r5008,r5009,r5010,r5011,r5012,r5013,r5014,r5015,r5016,r5017,r5018,r5019,r5020,r5021,r5022,r5023,r5024,r5025,r5026,r5027,r5028,r5029,r5030,r5031,r5032,r5033,r5034,r5035,r5036,r5037,r5038,r5039,r5040,r5041,r5042,r5043,r5044,r5045,r5046,r5047,r5048,r5049,r5050,r5051,r5052,r5053,r5054,r5055,r5056,r5057,r5058,r5059,r5060,r5061,r5062,r5063,r5064,r5065,r5066,r5067,r5068,r5069,r5070,r5071,r5072,r5073,r5074,r5075,r5076,r5077,r5078,r5079,r5080,r5081,r5082,r5083,r5084,r5085,r5086,r5087,r5088,r5089,r5090,r5091,r5092,r5093,r5094,r5095,r5096,r5097,r5098,r5099,r5100,r5101,r5102,r5103,r5104,r5105,r5106,r5107,r5108,r5109,r5110,r5111,r5112,r5113,r5114,r5115,r5116,r5117,r5118,r5119,r5120,r5121,r5122,r5123,r5124,r5125,r5126,r5127,r5128,r5129,r5130,r5131,r5132,r5133,r5134,r5135,r5136,r5137,r5138,r5139,r5140,r5141,r5142,r5143,r5144,r5145,r5146,r5147,r5148,r5149,r5150,r5151,r5152,r5153,r5154,r5155,r5156,r5157,r5158,r5159,r5160,r5161,r5162,r5163,r5164,r5165,r5166,r5167,r5168,r5169,r5170,r5171,r5172,r5173,r5174,r5175,r5176,r5177,r5178,r5179,r5180,r5181,r5182,r5183,r5184,r5185,r5186,r5187,r5188,r5189,r5190,r5191,r5192,r5193,r5194,r5195,r5196,r5197,r5198,r5199,r5200,r5201,r5202,r5203,r5204,r5205,r5206,r5207,r5208,r5209,r5210,r5211,r5212,r5213,r5214,r5215,r5216,r5217,r5218,r5219,r5220,r5221,r5222,r5223,r5224,r5225,r5226,r5227,r5228,r5229,r5230,r5231,r5232,r5233,r5234,r5235,r5236,r5237,r5238,r5239,r5240,r5241,r5242,r5243,r5244,r5245,r5246,r5247,r5248,r5249,r5250,r5251,r5252,r5253,r5254,r5255,r5256,r5257,r5258,r5259,r5260,r5261,r5262,r5263,r5264,r5265,r5266,r5267,r5268,r5269,r5270,r5271,r5272,r5273,r5274,r5275,r5276,r5277,r5278,r5279,r5280,r5281,r5282,r5283,r5284,r5285,r5286,r5287,r5288,r5289,r5290,r5291,r5292,r5293,r5294,r5295,r5296,r5297,r5298,r5299,r5300,r5301,r5302,r5303,r5304,r5305,r5306,r5307,r5308,r5309,r5310,r5311,r5312,r5313,r5314,r5315,r5316,r5317,r5318,r5319,r5320,r5321,r5322,r5323,r5324,r5325,r5326,r5327,r5328,r5329,r5330,r5331,r5332,r5333,r5334,r5335,r5336,r5337,r5338,r5339,r5340,r5341,r5342,r5343,r5344,r5345,r5346,r5347,r5348,r5349,r5350,r5351,r5352,r5353,r5354,r5355,r5356,r5357,r5358,r5359,r5360,r5361,r5362,r5363,r5364,r5365,r5366,r5367,r5368,r5369,r5370,r5371,r5372,r5373,r5374,r5375,r5376,r5377,r5378,r5379,r5380,r5381,r5382,r5383,r5384,r5385,r5386,r5387,r5388,r5389,r5390,r5391,r5392,r5393,r5394,r5395,r5396,r5397,r5398,r5399,r5400,r5401,r5402,r5403,r5404,r5405,r5406,r5407,r5408,r5409,r5410,r5411,r5412,r5413,r5414,r5415,r5416,r5417,r5418,r5419,r5420,r5421,r5422,r5423,r5424,r5425,r5426,r5427,r5428,r5429,r5430,r5431,r5432,r5433,r5434,r5435,r5436,r5437,r5438,r5439,r5440,r5441,r5442,r5443,r5444,r5445,r5446,r5447,r5448,r5449,r5450,r5451,r5452,r5453,r5454,r5455,r5456,r5457,r5458,r5459,r5460,r5461,r5462,r5463,r5464,r5465,r5466,r5467,r5468,r5469,r5470,r5471,r5472,r5473,r5474,r5475,r5476,r5477,r5478,r5479,r5480,r5481,r5482,r5483,r5484,r5485,r5486,r5487,r5488,r5489,r5490,r5491,r5492,r5493,r5494,r5495,r5496,r5497,r5498,r5499,r5500,r5501,r5502,r5503,r5504,r5505,r5506,r5507,r5508,r5509,r5510,r5511,r5512,r5513,r5514,r5515,r5516,r5517,r5518,r5519,r5520,r5521,r5522,r5523,r5524,r5525,r5526,r5527,r5528,r5529,r5530,r5531,r5532,r5533,r5534,r5535,r5536,r5537,r5538,r5539,r5540,r5541,r5542,r5543,r5544,r5545,r5546,r5547,r5548,r5549,r5550,r5551,r5552,r5553,r5554,r5555,r5556,r5557,r5558,r5559,r5560,r5561,r5562,r5563,r5564,r5565,r5566,r5567,r5568,r5569,r5570,r5571,r5572,r5573,r5574,r5575,r5576,r5577,r5578,r5579,r5580,r5581,r5582,r5583,r5584,r5585,r5586,r5587,r5588,r5589,r5590,r5591,r5592,r5593,r5594,r5595,r5596,r5597,r5598,r5599,r5600,r5601,r5602,r5603,r5604,r5605,r5606,r5607,r5608,r5609,r5610,r5611,r5612,r5613,r5614,r5615,r5616,r5617,r5618,r5619,r5620,r5621,r5622,r5623,r5624,r5625,r5626,r5627,r5628,r5629,r5630,r5631,r5632,r5633,r5634,r5635,r5636,r5637,r5638,r5639,r5640,r5641,r5642,r5643,r5644,r5645,r5646,r5647,r5648,r5649,r5650,r5651,r5652,r5653,r5654,r5655,r5656,r5657,r5658,r5659,r5660,r5661,r5662,r5663,r5664,r5665,r5666,r5667,r5668,r5669,r5670,r5671,r5672,r5673,r5674,r5675,r5676,r5677,r5678,r5679,r5680,r5681,r5682,r5683,r5684,r5685,r5686,r5687,r5688,r5689,r5690,r5691,r5692,r5693,r5694,r5695,r5696,r5697,r5698,r5699,r5700,r5701,r5702,r5703,r5704,r5705,r5706,r5707,r5708,r5709,r5710,r5711,r5712,r5713,r5714,r5715,r5716,r5717,r5718,r5719,r5720,r5721,r5722,r5723,r5724,r5725,r5726,r5727,r5728,r5729,r5730,r5731,r5732,r5733,r5734,r5735,r5736,r5737,r5738,r5739,r5740,r5741,r5742,r5743,r5744,r5745,r5746,r5747,r5748,r5749,r5750,r5751,r5752,r5753,r5754,r5755,r5756,r5757,r5758,r5759,r5760,r5761,r5762,r5763,r5764,r5765,r5766,r5767,r5768,r5769,r5770,r5771,r5772,r5773,r5774,r5775,r5776,r5777,r5778,r5779,r5780,r5781,r5782,r5783,r5784,r5785,r5786,r5787,r5788,r5789,r5790,r5791,r5792,r5793,r5794,r5795,r5796,r5797,r5798,r5799,r5800,r5801,r5802,r5803,r5804,r5805,r5806,r5807,r5808,r5809,r5810,r5811,r5812,r5813,r5814,r5815,r5816,r5817,r5818,r5819,r5820,r5821,r5822,r5823,r5824,r5825,r5826,r5827,r5828,r5829,r5830,r5831,r5832,r5833,r5834,r5835,r5836,r5837,r5838,r5839,r5840,r5841,r5842,r5843,r5844,r5845,r5846,r5847,r5848,r5849,r5850,r5851,r5852,r5853,r5854,r5855,r5856,r5857,r5858,r5859,r5860,r5861,r5862,r5863,r5864,r5865,r5866,r5867,r5868,r5869,r5870,r5871,r5872,r5873,r5874,r5875,r5876,r5877,r5878,r5879,r5880,r5881,r5882,r5883,r5884,r5885,r5886,r5887,r5888,r5889,r5890,r5891,r5892,r5893,r5894,r5895,r5896,r5897,r5898,r5899,r5900,r5901,r5902,r5903,r5904,r5905,r5906,r5907,r5908,r5909,r5910,r5911,r5912,r5913,r5914,r5915,r5916,r5917,r5918,r5919,r5920,r5921,r5922,r5923,r5924,r5925,r5926,r5927,r5928,r5929,r5930,r5931,r5932,r5933,r5934,r5935,r5936,r5937,r5938,r5939,r5940,r5941,r5942,r5943,r5944,r5945,r5946,r5947,r5948,r5949,r5950,r5951,r5952,r5953,r5954,r5955,r5956,r5957,r5958,r5959,r5960,r5961,r5962,r5963,r5964,r5965,r5966,r5967,r5968,r5969,r5970,r5971,r5972,r5973,r5974,r5975,r5976,r5977,r5978,r5979,r5980,r5981,r5982,r5983,r5984,r5985,r5986,r5987,r5988,r5989,r5990,r5991,r5992,r5993,r5994,r5995,r5996,r5997,r5998,r5999,r6000,r6001,r6002,r6003,r6004,r6005,r6006,r6007,r6008,r6009,r6010,r6011,r6012,r6013,r6014,r6015,r6016,r6017,r6018,r6019,r6020,r6021,r6022,r6023,r6024,r6025,r6026,r6027,r6028,r6029,r6030,r6031,r6032,r6033,r6034,r6035,r6036,r6037,r6038,r6039,r6040,r6041,r6042,r6043,r6044,r6045,r6046,r6047,r6048,r6049,r6050,r6051,r6052,r6053,r6054,r6055,r6056,r6057,r6058,r6059,r6060,r6061,r6062,r6063,r6064,r6065,r6066,r6067,r6068,r6069,r6070,r6071,r6072,r6073,r6074,r6075,r6076,r6077,r6078,r6079,r6080,r6081,r6082,r6083,r6084,r6085,r6086,r6087,r6088,r6089,r6090,r6091,r6092,r6093,r6094,r6095,r6096,r6097,r6098,r6099,r6100,r6101,r6102,r6103,r6104,r6105,r6106,r6107,r6108,r6109,r6110,r6111,r6112,r6113,r6114,r6115,r6116,r6117,r6118,r6119,r6120,r6121,r6122,r6123,r6124,r6125,r6126,r6127,r6128,r6129,r6130,r6131,r6132,r6133,r6134,r6135,r6136,r6137,r6138,r6139,r6140,r6141,r6142,r6143,r6144,r6145,r6146,r6147,r6148,r6149,r6150,r6151,r6152,r6153,r6154,r6155,r6156,r6157,r6158,r6159,r6160,r6161,r6162,r6163,r6164,r6165,r6166,r6167,r6168,r6169,r6170,r6171,r6172,r6173,r6174,r6175,r6176,r6177,r6178,r6179,r6180,r6181,r6182,r6183,r6184,r6185,r6186,r6187,r6188,r6189,r6190,r6191,r6192,r6193,r6194,r6195,r6196,r6197,r6198,r6199,r6200,r6201,r6202,r6203,r6204,r6205,r6206,r6207,r6208,r6209,r6210,r6211,r6212,r6213,r6214,r6215,r6216,r6217,r6218,r6219,r6220,r6221,r6222,r6223,r6224,r6225,r6226,r6227,r6228,r6229,r6230,r6231,r6232,r6233,r6234,r6235,r6236,r6237,r6238,r6239,r6240,r6241,r6242,r6243,r6244,r6245,r6246,r6247,r6248,r6249,r6250,r6251,r6252,r6253,r6254,r6255,r6256,r6257,r6258,r6259,r6260,r6261,r6262,r6263,r6264,r6265,r6266,r6267,r6268,r6269,r6270,r6271,r6272,r6273,r6274,r6275,r6276,r6277,r6278,r6279,r6280,r6281,r6282,r6283,r6284,r6285,r6286,r6287,r6288,r6289,r6290,r6291,r6292,r6293,r6294,r6295,r6296,r6297,r6298,r6299,r6300,r6301,r6302,r6303,r6304,r6305,r6306,r6307,r6308,r6309,r6310,r6311,r6312,r6313,r6314,r6315,r6316,r6317,r6318,r6319,r6320,r6321,r6322,r6323,r6324,r6325,r6326,r6327,r6328,r6329,r6330,r6331,r6332,r6333,r6334,r6335,r6336,r6337,r6338,r6339,r6340,r6341,r6342,r6343,r6344,r6345,r6346,r6347,r6348,r6349,r6350,r6351,r6352,r6353,r6354,r6355,r6356,r6357,r6358,r6359,r6360,r6361,r6362,r6363,r6364,r6365,r6366,r6367,r6368,r6369,r6370,r6371,r6372,r6373,r6374,r6375,r6376,r6377,r6378,r6379,r6380,r6381,r6382,r6383,r6384,r6385,r6386,r6387,r6388,r6389,r6390,r6391,r6392,r6393,r6394,r6395,r6396,r6397,r6398,r6399,r6400,r6401,r6402,r6403,r6404,r6405,r6406,r6407,r6408,r6409,r6410,r6411,r6412,r6413,r6414,r6415,r6416,r6417,r6418,r6419,r6420,r6421,r6422,r6423,r6424,r6425,r6426,r6427,r6428,r6429,r6430,r6431,r6432,r6433,r6434,r6435,r6436,r6437,r6438,r6439,r6440,r6441,r6442,r6443,r6444,r6445,r6446,r6447,r6448,r6449,r6450,r6451,r6452,r6453,r6454,r6455,r6456,r6457,r6458,r6459,r6460,r6461,r6462,r6463,r6464,r6465,r6466,r6467,r6468,r6469,r6470,r6471,r6472,r6473,r6474,r6475,r6476,r6477,r6478,r6479,r6480,r6481,r6482,r6483,r6484,r6485,r6486,r6487,r6488,r6489,r6490,r6491,r6492,r6493,r6494,r6495,r6496,r6497,r6498,r6499,r6500,r6501,r6502,r6503,r6504,r6505,r6506,r6507,r6508,r6509,r6510,r6511,r6512,r6513,r6514,r6515,r6516,r6517,r6518,r6519,r6520,r6521,r6522,r6523,r6524,r6525,r6526,r6527,r6528,r6529,r6530,r6531,r6532,r6533,r6534,r6535,r6536,r6537,r6538,r6539,r6540,r6541,r6542,r6543,r6544,r6545,r6546,r6547,r6548,r6549,r6550,r6551,r6552,r6553,r6554,r6555,r6556,r6557,r6558,r6559,r6560,r6561,r6562,r6563,r6564,r6565,r6566,r6567,r6568,r6569,r6570,r6571,r6572,r6573,r6574,r6575,r6576,r6577,r6578,r6579,r6580,r6581,r6582,r6583,r6584,r6585,r6586,r6587,r6588,r6589,r6590,r6591,r6592,r6593,r6594,r6595,r6596,r6597,r6598,r6599,r6600,r6601,r6602,r6603,r6604,r6605,r6606,r6607,r6608,r6609,r6610,r6611,r6612,r6613,r6614,r6615,r6616,r6617,r6618,r6619,r6620,r6621,r6622,r6623,r6624,r6625,r6626,r6627,r6628,r6629,r6630,r6631,r6632,r6633,r6634,r6635,r6636,r6637,r6638,r6639,r6640,r6641,r6642,r6643,r6644,r6645,r6646,r6647,r6648,r6649,r6650,r6651,r6652,r6653,r6654,r6655,r6656,r6657,r6658,r6659,r6660,r6661,r6662,r6663,r6664,r6665,r6666,r6667,r6668,r6669,r6670,r6671,r6672,r6673,r6674,r6675,r6676,r6677,r6678,r6679,r6680,r6681,r6682,r6683,r6684,r6685,r6686,r6687,r6688,r6689,r6690,r6691,r6692,r6693,r6694,r6695,r6696,r6697,r6698,r6699,r6700,r6701,r6702,r6703,r6704,r6705,r6706,r6707,r6708,r6709,r6710,r6711,r6712,r6713,r6714,r6715,r6716,r6717,r6718,r6719,r6720,r6721,r6722,r6723,r6724,r6725,r6726,r6727,r6728,r6729,r6730,r6731,r6732,r6733,r6734,r6735,r6736,r6737,r6738,r6739,r6740,r6741,r6742,r6743,r6744,r6745,r6746,r6747,r6748,r6749,r6750,r6751,r6752,r6753,r6754,r6755,r6756,r6757,r6758,r6759,r6760,r6761,r6762,r6763,r6764,r6765,r6766,r6767,r6768,r6769,r6770,r6771,r6772,r6773,r6774,r6775,r6776,r6777,r6778,r6779,r6780,r6781,r6782,r6783,r6784,r6785,r6786,r6787,r6788,r6789,r6790,r6791,r6792,r6793,r6794,r6795,r6796,r6797,r6798,r6799,r6800,r6801,r6802,r6803,r6804,r6805,r6806,r6807,r6808,r6809,r6810,r6811,r6812,r6813,r6814,r6815,r6816,r6817,r6818,r6819,r6820,r6821,r6822,r6823,r6824,r6825,r6826,r6827,r6828,r6829,r6830,r6831,r6832,r6833,r6834,r6835,r6836,r6837,r6838,r6839,r6840,r6841,r6842,r6843,r6844,r6845,r6846,r6847,r6848,r6849,r6850,r6851,r6852,r6853,r6854,r6855,r6856,r6857,r6858,r6859,r6860,r6861,r6862,r6863,r6864,r6865,r6866,r6867,r6868,r6869,r6870,r6871,r6872,r6873,r6874,r6875,r6876,r6877,r6878,r6879,r6880,r6881,r6882,r6883,r6884,r6885,r6886,r6887,r6888,r6889,r6890,r6891,r6892,r6893,r6894,r6895,r6896,r6897,r6898,r6899,r6900,r6901,r6902,r6903,r6904,r6905,r6906,r6907,r6908,r6909,r6910,r6911,r6912,r6913,r6914,r6915,r6916,r6917,r6918,r6919,r6920,r6921,r6922,r6923,r6924,r6925,r6926,r6927,r6928,r6929,r6930,r6931,r6932,r6933,r6934,r6935,r6936,r6937,r6938,r6939,r6940,r6941,r6942,r6943,r6944,r6945,r6946,r6947,r6948,r6949,r6950,r6951,r6952,r6953,r6954,r6955,r6956,r6957,r6958,r6959,r6960,r6961,r6962,r6963,r6964,r6965,r6966,r6967,r6968,r6969,r6970,r6971,r6972,r6973,r6974,r6975,r6976,r6977,r6978,r6979,r6980,r6981,r6982,r6983,r6984,r6985,r6986,r6987,r6988,r6989,r6990,r6991,r6992,r6993,r6994,r6995,r6996,r6997,r6998,r6999,r7000,r7001,r7002,r7003,r7004,r7005,r7006,r7007,r7008,r7009,r7010,r7011,r7012,r7013,r7014,r7015,r7016,r7017,r7018,r7019,r7020,r7021,r7022,r7023,r7024,r7025,r7026,r7027,r7028,r7029,r7030,r7031,r7032,r7033,r7034,r7035,r7036,r7037,r7038,r7039,r7040,r7041,r7042,r7043,r7044,r7045,r7046,r7047,r7048,r7049,r7050,r7051,r7052,r7053,r7054,r7055,r7056,r7057,r7058,r7059,r7060,r7061,r7062,r7063,r7064,r7065,r7066,r7067,r7068,r7069,r7070,r7071,r7072,r7073,r7074,r7075,r7076,r7077,r7078,r7079,r7080,r7081,r7082,r7083,r7084,r7085,r7086,r7087,r7088,r7089,r7090,r7091,r7092,r7093,r7094,r7095,r7096,r7097,r7098,r7099,r7100,r7101,r7102,r7103,r7104,r7105,r7106,r7107,r7108,r7109,r7110,r7111,r7112,r7113,r7114,r7115,r7116,r7117,r7118,r7119,r7120,r7121,r7122,r7123,r7124,r7125,r7126,r7127,r7128,r7129,r7130,r7131,r7132,r7133,r7134,r7135,r7136,r7137,r7138,r7139,r7140,r7141,r7142,r7143,r7144,r7145,r7146,r7147,r7148,r7149,r7150,r7151,r7152,r7153,r7154,r7155,r7156,r7157,r7158,r7159,r7160,r7161,r7162,r7163,r7164,r7165,r7166,r7167,r7168,r7169,r7170,r7171,r7172,r7173,r7174,r7175,r7176,r7177,r7178,r7179,r7180,r7181,r7182,r7183,r7184,r7185,r7186,r7187,r7188,r7189,r7190,r7191,r7192,r7193,r7194,r7195,r7196,r7197,r7198,r7199,r7200,r7201,r7202,r7203,r7204,r7205,r7206,r7207,r7208,r7209,r7210,r7211,r7212,r7213,r7214,r7215,r7216,r7217,r7218,r7219,r7220,r7221,r7222,r7223,r7224,r7225,r7226,r7227,r7228,r7229,r7230,r7231,r7232,r7233,r7234,r7235,r7236,r7237,r7238,r7239,r7240,r7241,r7242,r7243,r7244,r7245,r7246,r7247,r7248,r7249,r7250,r7251,r7252,r7253,r7254,r7255,r7256,r7257,r7258,r7259,r7260,r7261,r7262,r7263,r7264,r7265,r7266,r7267,r7268,r7269,r7270,r7271,r7272,r7273,r7274,r7275,r7276,r7277,r7278,r7279,r7280,r7281,r7282,r7283,r7284,r7285,r7286,r7287,r7288,r7289,r7290,r7291,r7292,r7293,r7294,r7295,r7296,r7297,r7298,r7299,r7300,r7301,r7302,r7303,r7304,r7305,r7306,r7307,r7308,r7309,r7310,r7311,r7312,r7313,r7314,r7315,r7316,r7317,r7318,r7319,r7320,r7321,r7322,r7323,r7324,r7325,r7326,r7327,r7328,r7329,r7330,r7331,r7332,r7333,r7334,r7335,r7336,r7337,r7338,r7339,r7340,r7341,r7342,r7343,r7344,r7345,r7346,r7347,r7348,r7349,r7350,r7351,r7352,r7353,r7354,r7355,r7356,r7357,r7358,r7359,r7360,r7361,r7362,r7363,r7364,r7365,r7366,r7367,r7368,r7369,r7370,r7371,r7372,r7373,r7374,r7375,r7376,r7377,r7378,r7379,r7380,r7381,r7382,r7383,r7384,r7385,r7386,r7387,r7388,r7389,r7390,r7391,r7392,r7393,r7394,r7395,r7396,r7397,r7398,r7399,r7400,r7401,r7402,r7403,r7404,r7405,r7406,r7407,r7408,r7409,r7410,r7411,r7412,r7413,r7414,r7415,r7416,r7417,r7418,r7419,r7420,r7421,r7422,r7423,r7424,r7425,r7426,r7427,r7428,r7429,r7430,r7431,r7432,r7433,r7434,r7435,r7436,r7437,r7438,r7439,r7440,r7441,r7442,r7443,r7444,r7445,r7446,r7447,r7448,r7449,r7450,r7451,r7452,r7453,r7454,r7455,r7456,r7457,r7458,r7459,r7460,r7461,r7462,r7463,r7464,r7465,r7466,r7467,r7468,r7469,r7470,r7471,r7472,r7473,r7474,r7475,r7476,r7477,r7478,r7479,r7480,r7481,r7482,r7483,r7484,r7485,r7486,r7487,r7488,r7489,r7490,r7491,r7492,r7493,r7494,r7495,r7496,r7497,r7498,r7499,r7500,r7501,r7502,r7503,r7504,r7505,r7506,r7507,r7508,r7509,r7510,r7511,r7512,r7513,r7514,r7515,r7516,r7517,r7518,r7519,r7520,r7521,r7522,r7523,r7524,r7525,r7526,r7527,r7528,r7529,r7530,r7531,r7532,r7533,r7534,r7535,r7536,r7537,r7538,r7539,r7540,r7541,r7542,r7543,r7544,r7545,r7546,r7547,r7548,r7549,r7550,r7551,r7552,r7553,r7554,r7555,r7556,r7557,r7558,r7559,r7560,r7561,r7562,r7563,r7564,r7565,r7566,r7567,r7568,r7569,r7570,r7571,r7572,r7573,r7574,r7575,r7576,r7577,r7578,r7579,r7580,r7581,r7582,r7583,r7584,r7585,r7586,r7587,r7588,r7589,r7590,r7591,r7592,r7593,r7594,r7595,r7596,r7597,r7598,r7599,r7600,r7601,r7602,r7603,r7604,r7605,r7606,r7607,r7608,r7609,r7610,r7611,r7612,r7613,r7614,r7615,r7616,r7617,r7618,r7619,r7620,r7621,r7622,r7623,r7624,r7625,r7626,r7627,r7628,r7629,r7630,r7631,r7632,r7633,r7634,r7635,r7636,r7637,r7638,r7639,r7640,r7641,r7642,r7643,r7644,r7645,r7646,r7647,r7648,r7649,r7650,r7651,r7652,r7653,r7654,r7655,r7656,r7657,r7658,r7659,r7660,r7661,r7662,r7663,r7664,r7665,r7666,r7667,r7668,r7669,r7670,r7671,r7672,r7673,r7674,r7675,r7676,r7677,r7678,r7679,r7680,r7681,r7682,r7683,r7684,r7685,r7686,r7687,r7688,r7689,r7690,r7691,r7692,r7693,r7694,r7695,r7696,r7697,r7698,r7699,r7700,r7701,r7702,r7703,r7704,r7705,r7706,r7707,r7708,r7709,r7710,r7711,r7712,r7713,r7714,r7715,r7716,r7717,r7718,r7719,r7720,r7721,r7722,r7723,r7724,r7725,r7726,r7727,r7728,r7729,r7730,r7731,r7732,r7733,r7734,r7735,r7736,r7737,r7738,r7739,r7740,r7741,r7742,r7743,r7744,r7745,r7746,r7747,r7748,r7749,r7750,r7751,r7752,r7753,r7754,r7755,r7756,r7757,r7758,r7759,r7760,r7761,r7762,r7763,r7764,r7765,r7766,r7767,r7768,r7769,r7770,r7771,r7772,r7773,r7774,r7775,r7776,r7777,r7778,r7779,r7780,r7781,r7782,r7783,r7784,r7785,r7786,r7787,r7788,r7789,r7790,r7791,r7792,r7793,r7794,r7795,r7796,r7797,r7798,r7799,r7800,r7801,r7802,r7803,r7804,r7805,r7806,r7807,r7808,r7809,r7810,r7811,r7812,r7813,r7814,r7815,r7816,r7817,r7818,r7819,r7820,r7821,r7822,r7823,r7824,r7825,r7826,r7827,r7828,r7829,r7830,r7831,r7832,r7833,r7834,r7835,r7836,r7837,r7838,r7839,r7840,r7841,r7842,r7843,r7844,r7845,r7846,r7847,r7848,r7849,r7850,r7851,r7852,r7853,r7854,r7855,r7856,r7857,r7858,r7859,r7860,r7861,r7862,r7863,r7864,r7865,r7866,r7867,r7868,r7869,r7870,r7871,r7872,r7873,r7874,r7875,r7876,r7877,r7878,r7879,r7880,r7881,r7882,r7883,r7884,r7885,r7886,r7887,r7888,r7889,r7890,r7891,r7892,r7893,r7894,r7895,r7896,r7897,r7898,r7899,r7900,r7901,r7902,r7903,r7904,r7905,r7906,r7907,r7908,r7909,r7910,r7911,r7912,r7913,r7914,r7915,r7916,r7917,r7918,r7919,r7920,r7921,r7922,r7923,r7924,r7925,r7926,r7927,r7928,r7929,r7930,r7931,r7932,r7933,r7934,r7935,r7936,r7937,r7938,r7939,r7940,r7941,r7942,r7943,r7944,r7945,r7946,r7947,r7948,r7949,r7950,r7951,r7952,r7953,r7954,r7955,r7956,r7957,r7958,r7959,r7960,r7961,r7962,r7963,r7964,r7965,r7966,r7967,r7968,r7969,r7970,r7971,r7972,r7973,r7974,r7975,r7976,r7977,r7978,r7979,r7980,r7981,r7982,r7983,r7984,r7985,r7986,r7987,r7988,r7989,r7990,r7991,r7992,r7993,r7994,r7995,r7996,r7997,r7998,r7999,r8000,r8001,r8002,r8003,r8004,r8005,r8006,r8007,r8008,r8009,r8010,r8011,r8012,r8013,r8014,r8015,r8016,r8017,r8018,r8019,r8020,r8021,r8022,r8023,r8024,r8025,r8026,r8027,r8028,r8029,r8030,r8031,r8032,r8033,r8034,r8035,r8036,r8037,r8038,r8039,r8040,r8041,r8042,r8043,r8044,r8045,r8046,r8047,r8048,r8049,r8050,r8051,r8052,r8053,r8054,r8055,r8056,r8057,r8058,r8059,r8060,r8061,r8062,r8063,r8064,r8065,r8066,r8067,r8068,r8069,r8070,r8071,r8072,r8073,r8074,r8075,r8076,r8077,r8078,r8079,r8080,r8081,r8082,r8083,r8084,r8085,r8086,r8087,r8088,r8089,r8090,r8091,r8092,r8093,r8094,r8095,r8096,r8097,r8098,r8099,r8100,r8101,r8102,r8103,r8104,r8105,r8106,r8107,r8108,r8109,r8110,r8111,r8112,r8113,r8114,r8115,r8116,r8117,r8118,r8119,r8120,r8121,r8122,r8123,r8124,r8125,r8126,r8127,r8128,r8129,r8130,r8131,r8132,r8133,r8134,r8135,r8136,r8137,r8138,r8139,r8140,r8141,r8142,r8143,r8144,r8145,r8146,r8147,r8148,r8149,r8150,r8151,r8152,r8153,r8154,r8155,r8156,r8157,r8158,r8159,r8160,r8161,r8162,r8163,r8164,r8165,r8166,r8167,r8168,r8169,r8170,r8171,r8172,r8173,r8174,r8175,r8176,r8177,r8178,r8179,r8180,r8181,r8182,r8183,r8184,r8185,r8186,r8187,r8188,r8189,r8190,r8191,r8192,r8193,r8194,r8195,r8196,r8197,r8198,r8199,r8200,r8201,r8202,r8203,r8204,r8205,r8206,r8207,r8208,r8209,r8210,r8211,r8212,r8213,r8214,r8215,r8216,r8217,r8218,r8219,r8220,r8221,r8222,r8223,r8224,r8225,r8226,r8227,r8228,r8229,r8230,r8231,r8232,r8233,r8234,r8235,r8236,r8237,r8238,r8239,r8240,r8241,r8242,r8243,r8244,r8245,r8246,r8247,r8248,r8249,r8250,r8251,r8252,r8253,r8254,r8255,r8256,r8257,r8258,r8259,r8260,r8261,r8262,r8263,r8264,r8265,r8266,r8267,r8268,r8269,r8270,r8271,r8272,r8273,r8274,r8275,r8276,r8277,r8278,r8279,r8280,r8281,r8282,r8283,r8284,r8285,r8286,r8287,r8288,r8289,r8290,r8291,r8292,r8293,r8294,r8295,r8296,r8297,r8298,r8299,r8300,r8301,r8302,r8303,r8304,r8305,r8306,r8307,r8308,r8309,r8310,r8311,r8312,r8313,r8314,r8315,r8316,r8317,r8318,r8319,r8320,r8321,r8322,r8323,r8324,r8325,r8326,r8327,r8328,r8329,r8330,r8331,r8332,r8333,r8334,r8335,r8336,r8337,r8338,r8339,r8340,r8341,r8342,r8343,r8344,r8345,r8346,r8347,r8348,r8349,r8350,r8351,r8352,r8353,r8354,r8355,r8356,r8357,r8358,r8359,r8360,r8361,r8362,r8363,r8364,r8365,r8366,r8367,r8368,r8369,r8370,r8371,r8372,r8373,r8374,r8375,r8376,r8377,r8378,r8379,r8380,r8381,r8382,r8383,r8384,r8385,r8386,r8387,r8388,r8389,r8390,r8391,r8392,r8393,r8394,r8395,r8396,r8397,r8398,r8399,r8400,r8401,r8402,r8403,r8404,r8405,r8406,r8407,r8408,r8409,r8410,r8411,r8412,r8413,r8414,r8415,r8416,r8417,r8418,r8419,r8420,r8421,r8422,r8423,r8424,r8425,r8426,r8427,r8428,r8429,r8430,r8431,r8432,r8433,r8434,r8435,r8436,r8437,r8438,r8439,r8440,r8441,r8442,r8443,r8444,r8445,r8446,r8447,r8448,r8449,r8450,r8451,r8452,r8453,r8454,r8455,r8456,r8457,r8458,r8459,r8460,r8461,r8462,r8463,r8464,r8465,r8466,r8467,r8468,r8469,r8470,r8471,r8472,r8473,r8474,r8475,r8476,r8477,r8478,r8479,r8480,r8481,r8482,r8483,r8484,r8485,r8486,r8487,r8488,r8489,r8490,r8491,r8492,r8493,r8494,r8495,r8496,r8497,r8498,r8499,r8500,r8501,r8502,r8503,r8504,r8505,r8506,r8507,r8508,r8509,r8510,r8511,r8512,r8513,r8514,r8515,r8516,r8517,r8518,r8519,r8520,r8521,r8522,r8523,r8524,r8525,r8526,r8527,r8528,r8529,r8530,r8531,r8532,r8533,r8534,r8535,r8536,r8537,r8538,r8539,r8540,r8541,r8542,r8543,r8544,r8545,r8546,r8547,r8548,r8549,r8550,r8551,r8552,r8553,r8554,r8555,r8556,r8557,r8558,r8559,r8560,r8561,r8562,r8563,r8564,r8565,r8566,r8567,r8568,r8569,r8570,r8571,r8572,r8573,r8574,r8575,r8576,r8577,r8578,r8579,r8580,r8581,r8582,r8583,r8584,r8585,r8586,r8587,r8588,r8589,r8590,r8591,r8592,r8593,r8594,r8595,r8596,r8597,r8598,r8599,r8600,r8601,r8602,r8603,r8604,r8605,r8606,r8607,r8608,r8609,r8610,r8611,r8612,r8613,r8614,r8615,r8616,r8617,r8618,r8619,r8620,r8621,r8622,r8623,r8624,r8625,r8626,r8627,r8628,r8629,r8630,r8631,r8632,r8633,r8634,r8635,r8636,r8637,r8638,r8639,r8640,r8641,r8642,r8643,r8644,r8645,r8646,r8647,r8648,r8649,r8650,r8651,r8652,r8653,r8654,r8655,r8656,r8657,r8658,r8659,r8660,r8661,r8662,r8663,r8664,r8665,r8666,r8667,r8668,r8669,r8670,r8671,r8672,r8673,r8674,r8675,r8676,r8677,r8678,r8679,r8680,r8681,r8682,r8683,r8684,r8685,r8686,r8687,r8688,r8689,r8690,r8691,r8692,r8693,r8694,r8695,r8696,r8697,r8698,r8699,r8700,r8701,r8702,r8703,r8704,r8705,r8706,r8707,r8708,r8709,r8710,r8711,r8712,r8713,r8714,r8715,r8716,r8717,r8718,r8719,r8720,r8721,r8722,r8723,r8724,r8725,r8726,r8727,r8728,r8729,r8730,r8731,r8732,r8733,r8734,r8735,r8736,r8737,r8738,r8739,r8740,r8741,r8742,r8743,r8744,r8745,r8746,r8747,r8748,r8749,r8750,r8751,r8752,r8753,r8754,r8755,r8756,r8757,r8758,r8759,r8760,r8761,r8762,r8763,r8764,r8765,r8766,r8767,r8768,r8769,r8770,r8771,r8772,r8773,r8774,r8775,r8776,r8777,r8778,r8779,r8780,r8781,r8782,r8783,r8784,r8785,r8786,r8787,r8788,r8789,r8790,r8791,r8792,r8793,r8794,r8795,r8796,r8797,r8798,r8799,r8800,r8801,r8802,r8803,r8804,r8805,r8806,r8807,r8808,r8809,r8810,r8811,r8812,r8813,r8814,r8815,r8816,r8817,r8818,r8819,r8820,r8821,r8822,r8823,r8824,r8825,r8826,r8827,r8828,r8829,r8830,r8831,r8832,r8833,r8834,r8835,r8836,r8837,r8838,r8839,r8840,r8841,r8842,r8843,r8844,r8845,r8846,r8847,r8848,r8849,r8850,r8851,r8852,r8853,r8854,r8855,r8856,r8857,r8858,r8859,r8860,r8861,r8862,r8863,r8864,r8865,r8866,r8867,r8868,r8869,r8870,r8871,r8872,r8873,r8874,r8875,r8876,r8877,r8878,r8879,r8880,r8881,r8882,r8883,r8884,r8885,r8886,r8887,r8888,r8889,r8890,r8891,r8892,r8893,r8894,r8895,r8896,r8897,r8898,r8899,r8900,r8901,r8902,r8903,r8904,r8905,r8906,r8907,r8908,r8909,r8910,r8911,r8912,r8913,r8914,r8915,r8916,r8917,r8918,r8919,r8920,r8921,r8922,r8923,r8924,r8925,r8926,r8927,r8928,r8929,r8930,r8931,r8932,r8933,r8934,r8935,r8936,r8937,r8938,r8939,r8940,r8941,r8942,r8943,r8944,r8945,r8946,r8947,r8948,r8949,r8950,r8951,r8952,r8953,r8954,r8955,r8956,r8957,r8958,r8959,r8960,r8961,r8962,r8963,r8964,r8965,r8966,r8967,r8968,r8969,r8970,r8971,r8972,r8973,r8974,r8975,r8976,r8977,r8978,r8979,r8980,r8981,r8982,r8983,r8984,r8985,r8986,r8987,r8988,r8989,r8990,r8991,r8992,r8993,r8994,r8995,r8996,r8997,r8998,r8999,r9000,r9001,r9002,r9003,r9004,r9005,r9006,r9007,r9008,r9009,r9010,r9011,r9012,r9013,r9014,r9015,r9016,r9017,r9018,r9019,r9020,r9021,r9022,r9023,r9024,r9025,r9026,r9027,r9028,r9029,r9030,r9031,r9032,r9033,r9034,r9035,r9036,r9037,r9038,r9039,r9040,r9041,r9042,r9043,r9044,r9045,r9046,r9047,r9048,r9049,r9050,r9051,r9052,r9053,r9054,r9055,r9056,r9057,r9058,r9059,r9060,r9061,r9062,r9063,r9064,r9065,r9066,r9067,r9068,r9069,r9070,r9071,r9072,r9073,r9074,r9075,r9076,r9077,r9078,r9079,r9080,r9081,r9082,r9083,r9084,r9085,r9086,r9087,r9088,r9089,r9090,r9091,r9092,r9093,r9094,r9095,r9096,r9097,r9098,r9099,r9100,r9101,r9102,r9103,r9104,r9105,r9106,r9107,r9108,r9109,r9110,r9111,r9112,r9113,r9114,r9115,r9116,r9117,r9118,r9119,r9120,r9121,r9122,r9123,r9124,r9125,r9126,r9127,r9128,r9129,r9130,r9131,r9132,r9133,r9134,r9135,r9136,r9137,r9138,r9139,r9140,r9141,r9142,r9143,r9144,r9145,r9146,r9147,r9148,r9149,r9150,r9151,r9152,r9153,r9154,r9155,r9156,r9157,r9158,r9159,r9160,r9161,r9162,r9163,r9164,r9165,r9166,r9167,r9168,r9169,r9170,r9171,r9172,r9173,r9174,r9175,r9176,r9177,r9178,r9179,r9180,r9181,r9182,r9183,r9184,r9185,r9186,r9187,r9188,r9189,r9190,r9191,r9192,r9193,r9194,r9195,r9196,r9197,r9198,r9199,r9200,r9201,r9202,r9203,r9204,r9205,r9206,r9207,r9208,r9209,r9210,r9211,r9212,r9213,r9214,r9215,r9216,r9217,r9218,r9219,r9220,r9221,r9222,r9223,r9224,r9225,r9226,r9227,r9228,r9229,r9230,r9231,r9232,r9233,r9234,r9235,r9236,r9237,r9238,r9239,r9240,r9241,r9242,r9243,r9244,r9245,r9246,r9247,r9248,r9249,r9250,r9251,r9252,r9253,r9254,r9255,r9256,r9257,r9258,r9259,r9260,r9261,r9262,r9263,r9264,r9265,r9266,r9267,r9268,r9269,r9270,r9271,r9272,r9273,r9274,r9275,r9276,r9277,r9278,r9279,r9280,r9281,r9282,r9283,r9284,r9285,r9286,r9287,r9288,r9289,r9290,r9291,r9292,r9293,r9294,r9295,r9296,r9297,r9298,r9299,r9300,r9301,r9302,r9303,r9304,r9305,r9306,r9307,r9308,r9309,r9310,r9311,r9312,r9313,r9314,r9315,r9316,r9317,r9318,r9319,r9320,r9321,r9322,r9323,r9324,r9325,r9326,r9327,r9328,r9329,r9330,r9331,r9332,r9333,r9334,r9335,r9336,r9337,r9338,r9339,r9340,r9341,r9342,r9343,r9344,r9345,r9346,r9347,r9348,r9349,r9350,r9351,r9352,r9353,r9354,r9355,r9356,r9357,r9358,r9359,r9360,r9361,r9362,r9363,r9364,r9365,r9366,r9367,r9368,r9369,r9370,r9371,r9372,r9373,r9374,r9375,r9376,r9377,r9378,r9379,r9380,r9381,r9382,r9383,r9384,r9385,r9386,r9387,r9388,r9389,r9390,r9391,r9392,r9393,r9394,r9395,r9396,r9397,r9398,r9399,r9400,r9401,r9402,r9403,r9404,r9405,r9406,r9407,r9408,r9409,r9410,r9411,r9412,r9413,r9414,r9415,r9416,r9417,r9418,r9419,r9420,r9421,r9422,r9423,r9424,r9425,r9426,r9427,r9428,r9429,r9430,r9431,r9432,r9433,r9434,r9435,r9436,r9437,r9438,r9439,r9440,r9441,r9442,r9443,r9444,r9445,r9446,r9447,r9448,r9449,r9450,r9451,r9452,r9453,r9454,r9455,r9456,r9457,r9458,r9459,r9460,r9461,r9462,r9463,r9464,r9465,r9466,r9467,r9468,r9469,r9470,r9471,r9472,r9473,r9474,r9475,r9476,r9477,r9478,r9479,r9480,r9481,r9482,r9483,r9484,r9485,r9486,r9487,r9488,r9489,r9490,r9491,r9492,r9493,r9494,r9495,r9496,r9497,r9498,r9499,r9500,r9501,r9502,r9503,r9504,r9505,r9506,r9507,r9508,r9509,r9510,r9511,r9512,r9513,r9514,r9515,r9516,r9517,r9518,r9519,r9520,r9521,r9522,r9523,r9524,r9525,r9526,r9527,r9528,r9529,r9530,r9531,r9532,r9533,r9534,r9535,r9536,r9537,r9538,r9539,r9540,r9541,r9542,r9543,r9544,r9545,r9546,r9547,r9548,r9549,r9550,r9551,r9552,r9553,r9554,r9555,r9556,r9557,r9558,r9559,r9560,r9561,r9562,r9563,r9564,r9565,r9566,r9567,r9568,r9569,r9570,r9571,r9572,r9573,r9574,r9575,r9576,r9577,r9578,r9579,r9580,r9581,r9582,r9583,r9584,r9585,r9586,r9587,r9588,r9589,r9590,r9591,r9592,r9593,r9594,r9595,r9596,r9597,r9598,r9599,r9600,r9601,r9602,r9603,r9604,r9605,r9606,r9607,r9608,r9609,r9610,r9611,r9612,r9613,r9614,r9615,r9616,r9617,r9618,r9619,r9620;r3=0;r4=STACKTOP;STACKTOP=STACKTOP+248|0;r5=r4;r6=r4+8;r7=r4+16;r8=r4+24;r9=r4+32;r10=r4+40;r11=r4+48;r12=r4+56;r13=r4+64;r14=r4+72;r15=r4+80;r16=r4+88;r17=r4+96;r18=r4+104;r19=r4+112;r20=r4+120;r21=r4+128;r22=r4+136;r23=r4+144;r24=r4+152;r25=r4+160;r26=r4+168;r27=r4+176;r28=r4+184;r29=r4+192;r30=r4+200;r31=r4+208;r32=r4+216;r33=r4+224;r34=r4+232;r35=r4+240;r36=r1+20|0;r37=HEAP32[r36>>2];r38=(r37|0)>0;if(!r38){r39=1;STACKTOP=r4;return r39}r40=r1+4|0;r41=r1+24|0;r42=r1+8|0;r43=r1+12|0;r44=r1+16|0;r45=r35;r46=r34;r47=r33;r48=r32;r49=r31;r50=r30;r51=r29;r52=r28;r53=r27;r54=r26;r55=r25;r56=r24;r57=r23;r58=r22;r59=r21;r60=r20;r61=r19;r62=r18;r63=r17;r64=r16;r65=r15;r66=r14;r67=r13;r68=r12;r69=r11;r70=r10;r71=r9;r72=r8;r73=r7;r74=r6;r75=r5;r76=r2;r77=0;L4:while(1){r78=HEAP32[r40>>2];r79=(r78|0)==0;r80=r79?64:r78;L6:do{switch(r80|0){case 4:{r81=HEAP32[r41>>2];r82=HEAP32[r42>>2];r83=HEAP32[r43>>2];r84=HEAP32[r44>>2];r85=4;r86=0;r87=__Znwj(48);r88=r87;__ZN9RCqsmodelC2Ebjjj(r88,0,31,16,1024);r89=r87;HEAP32[r35>>2]=r89;r90=__Znwj(12);r91=r90+4|0;r92=r91;HEAP32[r92>>2]=r81;r93=r90+8|0;r94=r93;HEAP32[r94>>2]=r35;r95=r82+1|0;r96=r83+1|0;r97=Math_imul(r96,r95)|0;r98=r97+r95|0;r99=r98;while(1){r100=r99+1|0;r101=r100&r99;r102=(r101|0)==0;r103=r100|r99;if(r102){break}else{r99=r103}}r104=_llvm_umul_with_overflow_i32(r100,8);r105=tempRet0;r106=r105;r107=r104;r108=r106?-1:r107;r109=__Znwj(r108);r110=r109;r111=r97;r112=0;while(1){r113=r112+1|0;r114=r112&r99;r115=r110+(r114<<3)|0;HEAPF64[r115>>3]=0;r116=r111-1|0;r117=(r116|0)==0;if(r117){break}else{r111=r116;r112=r113}}r118=(r84|0)==0;if(!r118){r119=(r83|0)==0;r120=(r82|0)==0;r121=r97;r122=0;r123=r76;while(1){r124=r95;r125=r121;while(1){r126=r125+1|0;r127=r125&r99;r128=r110+(r127<<3)|0;HEAPF64[r128>>3]=0;r129=r124-1|0;r130=(r129|0)==0;if(r130){break}else{r124=r129;r125=r126}}r131=r121+r95|0;if(r119){r132=r131;r133=r123}else{r134=r131;r135=0;r136=r123;while(1){r137=r134&r99;r138=r110+(r137<<3)|0;HEAPF64[r138>>3]=0;r139=r134+1|0;if(r120){r140=r139;r141=r136}else{r142=r139;r143=0;r144=r136;while(1){r145=r142-1|0;r146=r145&r99;r147=r110+(r146<<3)|0;r148=HEAPF64[r147>>3];r149=r147|0;r150=HEAP32[r149>>2];r151=r147+4|0;r152=HEAP32[r151>>2];r153=r142-r95|0;r154=r153-r97|0;r155=r154&r99;r156=r110+(r155<<3)|0;r157=HEAPF64[r156>>3];r158=r156|0;r159=HEAP32[r158>>2];r160=r156+4|0;r161=HEAP32[r160>>2];r162=r148-r157;r163=r153&r99;r164=r110+(r163<<3)|0;r165=HEAPF64[r164>>3];r166=r164|0;r167=HEAP32[r166>>2];r168=r164+4|0;r169=HEAP32[r168>>2];r170=r162+r165;r171=r145-r97|0;r172=r171&r99;r173=r110+(r172<<3)|0;r174=HEAPF64[r173>>3];r175=r173|0;r176=HEAP32[r175>>2];r177=r173+4|0;r178=HEAP32[r177>>2];r179=r170-r174;r180=r142-r97|0;r181=r180&r99;r182=r110+(r181<<3)|0;r183=HEAPF64[r182>>3];r184=r182|0;r185=HEAP32[r184>>2];r186=r182+4|0;r187=HEAP32[r186>>2];r188=r179+r183;r189=r145-r95|0;r190=r189&r99;r191=r110+(r190<<3)|0;r192=HEAPF64[r191>>3];r193=r191|0;r194=HEAP32[r193>>2];r195=r191+4|0;r196=HEAP32[r195>>2];r197=r188-r192;r198=r189-r97|0;r199=r198&r99;r200=r110+(r199<<3)|0;r201=HEAPF64[r200>>3];r202=r200|0;r203=HEAP32[r202>>2];r204=r200+4|0;r205=HEAP32[r204>>2];r206=r197+r201;HEAPF64[tempDoublePtr>>3]=r206;r207=HEAP32[tempDoublePtr>>2];r208=HEAP32[tempDoublePtr+4>>2];r209=r208>>>28|0<<4;r210=0>>>28|0<<4;r211=15;r212=0;r213=r209^r211;r214=r210^r212;r215=HEAP32[r92>>2];r216=HEAP32[r94>>2];r217=HEAP32[r216>>2];r218=__ZN9RCdecoder6decodeEP7RCmodel(r215,r217);r219=r213>>>3|r214<<29;r220=r214>>>3|0<<29;r221=0;r222=0;r223=_i64Subtract(r221,r222,r219,r220);r224=tempRet0;r225=r224>>>29|0<<3;r226=0>>>29|0<<3;r227=r225^r213;r228=r226^r214;r229=r218;r230=0;r231=-15;r232=-1;r233=_i64Add(r229,r230,r231,r232);r234=tempRet0;r235=_i64Add(r233,r234,r227,r228);r236=tempRet0;r237=r235>>>3|r236<<29;r238=r236>>>3|0<<29;r239=0;r240=0;r241=_i64Subtract(r239,r240,r237,r238);r242=tempRet0;r243=r242>>>29|0<<3;r244=0>>>29|0<<3;r245=r243^r235;r246=r244^r236;r247=0<<28|0>>>4;r248=r245<<28|0>>>4;r249=0;r250=-268435456;r251=r247^r249;r252=r248^r250;r253=(HEAP32[tempDoublePtr>>2]=r251,HEAP32[tempDoublePtr+4>>2]=r252,HEAPF64[tempDoublePtr>>3]);HEAPF64[r144>>3]=r253;r254=r142&r99;r255=r110+(r254<<3)|0;HEAPF64[r255>>3]=r253;r256=r144+8|0;r257=r142+1|0;r258=r143+1|0;r259=r258>>>0<r82>>>0;if(r259){r142=r257;r143=r258;r144=r256}else{r140=r257;r141=r256;break}}}r260=r135+1|0;r261=r260>>>0<r83>>>0;if(r261){r134=r140;r135=r260;r136=r141}else{r132=r140;r133=r141;break}}}r262=r122+1|0;r263=r262>>>0<r84>>>0;if(r263){r121=r132;r122=r262;r123=r133}else{break}}}r264=(r90|0)==0;if(!r264){_free(r90)}r265=HEAP32[r35>>2];r266=(r265|0)==0;if(!r266){r267=r265;r268=HEAP32[r267>>2];r269=r268+4|0;r270=HEAP32[r269>>2];FUNCTION_TABLE[r270](r265)}r271=(r109|0)==0;if(r271){break L6}_free(r109);break};case 6:{r272=HEAP32[r41>>2];r273=HEAP32[r42>>2];r274=HEAP32[r43>>2];r275=HEAP32[r44>>2];r276=4;r277=0;r278=__Znwj(48);r279=r278;__ZN9RCqsmodelC2Ebjjj(r279,0,127,16,1024);r280=r278;HEAP32[r34>>2]=r280;r281=__Znwj(12);r282=r281+4|0;r283=r282;HEAP32[r283>>2]=r272;r284=r281+8|0;r285=r284;HEAP32[r285>>2]=r34;r286=r273+1|0;r287=r274+1|0;r288=Math_imul(r287,r286)|0;r289=r288+r286|0;r290=r289;while(1){r291=r290+1|0;r292=r291&r290;r293=(r292|0)==0;r294=r291|r290;if(r293){break}else{r290=r294}}r295=_llvm_umul_with_overflow_i32(r291,8);r296=tempRet0;r297=r296;r298=r295;r299=r297?-1:r298;r300=__Znwj(r299);r301=r300;r302=r288;r303=0;while(1){r304=r303+1|0;r305=r303&r290;r306=r301+(r305<<3)|0;HEAPF64[r306>>3]=0;r307=r302-1|0;r308=(r307|0)==0;if(r308){break}else{r302=r307;r303=r304}}r309=(r275|0)==0;if(!r309){r310=(r274|0)==0;r311=(r273|0)==0;r312=r288;r313=0;r314=r76;while(1){r315=r286;r316=r312;while(1){r317=r316+1|0;r318=r316&r290;r319=r301+(r318<<3)|0;HEAPF64[r319>>3]=0;r320=r315-1|0;r321=(r320|0)==0;if(r321){break}else{r315=r320;r316=r317}}r322=r312+r286|0;if(r310){r323=r322;r324=r314}else{r325=r322;r326=0;r327=r314;while(1){r328=r325&r290;r329=r301+(r328<<3)|0;HEAPF64[r329>>3]=0;r330=r325+1|0;if(r311){r331=r330;r332=r327}else{r333=r330;r334=0;r335=r327;while(1){r336=r333-1|0;r337=r336&r290;r338=r301+(r337<<3)|0;r339=HEAPF64[r338>>3];r340=r338|0;r341=HEAP32[r340>>2];r342=r338+4|0;r343=HEAP32[r342>>2];r344=r333-r286|0;r345=r344-r288|0;r346=r345&r290;r347=r301+(r346<<3)|0;r348=HEAPF64[r347>>3];r349=r347|0;r350=HEAP32[r349>>2];r351=r347+4|0;r352=HEAP32[r351>>2];r353=r339-r348;r354=r344&r290;r355=r301+(r354<<3)|0;r356=HEAPF64[r355>>3];r357=r355|0;r358=HEAP32[r357>>2];r359=r355+4|0;r360=HEAP32[r359>>2];r361=r353+r356;r362=r336-r288|0;r363=r362&r290;r364=r301+(r363<<3)|0;r365=HEAPF64[r364>>3];r366=r364|0;r367=HEAP32[r366>>2];r368=r364+4|0;r369=HEAP32[r368>>2];r370=r361-r365;r371=r333-r288|0;r372=r371&r290;r373=r301+(r372<<3)|0;r374=HEAPF64[r373>>3];r375=r373|0;r376=HEAP32[r375>>2];r377=r373+4|0;r378=HEAP32[r377>>2];r379=r370+r374;r380=r336-r286|0;r381=r380&r290;r382=r301+(r381<<3)|0;r383=HEAPF64[r382>>3];r384=r382|0;r385=HEAP32[r384>>2];r386=r382+4|0;r387=HEAP32[r386>>2];r388=r379-r383;r389=r380-r288|0;r390=r389&r290;r391=r301+(r390<<3)|0;r392=HEAPF64[r391>>3];r393=r391|0;r394=HEAP32[r393>>2];r395=r391+4|0;r396=HEAP32[r395>>2];r397=r388+r392;HEAPF64[tempDoublePtr>>3]=r397;r398=HEAP32[tempDoublePtr>>2];r399=HEAP32[tempDoublePtr+4>>2];r400=r399>>>26|0<<6;r401=0>>>26|0<<6;r402=63;r403=0;r404=r400^r402;r405=r401^r403;r406=HEAP32[r283>>2];r407=HEAP32[r285>>2];r408=HEAP32[r407>>2];r409=__ZN9RCdecoder6decodeEP7RCmodel(r406,r408);r410=r404>>>5|r405<<27;r411=r405>>>5|0<<27;r412=0;r413=0;r414=_i64Subtract(r412,r413,r410,r411);r415=tempRet0;r416=r415>>>27|0<<5;r417=0>>>27|0<<5;r418=r416^r404;r419=r417^r405;r420=r409;r421=0;r422=-63;r423=-1;r424=_i64Add(r420,r421,r422,r423);r425=tempRet0;r426=_i64Add(r424,r425,r418,r419);r427=tempRet0;r428=r426>>>5|r427<<27;r429=r427>>>5|0<<27;r430=0;r431=0;r432=_i64Subtract(r430,r431,r428,r429);r433=tempRet0;r434=r433>>>27|0<<5;r435=0>>>27|0<<5;r436=r434^r426;r437=r435^r427;r438=0<<26|0>>>6;r439=r436<<26|0>>>6;r440=0;r441=-67108864;r442=r438^r440;r443=r439^r441;r444=(HEAP32[tempDoublePtr>>2]=r442,HEAP32[tempDoublePtr+4>>2]=r443,HEAPF64[tempDoublePtr>>3]);HEAPF64[r335>>3]=r444;r445=r333&r290;r446=r301+(r445<<3)|0;HEAPF64[r446>>3]=r444;r447=r335+8|0;r448=r333+1|0;r449=r334+1|0;r450=r449>>>0<r273>>>0;if(r450){r333=r448;r334=r449;r335=r447}else{r331=r448;r332=r447;break}}}r451=r326+1|0;r452=r451>>>0<r274>>>0;if(r452){r325=r331;r326=r451;r327=r332}else{r323=r331;r324=r332;break}}}r453=r313+1|0;r454=r453>>>0<r275>>>0;if(r454){r312=r323;r313=r453;r314=r324}else{break}}}r455=(r281|0)==0;if(!r455){_free(r281)}r456=HEAP32[r34>>2];r457=(r456|0)==0;if(!r457){r458=r456;r459=HEAP32[r458>>2];r460=r459+4|0;r461=HEAP32[r460>>2];FUNCTION_TABLE[r461](r456)}r462=(r300|0)==0;if(r462){break L6}_free(r300);break};case 8:{r463=HEAP32[r41>>2];r464=HEAP32[r42>>2];r465=HEAP32[r43>>2];r466=HEAP32[r44>>2];r467=4;r468=0;r469=__Znwj(48);r470=r469;__ZN9RCqsmodelC2Ebjjj(r470,0,511,16,1024);r471=r469;HEAP32[r33>>2]=r471;r472=__Znwj(12);r473=r472+4|0;r474=r473;HEAP32[r474>>2]=r463;r475=r472+8|0;r476=r475;HEAP32[r476>>2]=r33;r477=r464+1|0;r478=r465+1|0;r479=Math_imul(r478,r477)|0;r480=r479+r477|0;r481=r480;while(1){r482=r481+1|0;r483=r482&r481;r484=(r483|0)==0;r485=r482|r481;if(r484){break}else{r481=r485}}r486=_llvm_umul_with_overflow_i32(r482,8);r487=tempRet0;r488=r487;r489=r486;r490=r488?-1:r489;r491=__Znwj(r490);r492=r491;r493=r479;r494=0;while(1){r495=r494+1|0;r496=r494&r481;r497=r492+(r496<<3)|0;HEAPF64[r497>>3]=0;r498=r493-1|0;r499=(r498|0)==0;if(r499){break}else{r493=r498;r494=r495}}r500=(r466|0)==0;if(!r500){r501=(r465|0)==0;r502=(r464|0)==0;r503=r479;r504=0;r505=r76;while(1){r506=r477;r507=r503;while(1){r508=r507+1|0;r509=r507&r481;r510=r492+(r509<<3)|0;HEAPF64[r510>>3]=0;r511=r506-1|0;r512=(r511|0)==0;if(r512){break}else{r506=r511;r507=r508}}r513=r503+r477|0;if(r501){r514=r513;r515=r505}else{r516=r513;r517=0;r518=r505;while(1){r519=r516&r481;r520=r492+(r519<<3)|0;HEAPF64[r520>>3]=0;r521=r516+1|0;if(r502){r522=r521;r523=r518}else{r524=r521;r525=0;r526=r518;while(1){r527=r524-1|0;r528=r527&r481;r529=r492+(r528<<3)|0;r530=HEAPF64[r529>>3];r531=r529|0;r532=HEAP32[r531>>2];r533=r529+4|0;r534=HEAP32[r533>>2];r535=r524-r477|0;r536=r535-r479|0;r537=r536&r481;r538=r492+(r537<<3)|0;r539=HEAPF64[r538>>3];r540=r538|0;r541=HEAP32[r540>>2];r542=r538+4|0;r543=HEAP32[r542>>2];r544=r530-r539;r545=r535&r481;r546=r492+(r545<<3)|0;r547=HEAPF64[r546>>3];r548=r546|0;r549=HEAP32[r548>>2];r550=r546+4|0;r551=HEAP32[r550>>2];r552=r544+r547;r553=r527-r479|0;r554=r553&r481;r555=r492+(r554<<3)|0;r556=HEAPF64[r555>>3];r557=r555|0;r558=HEAP32[r557>>2];r559=r555+4|0;r560=HEAP32[r559>>2];r561=r552-r556;r562=r524-r479|0;r563=r562&r481;r564=r492+(r563<<3)|0;r565=HEAPF64[r564>>3];r566=r564|0;r567=HEAP32[r566>>2];r568=r564+4|0;r569=HEAP32[r568>>2];r570=r561+r565;r571=r527-r477|0;r572=r571&r481;r573=r492+(r572<<3)|0;r574=HEAPF64[r573>>3];r575=r573|0;r576=HEAP32[r575>>2];r577=r573+4|0;r578=HEAP32[r577>>2];r579=r570-r574;r580=r571-r479|0;r581=r580&r481;r582=r492+(r581<<3)|0;r583=HEAPF64[r582>>3];r584=r582|0;r585=HEAP32[r584>>2];r586=r582+4|0;r587=HEAP32[r586>>2];r588=r579+r583;HEAPF64[tempDoublePtr>>3]=r588;r589=HEAP32[tempDoublePtr>>2];r590=HEAP32[tempDoublePtr+4>>2];r591=r590>>>24|0<<8;r592=0>>>24|0<<8;r593=255;r594=0;r595=r591^r593;r596=r592^r594;r597=HEAP32[r474>>2];r598=HEAP32[r476>>2];r599=HEAP32[r598>>2];r600=__ZN9RCdecoder6decodeEP7RCmodel(r597,r599);r601=r595>>>7|r596<<25;r602=r596>>>7|0<<25;r603=0;r604=0;r605=_i64Subtract(r603,r604,r601,r602);r606=tempRet0;r607=r606>>>25|0<<7;r608=0>>>25|0<<7;r609=r607^r595;r610=r608^r596;r611=r600;r612=0;r613=-255;r614=-1;r615=_i64Add(r611,r612,r613,r614);r616=tempRet0;r617=_i64Add(r615,r616,r609,r610);r618=tempRet0;r619=r617>>>7|r618<<25;r620=r618>>>7|0<<25;r621=0;r622=0;r623=_i64Subtract(r621,r622,r619,r620);r624=tempRet0;r625=r624>>>25|0<<7;r626=0>>>25|0<<7;r627=r625^r617;r628=r626^r618;r629=0<<24|0>>>8;r630=r627<<24|0>>>8;r631=0;r632=-16777216;r633=r629^r631;r634=r630^r632;r635=(HEAP32[tempDoublePtr>>2]=r633,HEAP32[tempDoublePtr+4>>2]=r634,HEAPF64[tempDoublePtr>>3]);HEAPF64[r526>>3]=r635;r636=r524&r481;r637=r492+(r636<<3)|0;HEAPF64[r637>>3]=r635;r638=r526+8|0;r639=r524+1|0;r640=r525+1|0;r641=r640>>>0<r464>>>0;if(r641){r524=r639;r525=r640;r526=r638}else{r522=r639;r523=r638;break}}}r642=r517+1|0;r643=r642>>>0<r465>>>0;if(r643){r516=r522;r517=r642;r518=r523}else{r514=r522;r515=r523;break}}}r644=r504+1|0;r645=r644>>>0<r466>>>0;if(r645){r503=r514;r504=r644;r505=r515}else{break}}}r646=(r472|0)==0;if(!r646){_free(r472)}r647=HEAP32[r33>>2];r648=(r647|0)==0;if(!r648){r649=r647;r650=HEAP32[r649>>2];r651=r650+4|0;r652=HEAP32[r651>>2];FUNCTION_TABLE[r652](r647)}r653=(r491|0)==0;if(r653){break L6}_free(r491);break};case 10:{r654=HEAP32[r41>>2];r655=HEAP32[r42>>2];r656=HEAP32[r43>>2];r657=HEAP32[r44>>2];r658=4;r659=0;r660=__Znwj(48);r661=r660;__ZN9RCqsmodelC2Ebjjj(r661,0,21,16,1024);r662=r660;HEAP32[r32>>2]=r662;r663=__Znwj(12);r664=r663+4|0;r665=r664;HEAP32[r665>>2]=r654;r666=r663+8|0;r667=r666;HEAP32[r667>>2]=r32;r668=r655+1|0;r669=r656+1|0;r670=Math_imul(r669,r668)|0;r671=r670+r668|0;r672=r671;while(1){r673=r672+1|0;r674=r673&r672;r675=(r674|0)==0;r676=r673|r672;if(r675){break}else{r672=r676}}r677=_llvm_umul_with_overflow_i32(r673,8);r678=tempRet0;r679=r678;r680=r677;r681=r679?-1:r680;r682=__Znwj(r681);r683=r682;r684=r670;r685=0;while(1){r686=r685+1|0;r687=r685&r672;r688=r683+(r687<<3)|0;HEAPF64[r688>>3]=0;r689=r684-1|0;r690=(r689|0)==0;if(r690){break}else{r684=r689;r685=r686}}r691=(r657|0)==0;if(!r691){r692=(r656|0)==0;r693=(r655|0)==0;r694=r670;r695=0;r696=r76;while(1){r697=r668;r698=r694;while(1){r699=r698+1|0;r700=r698&r672;r701=r683+(r700<<3)|0;HEAPF64[r701>>3]=0;r702=r697-1|0;r703=(r702|0)==0;if(r703){break}else{r697=r702;r698=r699}}r704=r694+r668|0;if(r692){r705=r704;r706=r696}else{r707=r704;r708=0;r709=r696;while(1){r710=r707&r672;r711=r683+(r710<<3)|0;HEAPF64[r711>>3]=0;r712=r707+1|0;if(r693){r713=r712;r714=r709}else{r715=r712;r716=0;r717=r709;while(1){r718=r715-1|0;r719=r718&r672;r720=r683+(r719<<3)|0;r721=HEAPF64[r720>>3];r722=r720|0;r723=HEAP32[r722>>2];r724=r720+4|0;r725=HEAP32[r724>>2];r726=r715-r668|0;r727=r726-r670|0;r728=r727&r672;r729=r683+(r728<<3)|0;r730=HEAPF64[r729>>3];r731=r729|0;r732=HEAP32[r731>>2];r733=r729+4|0;r734=HEAP32[r733>>2];r735=r721-r730;r736=r726&r672;r737=r683+(r736<<3)|0;r738=HEAPF64[r737>>3];r739=r737|0;r740=HEAP32[r739>>2];r741=r737+4|0;r742=HEAP32[r741>>2];r743=r735+r738;r744=r718-r670|0;r745=r744&r672;r746=r683+(r745<<3)|0;r747=HEAPF64[r746>>3];r748=r746|0;r749=HEAP32[r748>>2];r750=r746+4|0;r751=HEAP32[r750>>2];r752=r743-r747;r753=r715-r670|0;r754=r753&r672;r755=r683+(r754<<3)|0;r756=HEAPF64[r755>>3];r757=r755|0;r758=HEAP32[r757>>2];r759=r755+4|0;r760=HEAP32[r759>>2];r761=r752+r756;r762=r718-r668|0;r763=r762&r672;r764=r683+(r763<<3)|0;r765=HEAPF64[r764>>3];r766=r764|0;r767=HEAP32[r766>>2];r768=r764+4|0;r769=HEAP32[r768>>2];r770=r761-r765;r771=r762-r670|0;r772=r771&r672;r773=r683+(r772<<3)|0;r774=HEAPF64[r773>>3];r775=r773|0;r776=HEAP32[r775>>2];r777=r773+4|0;r778=HEAP32[r777>>2];r779=r770+r774;r780=HEAP32[r665>>2];r781=HEAP32[r667>>2];r782=HEAP32[r781>>2];r783=__ZN9RCdecoder6decodeEP7RCmodel(r780,r782);r784=r783>>>0>10;do{if(r784){r785=r783-11|0;r786=r785;r787=0;r788=1;r789=0;r790=_bitshift64Shl(r788,r789,r786);r791=tempRet0;r792=HEAP32[r665>>2];r793=r785>>>0>16;do{if(r793){r794=__ZN9RCdecoder12decode_shiftEj(r792,16);r795=r794;r796=0;r797=r783-27|0;r798=r797>>>0>16;if(!r798){r799=0;r800=16;r801=r796;r802=r795;r803=r797;break}r804=__ZN9RCdecoder12decode_shiftEj(r792,16);r805=r804;r806=0;r807=r805<<16|0>>>16;r808=r806<<16|r805>>>16;r809=_i64Add(r807,r808,r795,r796);r810=tempRet0;r811=r783-43|0;r812=r811>>>0>16;if(!r812){r799=0;r800=32;r801=r810;r802=r809;r803=r811;break}r813=__ZN9RCdecoder12decode_shiftEj(r792,16);r814=r813;r815=0;r816=0;r817=r814;r818=_i64Add(r816,r817,r809,r810);r819=tempRet0;r820=r783-59|0;r799=0;r800=48;r801=r819;r802=r818;r803=r820}else{r799=0;r800=0;r801=0;r802=0;r803=r785}}while(0);r821=__ZN9RCdecoder12decode_shiftEj(r792,r803);r822=r821;r823=0;r824=_bitshift64Shl(r822,r823,r800);r825=tempRet0;HEAPF64[tempDoublePtr>>3]=r779;r826=HEAP32[tempDoublePtr>>2];r827=HEAP32[tempDoublePtr+4>>2];r828=r827>>>22|0<<10;r829=0>>>22|0<<10;r830=1023;r831=0;r832=r828^r830;r833=r829^r831;r834=r832>>>9|r833<<23;r835=r833>>>9|0<<23;r836=0;r837=0;r838=_i64Subtract(r836,r837,r834,r835);r839=tempRet0;r840=r839>>>23|0<<9;r841=0>>>23|0<<9;r842=r840^r832;r843=r841^r833;r844=_i64Add(r790,r791,r842,r843);r845=tempRet0;r846=_i64Add(r844,r845,r802,r801);r847=tempRet0;r848=_i64Add(r846,r847,r824,r825);r849=tempRet0;r850=r848>>>9|r849<<23;r851=r849>>>9|0<<23;r852=0;r853=0;r854=_i64Subtract(r852,r853,r850,r851);r855=tempRet0;r856=r855>>>23|0<<9;r857=0>>>23|0<<9;r858=r856^r848;r859=r857^r849;r860=0<<22|0>>>10;r861=r858<<22|0>>>10;r862=0;r863=-4194304;r864=r860^r862;r865=r861^r863;r866=r865;r867=r864}else{r868=r783>>>0<10;if(!r868){HEAPF64[tempDoublePtr>>3]=r779;r869=HEAP32[tempDoublePtr>>2];r870=HEAP32[tempDoublePtr+4>>2];r871=0;r872=-4194304;r873=r869&r871;r874=r870&r872;r866=r874;r867=r873;break}r875=9-r783|0;r876=r875;r877=0;r878=HEAP32[r665>>2];r879=r875>>>0>16;do{if(r879){r880=__ZN9RCdecoder12decode_shiftEj(r878,16);r881=r880;r882=0;r883=r875-16|0;r884=r883>>>0>16;if(!r884){r885=0;r886=16;r887=r882;r888=r881;r889=r883;break}r890=__ZN9RCdecoder12decode_shiftEj(r878,16);r891=r890;r892=0;r893=r891<<16|0>>>16;r894=r892<<16|r891>>>16;r895=_i64Add(r893,r894,r881,r882);r896=tempRet0;r897=r875-32|0;r898=r897>>>0>16;if(!r898){r885=0;r886=32;r887=r896;r888=r895;r889=r897;break}r899=__ZN9RCdecoder12decode_shiftEj(r878,16);r900=r899;r901=0;r902=0;r903=r900;r904=_i64Add(r902,r903,r895,r896);r905=tempRet0;r906=r875-48|0;r885=0;r886=48;r887=r905;r888=r904;r889=r906}else{r885=0;r886=0;r887=0;r888=0;r889=r875}}while(0);r907=__ZN9RCdecoder12decode_shiftEj(r878,r889);r908=r907;r909=0;r910=_bitshift64Shl(r908,r909,r886);r911=tempRet0;HEAPF64[tempDoublePtr>>3]=r779;r912=HEAP32[tempDoublePtr>>2];r913=HEAP32[tempDoublePtr+4>>2];r914=r913>>>22|0<<10;r915=0>>>22|0<<10;r916=1023;r917=0;r918=r914^r916;r919=r915^r917;r920=r918>>>9|r919<<23;r921=r919>>>9|0<<23;r922=0;r923=0;r924=_i64Subtract(r922,r923,r920,r921);r925=tempRet0;r926=r925>>>23|0<<9;r927=0>>>23|0<<9;r928=r926^r918;r929=r927^r919;r930=-1;r931=-1;r932=_bitshift64Shl(r930,r931,r876);r933=tempRet0;r934=_i64Add(r932,r933,r928,r929);r935=tempRet0;r936=_i64Subtract(r934,r935,r888,r887);r937=tempRet0;r938=_i64Subtract(r936,r937,r910,r911);r939=tempRet0;r940=r938>>>9|r939<<23;r941=r939>>>9|0<<23;r942=0;r943=0;r944=_i64Subtract(r942,r943,r940,r941);r945=tempRet0;r946=r945>>>23|0<<9;r947=0>>>23|0<<9;r948=r946^r938;r949=r947^r939;r950=0<<22|0>>>10;r951=r948<<22|0>>>10;r952=0;r953=-4194304;r954=r950^r952;r955=r951^r953;r866=r955;r867=r954}}while(0);r956=(HEAP32[tempDoublePtr>>2]=r867,HEAP32[tempDoublePtr+4>>2]=r866,HEAPF64[tempDoublePtr>>3]);HEAPF64[r717>>3]=r956;r957=r715&r672;r958=r683+(r957<<3)|0;HEAPF64[r958>>3]=r956;r959=r717+8|0;r960=r715+1|0;r961=r716+1|0;r962=r961>>>0<r655>>>0;if(r962){r715=r960;r716=r961;r717=r959}else{r713=r960;r714=r959;break}}}r963=r708+1|0;r964=r963>>>0<r656>>>0;if(r964){r707=r713;r708=r963;r709=r714}else{r705=r713;r706=r714;break}}}r965=r695+1|0;r966=r965>>>0<r657>>>0;if(r966){r694=r705;r695=r965;r696=r706}else{break}}}r967=(r663|0)==0;if(!r967){_free(r663)}r968=HEAP32[r32>>2];r969=(r968|0)==0;if(!r969){r970=r968;r971=HEAP32[r970>>2];r972=r971+4|0;r973=HEAP32[r972>>2];FUNCTION_TABLE[r973](r968)}r974=(r682|0)==0;if(r974){break L6}_free(r682);break};case 12:{r975=HEAP32[r41>>2];r976=HEAP32[r42>>2];r977=HEAP32[r43>>2];r978=HEAP32[r44>>2];r979=4;r980=0;r981=__Znwj(48);r982=r981;__ZN9RCqsmodelC2Ebjjj(r982,0,25,16,1024);r983=r981;HEAP32[r31>>2]=r983;r984=__Znwj(12);r985=r984+4|0;r986=r985;HEAP32[r986>>2]=r975;r987=r984+8|0;r988=r987;HEAP32[r988>>2]=r31;r989=r976+1|0;r990=r977+1|0;r991=Math_imul(r990,r989)|0;r992=r991+r989|0;r993=r992;while(1){r994=r993+1|0;r995=r994&r993;r996=(r995|0)==0;r997=r994|r993;if(r996){break}else{r993=r997}}r998=_llvm_umul_with_overflow_i32(r994,8);r999=tempRet0;r1000=r999;r1001=r998;r1002=r1000?-1:r1001;r1003=__Znwj(r1002);r1004=r1003;r1005=r991;r1006=0;while(1){r1007=r1006+1|0;r1008=r1006&r993;r1009=r1004+(r1008<<3)|0;HEAPF64[r1009>>3]=0;r1010=r1005-1|0;r1011=(r1010|0)==0;if(r1011){break}else{r1005=r1010;r1006=r1007}}r1012=(r978|0)==0;if(!r1012){r1013=(r977|0)==0;r1014=(r976|0)==0;r1015=r991;r1016=0;r1017=r76;while(1){r1018=r989;r1019=r1015;while(1){r1020=r1019+1|0;r1021=r1019&r993;r1022=r1004+(r1021<<3)|0;HEAPF64[r1022>>3]=0;r1023=r1018-1|0;r1024=(r1023|0)==0;if(r1024){break}else{r1018=r1023;r1019=r1020}}r1025=r1015+r989|0;if(r1013){r1026=r1025;r1027=r1017}else{r1028=r1025;r1029=0;r1030=r1017;while(1){r1031=r1028&r993;r1032=r1004+(r1031<<3)|0;HEAPF64[r1032>>3]=0;r1033=r1028+1|0;if(r1014){r1034=r1033;r1035=r1030}else{r1036=r1033;r1037=0;r1038=r1030;while(1){r1039=r1036-1|0;r1040=r1039&r993;r1041=r1004+(r1040<<3)|0;r1042=HEAPF64[r1041>>3];r1043=r1041|0;r1044=HEAP32[r1043>>2];r1045=r1041+4|0;r1046=HEAP32[r1045>>2];r1047=r1036-r989|0;r1048=r1047-r991|0;r1049=r1048&r993;r1050=r1004+(r1049<<3)|0;r1051=HEAPF64[r1050>>3];r1052=r1050|0;r1053=HEAP32[r1052>>2];r1054=r1050+4|0;r1055=HEAP32[r1054>>2];r1056=r1042-r1051;r1057=r1047&r993;r1058=r1004+(r1057<<3)|0;r1059=HEAPF64[r1058>>3];r1060=r1058|0;r1061=HEAP32[r1060>>2];r1062=r1058+4|0;r1063=HEAP32[r1062>>2];r1064=r1056+r1059;r1065=r1039-r991|0;r1066=r1065&r993;r1067=r1004+(r1066<<3)|0;r1068=HEAPF64[r1067>>3];r1069=r1067|0;r1070=HEAP32[r1069>>2];r1071=r1067+4|0;r1072=HEAP32[r1071>>2];r1073=r1064-r1068;r1074=r1036-r991|0;r1075=r1074&r993;r1076=r1004+(r1075<<3)|0;r1077=HEAPF64[r1076>>3];r1078=r1076|0;r1079=HEAP32[r1078>>2];r1080=r1076+4|0;r1081=HEAP32[r1080>>2];r1082=r1073+r1077;r1083=r1039-r989|0;r1084=r1083&r993;r1085=r1004+(r1084<<3)|0;r1086=HEAPF64[r1085>>3];r1087=r1085|0;r1088=HEAP32[r1087>>2];r1089=r1085+4|0;r1090=HEAP32[r1089>>2];r1091=r1082-r1086;r1092=r1083-r991|0;r1093=r1092&r993;r1094=r1004+(r1093<<3)|0;r1095=HEAPF64[r1094>>3];r1096=r1094|0;r1097=HEAP32[r1096>>2];r1098=r1094+4|0;r1099=HEAP32[r1098>>2];r1100=r1091+r1095;r1101=HEAP32[r986>>2];r1102=HEAP32[r988>>2];r1103=HEAP32[r1102>>2];r1104=__ZN9RCdecoder6decodeEP7RCmodel(r1101,r1103);r1105=r1104>>>0>12;do{if(r1105){r1106=r1104-13|0;r1107=r1106;r1108=0;r1109=1;r1110=0;r1111=_bitshift64Shl(r1109,r1110,r1107);r1112=tempRet0;r1113=HEAP32[r986>>2];r1114=r1106>>>0>16;do{if(r1114){r1115=__ZN9RCdecoder12decode_shiftEj(r1113,16);r1116=r1115;r1117=0;r1118=r1104-29|0;r1119=r1118>>>0>16;if(!r1119){r1120=0;r1121=16;r1122=r1117;r1123=r1116;r1124=r1118;break}r1125=__ZN9RCdecoder12decode_shiftEj(r1113,16);r1126=r1125;r1127=0;r1128=r1126<<16|0>>>16;r1129=r1127<<16|r1126>>>16;r1130=_i64Add(r1128,r1129,r1116,r1117);r1131=tempRet0;r1132=r1104-45|0;r1133=r1132>>>0>16;if(!r1133){r1120=0;r1121=32;r1122=r1131;r1123=r1130;r1124=r1132;break}r1134=__ZN9RCdecoder12decode_shiftEj(r1113,16);r1135=r1134;r1136=0;r1137=0;r1138=r1135;r1139=_i64Add(r1137,r1138,r1130,r1131);r1140=tempRet0;r1141=r1104-61|0;r1120=0;r1121=48;r1122=r1140;r1123=r1139;r1124=r1141}else{r1120=0;r1121=0;r1122=0;r1123=0;r1124=r1106}}while(0);r1142=__ZN9RCdecoder12decode_shiftEj(r1113,r1124);r1143=r1142;r1144=0;r1145=_bitshift64Shl(r1143,r1144,r1121);r1146=tempRet0;HEAPF64[tempDoublePtr>>3]=r1100;r1147=HEAP32[tempDoublePtr>>2];r1148=HEAP32[tempDoublePtr+4>>2];r1149=r1148>>>20|0<<12;r1150=0>>>20|0<<12;r1151=4095;r1152=0;r1153=r1149^r1151;r1154=r1150^r1152;r1155=r1153>>>11|r1154<<21;r1156=r1154>>>11|0<<21;r1157=0;r1158=0;r1159=_i64Subtract(r1157,r1158,r1155,r1156);r1160=tempRet0;r1161=r1160>>>21|0<<11;r1162=0>>>21|0<<11;r1163=r1161^r1153;r1164=r1162^r1154;r1165=_i64Add(r1111,r1112,r1163,r1164);r1166=tempRet0;r1167=_i64Add(r1165,r1166,r1123,r1122);r1168=tempRet0;r1169=_i64Add(r1167,r1168,r1145,r1146);r1170=tempRet0;r1171=r1169>>>11|r1170<<21;r1172=r1170>>>11|0<<21;r1173=0;r1174=0;r1175=_i64Subtract(r1173,r1174,r1171,r1172);r1176=tempRet0;r1177=r1176>>>21|0<<11;r1178=0>>>21|0<<11;r1179=r1177^r1169;r1180=r1178^r1170;r1181=0<<20|0>>>12;r1182=r1179<<20|0>>>12;r1183=0;r1184=-1048576;r1185=r1181^r1183;r1186=r1182^r1184;r1187=r1186;r1188=r1185}else{r1189=r1104>>>0<12;if(!r1189){HEAPF64[tempDoublePtr>>3]=r1100;r1190=HEAP32[tempDoublePtr>>2];r1191=HEAP32[tempDoublePtr+4>>2];r1192=0;r1193=-1048576;r1194=r1190&r1192;r1195=r1191&r1193;r1187=r1195;r1188=r1194;break}r1196=11-r1104|0;r1197=r1196;r1198=0;r1199=HEAP32[r986>>2];r1200=r1196>>>0>16;do{if(r1200){r1201=__ZN9RCdecoder12decode_shiftEj(r1199,16);r1202=r1201;r1203=0;r1204=r1196-16|0;r1205=r1204>>>0>16;if(!r1205){r1206=0;r1207=16;r1208=r1203;r1209=r1202;r1210=r1204;break}r1211=__ZN9RCdecoder12decode_shiftEj(r1199,16);r1212=r1211;r1213=0;r1214=r1212<<16|0>>>16;r1215=r1213<<16|r1212>>>16;r1216=_i64Add(r1214,r1215,r1202,r1203);r1217=tempRet0;r1218=r1196-32|0;r1219=r1218>>>0>16;if(!r1219){r1206=0;r1207=32;r1208=r1217;r1209=r1216;r1210=r1218;break}r1220=__ZN9RCdecoder12decode_shiftEj(r1199,16);r1221=r1220;r1222=0;r1223=0;r1224=r1221;r1225=_i64Add(r1223,r1224,r1216,r1217);r1226=tempRet0;r1227=r1196-48|0;r1206=0;r1207=48;r1208=r1226;r1209=r1225;r1210=r1227}else{r1206=0;r1207=0;r1208=0;r1209=0;r1210=r1196}}while(0);r1228=__ZN9RCdecoder12decode_shiftEj(r1199,r1210);r1229=r1228;r1230=0;r1231=_bitshift64Shl(r1229,r1230,r1207);r1232=tempRet0;HEAPF64[tempDoublePtr>>3]=r1100;r1233=HEAP32[tempDoublePtr>>2];r1234=HEAP32[tempDoublePtr+4>>2];r1235=r1234>>>20|0<<12;r1236=0>>>20|0<<12;r1237=4095;r1238=0;r1239=r1235^r1237;r1240=r1236^r1238;r1241=r1239>>>11|r1240<<21;r1242=r1240>>>11|0<<21;r1243=0;r1244=0;r1245=_i64Subtract(r1243,r1244,r1241,r1242);r1246=tempRet0;r1247=r1246>>>21|0<<11;r1248=0>>>21|0<<11;r1249=r1247^r1239;r1250=r1248^r1240;r1251=-1;r1252=-1;r1253=_bitshift64Shl(r1251,r1252,r1197);r1254=tempRet0;r1255=_i64Add(r1253,r1254,r1249,r1250);r1256=tempRet0;r1257=_i64Subtract(r1255,r1256,r1209,r1208);r1258=tempRet0;r1259=_i64Subtract(r1257,r1258,r1231,r1232);r1260=tempRet0;r1261=r1259>>>11|r1260<<21;r1262=r1260>>>11|0<<21;r1263=0;r1264=0;r1265=_i64Subtract(r1263,r1264,r1261,r1262);r1266=tempRet0;r1267=r1266>>>21|0<<11;r1268=0>>>21|0<<11;r1269=r1267^r1259;r1270=r1268^r1260;r1271=0<<20|0>>>12;r1272=r1269<<20|0>>>12;r1273=0;r1274=-1048576;r1275=r1271^r1273;r1276=r1272^r1274;r1187=r1276;r1188=r1275}}while(0);r1277=(HEAP32[tempDoublePtr>>2]=r1188,HEAP32[tempDoublePtr+4>>2]=r1187,HEAPF64[tempDoublePtr>>3]);HEAPF64[r1038>>3]=r1277;r1278=r1036&r993;r1279=r1004+(r1278<<3)|0;HEAPF64[r1279>>3]=r1277;r1280=r1038+8|0;r1281=r1036+1|0;r1282=r1037+1|0;r1283=r1282>>>0<r976>>>0;if(r1283){r1036=r1281;r1037=r1282;r1038=r1280}else{r1034=r1281;r1035=r1280;break}}}r1284=r1029+1|0;r1285=r1284>>>0<r977>>>0;if(r1285){r1028=r1034;r1029=r1284;r1030=r1035}else{r1026=r1034;r1027=r1035;break}}}r1286=r1016+1|0;r1287=r1286>>>0<r978>>>0;if(r1287){r1015=r1026;r1016=r1286;r1017=r1027}else{break}}}r1288=(r984|0)==0;if(!r1288){_free(r984)}r1289=HEAP32[r31>>2];r1290=(r1289|0)==0;if(!r1290){r1291=r1289;r1292=HEAP32[r1291>>2];r1293=r1292+4|0;r1294=HEAP32[r1293>>2];FUNCTION_TABLE[r1294](r1289)}r1295=(r1003|0)==0;if(r1295){break L6}_free(r1003);break};case 14:{r1296=HEAP32[r41>>2];r1297=HEAP32[r42>>2];r1298=HEAP32[r43>>2];r1299=HEAP32[r44>>2];r1300=4;r1301=0;r1302=__Znwj(48);r1303=r1302;__ZN9RCqsmodelC2Ebjjj(r1303,0,29,16,1024);r1304=r1302;HEAP32[r30>>2]=r1304;r1305=__Znwj(12);r1306=r1305+4|0;r1307=r1306;HEAP32[r1307>>2]=r1296;r1308=r1305+8|0;r1309=r1308;HEAP32[r1309>>2]=r30;r1310=r1297+1|0;r1311=r1298+1|0;r1312=Math_imul(r1311,r1310)|0;r1313=r1312+r1310|0;r1314=r1313;while(1){r1315=r1314+1|0;r1316=r1315&r1314;r1317=(r1316|0)==0;r1318=r1315|r1314;if(r1317){break}else{r1314=r1318}}r1319=_llvm_umul_with_overflow_i32(r1315,8);r1320=tempRet0;r1321=r1320;r1322=r1319;r1323=r1321?-1:r1322;r1324=__Znwj(r1323);r1325=r1324;r1326=r1312;r1327=0;while(1){r1328=r1327+1|0;r1329=r1327&r1314;r1330=r1325+(r1329<<3)|0;HEAPF64[r1330>>3]=0;r1331=r1326-1|0;r1332=(r1331|0)==0;if(r1332){break}else{r1326=r1331;r1327=r1328}}r1333=(r1299|0)==0;if(!r1333){r1334=(r1298|0)==0;r1335=(r1297|0)==0;r1336=r1312;r1337=0;r1338=r76;while(1){r1339=r1310;r1340=r1336;while(1){r1341=r1340+1|0;r1342=r1340&r1314;r1343=r1325+(r1342<<3)|0;HEAPF64[r1343>>3]=0;r1344=r1339-1|0;r1345=(r1344|0)==0;if(r1345){break}else{r1339=r1344;r1340=r1341}}r1346=r1336+r1310|0;if(r1334){r1347=r1346;r1348=r1338}else{r1349=r1346;r1350=0;r1351=r1338;while(1){r1352=r1349&r1314;r1353=r1325+(r1352<<3)|0;HEAPF64[r1353>>3]=0;r1354=r1349+1|0;if(r1335){r1355=r1354;r1356=r1351}else{r1357=r1354;r1358=0;r1359=r1351;while(1){r1360=r1357-1|0;r1361=r1360&r1314;r1362=r1325+(r1361<<3)|0;r1363=HEAPF64[r1362>>3];r1364=r1362|0;r1365=HEAP32[r1364>>2];r1366=r1362+4|0;r1367=HEAP32[r1366>>2];r1368=r1357-r1310|0;r1369=r1368-r1312|0;r1370=r1369&r1314;r1371=r1325+(r1370<<3)|0;r1372=HEAPF64[r1371>>3];r1373=r1371|0;r1374=HEAP32[r1373>>2];r1375=r1371+4|0;r1376=HEAP32[r1375>>2];r1377=r1363-r1372;r1378=r1368&r1314;r1379=r1325+(r1378<<3)|0;r1380=HEAPF64[r1379>>3];r1381=r1379|0;r1382=HEAP32[r1381>>2];r1383=r1379+4|0;r1384=HEAP32[r1383>>2];r1385=r1377+r1380;r1386=r1360-r1312|0;r1387=r1386&r1314;r1388=r1325+(r1387<<3)|0;r1389=HEAPF64[r1388>>3];r1390=r1388|0;r1391=HEAP32[r1390>>2];r1392=r1388+4|0;r1393=HEAP32[r1392>>2];r1394=r1385-r1389;r1395=r1357-r1312|0;r1396=r1395&r1314;r1397=r1325+(r1396<<3)|0;r1398=HEAPF64[r1397>>3];r1399=r1397|0;r1400=HEAP32[r1399>>2];r1401=r1397+4|0;r1402=HEAP32[r1401>>2];r1403=r1394+r1398;r1404=r1360-r1310|0;r1405=r1404&r1314;r1406=r1325+(r1405<<3)|0;r1407=HEAPF64[r1406>>3];r1408=r1406|0;r1409=HEAP32[r1408>>2];r1410=r1406+4|0;r1411=HEAP32[r1410>>2];r1412=r1403-r1407;r1413=r1404-r1312|0;r1414=r1413&r1314;r1415=r1325+(r1414<<3)|0;r1416=HEAPF64[r1415>>3];r1417=r1415|0;r1418=HEAP32[r1417>>2];r1419=r1415+4|0;r1420=HEAP32[r1419>>2];r1421=r1412+r1416;r1422=HEAP32[r1307>>2];r1423=HEAP32[r1309>>2];r1424=HEAP32[r1423>>2];r1425=__ZN9RCdecoder6decodeEP7RCmodel(r1422,r1424);r1426=r1425>>>0>14;do{if(r1426){r1427=r1425-15|0;r1428=r1427;r1429=0;r1430=1;r1431=0;r1432=_bitshift64Shl(r1430,r1431,r1428);r1433=tempRet0;r1434=HEAP32[r1307>>2];r1435=r1427>>>0>16;do{if(r1435){r1436=__ZN9RCdecoder12decode_shiftEj(r1434,16);r1437=r1436;r1438=0;r1439=r1425-31|0;r1440=r1439>>>0>16;if(!r1440){r1441=0;r1442=16;r1443=r1438;r1444=r1437;r1445=r1439;break}r1446=__ZN9RCdecoder12decode_shiftEj(r1434,16);r1447=r1446;r1448=0;r1449=r1447<<16|0>>>16;r1450=r1448<<16|r1447>>>16;r1451=_i64Add(r1449,r1450,r1437,r1438);r1452=tempRet0;r1453=r1425-47|0;r1454=r1453>>>0>16;if(!r1454){r1441=0;r1442=32;r1443=r1452;r1444=r1451;r1445=r1453;break}r1455=__ZN9RCdecoder12decode_shiftEj(r1434,16);r1456=r1455;r1457=0;r1458=0;r1459=r1456;r1460=_i64Add(r1458,r1459,r1451,r1452);r1461=tempRet0;r1462=r1425-63|0;r1441=0;r1442=48;r1443=r1461;r1444=r1460;r1445=r1462}else{r1441=0;r1442=0;r1443=0;r1444=0;r1445=r1427}}while(0);r1463=__ZN9RCdecoder12decode_shiftEj(r1434,r1445);r1464=r1463;r1465=0;r1466=_bitshift64Shl(r1464,r1465,r1442);r1467=tempRet0;HEAPF64[tempDoublePtr>>3]=r1421;r1468=HEAP32[tempDoublePtr>>2];r1469=HEAP32[tempDoublePtr+4>>2];r1470=r1469>>>18|0<<14;r1471=0>>>18|0<<14;r1472=16383;r1473=0;r1474=r1470^r1472;r1475=r1471^r1473;r1476=r1474>>>13|r1475<<19;r1477=r1475>>>13|0<<19;r1478=0;r1479=0;r1480=_i64Subtract(r1478,r1479,r1476,r1477);r1481=tempRet0;r1482=r1481>>>19|0<<13;r1483=0>>>19|0<<13;r1484=r1482^r1474;r1485=r1483^r1475;r1486=_i64Add(r1432,r1433,r1484,r1485);r1487=tempRet0;r1488=_i64Add(r1486,r1487,r1444,r1443);r1489=tempRet0;r1490=_i64Add(r1488,r1489,r1466,r1467);r1491=tempRet0;r1492=r1490>>>13|r1491<<19;r1493=r1491>>>13|0<<19;r1494=0;r1495=0;r1496=_i64Subtract(r1494,r1495,r1492,r1493);r1497=tempRet0;r1498=r1497>>>19|0<<13;r1499=0>>>19|0<<13;r1500=r1498^r1490;r1501=r1499^r1491;r1502=0<<18|0>>>14;r1503=r1500<<18|0>>>14;r1504=0;r1505=-262144;r1506=r1502^r1504;r1507=r1503^r1505;r1508=r1507;r1509=r1506}else{r1510=r1425>>>0<14;if(!r1510){HEAPF64[tempDoublePtr>>3]=r1421;r1511=HEAP32[tempDoublePtr>>2];r1512=HEAP32[tempDoublePtr+4>>2];r1513=0;r1514=-262144;r1515=r1511&r1513;r1516=r1512&r1514;r1508=r1516;r1509=r1515;break}r1517=13-r1425|0;r1518=r1517;r1519=0;r1520=HEAP32[r1307>>2];r1521=r1517>>>0>16;do{if(r1521){r1522=__ZN9RCdecoder12decode_shiftEj(r1520,16);r1523=r1522;r1524=0;r1525=r1517-16|0;r1526=r1525>>>0>16;if(!r1526){r1527=0;r1528=16;r1529=r1524;r1530=r1523;r1531=r1525;break}r1532=__ZN9RCdecoder12decode_shiftEj(r1520,16);r1533=r1532;r1534=0;r1535=r1533<<16|0>>>16;r1536=r1534<<16|r1533>>>16;r1537=_i64Add(r1535,r1536,r1523,r1524);r1538=tempRet0;r1539=r1517-32|0;r1540=r1539>>>0>16;if(!r1540){r1527=0;r1528=32;r1529=r1538;r1530=r1537;r1531=r1539;break}r1541=__ZN9RCdecoder12decode_shiftEj(r1520,16);r1542=r1541;r1543=0;r1544=0;r1545=r1542;r1546=_i64Add(r1544,r1545,r1537,r1538);r1547=tempRet0;r1548=r1517-48|0;r1527=0;r1528=48;r1529=r1547;r1530=r1546;r1531=r1548}else{r1527=0;r1528=0;r1529=0;r1530=0;r1531=r1517}}while(0);r1549=__ZN9RCdecoder12decode_shiftEj(r1520,r1531);r1550=r1549;r1551=0;r1552=_bitshift64Shl(r1550,r1551,r1528);r1553=tempRet0;HEAPF64[tempDoublePtr>>3]=r1421;r1554=HEAP32[tempDoublePtr>>2];r1555=HEAP32[tempDoublePtr+4>>2];r1556=r1555>>>18|0<<14;r1557=0>>>18|0<<14;r1558=16383;r1559=0;r1560=r1556^r1558;r1561=r1557^r1559;r1562=r1560>>>13|r1561<<19;r1563=r1561>>>13|0<<19;r1564=0;r1565=0;r1566=_i64Subtract(r1564,r1565,r1562,r1563);r1567=tempRet0;r1568=r1567>>>19|0<<13;r1569=0>>>19|0<<13;r1570=r1568^r1560;r1571=r1569^r1561;r1572=-1;r1573=-1;r1574=_bitshift64Shl(r1572,r1573,r1518);r1575=tempRet0;r1576=_i64Add(r1574,r1575,r1570,r1571);r1577=tempRet0;r1578=_i64Subtract(r1576,r1577,r1530,r1529);r1579=tempRet0;r1580=_i64Subtract(r1578,r1579,r1552,r1553);r1581=tempRet0;r1582=r1580>>>13|r1581<<19;r1583=r1581>>>13|0<<19;r1584=0;r1585=0;r1586=_i64Subtract(r1584,r1585,r1582,r1583);r1587=tempRet0;r1588=r1587>>>19|0<<13;r1589=0>>>19|0<<13;r1590=r1588^r1580;r1591=r1589^r1581;r1592=0<<18|0>>>14;r1593=r1590<<18|0>>>14;r1594=0;r1595=-262144;r1596=r1592^r1594;r1597=r1593^r1595;r1508=r1597;r1509=r1596}}while(0);r1598=(HEAP32[tempDoublePtr>>2]=r1509,HEAP32[tempDoublePtr+4>>2]=r1508,HEAPF64[tempDoublePtr>>3]);HEAPF64[r1359>>3]=r1598;r1599=r1357&r1314;r1600=r1325+(r1599<<3)|0;HEAPF64[r1600>>3]=r1598;r1601=r1359+8|0;r1602=r1357+1|0;r1603=r1358+1|0;r1604=r1603>>>0<r1297>>>0;if(r1604){r1357=r1602;r1358=r1603;r1359=r1601}else{r1355=r1602;r1356=r1601;break}}}r1605=r1350+1|0;r1606=r1605>>>0<r1298>>>0;if(r1606){r1349=r1355;r1350=r1605;r1351=r1356}else{r1347=r1355;r1348=r1356;break}}}r1607=r1337+1|0;r1608=r1607>>>0<r1299>>>0;if(r1608){r1336=r1347;r1337=r1607;r1338=r1348}else{break}}}r1609=(r1305|0)==0;if(!r1609){_free(r1305)}r1610=HEAP32[r30>>2];r1611=(r1610|0)==0;if(!r1611){r1612=r1610;r1613=HEAP32[r1612>>2];r1614=r1613+4|0;r1615=HEAP32[r1614>>2];FUNCTION_TABLE[r1615](r1610)}r1616=(r1324|0)==0;if(r1616){break L6}_free(r1324);break};case 16:{r1617=HEAP32[r41>>2];r1618=HEAP32[r42>>2];r1619=HEAP32[r43>>2];r1620=HEAP32[r44>>2];r1621=4;r1622=0;r1623=__Znwj(48);r1624=r1623;__ZN9RCqsmodelC2Ebjjj(r1624,0,33,16,1024);r1625=r1623;HEAP32[r29>>2]=r1625;r1626=__Znwj(12);r1627=r1626+4|0;r1628=r1627;HEAP32[r1628>>2]=r1617;r1629=r1626+8|0;r1630=r1629;HEAP32[r1630>>2]=r29;r1631=r1618+1|0;r1632=r1619+1|0;r1633=Math_imul(r1632,r1631)|0;r1634=r1633+r1631|0;r1635=r1634;while(1){r1636=r1635+1|0;r1637=r1636&r1635;r1638=(r1637|0)==0;r1639=r1636|r1635;if(r1638){break}else{r1635=r1639}}r1640=_llvm_umul_with_overflow_i32(r1636,8);r1641=tempRet0;r1642=r1641;r1643=r1640;r1644=r1642?-1:r1643;r1645=__Znwj(r1644);r1646=r1645;r1647=r1633;r1648=0;while(1){r1649=r1648+1|0;r1650=r1648&r1635;r1651=r1646+(r1650<<3)|0;HEAPF64[r1651>>3]=0;r1652=r1647-1|0;r1653=(r1652|0)==0;if(r1653){break}else{r1647=r1652;r1648=r1649}}r1654=(r1620|0)==0;if(!r1654){r1655=(r1619|0)==0;r1656=(r1618|0)==0;r1657=r1633;r1658=0;r1659=r76;while(1){r1660=r1631;r1661=r1657;while(1){r1662=r1661+1|0;r1663=r1661&r1635;r1664=r1646+(r1663<<3)|0;HEAPF64[r1664>>3]=0;r1665=r1660-1|0;r1666=(r1665|0)==0;if(r1666){break}else{r1660=r1665;r1661=r1662}}r1667=r1657+r1631|0;if(r1655){r1668=r1667;r1669=r1659}else{r1670=r1667;r1671=0;r1672=r1659;while(1){r1673=r1670&r1635;r1674=r1646+(r1673<<3)|0;HEAPF64[r1674>>3]=0;r1675=r1670+1|0;if(r1656){r1676=r1675;r1677=r1672}else{r1678=r1675;r1679=0;r1680=r1672;while(1){r1681=r1678-1|0;r1682=r1681&r1635;r1683=r1646+(r1682<<3)|0;r1684=HEAPF64[r1683>>3];r1685=r1683|0;r1686=HEAP32[r1685>>2];r1687=r1683+4|0;r1688=HEAP32[r1687>>2];r1689=r1678-r1631|0;r1690=r1689-r1633|0;r1691=r1690&r1635;r1692=r1646+(r1691<<3)|0;r1693=HEAPF64[r1692>>3];r1694=r1692|0;r1695=HEAP32[r1694>>2];r1696=r1692+4|0;r1697=HEAP32[r1696>>2];r1698=r1684-r1693;r1699=r1689&r1635;r1700=r1646+(r1699<<3)|0;r1701=HEAPF64[r1700>>3];r1702=r1700|0;r1703=HEAP32[r1702>>2];r1704=r1700+4|0;r1705=HEAP32[r1704>>2];r1706=r1698+r1701;r1707=r1681-r1633|0;r1708=r1707&r1635;r1709=r1646+(r1708<<3)|0;r1710=HEAPF64[r1709>>3];r1711=r1709|0;r1712=HEAP32[r1711>>2];r1713=r1709+4|0;r1714=HEAP32[r1713>>2];r1715=r1706-r1710;r1716=r1678-r1633|0;r1717=r1716&r1635;r1718=r1646+(r1717<<3)|0;r1719=HEAPF64[r1718>>3];r1720=r1718|0;r1721=HEAP32[r1720>>2];r1722=r1718+4|0;r1723=HEAP32[r1722>>2];r1724=r1715+r1719;r1725=r1681-r1631|0;r1726=r1725&r1635;r1727=r1646+(r1726<<3)|0;r1728=HEAPF64[r1727>>3];r1729=r1727|0;r1730=HEAP32[r1729>>2];r1731=r1727+4|0;r1732=HEAP32[r1731>>2];r1733=r1724-r1728;r1734=r1725-r1633|0;r1735=r1734&r1635;r1736=r1646+(r1735<<3)|0;r1737=HEAPF64[r1736>>3];r1738=r1736|0;r1739=HEAP32[r1738>>2];r1740=r1736+4|0;r1741=HEAP32[r1740>>2];r1742=r1733+r1737;r1743=HEAP32[r1628>>2];r1744=HEAP32[r1630>>2];r1745=HEAP32[r1744>>2];r1746=__ZN9RCdecoder6decodeEP7RCmodel(r1743,r1745);r1747=r1746>>>0>16;do{if(r1747){r1748=r1746-17|0;r1749=r1748;r1750=0;r1751=1;r1752=0;r1753=_bitshift64Shl(r1751,r1752,r1749);r1754=tempRet0;r1755=HEAP32[r1628>>2];r1756=r1748>>>0>16;do{if(r1756){r1757=__ZN9RCdecoder12decode_shiftEj(r1755,16);r1758=r1757;r1759=0;r1760=r1746-33|0;r1761=r1760>>>0>16;if(!r1761){r1762=0;r1763=16;r1764=r1759;r1765=r1758;r1766=r1760;break}r1767=__ZN9RCdecoder12decode_shiftEj(r1755,16);r1768=r1767;r1769=0;r1770=r1768<<16|0>>>16;r1771=r1769<<16|r1768>>>16;r1772=_i64Add(r1770,r1771,r1758,r1759);r1773=tempRet0;r1774=r1746-49|0;r1775=r1774>>>0>16;if(!r1775){r1762=0;r1763=32;r1764=r1773;r1765=r1772;r1766=r1774;break}r1776=__ZN9RCdecoder12decode_shiftEj(r1755,16);r1777=r1776;r1778=0;r1779=0;r1780=r1777;r1781=_i64Add(r1779,r1780,r1772,r1773);r1782=tempRet0;r1783=r1746-65|0;r1762=0;r1763=48;r1764=r1782;r1765=r1781;r1766=r1783}else{r1762=0;r1763=0;r1764=0;r1765=0;r1766=r1748}}while(0);r1784=__ZN9RCdecoder12decode_shiftEj(r1755,r1766);r1785=r1784;r1786=0;r1787=_bitshift64Shl(r1785,r1786,r1763);r1788=tempRet0;HEAPF64[tempDoublePtr>>3]=r1742;r1789=HEAP32[tempDoublePtr>>2];r1790=HEAP32[tempDoublePtr+4>>2];r1791=r1790>>>16|0<<16;r1792=0>>>16|0<<16;r1793=65535;r1794=0;r1795=r1791^r1793;r1796=r1792^r1794;r1797=r1795>>>15|r1796<<17;r1798=r1796>>>15|0<<17;r1799=0;r1800=0;r1801=_i64Subtract(r1799,r1800,r1797,r1798);r1802=tempRet0;r1803=r1802>>>17|0<<15;r1804=0>>>17|0<<15;r1805=r1803^r1795;r1806=r1804^r1796;r1807=_i64Add(r1753,r1754,r1805,r1806);r1808=tempRet0;r1809=_i64Add(r1807,r1808,r1765,r1764);r1810=tempRet0;r1811=_i64Add(r1809,r1810,r1787,r1788);r1812=tempRet0;r1813=r1811>>>15|r1812<<17;r1814=r1812>>>15|0<<17;r1815=0;r1816=0;r1817=_i64Subtract(r1815,r1816,r1813,r1814);r1818=tempRet0;r1819=r1818>>>17|0<<15;r1820=0>>>17|0<<15;r1821=r1819^r1811;r1822=r1820^r1812;r1823=0<<16|0>>>16;r1824=r1821<<16|0>>>16;r1825=0;r1826=-65536;r1827=r1823^r1825;r1828=r1824^r1826;r1829=r1828;r1830=r1827}else{r1831=r1746>>>0<16;if(!r1831){HEAPF64[tempDoublePtr>>3]=r1742;r1832=HEAP32[tempDoublePtr>>2];r1833=HEAP32[tempDoublePtr+4>>2];r1834=0;r1835=-65536;r1836=r1832&r1834;r1837=r1833&r1835;r1829=r1837;r1830=r1836;break}r1838=15-r1746|0;r1839=r1838;r1840=0;r1841=HEAP32[r1628>>2];r1842=r1838>>>0>16;do{if(r1842){r1843=__ZN9RCdecoder12decode_shiftEj(r1841,16);r1844=r1843;r1845=0;r1846=r1838-16|0;r1847=r1846>>>0>16;if(!r1847){r1848=0;r1849=16;r1850=r1845;r1851=r1844;r1852=r1846;break}r1853=__ZN9RCdecoder12decode_shiftEj(r1841,16);r1854=r1853;r1855=0;r1856=r1854<<16|0>>>16;r1857=r1855<<16|r1854>>>16;r1858=_i64Add(r1856,r1857,r1844,r1845);r1859=tempRet0;r1860=r1838-32|0;r1861=r1860>>>0>16;if(!r1861){r1848=0;r1849=32;r1850=r1859;r1851=r1858;r1852=r1860;break}r1862=__ZN9RCdecoder12decode_shiftEj(r1841,16);r1863=r1862;r1864=0;r1865=0;r1866=r1863;r1867=_i64Add(r1865,r1866,r1858,r1859);r1868=tempRet0;r1869=r1838-48|0;r1848=0;r1849=48;r1850=r1868;r1851=r1867;r1852=r1869}else{r1848=0;r1849=0;r1850=0;r1851=0;r1852=r1838}}while(0);r1870=__ZN9RCdecoder12decode_shiftEj(r1841,r1852);r1871=r1870;r1872=0;r1873=_bitshift64Shl(r1871,r1872,r1849);r1874=tempRet0;HEAPF64[tempDoublePtr>>3]=r1742;r1875=HEAP32[tempDoublePtr>>2];r1876=HEAP32[tempDoublePtr+4>>2];r1877=r1876>>>16|0<<16;r1878=0>>>16|0<<16;r1879=65535;r1880=0;r1881=r1877^r1879;r1882=r1878^r1880;r1883=r1881>>>15|r1882<<17;r1884=r1882>>>15|0<<17;r1885=0;r1886=0;r1887=_i64Subtract(r1885,r1886,r1883,r1884);r1888=tempRet0;r1889=r1888>>>17|0<<15;r1890=0>>>17|0<<15;r1891=r1889^r1881;r1892=r1890^r1882;r1893=-1;r1894=-1;r1895=_bitshift64Shl(r1893,r1894,r1839);r1896=tempRet0;r1897=_i64Add(r1895,r1896,r1891,r1892);r1898=tempRet0;r1899=_i64Subtract(r1897,r1898,r1851,r1850);r1900=tempRet0;r1901=_i64Subtract(r1899,r1900,r1873,r1874);r1902=tempRet0;r1903=r1901>>>15|r1902<<17;r1904=r1902>>>15|0<<17;r1905=0;r1906=0;r1907=_i64Subtract(r1905,r1906,r1903,r1904);r1908=tempRet0;r1909=r1908>>>17|0<<15;r1910=0>>>17|0<<15;r1911=r1909^r1901;r1912=r1910^r1902;r1913=0<<16|0>>>16;r1914=r1911<<16|0>>>16;r1915=0;r1916=-65536;r1917=r1913^r1915;r1918=r1914^r1916;r1829=r1918;r1830=r1917}}while(0);r1919=(HEAP32[tempDoublePtr>>2]=r1830,HEAP32[tempDoublePtr+4>>2]=r1829,HEAPF64[tempDoublePtr>>3]);HEAPF64[r1680>>3]=r1919;r1920=r1678&r1635;r1921=r1646+(r1920<<3)|0;HEAPF64[r1921>>3]=r1919;r1922=r1680+8|0;r1923=r1678+1|0;r1924=r1679+1|0;r1925=r1924>>>0<r1618>>>0;if(r1925){r1678=r1923;r1679=r1924;r1680=r1922}else{r1676=r1923;r1677=r1922;break}}}r1926=r1671+1|0;r1927=r1926>>>0<r1619>>>0;if(r1927){r1670=r1676;r1671=r1926;r1672=r1677}else{r1668=r1676;r1669=r1677;break}}}r1928=r1658+1|0;r1929=r1928>>>0<r1620>>>0;if(r1929){r1657=r1668;r1658=r1928;r1659=r1669}else{break}}}r1930=(r1626|0)==0;if(!r1930){_free(r1626)}r1931=HEAP32[r29>>2];r1932=(r1931|0)==0;if(!r1932){r1933=r1931;r1934=HEAP32[r1933>>2];r1935=r1934+4|0;r1936=HEAP32[r1935>>2];FUNCTION_TABLE[r1936](r1931)}r1937=(r1645|0)==0;if(r1937){break L6}_free(r1645);break};case 18:{r1938=HEAP32[r41>>2];r1939=HEAP32[r42>>2];r1940=HEAP32[r43>>2];r1941=HEAP32[r44>>2];r1942=4;r1943=0;r1944=__Znwj(48);r1945=r1944;__ZN9RCqsmodelC2Ebjjj(r1945,0,37,16,1024);r1946=r1944;HEAP32[r28>>2]=r1946;r1947=__Znwj(12);r1948=r1947+4|0;r1949=r1948;HEAP32[r1949>>2]=r1938;r1950=r1947+8|0;r1951=r1950;HEAP32[r1951>>2]=r28;r1952=r1939+1|0;r1953=r1940+1|0;r1954=Math_imul(r1953,r1952)|0;r1955=r1954+r1952|0;r1956=r1955;while(1){r1957=r1956+1|0;r1958=r1957&r1956;r1959=(r1958|0)==0;r1960=r1957|r1956;if(r1959){break}else{r1956=r1960}}r1961=_llvm_umul_with_overflow_i32(r1957,8);r1962=tempRet0;r1963=r1962;r1964=r1961;r1965=r1963?-1:r1964;r1966=__Znwj(r1965);r1967=r1966;r1968=r1954;r1969=0;while(1){r1970=r1969+1|0;r1971=r1969&r1956;r1972=r1967+(r1971<<3)|0;HEAPF64[r1972>>3]=0;r1973=r1968-1|0;r1974=(r1973|0)==0;if(r1974){break}else{r1968=r1973;r1969=r1970}}r1975=(r1941|0)==0;if(!r1975){r1976=(r1940|0)==0;r1977=(r1939|0)==0;r1978=r1954;r1979=0;r1980=r76;while(1){r1981=r1952;r1982=r1978;while(1){r1983=r1982+1|0;r1984=r1982&r1956;r1985=r1967+(r1984<<3)|0;HEAPF64[r1985>>3]=0;r1986=r1981-1|0;r1987=(r1986|0)==0;if(r1987){break}else{r1981=r1986;r1982=r1983}}r1988=r1978+r1952|0;if(r1976){r1989=r1988;r1990=r1980}else{r1991=r1988;r1992=0;r1993=r1980;while(1){r1994=r1991&r1956;r1995=r1967+(r1994<<3)|0;HEAPF64[r1995>>3]=0;r1996=r1991+1|0;if(r1977){r1997=r1996;r1998=r1993}else{r1999=r1996;r2000=0;r2001=r1993;while(1){r2002=r1999-1|0;r2003=r2002&r1956;r2004=r1967+(r2003<<3)|0;r2005=HEAPF64[r2004>>3];r2006=r2004|0;r2007=HEAP32[r2006>>2];r2008=r2004+4|0;r2009=HEAP32[r2008>>2];r2010=r1999-r1952|0;r2011=r2010-r1954|0;r2012=r2011&r1956;r2013=r1967+(r2012<<3)|0;r2014=HEAPF64[r2013>>3];r2015=r2013|0;r2016=HEAP32[r2015>>2];r2017=r2013+4|0;r2018=HEAP32[r2017>>2];r2019=r2005-r2014;r2020=r2010&r1956;r2021=r1967+(r2020<<3)|0;r2022=HEAPF64[r2021>>3];r2023=r2021|0;r2024=HEAP32[r2023>>2];r2025=r2021+4|0;r2026=HEAP32[r2025>>2];r2027=r2019+r2022;r2028=r2002-r1954|0;r2029=r2028&r1956;r2030=r1967+(r2029<<3)|0;r2031=HEAPF64[r2030>>3];r2032=r2030|0;r2033=HEAP32[r2032>>2];r2034=r2030+4|0;r2035=HEAP32[r2034>>2];r2036=r2027-r2031;r2037=r1999-r1954|0;r2038=r2037&r1956;r2039=r1967+(r2038<<3)|0;r2040=HEAPF64[r2039>>3];r2041=r2039|0;r2042=HEAP32[r2041>>2];r2043=r2039+4|0;r2044=HEAP32[r2043>>2];r2045=r2036+r2040;r2046=r2002-r1952|0;r2047=r2046&r1956;r2048=r1967+(r2047<<3)|0;r2049=HEAPF64[r2048>>3];r2050=r2048|0;r2051=HEAP32[r2050>>2];r2052=r2048+4|0;r2053=HEAP32[r2052>>2];r2054=r2045-r2049;r2055=r2046-r1954|0;r2056=r2055&r1956;r2057=r1967+(r2056<<3)|0;r2058=HEAPF64[r2057>>3];r2059=r2057|0;r2060=HEAP32[r2059>>2];r2061=r2057+4|0;r2062=HEAP32[r2061>>2];r2063=r2054+r2058;r2064=HEAP32[r1949>>2];r2065=HEAP32[r1951>>2];r2066=HEAP32[r2065>>2];r2067=__ZN9RCdecoder6decodeEP7RCmodel(r2064,r2066);r2068=r2067>>>0>18;do{if(r2068){r2069=r2067-19|0;r2070=r2069;r2071=0;r2072=1;r2073=0;r2074=_bitshift64Shl(r2072,r2073,r2070);r2075=tempRet0;r2076=HEAP32[r1949>>2];r2077=r2069>>>0>16;do{if(r2077){r2078=__ZN9RCdecoder12decode_shiftEj(r2076,16);r2079=r2078;r2080=0;r2081=r2067-35|0;r2082=r2081>>>0>16;if(!r2082){r2083=0;r2084=16;r2085=r2080;r2086=r2079;r2087=r2081;break}r2088=__ZN9RCdecoder12decode_shiftEj(r2076,16);r2089=r2088;r2090=0;r2091=r2089<<16|0>>>16;r2092=r2090<<16|r2089>>>16;r2093=_i64Add(r2091,r2092,r2079,r2080);r2094=tempRet0;r2095=r2067-51|0;r2096=r2095>>>0>16;if(!r2096){r2083=0;r2084=32;r2085=r2094;r2086=r2093;r2087=r2095;break}r2097=__ZN9RCdecoder12decode_shiftEj(r2076,16);r2098=r2097;r2099=0;r2100=0;r2101=r2098;r2102=_i64Add(r2100,r2101,r2093,r2094);r2103=tempRet0;r2104=r2067-67|0;r2083=0;r2084=48;r2085=r2103;r2086=r2102;r2087=r2104}else{r2083=0;r2084=0;r2085=0;r2086=0;r2087=r2069}}while(0);r2105=__ZN9RCdecoder12decode_shiftEj(r2076,r2087);r2106=r2105;r2107=0;r2108=_bitshift64Shl(r2106,r2107,r2084);r2109=tempRet0;HEAPF64[tempDoublePtr>>3]=r2063;r2110=HEAP32[tempDoublePtr>>2];r2111=HEAP32[tempDoublePtr+4>>2];r2112=r2111>>>14|0<<18;r2113=0>>>14|0<<18;r2114=262143;r2115=0;r2116=r2112^r2114;r2117=r2113^r2115;r2118=r2116>>>17|r2117<<15;r2119=r2117>>>17|0<<15;r2120=0;r2121=0;r2122=_i64Subtract(r2120,r2121,r2118,r2119);r2123=tempRet0;r2124=r2123>>>15|0<<17;r2125=0>>>15|0<<17;r2126=r2124^r2116;r2127=r2125^r2117;r2128=_i64Add(r2074,r2075,r2126,r2127);r2129=tempRet0;r2130=_i64Add(r2128,r2129,r2086,r2085);r2131=tempRet0;r2132=_i64Add(r2130,r2131,r2108,r2109);r2133=tempRet0;r2134=r2132>>>17|r2133<<15;r2135=r2133>>>17|0<<15;r2136=0;r2137=0;r2138=_i64Subtract(r2136,r2137,r2134,r2135);r2139=tempRet0;r2140=r2139>>>15|0<<17;r2141=0>>>15|0<<17;r2142=r2140^r2132;r2143=r2141^r2133;r2144=0<<14|0>>>18;r2145=r2142<<14|0>>>18;r2146=0;r2147=-16384;r2148=r2144^r2146;r2149=r2145^r2147;r2150=r2149;r2151=r2148}else{r2152=r2067>>>0<18;if(!r2152){HEAPF64[tempDoublePtr>>3]=r2063;r2153=HEAP32[tempDoublePtr>>2];r2154=HEAP32[tempDoublePtr+4>>2];r2155=0;r2156=-16384;r2157=r2153&r2155;r2158=r2154&r2156;r2150=r2158;r2151=r2157;break}r2159=17-r2067|0;r2160=r2159;r2161=0;r2162=HEAP32[r1949>>2];r2163=r2159>>>0>16;do{if(r2163){r2164=__ZN9RCdecoder12decode_shiftEj(r2162,16);r2165=r2164;r2166=0;r2167=r2159-16|0;r2168=r2167>>>0>16;if(!r2168){r2169=0;r2170=16;r2171=r2166;r2172=r2165;r2173=r2167;break}r2174=__ZN9RCdecoder12decode_shiftEj(r2162,16);r2175=r2174;r2176=0;r2177=r2175<<16|0>>>16;r2178=r2176<<16|r2175>>>16;r2179=_i64Add(r2177,r2178,r2165,r2166);r2180=tempRet0;r2181=r2159-32|0;r2182=r2181>>>0>16;if(!r2182){r2169=0;r2170=32;r2171=r2180;r2172=r2179;r2173=r2181;break}r2183=__ZN9RCdecoder12decode_shiftEj(r2162,16);r2184=r2183;r2185=0;r2186=0;r2187=r2184;r2188=_i64Add(r2186,r2187,r2179,r2180);r2189=tempRet0;r2190=r2159-48|0;r2169=0;r2170=48;r2171=r2189;r2172=r2188;r2173=r2190}else{r2169=0;r2170=0;r2171=0;r2172=0;r2173=r2159}}while(0);r2191=__ZN9RCdecoder12decode_shiftEj(r2162,r2173);r2192=r2191;r2193=0;r2194=_bitshift64Shl(r2192,r2193,r2170);r2195=tempRet0;HEAPF64[tempDoublePtr>>3]=r2063;r2196=HEAP32[tempDoublePtr>>2];r2197=HEAP32[tempDoublePtr+4>>2];r2198=r2197>>>14|0<<18;r2199=0>>>14|0<<18;r2200=262143;r2201=0;r2202=r2198^r2200;r2203=r2199^r2201;r2204=r2202>>>17|r2203<<15;r2205=r2203>>>17|0<<15;r2206=0;r2207=0;r2208=_i64Subtract(r2206,r2207,r2204,r2205);r2209=tempRet0;r2210=r2209>>>15|0<<17;r2211=0>>>15|0<<17;r2212=r2210^r2202;r2213=r2211^r2203;r2214=-1;r2215=-1;r2216=_bitshift64Shl(r2214,r2215,r2160);r2217=tempRet0;r2218=_i64Add(r2216,r2217,r2212,r2213);r2219=tempRet0;r2220=_i64Subtract(r2218,r2219,r2172,r2171);r2221=tempRet0;r2222=_i64Subtract(r2220,r2221,r2194,r2195);r2223=tempRet0;r2224=r2222>>>17|r2223<<15;r2225=r2223>>>17|0<<15;r2226=0;r2227=0;r2228=_i64Subtract(r2226,r2227,r2224,r2225);r2229=tempRet0;r2230=r2229>>>15|0<<17;r2231=0>>>15|0<<17;r2232=r2230^r2222;r2233=r2231^r2223;r2234=0<<14|0>>>18;r2235=r2232<<14|0>>>18;r2236=0;r2237=-16384;r2238=r2234^r2236;r2239=r2235^r2237;r2150=r2239;r2151=r2238}}while(0);r2240=(HEAP32[tempDoublePtr>>2]=r2151,HEAP32[tempDoublePtr+4>>2]=r2150,HEAPF64[tempDoublePtr>>3]);HEAPF64[r2001>>3]=r2240;r2241=r1999&r1956;r2242=r1967+(r2241<<3)|0;HEAPF64[r2242>>3]=r2240;r2243=r2001+8|0;r2244=r1999+1|0;r2245=r2000+1|0;r2246=r2245>>>0<r1939>>>0;if(r2246){r1999=r2244;r2000=r2245;r2001=r2243}else{r1997=r2244;r1998=r2243;break}}}r2247=r1992+1|0;r2248=r2247>>>0<r1940>>>0;if(r2248){r1991=r1997;r1992=r2247;r1993=r1998}else{r1989=r1997;r1990=r1998;break}}}r2249=r1979+1|0;r2250=r2249>>>0<r1941>>>0;if(r2250){r1978=r1989;r1979=r2249;r1980=r1990}else{break}}}r2251=(r1947|0)==0;if(!r2251){_free(r1947)}r2252=HEAP32[r28>>2];r2253=(r2252|0)==0;if(!r2253){r2254=r2252;r2255=HEAP32[r2254>>2];r2256=r2255+4|0;r2257=HEAP32[r2256>>2];FUNCTION_TABLE[r2257](r2252)}r2258=(r1966|0)==0;if(r2258){break L6}_free(r1966);break};case 20:{r2259=HEAP32[r41>>2];r2260=HEAP32[r42>>2];r2261=HEAP32[r43>>2];r2262=HEAP32[r44>>2];r2263=4;r2264=0;r2265=__Znwj(48);r2266=r2265;__ZN9RCqsmodelC2Ebjjj(r2266,0,41,16,1024);r2267=r2265;HEAP32[r27>>2]=r2267;r2268=__Znwj(12);r2269=r2268+4|0;r2270=r2269;HEAP32[r2270>>2]=r2259;r2271=r2268+8|0;r2272=r2271;HEAP32[r2272>>2]=r27;r2273=r2260+1|0;r2274=r2261+1|0;r2275=Math_imul(r2274,r2273)|0;r2276=r2275+r2273|0;r2277=r2276;while(1){r2278=r2277+1|0;r2279=r2278&r2277;r2280=(r2279|0)==0;r2281=r2278|r2277;if(r2280){break}else{r2277=r2281}}r2282=_llvm_umul_with_overflow_i32(r2278,8);r2283=tempRet0;r2284=r2283;r2285=r2282;r2286=r2284?-1:r2285;r2287=__Znwj(r2286);r2288=r2287;r2289=r2275;r2290=0;while(1){r2291=r2290+1|0;r2292=r2290&r2277;r2293=r2288+(r2292<<3)|0;HEAPF64[r2293>>3]=0;r2294=r2289-1|0;r2295=(r2294|0)==0;if(r2295){break}else{r2289=r2294;r2290=r2291}}r2296=(r2262|0)==0;if(!r2296){r2297=(r2261|0)==0;r2298=(r2260|0)==0;r2299=r2275;r2300=0;r2301=r76;while(1){r2302=r2273;r2303=r2299;while(1){r2304=r2303+1|0;r2305=r2303&r2277;r2306=r2288+(r2305<<3)|0;HEAPF64[r2306>>3]=0;r2307=r2302-1|0;r2308=(r2307|0)==0;if(r2308){break}else{r2302=r2307;r2303=r2304}}r2309=r2299+r2273|0;if(r2297){r2310=r2309;r2311=r2301}else{r2312=r2309;r2313=0;r2314=r2301;while(1){r2315=r2312&r2277;r2316=r2288+(r2315<<3)|0;HEAPF64[r2316>>3]=0;r2317=r2312+1|0;if(r2298){r2318=r2317;r2319=r2314}else{r2320=r2317;r2321=0;r2322=r2314;while(1){r2323=r2320-1|0;r2324=r2323&r2277;r2325=r2288+(r2324<<3)|0;r2326=HEAPF64[r2325>>3];r2327=r2325|0;r2328=HEAP32[r2327>>2];r2329=r2325+4|0;r2330=HEAP32[r2329>>2];r2331=r2320-r2273|0;r2332=r2331-r2275|0;r2333=r2332&r2277;r2334=r2288+(r2333<<3)|0;r2335=HEAPF64[r2334>>3];r2336=r2334|0;r2337=HEAP32[r2336>>2];r2338=r2334+4|0;r2339=HEAP32[r2338>>2];r2340=r2326-r2335;r2341=r2331&r2277;r2342=r2288+(r2341<<3)|0;r2343=HEAPF64[r2342>>3];r2344=r2342|0;r2345=HEAP32[r2344>>2];r2346=r2342+4|0;r2347=HEAP32[r2346>>2];r2348=r2340+r2343;r2349=r2323-r2275|0;r2350=r2349&r2277;r2351=r2288+(r2350<<3)|0;r2352=HEAPF64[r2351>>3];r2353=r2351|0;r2354=HEAP32[r2353>>2];r2355=r2351+4|0;r2356=HEAP32[r2355>>2];r2357=r2348-r2352;r2358=r2320-r2275|0;r2359=r2358&r2277;r2360=r2288+(r2359<<3)|0;r2361=HEAPF64[r2360>>3];r2362=r2360|0;r2363=HEAP32[r2362>>2];r2364=r2360+4|0;r2365=HEAP32[r2364>>2];r2366=r2357+r2361;r2367=r2323-r2273|0;r2368=r2367&r2277;r2369=r2288+(r2368<<3)|0;r2370=HEAPF64[r2369>>3];r2371=r2369|0;r2372=HEAP32[r2371>>2];r2373=r2369+4|0;r2374=HEAP32[r2373>>2];r2375=r2366-r2370;r2376=r2367-r2275|0;r2377=r2376&r2277;r2378=r2288+(r2377<<3)|0;r2379=HEAPF64[r2378>>3];r2380=r2378|0;r2381=HEAP32[r2380>>2];r2382=r2378+4|0;r2383=HEAP32[r2382>>2];r2384=r2375+r2379;r2385=HEAP32[r2270>>2];r2386=HEAP32[r2272>>2];r2387=HEAP32[r2386>>2];r2388=__ZN9RCdecoder6decodeEP7RCmodel(r2385,r2387);r2389=r2388>>>0>20;do{if(r2389){r2390=r2388-21|0;r2391=r2390;r2392=0;r2393=1;r2394=0;r2395=_bitshift64Shl(r2393,r2394,r2391);r2396=tempRet0;r2397=HEAP32[r2270>>2];r2398=r2390>>>0>16;do{if(r2398){r2399=__ZN9RCdecoder12decode_shiftEj(r2397,16);r2400=r2399;r2401=0;r2402=r2388-37|0;r2403=r2402>>>0>16;if(!r2403){r2404=0;r2405=16;r2406=r2401;r2407=r2400;r2408=r2402;break}r2409=__ZN9RCdecoder12decode_shiftEj(r2397,16);r2410=r2409;r2411=0;r2412=r2410<<16|0>>>16;r2413=r2411<<16|r2410>>>16;r2414=_i64Add(r2412,r2413,r2400,r2401);r2415=tempRet0;r2416=r2388-53|0;r2417=r2416>>>0>16;if(!r2417){r2404=0;r2405=32;r2406=r2415;r2407=r2414;r2408=r2416;break}r2418=__ZN9RCdecoder12decode_shiftEj(r2397,16);r2419=r2418;r2420=0;r2421=0;r2422=r2419;r2423=_i64Add(r2421,r2422,r2414,r2415);r2424=tempRet0;r2425=r2388-69|0;r2404=0;r2405=48;r2406=r2424;r2407=r2423;r2408=r2425}else{r2404=0;r2405=0;r2406=0;r2407=0;r2408=r2390}}while(0);r2426=__ZN9RCdecoder12decode_shiftEj(r2397,r2408);r2427=r2426;r2428=0;r2429=_bitshift64Shl(r2427,r2428,r2405);r2430=tempRet0;HEAPF64[tempDoublePtr>>3]=r2384;r2431=HEAP32[tempDoublePtr>>2];r2432=HEAP32[tempDoublePtr+4>>2];r2433=r2432>>>12|0<<20;r2434=0>>>12|0<<20;r2435=1048575;r2436=0;r2437=r2433^r2435;r2438=r2434^r2436;r2439=r2437>>>19|r2438<<13;r2440=r2438>>>19|0<<13;r2441=0;r2442=0;r2443=_i64Subtract(r2441,r2442,r2439,r2440);r2444=tempRet0;r2445=r2444>>>13|0<<19;r2446=0>>>13|0<<19;r2447=r2445^r2437;r2448=r2446^r2438;r2449=_i64Add(r2395,r2396,r2447,r2448);r2450=tempRet0;r2451=_i64Add(r2449,r2450,r2407,r2406);r2452=tempRet0;r2453=_i64Add(r2451,r2452,r2429,r2430);r2454=tempRet0;r2455=r2453>>>19|r2454<<13;r2456=r2454>>>19|0<<13;r2457=0;r2458=0;r2459=_i64Subtract(r2457,r2458,r2455,r2456);r2460=tempRet0;r2461=r2460>>>13|0<<19;r2462=0>>>13|0<<19;r2463=r2461^r2453;r2464=r2462^r2454;r2465=0<<12|0>>>20;r2466=r2463<<12|0>>>20;r2467=0;r2468=-4096;r2469=r2465^r2467;r2470=r2466^r2468;r2471=r2470;r2472=r2469}else{r2473=r2388>>>0<20;if(!r2473){HEAPF64[tempDoublePtr>>3]=r2384;r2474=HEAP32[tempDoublePtr>>2];r2475=HEAP32[tempDoublePtr+4>>2];r2476=0;r2477=-4096;r2478=r2474&r2476;r2479=r2475&r2477;r2471=r2479;r2472=r2478;break}r2480=19-r2388|0;r2481=r2480;r2482=0;r2483=HEAP32[r2270>>2];r2484=r2480>>>0>16;do{if(r2484){r2485=__ZN9RCdecoder12decode_shiftEj(r2483,16);r2486=r2485;r2487=0;r2488=r2480-16|0;r2489=r2488>>>0>16;if(!r2489){r2490=0;r2491=16;r2492=r2487;r2493=r2486;r2494=r2488;break}r2495=__ZN9RCdecoder12decode_shiftEj(r2483,16);r2496=r2495;r2497=0;r2498=r2496<<16|0>>>16;r2499=r2497<<16|r2496>>>16;r2500=_i64Add(r2498,r2499,r2486,r2487);r2501=tempRet0;r2502=r2480-32|0;r2503=r2502>>>0>16;if(!r2503){r2490=0;r2491=32;r2492=r2501;r2493=r2500;r2494=r2502;break}r2504=__ZN9RCdecoder12decode_shiftEj(r2483,16);r2505=r2504;r2506=0;r2507=0;r2508=r2505;r2509=_i64Add(r2507,r2508,r2500,r2501);r2510=tempRet0;r2511=r2480-48|0;r2490=0;r2491=48;r2492=r2510;r2493=r2509;r2494=r2511}else{r2490=0;r2491=0;r2492=0;r2493=0;r2494=r2480}}while(0);r2512=__ZN9RCdecoder12decode_shiftEj(r2483,r2494);r2513=r2512;r2514=0;r2515=_bitshift64Shl(r2513,r2514,r2491);r2516=tempRet0;HEAPF64[tempDoublePtr>>3]=r2384;r2517=HEAP32[tempDoublePtr>>2];r2518=HEAP32[tempDoublePtr+4>>2];r2519=r2518>>>12|0<<20;r2520=0>>>12|0<<20;r2521=1048575;r2522=0;r2523=r2519^r2521;r2524=r2520^r2522;r2525=r2523>>>19|r2524<<13;r2526=r2524>>>19|0<<13;r2527=0;r2528=0;r2529=_i64Subtract(r2527,r2528,r2525,r2526);r2530=tempRet0;r2531=r2530>>>13|0<<19;r2532=0>>>13|0<<19;r2533=r2531^r2523;r2534=r2532^r2524;r2535=-1;r2536=-1;r2537=_bitshift64Shl(r2535,r2536,r2481);r2538=tempRet0;r2539=_i64Add(r2537,r2538,r2533,r2534);r2540=tempRet0;r2541=_i64Subtract(r2539,r2540,r2493,r2492);r2542=tempRet0;r2543=_i64Subtract(r2541,r2542,r2515,r2516);r2544=tempRet0;r2545=r2543>>>19|r2544<<13;r2546=r2544>>>19|0<<13;r2547=0;r2548=0;r2549=_i64Subtract(r2547,r2548,r2545,r2546);r2550=tempRet0;r2551=r2550>>>13|0<<19;r2552=0>>>13|0<<19;r2553=r2551^r2543;r2554=r2552^r2544;r2555=0<<12|0>>>20;r2556=r2553<<12|0>>>20;r2557=0;r2558=-4096;r2559=r2555^r2557;r2560=r2556^r2558;r2471=r2560;r2472=r2559}}while(0);r2561=(HEAP32[tempDoublePtr>>2]=r2472,HEAP32[tempDoublePtr+4>>2]=r2471,HEAPF64[tempDoublePtr>>3]);HEAPF64[r2322>>3]=r2561;r2562=r2320&r2277;r2563=r2288+(r2562<<3)|0;HEAPF64[r2563>>3]=r2561;r2564=r2322+8|0;r2565=r2320+1|0;r2566=r2321+1|0;r2567=r2566>>>0<r2260>>>0;if(r2567){r2320=r2565;r2321=r2566;r2322=r2564}else{r2318=r2565;r2319=r2564;break}}}r2568=r2313+1|0;r2569=r2568>>>0<r2261>>>0;if(r2569){r2312=r2318;r2313=r2568;r2314=r2319}else{r2310=r2318;r2311=r2319;break}}}r2570=r2300+1|0;r2571=r2570>>>0<r2262>>>0;if(r2571){r2299=r2310;r2300=r2570;r2301=r2311}else{break}}}r2572=(r2268|0)==0;if(!r2572){_free(r2268)}r2573=HEAP32[r27>>2];r2574=(r2573|0)==0;if(!r2574){r2575=r2573;r2576=HEAP32[r2575>>2];r2577=r2576+4|0;r2578=HEAP32[r2577>>2];FUNCTION_TABLE[r2578](r2573)}r2579=(r2287|0)==0;if(r2579){break L6}_free(r2287);break};case 22:{r2580=HEAP32[r41>>2];r2581=HEAP32[r42>>2];r2582=HEAP32[r43>>2];r2583=HEAP32[r44>>2];r2584=4;r2585=0;r2586=__Znwj(48);r2587=r2586;__ZN9RCqsmodelC2Ebjjj(r2587,0,45,16,1024);r2588=r2586;HEAP32[r26>>2]=r2588;r2589=__Znwj(12);r2590=r2589+4|0;r2591=r2590;HEAP32[r2591>>2]=r2580;r2592=r2589+8|0;r2593=r2592;HEAP32[r2593>>2]=r26;r2594=r2581+1|0;r2595=r2582+1|0;r2596=Math_imul(r2595,r2594)|0;r2597=r2596+r2594|0;r2598=r2597;while(1){r2599=r2598+1|0;r2600=r2599&r2598;r2601=(r2600|0)==0;r2602=r2599|r2598;if(r2601){break}else{r2598=r2602}}r2603=_llvm_umul_with_overflow_i32(r2599,8);r2604=tempRet0;r2605=r2604;r2606=r2603;r2607=r2605?-1:r2606;r2608=__Znwj(r2607);r2609=r2608;r2610=r2596;r2611=0;while(1){r2612=r2611+1|0;r2613=r2611&r2598;r2614=r2609+(r2613<<3)|0;HEAPF64[r2614>>3]=0;r2615=r2610-1|0;r2616=(r2615|0)==0;if(r2616){break}else{r2610=r2615;r2611=r2612}}r2617=(r2583|0)==0;if(!r2617){r2618=(r2582|0)==0;r2619=(r2581|0)==0;r2620=r2596;r2621=0;r2622=r76;while(1){r2623=r2594;r2624=r2620;while(1){r2625=r2624+1|0;r2626=r2624&r2598;r2627=r2609+(r2626<<3)|0;HEAPF64[r2627>>3]=0;r2628=r2623-1|0;r2629=(r2628|0)==0;if(r2629){break}else{r2623=r2628;r2624=r2625}}r2630=r2620+r2594|0;if(r2618){r2631=r2630;r2632=r2622}else{r2633=r2630;r2634=0;r2635=r2622;while(1){r2636=r2633&r2598;r2637=r2609+(r2636<<3)|0;HEAPF64[r2637>>3]=0;r2638=r2633+1|0;if(r2619){r2639=r2638;r2640=r2635}else{r2641=r2638;r2642=0;r2643=r2635;while(1){r2644=r2641-1|0;r2645=r2644&r2598;r2646=r2609+(r2645<<3)|0;r2647=HEAPF64[r2646>>3];r2648=r2646|0;r2649=HEAP32[r2648>>2];r2650=r2646+4|0;r2651=HEAP32[r2650>>2];r2652=r2641-r2594|0;r2653=r2652-r2596|0;r2654=r2653&r2598;r2655=r2609+(r2654<<3)|0;r2656=HEAPF64[r2655>>3];r2657=r2655|0;r2658=HEAP32[r2657>>2];r2659=r2655+4|0;r2660=HEAP32[r2659>>2];r2661=r2647-r2656;r2662=r2652&r2598;r2663=r2609+(r2662<<3)|0;r2664=HEAPF64[r2663>>3];r2665=r2663|0;r2666=HEAP32[r2665>>2];r2667=r2663+4|0;r2668=HEAP32[r2667>>2];r2669=r2661+r2664;r2670=r2644-r2596|0;r2671=r2670&r2598;r2672=r2609+(r2671<<3)|0;r2673=HEAPF64[r2672>>3];r2674=r2672|0;r2675=HEAP32[r2674>>2];r2676=r2672+4|0;r2677=HEAP32[r2676>>2];r2678=r2669-r2673;r2679=r2641-r2596|0;r2680=r2679&r2598;r2681=r2609+(r2680<<3)|0;r2682=HEAPF64[r2681>>3];r2683=r2681|0;r2684=HEAP32[r2683>>2];r2685=r2681+4|0;r2686=HEAP32[r2685>>2];r2687=r2678+r2682;r2688=r2644-r2594|0;r2689=r2688&r2598;r2690=r2609+(r2689<<3)|0;r2691=HEAPF64[r2690>>3];r2692=r2690|0;r2693=HEAP32[r2692>>2];r2694=r2690+4|0;r2695=HEAP32[r2694>>2];r2696=r2687-r2691;r2697=r2688-r2596|0;r2698=r2697&r2598;r2699=r2609+(r2698<<3)|0;r2700=HEAPF64[r2699>>3];r2701=r2699|0;r2702=HEAP32[r2701>>2];r2703=r2699+4|0;r2704=HEAP32[r2703>>2];r2705=r2696+r2700;r2706=HEAP32[r2591>>2];r2707=HEAP32[r2593>>2];r2708=HEAP32[r2707>>2];r2709=__ZN9RCdecoder6decodeEP7RCmodel(r2706,r2708);r2710=r2709>>>0>22;do{if(r2710){r2711=r2709-23|0;r2712=r2711;r2713=0;r2714=1;r2715=0;r2716=_bitshift64Shl(r2714,r2715,r2712);r2717=tempRet0;r2718=HEAP32[r2591>>2];r2719=r2711>>>0>16;do{if(r2719){r2720=__ZN9RCdecoder12decode_shiftEj(r2718,16);r2721=r2720;r2722=0;r2723=r2709-39|0;r2724=r2723>>>0>16;if(!r2724){r2725=0;r2726=16;r2727=r2722;r2728=r2721;r2729=r2723;break}r2730=__ZN9RCdecoder12decode_shiftEj(r2718,16);r2731=r2730;r2732=0;r2733=r2731<<16|0>>>16;r2734=r2732<<16|r2731>>>16;r2735=_i64Add(r2733,r2734,r2721,r2722);r2736=tempRet0;r2737=r2709-55|0;r2738=r2737>>>0>16;if(!r2738){r2725=0;r2726=32;r2727=r2736;r2728=r2735;r2729=r2737;break}r2739=__ZN9RCdecoder12decode_shiftEj(r2718,16);r2740=r2739;r2741=0;r2742=0;r2743=r2740;r2744=_i64Add(r2742,r2743,r2735,r2736);r2745=tempRet0;r2746=r2709-71|0;r2725=0;r2726=48;r2727=r2745;r2728=r2744;r2729=r2746}else{r2725=0;r2726=0;r2727=0;r2728=0;r2729=r2711}}while(0);r2747=__ZN9RCdecoder12decode_shiftEj(r2718,r2729);r2748=r2747;r2749=0;r2750=_bitshift64Shl(r2748,r2749,r2726);r2751=tempRet0;HEAPF64[tempDoublePtr>>3]=r2705;r2752=HEAP32[tempDoublePtr>>2];r2753=HEAP32[tempDoublePtr+4>>2];r2754=r2753>>>10|0<<22;r2755=0>>>10|0<<22;r2756=4194303;r2757=0;r2758=r2754^r2756;r2759=r2755^r2757;r2760=r2758>>>21|r2759<<11;r2761=r2759>>>21|0<<11;r2762=0;r2763=0;r2764=_i64Subtract(r2762,r2763,r2760,r2761);r2765=tempRet0;r2766=r2765>>>11|0<<21;r2767=0>>>11|0<<21;r2768=r2766^r2758;r2769=r2767^r2759;r2770=_i64Add(r2716,r2717,r2768,r2769);r2771=tempRet0;r2772=_i64Add(r2770,r2771,r2728,r2727);r2773=tempRet0;r2774=_i64Add(r2772,r2773,r2750,r2751);r2775=tempRet0;r2776=r2774>>>21|r2775<<11;r2777=r2775>>>21|0<<11;r2778=0;r2779=0;r2780=_i64Subtract(r2778,r2779,r2776,r2777);r2781=tempRet0;r2782=r2781>>>11|0<<21;r2783=0>>>11|0<<21;r2784=r2782^r2774;r2785=r2783^r2775;r2786=0<<10|0>>>22;r2787=r2784<<10|0>>>22;r2788=0;r2789=-1024;r2790=r2786^r2788;r2791=r2787^r2789;r2792=r2791;r2793=r2790}else{r2794=r2709>>>0<22;if(!r2794){HEAPF64[tempDoublePtr>>3]=r2705;r2795=HEAP32[tempDoublePtr>>2];r2796=HEAP32[tempDoublePtr+4>>2];r2797=0;r2798=-1024;r2799=r2795&r2797;r2800=r2796&r2798;r2792=r2800;r2793=r2799;break}r2801=21-r2709|0;r2802=r2801;r2803=0;r2804=HEAP32[r2591>>2];r2805=r2801>>>0>16;do{if(r2805){r2806=__ZN9RCdecoder12decode_shiftEj(r2804,16);r2807=r2806;r2808=0;r2809=r2801-16|0;r2810=r2809>>>0>16;if(!r2810){r2811=0;r2812=16;r2813=r2808;r2814=r2807;r2815=r2809;break}r2816=__ZN9RCdecoder12decode_shiftEj(r2804,16);r2817=r2816;r2818=0;r2819=r2817<<16|0>>>16;r2820=r2818<<16|r2817>>>16;r2821=_i64Add(r2819,r2820,r2807,r2808);r2822=tempRet0;r2823=r2801-32|0;r2824=r2823>>>0>16;if(!r2824){r2811=0;r2812=32;r2813=r2822;r2814=r2821;r2815=r2823;break}r2825=__ZN9RCdecoder12decode_shiftEj(r2804,16);r2826=r2825;r2827=0;r2828=0;r2829=r2826;r2830=_i64Add(r2828,r2829,r2821,r2822);r2831=tempRet0;r2832=r2801-48|0;r2811=0;r2812=48;r2813=r2831;r2814=r2830;r2815=r2832}else{r2811=0;r2812=0;r2813=0;r2814=0;r2815=r2801}}while(0);r2833=__ZN9RCdecoder12decode_shiftEj(r2804,r2815);r2834=r2833;r2835=0;r2836=_bitshift64Shl(r2834,r2835,r2812);r2837=tempRet0;HEAPF64[tempDoublePtr>>3]=r2705;r2838=HEAP32[tempDoublePtr>>2];r2839=HEAP32[tempDoublePtr+4>>2];r2840=r2839>>>10|0<<22;r2841=0>>>10|0<<22;r2842=4194303;r2843=0;r2844=r2840^r2842;r2845=r2841^r2843;r2846=r2844>>>21|r2845<<11;r2847=r2845>>>21|0<<11;r2848=0;r2849=0;r2850=_i64Subtract(r2848,r2849,r2846,r2847);r2851=tempRet0;r2852=r2851>>>11|0<<21;r2853=0>>>11|0<<21;r2854=r2852^r2844;r2855=r2853^r2845;r2856=-1;r2857=-1;r2858=_bitshift64Shl(r2856,r2857,r2802);r2859=tempRet0;r2860=_i64Add(r2858,r2859,r2854,r2855);r2861=tempRet0;r2862=_i64Subtract(r2860,r2861,r2814,r2813);r2863=tempRet0;r2864=_i64Subtract(r2862,r2863,r2836,r2837);r2865=tempRet0;r2866=r2864>>>21|r2865<<11;r2867=r2865>>>21|0<<11;r2868=0;r2869=0;r2870=_i64Subtract(r2868,r2869,r2866,r2867);r2871=tempRet0;r2872=r2871>>>11|0<<21;r2873=0>>>11|0<<21;r2874=r2872^r2864;r2875=r2873^r2865;r2876=0<<10|0>>>22;r2877=r2874<<10|0>>>22;r2878=0;r2879=-1024;r2880=r2876^r2878;r2881=r2877^r2879;r2792=r2881;r2793=r2880}}while(0);r2882=(HEAP32[tempDoublePtr>>2]=r2793,HEAP32[tempDoublePtr+4>>2]=r2792,HEAPF64[tempDoublePtr>>3]);HEAPF64[r2643>>3]=r2882;r2883=r2641&r2598;r2884=r2609+(r2883<<3)|0;HEAPF64[r2884>>3]=r2882;r2885=r2643+8|0;r2886=r2641+1|0;r2887=r2642+1|0;r2888=r2887>>>0<r2581>>>0;if(r2888){r2641=r2886;r2642=r2887;r2643=r2885}else{r2639=r2886;r2640=r2885;break}}}r2889=r2634+1|0;r2890=r2889>>>0<r2582>>>0;if(r2890){r2633=r2639;r2634=r2889;r2635=r2640}else{r2631=r2639;r2632=r2640;break}}}r2891=r2621+1|0;r2892=r2891>>>0<r2583>>>0;if(r2892){r2620=r2631;r2621=r2891;r2622=r2632}else{break}}}r2893=(r2589|0)==0;if(!r2893){_free(r2589)}r2894=HEAP32[r26>>2];r2895=(r2894|0)==0;if(!r2895){r2896=r2894;r2897=HEAP32[r2896>>2];r2898=r2897+4|0;r2899=HEAP32[r2898>>2];FUNCTION_TABLE[r2899](r2894)}r2900=(r2608|0)==0;if(r2900){break L6}_free(r2608);break};case 24:{r2901=HEAP32[r41>>2];r2902=HEAP32[r42>>2];r2903=HEAP32[r43>>2];r2904=HEAP32[r44>>2];r2905=4;r2906=0;r2907=__Znwj(48);r2908=r2907;__ZN9RCqsmodelC2Ebjjj(r2908,0,49,16,1024);r2909=r2907;HEAP32[r25>>2]=r2909;r2910=__Znwj(12);r2911=r2910+4|0;r2912=r2911;HEAP32[r2912>>2]=r2901;r2913=r2910+8|0;r2914=r2913;HEAP32[r2914>>2]=r25;r2915=r2902+1|0;r2916=r2903+1|0;r2917=Math_imul(r2916,r2915)|0;r2918=r2917+r2915|0;r2919=r2918;while(1){r2920=r2919+1|0;r2921=r2920&r2919;r2922=(r2921|0)==0;r2923=r2920|r2919;if(r2922){break}else{r2919=r2923}}r2924=_llvm_umul_with_overflow_i32(r2920,8);r2925=tempRet0;r2926=r2925;r2927=r2924;r2928=r2926?-1:r2927;r2929=__Znwj(r2928);r2930=r2929;r2931=r2917;r2932=0;while(1){r2933=r2932+1|0;r2934=r2932&r2919;r2935=r2930+(r2934<<3)|0;HEAPF64[r2935>>3]=0;r2936=r2931-1|0;r2937=(r2936|0)==0;if(r2937){break}else{r2931=r2936;r2932=r2933}}r2938=(r2904|0)==0;if(!r2938){r2939=(r2903|0)==0;r2940=(r2902|0)==0;r2941=r2917;r2942=0;r2943=r76;while(1){r2944=r2915;r2945=r2941;while(1){r2946=r2945+1|0;r2947=r2945&r2919;r2948=r2930+(r2947<<3)|0;HEAPF64[r2948>>3]=0;r2949=r2944-1|0;r2950=(r2949|0)==0;if(r2950){break}else{r2944=r2949;r2945=r2946}}r2951=r2941+r2915|0;if(r2939){r2952=r2951;r2953=r2943}else{r2954=r2951;r2955=0;r2956=r2943;while(1){r2957=r2954&r2919;r2958=r2930+(r2957<<3)|0;HEAPF64[r2958>>3]=0;r2959=r2954+1|0;if(r2940){r2960=r2959;r2961=r2956}else{r2962=r2959;r2963=0;r2964=r2956;while(1){r2965=r2962-1|0;r2966=r2965&r2919;r2967=r2930+(r2966<<3)|0;r2968=HEAPF64[r2967>>3];r2969=r2967|0;r2970=HEAP32[r2969>>2];r2971=r2967+4|0;r2972=HEAP32[r2971>>2];r2973=r2962-r2915|0;r2974=r2973-r2917|0;r2975=r2974&r2919;r2976=r2930+(r2975<<3)|0;r2977=HEAPF64[r2976>>3];r2978=r2976|0;r2979=HEAP32[r2978>>2];r2980=r2976+4|0;r2981=HEAP32[r2980>>2];r2982=r2968-r2977;r2983=r2973&r2919;r2984=r2930+(r2983<<3)|0;r2985=HEAPF64[r2984>>3];r2986=r2984|0;r2987=HEAP32[r2986>>2];r2988=r2984+4|0;r2989=HEAP32[r2988>>2];r2990=r2982+r2985;r2991=r2965-r2917|0;r2992=r2991&r2919;r2993=r2930+(r2992<<3)|0;r2994=HEAPF64[r2993>>3];r2995=r2993|0;r2996=HEAP32[r2995>>2];r2997=r2993+4|0;r2998=HEAP32[r2997>>2];r2999=r2990-r2994;r3000=r2962-r2917|0;r3001=r3000&r2919;r3002=r2930+(r3001<<3)|0;r3003=HEAPF64[r3002>>3];r3004=r3002|0;r3005=HEAP32[r3004>>2];r3006=r3002+4|0;r3007=HEAP32[r3006>>2];r3008=r2999+r3003;r3009=r2965-r2915|0;r3010=r3009&r2919;r3011=r2930+(r3010<<3)|0;r3012=HEAPF64[r3011>>3];r3013=r3011|0;r3014=HEAP32[r3013>>2];r3015=r3011+4|0;r3016=HEAP32[r3015>>2];r3017=r3008-r3012;r3018=r3009-r2917|0;r3019=r3018&r2919;r3020=r2930+(r3019<<3)|0;r3021=HEAPF64[r3020>>3];r3022=r3020|0;r3023=HEAP32[r3022>>2];r3024=r3020+4|0;r3025=HEAP32[r3024>>2];r3026=r3017+r3021;r3027=HEAP32[r2912>>2];r3028=HEAP32[r2914>>2];r3029=HEAP32[r3028>>2];r3030=__ZN9RCdecoder6decodeEP7RCmodel(r3027,r3029);r3031=r3030>>>0>24;do{if(r3031){r3032=r3030-25|0;r3033=r3032;r3034=0;r3035=1;r3036=0;r3037=_bitshift64Shl(r3035,r3036,r3033);r3038=tempRet0;r3039=HEAP32[r2912>>2];r3040=r3032>>>0>16;do{if(r3040){r3041=__ZN9RCdecoder12decode_shiftEj(r3039,16);r3042=r3041;r3043=0;r3044=r3030-41|0;r3045=r3044>>>0>16;if(!r3045){r3046=0;r3047=16;r3048=r3043;r3049=r3042;r3050=r3044;break}r3051=__ZN9RCdecoder12decode_shiftEj(r3039,16);r3052=r3051;r3053=0;r3054=r3052<<16|0>>>16;r3055=r3053<<16|r3052>>>16;r3056=_i64Add(r3054,r3055,r3042,r3043);r3057=tempRet0;r3058=r3030-57|0;r3059=r3058>>>0>16;if(!r3059){r3046=0;r3047=32;r3048=r3057;r3049=r3056;r3050=r3058;break}r3060=__ZN9RCdecoder12decode_shiftEj(r3039,16);r3061=r3060;r3062=0;r3063=0;r3064=r3061;r3065=_i64Add(r3063,r3064,r3056,r3057);r3066=tempRet0;r3067=r3030-73|0;r3046=0;r3047=48;r3048=r3066;r3049=r3065;r3050=r3067}else{r3046=0;r3047=0;r3048=0;r3049=0;r3050=r3032}}while(0);r3068=__ZN9RCdecoder12decode_shiftEj(r3039,r3050);r3069=r3068;r3070=0;r3071=_bitshift64Shl(r3069,r3070,r3047);r3072=tempRet0;HEAPF64[tempDoublePtr>>3]=r3026;r3073=HEAP32[tempDoublePtr>>2];r3074=HEAP32[tempDoublePtr+4>>2];r3075=r3074>>>8|0<<24;r3076=0>>>8|0<<24;r3077=16777215;r3078=0;r3079=r3075^r3077;r3080=r3076^r3078;r3081=r3079>>>23|r3080<<9;r3082=r3080>>>23|0<<9;r3083=0;r3084=0;r3085=_i64Subtract(r3083,r3084,r3081,r3082);r3086=tempRet0;r3087=r3086>>>9|0<<23;r3088=0>>>9|0<<23;r3089=r3087^r3079;r3090=r3088^r3080;r3091=_i64Add(r3037,r3038,r3089,r3090);r3092=tempRet0;r3093=_i64Add(r3091,r3092,r3049,r3048);r3094=tempRet0;r3095=_i64Add(r3093,r3094,r3071,r3072);r3096=tempRet0;r3097=r3095>>>23|r3096<<9;r3098=r3096>>>23|0<<9;r3099=0;r3100=0;r3101=_i64Subtract(r3099,r3100,r3097,r3098);r3102=tempRet0;r3103=r3102>>>9|0<<23;r3104=0>>>9|0<<23;r3105=r3103^r3095;r3106=r3104^r3096;r3107=0<<8|0>>>24;r3108=r3105<<8|0>>>24;r3109=0;r3110=-256;r3111=r3107^r3109;r3112=r3108^r3110;r3113=r3112;r3114=r3111}else{r3115=r3030>>>0<24;if(!r3115){HEAPF64[tempDoublePtr>>3]=r3026;r3116=HEAP32[tempDoublePtr>>2];r3117=HEAP32[tempDoublePtr+4>>2];r3118=0;r3119=-256;r3120=r3116&r3118;r3121=r3117&r3119;r3113=r3121;r3114=r3120;break}r3122=23-r3030|0;r3123=r3122;r3124=0;r3125=HEAP32[r2912>>2];r3126=r3122>>>0>16;do{if(r3126){r3127=__ZN9RCdecoder12decode_shiftEj(r3125,16);r3128=r3127;r3129=0;r3130=r3122-16|0;r3131=r3130>>>0>16;if(!r3131){r3132=0;r3133=16;r3134=r3129;r3135=r3128;r3136=r3130;break}r3137=__ZN9RCdecoder12decode_shiftEj(r3125,16);r3138=r3137;r3139=0;r3140=r3138<<16|0>>>16;r3141=r3139<<16|r3138>>>16;r3142=_i64Add(r3140,r3141,r3128,r3129);r3143=tempRet0;r3144=r3122-32|0;r3145=r3144>>>0>16;if(!r3145){r3132=0;r3133=32;r3134=r3143;r3135=r3142;r3136=r3144;break}r3146=__ZN9RCdecoder12decode_shiftEj(r3125,16);r3147=r3146;r3148=0;r3149=0;r3150=r3147;r3151=_i64Add(r3149,r3150,r3142,r3143);r3152=tempRet0;r3153=r3122-48|0;r3132=0;r3133=48;r3134=r3152;r3135=r3151;r3136=r3153}else{r3132=0;r3133=0;r3134=0;r3135=0;r3136=r3122}}while(0);r3154=__ZN9RCdecoder12decode_shiftEj(r3125,r3136);r3155=r3154;r3156=0;r3157=_bitshift64Shl(r3155,r3156,r3133);r3158=tempRet0;HEAPF64[tempDoublePtr>>3]=r3026;r3159=HEAP32[tempDoublePtr>>2];r3160=HEAP32[tempDoublePtr+4>>2];r3161=r3160>>>8|0<<24;r3162=0>>>8|0<<24;r3163=16777215;r3164=0;r3165=r3161^r3163;r3166=r3162^r3164;r3167=r3165>>>23|r3166<<9;r3168=r3166>>>23|0<<9;r3169=0;r3170=0;r3171=_i64Subtract(r3169,r3170,r3167,r3168);r3172=tempRet0;r3173=r3172>>>9|0<<23;r3174=0>>>9|0<<23;r3175=r3173^r3165;r3176=r3174^r3166;r3177=-1;r3178=-1;r3179=_bitshift64Shl(r3177,r3178,r3123);r3180=tempRet0;r3181=_i64Add(r3179,r3180,r3175,r3176);r3182=tempRet0;r3183=_i64Subtract(r3181,r3182,r3135,r3134);r3184=tempRet0;r3185=_i64Subtract(r3183,r3184,r3157,r3158);r3186=tempRet0;r3187=r3185>>>23|r3186<<9;r3188=r3186>>>23|0<<9;r3189=0;r3190=0;r3191=_i64Subtract(r3189,r3190,r3187,r3188);r3192=tempRet0;r3193=r3192>>>9|0<<23;r3194=0>>>9|0<<23;r3195=r3193^r3185;r3196=r3194^r3186;r3197=0<<8|0>>>24;r3198=r3195<<8|0>>>24;r3199=0;r3200=-256;r3201=r3197^r3199;r3202=r3198^r3200;r3113=r3202;r3114=r3201}}while(0);r3203=(HEAP32[tempDoublePtr>>2]=r3114,HEAP32[tempDoublePtr+4>>2]=r3113,HEAPF64[tempDoublePtr>>3]);HEAPF64[r2964>>3]=r3203;r3204=r2962&r2919;r3205=r2930+(r3204<<3)|0;HEAPF64[r3205>>3]=r3203;r3206=r2964+8|0;r3207=r2962+1|0;r3208=r2963+1|0;r3209=r3208>>>0<r2902>>>0;if(r3209){r2962=r3207;r2963=r3208;r2964=r3206}else{r2960=r3207;r2961=r3206;break}}}r3210=r2955+1|0;r3211=r3210>>>0<r2903>>>0;if(r3211){r2954=r2960;r2955=r3210;r2956=r2961}else{r2952=r2960;r2953=r2961;break}}}r3212=r2942+1|0;r3213=r3212>>>0<r2904>>>0;if(r3213){r2941=r2952;r2942=r3212;r2943=r2953}else{break}}}r3214=(r2910|0)==0;if(!r3214){_free(r2910)}r3215=HEAP32[r25>>2];r3216=(r3215|0)==0;if(!r3216){r3217=r3215;r3218=HEAP32[r3217>>2];r3219=r3218+4|0;r3220=HEAP32[r3219>>2];FUNCTION_TABLE[r3220](r3215)}r3221=(r2929|0)==0;if(r3221){break L6}_free(r2929);break};case 26:{r3222=HEAP32[r41>>2];r3223=HEAP32[r42>>2];r3224=HEAP32[r43>>2];r3225=HEAP32[r44>>2];r3226=4;r3227=0;r3228=__Znwj(48);r3229=r3228;__ZN9RCqsmodelC2Ebjjj(r3229,0,53,16,1024);r3230=r3228;HEAP32[r24>>2]=r3230;r3231=__Znwj(12);r3232=r3231+4|0;r3233=r3232;HEAP32[r3233>>2]=r3222;r3234=r3231+8|0;r3235=r3234;HEAP32[r3235>>2]=r24;r3236=r3223+1|0;r3237=r3224+1|0;r3238=Math_imul(r3237,r3236)|0;r3239=r3238+r3236|0;r3240=r3239;while(1){r3241=r3240+1|0;r3242=r3241&r3240;r3243=(r3242|0)==0;r3244=r3241|r3240;if(r3243){break}else{r3240=r3244}}r3245=_llvm_umul_with_overflow_i32(r3241,8);r3246=tempRet0;r3247=r3246;r3248=r3245;r3249=r3247?-1:r3248;r3250=__Znwj(r3249);r3251=r3250;r3252=r3238;r3253=0;while(1){r3254=r3253+1|0;r3255=r3253&r3240;r3256=r3251+(r3255<<3)|0;HEAPF64[r3256>>3]=0;r3257=r3252-1|0;r3258=(r3257|0)==0;if(r3258){break}else{r3252=r3257;r3253=r3254}}r3259=(r3225|0)==0;if(!r3259){r3260=(r3224|0)==0;r3261=(r3223|0)==0;r3262=r3238;r3263=0;r3264=r76;while(1){r3265=r3236;r3266=r3262;while(1){r3267=r3266+1|0;r3268=r3266&r3240;r3269=r3251+(r3268<<3)|0;HEAPF64[r3269>>3]=0;r3270=r3265-1|0;r3271=(r3270|0)==0;if(r3271){break}else{r3265=r3270;r3266=r3267}}r3272=r3262+r3236|0;if(r3260){r3273=r3272;r3274=r3264}else{r3275=r3272;r3276=0;r3277=r3264;while(1){r3278=r3275&r3240;r3279=r3251+(r3278<<3)|0;HEAPF64[r3279>>3]=0;r3280=r3275+1|0;if(r3261){r3281=r3280;r3282=r3277}else{r3283=r3280;r3284=0;r3285=r3277;while(1){r3286=r3283-1|0;r3287=r3286&r3240;r3288=r3251+(r3287<<3)|0;r3289=HEAPF64[r3288>>3];r3290=r3288|0;r3291=HEAP32[r3290>>2];r3292=r3288+4|0;r3293=HEAP32[r3292>>2];r3294=r3283-r3236|0;r3295=r3294-r3238|0;r3296=r3295&r3240;r3297=r3251+(r3296<<3)|0;r3298=HEAPF64[r3297>>3];r3299=r3297|0;r3300=HEAP32[r3299>>2];r3301=r3297+4|0;r3302=HEAP32[r3301>>2];r3303=r3289-r3298;r3304=r3294&r3240;r3305=r3251+(r3304<<3)|0;r3306=HEAPF64[r3305>>3];r3307=r3305|0;r3308=HEAP32[r3307>>2];r3309=r3305+4|0;r3310=HEAP32[r3309>>2];r3311=r3303+r3306;r3312=r3286-r3238|0;r3313=r3312&r3240;r3314=r3251+(r3313<<3)|0;r3315=HEAPF64[r3314>>3];r3316=r3314|0;r3317=HEAP32[r3316>>2];r3318=r3314+4|0;r3319=HEAP32[r3318>>2];r3320=r3311-r3315;r3321=r3283-r3238|0;r3322=r3321&r3240;r3323=r3251+(r3322<<3)|0;r3324=HEAPF64[r3323>>3];r3325=r3323|0;r3326=HEAP32[r3325>>2];r3327=r3323+4|0;r3328=HEAP32[r3327>>2];r3329=r3320+r3324;r3330=r3286-r3236|0;r3331=r3330&r3240;r3332=r3251+(r3331<<3)|0;r3333=HEAPF64[r3332>>3];r3334=r3332|0;r3335=HEAP32[r3334>>2];r3336=r3332+4|0;r3337=HEAP32[r3336>>2];r3338=r3329-r3333;r3339=r3330-r3238|0;r3340=r3339&r3240;r3341=r3251+(r3340<<3)|0;r3342=HEAPF64[r3341>>3];r3343=r3341|0;r3344=HEAP32[r3343>>2];r3345=r3341+4|0;r3346=HEAP32[r3345>>2];r3347=r3338+r3342;r3348=HEAP32[r3233>>2];r3349=HEAP32[r3235>>2];r3350=HEAP32[r3349>>2];r3351=__ZN9RCdecoder6decodeEP7RCmodel(r3348,r3350);r3352=r3351>>>0>26;do{if(r3352){r3353=r3351-27|0;r3354=r3353;r3355=0;r3356=1;r3357=0;r3358=_bitshift64Shl(r3356,r3357,r3354);r3359=tempRet0;r3360=HEAP32[r3233>>2];r3361=r3353>>>0>16;do{if(r3361){r3362=__ZN9RCdecoder12decode_shiftEj(r3360,16);r3363=r3362;r3364=0;r3365=r3351-43|0;r3366=r3365>>>0>16;if(!r3366){r3367=0;r3368=16;r3369=r3364;r3370=r3363;r3371=r3365;break}r3372=__ZN9RCdecoder12decode_shiftEj(r3360,16);r3373=r3372;r3374=0;r3375=r3373<<16|0>>>16;r3376=r3374<<16|r3373>>>16;r3377=_i64Add(r3375,r3376,r3363,r3364);r3378=tempRet0;r3379=r3351-59|0;r3380=r3379>>>0>16;if(!r3380){r3367=0;r3368=32;r3369=r3378;r3370=r3377;r3371=r3379;break}r3381=__ZN9RCdecoder12decode_shiftEj(r3360,16);r3382=r3381;r3383=0;r3384=0;r3385=r3382;r3386=_i64Add(r3384,r3385,r3377,r3378);r3387=tempRet0;r3388=r3351-75|0;r3367=0;r3368=48;r3369=r3387;r3370=r3386;r3371=r3388}else{r3367=0;r3368=0;r3369=0;r3370=0;r3371=r3353}}while(0);r3389=__ZN9RCdecoder12decode_shiftEj(r3360,r3371);r3390=r3389;r3391=0;r3392=_bitshift64Shl(r3390,r3391,r3368);r3393=tempRet0;HEAPF64[tempDoublePtr>>3]=r3347;r3394=HEAP32[tempDoublePtr>>2];r3395=HEAP32[tempDoublePtr+4>>2];r3396=r3395>>>6|0<<26;r3397=0>>>6|0<<26;r3398=67108863;r3399=0;r3400=r3396^r3398;r3401=r3397^r3399;r3402=r3400>>>25|r3401<<7;r3403=r3401>>>25|0<<7;r3404=0;r3405=0;r3406=_i64Subtract(r3404,r3405,r3402,r3403);r3407=tempRet0;r3408=r3407>>>7|0<<25;r3409=0>>>7|0<<25;r3410=r3408^r3400;r3411=r3409^r3401;r3412=_i64Add(r3358,r3359,r3410,r3411);r3413=tempRet0;r3414=_i64Add(r3412,r3413,r3370,r3369);r3415=tempRet0;r3416=_i64Add(r3414,r3415,r3392,r3393);r3417=tempRet0;r3418=r3416>>>25|r3417<<7;r3419=r3417>>>25|0<<7;r3420=0;r3421=0;r3422=_i64Subtract(r3420,r3421,r3418,r3419);r3423=tempRet0;r3424=r3423>>>7|0<<25;r3425=0>>>7|0<<25;r3426=r3424^r3416;r3427=r3425^r3417;r3428=0<<6|0>>>26;r3429=r3426<<6|0>>>26;r3430=0;r3431=-64;r3432=r3428^r3430;r3433=r3429^r3431;r3434=r3433;r3435=r3432}else{r3436=r3351>>>0<26;if(!r3436){HEAPF64[tempDoublePtr>>3]=r3347;r3437=HEAP32[tempDoublePtr>>2];r3438=HEAP32[tempDoublePtr+4>>2];r3439=0;r3440=-64;r3441=r3437&r3439;r3442=r3438&r3440;r3434=r3442;r3435=r3441;break}r3443=25-r3351|0;r3444=r3443;r3445=0;r3446=HEAP32[r3233>>2];r3447=r3443>>>0>16;do{if(r3447){r3448=__ZN9RCdecoder12decode_shiftEj(r3446,16);r3449=r3448;r3450=0;r3451=r3443-16|0;r3452=r3451>>>0>16;if(!r3452){r3453=0;r3454=16;r3455=r3450;r3456=r3449;r3457=r3451;break}r3458=__ZN9RCdecoder12decode_shiftEj(r3446,16);r3459=r3458;r3460=0;r3461=r3459<<16|0>>>16;r3462=r3460<<16|r3459>>>16;r3463=_i64Add(r3461,r3462,r3449,r3450);r3464=tempRet0;r3465=r3443-32|0;r3466=r3465>>>0>16;if(!r3466){r3453=0;r3454=32;r3455=r3464;r3456=r3463;r3457=r3465;break}r3467=__ZN9RCdecoder12decode_shiftEj(r3446,16);r3468=r3467;r3469=0;r3470=0;r3471=r3468;r3472=_i64Add(r3470,r3471,r3463,r3464);r3473=tempRet0;r3474=r3443-48|0;r3453=0;r3454=48;r3455=r3473;r3456=r3472;r3457=r3474}else{r3453=0;r3454=0;r3455=0;r3456=0;r3457=r3443}}while(0);r3475=__ZN9RCdecoder12decode_shiftEj(r3446,r3457);r3476=r3475;r3477=0;r3478=_bitshift64Shl(r3476,r3477,r3454);r3479=tempRet0;HEAPF64[tempDoublePtr>>3]=r3347;r3480=HEAP32[tempDoublePtr>>2];r3481=HEAP32[tempDoublePtr+4>>2];r3482=r3481>>>6|0<<26;r3483=0>>>6|0<<26;r3484=67108863;r3485=0;r3486=r3482^r3484;r3487=r3483^r3485;r3488=r3486>>>25|r3487<<7;r3489=r3487>>>25|0<<7;r3490=0;r3491=0;r3492=_i64Subtract(r3490,r3491,r3488,r3489);r3493=tempRet0;r3494=r3493>>>7|0<<25;r3495=0>>>7|0<<25;r3496=r3494^r3486;r3497=r3495^r3487;r3498=-1;r3499=-1;r3500=_bitshift64Shl(r3498,r3499,r3444);r3501=tempRet0;r3502=_i64Add(r3500,r3501,r3496,r3497);r3503=tempRet0;r3504=_i64Subtract(r3502,r3503,r3456,r3455);r3505=tempRet0;r3506=_i64Subtract(r3504,r3505,r3478,r3479);r3507=tempRet0;r3508=r3506>>>25|r3507<<7;r3509=r3507>>>25|0<<7;r3510=0;r3511=0;r3512=_i64Subtract(r3510,r3511,r3508,r3509);r3513=tempRet0;r3514=r3513>>>7|0<<25;r3515=0>>>7|0<<25;r3516=r3514^r3506;r3517=r3515^r3507;r3518=0<<6|0>>>26;r3519=r3516<<6|0>>>26;r3520=0;r3521=-64;r3522=r3518^r3520;r3523=r3519^r3521;r3434=r3523;r3435=r3522}}while(0);r3524=(HEAP32[tempDoublePtr>>2]=r3435,HEAP32[tempDoublePtr+4>>2]=r3434,HEAPF64[tempDoublePtr>>3]);HEAPF64[r3285>>3]=r3524;r3525=r3283&r3240;r3526=r3251+(r3525<<3)|0;HEAPF64[r3526>>3]=r3524;r3527=r3285+8|0;r3528=r3283+1|0;r3529=r3284+1|0;r3530=r3529>>>0<r3223>>>0;if(r3530){r3283=r3528;r3284=r3529;r3285=r3527}else{r3281=r3528;r3282=r3527;break}}}r3531=r3276+1|0;r3532=r3531>>>0<r3224>>>0;if(r3532){r3275=r3281;r3276=r3531;r3277=r3282}else{r3273=r3281;r3274=r3282;break}}}r3533=r3263+1|0;r3534=r3533>>>0<r3225>>>0;if(r3534){r3262=r3273;r3263=r3533;r3264=r3274}else{break}}}r3535=(r3231|0)==0;if(!r3535){_free(r3231)}r3536=HEAP32[r24>>2];r3537=(r3536|0)==0;if(!r3537){r3538=r3536;r3539=HEAP32[r3538>>2];r3540=r3539+4|0;r3541=HEAP32[r3540>>2];FUNCTION_TABLE[r3541](r3536)}r3542=(r3250|0)==0;if(r3542){break L6}_free(r3250);break};case 28:{r3543=HEAP32[r41>>2];r3544=HEAP32[r42>>2];r3545=HEAP32[r43>>2];r3546=HEAP32[r44>>2];r3547=4;r3548=0;r3549=__Znwj(48);r3550=r3549;__ZN9RCqsmodelC2Ebjjj(r3550,0,57,16,1024);r3551=r3549;HEAP32[r23>>2]=r3551;r3552=__Znwj(12);r3553=r3552+4|0;r3554=r3553;HEAP32[r3554>>2]=r3543;r3555=r3552+8|0;r3556=r3555;HEAP32[r3556>>2]=r23;r3557=r3544+1|0;r3558=r3545+1|0;r3559=Math_imul(r3558,r3557)|0;r3560=r3559+r3557|0;r3561=r3560;while(1){r3562=r3561+1|0;r3563=r3562&r3561;r3564=(r3563|0)==0;r3565=r3562|r3561;if(r3564){break}else{r3561=r3565}}r3566=_llvm_umul_with_overflow_i32(r3562,8);r3567=tempRet0;r3568=r3567;r3569=r3566;r3570=r3568?-1:r3569;r3571=__Znwj(r3570);r3572=r3571;r3573=r3559;r3574=0;while(1){r3575=r3574+1|0;r3576=r3574&r3561;r3577=r3572+(r3576<<3)|0;HEAPF64[r3577>>3]=0;r3578=r3573-1|0;r3579=(r3578|0)==0;if(r3579){break}else{r3573=r3578;r3574=r3575}}r3580=(r3546|0)==0;if(!r3580){r3581=(r3545|0)==0;r3582=(r3544|0)==0;r3583=r3559;r3584=0;r3585=r76;while(1){r3586=r3557;r3587=r3583;while(1){r3588=r3587+1|0;r3589=r3587&r3561;r3590=r3572+(r3589<<3)|0;HEAPF64[r3590>>3]=0;r3591=r3586-1|0;r3592=(r3591|0)==0;if(r3592){break}else{r3586=r3591;r3587=r3588}}r3593=r3583+r3557|0;if(r3581){r3594=r3593;r3595=r3585}else{r3596=r3593;r3597=0;r3598=r3585;while(1){r3599=r3596&r3561;r3600=r3572+(r3599<<3)|0;HEAPF64[r3600>>3]=0;r3601=r3596+1|0;if(r3582){r3602=r3601;r3603=r3598}else{r3604=r3601;r3605=0;r3606=r3598;while(1){r3607=r3604-1|0;r3608=r3607&r3561;r3609=r3572+(r3608<<3)|0;r3610=HEAPF64[r3609>>3];r3611=r3609|0;r3612=HEAP32[r3611>>2];r3613=r3609+4|0;r3614=HEAP32[r3613>>2];r3615=r3604-r3557|0;r3616=r3615-r3559|0;r3617=r3616&r3561;r3618=r3572+(r3617<<3)|0;r3619=HEAPF64[r3618>>3];r3620=r3618|0;r3621=HEAP32[r3620>>2];r3622=r3618+4|0;r3623=HEAP32[r3622>>2];r3624=r3610-r3619;r3625=r3615&r3561;r3626=r3572+(r3625<<3)|0;r3627=HEAPF64[r3626>>3];r3628=r3626|0;r3629=HEAP32[r3628>>2];r3630=r3626+4|0;r3631=HEAP32[r3630>>2];r3632=r3624+r3627;r3633=r3607-r3559|0;r3634=r3633&r3561;r3635=r3572+(r3634<<3)|0;r3636=HEAPF64[r3635>>3];r3637=r3635|0;r3638=HEAP32[r3637>>2];r3639=r3635+4|0;r3640=HEAP32[r3639>>2];r3641=r3632-r3636;r3642=r3604-r3559|0;r3643=r3642&r3561;r3644=r3572+(r3643<<3)|0;r3645=HEAPF64[r3644>>3];r3646=r3644|0;r3647=HEAP32[r3646>>2];r3648=r3644+4|0;r3649=HEAP32[r3648>>2];r3650=r3641+r3645;r3651=r3607-r3557|0;r3652=r3651&r3561;r3653=r3572+(r3652<<3)|0;r3654=HEAPF64[r3653>>3];r3655=r3653|0;r3656=HEAP32[r3655>>2];r3657=r3653+4|0;r3658=HEAP32[r3657>>2];r3659=r3650-r3654;r3660=r3651-r3559|0;r3661=r3660&r3561;r3662=r3572+(r3661<<3)|0;r3663=HEAPF64[r3662>>3];r3664=r3662|0;r3665=HEAP32[r3664>>2];r3666=r3662+4|0;r3667=HEAP32[r3666>>2];r3668=r3659+r3663;r3669=HEAP32[r3554>>2];r3670=HEAP32[r3556>>2];r3671=HEAP32[r3670>>2];r3672=__ZN9RCdecoder6decodeEP7RCmodel(r3669,r3671);r3673=r3672>>>0>28;do{if(r3673){r3674=r3672-29|0;r3675=r3674;r3676=0;r3677=1;r3678=0;r3679=_bitshift64Shl(r3677,r3678,r3675);r3680=tempRet0;r3681=HEAP32[r3554>>2];r3682=r3674>>>0>16;do{if(r3682){r3683=__ZN9RCdecoder12decode_shiftEj(r3681,16);r3684=r3683;r3685=0;r3686=r3672-45|0;r3687=r3686>>>0>16;if(!r3687){r3688=0;r3689=16;r3690=r3685;r3691=r3684;r3692=r3686;break}r3693=__ZN9RCdecoder12decode_shiftEj(r3681,16);r3694=r3693;r3695=0;r3696=r3694<<16|0>>>16;r3697=r3695<<16|r3694>>>16;r3698=_i64Add(r3696,r3697,r3684,r3685);r3699=tempRet0;r3700=r3672-61|0;r3701=r3700>>>0>16;if(!r3701){r3688=0;r3689=32;r3690=r3699;r3691=r3698;r3692=r3700;break}r3702=__ZN9RCdecoder12decode_shiftEj(r3681,16);r3703=r3702;r3704=0;r3705=0;r3706=r3703;r3707=_i64Add(r3705,r3706,r3698,r3699);r3708=tempRet0;r3709=r3672-77|0;r3688=0;r3689=48;r3690=r3708;r3691=r3707;r3692=r3709}else{r3688=0;r3689=0;r3690=0;r3691=0;r3692=r3674}}while(0);r3710=__ZN9RCdecoder12decode_shiftEj(r3681,r3692);r3711=r3710;r3712=0;r3713=_bitshift64Shl(r3711,r3712,r3689);r3714=tempRet0;HEAPF64[tempDoublePtr>>3]=r3668;r3715=HEAP32[tempDoublePtr>>2];r3716=HEAP32[tempDoublePtr+4>>2];r3717=r3716>>>4|0<<28;r3718=0>>>4|0<<28;r3719=268435455;r3720=0;r3721=r3717^r3719;r3722=r3718^r3720;r3723=r3721>>>27|r3722<<5;r3724=r3722>>>27|0<<5;r3725=0;r3726=0;r3727=_i64Subtract(r3725,r3726,r3723,r3724);r3728=tempRet0;r3729=r3728>>>5|0<<27;r3730=0>>>5|0<<27;r3731=r3729^r3721;r3732=r3730^r3722;r3733=_i64Add(r3679,r3680,r3731,r3732);r3734=tempRet0;r3735=_i64Add(r3733,r3734,r3691,r3690);r3736=tempRet0;r3737=_i64Add(r3735,r3736,r3713,r3714);r3738=tempRet0;r3739=r3737>>>27|r3738<<5;r3740=r3738>>>27|0<<5;r3741=0;r3742=0;r3743=_i64Subtract(r3741,r3742,r3739,r3740);r3744=tempRet0;r3745=r3744>>>5|0<<27;r3746=0>>>5|0<<27;r3747=r3745^r3737;r3748=r3746^r3738;r3749=0<<4|0>>>28;r3750=r3747<<4|0>>>28;r3751=0;r3752=-16;r3753=r3749^r3751;r3754=r3750^r3752;r3755=r3754;r3756=r3753}else{r3757=r3672>>>0<28;if(!r3757){HEAPF64[tempDoublePtr>>3]=r3668;r3758=HEAP32[tempDoublePtr>>2];r3759=HEAP32[tempDoublePtr+4>>2];r3760=0;r3761=-16;r3762=r3758&r3760;r3763=r3759&r3761;r3755=r3763;r3756=r3762;break}r3764=27-r3672|0;r3765=r3764;r3766=0;r3767=HEAP32[r3554>>2];r3768=r3764>>>0>16;do{if(r3768){r3769=__ZN9RCdecoder12decode_shiftEj(r3767,16);r3770=r3769;r3771=0;r3772=r3764-16|0;r3773=r3772>>>0>16;if(!r3773){r3774=0;r3775=16;r3776=r3771;r3777=r3770;r3778=r3772;break}r3779=__ZN9RCdecoder12decode_shiftEj(r3767,16);r3780=r3779;r3781=0;r3782=r3780<<16|0>>>16;r3783=r3781<<16|r3780>>>16;r3784=_i64Add(r3782,r3783,r3770,r3771);r3785=tempRet0;r3786=r3764-32|0;r3787=r3786>>>0>16;if(!r3787){r3774=0;r3775=32;r3776=r3785;r3777=r3784;r3778=r3786;break}r3788=__ZN9RCdecoder12decode_shiftEj(r3767,16);r3789=r3788;r3790=0;r3791=0;r3792=r3789;r3793=_i64Add(r3791,r3792,r3784,r3785);r3794=tempRet0;r3795=r3764-48|0;r3774=0;r3775=48;r3776=r3794;r3777=r3793;r3778=r3795}else{r3774=0;r3775=0;r3776=0;r3777=0;r3778=r3764}}while(0);r3796=__ZN9RCdecoder12decode_shiftEj(r3767,r3778);r3797=r3796;r3798=0;r3799=_bitshift64Shl(r3797,r3798,r3775);r3800=tempRet0;HEAPF64[tempDoublePtr>>3]=r3668;r3801=HEAP32[tempDoublePtr>>2];r3802=HEAP32[tempDoublePtr+4>>2];r3803=r3802>>>4|0<<28;r3804=0>>>4|0<<28;r3805=268435455;r3806=0;r3807=r3803^r3805;r3808=r3804^r3806;r3809=r3807>>>27|r3808<<5;r3810=r3808>>>27|0<<5;r3811=0;r3812=0;r3813=_i64Subtract(r3811,r3812,r3809,r3810);r3814=tempRet0;r3815=r3814>>>5|0<<27;r3816=0>>>5|0<<27;r3817=r3815^r3807;r3818=r3816^r3808;r3819=-1;r3820=-1;r3821=_bitshift64Shl(r3819,r3820,r3765);r3822=tempRet0;r3823=_i64Add(r3821,r3822,r3817,r3818);r3824=tempRet0;r3825=_i64Subtract(r3823,r3824,r3777,r3776);r3826=tempRet0;r3827=_i64Subtract(r3825,r3826,r3799,r3800);r3828=tempRet0;r3829=r3827>>>27|r3828<<5;r3830=r3828>>>27|0<<5;r3831=0;r3832=0;r3833=_i64Subtract(r3831,r3832,r3829,r3830);r3834=tempRet0;r3835=r3834>>>5|0<<27;r3836=0>>>5|0<<27;r3837=r3835^r3827;r3838=r3836^r3828;r3839=0<<4|0>>>28;r3840=r3837<<4|0>>>28;r3841=0;r3842=-16;r3843=r3839^r3841;r3844=r3840^r3842;r3755=r3844;r3756=r3843}}while(0);r3845=(HEAP32[tempDoublePtr>>2]=r3756,HEAP32[tempDoublePtr+4>>2]=r3755,HEAPF64[tempDoublePtr>>3]);HEAPF64[r3606>>3]=r3845;r3846=r3604&r3561;r3847=r3572+(r3846<<3)|0;HEAPF64[r3847>>3]=r3845;r3848=r3606+8|0;r3849=r3604+1|0;r3850=r3605+1|0;r3851=r3850>>>0<r3544>>>0;if(r3851){r3604=r3849;r3605=r3850;r3606=r3848}else{r3602=r3849;r3603=r3848;break}}}r3852=r3597+1|0;r3853=r3852>>>0<r3545>>>0;if(r3853){r3596=r3602;r3597=r3852;r3598=r3603}else{r3594=r3602;r3595=r3603;break}}}r3854=r3584+1|0;r3855=r3854>>>0<r3546>>>0;if(r3855){r3583=r3594;r3584=r3854;r3585=r3595}else{break}}}r3856=(r3552|0)==0;if(!r3856){_free(r3552)}r3857=HEAP32[r23>>2];r3858=(r3857|0)==0;if(!r3858){r3859=r3857;r3860=HEAP32[r3859>>2];r3861=r3860+4|0;r3862=HEAP32[r3861>>2];FUNCTION_TABLE[r3862](r3857)}r3863=(r3571|0)==0;if(r3863){break L6}_free(r3571);break};case 30:{r3864=HEAP32[r41>>2];r3865=HEAP32[r42>>2];r3866=HEAP32[r43>>2];r3867=HEAP32[r44>>2];r3868=4;r3869=0;r3870=__Znwj(48);r3871=r3870;__ZN9RCqsmodelC2Ebjjj(r3871,0,61,16,1024);r3872=r3870;HEAP32[r22>>2]=r3872;r3873=__Znwj(12);r3874=r3873+4|0;r3875=r3874;HEAP32[r3875>>2]=r3864;r3876=r3873+8|0;r3877=r3876;HEAP32[r3877>>2]=r22;r3878=r3865+1|0;r3879=r3866+1|0;r3880=Math_imul(r3879,r3878)|0;r3881=r3880+r3878|0;r3882=r3881;while(1){r3883=r3882+1|0;r3884=r3883&r3882;r3885=(r3884|0)==0;r3886=r3883|r3882;if(r3885){break}else{r3882=r3886}}r3887=_llvm_umul_with_overflow_i32(r3883,8);r3888=tempRet0;r3889=r3888;r3890=r3887;r3891=r3889?-1:r3890;r3892=__Znwj(r3891);r3893=r3892;r3894=r3880;r3895=0;while(1){r3896=r3895+1|0;r3897=r3895&r3882;r3898=r3893+(r3897<<3)|0;HEAPF64[r3898>>3]=0;r3899=r3894-1|0;r3900=(r3899|0)==0;if(r3900){break}else{r3894=r3899;r3895=r3896}}r3901=(r3867|0)==0;if(!r3901){r3902=(r3866|0)==0;r3903=(r3865|0)==0;r3904=r3880;r3905=0;r3906=r76;while(1){r3907=r3878;r3908=r3904;while(1){r3909=r3908+1|0;r3910=r3908&r3882;r3911=r3893+(r3910<<3)|0;HEAPF64[r3911>>3]=0;r3912=r3907-1|0;r3913=(r3912|0)==0;if(r3913){break}else{r3907=r3912;r3908=r3909}}r3914=r3904+r3878|0;if(r3902){r3915=r3914;r3916=r3906}else{r3917=r3914;r3918=0;r3919=r3906;while(1){r3920=r3917&r3882;r3921=r3893+(r3920<<3)|0;HEAPF64[r3921>>3]=0;r3922=r3917+1|0;if(r3903){r3923=r3922;r3924=r3919}else{r3925=r3922;r3926=0;r3927=r3919;while(1){r3928=r3925-1|0;r3929=r3928&r3882;r3930=r3893+(r3929<<3)|0;r3931=HEAPF64[r3930>>3];r3932=r3930|0;r3933=HEAP32[r3932>>2];r3934=r3930+4|0;r3935=HEAP32[r3934>>2];r3936=r3925-r3878|0;r3937=r3936-r3880|0;r3938=r3937&r3882;r3939=r3893+(r3938<<3)|0;r3940=HEAPF64[r3939>>3];r3941=r3939|0;r3942=HEAP32[r3941>>2];r3943=r3939+4|0;r3944=HEAP32[r3943>>2];r3945=r3931-r3940;r3946=r3936&r3882;r3947=r3893+(r3946<<3)|0;r3948=HEAPF64[r3947>>3];r3949=r3947|0;r3950=HEAP32[r3949>>2];r3951=r3947+4|0;r3952=HEAP32[r3951>>2];r3953=r3945+r3948;r3954=r3928-r3880|0;r3955=r3954&r3882;r3956=r3893+(r3955<<3)|0;r3957=HEAPF64[r3956>>3];r3958=r3956|0;r3959=HEAP32[r3958>>2];r3960=r3956+4|0;r3961=HEAP32[r3960>>2];r3962=r3953-r3957;r3963=r3925-r3880|0;r3964=r3963&r3882;r3965=r3893+(r3964<<3)|0;r3966=HEAPF64[r3965>>3];r3967=r3965|0;r3968=HEAP32[r3967>>2];r3969=r3965+4|0;r3970=HEAP32[r3969>>2];r3971=r3962+r3966;r3972=r3928-r3878|0;r3973=r3972&r3882;r3974=r3893+(r3973<<3)|0;r3975=HEAPF64[r3974>>3];r3976=r3974|0;r3977=HEAP32[r3976>>2];r3978=r3974+4|0;r3979=HEAP32[r3978>>2];r3980=r3971-r3975;r3981=r3972-r3880|0;r3982=r3981&r3882;r3983=r3893+(r3982<<3)|0;r3984=HEAPF64[r3983>>3];r3985=r3983|0;r3986=HEAP32[r3985>>2];r3987=r3983+4|0;r3988=HEAP32[r3987>>2];r3989=r3980+r3984;r3990=HEAP32[r3875>>2];r3991=HEAP32[r3877>>2];r3992=HEAP32[r3991>>2];r3993=__ZN9RCdecoder6decodeEP7RCmodel(r3990,r3992);r3994=r3993>>>0>30;do{if(r3994){r3995=r3993-31|0;r3996=r3995;r3997=0;r3998=1;r3999=0;r4000=_bitshift64Shl(r3998,r3999,r3996);r4001=tempRet0;r4002=HEAP32[r3875>>2];r4003=r3995>>>0>16;do{if(r4003){r4004=__ZN9RCdecoder12decode_shiftEj(r4002,16);r4005=r4004;r4006=0;r4007=r3993-47|0;r4008=r4007>>>0>16;if(!r4008){r4009=0;r4010=16;r4011=r4006;r4012=r4005;r4013=r4007;break}r4014=__ZN9RCdecoder12decode_shiftEj(r4002,16);r4015=r4014;r4016=0;r4017=r4015<<16|0>>>16;r4018=r4016<<16|r4015>>>16;r4019=_i64Add(r4017,r4018,r4005,r4006);r4020=tempRet0;r4021=r3993-63|0;r4022=r4021>>>0>16;if(!r4022){r4009=0;r4010=32;r4011=r4020;r4012=r4019;r4013=r4021;break}r4023=__ZN9RCdecoder12decode_shiftEj(r4002,16);r4024=r4023;r4025=0;r4026=0;r4027=r4024;r4028=_i64Add(r4026,r4027,r4019,r4020);r4029=tempRet0;r4030=r3993-79|0;r4009=0;r4010=48;r4011=r4029;r4012=r4028;r4013=r4030}else{r4009=0;r4010=0;r4011=0;r4012=0;r4013=r3995}}while(0);r4031=__ZN9RCdecoder12decode_shiftEj(r4002,r4013);r4032=r4031;r4033=0;r4034=_bitshift64Shl(r4032,r4033,r4010);r4035=tempRet0;HEAPF64[tempDoublePtr>>3]=r3989;r4036=HEAP32[tempDoublePtr>>2];r4037=HEAP32[tempDoublePtr+4>>2];r4038=r4037>>>2|0<<30;r4039=0>>>2|0<<30;r4040=1073741823;r4041=0;r4042=r4038^r4040;r4043=r4039^r4041;r4044=r4042>>>29|r4043<<3;r4045=r4043>>>29|0<<3;r4046=0;r4047=0;r4048=_i64Subtract(r4046,r4047,r4044,r4045);r4049=tempRet0;r4050=r4049>>>3|0<<29;r4051=0>>>3|0<<29;r4052=r4050^r4042;r4053=r4051^r4043;r4054=_i64Add(r4000,r4001,r4052,r4053);r4055=tempRet0;r4056=_i64Add(r4054,r4055,r4012,r4011);r4057=tempRet0;r4058=_i64Add(r4056,r4057,r4034,r4035);r4059=tempRet0;r4060=r4058>>>29|r4059<<3;r4061=r4059>>>29|0<<3;r4062=0;r4063=0;r4064=_i64Subtract(r4062,r4063,r4060,r4061);r4065=tempRet0;r4066=r4065>>>3|0<<29;r4067=0>>>3|0<<29;r4068=r4066^r4058;r4069=r4067^r4059;r4070=0<<2|0>>>30;r4071=r4068<<2|0>>>30;r4072=0;r4073=-4;r4074=r4070^r4072;r4075=r4071^r4073;r4076=r4075;r4077=r4074}else{r4078=r3993>>>0<30;if(!r4078){HEAPF64[tempDoublePtr>>3]=r3989;r4079=HEAP32[tempDoublePtr>>2];r4080=HEAP32[tempDoublePtr+4>>2];r4081=0;r4082=-4;r4083=r4079&r4081;r4084=r4080&r4082;r4076=r4084;r4077=r4083;break}r4085=29-r3993|0;r4086=r4085;r4087=0;r4088=HEAP32[r3875>>2];r4089=r4085>>>0>16;do{if(r4089){r4090=__ZN9RCdecoder12decode_shiftEj(r4088,16);r4091=r4090;r4092=0;r4093=r4085-16|0;r4094=r4093>>>0>16;if(!r4094){r4095=0;r4096=16;r4097=r4092;r4098=r4091;r4099=r4093;break}r4100=__ZN9RCdecoder12decode_shiftEj(r4088,16);r4101=r4100;r4102=0;r4103=r4101<<16|0>>>16;r4104=r4102<<16|r4101>>>16;r4105=_i64Add(r4103,r4104,r4091,r4092);r4106=tempRet0;r4107=r4085-32|0;r4108=r4107>>>0>16;if(!r4108){r4095=0;r4096=32;r4097=r4106;r4098=r4105;r4099=r4107;break}r4109=__ZN9RCdecoder12decode_shiftEj(r4088,16);r4110=r4109;r4111=0;r4112=0;r4113=r4110;r4114=_i64Add(r4112,r4113,r4105,r4106);r4115=tempRet0;r4116=r4085-48|0;r4095=0;r4096=48;r4097=r4115;r4098=r4114;r4099=r4116}else{r4095=0;r4096=0;r4097=0;r4098=0;r4099=r4085}}while(0);r4117=__ZN9RCdecoder12decode_shiftEj(r4088,r4099);r4118=r4117;r4119=0;r4120=_bitshift64Shl(r4118,r4119,r4096);r4121=tempRet0;HEAPF64[tempDoublePtr>>3]=r3989;r4122=HEAP32[tempDoublePtr>>2];r4123=HEAP32[tempDoublePtr+4>>2];r4124=r4123>>>2|0<<30;r4125=0>>>2|0<<30;r4126=1073741823;r4127=0;r4128=r4124^r4126;r4129=r4125^r4127;r4130=r4128>>>29|r4129<<3;r4131=r4129>>>29|0<<3;r4132=0;r4133=0;r4134=_i64Subtract(r4132,r4133,r4130,r4131);r4135=tempRet0;r4136=r4135>>>3|0<<29;r4137=0>>>3|0<<29;r4138=r4136^r4128;r4139=r4137^r4129;r4140=-1;r4141=-1;r4142=_bitshift64Shl(r4140,r4141,r4086);r4143=tempRet0;r4144=_i64Add(r4142,r4143,r4138,r4139);r4145=tempRet0;r4146=_i64Subtract(r4144,r4145,r4098,r4097);r4147=tempRet0;r4148=_i64Subtract(r4146,r4147,r4120,r4121);r4149=tempRet0;r4150=r4148>>>29|r4149<<3;r4151=r4149>>>29|0<<3;r4152=0;r4153=0;r4154=_i64Subtract(r4152,r4153,r4150,r4151);r4155=tempRet0;r4156=r4155>>>3|0<<29;r4157=0>>>3|0<<29;r4158=r4156^r4148;r4159=r4157^r4149;r4160=0<<2|0>>>30;r4161=r4158<<2|0>>>30;r4162=0;r4163=-4;r4164=r4160^r4162;r4165=r4161^r4163;r4076=r4165;r4077=r4164}}while(0);r4166=(HEAP32[tempDoublePtr>>2]=r4077,HEAP32[tempDoublePtr+4>>2]=r4076,HEAPF64[tempDoublePtr>>3]);HEAPF64[r3927>>3]=r4166;r4167=r3925&r3882;r4168=r3893+(r4167<<3)|0;HEAPF64[r4168>>3]=r4166;r4169=r3927+8|0;r4170=r3925+1|0;r4171=r3926+1|0;r4172=r4171>>>0<r3865>>>0;if(r4172){r3925=r4170;r3926=r4171;r3927=r4169}else{r3923=r4170;r3924=r4169;break}}}r4173=r3918+1|0;r4174=r4173>>>0<r3866>>>0;if(r4174){r3917=r3923;r3918=r4173;r3919=r3924}else{r3915=r3923;r3916=r3924;break}}}r4175=r3905+1|0;r4176=r4175>>>0<r3867>>>0;if(r4176){r3904=r3915;r3905=r4175;r3906=r3916}else{break}}}r4177=(r3873|0)==0;if(!r4177){_free(r3873)}r4178=HEAP32[r22>>2];r4179=(r4178|0)==0;if(!r4179){r4180=r4178;r4181=HEAP32[r4180>>2];r4182=r4181+4|0;r4183=HEAP32[r4182>>2];FUNCTION_TABLE[r4183](r4178)}r4184=(r3892|0)==0;if(r4184){break L6}_free(r3892);break};case 32:{r4185=HEAP32[r41>>2];r4186=HEAP32[r42>>2];r4187=HEAP32[r43>>2];r4188=HEAP32[r44>>2];r4189=4;r4190=0;r4191=__Znwj(48);r4192=r4191;__ZN9RCqsmodelC2Ebjjj(r4192,0,65,16,1024);r4193=r4191;HEAP32[r21>>2]=r4193;r4194=__Znwj(12);r4195=r4194+4|0;r4196=r4195;HEAP32[r4196>>2]=r4185;r4197=r4194+8|0;r4198=r4197;HEAP32[r4198>>2]=r21;r4199=r4186+1|0;r4200=r4187+1|0;r4201=Math_imul(r4200,r4199)|0;r4202=r4201+r4199|0;r4203=r4202;while(1){r4204=r4203+1|0;r4205=r4204&r4203;r4206=(r4205|0)==0;r4207=r4204|r4203;if(r4206){break}else{r4203=r4207}}r4208=_llvm_umul_with_overflow_i32(r4204,8);r4209=tempRet0;r4210=r4209;r4211=r4208;r4212=r4210?-1:r4211;r4213=__Znwj(r4212);r4214=r4213;r4215=r4201;r4216=0;while(1){r4217=r4216+1|0;r4218=r4216&r4203;r4219=r4214+(r4218<<3)|0;HEAPF64[r4219>>3]=0;r4220=r4215-1|0;r4221=(r4220|0)==0;if(r4221){break}else{r4215=r4220;r4216=r4217}}r4222=(r4188|0)==0;if(!r4222){r4223=(r4187|0)==0;r4224=(r4186|0)==0;r4225=r4201;r4226=0;r4227=r76;while(1){r4228=r4199;r4229=r4225;while(1){r4230=r4229+1|0;r4231=r4229&r4203;r4232=r4214+(r4231<<3)|0;HEAPF64[r4232>>3]=0;r4233=r4228-1|0;r4234=(r4233|0)==0;if(r4234){break}else{r4228=r4233;r4229=r4230}}r4235=r4225+r4199|0;if(r4223){r4236=r4235;r4237=r4227}else{r4238=r4235;r4239=0;r4240=r4227;while(1){r4241=r4238&r4203;r4242=r4214+(r4241<<3)|0;HEAPF64[r4242>>3]=0;r4243=r4238+1|0;if(r4224){r4244=r4243;r4245=r4240}else{r4246=r4243;r4247=0;r4248=r4240;while(1){r4249=r4246-1|0;r4250=r4249&r4203;r4251=r4214+(r4250<<3)|0;r4252=HEAPF64[r4251>>3];r4253=r4251|0;r4254=HEAP32[r4253>>2];r4255=r4251+4|0;r4256=HEAP32[r4255>>2];r4257=r4246-r4199|0;r4258=r4257-r4201|0;r4259=r4258&r4203;r4260=r4214+(r4259<<3)|0;r4261=HEAPF64[r4260>>3];r4262=r4260|0;r4263=HEAP32[r4262>>2];r4264=r4260+4|0;r4265=HEAP32[r4264>>2];r4266=r4252-r4261;r4267=r4257&r4203;r4268=r4214+(r4267<<3)|0;r4269=HEAPF64[r4268>>3];r4270=r4268|0;r4271=HEAP32[r4270>>2];r4272=r4268+4|0;r4273=HEAP32[r4272>>2];r4274=r4266+r4269;r4275=r4249-r4201|0;r4276=r4275&r4203;r4277=r4214+(r4276<<3)|0;r4278=HEAPF64[r4277>>3];r4279=r4277|0;r4280=HEAP32[r4279>>2];r4281=r4277+4|0;r4282=HEAP32[r4281>>2];r4283=r4274-r4278;r4284=r4246-r4201|0;r4285=r4284&r4203;r4286=r4214+(r4285<<3)|0;r4287=HEAPF64[r4286>>3];r4288=r4286|0;r4289=HEAP32[r4288>>2];r4290=r4286+4|0;r4291=HEAP32[r4290>>2];r4292=r4283+r4287;r4293=r4249-r4199|0;r4294=r4293&r4203;r4295=r4214+(r4294<<3)|0;r4296=HEAPF64[r4295>>3];r4297=r4295|0;r4298=HEAP32[r4297>>2];r4299=r4295+4|0;r4300=HEAP32[r4299>>2];r4301=r4292-r4296;r4302=r4293-r4201|0;r4303=r4302&r4203;r4304=r4214+(r4303<<3)|0;r4305=HEAPF64[r4304>>3];r4306=r4304|0;r4307=HEAP32[r4306>>2];r4308=r4304+4|0;r4309=HEAP32[r4308>>2];r4310=r4301+r4305;r4311=HEAP32[r4196>>2];r4312=HEAP32[r4198>>2];r4313=HEAP32[r4312>>2];r4314=__ZN9RCdecoder6decodeEP7RCmodel(r4311,r4313);r4315=r4314>>>0>32;do{if(r4315){r4316=r4314-33|0;r4317=r4316;r4318=0;r4319=1;r4320=0;r4321=_bitshift64Shl(r4319,r4320,r4317);r4322=tempRet0;r4323=HEAP32[r4196>>2];r4324=r4316>>>0>16;do{if(r4324){r4325=__ZN9RCdecoder12decode_shiftEj(r4323,16);r4326=r4325;r4327=0;r4328=r4314-49|0;r4329=r4328>>>0>16;if(!r4329){r4330=0;r4331=16;r4332=r4327;r4333=r4326;r4334=r4328;break}r4335=__ZN9RCdecoder12decode_shiftEj(r4323,16);r4336=r4335;r4337=0;r4338=r4336<<16|0>>>16;r4339=r4337<<16|r4336>>>16;r4340=_i64Add(r4338,r4339,r4326,r4327);r4341=tempRet0;r4342=r4314-65|0;r4343=r4342>>>0>16;if(!r4343){r4330=0;r4331=32;r4332=r4341;r4333=r4340;r4334=r4342;break}r4344=__ZN9RCdecoder12decode_shiftEj(r4323,16);r4345=r4344;r4346=0;r4347=0;r4348=r4345;r4349=_i64Add(r4347,r4348,r4340,r4341);r4350=tempRet0;r4351=r4314-81|0;r4330=0;r4331=48;r4332=r4350;r4333=r4349;r4334=r4351}else{r4330=0;r4331=0;r4332=0;r4333=0;r4334=r4316}}while(0);r4352=__ZN9RCdecoder12decode_shiftEj(r4323,r4334);r4353=r4352;r4354=0;r4355=_bitshift64Shl(r4353,r4354,r4331);r4356=tempRet0;HEAPF64[tempDoublePtr>>3]=r4310;r4357=HEAP32[tempDoublePtr>>2];r4358=HEAP32[tempDoublePtr+4>>2];r4359=r4358;r4360=0;r4361=-1;r4362=0;r4363=r4359^r4361;r4364=r4360^r4362;r4365=r4363>>>31|r4364<<1;r4366=r4364>>>31|0<<1;r4367=0;r4368=0;r4369=_i64Subtract(r4367,r4368,r4365,r4366);r4370=tempRet0;r4371=r4370>>>1|0<<31;r4372=0>>>1|0<<31;r4373=r4371^r4363;r4374=r4372^r4364;r4375=_i64Add(r4321,r4322,r4373,r4374);r4376=tempRet0;r4377=_i64Add(r4375,r4376,r4333,r4332);r4378=tempRet0;r4379=_i64Add(r4377,r4378,r4355,r4356);r4380=tempRet0;r4381=r4379>>>31|r4380<<1;r4382=r4380>>>31|0<<1;r4383=0;r4384=0;r4385=_i64Subtract(r4383,r4384,r4381,r4382);r4386=tempRet0;r4387=r4386>>>1|0<<31;r4388=0>>>1|0<<31;r4389=r4387^r4379;r4390=r4388^r4380;r4391=0;r4392=r4389;r4393=0;r4394=-1;r4395=r4391^r4393;r4396=r4392^r4394;r4397=r4396;r4398=r4395}else{r4399=r4314>>>0<32;if(!r4399){HEAPF64[tempDoublePtr>>3]=r4310;r4400=HEAP32[tempDoublePtr>>2];r4401=HEAP32[tempDoublePtr+4>>2];r4402=0;r4403=-1;r4404=r4400&r4402;r4405=r4401&r4403;r4397=r4405;r4398=r4404;break}r4406=31-r4314|0;r4407=r4406;r4408=0;r4409=HEAP32[r4196>>2];r4410=r4406>>>0>16;do{if(r4410){r4411=__ZN9RCdecoder12decode_shiftEj(r4409,16);r4412=r4411;r4413=0;r4414=r4406-16|0;r4415=r4414>>>0>16;if(!r4415){r4416=0;r4417=16;r4418=r4413;r4419=r4412;r4420=r4414;break}r4421=__ZN9RCdecoder12decode_shiftEj(r4409,16);r4422=r4421;r4423=0;r4424=r4422<<16|0>>>16;r4425=r4423<<16|r4422>>>16;r4426=_i64Add(r4424,r4425,r4412,r4413);r4427=tempRet0;r4428=r4406-32|0;r4429=r4428>>>0>16;if(!r4429){r4416=0;r4417=32;r4418=r4427;r4419=r4426;r4420=r4428;break}r4430=__ZN9RCdecoder12decode_shiftEj(r4409,16);r4431=r4430;r4432=0;r4433=0;r4434=r4431;r4435=_i64Add(r4433,r4434,r4426,r4427);r4436=tempRet0;r4437=r4406-48|0;r4416=0;r4417=48;r4418=r4436;r4419=r4435;r4420=r4437}else{r4416=0;r4417=0;r4418=0;r4419=0;r4420=r4406}}while(0);r4438=__ZN9RCdecoder12decode_shiftEj(r4409,r4420);r4439=r4438;r4440=0;r4441=_bitshift64Shl(r4439,r4440,r4417);r4442=tempRet0;HEAPF64[tempDoublePtr>>3]=r4310;r4443=HEAP32[tempDoublePtr>>2];r4444=HEAP32[tempDoublePtr+4>>2];r4445=r4444;r4446=0;r4447=-1;r4448=0;r4449=r4445^r4447;r4450=r4446^r4448;r4451=r4449>>>31|r4450<<1;r4452=r4450>>>31|0<<1;r4453=0;r4454=0;r4455=_i64Subtract(r4453,r4454,r4451,r4452);r4456=tempRet0;r4457=r4456>>>1|0<<31;r4458=0>>>1|0<<31;r4459=r4457^r4449;r4460=r4458^r4450;r4461=-1;r4462=-1;r4463=_bitshift64Shl(r4461,r4462,r4407);r4464=tempRet0;r4465=_i64Add(r4463,r4464,r4459,r4460);r4466=tempRet0;r4467=_i64Subtract(r4465,r4466,r4419,r4418);r4468=tempRet0;r4469=_i64Subtract(r4467,r4468,r4441,r4442);r4470=tempRet0;r4471=r4469>>>31|r4470<<1;r4472=r4470>>>31|0<<1;r4473=0;r4474=0;r4475=_i64Subtract(r4473,r4474,r4471,r4472);r4476=tempRet0;r4477=r4476>>>1|0<<31;r4478=0>>>1|0<<31;r4479=r4477^r4469;r4480=r4478^r4470;r4481=0;r4482=r4479;r4483=0;r4484=-1;r4485=r4481^r4483;r4486=r4482^r4484;r4397=r4486;r4398=r4485}}while(0);r4487=(HEAP32[tempDoublePtr>>2]=r4398,HEAP32[tempDoublePtr+4>>2]=r4397,HEAPF64[tempDoublePtr>>3]);HEAPF64[r4248>>3]=r4487;r4488=r4246&r4203;r4489=r4214+(r4488<<3)|0;HEAPF64[r4489>>3]=r4487;r4490=r4248+8|0;r4491=r4246+1|0;r4492=r4247+1|0;r4493=r4492>>>0<r4186>>>0;if(r4493){r4246=r4491;r4247=r4492;r4248=r4490}else{r4244=r4491;r4245=r4490;break}}}r4494=r4239+1|0;r4495=r4494>>>0<r4187>>>0;if(r4495){r4238=r4244;r4239=r4494;r4240=r4245}else{r4236=r4244;r4237=r4245;break}}}r4496=r4226+1|0;r4497=r4496>>>0<r4188>>>0;if(r4497){r4225=r4236;r4226=r4496;r4227=r4237}else{break}}}r4498=(r4194|0)==0;if(!r4498){_free(r4194)}r4499=HEAP32[r21>>2];r4500=(r4499|0)==0;if(!r4500){r4501=r4499;r4502=HEAP32[r4501>>2];r4503=r4502+4|0;r4504=HEAP32[r4503>>2];FUNCTION_TABLE[r4504](r4499)}r4505=(r4213|0)==0;if(r4505){break L6}_free(r4213);break};case 34:{r4506=HEAP32[r41>>2];r4507=HEAP32[r42>>2];r4508=HEAP32[r43>>2];r4509=HEAP32[r44>>2];r4510=4;r4511=0;r4512=__Znwj(48);r4513=r4512;__ZN9RCqsmodelC2Ebjjj(r4513,0,69,16,1024);r4514=r4512;HEAP32[r20>>2]=r4514;r4515=__Znwj(12);r4516=r4515+4|0;r4517=r4516;HEAP32[r4517>>2]=r4506;r4518=r4515+8|0;r4519=r4518;HEAP32[r4519>>2]=r20;r4520=r4507+1|0;r4521=r4508+1|0;r4522=Math_imul(r4521,r4520)|0;r4523=r4522+r4520|0;r4524=r4523;while(1){r4525=r4524+1|0;r4526=r4525&r4524;r4527=(r4526|0)==0;r4528=r4525|r4524;if(r4527){break}else{r4524=r4528}}r4529=_llvm_umul_with_overflow_i32(r4525,8);r4530=tempRet0;r4531=r4530;r4532=r4529;r4533=r4531?-1:r4532;r4534=__Znwj(r4533);r4535=r4534;r4536=r4522;r4537=0;while(1){r4538=r4537+1|0;r4539=r4537&r4524;r4540=r4535+(r4539<<3)|0;HEAPF64[r4540>>3]=0;r4541=r4536-1|0;r4542=(r4541|0)==0;if(r4542){break}else{r4536=r4541;r4537=r4538}}r4543=(r4509|0)==0;if(!r4543){r4544=(r4508|0)==0;r4545=(r4507|0)==0;r4546=r4522;r4547=0;r4548=r76;while(1){r4549=r4520;r4550=r4546;while(1){r4551=r4550+1|0;r4552=r4550&r4524;r4553=r4535+(r4552<<3)|0;HEAPF64[r4553>>3]=0;r4554=r4549-1|0;r4555=(r4554|0)==0;if(r4555){break}else{r4549=r4554;r4550=r4551}}r4556=r4546+r4520|0;if(r4544){r4557=r4556;r4558=r4548}else{r4559=r4556;r4560=0;r4561=r4548;while(1){r4562=r4559&r4524;r4563=r4535+(r4562<<3)|0;HEAPF64[r4563>>3]=0;r4564=r4559+1|0;if(r4545){r4565=r4564;r4566=r4561}else{r4567=r4564;r4568=0;r4569=r4561;while(1){r4570=r4567-1|0;r4571=r4570&r4524;r4572=r4535+(r4571<<3)|0;r4573=HEAPF64[r4572>>3];r4574=r4572|0;r4575=HEAP32[r4574>>2];r4576=r4572+4|0;r4577=HEAP32[r4576>>2];r4578=r4567-r4520|0;r4579=r4578-r4522|0;r4580=r4579&r4524;r4581=r4535+(r4580<<3)|0;r4582=HEAPF64[r4581>>3];r4583=r4581|0;r4584=HEAP32[r4583>>2];r4585=r4581+4|0;r4586=HEAP32[r4585>>2];r4587=r4573-r4582;r4588=r4578&r4524;r4589=r4535+(r4588<<3)|0;r4590=HEAPF64[r4589>>3];r4591=r4589|0;r4592=HEAP32[r4591>>2];r4593=r4589+4|0;r4594=HEAP32[r4593>>2];r4595=r4587+r4590;r4596=r4570-r4522|0;r4597=r4596&r4524;r4598=r4535+(r4597<<3)|0;r4599=HEAPF64[r4598>>3];r4600=r4598|0;r4601=HEAP32[r4600>>2];r4602=r4598+4|0;r4603=HEAP32[r4602>>2];r4604=r4595-r4599;r4605=r4567-r4522|0;r4606=r4605&r4524;r4607=r4535+(r4606<<3)|0;r4608=HEAPF64[r4607>>3];r4609=r4607|0;r4610=HEAP32[r4609>>2];r4611=r4607+4|0;r4612=HEAP32[r4611>>2];r4613=r4604+r4608;r4614=r4570-r4520|0;r4615=r4614&r4524;r4616=r4535+(r4615<<3)|0;r4617=HEAPF64[r4616>>3];r4618=r4616|0;r4619=HEAP32[r4618>>2];r4620=r4616+4|0;r4621=HEAP32[r4620>>2];r4622=r4613-r4617;r4623=r4614-r4522|0;r4624=r4623&r4524;r4625=r4535+(r4624<<3)|0;r4626=HEAPF64[r4625>>3];r4627=r4625|0;r4628=HEAP32[r4627>>2];r4629=r4625+4|0;r4630=HEAP32[r4629>>2];r4631=r4622+r4626;r4632=HEAP32[r4517>>2];r4633=HEAP32[r4519>>2];r4634=HEAP32[r4633>>2];r4635=__ZN9RCdecoder6decodeEP7RCmodel(r4632,r4634);r4636=r4635>>>0>34;do{if(r4636){r4637=r4635-35|0;r4638=r4637;r4639=0;r4640=1;r4641=0;r4642=_bitshift64Shl(r4640,r4641,r4638);r4643=tempRet0;r4644=HEAP32[r4517>>2];r4645=r4637>>>0>16;do{if(r4645){r4646=__ZN9RCdecoder12decode_shiftEj(r4644,16);r4647=r4646;r4648=0;r4649=r4635-51|0;r4650=r4649>>>0>16;if(!r4650){r4651=0;r4652=16;r4653=r4648;r4654=r4647;r4655=r4649;break}r4656=__ZN9RCdecoder12decode_shiftEj(r4644,16);r4657=r4656;r4658=0;r4659=r4657<<16|0>>>16;r4660=r4658<<16|r4657>>>16;r4661=_i64Add(r4659,r4660,r4647,r4648);r4662=tempRet0;r4663=r4635-67|0;r4664=r4663>>>0>16;if(!r4664){r4651=0;r4652=32;r4653=r4662;r4654=r4661;r4655=r4663;break}r4665=__ZN9RCdecoder12decode_shiftEj(r4644,16);r4666=r4665;r4667=0;r4668=0;r4669=r4666;r4670=_i64Add(r4668,r4669,r4661,r4662);r4671=tempRet0;r4672=r4635-83|0;r4651=0;r4652=48;r4653=r4671;r4654=r4670;r4655=r4672}else{r4651=0;r4652=0;r4653=0;r4654=0;r4655=r4637}}while(0);r4673=__ZN9RCdecoder12decode_shiftEj(r4644,r4655);r4674=r4673;r4675=0;r4676=_bitshift64Shl(r4674,r4675,r4652);r4677=tempRet0;HEAPF64[tempDoublePtr>>3]=r4631;r4678=HEAP32[tempDoublePtr>>2];r4679=HEAP32[tempDoublePtr+4>>2];r4680=r4678>>>30|r4679<<2;r4681=r4679>>>30|0<<2;r4682=-1;r4683=3;r4684=r4680^r4682;r4685=r4681^r4683;r4686=r4685>>>1|0<<31;r4687=0>>>1|0<<31;r4688=0;r4689=0;r4690=_i64Subtract(r4688,r4689,r4686,r4687);r4691=tempRet0;r4692=r4690>>>31|r4691<<1;r4693=r4691>>>31|0<<1;r4694=r4692^r4684;r4695=r4693^r4685;r4696=_i64Add(r4642,r4643,r4694,r4695);r4697=tempRet0;r4698=_i64Add(r4696,r4697,r4654,r4653);r4699=tempRet0;r4700=_i64Add(r4698,r4699,r4676,r4677);r4701=tempRet0;r4702=r4701>>>1|0<<31;r4703=0>>>1|0<<31;r4704=0;r4705=0;r4706=_i64Subtract(r4704,r4705,r4702,r4703);r4707=tempRet0;r4708=r4706>>>31|r4707<<1;r4709=r4707>>>31|0<<1;r4710=r4708^r4700;r4711=r4709^r4701;r4712=r4710<<30|0>>>2;r4713=r4711<<30|r4710>>>2;r4714=-1073741824;r4715=-1;r4716=r4712^r4714;r4717=r4713^r4715;r4718=r4717;r4719=r4716}else{r4720=r4635>>>0<34;if(!r4720){HEAPF64[tempDoublePtr>>3]=r4631;r4721=HEAP32[tempDoublePtr>>2];r4722=HEAP32[tempDoublePtr+4>>2];r4723=-1073741824;r4724=-1;r4725=r4721&r4723;r4726=r4722&r4724;r4718=r4726;r4719=r4725;break}r4727=33-r4635|0;r4728=r4727;r4729=0;r4730=HEAP32[r4517>>2];r4731=r4727>>>0>16;do{if(r4731){r4732=__ZN9RCdecoder12decode_shiftEj(r4730,16);r4733=r4732;r4734=0;r4735=r4727-16|0;r4736=r4735>>>0>16;if(!r4736){r4737=0;r4738=16;r4739=r4734;r4740=r4733;r4741=r4735;break}r4742=__ZN9RCdecoder12decode_shiftEj(r4730,16);r4743=r4742;r4744=0;r4745=r4743<<16|0>>>16;r4746=r4744<<16|r4743>>>16;r4747=_i64Add(r4745,r4746,r4733,r4734);r4748=tempRet0;r4749=r4727-32|0;r4750=r4749>>>0>16;if(!r4750){r4737=0;r4738=32;r4739=r4748;r4740=r4747;r4741=r4749;break}r4751=__ZN9RCdecoder12decode_shiftEj(r4730,16);r4752=r4751;r4753=0;r4754=0;r4755=r4752;r4756=_i64Add(r4754,r4755,r4747,r4748);r4757=tempRet0;r4758=r4727-48|0;r4737=0;r4738=48;r4739=r4757;r4740=r4756;r4741=r4758}else{r4737=0;r4738=0;r4739=0;r4740=0;r4741=r4727}}while(0);r4759=__ZN9RCdecoder12decode_shiftEj(r4730,r4741);r4760=r4759;r4761=0;r4762=_bitshift64Shl(r4760,r4761,r4738);r4763=tempRet0;HEAPF64[tempDoublePtr>>3]=r4631;r4764=HEAP32[tempDoublePtr>>2];r4765=HEAP32[tempDoublePtr+4>>2];r4766=r4764>>>30|r4765<<2;r4767=r4765>>>30|0<<2;r4768=-1;r4769=3;r4770=r4766^r4768;r4771=r4767^r4769;r4772=r4771>>>1|0<<31;r4773=0>>>1|0<<31;r4774=0;r4775=0;r4776=_i64Subtract(r4774,r4775,r4772,r4773);r4777=tempRet0;r4778=r4776>>>31|r4777<<1;r4779=r4777>>>31|0<<1;r4780=r4778^r4770;r4781=r4779^r4771;r4782=-1;r4783=-1;r4784=_bitshift64Shl(r4782,r4783,r4728);r4785=tempRet0;r4786=_i64Add(r4784,r4785,r4780,r4781);r4787=tempRet0;r4788=_i64Subtract(r4786,r4787,r4740,r4739);r4789=tempRet0;r4790=_i64Subtract(r4788,r4789,r4762,r4763);r4791=tempRet0;r4792=r4791>>>1|0<<31;r4793=0>>>1|0<<31;r4794=0;r4795=0;r4796=_i64Subtract(r4794,r4795,r4792,r4793);r4797=tempRet0;r4798=r4796>>>31|r4797<<1;r4799=r4797>>>31|0<<1;r4800=r4798^r4790;r4801=r4799^r4791;r4802=r4800<<30|0>>>2;r4803=r4801<<30|r4800>>>2;r4804=-1073741824;r4805=-1;r4806=r4802^r4804;r4807=r4803^r4805;r4718=r4807;r4719=r4806}}while(0);r4808=(HEAP32[tempDoublePtr>>2]=r4719,HEAP32[tempDoublePtr+4>>2]=r4718,HEAPF64[tempDoublePtr>>3]);HEAPF64[r4569>>3]=r4808;r4809=r4567&r4524;r4810=r4535+(r4809<<3)|0;HEAPF64[r4810>>3]=r4808;r4811=r4569+8|0;r4812=r4567+1|0;r4813=r4568+1|0;r4814=r4813>>>0<r4507>>>0;if(r4814){r4567=r4812;r4568=r4813;r4569=r4811}else{r4565=r4812;r4566=r4811;break}}}r4815=r4560+1|0;r4816=r4815>>>0<r4508>>>0;if(r4816){r4559=r4565;r4560=r4815;r4561=r4566}else{r4557=r4565;r4558=r4566;break}}}r4817=r4547+1|0;r4818=r4817>>>0<r4509>>>0;if(r4818){r4546=r4557;r4547=r4817;r4548=r4558}else{break}}}r4819=(r4515|0)==0;if(!r4819){_free(r4515)}r4820=HEAP32[r20>>2];r4821=(r4820|0)==0;if(!r4821){r4822=r4820;r4823=HEAP32[r4822>>2];r4824=r4823+4|0;r4825=HEAP32[r4824>>2];FUNCTION_TABLE[r4825](r4820)}r4826=(r4534|0)==0;if(r4826){break L6}_free(r4534);break};case 36:{r4827=HEAP32[r41>>2];r4828=HEAP32[r42>>2];r4829=HEAP32[r43>>2];r4830=HEAP32[r44>>2];r4831=4;r4832=0;r4833=__Znwj(48);r4834=r4833;__ZN9RCqsmodelC2Ebjjj(r4834,0,73,16,1024);r4835=r4833;HEAP32[r19>>2]=r4835;r4836=__Znwj(12);r4837=r4836+4|0;r4838=r4837;HEAP32[r4838>>2]=r4827;r4839=r4836+8|0;r4840=r4839;HEAP32[r4840>>2]=r19;r4841=r4828+1|0;r4842=r4829+1|0;r4843=Math_imul(r4842,r4841)|0;r4844=r4843+r4841|0;r4845=r4844;while(1){r4846=r4845+1|0;r4847=r4846&r4845;r4848=(r4847|0)==0;r4849=r4846|r4845;if(r4848){break}else{r4845=r4849}}r4850=_llvm_umul_with_overflow_i32(r4846,8);r4851=tempRet0;r4852=r4851;r4853=r4850;r4854=r4852?-1:r4853;r4855=__Znwj(r4854);r4856=r4855;r4857=r4843;r4858=0;while(1){r4859=r4858+1|0;r4860=r4858&r4845;r4861=r4856+(r4860<<3)|0;HEAPF64[r4861>>3]=0;r4862=r4857-1|0;r4863=(r4862|0)==0;if(r4863){break}else{r4857=r4862;r4858=r4859}}r4864=(r4830|0)==0;if(!r4864){r4865=(r4829|0)==0;r4866=(r4828|0)==0;r4867=r4843;r4868=0;r4869=r76;while(1){r4870=r4841;r4871=r4867;while(1){r4872=r4871+1|0;r4873=r4871&r4845;r4874=r4856+(r4873<<3)|0;HEAPF64[r4874>>3]=0;r4875=r4870-1|0;r4876=(r4875|0)==0;if(r4876){break}else{r4870=r4875;r4871=r4872}}r4877=r4867+r4841|0;if(r4865){r4878=r4877;r4879=r4869}else{r4880=r4877;r4881=0;r4882=r4869;while(1){r4883=r4880&r4845;r4884=r4856+(r4883<<3)|0;HEAPF64[r4884>>3]=0;r4885=r4880+1|0;if(r4866){r4886=r4885;r4887=r4882}else{r4888=r4885;r4889=0;r4890=r4882;while(1){r4891=r4888-1|0;r4892=r4891&r4845;r4893=r4856+(r4892<<3)|0;r4894=HEAPF64[r4893>>3];r4895=r4893|0;r4896=HEAP32[r4895>>2];r4897=r4893+4|0;r4898=HEAP32[r4897>>2];r4899=r4888-r4841|0;r4900=r4899-r4843|0;r4901=r4900&r4845;r4902=r4856+(r4901<<3)|0;r4903=HEAPF64[r4902>>3];r4904=r4902|0;r4905=HEAP32[r4904>>2];r4906=r4902+4|0;r4907=HEAP32[r4906>>2];r4908=r4894-r4903;r4909=r4899&r4845;r4910=r4856+(r4909<<3)|0;r4911=HEAPF64[r4910>>3];r4912=r4910|0;r4913=HEAP32[r4912>>2];r4914=r4910+4|0;r4915=HEAP32[r4914>>2];r4916=r4908+r4911;r4917=r4891-r4843|0;r4918=r4917&r4845;r4919=r4856+(r4918<<3)|0;r4920=HEAPF64[r4919>>3];r4921=r4919|0;r4922=HEAP32[r4921>>2];r4923=r4919+4|0;r4924=HEAP32[r4923>>2];r4925=r4916-r4920;r4926=r4888-r4843|0;r4927=r4926&r4845;r4928=r4856+(r4927<<3)|0;r4929=HEAPF64[r4928>>3];r4930=r4928|0;r4931=HEAP32[r4930>>2];r4932=r4928+4|0;r4933=HEAP32[r4932>>2];r4934=r4925+r4929;r4935=r4891-r4841|0;r4936=r4935&r4845;r4937=r4856+(r4936<<3)|0;r4938=HEAPF64[r4937>>3];r4939=r4937|0;r4940=HEAP32[r4939>>2];r4941=r4937+4|0;r4942=HEAP32[r4941>>2];r4943=r4934-r4938;r4944=r4935-r4843|0;r4945=r4944&r4845;r4946=r4856+(r4945<<3)|0;r4947=HEAPF64[r4946>>3];r4948=r4946|0;r4949=HEAP32[r4948>>2];r4950=r4946+4|0;r4951=HEAP32[r4950>>2];r4952=r4943+r4947;r4953=HEAP32[r4838>>2];r4954=HEAP32[r4840>>2];r4955=HEAP32[r4954>>2];r4956=__ZN9RCdecoder6decodeEP7RCmodel(r4953,r4955);r4957=r4956>>>0>36;do{if(r4957){r4958=r4956-37|0;r4959=r4958;r4960=0;r4961=1;r4962=0;r4963=_bitshift64Shl(r4961,r4962,r4959);r4964=tempRet0;r4965=HEAP32[r4838>>2];r4966=r4958>>>0>16;do{if(r4966){r4967=__ZN9RCdecoder12decode_shiftEj(r4965,16);r4968=r4967;r4969=0;r4970=r4956-53|0;r4971=r4970>>>0>16;if(!r4971){r4972=0;r4973=16;r4974=r4969;r4975=r4968;r4976=r4970;break}r4977=__ZN9RCdecoder12decode_shiftEj(r4965,16);r4978=r4977;r4979=0;r4980=r4978<<16|0>>>16;r4981=r4979<<16|r4978>>>16;r4982=_i64Add(r4980,r4981,r4968,r4969);r4983=tempRet0;r4984=r4956-69|0;r4985=r4984>>>0>16;if(!r4985){r4972=0;r4973=32;r4974=r4983;r4975=r4982;r4976=r4984;break}r4986=__ZN9RCdecoder12decode_shiftEj(r4965,16);r4987=r4986;r4988=0;r4989=0;r4990=r4987;r4991=_i64Add(r4989,r4990,r4982,r4983);r4992=tempRet0;r4993=r4956-85|0;r4972=0;r4973=48;r4974=r4992;r4975=r4991;r4976=r4993}else{r4972=0;r4973=0;r4974=0;r4975=0;r4976=r4958}}while(0);r4994=__ZN9RCdecoder12decode_shiftEj(r4965,r4976);r4995=r4994;r4996=0;r4997=_bitshift64Shl(r4995,r4996,r4973);r4998=tempRet0;HEAPF64[tempDoublePtr>>3]=r4952;r4999=HEAP32[tempDoublePtr>>2];r5000=HEAP32[tempDoublePtr+4>>2];r5001=r4999>>>28|r5000<<4;r5002=r5000>>>28|0<<4;r5003=-1;r5004=15;r5005=r5001^r5003;r5006=r5002^r5004;r5007=r5006>>>3|0<<29;r5008=0>>>3|0<<29;r5009=0;r5010=0;r5011=_i64Subtract(r5009,r5010,r5007,r5008);r5012=tempRet0;r5013=r5011>>>29|r5012<<3;r5014=r5012>>>29|0<<3;r5015=r5013^r5005;r5016=r5014^r5006;r5017=_i64Add(r4963,r4964,r5015,r5016);r5018=tempRet0;r5019=_i64Add(r5017,r5018,r4975,r4974);r5020=tempRet0;r5021=_i64Add(r5019,r5020,r4997,r4998);r5022=tempRet0;r5023=r5022>>>3|0<<29;r5024=0>>>3|0<<29;r5025=0;r5026=0;r5027=_i64Subtract(r5025,r5026,r5023,r5024);r5028=tempRet0;r5029=r5027>>>29|r5028<<3;r5030=r5028>>>29|0<<3;r5031=r5029^r5021;r5032=r5030^r5022;r5033=r5031<<28|0>>>4;r5034=r5032<<28|r5031>>>4;r5035=-268435456;r5036=-1;r5037=r5033^r5035;r5038=r5034^r5036;r5039=r5038;r5040=r5037}else{r5041=r4956>>>0<36;if(!r5041){HEAPF64[tempDoublePtr>>3]=r4952;r5042=HEAP32[tempDoublePtr>>2];r5043=HEAP32[tempDoublePtr+4>>2];r5044=-268435456;r5045=-1;r5046=r5042&r5044;r5047=r5043&r5045;r5039=r5047;r5040=r5046;break}r5048=35-r4956|0;r5049=r5048;r5050=0;r5051=HEAP32[r4838>>2];r5052=r5048>>>0>16;do{if(r5052){r5053=__ZN9RCdecoder12decode_shiftEj(r5051,16);r5054=r5053;r5055=0;r5056=r5048-16|0;r5057=r5056>>>0>16;if(!r5057){r5058=0;r5059=16;r5060=r5055;r5061=r5054;r5062=r5056;break}r5063=__ZN9RCdecoder12decode_shiftEj(r5051,16);r5064=r5063;r5065=0;r5066=r5064<<16|0>>>16;r5067=r5065<<16|r5064>>>16;r5068=_i64Add(r5066,r5067,r5054,r5055);r5069=tempRet0;r5070=r5048-32|0;r5071=r5070>>>0>16;if(!r5071){r5058=0;r5059=32;r5060=r5069;r5061=r5068;r5062=r5070;break}r5072=__ZN9RCdecoder12decode_shiftEj(r5051,16);r5073=r5072;r5074=0;r5075=0;r5076=r5073;r5077=_i64Add(r5075,r5076,r5068,r5069);r5078=tempRet0;r5079=r5048-48|0;r5058=0;r5059=48;r5060=r5078;r5061=r5077;r5062=r5079}else{r5058=0;r5059=0;r5060=0;r5061=0;r5062=r5048}}while(0);r5080=__ZN9RCdecoder12decode_shiftEj(r5051,r5062);r5081=r5080;r5082=0;r5083=_bitshift64Shl(r5081,r5082,r5059);r5084=tempRet0;HEAPF64[tempDoublePtr>>3]=r4952;r5085=HEAP32[tempDoublePtr>>2];r5086=HEAP32[tempDoublePtr+4>>2];r5087=r5085>>>28|r5086<<4;r5088=r5086>>>28|0<<4;r5089=-1;r5090=15;r5091=r5087^r5089;r5092=r5088^r5090;r5093=r5092>>>3|0<<29;r5094=0>>>3|0<<29;r5095=0;r5096=0;r5097=_i64Subtract(r5095,r5096,r5093,r5094);r5098=tempRet0;r5099=r5097>>>29|r5098<<3;r5100=r5098>>>29|0<<3;r5101=r5099^r5091;r5102=r5100^r5092;r5103=-1;r5104=-1;r5105=_bitshift64Shl(r5103,r5104,r5049);r5106=tempRet0;r5107=_i64Add(r5105,r5106,r5101,r5102);r5108=tempRet0;r5109=_i64Subtract(r5107,r5108,r5061,r5060);r5110=tempRet0;r5111=_i64Subtract(r5109,r5110,r5083,r5084);r5112=tempRet0;r5113=r5112>>>3|0<<29;r5114=0>>>3|0<<29;r5115=0;r5116=0;r5117=_i64Subtract(r5115,r5116,r5113,r5114);r5118=tempRet0;r5119=r5117>>>29|r5118<<3;r5120=r5118>>>29|0<<3;r5121=r5119^r5111;r5122=r5120^r5112;r5123=r5121<<28|0>>>4;r5124=r5122<<28|r5121>>>4;r5125=-268435456;r5126=-1;r5127=r5123^r5125;r5128=r5124^r5126;r5039=r5128;r5040=r5127}}while(0);r5129=(HEAP32[tempDoublePtr>>2]=r5040,HEAP32[tempDoublePtr+4>>2]=r5039,HEAPF64[tempDoublePtr>>3]);HEAPF64[r4890>>3]=r5129;r5130=r4888&r4845;r5131=r4856+(r5130<<3)|0;HEAPF64[r5131>>3]=r5129;r5132=r4890+8|0;r5133=r4888+1|0;r5134=r4889+1|0;r5135=r5134>>>0<r4828>>>0;if(r5135){r4888=r5133;r4889=r5134;r4890=r5132}else{r4886=r5133;r4887=r5132;break}}}r5136=r4881+1|0;r5137=r5136>>>0<r4829>>>0;if(r5137){r4880=r4886;r4881=r5136;r4882=r4887}else{r4878=r4886;r4879=r4887;break}}}r5138=r4868+1|0;r5139=r5138>>>0<r4830>>>0;if(r5139){r4867=r4878;r4868=r5138;r4869=r4879}else{break}}}r5140=(r4836|0)==0;if(!r5140){_free(r4836)}r5141=HEAP32[r19>>2];r5142=(r5141|0)==0;if(!r5142){r5143=r5141;r5144=HEAP32[r5143>>2];r5145=r5144+4|0;r5146=HEAP32[r5145>>2];FUNCTION_TABLE[r5146](r5141)}r5147=(r4855|0)==0;if(r5147){break L6}_free(r4855);break};case 38:{r5148=HEAP32[r41>>2];r5149=HEAP32[r42>>2];r5150=HEAP32[r43>>2];r5151=HEAP32[r44>>2];r5152=4;r5153=0;r5154=__Znwj(48);r5155=r5154;__ZN9RCqsmodelC2Ebjjj(r5155,0,77,16,1024);r5156=r5154;HEAP32[r18>>2]=r5156;r5157=__Znwj(12);r5158=r5157+4|0;r5159=r5158;HEAP32[r5159>>2]=r5148;r5160=r5157+8|0;r5161=r5160;HEAP32[r5161>>2]=r18;r5162=r5149+1|0;r5163=r5150+1|0;r5164=Math_imul(r5163,r5162)|0;r5165=r5164+r5162|0;r5166=r5165;while(1){r5167=r5166+1|0;r5168=r5167&r5166;r5169=(r5168|0)==0;r5170=r5167|r5166;if(r5169){break}else{r5166=r5170}}r5171=_llvm_umul_with_overflow_i32(r5167,8);r5172=tempRet0;r5173=r5172;r5174=r5171;r5175=r5173?-1:r5174;r5176=__Znwj(r5175);r5177=r5176;r5178=r5164;r5179=0;while(1){r5180=r5179+1|0;r5181=r5179&r5166;r5182=r5177+(r5181<<3)|0;HEAPF64[r5182>>3]=0;r5183=r5178-1|0;r5184=(r5183|0)==0;if(r5184){break}else{r5178=r5183;r5179=r5180}}r5185=(r5151|0)==0;if(!r5185){r5186=(r5150|0)==0;r5187=(r5149|0)==0;r5188=r5164;r5189=0;r5190=r76;while(1){r5191=r5162;r5192=r5188;while(1){r5193=r5192+1|0;r5194=r5192&r5166;r5195=r5177+(r5194<<3)|0;HEAPF64[r5195>>3]=0;r5196=r5191-1|0;r5197=(r5196|0)==0;if(r5197){break}else{r5191=r5196;r5192=r5193}}r5198=r5188+r5162|0;if(r5186){r5199=r5198;r5200=r5190}else{r5201=r5198;r5202=0;r5203=r5190;while(1){r5204=r5201&r5166;r5205=r5177+(r5204<<3)|0;HEAPF64[r5205>>3]=0;r5206=r5201+1|0;if(r5187){r5207=r5206;r5208=r5203}else{r5209=r5206;r5210=0;r5211=r5203;while(1){r5212=r5209-1|0;r5213=r5212&r5166;r5214=r5177+(r5213<<3)|0;r5215=HEAPF64[r5214>>3];r5216=r5214|0;r5217=HEAP32[r5216>>2];r5218=r5214+4|0;r5219=HEAP32[r5218>>2];r5220=r5209-r5162|0;r5221=r5220-r5164|0;r5222=r5221&r5166;r5223=r5177+(r5222<<3)|0;r5224=HEAPF64[r5223>>3];r5225=r5223|0;r5226=HEAP32[r5225>>2];r5227=r5223+4|0;r5228=HEAP32[r5227>>2];r5229=r5215-r5224;r5230=r5220&r5166;r5231=r5177+(r5230<<3)|0;r5232=HEAPF64[r5231>>3];r5233=r5231|0;r5234=HEAP32[r5233>>2];r5235=r5231+4|0;r5236=HEAP32[r5235>>2];r5237=r5229+r5232;r5238=r5212-r5164|0;r5239=r5238&r5166;r5240=r5177+(r5239<<3)|0;r5241=HEAPF64[r5240>>3];r5242=r5240|0;r5243=HEAP32[r5242>>2];r5244=r5240+4|0;r5245=HEAP32[r5244>>2];r5246=r5237-r5241;r5247=r5209-r5164|0;r5248=r5247&r5166;r5249=r5177+(r5248<<3)|0;r5250=HEAPF64[r5249>>3];r5251=r5249|0;r5252=HEAP32[r5251>>2];r5253=r5249+4|0;r5254=HEAP32[r5253>>2];r5255=r5246+r5250;r5256=r5212-r5162|0;r5257=r5256&r5166;r5258=r5177+(r5257<<3)|0;r5259=HEAPF64[r5258>>3];r5260=r5258|0;r5261=HEAP32[r5260>>2];r5262=r5258+4|0;r5263=HEAP32[r5262>>2];r5264=r5255-r5259;r5265=r5256-r5164|0;r5266=r5265&r5166;r5267=r5177+(r5266<<3)|0;r5268=HEAPF64[r5267>>3];r5269=r5267|0;r5270=HEAP32[r5269>>2];r5271=r5267+4|0;r5272=HEAP32[r5271>>2];r5273=r5264+r5268;r5274=HEAP32[r5159>>2];r5275=HEAP32[r5161>>2];r5276=HEAP32[r5275>>2];r5277=__ZN9RCdecoder6decodeEP7RCmodel(r5274,r5276);r5278=r5277>>>0>38;do{if(r5278){r5279=r5277-39|0;r5280=r5279;r5281=0;r5282=1;r5283=0;r5284=_bitshift64Shl(r5282,r5283,r5280);r5285=tempRet0;r5286=HEAP32[r5159>>2];r5287=r5279>>>0>16;do{if(r5287){r5288=__ZN9RCdecoder12decode_shiftEj(r5286,16);r5289=r5288;r5290=0;r5291=r5277-55|0;r5292=r5291>>>0>16;if(!r5292){r5293=0;r5294=16;r5295=r5290;r5296=r5289;r5297=r5291;break}r5298=__ZN9RCdecoder12decode_shiftEj(r5286,16);r5299=r5298;r5300=0;r5301=r5299<<16|0>>>16;r5302=r5300<<16|r5299>>>16;r5303=_i64Add(r5301,r5302,r5289,r5290);r5304=tempRet0;r5305=r5277-71|0;r5306=r5305>>>0>16;if(!r5306){r5293=0;r5294=32;r5295=r5304;r5296=r5303;r5297=r5305;break}r5307=__ZN9RCdecoder12decode_shiftEj(r5286,16);r5308=r5307;r5309=0;r5310=0;r5311=r5308;r5312=_i64Add(r5310,r5311,r5303,r5304);r5313=tempRet0;r5314=r5277-87|0;r5293=0;r5294=48;r5295=r5313;r5296=r5312;r5297=r5314}else{r5293=0;r5294=0;r5295=0;r5296=0;r5297=r5279}}while(0);r5315=__ZN9RCdecoder12decode_shiftEj(r5286,r5297);r5316=r5315;r5317=0;r5318=_bitshift64Shl(r5316,r5317,r5294);r5319=tempRet0;HEAPF64[tempDoublePtr>>3]=r5273;r5320=HEAP32[tempDoublePtr>>2];r5321=HEAP32[tempDoublePtr+4>>2];r5322=r5320>>>26|r5321<<6;r5323=r5321>>>26|0<<6;r5324=-1;r5325=63;r5326=r5322^r5324;r5327=r5323^r5325;r5328=r5327>>>5|0<<27;r5329=0>>>5|0<<27;r5330=0;r5331=0;r5332=_i64Subtract(r5330,r5331,r5328,r5329);r5333=tempRet0;r5334=r5332>>>27|r5333<<5;r5335=r5333>>>27|0<<5;r5336=r5334^r5326;r5337=r5335^r5327;r5338=_i64Add(r5284,r5285,r5336,r5337);r5339=tempRet0;r5340=_i64Add(r5338,r5339,r5296,r5295);r5341=tempRet0;r5342=_i64Add(r5340,r5341,r5318,r5319);r5343=tempRet0;r5344=r5343>>>5|0<<27;r5345=0>>>5|0<<27;r5346=0;r5347=0;r5348=_i64Subtract(r5346,r5347,r5344,r5345);r5349=tempRet0;r5350=r5348>>>27|r5349<<5;r5351=r5349>>>27|0<<5;r5352=r5350^r5342;r5353=r5351^r5343;r5354=r5352<<26|0>>>6;r5355=r5353<<26|r5352>>>6;r5356=-67108864;r5357=-1;r5358=r5354^r5356;r5359=r5355^r5357;r5360=r5359;r5361=r5358}else{r5362=r5277>>>0<38;if(!r5362){HEAPF64[tempDoublePtr>>3]=r5273;r5363=HEAP32[tempDoublePtr>>2];r5364=HEAP32[tempDoublePtr+4>>2];r5365=-67108864;r5366=-1;r5367=r5363&r5365;r5368=r5364&r5366;r5360=r5368;r5361=r5367;break}r5369=37-r5277|0;r5370=r5369;r5371=0;r5372=HEAP32[r5159>>2];r5373=r5369>>>0>16;do{if(r5373){r5374=__ZN9RCdecoder12decode_shiftEj(r5372,16);r5375=r5374;r5376=0;r5377=r5369-16|0;r5378=r5377>>>0>16;if(!r5378){r5379=0;r5380=16;r5381=r5376;r5382=r5375;r5383=r5377;break}r5384=__ZN9RCdecoder12decode_shiftEj(r5372,16);r5385=r5384;r5386=0;r5387=r5385<<16|0>>>16;r5388=r5386<<16|r5385>>>16;r5389=_i64Add(r5387,r5388,r5375,r5376);r5390=tempRet0;r5391=r5369-32|0;r5392=r5391>>>0>16;if(!r5392){r5379=0;r5380=32;r5381=r5390;r5382=r5389;r5383=r5391;break}r5393=__ZN9RCdecoder12decode_shiftEj(r5372,16);r5394=r5393;r5395=0;r5396=0;r5397=r5394;r5398=_i64Add(r5396,r5397,r5389,r5390);r5399=tempRet0;r5400=r5369-48|0;r5379=0;r5380=48;r5381=r5399;r5382=r5398;r5383=r5400}else{r5379=0;r5380=0;r5381=0;r5382=0;r5383=r5369}}while(0);r5401=__ZN9RCdecoder12decode_shiftEj(r5372,r5383);r5402=r5401;r5403=0;r5404=_bitshift64Shl(r5402,r5403,r5380);r5405=tempRet0;HEAPF64[tempDoublePtr>>3]=r5273;r5406=HEAP32[tempDoublePtr>>2];r5407=HEAP32[tempDoublePtr+4>>2];r5408=r5406>>>26|r5407<<6;r5409=r5407>>>26|0<<6;r5410=-1;r5411=63;r5412=r5408^r5410;r5413=r5409^r5411;r5414=r5413>>>5|0<<27;r5415=0>>>5|0<<27;r5416=0;r5417=0;r5418=_i64Subtract(r5416,r5417,r5414,r5415);r5419=tempRet0;r5420=r5418>>>27|r5419<<5;r5421=r5419>>>27|0<<5;r5422=r5420^r5412;r5423=r5421^r5413;r5424=-1;r5425=-1;r5426=_bitshift64Shl(r5424,r5425,r5370);r5427=tempRet0;r5428=_i64Add(r5426,r5427,r5422,r5423);r5429=tempRet0;r5430=_i64Subtract(r5428,r5429,r5382,r5381);r5431=tempRet0;r5432=_i64Subtract(r5430,r5431,r5404,r5405);r5433=tempRet0;r5434=r5433>>>5|0<<27;r5435=0>>>5|0<<27;r5436=0;r5437=0;r5438=_i64Subtract(r5436,r5437,r5434,r5435);r5439=tempRet0;r5440=r5438>>>27|r5439<<5;r5441=r5439>>>27|0<<5;r5442=r5440^r5432;r5443=r5441^r5433;r5444=r5442<<26|0>>>6;r5445=r5443<<26|r5442>>>6;r5446=-67108864;r5447=-1;r5448=r5444^r5446;r5449=r5445^r5447;r5360=r5449;r5361=r5448}}while(0);r5450=(HEAP32[tempDoublePtr>>2]=r5361,HEAP32[tempDoublePtr+4>>2]=r5360,HEAPF64[tempDoublePtr>>3]);HEAPF64[r5211>>3]=r5450;r5451=r5209&r5166;r5452=r5177+(r5451<<3)|0;HEAPF64[r5452>>3]=r5450;r5453=r5211+8|0;r5454=r5209+1|0;r5455=r5210+1|0;r5456=r5455>>>0<r5149>>>0;if(r5456){r5209=r5454;r5210=r5455;r5211=r5453}else{r5207=r5454;r5208=r5453;break}}}r5457=r5202+1|0;r5458=r5457>>>0<r5150>>>0;if(r5458){r5201=r5207;r5202=r5457;r5203=r5208}else{r5199=r5207;r5200=r5208;break}}}r5459=r5189+1|0;r5460=r5459>>>0<r5151>>>0;if(r5460){r5188=r5199;r5189=r5459;r5190=r5200}else{break}}}r5461=(r5157|0)==0;if(!r5461){_free(r5157)}r5462=HEAP32[r18>>2];r5463=(r5462|0)==0;if(!r5463){r5464=r5462;r5465=HEAP32[r5464>>2];r5466=r5465+4|0;r5467=HEAP32[r5466>>2];FUNCTION_TABLE[r5467](r5462)}r5468=(r5176|0)==0;if(r5468){break L6}_free(r5176);break};case 40:{r5469=HEAP32[r41>>2];r5470=HEAP32[r42>>2];r5471=HEAP32[r43>>2];r5472=HEAP32[r44>>2];r5473=4;r5474=0;r5475=__Znwj(48);r5476=r5475;__ZN9RCqsmodelC2Ebjjj(r5476,0,81,16,1024);r5477=r5475;HEAP32[r17>>2]=r5477;r5478=__Znwj(12);r5479=r5478+4|0;r5480=r5479;HEAP32[r5480>>2]=r5469;r5481=r5478+8|0;r5482=r5481;HEAP32[r5482>>2]=r17;r5483=r5470+1|0;r5484=r5471+1|0;r5485=Math_imul(r5484,r5483)|0;r5486=r5485+r5483|0;r5487=r5486;while(1){r5488=r5487+1|0;r5489=r5488&r5487;r5490=(r5489|0)==0;r5491=r5488|r5487;if(r5490){break}else{r5487=r5491}}r5492=_llvm_umul_with_overflow_i32(r5488,8);r5493=tempRet0;r5494=r5493;r5495=r5492;r5496=r5494?-1:r5495;r5497=__Znwj(r5496);r5498=r5497;r5499=r5485;r5500=0;while(1){r5501=r5500+1|0;r5502=r5500&r5487;r5503=r5498+(r5502<<3)|0;HEAPF64[r5503>>3]=0;r5504=r5499-1|0;r5505=(r5504|0)==0;if(r5505){break}else{r5499=r5504;r5500=r5501}}r5506=(r5472|0)==0;if(!r5506){r5507=(r5471|0)==0;r5508=(r5470|0)==0;r5509=r5485;r5510=0;r5511=r76;while(1){r5512=r5483;r5513=r5509;while(1){r5514=r5513+1|0;r5515=r5513&r5487;r5516=r5498+(r5515<<3)|0;HEAPF64[r5516>>3]=0;r5517=r5512-1|0;r5518=(r5517|0)==0;if(r5518){break}else{r5512=r5517;r5513=r5514}}r5519=r5509+r5483|0;if(r5507){r5520=r5519;r5521=r5511}else{r5522=r5519;r5523=0;r5524=r5511;while(1){r5525=r5522&r5487;r5526=r5498+(r5525<<3)|0;HEAPF64[r5526>>3]=0;r5527=r5522+1|0;if(r5508){r5528=r5527;r5529=r5524}else{r5530=r5527;r5531=0;r5532=r5524;while(1){r5533=r5530-1|0;r5534=r5533&r5487;r5535=r5498+(r5534<<3)|0;r5536=HEAPF64[r5535>>3];r5537=r5535|0;r5538=HEAP32[r5537>>2];r5539=r5535+4|0;r5540=HEAP32[r5539>>2];r5541=r5530-r5483|0;r5542=r5541-r5485|0;r5543=r5542&r5487;r5544=r5498+(r5543<<3)|0;r5545=HEAPF64[r5544>>3];r5546=r5544|0;r5547=HEAP32[r5546>>2];r5548=r5544+4|0;r5549=HEAP32[r5548>>2];r5550=r5536-r5545;r5551=r5541&r5487;r5552=r5498+(r5551<<3)|0;r5553=HEAPF64[r5552>>3];r5554=r5552|0;r5555=HEAP32[r5554>>2];r5556=r5552+4|0;r5557=HEAP32[r5556>>2];r5558=r5550+r5553;r5559=r5533-r5485|0;r5560=r5559&r5487;r5561=r5498+(r5560<<3)|0;r5562=HEAPF64[r5561>>3];r5563=r5561|0;r5564=HEAP32[r5563>>2];r5565=r5561+4|0;r5566=HEAP32[r5565>>2];r5567=r5558-r5562;r5568=r5530-r5485|0;r5569=r5568&r5487;r5570=r5498+(r5569<<3)|0;r5571=HEAPF64[r5570>>3];r5572=r5570|0;r5573=HEAP32[r5572>>2];r5574=r5570+4|0;r5575=HEAP32[r5574>>2];r5576=r5567+r5571;r5577=r5533-r5483|0;r5578=r5577&r5487;r5579=r5498+(r5578<<3)|0;r5580=HEAPF64[r5579>>3];r5581=r5579|0;r5582=HEAP32[r5581>>2];r5583=r5579+4|0;r5584=HEAP32[r5583>>2];r5585=r5576-r5580;r5586=r5577-r5485|0;r5587=r5586&r5487;r5588=r5498+(r5587<<3)|0;r5589=HEAPF64[r5588>>3];r5590=r5588|0;r5591=HEAP32[r5590>>2];r5592=r5588+4|0;r5593=HEAP32[r5592>>2];r5594=r5585+r5589;r5595=HEAP32[r5480>>2];r5596=HEAP32[r5482>>2];r5597=HEAP32[r5596>>2];r5598=__ZN9RCdecoder6decodeEP7RCmodel(r5595,r5597);r5599=r5598>>>0>40;do{if(r5599){r5600=r5598-41|0;r5601=r5600;r5602=0;r5603=1;r5604=0;r5605=_bitshift64Shl(r5603,r5604,r5601);r5606=tempRet0;r5607=HEAP32[r5480>>2];r5608=r5600>>>0>16;do{if(r5608){r5609=__ZN9RCdecoder12decode_shiftEj(r5607,16);r5610=r5609;r5611=0;r5612=r5598-57|0;r5613=r5612>>>0>16;if(!r5613){r5614=0;r5615=16;r5616=r5611;r5617=r5610;r5618=r5612;break}r5619=__ZN9RCdecoder12decode_shiftEj(r5607,16);r5620=r5619;r5621=0;r5622=r5620<<16|0>>>16;r5623=r5621<<16|r5620>>>16;r5624=_i64Add(r5622,r5623,r5610,r5611);r5625=tempRet0;r5626=r5598-73|0;r5627=r5626>>>0>16;if(!r5627){r5614=0;r5615=32;r5616=r5625;r5617=r5624;r5618=r5626;break}r5628=__ZN9RCdecoder12decode_shiftEj(r5607,16);r5629=r5628;r5630=0;r5631=0;r5632=r5629;r5633=_i64Add(r5631,r5632,r5624,r5625);r5634=tempRet0;r5635=r5598-89|0;r5614=0;r5615=48;r5616=r5634;r5617=r5633;r5618=r5635}else{r5614=0;r5615=0;r5616=0;r5617=0;r5618=r5600}}while(0);r5636=__ZN9RCdecoder12decode_shiftEj(r5607,r5618);r5637=r5636;r5638=0;r5639=_bitshift64Shl(r5637,r5638,r5615);r5640=tempRet0;HEAPF64[tempDoublePtr>>3]=r5594;r5641=HEAP32[tempDoublePtr>>2];r5642=HEAP32[tempDoublePtr+4>>2];r5643=r5641>>>24|r5642<<8;r5644=r5642>>>24|0<<8;r5645=-1;r5646=255;r5647=r5643^r5645;r5648=r5644^r5646;r5649=r5648>>>7|0<<25;r5650=0>>>7|0<<25;r5651=0;r5652=0;r5653=_i64Subtract(r5651,r5652,r5649,r5650);r5654=tempRet0;r5655=r5653>>>25|r5654<<7;r5656=r5654>>>25|0<<7;r5657=r5655^r5647;r5658=r5656^r5648;r5659=_i64Add(r5605,r5606,r5657,r5658);r5660=tempRet0;r5661=_i64Add(r5659,r5660,r5617,r5616);r5662=tempRet0;r5663=_i64Add(r5661,r5662,r5639,r5640);r5664=tempRet0;r5665=r5664>>>7|0<<25;r5666=0>>>7|0<<25;r5667=0;r5668=0;r5669=_i64Subtract(r5667,r5668,r5665,r5666);r5670=tempRet0;r5671=r5669>>>25|r5670<<7;r5672=r5670>>>25|0<<7;r5673=r5671^r5663;r5674=r5672^r5664;r5675=r5673<<24|0>>>8;r5676=r5674<<24|r5673>>>8;r5677=-16777216;r5678=-1;r5679=r5675^r5677;r5680=r5676^r5678;r5681=r5680;r5682=r5679}else{r5683=r5598>>>0<40;if(!r5683){HEAPF64[tempDoublePtr>>3]=r5594;r5684=HEAP32[tempDoublePtr>>2];r5685=HEAP32[tempDoublePtr+4>>2];r5686=-16777216;r5687=-1;r5688=r5684&r5686;r5689=r5685&r5687;r5681=r5689;r5682=r5688;break}r5690=39-r5598|0;r5691=r5690;r5692=0;r5693=HEAP32[r5480>>2];r5694=r5690>>>0>16;do{if(r5694){r5695=__ZN9RCdecoder12decode_shiftEj(r5693,16);r5696=r5695;r5697=0;r5698=r5690-16|0;r5699=r5698>>>0>16;if(!r5699){r5700=0;r5701=16;r5702=r5697;r5703=r5696;r5704=r5698;break}r5705=__ZN9RCdecoder12decode_shiftEj(r5693,16);r5706=r5705;r5707=0;r5708=r5706<<16|0>>>16;r5709=r5707<<16|r5706>>>16;r5710=_i64Add(r5708,r5709,r5696,r5697);r5711=tempRet0;r5712=r5690-32|0;r5713=r5712>>>0>16;if(!r5713){r5700=0;r5701=32;r5702=r5711;r5703=r5710;r5704=r5712;break}r5714=__ZN9RCdecoder12decode_shiftEj(r5693,16);r5715=r5714;r5716=0;r5717=0;r5718=r5715;r5719=_i64Add(r5717,r5718,r5710,r5711);r5720=tempRet0;r5721=r5690-48|0;r5700=0;r5701=48;r5702=r5720;r5703=r5719;r5704=r5721}else{r5700=0;r5701=0;r5702=0;r5703=0;r5704=r5690}}while(0);r5722=__ZN9RCdecoder12decode_shiftEj(r5693,r5704);r5723=r5722;r5724=0;r5725=_bitshift64Shl(r5723,r5724,r5701);r5726=tempRet0;HEAPF64[tempDoublePtr>>3]=r5594;r5727=HEAP32[tempDoublePtr>>2];r5728=HEAP32[tempDoublePtr+4>>2];r5729=r5727>>>24|r5728<<8;r5730=r5728>>>24|0<<8;r5731=-1;r5732=255;r5733=r5729^r5731;r5734=r5730^r5732;r5735=r5734>>>7|0<<25;r5736=0>>>7|0<<25;r5737=0;r5738=0;r5739=_i64Subtract(r5737,r5738,r5735,r5736);r5740=tempRet0;r5741=r5739>>>25|r5740<<7;r5742=r5740>>>25|0<<7;r5743=r5741^r5733;r5744=r5742^r5734;r5745=-1;r5746=-1;r5747=_bitshift64Shl(r5745,r5746,r5691);r5748=tempRet0;r5749=_i64Add(r5747,r5748,r5743,r5744);r5750=tempRet0;r5751=_i64Subtract(r5749,r5750,r5703,r5702);r5752=tempRet0;r5753=_i64Subtract(r5751,r5752,r5725,r5726);r5754=tempRet0;r5755=r5754>>>7|0<<25;r5756=0>>>7|0<<25;r5757=0;r5758=0;r5759=_i64Subtract(r5757,r5758,r5755,r5756);r5760=tempRet0;r5761=r5759>>>25|r5760<<7;r5762=r5760>>>25|0<<7;r5763=r5761^r5753;r5764=r5762^r5754;r5765=r5763<<24|0>>>8;r5766=r5764<<24|r5763>>>8;r5767=-16777216;r5768=-1;r5769=r5765^r5767;r5770=r5766^r5768;r5681=r5770;r5682=r5769}}while(0);r5771=(HEAP32[tempDoublePtr>>2]=r5682,HEAP32[tempDoublePtr+4>>2]=r5681,HEAPF64[tempDoublePtr>>3]);HEAPF64[r5532>>3]=r5771;r5772=r5530&r5487;r5773=r5498+(r5772<<3)|0;HEAPF64[r5773>>3]=r5771;r5774=r5532+8|0;r5775=r5530+1|0;r5776=r5531+1|0;r5777=r5776>>>0<r5470>>>0;if(r5777){r5530=r5775;r5531=r5776;r5532=r5774}else{r5528=r5775;r5529=r5774;break}}}r5778=r5523+1|0;r5779=r5778>>>0<r5471>>>0;if(r5779){r5522=r5528;r5523=r5778;r5524=r5529}else{r5520=r5528;r5521=r5529;break}}}r5780=r5510+1|0;r5781=r5780>>>0<r5472>>>0;if(r5781){r5509=r5520;r5510=r5780;r5511=r5521}else{break}}}r5782=(r5478|0)==0;if(!r5782){_free(r5478)}r5783=HEAP32[r17>>2];r5784=(r5783|0)==0;if(!r5784){r5785=r5783;r5786=HEAP32[r5785>>2];r5787=r5786+4|0;r5788=HEAP32[r5787>>2];FUNCTION_TABLE[r5788](r5783)}r5789=(r5497|0)==0;if(r5789){break L6}_free(r5497);break};case 42:{r5790=HEAP32[r41>>2];r5791=HEAP32[r42>>2];r5792=HEAP32[r43>>2];r5793=HEAP32[r44>>2];r5794=4;r5795=0;r5796=__Znwj(48);r5797=r5796;__ZN9RCqsmodelC2Ebjjj(r5797,0,85,16,1024);r5798=r5796;HEAP32[r16>>2]=r5798;r5799=__Znwj(12);r5800=r5799+4|0;r5801=r5800;HEAP32[r5801>>2]=r5790;r5802=r5799+8|0;r5803=r5802;HEAP32[r5803>>2]=r16;r5804=r5791+1|0;r5805=r5792+1|0;r5806=Math_imul(r5805,r5804)|0;r5807=r5806+r5804|0;r5808=r5807;while(1){r5809=r5808+1|0;r5810=r5809&r5808;r5811=(r5810|0)==0;r5812=r5809|r5808;if(r5811){break}else{r5808=r5812}}r5813=_llvm_umul_with_overflow_i32(r5809,8);r5814=tempRet0;r5815=r5814;r5816=r5813;r5817=r5815?-1:r5816;r5818=__Znwj(r5817);r5819=r5818;r5820=r5806;r5821=0;while(1){r5822=r5821+1|0;r5823=r5821&r5808;r5824=r5819+(r5823<<3)|0;HEAPF64[r5824>>3]=0;r5825=r5820-1|0;r5826=(r5825|0)==0;if(r5826){break}else{r5820=r5825;r5821=r5822}}r5827=(r5793|0)==0;if(!r5827){r5828=(r5792|0)==0;r5829=(r5791|0)==0;r5830=r5806;r5831=0;r5832=r76;while(1){r5833=r5804;r5834=r5830;while(1){r5835=r5834+1|0;r5836=r5834&r5808;r5837=r5819+(r5836<<3)|0;HEAPF64[r5837>>3]=0;r5838=r5833-1|0;r5839=(r5838|0)==0;if(r5839){break}else{r5833=r5838;r5834=r5835}}r5840=r5830+r5804|0;if(r5828){r5841=r5840;r5842=r5832}else{r5843=r5840;r5844=0;r5845=r5832;while(1){r5846=r5843&r5808;r5847=r5819+(r5846<<3)|0;HEAPF64[r5847>>3]=0;r5848=r5843+1|0;if(r5829){r5849=r5848;r5850=r5845}else{r5851=r5848;r5852=0;r5853=r5845;while(1){r5854=r5851-1|0;r5855=r5854&r5808;r5856=r5819+(r5855<<3)|0;r5857=HEAPF64[r5856>>3];r5858=r5856|0;r5859=HEAP32[r5858>>2];r5860=r5856+4|0;r5861=HEAP32[r5860>>2];r5862=r5851-r5804|0;r5863=r5862-r5806|0;r5864=r5863&r5808;r5865=r5819+(r5864<<3)|0;r5866=HEAPF64[r5865>>3];r5867=r5865|0;r5868=HEAP32[r5867>>2];r5869=r5865+4|0;r5870=HEAP32[r5869>>2];r5871=r5857-r5866;r5872=r5862&r5808;r5873=r5819+(r5872<<3)|0;r5874=HEAPF64[r5873>>3];r5875=r5873|0;r5876=HEAP32[r5875>>2];r5877=r5873+4|0;r5878=HEAP32[r5877>>2];r5879=r5871+r5874;r5880=r5854-r5806|0;r5881=r5880&r5808;r5882=r5819+(r5881<<3)|0;r5883=HEAPF64[r5882>>3];r5884=r5882|0;r5885=HEAP32[r5884>>2];r5886=r5882+4|0;r5887=HEAP32[r5886>>2];r5888=r5879-r5883;r5889=r5851-r5806|0;r5890=r5889&r5808;r5891=r5819+(r5890<<3)|0;r5892=HEAPF64[r5891>>3];r5893=r5891|0;r5894=HEAP32[r5893>>2];r5895=r5891+4|0;r5896=HEAP32[r5895>>2];r5897=r5888+r5892;r5898=r5854-r5804|0;r5899=r5898&r5808;r5900=r5819+(r5899<<3)|0;r5901=HEAPF64[r5900>>3];r5902=r5900|0;r5903=HEAP32[r5902>>2];r5904=r5900+4|0;r5905=HEAP32[r5904>>2];r5906=r5897-r5901;r5907=r5898-r5806|0;r5908=r5907&r5808;r5909=r5819+(r5908<<3)|0;r5910=HEAPF64[r5909>>3];r5911=r5909|0;r5912=HEAP32[r5911>>2];r5913=r5909+4|0;r5914=HEAP32[r5913>>2];r5915=r5906+r5910;r5916=HEAP32[r5801>>2];r5917=HEAP32[r5803>>2];r5918=HEAP32[r5917>>2];r5919=__ZN9RCdecoder6decodeEP7RCmodel(r5916,r5918);r5920=r5919>>>0>42;do{if(r5920){r5921=r5919-43|0;r5922=r5921;r5923=0;r5924=1;r5925=0;r5926=_bitshift64Shl(r5924,r5925,r5922);r5927=tempRet0;r5928=HEAP32[r5801>>2];r5929=r5921>>>0>16;do{if(r5929){r5930=__ZN9RCdecoder12decode_shiftEj(r5928,16);r5931=r5930;r5932=0;r5933=r5919-59|0;r5934=r5933>>>0>16;if(!r5934){r5935=0;r5936=16;r5937=r5932;r5938=r5931;r5939=r5933;break}r5940=__ZN9RCdecoder12decode_shiftEj(r5928,16);r5941=r5940;r5942=0;r5943=r5941<<16|0>>>16;r5944=r5942<<16|r5941>>>16;r5945=_i64Add(r5943,r5944,r5931,r5932);r5946=tempRet0;r5947=r5919-75|0;r5948=r5947>>>0>16;if(!r5948){r5935=0;r5936=32;r5937=r5946;r5938=r5945;r5939=r5947;break}r5949=__ZN9RCdecoder12decode_shiftEj(r5928,16);r5950=r5949;r5951=0;r5952=0;r5953=r5950;r5954=_i64Add(r5952,r5953,r5945,r5946);r5955=tempRet0;r5956=r5919-91|0;r5935=0;r5936=48;r5937=r5955;r5938=r5954;r5939=r5956}else{r5935=0;r5936=0;r5937=0;r5938=0;r5939=r5921}}while(0);r5957=__ZN9RCdecoder12decode_shiftEj(r5928,r5939);r5958=r5957;r5959=0;r5960=_bitshift64Shl(r5958,r5959,r5936);r5961=tempRet0;HEAPF64[tempDoublePtr>>3]=r5915;r5962=HEAP32[tempDoublePtr>>2];r5963=HEAP32[tempDoublePtr+4>>2];r5964=r5962>>>22|r5963<<10;r5965=r5963>>>22|0<<10;r5966=-1;r5967=1023;r5968=r5964^r5966;r5969=r5965^r5967;r5970=r5969>>>9|0<<23;r5971=0>>>9|0<<23;r5972=0;r5973=0;r5974=_i64Subtract(r5972,r5973,r5970,r5971);r5975=tempRet0;r5976=r5974>>>23|r5975<<9;r5977=r5975>>>23|0<<9;r5978=r5976^r5968;r5979=r5977^r5969;r5980=_i64Add(r5926,r5927,r5978,r5979);r5981=tempRet0;r5982=_i64Add(r5980,r5981,r5938,r5937);r5983=tempRet0;r5984=_i64Add(r5982,r5983,r5960,r5961);r5985=tempRet0;r5986=r5985>>>9|0<<23;r5987=0>>>9|0<<23;r5988=0;r5989=0;r5990=_i64Subtract(r5988,r5989,r5986,r5987);r5991=tempRet0;r5992=r5990>>>23|r5991<<9;r5993=r5991>>>23|0<<9;r5994=r5992^r5984;r5995=r5993^r5985;r5996=r5994<<22|0>>>10;r5997=r5995<<22|r5994>>>10;r5998=-4194304;r5999=-1;r6000=r5996^r5998;r6001=r5997^r5999;r6002=r6001;r6003=r6000}else{r6004=r5919>>>0<42;if(!r6004){HEAPF64[tempDoublePtr>>3]=r5915;r6005=HEAP32[tempDoublePtr>>2];r6006=HEAP32[tempDoublePtr+4>>2];r6007=-4194304;r6008=-1;r6009=r6005&r6007;r6010=r6006&r6008;r6002=r6010;r6003=r6009;break}r6011=41-r5919|0;r6012=r6011;r6013=0;r6014=HEAP32[r5801>>2];r6015=r6011>>>0>16;do{if(r6015){r6016=__ZN9RCdecoder12decode_shiftEj(r6014,16);r6017=r6016;r6018=0;r6019=r6011-16|0;r6020=r6019>>>0>16;if(!r6020){r6021=0;r6022=16;r6023=r6018;r6024=r6017;r6025=r6019;break}r6026=__ZN9RCdecoder12decode_shiftEj(r6014,16);r6027=r6026;r6028=0;r6029=r6027<<16|0>>>16;r6030=r6028<<16|r6027>>>16;r6031=_i64Add(r6029,r6030,r6017,r6018);r6032=tempRet0;r6033=r6011-32|0;r6034=r6033>>>0>16;if(!r6034){r6021=0;r6022=32;r6023=r6032;r6024=r6031;r6025=r6033;break}r6035=__ZN9RCdecoder12decode_shiftEj(r6014,16);r6036=r6035;r6037=0;r6038=0;r6039=r6036;r6040=_i64Add(r6038,r6039,r6031,r6032);r6041=tempRet0;r6042=r6011-48|0;r6021=0;r6022=48;r6023=r6041;r6024=r6040;r6025=r6042}else{r6021=0;r6022=0;r6023=0;r6024=0;r6025=r6011}}while(0);r6043=__ZN9RCdecoder12decode_shiftEj(r6014,r6025);r6044=r6043;r6045=0;r6046=_bitshift64Shl(r6044,r6045,r6022);r6047=tempRet0;HEAPF64[tempDoublePtr>>3]=r5915;r6048=HEAP32[tempDoublePtr>>2];r6049=HEAP32[tempDoublePtr+4>>2];r6050=r6048>>>22|r6049<<10;r6051=r6049>>>22|0<<10;r6052=-1;r6053=1023;r6054=r6050^r6052;r6055=r6051^r6053;r6056=r6055>>>9|0<<23;r6057=0>>>9|0<<23;r6058=0;r6059=0;r6060=_i64Subtract(r6058,r6059,r6056,r6057);r6061=tempRet0;r6062=r6060>>>23|r6061<<9;r6063=r6061>>>23|0<<9;r6064=r6062^r6054;r6065=r6063^r6055;r6066=-1;r6067=-1;r6068=_bitshift64Shl(r6066,r6067,r6012);r6069=tempRet0;r6070=_i64Add(r6068,r6069,r6064,r6065);r6071=tempRet0;r6072=_i64Subtract(r6070,r6071,r6024,r6023);r6073=tempRet0;r6074=_i64Subtract(r6072,r6073,r6046,r6047);r6075=tempRet0;r6076=r6075>>>9|0<<23;r6077=0>>>9|0<<23;r6078=0;r6079=0;r6080=_i64Subtract(r6078,r6079,r6076,r6077);r6081=tempRet0;r6082=r6080>>>23|r6081<<9;r6083=r6081>>>23|0<<9;r6084=r6082^r6074;r6085=r6083^r6075;r6086=r6084<<22|0>>>10;r6087=r6085<<22|r6084>>>10;r6088=-4194304;r6089=-1;r6090=r6086^r6088;r6091=r6087^r6089;r6002=r6091;r6003=r6090}}while(0);r6092=(HEAP32[tempDoublePtr>>2]=r6003,HEAP32[tempDoublePtr+4>>2]=r6002,HEAPF64[tempDoublePtr>>3]);HEAPF64[r5853>>3]=r6092;r6093=r5851&r5808;r6094=r5819+(r6093<<3)|0;HEAPF64[r6094>>3]=r6092;r6095=r5853+8|0;r6096=r5851+1|0;r6097=r5852+1|0;r6098=r6097>>>0<r5791>>>0;if(r6098){r5851=r6096;r5852=r6097;r5853=r6095}else{r5849=r6096;r5850=r6095;break}}}r6099=r5844+1|0;r6100=r6099>>>0<r5792>>>0;if(r6100){r5843=r5849;r5844=r6099;r5845=r5850}else{r5841=r5849;r5842=r5850;break}}}r6101=r5831+1|0;r6102=r6101>>>0<r5793>>>0;if(r6102){r5830=r5841;r5831=r6101;r5832=r5842}else{break}}}r6103=(r5799|0)==0;if(!r6103){_free(r5799)}r6104=HEAP32[r16>>2];r6105=(r6104|0)==0;if(!r6105){r6106=r6104;r6107=HEAP32[r6106>>2];r6108=r6107+4|0;r6109=HEAP32[r6108>>2];FUNCTION_TABLE[r6109](r6104)}r6110=(r5818|0)==0;if(r6110){break L6}_free(r5818);break};case 44:{r6111=HEAP32[r41>>2];r6112=HEAP32[r42>>2];r6113=HEAP32[r43>>2];r6114=HEAP32[r44>>2];r6115=4;r6116=0;r6117=__Znwj(48);r6118=r6117;__ZN9RCqsmodelC2Ebjjj(r6118,0,89,16,1024);r6119=r6117;HEAP32[r15>>2]=r6119;r6120=__Znwj(12);r6121=r6120+4|0;r6122=r6121;HEAP32[r6122>>2]=r6111;r6123=r6120+8|0;r6124=r6123;HEAP32[r6124>>2]=r15;r6125=r6112+1|0;r6126=r6113+1|0;r6127=Math_imul(r6126,r6125)|0;r6128=r6127+r6125|0;r6129=r6128;while(1){r6130=r6129+1|0;r6131=r6130&r6129;r6132=(r6131|0)==0;r6133=r6130|r6129;if(r6132){break}else{r6129=r6133}}r6134=_llvm_umul_with_overflow_i32(r6130,8);r6135=tempRet0;r6136=r6135;r6137=r6134;r6138=r6136?-1:r6137;r6139=__Znwj(r6138);r6140=r6139;r6141=r6127;r6142=0;while(1){r6143=r6142+1|0;r6144=r6142&r6129;r6145=r6140+(r6144<<3)|0;HEAPF64[r6145>>3]=0;r6146=r6141-1|0;r6147=(r6146|0)==0;if(r6147){break}else{r6141=r6146;r6142=r6143}}r6148=(r6114|0)==0;if(!r6148){r6149=(r6113|0)==0;r6150=(r6112|0)==0;r6151=r6127;r6152=0;r6153=r76;while(1){r6154=r6125;r6155=r6151;while(1){r6156=r6155+1|0;r6157=r6155&r6129;r6158=r6140+(r6157<<3)|0;HEAPF64[r6158>>3]=0;r6159=r6154-1|0;r6160=(r6159|0)==0;if(r6160){break}else{r6154=r6159;r6155=r6156}}r6161=r6151+r6125|0;if(r6149){r6162=r6161;r6163=r6153}else{r6164=r6161;r6165=0;r6166=r6153;while(1){r6167=r6164&r6129;r6168=r6140+(r6167<<3)|0;HEAPF64[r6168>>3]=0;r6169=r6164+1|0;if(r6150){r6170=r6169;r6171=r6166}else{r6172=r6169;r6173=0;r6174=r6166;while(1){r6175=r6172-1|0;r6176=r6175&r6129;r6177=r6140+(r6176<<3)|0;r6178=HEAPF64[r6177>>3];r6179=r6177|0;r6180=HEAP32[r6179>>2];r6181=r6177+4|0;r6182=HEAP32[r6181>>2];r6183=r6172-r6125|0;r6184=r6183-r6127|0;r6185=r6184&r6129;r6186=r6140+(r6185<<3)|0;r6187=HEAPF64[r6186>>3];r6188=r6186|0;r6189=HEAP32[r6188>>2];r6190=r6186+4|0;r6191=HEAP32[r6190>>2];r6192=r6178-r6187;r6193=r6183&r6129;r6194=r6140+(r6193<<3)|0;r6195=HEAPF64[r6194>>3];r6196=r6194|0;r6197=HEAP32[r6196>>2];r6198=r6194+4|0;r6199=HEAP32[r6198>>2];r6200=r6192+r6195;r6201=r6175-r6127|0;r6202=r6201&r6129;r6203=r6140+(r6202<<3)|0;r6204=HEAPF64[r6203>>3];r6205=r6203|0;r6206=HEAP32[r6205>>2];r6207=r6203+4|0;r6208=HEAP32[r6207>>2];r6209=r6200-r6204;r6210=r6172-r6127|0;r6211=r6210&r6129;r6212=r6140+(r6211<<3)|0;r6213=HEAPF64[r6212>>3];r6214=r6212|0;r6215=HEAP32[r6214>>2];r6216=r6212+4|0;r6217=HEAP32[r6216>>2];r6218=r6209+r6213;r6219=r6175-r6125|0;r6220=r6219&r6129;r6221=r6140+(r6220<<3)|0;r6222=HEAPF64[r6221>>3];r6223=r6221|0;r6224=HEAP32[r6223>>2];r6225=r6221+4|0;r6226=HEAP32[r6225>>2];r6227=r6218-r6222;r6228=r6219-r6127|0;r6229=r6228&r6129;r6230=r6140+(r6229<<3)|0;r6231=HEAPF64[r6230>>3];r6232=r6230|0;r6233=HEAP32[r6232>>2];r6234=r6230+4|0;r6235=HEAP32[r6234>>2];r6236=r6227+r6231;r6237=HEAP32[r6122>>2];r6238=HEAP32[r6124>>2];r6239=HEAP32[r6238>>2];r6240=__ZN9RCdecoder6decodeEP7RCmodel(r6237,r6239);r6241=r6240>>>0>44;do{if(r6241){r6242=r6240-45|0;r6243=r6242;r6244=0;r6245=1;r6246=0;r6247=_bitshift64Shl(r6245,r6246,r6243);r6248=tempRet0;r6249=HEAP32[r6122>>2];r6250=r6242>>>0>16;do{if(r6250){r6251=__ZN9RCdecoder12decode_shiftEj(r6249,16);r6252=r6251;r6253=0;r6254=r6240-61|0;r6255=r6254>>>0>16;if(!r6255){r6256=0;r6257=16;r6258=r6253;r6259=r6252;r6260=r6254;break}r6261=__ZN9RCdecoder12decode_shiftEj(r6249,16);r6262=r6261;r6263=0;r6264=r6262<<16|0>>>16;r6265=r6263<<16|r6262>>>16;r6266=_i64Add(r6264,r6265,r6252,r6253);r6267=tempRet0;r6268=r6240-77|0;r6269=r6268>>>0>16;if(!r6269){r6256=0;r6257=32;r6258=r6267;r6259=r6266;r6260=r6268;break}r6270=__ZN9RCdecoder12decode_shiftEj(r6249,16);r6271=r6270;r6272=0;r6273=0;r6274=r6271;r6275=_i64Add(r6273,r6274,r6266,r6267);r6276=tempRet0;r6277=r6240-93|0;r6256=0;r6257=48;r6258=r6276;r6259=r6275;r6260=r6277}else{r6256=0;r6257=0;r6258=0;r6259=0;r6260=r6242}}while(0);r6278=__ZN9RCdecoder12decode_shiftEj(r6249,r6260);r6279=r6278;r6280=0;r6281=_bitshift64Shl(r6279,r6280,r6257);r6282=tempRet0;HEAPF64[tempDoublePtr>>3]=r6236;r6283=HEAP32[tempDoublePtr>>2];r6284=HEAP32[tempDoublePtr+4>>2];r6285=r6283>>>20|r6284<<12;r6286=r6284>>>20|0<<12;r6287=-1;r6288=4095;r6289=r6285^r6287;r6290=r6286^r6288;r6291=r6290>>>11|0<<21;r6292=0>>>11|0<<21;r6293=0;r6294=0;r6295=_i64Subtract(r6293,r6294,r6291,r6292);r6296=tempRet0;r6297=r6295>>>21|r6296<<11;r6298=r6296>>>21|0<<11;r6299=r6297^r6289;r6300=r6298^r6290;r6301=_i64Add(r6247,r6248,r6299,r6300);r6302=tempRet0;r6303=_i64Add(r6301,r6302,r6259,r6258);r6304=tempRet0;r6305=_i64Add(r6303,r6304,r6281,r6282);r6306=tempRet0;r6307=r6306>>>11|0<<21;r6308=0>>>11|0<<21;r6309=0;r6310=0;r6311=_i64Subtract(r6309,r6310,r6307,r6308);r6312=tempRet0;r6313=r6311>>>21|r6312<<11;r6314=r6312>>>21|0<<11;r6315=r6313^r6305;r6316=r6314^r6306;r6317=r6315<<20|0>>>12;r6318=r6316<<20|r6315>>>12;r6319=-1048576;r6320=-1;r6321=r6317^r6319;r6322=r6318^r6320;r6323=r6322;r6324=r6321}else{r6325=r6240>>>0<44;if(!r6325){HEAPF64[tempDoublePtr>>3]=r6236;r6326=HEAP32[tempDoublePtr>>2];r6327=HEAP32[tempDoublePtr+4>>2];r6328=-1048576;r6329=-1;r6330=r6326&r6328;r6331=r6327&r6329;r6323=r6331;r6324=r6330;break}r6332=43-r6240|0;r6333=r6332;r6334=0;r6335=HEAP32[r6122>>2];r6336=r6332>>>0>16;do{if(r6336){r6337=__ZN9RCdecoder12decode_shiftEj(r6335,16);r6338=r6337;r6339=0;r6340=r6332-16|0;r6341=r6340>>>0>16;if(!r6341){r6342=0;r6343=16;r6344=r6339;r6345=r6338;r6346=r6340;break}r6347=__ZN9RCdecoder12decode_shiftEj(r6335,16);r6348=r6347;r6349=0;r6350=r6348<<16|0>>>16;r6351=r6349<<16|r6348>>>16;r6352=_i64Add(r6350,r6351,r6338,r6339);r6353=tempRet0;r6354=r6332-32|0;r6355=r6354>>>0>16;if(!r6355){r6342=0;r6343=32;r6344=r6353;r6345=r6352;r6346=r6354;break}r6356=__ZN9RCdecoder12decode_shiftEj(r6335,16);r6357=r6356;r6358=0;r6359=0;r6360=r6357;r6361=_i64Add(r6359,r6360,r6352,r6353);r6362=tempRet0;r6363=r6332-48|0;r6342=0;r6343=48;r6344=r6362;r6345=r6361;r6346=r6363}else{r6342=0;r6343=0;r6344=0;r6345=0;r6346=r6332}}while(0);r6364=__ZN9RCdecoder12decode_shiftEj(r6335,r6346);r6365=r6364;r6366=0;r6367=_bitshift64Shl(r6365,r6366,r6343);r6368=tempRet0;HEAPF64[tempDoublePtr>>3]=r6236;r6369=HEAP32[tempDoublePtr>>2];r6370=HEAP32[tempDoublePtr+4>>2];r6371=r6369>>>20|r6370<<12;r6372=r6370>>>20|0<<12;r6373=-1;r6374=4095;r6375=r6371^r6373;r6376=r6372^r6374;r6377=r6376>>>11|0<<21;r6378=0>>>11|0<<21;r6379=0;r6380=0;r6381=_i64Subtract(r6379,r6380,r6377,r6378);r6382=tempRet0;r6383=r6381>>>21|r6382<<11;r6384=r6382>>>21|0<<11;r6385=r6383^r6375;r6386=r6384^r6376;r6387=-1;r6388=-1;r6389=_bitshift64Shl(r6387,r6388,r6333);r6390=tempRet0;r6391=_i64Add(r6389,r6390,r6385,r6386);r6392=tempRet0;r6393=_i64Subtract(r6391,r6392,r6345,r6344);r6394=tempRet0;r6395=_i64Subtract(r6393,r6394,r6367,r6368);r6396=tempRet0;r6397=r6396>>>11|0<<21;r6398=0>>>11|0<<21;r6399=0;r6400=0;r6401=_i64Subtract(r6399,r6400,r6397,r6398);r6402=tempRet0;r6403=r6401>>>21|r6402<<11;r6404=r6402>>>21|0<<11;r6405=r6403^r6395;r6406=r6404^r6396;r6407=r6405<<20|0>>>12;r6408=r6406<<20|r6405>>>12;r6409=-1048576;r6410=-1;r6411=r6407^r6409;r6412=r6408^r6410;r6323=r6412;r6324=r6411}}while(0);r6413=(HEAP32[tempDoublePtr>>2]=r6324,HEAP32[tempDoublePtr+4>>2]=r6323,HEAPF64[tempDoublePtr>>3]);HEAPF64[r6174>>3]=r6413;r6414=r6172&r6129;r6415=r6140+(r6414<<3)|0;HEAPF64[r6415>>3]=r6413;r6416=r6174+8|0;r6417=r6172+1|0;r6418=r6173+1|0;r6419=r6418>>>0<r6112>>>0;if(r6419){r6172=r6417;r6173=r6418;r6174=r6416}else{r6170=r6417;r6171=r6416;break}}}r6420=r6165+1|0;r6421=r6420>>>0<r6113>>>0;if(r6421){r6164=r6170;r6165=r6420;r6166=r6171}else{r6162=r6170;r6163=r6171;break}}}r6422=r6152+1|0;r6423=r6422>>>0<r6114>>>0;if(r6423){r6151=r6162;r6152=r6422;r6153=r6163}else{break}}}r6424=(r6120|0)==0;if(!r6424){_free(r6120)}r6425=HEAP32[r15>>2];r6426=(r6425|0)==0;if(!r6426){r6427=r6425;r6428=HEAP32[r6427>>2];r6429=r6428+4|0;r6430=HEAP32[r6429>>2];FUNCTION_TABLE[r6430](r6425)}r6431=(r6139|0)==0;if(r6431){break L6}_free(r6139);break};case 46:{r6432=HEAP32[r41>>2];r6433=HEAP32[r42>>2];r6434=HEAP32[r43>>2];r6435=HEAP32[r44>>2];r6436=4;r6437=0;r6438=__Znwj(48);r6439=r6438;__ZN9RCqsmodelC2Ebjjj(r6439,0,93,16,1024);r6440=r6438;HEAP32[r14>>2]=r6440;r6441=__Znwj(12);r6442=r6441+4|0;r6443=r6442;HEAP32[r6443>>2]=r6432;r6444=r6441+8|0;r6445=r6444;HEAP32[r6445>>2]=r14;r6446=r6433+1|0;r6447=r6434+1|0;r6448=Math_imul(r6447,r6446)|0;r6449=r6448+r6446|0;r6450=r6449;while(1){r6451=r6450+1|0;r6452=r6451&r6450;r6453=(r6452|0)==0;r6454=r6451|r6450;if(r6453){break}else{r6450=r6454}}r6455=_llvm_umul_with_overflow_i32(r6451,8);r6456=tempRet0;r6457=r6456;r6458=r6455;r6459=r6457?-1:r6458;r6460=__Znwj(r6459);r6461=r6460;r6462=r6448;r6463=0;while(1){r6464=r6463+1|0;r6465=r6463&r6450;r6466=r6461+(r6465<<3)|0;HEAPF64[r6466>>3]=0;r6467=r6462-1|0;r6468=(r6467|0)==0;if(r6468){break}else{r6462=r6467;r6463=r6464}}r6469=(r6435|0)==0;if(!r6469){r6470=(r6434|0)==0;r6471=(r6433|0)==0;r6472=r6448;r6473=0;r6474=r76;while(1){r6475=r6446;r6476=r6472;while(1){r6477=r6476+1|0;r6478=r6476&r6450;r6479=r6461+(r6478<<3)|0;HEAPF64[r6479>>3]=0;r6480=r6475-1|0;r6481=(r6480|0)==0;if(r6481){break}else{r6475=r6480;r6476=r6477}}r6482=r6472+r6446|0;if(r6470){r6483=r6482;r6484=r6474}else{r6485=r6482;r6486=0;r6487=r6474;while(1){r6488=r6485&r6450;r6489=r6461+(r6488<<3)|0;HEAPF64[r6489>>3]=0;r6490=r6485+1|0;if(r6471){r6491=r6490;r6492=r6487}else{r6493=r6490;r6494=0;r6495=r6487;while(1){r6496=r6493-1|0;r6497=r6496&r6450;r6498=r6461+(r6497<<3)|0;r6499=HEAPF64[r6498>>3];r6500=r6498|0;r6501=HEAP32[r6500>>2];r6502=r6498+4|0;r6503=HEAP32[r6502>>2];r6504=r6493-r6446|0;r6505=r6504-r6448|0;r6506=r6505&r6450;r6507=r6461+(r6506<<3)|0;r6508=HEAPF64[r6507>>3];r6509=r6507|0;r6510=HEAP32[r6509>>2];r6511=r6507+4|0;r6512=HEAP32[r6511>>2];r6513=r6499-r6508;r6514=r6504&r6450;r6515=r6461+(r6514<<3)|0;r6516=HEAPF64[r6515>>3];r6517=r6515|0;r6518=HEAP32[r6517>>2];r6519=r6515+4|0;r6520=HEAP32[r6519>>2];r6521=r6513+r6516;r6522=r6496-r6448|0;r6523=r6522&r6450;r6524=r6461+(r6523<<3)|0;r6525=HEAPF64[r6524>>3];r6526=r6524|0;r6527=HEAP32[r6526>>2];r6528=r6524+4|0;r6529=HEAP32[r6528>>2];r6530=r6521-r6525;r6531=r6493-r6448|0;r6532=r6531&r6450;r6533=r6461+(r6532<<3)|0;r6534=HEAPF64[r6533>>3];r6535=r6533|0;r6536=HEAP32[r6535>>2];r6537=r6533+4|0;r6538=HEAP32[r6537>>2];r6539=r6530+r6534;r6540=r6496-r6446|0;r6541=r6540&r6450;r6542=r6461+(r6541<<3)|0;r6543=HEAPF64[r6542>>3];r6544=r6542|0;r6545=HEAP32[r6544>>2];r6546=r6542+4|0;r6547=HEAP32[r6546>>2];r6548=r6539-r6543;r6549=r6540-r6448|0;r6550=r6549&r6450;r6551=r6461+(r6550<<3)|0;r6552=HEAPF64[r6551>>3];r6553=r6551|0;r6554=HEAP32[r6553>>2];r6555=r6551+4|0;r6556=HEAP32[r6555>>2];r6557=r6548+r6552;r6558=HEAP32[r6443>>2];r6559=HEAP32[r6445>>2];r6560=HEAP32[r6559>>2];r6561=__ZN9RCdecoder6decodeEP7RCmodel(r6558,r6560);r6562=r6561>>>0>46;do{if(r6562){r6563=r6561-47|0;r6564=r6563;r6565=0;r6566=1;r6567=0;r6568=_bitshift64Shl(r6566,r6567,r6564);r6569=tempRet0;r6570=HEAP32[r6443>>2];r6571=r6563>>>0>16;do{if(r6571){r6572=__ZN9RCdecoder12decode_shiftEj(r6570,16);r6573=r6572;r6574=0;r6575=r6561-63|0;r6576=r6575>>>0>16;if(!r6576){r6577=0;r6578=16;r6579=r6574;r6580=r6573;r6581=r6575;break}r6582=__ZN9RCdecoder12decode_shiftEj(r6570,16);r6583=r6582;r6584=0;r6585=r6583<<16|0>>>16;r6586=r6584<<16|r6583>>>16;r6587=_i64Add(r6585,r6586,r6573,r6574);r6588=tempRet0;r6589=r6561-79|0;r6590=r6589>>>0>16;if(!r6590){r6577=0;r6578=32;r6579=r6588;r6580=r6587;r6581=r6589;break}r6591=__ZN9RCdecoder12decode_shiftEj(r6570,16);r6592=r6591;r6593=0;r6594=0;r6595=r6592;r6596=_i64Add(r6594,r6595,r6587,r6588);r6597=tempRet0;r6598=r6561-95|0;r6577=0;r6578=48;r6579=r6597;r6580=r6596;r6581=r6598}else{r6577=0;r6578=0;r6579=0;r6580=0;r6581=r6563}}while(0);r6599=__ZN9RCdecoder12decode_shiftEj(r6570,r6581);r6600=r6599;r6601=0;r6602=_bitshift64Shl(r6600,r6601,r6578);r6603=tempRet0;HEAPF64[tempDoublePtr>>3]=r6557;r6604=HEAP32[tempDoublePtr>>2];r6605=HEAP32[tempDoublePtr+4>>2];r6606=r6604>>>18|r6605<<14;r6607=r6605>>>18|0<<14;r6608=-1;r6609=16383;r6610=r6606^r6608;r6611=r6607^r6609;r6612=r6611>>>13|0<<19;r6613=0>>>13|0<<19;r6614=0;r6615=0;r6616=_i64Subtract(r6614,r6615,r6612,r6613);r6617=tempRet0;r6618=r6616>>>19|r6617<<13;r6619=r6617>>>19|0<<13;r6620=r6618^r6610;r6621=r6619^r6611;r6622=_i64Add(r6568,r6569,r6620,r6621);r6623=tempRet0;r6624=_i64Add(r6622,r6623,r6580,r6579);r6625=tempRet0;r6626=_i64Add(r6624,r6625,r6602,r6603);r6627=tempRet0;r6628=r6627>>>13|0<<19;r6629=0>>>13|0<<19;r6630=0;r6631=0;r6632=_i64Subtract(r6630,r6631,r6628,r6629);r6633=tempRet0;r6634=r6632>>>19|r6633<<13;r6635=r6633>>>19|0<<13;r6636=r6634^r6626;r6637=r6635^r6627;r6638=r6636<<18|0>>>14;r6639=r6637<<18|r6636>>>14;r6640=-262144;r6641=-1;r6642=r6638^r6640;r6643=r6639^r6641;r6644=r6643;r6645=r6642}else{r6646=r6561>>>0<46;if(!r6646){HEAPF64[tempDoublePtr>>3]=r6557;r6647=HEAP32[tempDoublePtr>>2];r6648=HEAP32[tempDoublePtr+4>>2];r6649=-262144;r6650=-1;r6651=r6647&r6649;r6652=r6648&r6650;r6644=r6652;r6645=r6651;break}r6653=45-r6561|0;r6654=r6653;r6655=0;r6656=HEAP32[r6443>>2];r6657=r6653>>>0>16;do{if(r6657){r6658=__ZN9RCdecoder12decode_shiftEj(r6656,16);r6659=r6658;r6660=0;r6661=r6653-16|0;r6662=r6661>>>0>16;if(!r6662){r6663=0;r6664=16;r6665=r6660;r6666=r6659;r6667=r6661;break}r6668=__ZN9RCdecoder12decode_shiftEj(r6656,16);r6669=r6668;r6670=0;r6671=r6669<<16|0>>>16;r6672=r6670<<16|r6669>>>16;r6673=_i64Add(r6671,r6672,r6659,r6660);r6674=tempRet0;r6675=r6653-32|0;r6676=r6675>>>0>16;if(!r6676){r6663=0;r6664=32;r6665=r6674;r6666=r6673;r6667=r6675;break}r6677=__ZN9RCdecoder12decode_shiftEj(r6656,16);r6678=r6677;r6679=0;r6680=0;r6681=r6678;r6682=_i64Add(r6680,r6681,r6673,r6674);r6683=tempRet0;r6684=r6653-48|0;r6663=0;r6664=48;r6665=r6683;r6666=r6682;r6667=r6684}else{r6663=0;r6664=0;r6665=0;r6666=0;r6667=r6653}}while(0);r6685=__ZN9RCdecoder12decode_shiftEj(r6656,r6667);r6686=r6685;r6687=0;r6688=_bitshift64Shl(r6686,r6687,r6664);r6689=tempRet0;HEAPF64[tempDoublePtr>>3]=r6557;r6690=HEAP32[tempDoublePtr>>2];r6691=HEAP32[tempDoublePtr+4>>2];r6692=r6690>>>18|r6691<<14;r6693=r6691>>>18|0<<14;r6694=-1;r6695=16383;r6696=r6692^r6694;r6697=r6693^r6695;r6698=r6697>>>13|0<<19;r6699=0>>>13|0<<19;r6700=0;r6701=0;r6702=_i64Subtract(r6700,r6701,r6698,r6699);r6703=tempRet0;r6704=r6702>>>19|r6703<<13;r6705=r6703>>>19|0<<13;r6706=r6704^r6696;r6707=r6705^r6697;r6708=-1;r6709=-1;r6710=_bitshift64Shl(r6708,r6709,r6654);r6711=tempRet0;r6712=_i64Add(r6710,r6711,r6706,r6707);r6713=tempRet0;r6714=_i64Subtract(r6712,r6713,r6666,r6665);r6715=tempRet0;r6716=_i64Subtract(r6714,r6715,r6688,r6689);r6717=tempRet0;r6718=r6717>>>13|0<<19;r6719=0>>>13|0<<19;r6720=0;r6721=0;r6722=_i64Subtract(r6720,r6721,r6718,r6719);r6723=tempRet0;r6724=r6722>>>19|r6723<<13;r6725=r6723>>>19|0<<13;r6726=r6724^r6716;r6727=r6725^r6717;r6728=r6726<<18|0>>>14;r6729=r6727<<18|r6726>>>14;r6730=-262144;r6731=-1;r6732=r6728^r6730;r6733=r6729^r6731;r6644=r6733;r6645=r6732}}while(0);r6734=(HEAP32[tempDoublePtr>>2]=r6645,HEAP32[tempDoublePtr+4>>2]=r6644,HEAPF64[tempDoublePtr>>3]);HEAPF64[r6495>>3]=r6734;r6735=r6493&r6450;r6736=r6461+(r6735<<3)|0;HEAPF64[r6736>>3]=r6734;r6737=r6495+8|0;r6738=r6493+1|0;r6739=r6494+1|0;r6740=r6739>>>0<r6433>>>0;if(r6740){r6493=r6738;r6494=r6739;r6495=r6737}else{r6491=r6738;r6492=r6737;break}}}r6741=r6486+1|0;r6742=r6741>>>0<r6434>>>0;if(r6742){r6485=r6491;r6486=r6741;r6487=r6492}else{r6483=r6491;r6484=r6492;break}}}r6743=r6473+1|0;r6744=r6743>>>0<r6435>>>0;if(r6744){r6472=r6483;r6473=r6743;r6474=r6484}else{break}}}r6745=(r6441|0)==0;if(!r6745){_free(r6441)}r6746=HEAP32[r14>>2];r6747=(r6746|0)==0;if(!r6747){r6748=r6746;r6749=HEAP32[r6748>>2];r6750=r6749+4|0;r6751=HEAP32[r6750>>2];FUNCTION_TABLE[r6751](r6746)}r6752=(r6460|0)==0;if(r6752){break L6}_free(r6460);break};case 48:{r6753=HEAP32[r41>>2];r6754=HEAP32[r42>>2];r6755=HEAP32[r43>>2];r6756=HEAP32[r44>>2];r6757=4;r6758=0;r6759=__Znwj(48);r6760=r6759;__ZN9RCqsmodelC2Ebjjj(r6760,0,97,16,1024);r6761=r6759;HEAP32[r13>>2]=r6761;r6762=__Znwj(12);r6763=r6762+4|0;r6764=r6763;HEAP32[r6764>>2]=r6753;r6765=r6762+8|0;r6766=r6765;HEAP32[r6766>>2]=r13;r6767=r6754+1|0;r6768=r6755+1|0;r6769=Math_imul(r6768,r6767)|0;r6770=r6769+r6767|0;r6771=r6770;while(1){r6772=r6771+1|0;r6773=r6772&r6771;r6774=(r6773|0)==0;r6775=r6772|r6771;if(r6774){break}else{r6771=r6775}}r6776=_llvm_umul_with_overflow_i32(r6772,8);r6777=tempRet0;r6778=r6777;r6779=r6776;r6780=r6778?-1:r6779;r6781=__Znwj(r6780);r6782=r6781;r6783=r6769;r6784=0;while(1){r6785=r6784+1|0;r6786=r6784&r6771;r6787=r6782+(r6786<<3)|0;HEAPF64[r6787>>3]=0;r6788=r6783-1|0;r6789=(r6788|0)==0;if(r6789){break}else{r6783=r6788;r6784=r6785}}r6790=(r6756|0)==0;if(!r6790){r6791=(r6755|0)==0;r6792=(r6754|0)==0;r6793=r6769;r6794=0;r6795=r76;while(1){r6796=r6767;r6797=r6793;while(1){r6798=r6797+1|0;r6799=r6797&r6771;r6800=r6782+(r6799<<3)|0;HEAPF64[r6800>>3]=0;r6801=r6796-1|0;r6802=(r6801|0)==0;if(r6802){break}else{r6796=r6801;r6797=r6798}}r6803=r6793+r6767|0;if(r6791){r6804=r6803;r6805=r6795}else{r6806=r6803;r6807=0;r6808=r6795;while(1){r6809=r6806&r6771;r6810=r6782+(r6809<<3)|0;HEAPF64[r6810>>3]=0;r6811=r6806+1|0;if(r6792){r6812=r6811;r6813=r6808}else{r6814=r6811;r6815=0;r6816=r6808;while(1){r6817=r6814-1|0;r6818=r6817&r6771;r6819=r6782+(r6818<<3)|0;r6820=HEAPF64[r6819>>3];r6821=r6819|0;r6822=HEAP32[r6821>>2];r6823=r6819+4|0;r6824=HEAP32[r6823>>2];r6825=r6814-r6767|0;r6826=r6825-r6769|0;r6827=r6826&r6771;r6828=r6782+(r6827<<3)|0;r6829=HEAPF64[r6828>>3];r6830=r6828|0;r6831=HEAP32[r6830>>2];r6832=r6828+4|0;r6833=HEAP32[r6832>>2];r6834=r6820-r6829;r6835=r6825&r6771;r6836=r6782+(r6835<<3)|0;r6837=HEAPF64[r6836>>3];r6838=r6836|0;r6839=HEAP32[r6838>>2];r6840=r6836+4|0;r6841=HEAP32[r6840>>2];r6842=r6834+r6837;r6843=r6817-r6769|0;r6844=r6843&r6771;r6845=r6782+(r6844<<3)|0;r6846=HEAPF64[r6845>>3];r6847=r6845|0;r6848=HEAP32[r6847>>2];r6849=r6845+4|0;r6850=HEAP32[r6849>>2];r6851=r6842-r6846;r6852=r6814-r6769|0;r6853=r6852&r6771;r6854=r6782+(r6853<<3)|0;r6855=HEAPF64[r6854>>3];r6856=r6854|0;r6857=HEAP32[r6856>>2];r6858=r6854+4|0;r6859=HEAP32[r6858>>2];r6860=r6851+r6855;r6861=r6817-r6767|0;r6862=r6861&r6771;r6863=r6782+(r6862<<3)|0;r6864=HEAPF64[r6863>>3];r6865=r6863|0;r6866=HEAP32[r6865>>2];r6867=r6863+4|0;r6868=HEAP32[r6867>>2];r6869=r6860-r6864;r6870=r6861-r6769|0;r6871=r6870&r6771;r6872=r6782+(r6871<<3)|0;r6873=HEAPF64[r6872>>3];r6874=r6872|0;r6875=HEAP32[r6874>>2];r6876=r6872+4|0;r6877=HEAP32[r6876>>2];r6878=r6869+r6873;r6879=HEAP32[r6764>>2];r6880=HEAP32[r6766>>2];r6881=HEAP32[r6880>>2];r6882=__ZN9RCdecoder6decodeEP7RCmodel(r6879,r6881);r6883=r6882>>>0>48;do{if(r6883){r6884=r6882-49|0;r6885=r6884;r6886=0;r6887=1;r6888=0;r6889=_bitshift64Shl(r6887,r6888,r6885);r6890=tempRet0;r6891=HEAP32[r6764>>2];r6892=r6884>>>0>16;do{if(r6892){r6893=__ZN9RCdecoder12decode_shiftEj(r6891,16);r6894=r6893;r6895=0;r6896=r6882-65|0;r6897=r6896>>>0>16;if(!r6897){r6898=0;r6899=16;r6900=r6895;r6901=r6894;r6902=r6896;break}r6903=__ZN9RCdecoder12decode_shiftEj(r6891,16);r6904=r6903;r6905=0;r6906=r6904<<16|0>>>16;r6907=r6905<<16|r6904>>>16;r6908=_i64Add(r6906,r6907,r6894,r6895);r6909=tempRet0;r6910=r6882-81|0;r6911=r6910>>>0>16;if(!r6911){r6898=0;r6899=32;r6900=r6909;r6901=r6908;r6902=r6910;break}r6912=__ZN9RCdecoder12decode_shiftEj(r6891,16);r6913=r6912;r6914=0;r6915=0;r6916=r6913;r6917=_i64Add(r6915,r6916,r6908,r6909);r6918=tempRet0;r6919=r6882-97|0;r6898=0;r6899=48;r6900=r6918;r6901=r6917;r6902=r6919}else{r6898=0;r6899=0;r6900=0;r6901=0;r6902=r6884}}while(0);r6920=__ZN9RCdecoder12decode_shiftEj(r6891,r6902);r6921=r6920;r6922=0;r6923=_bitshift64Shl(r6921,r6922,r6899);r6924=tempRet0;HEAPF64[tempDoublePtr>>3]=r6878;r6925=HEAP32[tempDoublePtr>>2];r6926=HEAP32[tempDoublePtr+4>>2];r6927=r6925>>>16|r6926<<16;r6928=r6926>>>16|0<<16;r6929=-1;r6930=65535;r6931=r6927^r6929;r6932=r6928^r6930;r6933=r6932>>>15|0<<17;r6934=0>>>15|0<<17;r6935=0;r6936=0;r6937=_i64Subtract(r6935,r6936,r6933,r6934);r6938=tempRet0;r6939=r6937>>>17|r6938<<15;r6940=r6938>>>17|0<<15;r6941=r6939^r6931;r6942=r6940^r6932;r6943=_i64Add(r6889,r6890,r6941,r6942);r6944=tempRet0;r6945=_i64Add(r6943,r6944,r6901,r6900);r6946=tempRet0;r6947=_i64Add(r6945,r6946,r6923,r6924);r6948=tempRet0;r6949=r6948>>>15|0<<17;r6950=0>>>15|0<<17;r6951=0;r6952=0;r6953=_i64Subtract(r6951,r6952,r6949,r6950);r6954=tempRet0;r6955=r6953>>>17|r6954<<15;r6956=r6954>>>17|0<<15;r6957=r6955^r6947;r6958=r6956^r6948;r6959=r6957<<16|0>>>16;r6960=r6958<<16|r6957>>>16;r6961=-65536;r6962=-1;r6963=r6959^r6961;r6964=r6960^r6962;r6965=r6964;r6966=r6963}else{r6967=r6882>>>0<48;if(!r6967){HEAPF64[tempDoublePtr>>3]=r6878;r6968=HEAP32[tempDoublePtr>>2];r6969=HEAP32[tempDoublePtr+4>>2];r6970=-65536;r6971=-1;r6972=r6968&r6970;r6973=r6969&r6971;r6965=r6973;r6966=r6972;break}r6974=47-r6882|0;r6975=r6974;r6976=0;r6977=HEAP32[r6764>>2];r6978=r6974>>>0>16;do{if(r6978){r6979=__ZN9RCdecoder12decode_shiftEj(r6977,16);r6980=r6979;r6981=0;r6982=r6974-16|0;r6983=r6982>>>0>16;if(!r6983){r6984=0;r6985=16;r6986=r6981;r6987=r6980;r6988=r6982;break}r6989=__ZN9RCdecoder12decode_shiftEj(r6977,16);r6990=r6989;r6991=0;r6992=r6990<<16|0>>>16;r6993=r6991<<16|r6990>>>16;r6994=_i64Add(r6992,r6993,r6980,r6981);r6995=tempRet0;r6996=r6974-32|0;r6997=r6996>>>0>16;if(!r6997){r6984=0;r6985=32;r6986=r6995;r6987=r6994;r6988=r6996;break}r6998=__ZN9RCdecoder12decode_shiftEj(r6977,16);r6999=r6998;r7000=0;r7001=0;r7002=r6999;r7003=_i64Add(r7001,r7002,r6994,r6995);r7004=tempRet0;r7005=r6974-48|0;r6984=0;r6985=48;r6986=r7004;r6987=r7003;r6988=r7005}else{r6984=0;r6985=0;r6986=0;r6987=0;r6988=r6974}}while(0);r7006=__ZN9RCdecoder12decode_shiftEj(r6977,r6988);r7007=r7006;r7008=0;r7009=_bitshift64Shl(r7007,r7008,r6985);r7010=tempRet0;HEAPF64[tempDoublePtr>>3]=r6878;r7011=HEAP32[tempDoublePtr>>2];r7012=HEAP32[tempDoublePtr+4>>2];r7013=r7011>>>16|r7012<<16;r7014=r7012>>>16|0<<16;r7015=-1;r7016=65535;r7017=r7013^r7015;r7018=r7014^r7016;r7019=r7018>>>15|0<<17;r7020=0>>>15|0<<17;r7021=0;r7022=0;r7023=_i64Subtract(r7021,r7022,r7019,r7020);r7024=tempRet0;r7025=r7023>>>17|r7024<<15;r7026=r7024>>>17|0<<15;r7027=r7025^r7017;r7028=r7026^r7018;r7029=-1;r7030=-1;r7031=_bitshift64Shl(r7029,r7030,r6975);r7032=tempRet0;r7033=_i64Add(r7031,r7032,r7027,r7028);r7034=tempRet0;r7035=_i64Subtract(r7033,r7034,r6987,r6986);r7036=tempRet0;r7037=_i64Subtract(r7035,r7036,r7009,r7010);r7038=tempRet0;r7039=r7038>>>15|0<<17;r7040=0>>>15|0<<17;r7041=0;r7042=0;r7043=_i64Subtract(r7041,r7042,r7039,r7040);r7044=tempRet0;r7045=r7043>>>17|r7044<<15;r7046=r7044>>>17|0<<15;r7047=r7045^r7037;r7048=r7046^r7038;r7049=r7047<<16|0>>>16;r7050=r7048<<16|r7047>>>16;r7051=-65536;r7052=-1;r7053=r7049^r7051;r7054=r7050^r7052;r6965=r7054;r6966=r7053}}while(0);r7055=(HEAP32[tempDoublePtr>>2]=r6966,HEAP32[tempDoublePtr+4>>2]=r6965,HEAPF64[tempDoublePtr>>3]);HEAPF64[r6816>>3]=r7055;r7056=r6814&r6771;r7057=r6782+(r7056<<3)|0;HEAPF64[r7057>>3]=r7055;r7058=r6816+8|0;r7059=r6814+1|0;r7060=r6815+1|0;r7061=r7060>>>0<r6754>>>0;if(r7061){r6814=r7059;r6815=r7060;r6816=r7058}else{r6812=r7059;r6813=r7058;break}}}r7062=r6807+1|0;r7063=r7062>>>0<r6755>>>0;if(r7063){r6806=r6812;r6807=r7062;r6808=r6813}else{r6804=r6812;r6805=r6813;break}}}r7064=r6794+1|0;r7065=r7064>>>0<r6756>>>0;if(r7065){r6793=r6804;r6794=r7064;r6795=r6805}else{break}}}r7066=(r6762|0)==0;if(!r7066){_free(r6762)}r7067=HEAP32[r13>>2];r7068=(r7067|0)==0;if(!r7068){r7069=r7067;r7070=HEAP32[r7069>>2];r7071=r7070+4|0;r7072=HEAP32[r7071>>2];FUNCTION_TABLE[r7072](r7067)}r7073=(r6781|0)==0;if(r7073){break L6}_free(r6781);break};case 50:{r7074=HEAP32[r41>>2];r7075=HEAP32[r42>>2];r7076=HEAP32[r43>>2];r7077=HEAP32[r44>>2];r7078=4;r7079=0;r7080=__Znwj(48);r7081=r7080;__ZN9RCqsmodelC2Ebjjj(r7081,0,101,16,1024);r7082=r7080;HEAP32[r12>>2]=r7082;r7083=__Znwj(12);r7084=r7083+4|0;r7085=r7084;HEAP32[r7085>>2]=r7074;r7086=r7083+8|0;r7087=r7086;HEAP32[r7087>>2]=r12;r7088=r7075+1|0;r7089=r7076+1|0;r7090=Math_imul(r7089,r7088)|0;r7091=r7090+r7088|0;r7092=r7091;while(1){r7093=r7092+1|0;r7094=r7093&r7092;r7095=(r7094|0)==0;r7096=r7093|r7092;if(r7095){break}else{r7092=r7096}}r7097=_llvm_umul_with_overflow_i32(r7093,8);r7098=tempRet0;r7099=r7098;r7100=r7097;r7101=r7099?-1:r7100;r7102=__Znwj(r7101);r7103=r7102;r7104=r7090;r7105=0;while(1){r7106=r7105+1|0;r7107=r7105&r7092;r7108=r7103+(r7107<<3)|0;HEAPF64[r7108>>3]=0;r7109=r7104-1|0;r7110=(r7109|0)==0;if(r7110){break}else{r7104=r7109;r7105=r7106}}r7111=(r7077|0)==0;if(!r7111){r7112=(r7076|0)==0;r7113=(r7075|0)==0;r7114=r7090;r7115=0;r7116=r76;while(1){r7117=r7088;r7118=r7114;while(1){r7119=r7118+1|0;r7120=r7118&r7092;r7121=r7103+(r7120<<3)|0;HEAPF64[r7121>>3]=0;r7122=r7117-1|0;r7123=(r7122|0)==0;if(r7123){break}else{r7117=r7122;r7118=r7119}}r7124=r7114+r7088|0;if(r7112){r7125=r7124;r7126=r7116}else{r7127=r7124;r7128=0;r7129=r7116;while(1){r7130=r7127&r7092;r7131=r7103+(r7130<<3)|0;HEAPF64[r7131>>3]=0;r7132=r7127+1|0;if(r7113){r7133=r7132;r7134=r7129}else{r7135=r7132;r7136=0;r7137=r7129;while(1){r7138=r7135-1|0;r7139=r7138&r7092;r7140=r7103+(r7139<<3)|0;r7141=HEAPF64[r7140>>3];r7142=r7140|0;r7143=HEAP32[r7142>>2];r7144=r7140+4|0;r7145=HEAP32[r7144>>2];r7146=r7135-r7088|0;r7147=r7146-r7090|0;r7148=r7147&r7092;r7149=r7103+(r7148<<3)|0;r7150=HEAPF64[r7149>>3];r7151=r7149|0;r7152=HEAP32[r7151>>2];r7153=r7149+4|0;r7154=HEAP32[r7153>>2];r7155=r7141-r7150;r7156=r7146&r7092;r7157=r7103+(r7156<<3)|0;r7158=HEAPF64[r7157>>3];r7159=r7157|0;r7160=HEAP32[r7159>>2];r7161=r7157+4|0;r7162=HEAP32[r7161>>2];r7163=r7155+r7158;r7164=r7138-r7090|0;r7165=r7164&r7092;r7166=r7103+(r7165<<3)|0;r7167=HEAPF64[r7166>>3];r7168=r7166|0;r7169=HEAP32[r7168>>2];r7170=r7166+4|0;r7171=HEAP32[r7170>>2];r7172=r7163-r7167;r7173=r7135-r7090|0;r7174=r7173&r7092;r7175=r7103+(r7174<<3)|0;r7176=HEAPF64[r7175>>3];r7177=r7175|0;r7178=HEAP32[r7177>>2];r7179=r7175+4|0;r7180=HEAP32[r7179>>2];r7181=r7172+r7176;r7182=r7138-r7088|0;r7183=r7182&r7092;r7184=r7103+(r7183<<3)|0;r7185=HEAPF64[r7184>>3];r7186=r7184|0;r7187=HEAP32[r7186>>2];r7188=r7184+4|0;r7189=HEAP32[r7188>>2];r7190=r7181-r7185;r7191=r7182-r7090|0;r7192=r7191&r7092;r7193=r7103+(r7192<<3)|0;r7194=HEAPF64[r7193>>3];r7195=r7193|0;r7196=HEAP32[r7195>>2];r7197=r7193+4|0;r7198=HEAP32[r7197>>2];r7199=r7190+r7194;r7200=HEAP32[r7085>>2];r7201=HEAP32[r7087>>2];r7202=HEAP32[r7201>>2];r7203=__ZN9RCdecoder6decodeEP7RCmodel(r7200,r7202);r7204=r7203>>>0>50;do{if(r7204){r7205=r7203-51|0;r7206=r7205;r7207=0;r7208=1;r7209=0;r7210=_bitshift64Shl(r7208,r7209,r7206);r7211=tempRet0;r7212=HEAP32[r7085>>2];r7213=r7205>>>0>16;do{if(r7213){r7214=__ZN9RCdecoder12decode_shiftEj(r7212,16);r7215=r7214;r7216=0;r7217=r7203-67|0;r7218=r7217>>>0>16;if(!r7218){r7219=0;r7220=16;r7221=r7216;r7222=r7215;r7223=r7217;break}r7224=__ZN9RCdecoder12decode_shiftEj(r7212,16);r7225=r7224;r7226=0;r7227=r7225<<16|0>>>16;r7228=r7226<<16|r7225>>>16;r7229=_i64Add(r7227,r7228,r7215,r7216);r7230=tempRet0;r7231=r7203-83|0;r7232=r7231>>>0>16;if(!r7232){r7219=0;r7220=32;r7221=r7230;r7222=r7229;r7223=r7231;break}r7233=__ZN9RCdecoder12decode_shiftEj(r7212,16);r7234=r7233;r7235=0;r7236=0;r7237=r7234;r7238=_i64Add(r7236,r7237,r7229,r7230);r7239=tempRet0;r7240=r7203-99|0;r7219=0;r7220=48;r7221=r7239;r7222=r7238;r7223=r7240}else{r7219=0;r7220=0;r7221=0;r7222=0;r7223=r7205}}while(0);r7241=__ZN9RCdecoder12decode_shiftEj(r7212,r7223);r7242=r7241;r7243=0;r7244=_bitshift64Shl(r7242,r7243,r7220);r7245=tempRet0;HEAPF64[tempDoublePtr>>3]=r7199;r7246=HEAP32[tempDoublePtr>>2];r7247=HEAP32[tempDoublePtr+4>>2];r7248=r7246>>>14|r7247<<18;r7249=r7247>>>14|0<<18;r7250=-1;r7251=262143;r7252=r7248^r7250;r7253=r7249^r7251;r7254=r7253>>>17|0<<15;r7255=0>>>17|0<<15;r7256=0;r7257=0;r7258=_i64Subtract(r7256,r7257,r7254,r7255);r7259=tempRet0;r7260=r7258>>>15|r7259<<17;r7261=r7259>>>15|0<<17;r7262=r7260^r7252;r7263=r7261^r7253;r7264=_i64Add(r7210,r7211,r7262,r7263);r7265=tempRet0;r7266=_i64Add(r7264,r7265,r7222,r7221);r7267=tempRet0;r7268=_i64Add(r7266,r7267,r7244,r7245);r7269=tempRet0;r7270=r7269>>>17|0<<15;r7271=0>>>17|0<<15;r7272=0;r7273=0;r7274=_i64Subtract(r7272,r7273,r7270,r7271);r7275=tempRet0;r7276=r7274>>>15|r7275<<17;r7277=r7275>>>15|0<<17;r7278=r7276^r7268;r7279=r7277^r7269;r7280=r7278<<14|0>>>18;r7281=r7279<<14|r7278>>>18;r7282=-16384;r7283=-1;r7284=r7280^r7282;r7285=r7281^r7283;r7286=r7285;r7287=r7284}else{r7288=r7203>>>0<50;if(!r7288){HEAPF64[tempDoublePtr>>3]=r7199;r7289=HEAP32[tempDoublePtr>>2];r7290=HEAP32[tempDoublePtr+4>>2];r7291=-16384;r7292=-1;r7293=r7289&r7291;r7294=r7290&r7292;r7286=r7294;r7287=r7293;break}r7295=49-r7203|0;r7296=r7295;r7297=0;r7298=HEAP32[r7085>>2];r7299=r7295>>>0>16;do{if(r7299){r7300=__ZN9RCdecoder12decode_shiftEj(r7298,16);r7301=r7300;r7302=0;r7303=r7295-16|0;r7304=r7303>>>0>16;if(!r7304){r7305=0;r7306=16;r7307=r7302;r7308=r7301;r7309=r7303;break}r7310=__ZN9RCdecoder12decode_shiftEj(r7298,16);r7311=r7310;r7312=0;r7313=r7311<<16|0>>>16;r7314=r7312<<16|r7311>>>16;r7315=_i64Add(r7313,r7314,r7301,r7302);r7316=tempRet0;r7317=r7295-32|0;r7318=r7317>>>0>16;if(!r7318){r7305=0;r7306=32;r7307=r7316;r7308=r7315;r7309=r7317;break}r7319=__ZN9RCdecoder12decode_shiftEj(r7298,16);r7320=r7319;r7321=0;r7322=0;r7323=r7320;r7324=_i64Add(r7322,r7323,r7315,r7316);r7325=tempRet0;r7326=r7295-48|0;r7305=0;r7306=48;r7307=r7325;r7308=r7324;r7309=r7326}else{r7305=0;r7306=0;r7307=0;r7308=0;r7309=r7295}}while(0);r7327=__ZN9RCdecoder12decode_shiftEj(r7298,r7309);r7328=r7327;r7329=0;r7330=_bitshift64Shl(r7328,r7329,r7306);r7331=tempRet0;HEAPF64[tempDoublePtr>>3]=r7199;r7332=HEAP32[tempDoublePtr>>2];r7333=HEAP32[tempDoublePtr+4>>2];r7334=r7332>>>14|r7333<<18;r7335=r7333>>>14|0<<18;r7336=-1;r7337=262143;r7338=r7334^r7336;r7339=r7335^r7337;r7340=r7339>>>17|0<<15;r7341=0>>>17|0<<15;r7342=0;r7343=0;r7344=_i64Subtract(r7342,r7343,r7340,r7341);r7345=tempRet0;r7346=r7344>>>15|r7345<<17;r7347=r7345>>>15|0<<17;r7348=r7346^r7338;r7349=r7347^r7339;r7350=-1;r7351=-1;r7352=_bitshift64Shl(r7350,r7351,r7296);r7353=tempRet0;r7354=_i64Add(r7352,r7353,r7348,r7349);r7355=tempRet0;r7356=_i64Subtract(r7354,r7355,r7308,r7307);r7357=tempRet0;r7358=_i64Subtract(r7356,r7357,r7330,r7331);r7359=tempRet0;r7360=r7359>>>17|0<<15;r7361=0>>>17|0<<15;r7362=0;r7363=0;r7364=_i64Subtract(r7362,r7363,r7360,r7361);r7365=tempRet0;r7366=r7364>>>15|r7365<<17;r7367=r7365>>>15|0<<17;r7368=r7366^r7358;r7369=r7367^r7359;r7370=r7368<<14|0>>>18;r7371=r7369<<14|r7368>>>18;r7372=-16384;r7373=-1;r7374=r7370^r7372;r7375=r7371^r7373;r7286=r7375;r7287=r7374}}while(0);r7376=(HEAP32[tempDoublePtr>>2]=r7287,HEAP32[tempDoublePtr+4>>2]=r7286,HEAPF64[tempDoublePtr>>3]);HEAPF64[r7137>>3]=r7376;r7377=r7135&r7092;r7378=r7103+(r7377<<3)|0;HEAPF64[r7378>>3]=r7376;r7379=r7137+8|0;r7380=r7135+1|0;r7381=r7136+1|0;r7382=r7381>>>0<r7075>>>0;if(r7382){r7135=r7380;r7136=r7381;r7137=r7379}else{r7133=r7380;r7134=r7379;break}}}r7383=r7128+1|0;r7384=r7383>>>0<r7076>>>0;if(r7384){r7127=r7133;r7128=r7383;r7129=r7134}else{r7125=r7133;r7126=r7134;break}}}r7385=r7115+1|0;r7386=r7385>>>0<r7077>>>0;if(r7386){r7114=r7125;r7115=r7385;r7116=r7126}else{break}}}r7387=(r7083|0)==0;if(!r7387){_free(r7083)}r7388=HEAP32[r12>>2];r7389=(r7388|0)==0;if(!r7389){r7390=r7388;r7391=HEAP32[r7390>>2];r7392=r7391+4|0;r7393=HEAP32[r7392>>2];FUNCTION_TABLE[r7393](r7388)}r7394=(r7102|0)==0;if(r7394){break L6}_free(r7102);break};case 52:{r7395=HEAP32[r41>>2];r7396=HEAP32[r42>>2];r7397=HEAP32[r43>>2];r7398=HEAP32[r44>>2];r7399=4;r7400=0;r7401=__Znwj(48);r7402=r7401;__ZN9RCqsmodelC2Ebjjj(r7402,0,105,16,1024);r7403=r7401;HEAP32[r11>>2]=r7403;r7404=__Znwj(12);r7405=r7404+4|0;r7406=r7405;HEAP32[r7406>>2]=r7395;r7407=r7404+8|0;r7408=r7407;HEAP32[r7408>>2]=r11;r7409=r7396+1|0;r7410=r7397+1|0;r7411=Math_imul(r7410,r7409)|0;r7412=r7411+r7409|0;r7413=r7412;while(1){r7414=r7413+1|0;r7415=r7414&r7413;r7416=(r7415|0)==0;r7417=r7414|r7413;if(r7416){break}else{r7413=r7417}}r7418=_llvm_umul_with_overflow_i32(r7414,8);r7419=tempRet0;r7420=r7419;r7421=r7418;r7422=r7420?-1:r7421;r7423=__Znwj(r7422);r7424=r7423;r7425=r7411;r7426=0;while(1){r7427=r7426+1|0;r7428=r7426&r7413;r7429=r7424+(r7428<<3)|0;HEAPF64[r7429>>3]=0;r7430=r7425-1|0;r7431=(r7430|0)==0;if(r7431){break}else{r7425=r7430;r7426=r7427}}r7432=(r7398|0)==0;if(!r7432){r7433=(r7397|0)==0;r7434=(r7396|0)==0;r7435=r7411;r7436=0;r7437=r76;while(1){r7438=r7409;r7439=r7435;while(1){r7440=r7439+1|0;r7441=r7439&r7413;r7442=r7424+(r7441<<3)|0;HEAPF64[r7442>>3]=0;r7443=r7438-1|0;r7444=(r7443|0)==0;if(r7444){break}else{r7438=r7443;r7439=r7440}}r7445=r7435+r7409|0;if(r7433){r7446=r7445;r7447=r7437}else{r7448=r7445;r7449=0;r7450=r7437;while(1){r7451=r7448&r7413;r7452=r7424+(r7451<<3)|0;HEAPF64[r7452>>3]=0;r7453=r7448+1|0;if(r7434){r7454=r7453;r7455=r7450}else{r7456=r7453;r7457=0;r7458=r7450;while(1){r7459=r7456-1|0;r7460=r7459&r7413;r7461=r7424+(r7460<<3)|0;r7462=HEAPF64[r7461>>3];r7463=r7461|0;r7464=HEAP32[r7463>>2];r7465=r7461+4|0;r7466=HEAP32[r7465>>2];r7467=r7456-r7409|0;r7468=r7467-r7411|0;r7469=r7468&r7413;r7470=r7424+(r7469<<3)|0;r7471=HEAPF64[r7470>>3];r7472=r7470|0;r7473=HEAP32[r7472>>2];r7474=r7470+4|0;r7475=HEAP32[r7474>>2];r7476=r7462-r7471;r7477=r7467&r7413;r7478=r7424+(r7477<<3)|0;r7479=HEAPF64[r7478>>3];r7480=r7478|0;r7481=HEAP32[r7480>>2];r7482=r7478+4|0;r7483=HEAP32[r7482>>2];r7484=r7476+r7479;r7485=r7459-r7411|0;r7486=r7485&r7413;r7487=r7424+(r7486<<3)|0;r7488=HEAPF64[r7487>>3];r7489=r7487|0;r7490=HEAP32[r7489>>2];r7491=r7487+4|0;r7492=HEAP32[r7491>>2];r7493=r7484-r7488;r7494=r7456-r7411|0;r7495=r7494&r7413;r7496=r7424+(r7495<<3)|0;r7497=HEAPF64[r7496>>3];r7498=r7496|0;r7499=HEAP32[r7498>>2];r7500=r7496+4|0;r7501=HEAP32[r7500>>2];r7502=r7493+r7497;r7503=r7459-r7409|0;r7504=r7503&r7413;r7505=r7424+(r7504<<3)|0;r7506=HEAPF64[r7505>>3];r7507=r7505|0;r7508=HEAP32[r7507>>2];r7509=r7505+4|0;r7510=HEAP32[r7509>>2];r7511=r7502-r7506;r7512=r7503-r7411|0;r7513=r7512&r7413;r7514=r7424+(r7513<<3)|0;r7515=HEAPF64[r7514>>3];r7516=r7514|0;r7517=HEAP32[r7516>>2];r7518=r7514+4|0;r7519=HEAP32[r7518>>2];r7520=r7511+r7515;r7521=HEAP32[r7406>>2];r7522=HEAP32[r7408>>2];r7523=HEAP32[r7522>>2];r7524=__ZN9RCdecoder6decodeEP7RCmodel(r7521,r7523);r7525=r7524>>>0>52;do{if(r7525){r7526=r7524-53|0;r7527=r7526;r7528=0;r7529=1;r7530=0;r7531=_bitshift64Shl(r7529,r7530,r7527);r7532=tempRet0;r7533=HEAP32[r7406>>2];r7534=r7526>>>0>16;do{if(r7534){r7535=__ZN9RCdecoder12decode_shiftEj(r7533,16);r7536=r7535;r7537=0;r7538=r7524-69|0;r7539=r7538>>>0>16;if(!r7539){r7540=0;r7541=16;r7542=r7537;r7543=r7536;r7544=r7538;break}r7545=__ZN9RCdecoder12decode_shiftEj(r7533,16);r7546=r7545;r7547=0;r7548=r7546<<16|0>>>16;r7549=r7547<<16|r7546>>>16;r7550=_i64Add(r7548,r7549,r7536,r7537);r7551=tempRet0;r7552=r7524-85|0;r7553=r7552>>>0>16;if(!r7553){r7540=0;r7541=32;r7542=r7551;r7543=r7550;r7544=r7552;break}r7554=__ZN9RCdecoder12decode_shiftEj(r7533,16);r7555=r7554;r7556=0;r7557=0;r7558=r7555;r7559=_i64Add(r7557,r7558,r7550,r7551);r7560=tempRet0;r7561=r7524-101|0;r7540=0;r7541=48;r7542=r7560;r7543=r7559;r7544=r7561}else{r7540=0;r7541=0;r7542=0;r7543=0;r7544=r7526}}while(0);r7562=__ZN9RCdecoder12decode_shiftEj(r7533,r7544);r7563=r7562;r7564=0;r7565=_bitshift64Shl(r7563,r7564,r7541);r7566=tempRet0;HEAPF64[tempDoublePtr>>3]=r7520;r7567=HEAP32[tempDoublePtr>>2];r7568=HEAP32[tempDoublePtr+4>>2];r7569=r7567>>>12|r7568<<20;r7570=r7568>>>12|0<<20;r7571=-1;r7572=1048575;r7573=r7569^r7571;r7574=r7570^r7572;r7575=r7574>>>19|0<<13;r7576=0>>>19|0<<13;r7577=0;r7578=0;r7579=_i64Subtract(r7577,r7578,r7575,r7576);r7580=tempRet0;r7581=r7579>>>13|r7580<<19;r7582=r7580>>>13|0<<19;r7583=r7581^r7573;r7584=r7582^r7574;r7585=_i64Add(r7531,r7532,r7583,r7584);r7586=tempRet0;r7587=_i64Add(r7585,r7586,r7543,r7542);r7588=tempRet0;r7589=_i64Add(r7587,r7588,r7565,r7566);r7590=tempRet0;r7591=r7590>>>19|0<<13;r7592=0>>>19|0<<13;r7593=0;r7594=0;r7595=_i64Subtract(r7593,r7594,r7591,r7592);r7596=tempRet0;r7597=r7595>>>13|r7596<<19;r7598=r7596>>>13|0<<19;r7599=r7597^r7589;r7600=r7598^r7590;r7601=r7599<<12|0>>>20;r7602=r7600<<12|r7599>>>20;r7603=-4096;r7604=-1;r7605=r7601^r7603;r7606=r7602^r7604;r7607=r7606;r7608=r7605}else{r7609=r7524>>>0<52;if(!r7609){HEAPF64[tempDoublePtr>>3]=r7520;r7610=HEAP32[tempDoublePtr>>2];r7611=HEAP32[tempDoublePtr+4>>2];r7612=-4096;r7613=-1;r7614=r7610&r7612;r7615=r7611&r7613;r7607=r7615;r7608=r7614;break}r7616=51-r7524|0;r7617=r7616;r7618=0;r7619=HEAP32[r7406>>2];r7620=r7616>>>0>16;do{if(r7620){r7621=__ZN9RCdecoder12decode_shiftEj(r7619,16);r7622=r7621;r7623=0;r7624=r7616-16|0;r7625=r7624>>>0>16;if(!r7625){r7626=0;r7627=16;r7628=r7623;r7629=r7622;r7630=r7624;break}r7631=__ZN9RCdecoder12decode_shiftEj(r7619,16);r7632=r7631;r7633=0;r7634=r7632<<16|0>>>16;r7635=r7633<<16|r7632>>>16;r7636=_i64Add(r7634,r7635,r7622,r7623);r7637=tempRet0;r7638=r7616-32|0;r7639=r7638>>>0>16;if(!r7639){r7626=0;r7627=32;r7628=r7637;r7629=r7636;r7630=r7638;break}r7640=__ZN9RCdecoder12decode_shiftEj(r7619,16);r7641=r7640;r7642=0;r7643=0;r7644=r7641;r7645=_i64Add(r7643,r7644,r7636,r7637);r7646=tempRet0;r7647=r7616-48|0;r7626=0;r7627=48;r7628=r7646;r7629=r7645;r7630=r7647}else{r7626=0;r7627=0;r7628=0;r7629=0;r7630=r7616}}while(0);r7648=__ZN9RCdecoder12decode_shiftEj(r7619,r7630);r7649=r7648;r7650=0;r7651=_bitshift64Shl(r7649,r7650,r7627);r7652=tempRet0;HEAPF64[tempDoublePtr>>3]=r7520;r7653=HEAP32[tempDoublePtr>>2];r7654=HEAP32[tempDoublePtr+4>>2];r7655=r7653>>>12|r7654<<20;r7656=r7654>>>12|0<<20;r7657=-1;r7658=1048575;r7659=r7655^r7657;r7660=r7656^r7658;r7661=r7660>>>19|0<<13;r7662=0>>>19|0<<13;r7663=0;r7664=0;r7665=_i64Subtract(r7663,r7664,r7661,r7662);r7666=tempRet0;r7667=r7665>>>13|r7666<<19;r7668=r7666>>>13|0<<19;r7669=r7667^r7659;r7670=r7668^r7660;r7671=-1;r7672=-1;r7673=_bitshift64Shl(r7671,r7672,r7617);r7674=tempRet0;r7675=_i64Add(r7673,r7674,r7669,r7670);r7676=tempRet0;r7677=_i64Subtract(r7675,r7676,r7629,r7628);r7678=tempRet0;r7679=_i64Subtract(r7677,r7678,r7651,r7652);r7680=tempRet0;r7681=r7680>>>19|0<<13;r7682=0>>>19|0<<13;r7683=0;r7684=0;r7685=_i64Subtract(r7683,r7684,r7681,r7682);r7686=tempRet0;r7687=r7685>>>13|r7686<<19;r7688=r7686>>>13|0<<19;r7689=r7687^r7679;r7690=r7688^r7680;r7691=r7689<<12|0>>>20;r7692=r7690<<12|r7689>>>20;r7693=-4096;r7694=-1;r7695=r7691^r7693;r7696=r7692^r7694;r7607=r7696;r7608=r7695}}while(0);r7697=(HEAP32[tempDoublePtr>>2]=r7608,HEAP32[tempDoublePtr+4>>2]=r7607,HEAPF64[tempDoublePtr>>3]);HEAPF64[r7458>>3]=r7697;r7698=r7456&r7413;r7699=r7424+(r7698<<3)|0;HEAPF64[r7699>>3]=r7697;r7700=r7458+8|0;r7701=r7456+1|0;r7702=r7457+1|0;r7703=r7702>>>0<r7396>>>0;if(r7703){r7456=r7701;r7457=r7702;r7458=r7700}else{r7454=r7701;r7455=r7700;break}}}r7704=r7449+1|0;r7705=r7704>>>0<r7397>>>0;if(r7705){r7448=r7454;r7449=r7704;r7450=r7455}else{r7446=r7454;r7447=r7455;break}}}r7706=r7436+1|0;r7707=r7706>>>0<r7398>>>0;if(r7707){r7435=r7446;r7436=r7706;r7437=r7447}else{break}}}r7708=(r7404|0)==0;if(!r7708){_free(r7404)}r7709=HEAP32[r11>>2];r7710=(r7709|0)==0;if(!r7710){r7711=r7709;r7712=HEAP32[r7711>>2];r7713=r7712+4|0;r7714=HEAP32[r7713>>2];FUNCTION_TABLE[r7714](r7709)}r7715=(r7423|0)==0;if(r7715){break L6}_free(r7423);break};case 54:{r7716=HEAP32[r41>>2];r7717=HEAP32[r42>>2];r7718=HEAP32[r43>>2];r7719=HEAP32[r44>>2];r7720=4;r7721=0;r7722=__Znwj(48);r7723=r7722;__ZN9RCqsmodelC2Ebjjj(r7723,0,109,16,1024);r7724=r7722;HEAP32[r10>>2]=r7724;r7725=__Znwj(12);r7726=r7725+4|0;r7727=r7726;HEAP32[r7727>>2]=r7716;r7728=r7725+8|0;r7729=r7728;HEAP32[r7729>>2]=r10;r7730=r7717+1|0;r7731=r7718+1|0;r7732=Math_imul(r7731,r7730)|0;r7733=r7732+r7730|0;r7734=r7733;while(1){r7735=r7734+1|0;r7736=r7735&r7734;r7737=(r7736|0)==0;r7738=r7735|r7734;if(r7737){break}else{r7734=r7738}}r7739=_llvm_umul_with_overflow_i32(r7735,8);r7740=tempRet0;r7741=r7740;r7742=r7739;r7743=r7741?-1:r7742;r7744=__Znwj(r7743);r7745=r7744;r7746=r7732;r7747=0;while(1){r7748=r7747+1|0;r7749=r7747&r7734;r7750=r7745+(r7749<<3)|0;HEAPF64[r7750>>3]=0;r7751=r7746-1|0;r7752=(r7751|0)==0;if(r7752){break}else{r7746=r7751;r7747=r7748}}r7753=(r7719|0)==0;if(!r7753){r7754=(r7718|0)==0;r7755=(r7717|0)==0;r7756=r7732;r7757=0;r7758=r76;while(1){r7759=r7730;r7760=r7756;while(1){r7761=r7760+1|0;r7762=r7760&r7734;r7763=r7745+(r7762<<3)|0;HEAPF64[r7763>>3]=0;r7764=r7759-1|0;r7765=(r7764|0)==0;if(r7765){break}else{r7759=r7764;r7760=r7761}}r7766=r7756+r7730|0;if(r7754){r7767=r7766;r7768=r7758}else{r7769=r7766;r7770=0;r7771=r7758;while(1){r7772=r7769&r7734;r7773=r7745+(r7772<<3)|0;HEAPF64[r7773>>3]=0;r7774=r7769+1|0;if(r7755){r7775=r7774;r7776=r7771}else{r7777=r7774;r7778=0;r7779=r7771;while(1){r7780=r7777-1|0;r7781=r7780&r7734;r7782=r7745+(r7781<<3)|0;r7783=HEAPF64[r7782>>3];r7784=r7782|0;r7785=HEAP32[r7784>>2];r7786=r7782+4|0;r7787=HEAP32[r7786>>2];r7788=r7777-r7730|0;r7789=r7788-r7732|0;r7790=r7789&r7734;r7791=r7745+(r7790<<3)|0;r7792=HEAPF64[r7791>>3];r7793=r7791|0;r7794=HEAP32[r7793>>2];r7795=r7791+4|0;r7796=HEAP32[r7795>>2];r7797=r7783-r7792;r7798=r7788&r7734;r7799=r7745+(r7798<<3)|0;r7800=HEAPF64[r7799>>3];r7801=r7799|0;r7802=HEAP32[r7801>>2];r7803=r7799+4|0;r7804=HEAP32[r7803>>2];r7805=r7797+r7800;r7806=r7780-r7732|0;r7807=r7806&r7734;r7808=r7745+(r7807<<3)|0;r7809=HEAPF64[r7808>>3];r7810=r7808|0;r7811=HEAP32[r7810>>2];r7812=r7808+4|0;r7813=HEAP32[r7812>>2];r7814=r7805-r7809;r7815=r7777-r7732|0;r7816=r7815&r7734;r7817=r7745+(r7816<<3)|0;r7818=HEAPF64[r7817>>3];r7819=r7817|0;r7820=HEAP32[r7819>>2];r7821=r7817+4|0;r7822=HEAP32[r7821>>2];r7823=r7814+r7818;r7824=r7780-r7730|0;r7825=r7824&r7734;r7826=r7745+(r7825<<3)|0;r7827=HEAPF64[r7826>>3];r7828=r7826|0;r7829=HEAP32[r7828>>2];r7830=r7826+4|0;r7831=HEAP32[r7830>>2];r7832=r7823-r7827;r7833=r7824-r7732|0;r7834=r7833&r7734;r7835=r7745+(r7834<<3)|0;r7836=HEAPF64[r7835>>3];r7837=r7835|0;r7838=HEAP32[r7837>>2];r7839=r7835+4|0;r7840=HEAP32[r7839>>2];r7841=r7832+r7836;r7842=HEAP32[r7727>>2];r7843=HEAP32[r7729>>2];r7844=HEAP32[r7843>>2];r7845=__ZN9RCdecoder6decodeEP7RCmodel(r7842,r7844);r7846=r7845>>>0>54;do{if(r7846){r7847=r7845-55|0;r7848=r7847;r7849=0;r7850=1;r7851=0;r7852=_bitshift64Shl(r7850,r7851,r7848);r7853=tempRet0;r7854=HEAP32[r7727>>2];r7855=r7847>>>0>16;do{if(r7855){r7856=__ZN9RCdecoder12decode_shiftEj(r7854,16);r7857=r7856;r7858=0;r7859=r7845-71|0;r7860=r7859>>>0>16;if(!r7860){r7861=0;r7862=16;r7863=r7858;r7864=r7857;r7865=r7859;break}r7866=__ZN9RCdecoder12decode_shiftEj(r7854,16);r7867=r7866;r7868=0;r7869=r7867<<16|0>>>16;r7870=r7868<<16|r7867>>>16;r7871=_i64Add(r7869,r7870,r7857,r7858);r7872=tempRet0;r7873=r7845-87|0;r7874=r7873>>>0>16;if(!r7874){r7861=0;r7862=32;r7863=r7872;r7864=r7871;r7865=r7873;break}r7875=__ZN9RCdecoder12decode_shiftEj(r7854,16);r7876=r7875;r7877=0;r7878=0;r7879=r7876;r7880=_i64Add(r7878,r7879,r7871,r7872);r7881=tempRet0;r7882=r7845-103|0;r7861=0;r7862=48;r7863=r7881;r7864=r7880;r7865=r7882}else{r7861=0;r7862=0;r7863=0;r7864=0;r7865=r7847}}while(0);r7883=__ZN9RCdecoder12decode_shiftEj(r7854,r7865);r7884=r7883;r7885=0;r7886=_bitshift64Shl(r7884,r7885,r7862);r7887=tempRet0;HEAPF64[tempDoublePtr>>3]=r7841;r7888=HEAP32[tempDoublePtr>>2];r7889=HEAP32[tempDoublePtr+4>>2];r7890=r7888>>>10|r7889<<22;r7891=r7889>>>10|0<<22;r7892=-1;r7893=4194303;r7894=r7890^r7892;r7895=r7891^r7893;r7896=r7895>>>21|0<<11;r7897=0>>>21|0<<11;r7898=0;r7899=0;r7900=_i64Subtract(r7898,r7899,r7896,r7897);r7901=tempRet0;r7902=r7900>>>11|r7901<<21;r7903=r7901>>>11|0<<21;r7904=r7902^r7894;r7905=r7903^r7895;r7906=_i64Add(r7852,r7853,r7904,r7905);r7907=tempRet0;r7908=_i64Add(r7906,r7907,r7864,r7863);r7909=tempRet0;r7910=_i64Add(r7908,r7909,r7886,r7887);r7911=tempRet0;r7912=r7911>>>21|0<<11;r7913=0>>>21|0<<11;r7914=0;r7915=0;r7916=_i64Subtract(r7914,r7915,r7912,r7913);r7917=tempRet0;r7918=r7916>>>11|r7917<<21;r7919=r7917>>>11|0<<21;r7920=r7918^r7910;r7921=r7919^r7911;r7922=r7920<<10|0>>>22;r7923=r7921<<10|r7920>>>22;r7924=-1024;r7925=-1;r7926=r7922^r7924;r7927=r7923^r7925;r7928=r7927;r7929=r7926}else{r7930=r7845>>>0<54;if(!r7930){HEAPF64[tempDoublePtr>>3]=r7841;r7931=HEAP32[tempDoublePtr>>2];r7932=HEAP32[tempDoublePtr+4>>2];r7933=-1024;r7934=-1;r7935=r7931&r7933;r7936=r7932&r7934;r7928=r7936;r7929=r7935;break}r7937=53-r7845|0;r7938=r7937;r7939=0;r7940=HEAP32[r7727>>2];r7941=r7937>>>0>16;do{if(r7941){r7942=__ZN9RCdecoder12decode_shiftEj(r7940,16);r7943=r7942;r7944=0;r7945=r7937-16|0;r7946=r7945>>>0>16;if(!r7946){r7947=0;r7948=16;r7949=r7944;r7950=r7943;r7951=r7945;break}r7952=__ZN9RCdecoder12decode_shiftEj(r7940,16);r7953=r7952;r7954=0;r7955=r7953<<16|0>>>16;r7956=r7954<<16|r7953>>>16;r7957=_i64Add(r7955,r7956,r7943,r7944);r7958=tempRet0;r7959=r7937-32|0;r7960=r7959>>>0>16;if(!r7960){r7947=0;r7948=32;r7949=r7958;r7950=r7957;r7951=r7959;break}r7961=__ZN9RCdecoder12decode_shiftEj(r7940,16);r7962=r7961;r7963=0;r7964=0;r7965=r7962;r7966=_i64Add(r7964,r7965,r7957,r7958);r7967=tempRet0;r7968=r7937-48|0;r7947=0;r7948=48;r7949=r7967;r7950=r7966;r7951=r7968}else{r7947=0;r7948=0;r7949=0;r7950=0;r7951=r7937}}while(0);r7969=__ZN9RCdecoder12decode_shiftEj(r7940,r7951);r7970=r7969;r7971=0;r7972=_bitshift64Shl(r7970,r7971,r7948);r7973=tempRet0;HEAPF64[tempDoublePtr>>3]=r7841;r7974=HEAP32[tempDoublePtr>>2];r7975=HEAP32[tempDoublePtr+4>>2];r7976=r7974>>>10|r7975<<22;r7977=r7975>>>10|0<<22;r7978=-1;r7979=4194303;r7980=r7976^r7978;r7981=r7977^r7979;r7982=r7981>>>21|0<<11;r7983=0>>>21|0<<11;r7984=0;r7985=0;r7986=_i64Subtract(r7984,r7985,r7982,r7983);r7987=tempRet0;r7988=r7986>>>11|r7987<<21;r7989=r7987>>>11|0<<21;r7990=r7988^r7980;r7991=r7989^r7981;r7992=-1;r7993=-1;r7994=_bitshift64Shl(r7992,r7993,r7938);r7995=tempRet0;r7996=_i64Add(r7994,r7995,r7990,r7991);r7997=tempRet0;r7998=_i64Subtract(r7996,r7997,r7950,r7949);r7999=tempRet0;r8000=_i64Subtract(r7998,r7999,r7972,r7973);r8001=tempRet0;r8002=r8001>>>21|0<<11;r8003=0>>>21|0<<11;r8004=0;r8005=0;r8006=_i64Subtract(r8004,r8005,r8002,r8003);r8007=tempRet0;r8008=r8006>>>11|r8007<<21;r8009=r8007>>>11|0<<21;r8010=r8008^r8000;r8011=r8009^r8001;r8012=r8010<<10|0>>>22;r8013=r8011<<10|r8010>>>22;r8014=-1024;r8015=-1;r8016=r8012^r8014;r8017=r8013^r8015;r7928=r8017;r7929=r8016}}while(0);r8018=(HEAP32[tempDoublePtr>>2]=r7929,HEAP32[tempDoublePtr+4>>2]=r7928,HEAPF64[tempDoublePtr>>3]);HEAPF64[r7779>>3]=r8018;r8019=r7777&r7734;r8020=r7745+(r8019<<3)|0;HEAPF64[r8020>>3]=r8018;r8021=r7779+8|0;r8022=r7777+1|0;r8023=r7778+1|0;r8024=r8023>>>0<r7717>>>0;if(r8024){r7777=r8022;r7778=r8023;r7779=r8021}else{r7775=r8022;r7776=r8021;break}}}r8025=r7770+1|0;r8026=r8025>>>0<r7718>>>0;if(r8026){r7769=r7775;r7770=r8025;r7771=r7776}else{r7767=r7775;r7768=r7776;break}}}r8027=r7757+1|0;r8028=r8027>>>0<r7719>>>0;if(r8028){r7756=r7767;r7757=r8027;r7758=r7768}else{break}}}r8029=(r7725|0)==0;if(!r8029){_free(r7725)}r8030=HEAP32[r10>>2];r8031=(r8030|0)==0;if(!r8031){r8032=r8030;r8033=HEAP32[r8032>>2];r8034=r8033+4|0;r8035=HEAP32[r8034>>2];FUNCTION_TABLE[r8035](r8030)}r8036=(r7744|0)==0;if(r8036){break L6}_free(r7744);break};case 56:{r8037=HEAP32[r41>>2];r8038=HEAP32[r42>>2];r8039=HEAP32[r43>>2];r8040=HEAP32[r44>>2];r8041=4;r8042=0;r8043=__Znwj(48);r8044=r8043;__ZN9RCqsmodelC2Ebjjj(r8044,0,113,16,1024);r8045=r8043;HEAP32[r9>>2]=r8045;r8046=__Znwj(12);r8047=r8046+4|0;r8048=r8047;HEAP32[r8048>>2]=r8037;r8049=r8046+8|0;r8050=r8049;HEAP32[r8050>>2]=r9;r8051=r8038+1|0;r8052=r8039+1|0;r8053=Math_imul(r8052,r8051)|0;r8054=r8053+r8051|0;r8055=r8054;while(1){r8056=r8055+1|0;r8057=r8056&r8055;r8058=(r8057|0)==0;r8059=r8056|r8055;if(r8058){break}else{r8055=r8059}}r8060=_llvm_umul_with_overflow_i32(r8056,8);r8061=tempRet0;r8062=r8061;r8063=r8060;r8064=r8062?-1:r8063;r8065=__Znwj(r8064);r8066=r8065;r8067=r8053;r8068=0;while(1){r8069=r8068+1|0;r8070=r8068&r8055;r8071=r8066+(r8070<<3)|0;HEAPF64[r8071>>3]=0;r8072=r8067-1|0;r8073=(r8072|0)==0;if(r8073){break}else{r8067=r8072;r8068=r8069}}r8074=(r8040|0)==0;if(!r8074){r8075=(r8039|0)==0;r8076=(r8038|0)==0;r8077=r8053;r8078=0;r8079=r76;while(1){r8080=r8051;r8081=r8077;while(1){r8082=r8081+1|0;r8083=r8081&r8055;r8084=r8066+(r8083<<3)|0;HEAPF64[r8084>>3]=0;r8085=r8080-1|0;r8086=(r8085|0)==0;if(r8086){break}else{r8080=r8085;r8081=r8082}}r8087=r8077+r8051|0;if(r8075){r8088=r8087;r8089=r8079}else{r8090=r8087;r8091=0;r8092=r8079;while(1){r8093=r8090&r8055;r8094=r8066+(r8093<<3)|0;HEAPF64[r8094>>3]=0;r8095=r8090+1|0;if(r8076){r8096=r8095;r8097=r8092}else{r8098=r8095;r8099=0;r8100=r8092;while(1){r8101=r8098-1|0;r8102=r8101&r8055;r8103=r8066+(r8102<<3)|0;r8104=HEAPF64[r8103>>3];r8105=r8103|0;r8106=HEAP32[r8105>>2];r8107=r8103+4|0;r8108=HEAP32[r8107>>2];r8109=r8098-r8051|0;r8110=r8109-r8053|0;r8111=r8110&r8055;r8112=r8066+(r8111<<3)|0;r8113=HEAPF64[r8112>>3];r8114=r8112|0;r8115=HEAP32[r8114>>2];r8116=r8112+4|0;r8117=HEAP32[r8116>>2];r8118=r8104-r8113;r8119=r8109&r8055;r8120=r8066+(r8119<<3)|0;r8121=HEAPF64[r8120>>3];r8122=r8120|0;r8123=HEAP32[r8122>>2];r8124=r8120+4|0;r8125=HEAP32[r8124>>2];r8126=r8118+r8121;r8127=r8101-r8053|0;r8128=r8127&r8055;r8129=r8066+(r8128<<3)|0;r8130=HEAPF64[r8129>>3];r8131=r8129|0;r8132=HEAP32[r8131>>2];r8133=r8129+4|0;r8134=HEAP32[r8133>>2];r8135=r8126-r8130;r8136=r8098-r8053|0;r8137=r8136&r8055;r8138=r8066+(r8137<<3)|0;r8139=HEAPF64[r8138>>3];r8140=r8138|0;r8141=HEAP32[r8140>>2];r8142=r8138+4|0;r8143=HEAP32[r8142>>2];r8144=r8135+r8139;r8145=r8101-r8051|0;r8146=r8145&r8055;r8147=r8066+(r8146<<3)|0;r8148=HEAPF64[r8147>>3];r8149=r8147|0;r8150=HEAP32[r8149>>2];r8151=r8147+4|0;r8152=HEAP32[r8151>>2];r8153=r8144-r8148;r8154=r8145-r8053|0;r8155=r8154&r8055;r8156=r8066+(r8155<<3)|0;r8157=HEAPF64[r8156>>3];r8158=r8156|0;r8159=HEAP32[r8158>>2];r8160=r8156+4|0;r8161=HEAP32[r8160>>2];r8162=r8153+r8157;r8163=HEAP32[r8048>>2];r8164=HEAP32[r8050>>2];r8165=HEAP32[r8164>>2];r8166=__ZN9RCdecoder6decodeEP7RCmodel(r8163,r8165);r8167=r8166>>>0>56;do{if(r8167){r8168=r8166-57|0;r8169=r8168;r8170=0;r8171=1;r8172=0;r8173=_bitshift64Shl(r8171,r8172,r8169);r8174=tempRet0;r8175=HEAP32[r8048>>2];r8176=r8168>>>0>16;do{if(r8176){r8177=__ZN9RCdecoder12decode_shiftEj(r8175,16);r8178=r8177;r8179=0;r8180=r8166-73|0;r8181=r8180>>>0>16;if(!r8181){r8182=0;r8183=16;r8184=r8179;r8185=r8178;r8186=r8180;break}r8187=__ZN9RCdecoder12decode_shiftEj(r8175,16);r8188=r8187;r8189=0;r8190=r8188<<16|0>>>16;r8191=r8189<<16|r8188>>>16;r8192=_i64Add(r8190,r8191,r8178,r8179);r8193=tempRet0;r8194=r8166-89|0;r8195=r8194>>>0>16;if(!r8195){r8182=0;r8183=32;r8184=r8193;r8185=r8192;r8186=r8194;break}r8196=__ZN9RCdecoder12decode_shiftEj(r8175,16);r8197=r8196;r8198=0;r8199=0;r8200=r8197;r8201=_i64Add(r8199,r8200,r8192,r8193);r8202=tempRet0;r8203=r8166-105|0;r8182=0;r8183=48;r8184=r8202;r8185=r8201;r8186=r8203}else{r8182=0;r8183=0;r8184=0;r8185=0;r8186=r8168}}while(0);r8204=__ZN9RCdecoder12decode_shiftEj(r8175,r8186);r8205=r8204;r8206=0;r8207=_bitshift64Shl(r8205,r8206,r8183);r8208=tempRet0;HEAPF64[tempDoublePtr>>3]=r8162;r8209=HEAP32[tempDoublePtr>>2];r8210=HEAP32[tempDoublePtr+4>>2];r8211=r8209>>>8|r8210<<24;r8212=r8210>>>8|0<<24;r8213=-1;r8214=16777215;r8215=r8211^r8213;r8216=r8212^r8214;r8217=r8216>>>23|0<<9;r8218=0>>>23|0<<9;r8219=0;r8220=0;r8221=_i64Subtract(r8219,r8220,r8217,r8218);r8222=tempRet0;r8223=r8221>>>9|r8222<<23;r8224=r8222>>>9|0<<23;r8225=r8223^r8215;r8226=r8224^r8216;r8227=_i64Add(r8173,r8174,r8225,r8226);r8228=tempRet0;r8229=_i64Add(r8227,r8228,r8185,r8184);r8230=tempRet0;r8231=_i64Add(r8229,r8230,r8207,r8208);r8232=tempRet0;r8233=r8232>>>23|0<<9;r8234=0>>>23|0<<9;r8235=0;r8236=0;r8237=_i64Subtract(r8235,r8236,r8233,r8234);r8238=tempRet0;r8239=r8237>>>9|r8238<<23;r8240=r8238>>>9|0<<23;r8241=r8239^r8231;r8242=r8240^r8232;r8243=r8241<<8|0>>>24;r8244=r8242<<8|r8241>>>24;r8245=-256;r8246=-1;r8247=r8243^r8245;r8248=r8244^r8246;r8249=r8248;r8250=r8247}else{r8251=r8166>>>0<56;if(!r8251){HEAPF64[tempDoublePtr>>3]=r8162;r8252=HEAP32[tempDoublePtr>>2];r8253=HEAP32[tempDoublePtr+4>>2];r8254=-256;r8255=-1;r8256=r8252&r8254;r8257=r8253&r8255;r8249=r8257;r8250=r8256;break}r8258=55-r8166|0;r8259=r8258;r8260=0;r8261=HEAP32[r8048>>2];r8262=r8258>>>0>16;do{if(r8262){r8263=__ZN9RCdecoder12decode_shiftEj(r8261,16);r8264=r8263;r8265=0;r8266=r8258-16|0;r8267=r8266>>>0>16;if(!r8267){r8268=0;r8269=16;r8270=r8265;r8271=r8264;r8272=r8266;break}r8273=__ZN9RCdecoder12decode_shiftEj(r8261,16);r8274=r8273;r8275=0;r8276=r8274<<16|0>>>16;r8277=r8275<<16|r8274>>>16;r8278=_i64Add(r8276,r8277,r8264,r8265);r8279=tempRet0;r8280=r8258-32|0;r8281=r8280>>>0>16;if(!r8281){r8268=0;r8269=32;r8270=r8279;r8271=r8278;r8272=r8280;break}r8282=__ZN9RCdecoder12decode_shiftEj(r8261,16);r8283=r8282;r8284=0;r8285=0;r8286=r8283;r8287=_i64Add(r8285,r8286,r8278,r8279);r8288=tempRet0;r8289=r8258-48|0;r8268=0;r8269=48;r8270=r8288;r8271=r8287;r8272=r8289}else{r8268=0;r8269=0;r8270=0;r8271=0;r8272=r8258}}while(0);r8290=__ZN9RCdecoder12decode_shiftEj(r8261,r8272);r8291=r8290;r8292=0;r8293=_bitshift64Shl(r8291,r8292,r8269);r8294=tempRet0;HEAPF64[tempDoublePtr>>3]=r8162;r8295=HEAP32[tempDoublePtr>>2];r8296=HEAP32[tempDoublePtr+4>>2];r8297=r8295>>>8|r8296<<24;r8298=r8296>>>8|0<<24;r8299=-1;r8300=16777215;r8301=r8297^r8299;r8302=r8298^r8300;r8303=r8302>>>23|0<<9;r8304=0>>>23|0<<9;r8305=0;r8306=0;r8307=_i64Subtract(r8305,r8306,r8303,r8304);r8308=tempRet0;r8309=r8307>>>9|r8308<<23;r8310=r8308>>>9|0<<23;r8311=r8309^r8301;r8312=r8310^r8302;r8313=-1;r8314=-1;r8315=_bitshift64Shl(r8313,r8314,r8259);r8316=tempRet0;r8317=_i64Add(r8315,r8316,r8311,r8312);r8318=tempRet0;r8319=_i64Subtract(r8317,r8318,r8271,r8270);r8320=tempRet0;r8321=_i64Subtract(r8319,r8320,r8293,r8294);r8322=tempRet0;r8323=r8322>>>23|0<<9;r8324=0>>>23|0<<9;r8325=0;r8326=0;r8327=_i64Subtract(r8325,r8326,r8323,r8324);r8328=tempRet0;r8329=r8327>>>9|r8328<<23;r8330=r8328>>>9|0<<23;r8331=r8329^r8321;r8332=r8330^r8322;r8333=r8331<<8|0>>>24;r8334=r8332<<8|r8331>>>24;r8335=-256;r8336=-1;r8337=r8333^r8335;r8338=r8334^r8336;r8249=r8338;r8250=r8337}}while(0);r8339=(HEAP32[tempDoublePtr>>2]=r8250,HEAP32[tempDoublePtr+4>>2]=r8249,HEAPF64[tempDoublePtr>>3]);HEAPF64[r8100>>3]=r8339;r8340=r8098&r8055;r8341=r8066+(r8340<<3)|0;HEAPF64[r8341>>3]=r8339;r8342=r8100+8|0;r8343=r8098+1|0;r8344=r8099+1|0;r8345=r8344>>>0<r8038>>>0;if(r8345){r8098=r8343;r8099=r8344;r8100=r8342}else{r8096=r8343;r8097=r8342;break}}}r8346=r8091+1|0;r8347=r8346>>>0<r8039>>>0;if(r8347){r8090=r8096;r8091=r8346;r8092=r8097}else{r8088=r8096;r8089=r8097;break}}}r8348=r8078+1|0;r8349=r8348>>>0<r8040>>>0;if(r8349){r8077=r8088;r8078=r8348;r8079=r8089}else{break}}}r8350=(r8046|0)==0;if(!r8350){_free(r8046)}r8351=HEAP32[r9>>2];r8352=(r8351|0)==0;if(!r8352){r8353=r8351;r8354=HEAP32[r8353>>2];r8355=r8354+4|0;r8356=HEAP32[r8355>>2];FUNCTION_TABLE[r8356](r8351)}r8357=(r8065|0)==0;if(r8357){break L6}_free(r8065);break};case 58:{r8358=HEAP32[r41>>2];r8359=HEAP32[r42>>2];r8360=HEAP32[r43>>2];r8361=HEAP32[r44>>2];r8362=4;r8363=0;r8364=__Znwj(48);r8365=r8364;__ZN9RCqsmodelC2Ebjjj(r8365,0,117,16,1024);r8366=r8364;HEAP32[r8>>2]=r8366;r8367=__Znwj(12);r8368=r8367+4|0;r8369=r8368;HEAP32[r8369>>2]=r8358;r8370=r8367+8|0;r8371=r8370;HEAP32[r8371>>2]=r8;r8372=r8359+1|0;r8373=r8360+1|0;r8374=Math_imul(r8373,r8372)|0;r8375=r8374+r8372|0;r8376=r8375;while(1){r8377=r8376+1|0;r8378=r8377&r8376;r8379=(r8378|0)==0;r8380=r8377|r8376;if(r8379){break}else{r8376=r8380}}r8381=_llvm_umul_with_overflow_i32(r8377,8);r8382=tempRet0;r8383=r8382;r8384=r8381;r8385=r8383?-1:r8384;r8386=__Znwj(r8385);r8387=r8386;r8388=r8374;r8389=0;while(1){r8390=r8389+1|0;r8391=r8389&r8376;r8392=r8387+(r8391<<3)|0;HEAPF64[r8392>>3]=0;r8393=r8388-1|0;r8394=(r8393|0)==0;if(r8394){break}else{r8388=r8393;r8389=r8390}}r8395=(r8361|0)==0;if(!r8395){r8396=(r8360|0)==0;r8397=(r8359|0)==0;r8398=r8374;r8399=0;r8400=r76;while(1){r8401=r8372;r8402=r8398;while(1){r8403=r8402+1|0;r8404=r8402&r8376;r8405=r8387+(r8404<<3)|0;HEAPF64[r8405>>3]=0;r8406=r8401-1|0;r8407=(r8406|0)==0;if(r8407){break}else{r8401=r8406;r8402=r8403}}r8408=r8398+r8372|0;if(r8396){r8409=r8408;r8410=r8400}else{r8411=r8408;r8412=0;r8413=r8400;while(1){r8414=r8411&r8376;r8415=r8387+(r8414<<3)|0;HEAPF64[r8415>>3]=0;r8416=r8411+1|0;if(r8397){r8417=r8416;r8418=r8413}else{r8419=r8416;r8420=0;r8421=r8413;while(1){r8422=r8419-1|0;r8423=r8422&r8376;r8424=r8387+(r8423<<3)|0;r8425=HEAPF64[r8424>>3];r8426=r8424|0;r8427=HEAP32[r8426>>2];r8428=r8424+4|0;r8429=HEAP32[r8428>>2];r8430=r8419-r8372|0;r8431=r8430-r8374|0;r8432=r8431&r8376;r8433=r8387+(r8432<<3)|0;r8434=HEAPF64[r8433>>3];r8435=r8433|0;r8436=HEAP32[r8435>>2];r8437=r8433+4|0;r8438=HEAP32[r8437>>2];r8439=r8425-r8434;r8440=r8430&r8376;r8441=r8387+(r8440<<3)|0;r8442=HEAPF64[r8441>>3];r8443=r8441|0;r8444=HEAP32[r8443>>2];r8445=r8441+4|0;r8446=HEAP32[r8445>>2];r8447=r8439+r8442;r8448=r8422-r8374|0;r8449=r8448&r8376;r8450=r8387+(r8449<<3)|0;r8451=HEAPF64[r8450>>3];r8452=r8450|0;r8453=HEAP32[r8452>>2];r8454=r8450+4|0;r8455=HEAP32[r8454>>2];r8456=r8447-r8451;r8457=r8419-r8374|0;r8458=r8457&r8376;r8459=r8387+(r8458<<3)|0;r8460=HEAPF64[r8459>>3];r8461=r8459|0;r8462=HEAP32[r8461>>2];r8463=r8459+4|0;r8464=HEAP32[r8463>>2];r8465=r8456+r8460;r8466=r8422-r8372|0;r8467=r8466&r8376;r8468=r8387+(r8467<<3)|0;r8469=HEAPF64[r8468>>3];r8470=r8468|0;r8471=HEAP32[r8470>>2];r8472=r8468+4|0;r8473=HEAP32[r8472>>2];r8474=r8465-r8469;r8475=r8466-r8374|0;r8476=r8475&r8376;r8477=r8387+(r8476<<3)|0;r8478=HEAPF64[r8477>>3];r8479=r8477|0;r8480=HEAP32[r8479>>2];r8481=r8477+4|0;r8482=HEAP32[r8481>>2];r8483=r8474+r8478;r8484=HEAP32[r8369>>2];r8485=HEAP32[r8371>>2];r8486=HEAP32[r8485>>2];r8487=__ZN9RCdecoder6decodeEP7RCmodel(r8484,r8486);r8488=r8487>>>0>58;do{if(r8488){r8489=r8487-59|0;r8490=r8489;r8491=0;r8492=1;r8493=0;r8494=_bitshift64Shl(r8492,r8493,r8490);r8495=tempRet0;r8496=HEAP32[r8369>>2];r8497=r8489>>>0>16;do{if(r8497){r8498=__ZN9RCdecoder12decode_shiftEj(r8496,16);r8499=r8498;r8500=0;r8501=r8487-75|0;r8502=r8501>>>0>16;if(!r8502){r8503=0;r8504=16;r8505=r8500;r8506=r8499;r8507=r8501;break}r8508=__ZN9RCdecoder12decode_shiftEj(r8496,16);r8509=r8508;r8510=0;r8511=r8509<<16|0>>>16;r8512=r8510<<16|r8509>>>16;r8513=_i64Add(r8511,r8512,r8499,r8500);r8514=tempRet0;r8515=r8487-91|0;r8516=r8515>>>0>16;if(!r8516){r8503=0;r8504=32;r8505=r8514;r8506=r8513;r8507=r8515;break}r8517=__ZN9RCdecoder12decode_shiftEj(r8496,16);r8518=r8517;r8519=0;r8520=0;r8521=r8518;r8522=_i64Add(r8520,r8521,r8513,r8514);r8523=tempRet0;r8524=r8487-107|0;r8503=0;r8504=48;r8505=r8523;r8506=r8522;r8507=r8524}else{r8503=0;r8504=0;r8505=0;r8506=0;r8507=r8489}}while(0);r8525=__ZN9RCdecoder12decode_shiftEj(r8496,r8507);r8526=r8525;r8527=0;r8528=_bitshift64Shl(r8526,r8527,r8504);r8529=tempRet0;HEAPF64[tempDoublePtr>>3]=r8483;r8530=HEAP32[tempDoublePtr>>2];r8531=HEAP32[tempDoublePtr+4>>2];r8532=r8530>>>6|r8531<<26;r8533=r8531>>>6|0<<26;r8534=-1;r8535=67108863;r8536=r8532^r8534;r8537=r8533^r8535;r8538=r8537>>>25|0<<7;r8539=0>>>25|0<<7;r8540=0;r8541=0;r8542=_i64Subtract(r8540,r8541,r8538,r8539);r8543=tempRet0;r8544=r8542>>>7|r8543<<25;r8545=r8543>>>7|0<<25;r8546=r8544^r8536;r8547=r8545^r8537;r8548=_i64Add(r8494,r8495,r8546,r8547);r8549=tempRet0;r8550=_i64Add(r8548,r8549,r8506,r8505);r8551=tempRet0;r8552=_i64Add(r8550,r8551,r8528,r8529);r8553=tempRet0;r8554=r8553>>>25|0<<7;r8555=0>>>25|0<<7;r8556=0;r8557=0;r8558=_i64Subtract(r8556,r8557,r8554,r8555);r8559=tempRet0;r8560=r8558>>>7|r8559<<25;r8561=r8559>>>7|0<<25;r8562=r8560^r8552;r8563=r8561^r8553;r8564=r8562<<6|0>>>26;r8565=r8563<<6|r8562>>>26;r8566=-64;r8567=-1;r8568=r8564^r8566;r8569=r8565^r8567;r8570=r8569;r8571=r8568}else{r8572=r8487>>>0<58;if(!r8572){HEAPF64[tempDoublePtr>>3]=r8483;r8573=HEAP32[tempDoublePtr>>2];r8574=HEAP32[tempDoublePtr+4>>2];r8575=-64;r8576=-1;r8577=r8573&r8575;r8578=r8574&r8576;r8570=r8578;r8571=r8577;break}r8579=57-r8487|0;r8580=r8579;r8581=0;r8582=HEAP32[r8369>>2];r8583=r8579>>>0>16;do{if(r8583){r8584=__ZN9RCdecoder12decode_shiftEj(r8582,16);r8585=r8584;r8586=0;r8587=r8579-16|0;r8588=r8587>>>0>16;if(!r8588){r8589=0;r8590=16;r8591=r8586;r8592=r8585;r8593=r8587;break}r8594=__ZN9RCdecoder12decode_shiftEj(r8582,16);r8595=r8594;r8596=0;r8597=r8595<<16|0>>>16;r8598=r8596<<16|r8595>>>16;r8599=_i64Add(r8597,r8598,r8585,r8586);r8600=tempRet0;r8601=r8579-32|0;r8602=r8601>>>0>16;if(!r8602){r8589=0;r8590=32;r8591=r8600;r8592=r8599;r8593=r8601;break}r8603=__ZN9RCdecoder12decode_shiftEj(r8582,16);r8604=r8603;r8605=0;r8606=0;r8607=r8604;r8608=_i64Add(r8606,r8607,r8599,r8600);r8609=tempRet0;r8610=r8579-48|0;r8589=0;r8590=48;r8591=r8609;r8592=r8608;r8593=r8610}else{r8589=0;r8590=0;r8591=0;r8592=0;r8593=r8579}}while(0);r8611=__ZN9RCdecoder12decode_shiftEj(r8582,r8593);r8612=r8611;r8613=0;r8614=_bitshift64Shl(r8612,r8613,r8590);r8615=tempRet0;HEAPF64[tempDoublePtr>>3]=r8483;r8616=HEAP32[tempDoublePtr>>2];r8617=HEAP32[tempDoublePtr+4>>2];r8618=r8616>>>6|r8617<<26;r8619=r8617>>>6|0<<26;r8620=-1;r8621=67108863;r8622=r8618^r8620;r8623=r8619^r8621;r8624=r8623>>>25|0<<7;r8625=0>>>25|0<<7;r8626=0;r8627=0;r8628=_i64Subtract(r8626,r8627,r8624,r8625);r8629=tempRet0;r8630=r8628>>>7|r8629<<25;r8631=r8629>>>7|0<<25;r8632=r8630^r8622;r8633=r8631^r8623;r8634=-1;r8635=-1;r8636=_bitshift64Shl(r8634,r8635,r8580);r8637=tempRet0;r8638=_i64Add(r8636,r8637,r8632,r8633);r8639=tempRet0;r8640=_i64Subtract(r8638,r8639,r8592,r8591);r8641=tempRet0;r8642=_i64Subtract(r8640,r8641,r8614,r8615);r8643=tempRet0;r8644=r8643>>>25|0<<7;r8645=0>>>25|0<<7;r8646=0;r8647=0;r8648=_i64Subtract(r8646,r8647,r8644,r8645);r8649=tempRet0;r8650=r8648>>>7|r8649<<25;r8651=r8649>>>7|0<<25;r8652=r8650^r8642;r8653=r8651^r8643;r8654=r8652<<6|0>>>26;r8655=r8653<<6|r8652>>>26;r8656=-64;r8657=-1;r8658=r8654^r8656;r8659=r8655^r8657;r8570=r8659;r8571=r8658}}while(0);r8660=(HEAP32[tempDoublePtr>>2]=r8571,HEAP32[tempDoublePtr+4>>2]=r8570,HEAPF64[tempDoublePtr>>3]);HEAPF64[r8421>>3]=r8660;r8661=r8419&r8376;r8662=r8387+(r8661<<3)|0;HEAPF64[r8662>>3]=r8660;r8663=r8421+8|0;r8664=r8419+1|0;r8665=r8420+1|0;r8666=r8665>>>0<r8359>>>0;if(r8666){r8419=r8664;r8420=r8665;r8421=r8663}else{r8417=r8664;r8418=r8663;break}}}r8667=r8412+1|0;r8668=r8667>>>0<r8360>>>0;if(r8668){r8411=r8417;r8412=r8667;r8413=r8418}else{r8409=r8417;r8410=r8418;break}}}r8669=r8399+1|0;r8670=r8669>>>0<r8361>>>0;if(r8670){r8398=r8409;r8399=r8669;r8400=r8410}else{break}}}r8671=(r8367|0)==0;if(!r8671){_free(r8367)}r8672=HEAP32[r8>>2];r8673=(r8672|0)==0;if(!r8673){r8674=r8672;r8675=HEAP32[r8674>>2];r8676=r8675+4|0;r8677=HEAP32[r8676>>2];FUNCTION_TABLE[r8677](r8672)}r8678=(r8386|0)==0;if(r8678){break L6}_free(r8386);break};case 60:{r8679=HEAP32[r41>>2];r8680=HEAP32[r42>>2];r8681=HEAP32[r43>>2];r8682=HEAP32[r44>>2];r8683=4;r8684=0;r8685=__Znwj(48);r8686=r8685;__ZN9RCqsmodelC2Ebjjj(r8686,0,121,16,1024);r8687=r8685;HEAP32[r7>>2]=r8687;r8688=__Znwj(12);r8689=r8688+4|0;r8690=r8689;HEAP32[r8690>>2]=r8679;r8691=r8688+8|0;r8692=r8691;HEAP32[r8692>>2]=r7;r8693=r8680+1|0;r8694=r8681+1|0;r8695=Math_imul(r8694,r8693)|0;r8696=r8695+r8693|0;r8697=r8696;while(1){r8698=r8697+1|0;r8699=r8698&r8697;r8700=(r8699|0)==0;r8701=r8698|r8697;if(r8700){break}else{r8697=r8701}}r8702=_llvm_umul_with_overflow_i32(r8698,8);r8703=tempRet0;r8704=r8703;r8705=r8702;r8706=r8704?-1:r8705;r8707=__Znwj(r8706);r8708=r8707;r8709=r8695;r8710=0;while(1){r8711=r8710+1|0;r8712=r8710&r8697;r8713=r8708+(r8712<<3)|0;HEAPF64[r8713>>3]=0;r8714=r8709-1|0;r8715=(r8714|0)==0;if(r8715){break}else{r8709=r8714;r8710=r8711}}r8716=(r8682|0)==0;if(!r8716){r8717=(r8681|0)==0;r8718=(r8680|0)==0;r8719=r8695;r8720=0;r8721=r76;while(1){r8722=r8693;r8723=r8719;while(1){r8724=r8723+1|0;r8725=r8723&r8697;r8726=r8708+(r8725<<3)|0;HEAPF64[r8726>>3]=0;r8727=r8722-1|0;r8728=(r8727|0)==0;if(r8728){break}else{r8722=r8727;r8723=r8724}}r8729=r8719+r8693|0;if(r8717){r8730=r8729;r8731=r8721}else{r8732=r8729;r8733=0;r8734=r8721;while(1){r8735=r8732&r8697;r8736=r8708+(r8735<<3)|0;HEAPF64[r8736>>3]=0;r8737=r8732+1|0;if(r8718){r8738=r8737;r8739=r8734}else{r8740=r8737;r8741=0;r8742=r8734;while(1){r8743=r8740-1|0;r8744=r8743&r8697;r8745=r8708+(r8744<<3)|0;r8746=HEAPF64[r8745>>3];r8747=r8745|0;r8748=HEAP32[r8747>>2];r8749=r8745+4|0;r8750=HEAP32[r8749>>2];r8751=r8740-r8693|0;r8752=r8751-r8695|0;r8753=r8752&r8697;r8754=r8708+(r8753<<3)|0;r8755=HEAPF64[r8754>>3];r8756=r8754|0;r8757=HEAP32[r8756>>2];r8758=r8754+4|0;r8759=HEAP32[r8758>>2];r8760=r8746-r8755;r8761=r8751&r8697;r8762=r8708+(r8761<<3)|0;r8763=HEAPF64[r8762>>3];r8764=r8762|0;r8765=HEAP32[r8764>>2];r8766=r8762+4|0;r8767=HEAP32[r8766>>2];r8768=r8760+r8763;r8769=r8743-r8695|0;r8770=r8769&r8697;r8771=r8708+(r8770<<3)|0;r8772=HEAPF64[r8771>>3];r8773=r8771|0;r8774=HEAP32[r8773>>2];r8775=r8771+4|0;r8776=HEAP32[r8775>>2];r8777=r8768-r8772;r8778=r8740-r8695|0;r8779=r8778&r8697;r8780=r8708+(r8779<<3)|0;r8781=HEAPF64[r8780>>3];r8782=r8780|0;r8783=HEAP32[r8782>>2];r8784=r8780+4|0;r8785=HEAP32[r8784>>2];r8786=r8777+r8781;r8787=r8743-r8693|0;r8788=r8787&r8697;r8789=r8708+(r8788<<3)|0;r8790=HEAPF64[r8789>>3];r8791=r8789|0;r8792=HEAP32[r8791>>2];r8793=r8789+4|0;r8794=HEAP32[r8793>>2];r8795=r8786-r8790;r8796=r8787-r8695|0;r8797=r8796&r8697;r8798=r8708+(r8797<<3)|0;r8799=HEAPF64[r8798>>3];r8800=r8798|0;r8801=HEAP32[r8800>>2];r8802=r8798+4|0;r8803=HEAP32[r8802>>2];r8804=r8795+r8799;r8805=HEAP32[r8690>>2];r8806=HEAP32[r8692>>2];r8807=HEAP32[r8806>>2];r8808=__ZN9RCdecoder6decodeEP7RCmodel(r8805,r8807);r8809=r8808>>>0>60;do{if(r8809){r8810=r8808-61|0;r8811=r8810;r8812=0;r8813=1;r8814=0;r8815=_bitshift64Shl(r8813,r8814,r8811);r8816=tempRet0;r8817=HEAP32[r8690>>2];r8818=r8810>>>0>16;do{if(r8818){r8819=__ZN9RCdecoder12decode_shiftEj(r8817,16);r8820=r8819;r8821=0;r8822=r8808-77|0;r8823=r8822>>>0>16;if(!r8823){r8824=0;r8825=16;r8826=r8821;r8827=r8820;r8828=r8822;break}r8829=__ZN9RCdecoder12decode_shiftEj(r8817,16);r8830=r8829;r8831=0;r8832=r8830<<16|0>>>16;r8833=r8831<<16|r8830>>>16;r8834=_i64Add(r8832,r8833,r8820,r8821);r8835=tempRet0;r8836=r8808-93|0;r8837=r8836>>>0>16;if(!r8837){r8824=0;r8825=32;r8826=r8835;r8827=r8834;r8828=r8836;break}r8838=__ZN9RCdecoder12decode_shiftEj(r8817,16);r8839=r8838;r8840=0;r8841=0;r8842=r8839;r8843=_i64Add(r8841,r8842,r8834,r8835);r8844=tempRet0;r8845=r8808-109|0;r8824=0;r8825=48;r8826=r8844;r8827=r8843;r8828=r8845}else{r8824=0;r8825=0;r8826=0;r8827=0;r8828=r8810}}while(0);r8846=__ZN9RCdecoder12decode_shiftEj(r8817,r8828);r8847=r8846;r8848=0;r8849=_bitshift64Shl(r8847,r8848,r8825);r8850=tempRet0;HEAPF64[tempDoublePtr>>3]=r8804;r8851=HEAP32[tempDoublePtr>>2];r8852=HEAP32[tempDoublePtr+4>>2];r8853=r8851>>>4|r8852<<28;r8854=r8852>>>4|0<<28;r8855=-1;r8856=268435455;r8857=r8853^r8855;r8858=r8854^r8856;r8859=r8858>>>27|0<<5;r8860=0>>>27|0<<5;r8861=0;r8862=0;r8863=_i64Subtract(r8861,r8862,r8859,r8860);r8864=tempRet0;r8865=r8863>>>5|r8864<<27;r8866=r8864>>>5|0<<27;r8867=r8865^r8857;r8868=r8866^r8858;r8869=_i64Add(r8815,r8816,r8867,r8868);r8870=tempRet0;r8871=_i64Add(r8869,r8870,r8827,r8826);r8872=tempRet0;r8873=_i64Add(r8871,r8872,r8849,r8850);r8874=tempRet0;r8875=r8874>>>27|0<<5;r8876=0>>>27|0<<5;r8877=0;r8878=0;r8879=_i64Subtract(r8877,r8878,r8875,r8876);r8880=tempRet0;r8881=r8879>>>5|r8880<<27;r8882=r8880>>>5|0<<27;r8883=r8881^r8873;r8884=r8882^r8874;r8885=r8883<<4|0>>>28;r8886=r8884<<4|r8883>>>28;r8887=-16;r8888=-1;r8889=r8885^r8887;r8890=r8886^r8888;r8891=r8890;r8892=r8889}else{r8893=r8808>>>0<60;if(!r8893){HEAPF64[tempDoublePtr>>3]=r8804;r8894=HEAP32[tempDoublePtr>>2];r8895=HEAP32[tempDoublePtr+4>>2];r8896=-16;r8897=-1;r8898=r8894&r8896;r8899=r8895&r8897;r8891=r8899;r8892=r8898;break}r8900=59-r8808|0;r8901=r8900;r8902=0;r8903=HEAP32[r8690>>2];r8904=r8900>>>0>16;do{if(r8904){r8905=__ZN9RCdecoder12decode_shiftEj(r8903,16);r8906=r8905;r8907=0;r8908=r8900-16|0;r8909=r8908>>>0>16;if(!r8909){r8910=0;r8911=16;r8912=r8907;r8913=r8906;r8914=r8908;break}r8915=__ZN9RCdecoder12decode_shiftEj(r8903,16);r8916=r8915;r8917=0;r8918=r8916<<16|0>>>16;r8919=r8917<<16|r8916>>>16;r8920=_i64Add(r8918,r8919,r8906,r8907);r8921=tempRet0;r8922=r8900-32|0;r8923=r8922>>>0>16;if(!r8923){r8910=0;r8911=32;r8912=r8921;r8913=r8920;r8914=r8922;break}r8924=__ZN9RCdecoder12decode_shiftEj(r8903,16);r8925=r8924;r8926=0;r8927=0;r8928=r8925;r8929=_i64Add(r8927,r8928,r8920,r8921);r8930=tempRet0;r8931=r8900-48|0;r8910=0;r8911=48;r8912=r8930;r8913=r8929;r8914=r8931}else{r8910=0;r8911=0;r8912=0;r8913=0;r8914=r8900}}while(0);r8932=__ZN9RCdecoder12decode_shiftEj(r8903,r8914);r8933=r8932;r8934=0;r8935=_bitshift64Shl(r8933,r8934,r8911);r8936=tempRet0;HEAPF64[tempDoublePtr>>3]=r8804;r8937=HEAP32[tempDoublePtr>>2];r8938=HEAP32[tempDoublePtr+4>>2];r8939=r8937>>>4|r8938<<28;r8940=r8938>>>4|0<<28;r8941=-1;r8942=268435455;r8943=r8939^r8941;r8944=r8940^r8942;r8945=r8944>>>27|0<<5;r8946=0>>>27|0<<5;r8947=0;r8948=0;r8949=_i64Subtract(r8947,r8948,r8945,r8946);r8950=tempRet0;r8951=r8949>>>5|r8950<<27;r8952=r8950>>>5|0<<27;r8953=r8951^r8943;r8954=r8952^r8944;r8955=-1;r8956=-1;r8957=_bitshift64Shl(r8955,r8956,r8901);r8958=tempRet0;r8959=_i64Add(r8957,r8958,r8953,r8954);r8960=tempRet0;r8961=_i64Subtract(r8959,r8960,r8913,r8912);r8962=tempRet0;r8963=_i64Subtract(r8961,r8962,r8935,r8936);r8964=tempRet0;r8965=r8964>>>27|0<<5;r8966=0>>>27|0<<5;r8967=0;r8968=0;r8969=_i64Subtract(r8967,r8968,r8965,r8966);r8970=tempRet0;r8971=r8969>>>5|r8970<<27;r8972=r8970>>>5|0<<27;r8973=r8971^r8963;r8974=r8972^r8964;r8975=r8973<<4|0>>>28;r8976=r8974<<4|r8973>>>28;r8977=-16;r8978=-1;r8979=r8975^r8977;r8980=r8976^r8978;r8891=r8980;r8892=r8979}}while(0);r8981=(HEAP32[tempDoublePtr>>2]=r8892,HEAP32[tempDoublePtr+4>>2]=r8891,HEAPF64[tempDoublePtr>>3]);HEAPF64[r8742>>3]=r8981;r8982=r8740&r8697;r8983=r8708+(r8982<<3)|0;HEAPF64[r8983>>3]=r8981;r8984=r8742+8|0;r8985=r8740+1|0;r8986=r8741+1|0;r8987=r8986>>>0<r8680>>>0;if(r8987){r8740=r8985;r8741=r8986;r8742=r8984}else{r8738=r8985;r8739=r8984;break}}}r8988=r8733+1|0;r8989=r8988>>>0<r8681>>>0;if(r8989){r8732=r8738;r8733=r8988;r8734=r8739}else{r8730=r8738;r8731=r8739;break}}}r8990=r8720+1|0;r8991=r8990>>>0<r8682>>>0;if(r8991){r8719=r8730;r8720=r8990;r8721=r8731}else{break}}}r8992=(r8688|0)==0;if(!r8992){_free(r8688)}r8993=HEAP32[r7>>2];r8994=(r8993|0)==0;if(!r8994){r8995=r8993;r8996=HEAP32[r8995>>2];r8997=r8996+4|0;r8998=HEAP32[r8997>>2];FUNCTION_TABLE[r8998](r8993)}r8999=(r8707|0)==0;if(r8999){break L6}_free(r8707);break};case 62:{r9000=HEAP32[r41>>2];r9001=HEAP32[r42>>2];r9002=HEAP32[r43>>2];r9003=HEAP32[r44>>2];r9004=4;r9005=0;r9006=__Znwj(48);r9007=r9006;__ZN9RCqsmodelC2Ebjjj(r9007,0,125,16,1024);r9008=r9006;HEAP32[r6>>2]=r9008;r9009=__Znwj(12);r9010=r9009+4|0;r9011=r9010;HEAP32[r9011>>2]=r9000;r9012=r9009+8|0;r9013=r9012;HEAP32[r9013>>2]=r6;r9014=r9001+1|0;r9015=r9002+1|0;r9016=Math_imul(r9015,r9014)|0;r9017=r9016+r9014|0;r9018=r9017;while(1){r9019=r9018+1|0;r9020=r9019&r9018;r9021=(r9020|0)==0;r9022=r9019|r9018;if(r9021){break}else{r9018=r9022}}r9023=_llvm_umul_with_overflow_i32(r9019,8);r9024=tempRet0;r9025=r9024;r9026=r9023;r9027=r9025?-1:r9026;r9028=__Znwj(r9027);r9029=r9028;r9030=r9016;r9031=0;while(1){r9032=r9031+1|0;r9033=r9031&r9018;r9034=r9029+(r9033<<3)|0;HEAPF64[r9034>>3]=0;r9035=r9030-1|0;r9036=(r9035|0)==0;if(r9036){break}else{r9030=r9035;r9031=r9032}}r9037=(r9003|0)==0;if(!r9037){r9038=(r9002|0)==0;r9039=(r9001|0)==0;r9040=r9016;r9041=0;r9042=r76;while(1){r9043=r9014;r9044=r9040;while(1){r9045=r9044+1|0;r9046=r9044&r9018;r9047=r9029+(r9046<<3)|0;HEAPF64[r9047>>3]=0;r9048=r9043-1|0;r9049=(r9048|0)==0;if(r9049){break}else{r9043=r9048;r9044=r9045}}r9050=r9040+r9014|0;if(r9038){r9051=r9050;r9052=r9042}else{r9053=r9050;r9054=0;r9055=r9042;while(1){r9056=r9053&r9018;r9057=r9029+(r9056<<3)|0;HEAPF64[r9057>>3]=0;r9058=r9053+1|0;if(r9039){r9059=r9058;r9060=r9055}else{r9061=r9058;r9062=0;r9063=r9055;while(1){r9064=r9061-1|0;r9065=r9064&r9018;r9066=r9029+(r9065<<3)|0;r9067=HEAPF64[r9066>>3];r9068=r9066|0;r9069=HEAP32[r9068>>2];r9070=r9066+4|0;r9071=HEAP32[r9070>>2];r9072=r9061-r9014|0;r9073=r9072-r9016|0;r9074=r9073&r9018;r9075=r9029+(r9074<<3)|0;r9076=HEAPF64[r9075>>3];r9077=r9075|0;r9078=HEAP32[r9077>>2];r9079=r9075+4|0;r9080=HEAP32[r9079>>2];r9081=r9067-r9076;r9082=r9072&r9018;r9083=r9029+(r9082<<3)|0;r9084=HEAPF64[r9083>>3];r9085=r9083|0;r9086=HEAP32[r9085>>2];r9087=r9083+4|0;r9088=HEAP32[r9087>>2];r9089=r9081+r9084;r9090=r9064-r9016|0;r9091=r9090&r9018;r9092=r9029+(r9091<<3)|0;r9093=HEAPF64[r9092>>3];r9094=r9092|0;r9095=HEAP32[r9094>>2];r9096=r9092+4|0;r9097=HEAP32[r9096>>2];r9098=r9089-r9093;r9099=r9061-r9016|0;r9100=r9099&r9018;r9101=r9029+(r9100<<3)|0;r9102=HEAPF64[r9101>>3];r9103=r9101|0;r9104=HEAP32[r9103>>2];r9105=r9101+4|0;r9106=HEAP32[r9105>>2];r9107=r9098+r9102;r9108=r9064-r9014|0;r9109=r9108&r9018;r9110=r9029+(r9109<<3)|0;r9111=HEAPF64[r9110>>3];r9112=r9110|0;r9113=HEAP32[r9112>>2];r9114=r9110+4|0;r9115=HEAP32[r9114>>2];r9116=r9107-r9111;r9117=r9108-r9016|0;r9118=r9117&r9018;r9119=r9029+(r9118<<3)|0;r9120=HEAPF64[r9119>>3];r9121=r9119|0;r9122=HEAP32[r9121>>2];r9123=r9119+4|0;r9124=HEAP32[r9123>>2];r9125=r9116+r9120;r9126=HEAP32[r9011>>2];r9127=HEAP32[r9013>>2];r9128=HEAP32[r9127>>2];r9129=__ZN9RCdecoder6decodeEP7RCmodel(r9126,r9128);r9130=r9129>>>0>62;do{if(r9130){r9131=r9129-63|0;r9132=r9131;r9133=0;r9134=1;r9135=0;r9136=_bitshift64Shl(r9134,r9135,r9132);r9137=tempRet0;r9138=HEAP32[r9011>>2];r9139=r9131>>>0>16;do{if(r9139){r9140=__ZN9RCdecoder12decode_shiftEj(r9138,16);r9141=r9140;r9142=0;r9143=r9129-79|0;r9144=r9143>>>0>16;if(!r9144){r9145=0;r9146=16;r9147=r9142;r9148=r9141;r9149=r9143;break}r9150=__ZN9RCdecoder12decode_shiftEj(r9138,16);r9151=r9150;r9152=0;r9153=r9151<<16|0>>>16;r9154=r9152<<16|r9151>>>16;r9155=_i64Add(r9153,r9154,r9141,r9142);r9156=tempRet0;r9157=r9129-95|0;r9158=r9157>>>0>16;if(!r9158){r9145=0;r9146=32;r9147=r9156;r9148=r9155;r9149=r9157;break}r9159=__ZN9RCdecoder12decode_shiftEj(r9138,16);r9160=r9159;r9161=0;r9162=0;r9163=r9160;r9164=_i64Add(r9162,r9163,r9155,r9156);r9165=tempRet0;r9166=r9129-111|0;r9145=0;r9146=48;r9147=r9165;r9148=r9164;r9149=r9166}else{r9145=0;r9146=0;r9147=0;r9148=0;r9149=r9131}}while(0);r9167=__ZN9RCdecoder12decode_shiftEj(r9138,r9149);r9168=r9167;r9169=0;r9170=_bitshift64Shl(r9168,r9169,r9146);r9171=tempRet0;HEAPF64[tempDoublePtr>>3]=r9125;r9172=HEAP32[tempDoublePtr>>2];r9173=HEAP32[tempDoublePtr+4>>2];r9174=r9172>>>2|r9173<<30;r9175=r9173>>>2|0<<30;r9176=-1;r9177=1073741823;r9178=r9174^r9176;r9179=r9175^r9177;r9180=r9179>>>29|0<<3;r9181=0>>>29|0<<3;r9182=0;r9183=0;r9184=_i64Subtract(r9182,r9183,r9180,r9181);r9185=tempRet0;r9186=r9184>>>3|r9185<<29;r9187=r9185>>>3|0<<29;r9188=r9186^r9178;r9189=r9187^r9179;r9190=_i64Add(r9136,r9137,r9188,r9189);r9191=tempRet0;r9192=_i64Add(r9190,r9191,r9148,r9147);r9193=tempRet0;r9194=_i64Add(r9192,r9193,r9170,r9171);r9195=tempRet0;r9196=r9195>>>29|0<<3;r9197=0>>>29|0<<3;r9198=0;r9199=0;r9200=_i64Subtract(r9198,r9199,r9196,r9197);r9201=tempRet0;r9202=r9200>>>3|r9201<<29;r9203=r9201>>>3|0<<29;r9204=r9202^r9194;r9205=r9203^r9195;r9206=r9204<<2|0>>>30;r9207=r9205<<2|r9204>>>30;r9208=-4;r9209=-1;r9210=r9206^r9208;r9211=r9207^r9209;r9212=r9211;r9213=r9210}else{r9214=r9129>>>0<62;if(!r9214){HEAPF64[tempDoublePtr>>3]=r9125;r9215=HEAP32[tempDoublePtr>>2];r9216=HEAP32[tempDoublePtr+4>>2];r9217=-4;r9218=-1;r9219=r9215&r9217;r9220=r9216&r9218;r9212=r9220;r9213=r9219;break}r9221=61-r9129|0;r9222=r9221;r9223=0;r9224=HEAP32[r9011>>2];r9225=r9221>>>0>16;do{if(r9225){r9226=__ZN9RCdecoder12decode_shiftEj(r9224,16);r9227=r9226;r9228=0;r9229=r9221-16|0;r9230=r9229>>>0>16;if(!r9230){r9231=0;r9232=16;r9233=r9228;r9234=r9227;r9235=r9229;break}r9236=__ZN9RCdecoder12decode_shiftEj(r9224,16);r9237=r9236;r9238=0;r9239=r9237<<16|0>>>16;r9240=r9238<<16|r9237>>>16;r9241=_i64Add(r9239,r9240,r9227,r9228);r9242=tempRet0;r9243=r9221-32|0;r9244=r9243>>>0>16;if(!r9244){r9231=0;r9232=32;r9233=r9242;r9234=r9241;r9235=r9243;break}r9245=__ZN9RCdecoder12decode_shiftEj(r9224,16);r9246=r9245;r9247=0;r9248=0;r9249=r9246;r9250=_i64Add(r9248,r9249,r9241,r9242);r9251=tempRet0;r9252=r9221-48|0;r9231=0;r9232=48;r9233=r9251;r9234=r9250;r9235=r9252}else{r9231=0;r9232=0;r9233=0;r9234=0;r9235=r9221}}while(0);r9253=__ZN9RCdecoder12decode_shiftEj(r9224,r9235);r9254=r9253;r9255=0;r9256=_bitshift64Shl(r9254,r9255,r9232);r9257=tempRet0;HEAPF64[tempDoublePtr>>3]=r9125;r9258=HEAP32[tempDoublePtr>>2];r9259=HEAP32[tempDoublePtr+4>>2];r9260=r9258>>>2|r9259<<30;r9261=r9259>>>2|0<<30;r9262=-1;r9263=1073741823;r9264=r9260^r9262;r9265=r9261^r9263;r9266=r9265>>>29|0<<3;r9267=0>>>29|0<<3;r9268=0;r9269=0;r9270=_i64Subtract(r9268,r9269,r9266,r9267);r9271=tempRet0;r9272=r9270>>>3|r9271<<29;r9273=r9271>>>3|0<<29;r9274=r9272^r9264;r9275=r9273^r9265;r9276=-1;r9277=-1;r9278=_bitshift64Shl(r9276,r9277,r9222);r9279=tempRet0;r9280=_i64Add(r9278,r9279,r9274,r9275);r9281=tempRet0;r9282=_i64Subtract(r9280,r9281,r9234,r9233);r9283=tempRet0;r9284=_i64Subtract(r9282,r9283,r9256,r9257);r9285=tempRet0;r9286=r9285>>>29|0<<3;r9287=0>>>29|0<<3;r9288=0;r9289=0;r9290=_i64Subtract(r9288,r9289,r9286,r9287);r9291=tempRet0;r9292=r9290>>>3|r9291<<29;r9293=r9291>>>3|0<<29;r9294=r9292^r9284;r9295=r9293^r9285;r9296=r9294<<2|0>>>30;r9297=r9295<<2|r9294>>>30;r9298=-4;r9299=-1;r9300=r9296^r9298;r9301=r9297^r9299;r9212=r9301;r9213=r9300}}while(0);r9302=(HEAP32[tempDoublePtr>>2]=r9213,HEAP32[tempDoublePtr+4>>2]=r9212,HEAPF64[tempDoublePtr>>3]);HEAPF64[r9063>>3]=r9302;r9303=r9061&r9018;r9304=r9029+(r9303<<3)|0;HEAPF64[r9304>>3]=r9302;r9305=r9063+8|0;r9306=r9061+1|0;r9307=r9062+1|0;r9308=r9307>>>0<r9001>>>0;if(r9308){r9061=r9306;r9062=r9307;r9063=r9305}else{r9059=r9306;r9060=r9305;break}}}r9309=r9054+1|0;r9310=r9309>>>0<r9002>>>0;if(r9310){r9053=r9059;r9054=r9309;r9055=r9060}else{r9051=r9059;r9052=r9060;break}}}r9311=r9041+1|0;r9312=r9311>>>0<r9003>>>0;if(r9312){r9040=r9051;r9041=r9311;r9042=r9052}else{break}}}r9313=(r9009|0)==0;if(!r9313){_free(r9009)}r9314=HEAP32[r6>>2];r9315=(r9314|0)==0;if(!r9315){r9316=r9314;r9317=HEAP32[r9316>>2];r9318=r9317+4|0;r9319=HEAP32[r9318>>2];FUNCTION_TABLE[r9319](r9314)}r9320=(r9028|0)==0;if(r9320){break L6}_free(r9028);break};case 64:{r9321=HEAP32[r41>>2];r9322=HEAP32[r42>>2];r9323=HEAP32[r43>>2];r9324=HEAP32[r44>>2];r9325=4;r9326=0;r9327=__Znwj(48);r9328=r9327;__ZN9RCqsmodelC2Ebjjj(r9328,0,129,16,1024);r9329=r9327;HEAP32[r5>>2]=r9329;r9330=__Znwj(12);r9331=r9330+4|0;r9332=r9331;HEAP32[r9332>>2]=r9321;r9333=r9330+8|0;r9334=r9333;HEAP32[r9334>>2]=r5;r9335=r9322+1|0;r9336=r9323+1|0;r9337=Math_imul(r9336,r9335)|0;r9338=r9337+r9335|0;r9339=r9338;while(1){r9340=r9339+1|0;r9341=r9340&r9339;r9342=(r9341|0)==0;r9343=r9340|r9339;if(r9342){break}else{r9339=r9343}}r9344=_llvm_umul_with_overflow_i32(r9340,8);r9345=tempRet0;r9346=r9345;r9347=r9344;r9348=r9346?-1:r9347;r9349=__Znwj(r9348);r9350=r9349;r9351=r9337;r9352=0;while(1){r9353=r9352+1|0;r9354=r9352&r9339;r9355=r9350+(r9354<<3)|0;HEAPF64[r9355>>3]=0;r9356=r9351-1|0;r9357=(r9356|0)==0;if(r9357){break}else{r9351=r9356;r9352=r9353}}r9358=(r9324|0)==0;if(!r9358){r9359=(r9323|0)==0;r9360=(r9322|0)==0;r9361=r9337;r9362=0;r9363=r76;while(1){r9364=r9335;r9365=r9361;while(1){r9366=r9365+1|0;r9367=r9365&r9339;r9368=r9350+(r9367<<3)|0;HEAPF64[r9368>>3]=0;r9369=r9364-1|0;r9370=(r9369|0)==0;if(r9370){break}else{r9364=r9369;r9365=r9366}}r9371=r9361+r9335|0;if(r9359){r9372=r9371;r9373=r9363}else{r9374=r9371;r9375=0;r9376=r9363;while(1){r9377=r9374&r9339;r9378=r9350+(r9377<<3)|0;HEAPF64[r9378>>3]=0;r9379=r9374+1|0;if(r9360){r9380=r9379;r9381=r9376}else{r9382=r9379;r9383=0;r9384=r9376;while(1){r9385=r9382-1|0;r9386=r9385&r9339;r9387=r9350+(r9386<<3)|0;r9388=HEAPF64[r9387>>3];r9389=r9387|0;r9390=HEAP32[r9389>>2];r9391=r9387+4|0;r9392=HEAP32[r9391>>2];r9393=r9382-r9335|0;r9394=r9393-r9337|0;r9395=r9394&r9339;r9396=r9350+(r9395<<3)|0;r9397=HEAPF64[r9396>>3];r9398=r9396|0;r9399=HEAP32[r9398>>2];r9400=r9396+4|0;r9401=HEAP32[r9400>>2];r9402=r9388-r9397;r9403=r9393&r9339;r9404=r9350+(r9403<<3)|0;r9405=HEAPF64[r9404>>3];r9406=r9404|0;r9407=HEAP32[r9406>>2];r9408=r9404+4|0;r9409=HEAP32[r9408>>2];r9410=r9402+r9405;r9411=r9385-r9337|0;r9412=r9411&r9339;r9413=r9350+(r9412<<3)|0;r9414=HEAPF64[r9413>>3];r9415=r9413|0;r9416=HEAP32[r9415>>2];r9417=r9413+4|0;r9418=HEAP32[r9417>>2];r9419=r9410-r9414;r9420=r9382-r9337|0;r9421=r9420&r9339;r9422=r9350+(r9421<<3)|0;r9423=HEAPF64[r9422>>3];r9424=r9422|0;r9425=HEAP32[r9424>>2];r9426=r9422+4|0;r9427=HEAP32[r9426>>2];r9428=r9419+r9423;r9429=r9385-r9335|0;r9430=r9429&r9339;r9431=r9350+(r9430<<3)|0;r9432=HEAPF64[r9431>>3];r9433=r9431|0;r9434=HEAP32[r9433>>2];r9435=r9431+4|0;r9436=HEAP32[r9435>>2];r9437=r9428-r9432;r9438=r9429-r9337|0;r9439=r9438&r9339;r9440=r9350+(r9439<<3)|0;r9441=HEAPF64[r9440>>3];r9442=r9440|0;r9443=HEAP32[r9442>>2];r9444=r9440+4|0;r9445=HEAP32[r9444>>2];r9446=r9437+r9441;r9447=HEAP32[r9332>>2];r9448=HEAP32[r9334>>2];r9449=HEAP32[r9448>>2];r9450=__ZN9RCdecoder6decodeEP7RCmodel(r9447,r9449);r9451=r9450>>>0>64;do{if(r9451){r9452=r9450-65|0;r9453=r9452;r9454=0;r9455=1;r9456=0;r9457=_bitshift64Shl(r9455,r9456,r9453);r9458=tempRet0;r9459=HEAP32[r9332>>2];r9460=r9452>>>0>16;do{if(r9460){r9461=__ZN9RCdecoder12decode_shiftEj(r9459,16);r9462=r9461;r9463=0;r9464=r9450-81|0;r9465=r9464>>>0>16;if(!r9465){r9466=0;r9467=16;r9468=r9463;r9469=r9462;r9470=r9464;break}r9471=__ZN9RCdecoder12decode_shiftEj(r9459,16);r9472=r9471;r9473=0;r9474=r9472<<16|0>>>16;r9475=r9473<<16|r9472>>>16;r9476=_i64Add(r9474,r9475,r9462,r9463);r9477=tempRet0;r9478=r9450-97|0;r9479=r9478>>>0>16;if(!r9479){r9466=0;r9467=32;r9468=r9477;r9469=r9476;r9470=r9478;break}r9480=__ZN9RCdecoder12decode_shiftEj(r9459,16);r9481=r9480;r9482=0;r9483=0;r9484=r9481;r9485=_i64Add(r9483,r9484,r9476,r9477);r9486=tempRet0;r9487=r9450-113|0;r9466=0;r9467=48;r9468=r9486;r9469=r9485;r9470=r9487}else{r9466=0;r9467=0;r9468=0;r9469=0;r9470=r9452}}while(0);r9488=__ZN9RCdecoder12decode_shiftEj(r9459,r9470);r9489=r9488;r9490=0;r9491=_bitshift64Shl(r9489,r9490,r9467);r9492=tempRet0;HEAPF64[tempDoublePtr>>3]=r9446;r9493=HEAP32[tempDoublePtr>>2];r9494=HEAP32[tempDoublePtr+4>>2];r9495=-1;r9496=-1;r9497=r9493^r9495;r9498=r9494^r9496;r9499=r9498>>31|((r9498|0)<0|0?-1:0)<<1;r9500=((r9498|0)<0|0?-1:0)>>31|((r9498|0)<0|0?-1:0)<<1;r9501=r9499>>>1|r9500<<31;r9502=r9500>>>1|0<<31;r9503=r9501^r9497;r9504=r9502^r9498;r9505=_i64Add(r9457,r9458,r9503,r9504);r9506=tempRet0;r9507=_i64Add(r9505,r9506,r9469,r9468);r9508=tempRet0;r9509=_i64Add(r9507,r9508,r9491,r9492);r9510=tempRet0;r9511=r9510>>31|((r9510|0)<0|0?-1:0)<<1;r9512=((r9510|0)<0|0?-1:0)>>31|((r9510|0)<0|0?-1:0)<<1;r9513=r9511>>>1|r9512<<31;r9514=r9512>>>1|0<<31;r9515=-1;r9516=-1;r9517=r9509^r9515;r9518=r9510^r9516;r9519=r9513^r9517;r9520=r9514^r9518;r9521=(HEAP32[tempDoublePtr>>2]=r9519,HEAP32[tempDoublePtr+4>>2]=r9520,HEAPF64[tempDoublePtr>>3]);r9522=r9521}else{r9523=r9450>>>0<64;if(!r9523){r9522=r9446;break}r9524=63-r9450|0;r9525=r9524;r9526=0;r9527=HEAP32[r9332>>2];r9528=r9524>>>0>16;do{if(r9528){r9529=__ZN9RCdecoder12decode_shiftEj(r9527,16);r9530=r9529;r9531=0;r9532=r9524-16|0;r9533=r9532>>>0>16;if(!r9533){r9534=0;r9535=16;r9536=r9531;r9537=r9530;r9538=r9532;break}r9539=__ZN9RCdecoder12decode_shiftEj(r9527,16);r9540=r9539;r9541=0;r9542=r9540<<16|0>>>16;r9543=r9541<<16|r9540>>>16;r9544=_i64Add(r9542,r9543,r9530,r9531);r9545=tempRet0;r9546=r9524-32|0;r9547=r9546>>>0>16;if(!r9547){r9534=0;r9535=32;r9536=r9545;r9537=r9544;r9538=r9546;break}r9548=__ZN9RCdecoder12decode_shiftEj(r9527,16);r9549=r9548;r9550=0;r9551=0;r9552=r9549;r9553=_i64Add(r9551,r9552,r9544,r9545);r9554=tempRet0;r9555=r9524-48|0;r9534=0;r9535=48;r9536=r9554;r9537=r9553;r9538=r9555}else{r9534=0;r9535=0;r9536=0;r9537=0;r9538=r9524}}while(0);r9556=__ZN9RCdecoder12decode_shiftEj(r9527,r9538);r9557=r9556;r9558=0;r9559=_bitshift64Shl(r9557,r9558,r9535);r9560=tempRet0;HEAPF64[tempDoublePtr>>3]=r9446;r9561=HEAP32[tempDoublePtr>>2];r9562=HEAP32[tempDoublePtr+4>>2];r9563=-1;r9564=-1;r9565=r9561^r9563;r9566=r9562^r9564;r9567=r9566>>31|((r9566|0)<0|0?-1:0)<<1;r9568=((r9566|0)<0|0?-1:0)>>31|((r9566|0)<0|0?-1:0)<<1;r9569=r9567>>>1|r9568<<31;r9570=r9568>>>1|0<<31;r9571=r9569^r9565;r9572=r9570^r9566;r9573=-1;r9574=-1;r9575=_bitshift64Shl(r9573,r9574,r9525);r9576=tempRet0;r9577=_i64Add(r9575,r9576,r9571,r9572);r9578=tempRet0;r9579=_i64Subtract(r9577,r9578,r9537,r9536);r9580=tempRet0;r9581=_i64Subtract(r9579,r9580,r9559,r9560);r9582=tempRet0;r9583=r9582>>31|((r9582|0)<0|0?-1:0)<<1;r9584=((r9582|0)<0|0?-1:0)>>31|((r9582|0)<0|0?-1:0)<<1;r9585=r9583>>>1|r9584<<31;r9586=r9584>>>1|0<<31;r9587=-1;r9588=-1;r9589=r9581^r9587;r9590=r9582^r9588;r9591=r9585^r9589;r9592=r9586^r9590;r9593=(HEAP32[tempDoublePtr>>2]=r9591,HEAP32[tempDoublePtr+4>>2]=r9592,HEAPF64[tempDoublePtr>>3]);r9522=r9593}}while(0);HEAPF64[r9384>>3]=r9522;r9594=r9382&r9339;r9595=r9350+(r9594<<3)|0;HEAPF64[r9595>>3]=r9522;r9596=r9384+8|0;r9597=r9382+1|0;r9598=r9383+1|0;r9599=r9598>>>0<r9322>>>0;if(r9599){r9382=r9597;r9383=r9598;r9384=r9596}else{r9380=r9597;r9381=r9596;break}}}r9600=r9375+1|0;r9601=r9600>>>0<r9323>>>0;if(r9601){r9374=r9380;r9375=r9600;r9376=r9381}else{r9372=r9380;r9373=r9381;break}}}r9602=r9362+1|0;r9603=r9602>>>0<r9324>>>0;if(r9603){r9361=r9372;r9362=r9602;r9363=r9373}else{break}}}r9604=(r9330|0)==0;if(!r9604){_free(r9330)}r9605=HEAP32[r5>>2];r9606=(r9605|0)==0;if(!r9606){r9607=r9605;r9608=HEAP32[r9607>>2];r9609=r9608+4|0;r9610=HEAP32[r9609>>2];FUNCTION_TABLE[r9610](r9605)}r9611=(r9349|0)==0;if(r9611){break L6}_free(r9349);break};default:{break L4}}}while(0);r9612=HEAP32[r42>>2];r9613=HEAP32[r43>>2];r9614=Math_imul(r9613,r9612)|0;r9615=HEAP32[r44>>2];r9616=Math_imul(r9614,r9615)|0;r9617=r76+(r9616<<3)|0;r9618=r77+1|0;r9619=HEAP32[r36>>2];r9620=(r9618|0)<(r9619|0);if(r9620){r76=r9617;r77=r9618}else{r39=1;r3=1523;break}}if(r3==1523){STACKTOP=r4;return r39}HEAP32[_fpzip_errno>>2]=5;r39=0;STACKTOP=r4;return r39}function __ZN12RCmemdecoderD2Ev(r1){return}function __ZN12RCmemdecoderD0Ev(r1){if((r1|0)==0){return}_free(r1);return}function __ZN12RCmemdecoder7getbyteEv(r1){var r2;r2=r1+20|0;r1=HEAP32[r2>>2];HEAP32[r2>>2]=r1+1;return HEAPU8[r1]}function __ZNK12RCmemdecoder5bytesEv(r1){return HEAP32[r1+20>>2]-HEAP32[r1+24>>2]|0}function __Z10dekempressPv(r1){var r2,r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18,r19;r2=__Z10decompressPv(r1);r1=HEAP32[r2+8>>2];r3=HEAP32[r2+12>>2];r4=HEAP32[r2+16>>2];r5=HEAP32[r2+20>>2];r6=r2+28|0;r7=HEAP32[r6>>2];if((HEAP32[r2>>2]|0)==0){r8=r7;r9=HEAP32[r2+24>>2];if((r9|0)>0){r10=0;while(1){r11=r8+(r10<<2)|0;HEAPF32[r11>>2]=HEAPF32[r11>>2]-2;r11=r10+1|0;if((r11|0)<(r9|0)){r10=r11}else{break}}}r10=Math_imul(r3,r1)|0;r9=Math_imul(r10,r4)|0;r11=Math_imul(r9,r5)|0;do{if((r11|0)==0){r12=0}else{r13=r11<<2;if(r11>>>0<=65535){r12=r13;break}r12=((r13>>>0)/(r11>>>0)&-1|0)==4?r13:-1}}while(0);r11=_malloc(r12);do{if((r11|0)!=0){if((HEAP32[r11-4>>2]&3|0)==0){break}_memset(r11,0,r12)|0}}while(0);r12=r11;if((r5|0)>0&(r4|0)>0){r13=0;while(1){r14=Math_imul(r13,r9)|0;r15=r13+r5|0;r16=0;while(1){r17=Math_imul(r16,r10)|0;_memcpy(r12+(r17+r14<<2)|0,r8+(Math_imul(r17,r15)<<2)|0,r10)|0;r17=r16+1|0;if((r17|0)<(r4|0)){r16=r17}else{break}}r16=r13+1|0;if((r16|0)<(r5|0)){r13=r16}else{break}}}_free(r7);r18=r11;HEAP32[r6>>2]=r18;return r2}else{r11=r7;r13=HEAP32[r2+24>>2];if((r13|0)>0){r10=0;while(1){r8=r11+(r10<<3)|0;HEAPF64[r8>>3]=HEAPF64[r8>>3]-2;r8=r10+1|0;if((r8|0)<(r13|0)){r10=r8}else{break}}}r10=Math_imul(r3,r1)|0;r1=Math_imul(r10,r4)|0;r3=Math_imul(r1,r5)|0;do{if((r3|0)==0){r19=0}else{r13=r3<<3;if(r3>>>0<=65535){r19=r13;break}r19=((r13>>>0)/(r3>>>0)&-1|0)==8?r13:-1}}while(0);r3=_malloc(r19);do{if((r3|0)!=0){if((HEAP32[r3-4>>2]&3|0)==0){break}_memset(r3,0,r19)|0}}while(0);r19=r3;if((r5|0)>0&(r4|0)>0){r13=0;while(1){r8=Math_imul(r13,r1)|0;r12=r13+r5|0;r9=0;while(1){r16=Math_imul(r9,r10)|0;_memcpy(r19+(r16+r8<<3)|0,r11+(Math_imul(r16,r12)<<3)|0,r10)|0;r16=r9+1|0;if((r16|0)<(r4|0)){r9=r16}else{break}}r9=r13+1|0;if((r9|0)<(r5|0)){r13=r9}else{break}}}_free(r7);r18=r3;HEAP32[r6>>2]=r18;return r2}}function __Z10decompressPv(r1){var r2,r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18,r19,r20,r21,r22,r23,r24,r25,r26,r27,r28,r29,r30,r31,r32,r33,r34,r35;r2=0;r3=0;r4=STACKTOP;HEAP32[_fpzip_errno>>2]=0;r5=__Znwj(28);r6=r5;HEAP32[r6>>2]=0;r7=r5+4|0;HEAP32[r7>>2]=0;r8=r5+20|0;HEAP32[r8>>2]=1;r9=r5+16|0;HEAP32[r9>>2]=1;r10=r5+12|0;HEAP32[r10>>2]=1;r11=r5+8|0;HEAP32[r11>>2]=1;r12=r5+24|0;r13=__Znwj(28);r14=r13+8|0;HEAP32[r14>>2]=0;HEAP32[r13+12>>2]=-1;r15=r13+16|0;HEAP32[r13>>2]=592;HEAP32[r13+20>>2]=r1;HEAP32[r13+24>>2]=r1;r16=r13;HEAP32[r12>>2]=r16;HEAP8[r13+4|0]=0;r17=r13;HEAP32[r15>>2]=0;r18=__ZN12RCmemdecoder7getbyteEv(r13);r13=HEAP32[r15>>2]|r18;HEAP32[r14>>2]=HEAP32[r14>>2]<<8;HEAP32[r15>>2]=r13<<8;r13=FUNCTION_TABLE[HEAP32[HEAP32[r17>>2]+8>>2]](r16);r18=HEAP32[r15>>2]|r13;HEAP32[r14>>2]=HEAP32[r14>>2]<<8;HEAP32[r15>>2]=r18<<8;r18=FUNCTION_TABLE[HEAP32[HEAP32[r17>>2]+8>>2]](r16);r13=HEAP32[r15>>2]|r18;HEAP32[r14>>2]=HEAP32[r14>>2]<<8;HEAP32[r15>>2]=r13<<8;r13=FUNCTION_TABLE[HEAP32[HEAP32[r17>>2]+8>>2]](r16);HEAP32[r15>>2]=HEAP32[r15>>2]|r13;HEAP32[r14>>2]=HEAP32[r14>>2]<<8;HEAP32[_fpzip_errno>>2]=0;r14=HEAP32[r12>>2];do{if((__ZN9RCdecoder12decode_shiftEj(r14,8)|0)==102){if((__ZN9RCdecoder12decode_shiftEj(r14,8)|0)!=112){r19=3;break}if((__ZN9RCdecoder12decode_shiftEj(r14,8)|0)!=122){r19=3;break}if((__ZN9RCdecoder12decode_shiftEj(r14,8)|0)!=0){r19=3;break}if((__ZN9RCdecoder12decode_shiftEj(r14,16)|0)!=272){r19=4;break}if((__ZN9RCdecoder12decode_shiftEj(r14,8)|0)!=1){r19=4;break}HEAP32[r6>>2]=__ZN9RCdecoder12decode_shiftEj(r14,1);HEAP32[r7>>2]=__ZN9RCdecoder12decode_shiftEj(r14,7);r13=__ZN9RCdecoder12decode_shiftEj(r14,16);HEAP32[r11>>2]=(__ZN9RCdecoder12decode_shiftEj(r14,16)<<16)+r13;r13=__ZN9RCdecoder12decode_shiftEj(r14,16);HEAP32[r10>>2]=(__ZN9RCdecoder12decode_shiftEj(r14,16)<<16)+r13;r13=__ZN9RCdecoder12decode_shiftEj(r14,16);r15=(__ZN9RCdecoder12decode_shiftEj(r14,16)<<16)+r13|0;HEAP32[r9>>2]=r15;r13=__ZN9RCdecoder12decode_shiftEj(r14,16);r16=(__ZN9RCdecoder12decode_shiftEj(r14,16)<<16)+r13|0;HEAP32[r8>>2]=r16;r13=r5;r17=int32x4(HEAP32[r13>>2],HEAP32[r13+4>>2],HEAP32[r13+8>>2],HEAP32[r13+12>>2]);r13=Math_imul(Math_imul(Math_imul(r17.w,r17.z)|0,r15)|0,r16)|0;r18=r17.x;if((r18|0)==0){r20=_llvm_umul_with_overflow_i32(r13,4);r21=__Znwj(tempRet0?-1:r20)}else{r20=_llvm_umul_with_overflow_i32(r13,8);r21=__Znwj(tempRet0?-1:r20)}HEAP32[_fpzip_errno>>2]=0;r20=r5;if((HEAP32[r6>>2]|0)==0){if(__ZL12decompress4dIfEbP8FPZinputPT_(r20,r21)){r2=20}}else{if(__ZL12decompress4dIdEbP8FPZinputPT_(r20,r21)){r2=20}}do{if(r2==20){r20=HEAP32[r12>>2];if((HEAP8[r20+4|0]&1)!=0){if((HEAP32[_fpzip_errno>>2]|0)!=0){break}HEAP32[_fpzip_errno>>2]=1;break}if((FUNCTION_TABLE[HEAP32[HEAP32[r20>>2]+12>>2]](r20)|0)==0){break}r20=HEAP32[r12>>2];if((r20|0)!=0){FUNCTION_TABLE[HEAP32[HEAP32[r20>>2]+4>>2]](r20)}if((r5|0)==0){_free(r1);r22=__Znwj(32);r23=r22;HEAP32[r22>>2]=0;HEAP32[r22+4>>2]=0;HEAP32[r22+8>>2]=0;HEAP32[r22+12>>2]=0;HEAP32[r22+16>>2]=0;HEAP32[r22+20>>2]=0;r24=r22;HEAP32[r24>>2]=r17.x,HEAP32[r24+4>>2]=r17.y,HEAP32[r24+8>>2]=r17.z,HEAP32[r24+12>>2]=r17.w;r25=r22+16|0;r26=r25;HEAP32[r26>>2]=r15;r27=r22+20|0;r28=r27;HEAP32[r28>>2]=r16;r29=r18<<2;r30=r29+4|0;r31=Math_imul(r30,r13)|0;r32=r22+24|0;r33=r32;HEAP32[r33>>2]=r31;r34=r22+28|0;r35=r34;HEAP32[r35>>2]=r21;STACKTOP=r4;return r23}_free(r5);_free(r1);r22=__Znwj(32);r23=r22;HEAP32[r22>>2]=0;HEAP32[r22+4>>2]=0;HEAP32[r22+8>>2]=0;HEAP32[r22+12>>2]=0;HEAP32[r22+16>>2]=0;HEAP32[r22+20>>2]=0;r24=r22;HEAP32[r24>>2]=r17.x,HEAP32[r24+4>>2]=r17.y,HEAP32[r24+8>>2]=r17.z,HEAP32[r24+12>>2]=r17.w;r25=r22+16|0;r26=r25;HEAP32[r26>>2]=r15;r27=r22+20|0;r28=r27;HEAP32[r28>>2]=r16;r29=r18<<2;r30=r29+4|0;r31=Math_imul(r30,r13)|0;r32=r22+24|0;r33=r32;HEAP32[r33>>2]=r31;r34=r22+28|0;r35=r34;HEAP32[r35>>2]=r21;STACKTOP=r4;return r23}}while(0);r13=HEAP32[_fpzip_errstr+(HEAP32[_fpzip_errno>>2]<<2)>>2];_sprintf(0,352,(r3=STACKTOP,STACKTOP=STACKTOP+8|0,HEAP32[r3>>2]=r13,r3));STACKTOP=r3;___cxa_throw(___cxa_allocate_exception(4),1432,0)}else{r19=3}}while(0);HEAP32[_fpzip_errno>>2]=r19;r23=HEAP32[_fpzip_errstr+(r19<<2)>>2];_sprintf(0,384,(r3=STACKTOP,STACKTOP=STACKTOP+8|0,HEAP32[r3>>2]=r23,r3));STACKTOP=r3;___cxa_throw(___cxa_allocate_exception(4),1432,0)}function __GLOBAL__I_a(){var r1,r2,r3,r4;r1=STACKTOP;STACKTOP=STACKTOP+32|0;r2=r1;r3=r1+16;HEAP32[r3>>2]=2;r4=r3+4|0;HEAP32[r4>>2]=1448;HEAP32[r3+8>>2]=1416;__embind_register_function(192,2,r4,20,50);HEAP32[r2>>2]=2;r4=r2+4|0;HEAP32[r4>>2]=1448;HEAP32[r2+8>>2]=1416;__embind_register_function(128,2,r4,20,16);STACKTOP=r1;return}function __ZN10emscripten8internal7InvokerIP12DecodedImageJPvEE6invokeEPFS3_S4_ES4_(r1,r2){return FUNCTION_TABLE[r1](r2)}



function __ZL12decompress4dIfEbP8FPZinputPT_(r1,r2){var r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18,r19,r20,r21,r22,r23,r24,r25,r26,r27,r28,r29,r30,r31,r32,r33,r34,r35,r36,r37,r38,r39,r40,r41,r42,r43,r44,r45,r46,r47,r48,r49,r50,r51,r52,r53,r54,r55,r56,r57,r58,r59,r60,r61,r62,r63,r64,r65,r66,r67,r68,r69,r70,r71,r72,r73,r74,r75,r76,r77,r78,r79,r80,r81,r82,r83,r84,r85,r86,r87,r88,r89,r90,r91,r92,r93,r94,r95,r96,r97,r98,r99,r100,r101,r102,r103,r104,r105,r106,r107,r108,r109,r110,r111,r112,r113,r114,r115,r116,r117,r118,r119,r120,r121,r122,r123,r124,r125,r126,r127,r128,r129,r130,r131,r132,r133,r134,r135,r136,r137,r138,r139,r140,r141,r142,r143,r144,r145,r146,r147,r148,r149,r150,r151,r152,r153,r154,r155,r156,r157,r158,r159,r160,r161,r162,r163,r164,r165,r166,r167,r168,r169,r170,r171,r172,r173,r174,r175,r176,r177,r178,r179,r180,r181,r182,r183,r184,r185,r186,r187,r188,r189,r190,r191,r192,r193,r194,r195,r196,r197,r198,r199,r200,r201,r202,r203,r204,r205,r206,r207,r208,r209,r210,r211,r212,r213,r214,r215,r216,r217,r218,r219,r220,r221,r222,r223,r224,r225,r226,r227,r228,r229,r230,r231,r232,r233,r234,r235,r236,r237,r238,r239,r240,r241,r242,r243,r244,r245,r246,r247,r248,r249,r250,r251,r252,r253,r254,r255,r256,r257,r258,r259,r260,r261,r262,r263,r264,r265,r266,r267,r268,r269,r270,r271,r272,r273,r274,r275,r276,r277,r278,r279,r280,r281,r282,r283,r284,r285,r286,r287,r288,r289,r290,r291,r292,r293,r294,r295,r296,r297,r298,r299,r300,r301,r302,r303,r304,r305,r306,r307,r308,r309,r310,r311,r312,r313,r314,r315,r316,r317,r318,r319,r320,r321,r322,r323,r324,r325,r326,r327,r328,r329,r330,r331,r332,r333,r334,r335,r336,r337,r338,r339,r340,r341,r342,r343,r344,r345,r346,r347,r348,r349,r350,r351,r352,r353,r354,r355,r356,r357,r358,r359,r360,r361,r362,r363,r364,r365,r366,r367,r368,r369,r370,r371,r372,r373,r374,r375,r376,r377,r378,r379,r380,r381,r382,r383,r384,r385,r386,r387,r388,r389,r390,r391,r392,r393,r394,r395,r396,r397,r398,r399,r400,r401,r402,r403,r404,r405,r406,r407,r408,r409,r410,r411,r412,r413,r414,r415,r416,r417,r418,r419,r420,r421,r422,r423,r424,r425,r426,r427,r428,r429,r430,r431,r432,r433,r434,r435,r436,r437,r438,r439,r440,r441,r442,r443,r444,r445,r446,r447,r448,r449,r450,r451,r452,r453,r454,r455,r456,r457,r458,r459,r460,r461,r462,r463,r464,r465,r466,r467,r468,r469,r470,r471,r472,r473,r474,r475,r476,r477,r478,r479,r480,r481,r482,r483,r484,r485,r486,r487,r488,r489,r490,r491,r492,r493,r494,r495,r496,r497,r498,r499,r500,r501,r502,r503,r504,r505,r506,r507,r508,r509,r510,r511,r512,r513,r514,r515,r516,r517,r518,r519,r520,r521,r522,r523,r524,r525,r526,r527,r528,r529,r530,r531,r532,r533,r534,r535,r536,r537,r538,r539,r540,r541,r542,r543,r544,r545,r546,r547,r548,r549,r550,r551,r552,r553,r554,r555,r556,r557,r558,r559,r560,r561,r562,r563,r564,r565,r566,r567,r568,r569,r570,r571,r572,r573,r574,r575,r576,r577,r578,r579,r580,r581,r582,r583,r584,r585,r586,r587,r588,r589,r590,r591,r592,r593,r594,r595,r596,r597,r598,r599,r600,r601,r602,r603,r604,r605,r606,r607,r608,r609,r610,r611,r612,r613,r614,r615,r616,r617,r618,r619,r620,r621,r622,r623,r624,r625,r626,r627,r628,r629,r630,r631,r632,r633,r634,r635,r636,r637,r638,r639,r640,r641,r642,r643,r644,r645,r646,r647,r648,r649,r650,r651,r652,r653,r654,r655,r656,r657,r658,r659,r660,r661,r662,r663,r664,r665,r666,r667,r668,r669,r670,r671,r672,r673,r674,r675,r676,r677,r678,r679,r680,r681,r682,r683,r684,r685,r686,r687,r688,r689,r690,r691,r692,r693,r694,r695,r696,r697,r698,r699,r700,r701,r702,r703,r704,r705,r706,r707,r708,r709,r710,r711,r712,r713,r714,r715,r716,r717,r718,r719,r720,r721,r722,r723,r724,r725,r726,r727,r728,r729,r730,r731,r732,r733,r734,r735,r736,r737,r738,r739,r740,r741,r742,r743,r744,r745,r746,r747,r748,r749,r750,r751,r752,r753,r754,r755,r756,r757,r758,r759,r760,r761,r762,r763,r764,r765,r766,r767,r768,r769,r770,r771,r772,r773,r774,r775,r776,r777,r778,r779,r780,r781,r782,r783,r784,r785,r786,r787,r788,r789,r790,r791,r792,r793,r794,r795,r796,r797,r798,r799,r800,r801,r802,r803,r804,r805,r806,r807,r808,r809,r810,r811,r812,r813,r814,r815,r816,r817,r818,r819,r820,r821,r822,r823,r824,r825,r826,r827,r828,r829,r830,r831,r832,r833,r834,r835,r836,r837,r838,r839,r840,r841,r842,r843,r844,r845,r846,r847,r848,r849,r850,r851,r852,r853,r854,r855,r856,r857,r858,r859,r860,r861,r862,r863,r864,r865,r866,r867,r868,r869,r870,r871,r872,r873,r874,r875,r876,r877,r878,r879,r880,r881,r882,r883,r884,r885,r886,r887,r888,r889,r890,r891,r892,r893,r894,r895,r896,r897,r898,r899,r900,r901,r902,r903,r904,r905,r906,r907,r908,r909,r910,r911,r912,r913,r914,r915,r916,r917,r918,r919,r920,r921,r922,r923,r924,r925,r926,r927,r928,r929,r930,r931,r932,r933,r934,r935,r936,r937,r938,r939,r940,r941,r942,r943,r944,r945,r946,r947,r948,r949,r950,r951,r952,r953,r954,r955,r956,r957,r958,r959,r960,r961,r962,r963,r964,r965,r966,r967,r968,r969,r970,r971,r972,r973,r974,r975,r976,r977,r978,r979,r980,r981,r982,r983,r984,r985,r986,r987,r988,r989,r990,r991,r992,r993,r994,r995,r996,r997,r998,r999,r1000,r1001,r1002,r1003,r1004,r1005,r1006,r1007,r1008,r1009,r1010,r1011,r1012,r1013,r1014,r1015,r1016,r1017,r1018,r1019,r1020,r1021,r1022,r1023,r1024,r1025,r1026,r1027,r1028,r1029,r1030,r1031,r1032,r1033,r1034,r1035,r1036,r1037,r1038,r1039,r1040,r1041,r1042,r1043,r1044,r1045,r1046,r1047,r1048,r1049,r1050,r1051,r1052,r1053,r1054,r1055,r1056,r1057,r1058,r1059,r1060,r1061,r1062,r1063,r1064,r1065,r1066,r1067,r1068,r1069,r1070,r1071,r1072,r1073,r1074,r1075,r1076,r1077,r1078,r1079,r1080,r1081,r1082,r1083,r1084,r1085,r1086,r1087,r1088,r1089,r1090,r1091,r1092,r1093,r1094,r1095,r1096,r1097,r1098,r1099,r1100,r1101,r1102,r1103,r1104,r1105,r1106,r1107,r1108,r1109,r1110,r1111,r1112,r1113,r1114,r1115,r1116,r1117,r1118,r1119,r1120,r1121,r1122,r1123,r1124,r1125,r1126,r1127,r1128,r1129,r1130,r1131,r1132,r1133,r1134,r1135,r1136,r1137,r1138,r1139,r1140,r1141,r1142,r1143,r1144,r1145,r1146,r1147,r1148,r1149,r1150,r1151,r1152,r1153,r1154,r1155,r1156,r1157,r1158,r1159,r1160,r1161,r1162,r1163,r1164,r1165,r1166,r1167,r1168,r1169,r1170,r1171,r1172,r1173,r1174,r1175,r1176,r1177,r1178,r1179,r1180,r1181,r1182,r1183,r1184,r1185,r1186,r1187,r1188,r1189,r1190,r1191,r1192,r1193,r1194,r1195,r1196,r1197,r1198,r1199,r1200,r1201,r1202,r1203,r1204,r1205,r1206,r1207,r1208,r1209,r1210,r1211,r1212,r1213,r1214,r1215,r1216,r1217,r1218,r1219,r1220,r1221,r1222,r1223,r1224,r1225,r1226,r1227,r1228,r1229,r1230,r1231,r1232,r1233,r1234,r1235,r1236,r1237,r1238,r1239,r1240,r1241,r1242,r1243,r1244,r1245,r1246,r1247,r1248,r1249,r1250,r1251,r1252,r1253,r1254,r1255,r1256,r1257,r1258,r1259,r1260,r1261,r1262,r1263,r1264,r1265,r1266,r1267,r1268,r1269,r1270,r1271,r1272,r1273,r1274,r1275,r1276,r1277,r1278,r1279,r1280,r1281,r1282,r1283,r1284,r1285,r1286,r1287,r1288,r1289,r1290,r1291,r1292,r1293,r1294,r1295,r1296,r1297,r1298,r1299,r1300,r1301,r1302,r1303,r1304,r1305,r1306,r1307,r1308,r1309,r1310,r1311,r1312,r1313,r1314,r1315,r1316,r1317,r1318,r1319,r1320,r1321,r1322,r1323,r1324,r1325,r1326,r1327,r1328,r1329,r1330,r1331,r1332,r1333,r1334,r1335,r1336,r1337,r1338,r1339,r1340,r1341,r1342,r1343,r1344,r1345,r1346,r1347,r1348,r1349,r1350,r1351,r1352,r1353,r1354,r1355,r1356,r1357,r1358,r1359,r1360,r1361,r1362,r1363,r1364,r1365,r1366,r1367,r1368,r1369,r1370,r1371,r1372,r1373,r1374,r1375,r1376,r1377,r1378,r1379,r1380,r1381,r1382,r1383,r1384,r1385,r1386,r1387,r1388,r1389,r1390,r1391,r1392,r1393,r1394,r1395,r1396,r1397,r1398,r1399,r1400,r1401,r1402,r1403,r1404,r1405,r1406,r1407,r1408,r1409,r1410,r1411,r1412,r1413,r1414,r1415,r1416,r1417,r1418,r1419,r1420,r1421,r1422,r1423,r1424,r1425,r1426,r1427,r1428,r1429,r1430,r1431,r1432,r1433,r1434,r1435,r1436,r1437,r1438,r1439,r1440,r1441,r1442,r1443,r1444,r1445,r1446,r1447,r1448,r1449,r1450,r1451,r1452,r1453,r1454,r1455,r1456,r1457,r1458,r1459,r1460,r1461,r1462,r1463,r1464,r1465,r1466,r1467,r1468,r1469,r1470,r1471,r1472,r1473,r1474,r1475,r1476,r1477,r1478,r1479,r1480,r1481,r1482,r1483,r1484,r1485,r1486,r1487,r1488,r1489,r1490,r1491,r1492,r1493,r1494,r1495,r1496,r1497,r1498,r1499,r1500,r1501,r1502,r1503,r1504,r1505,r1506,r1507,r1508,r1509,r1510,r1511,r1512,r1513,r1514,r1515,r1516,r1517,r1518,r1519,r1520,r1521,r1522,r1523,r1524,r1525,r1526,r1527,r1528,r1529,r1530,r1531,r1532,r1533,r1534,r1535,r1536,r1537,r1538,r1539,r1540,r1541,r1542,r1543,r1544,r1545,r1546,r1547,r1548,r1549,r1550,r1551,r1552,r1553,r1554,r1555,r1556,r1557,r1558,r1559,r1560,r1561,r1562,r1563,r1564,r1565,r1566,r1567,r1568,r1569,r1570,r1571,r1572,r1573,r1574,r1575,r1576,r1577,r1578,r1579,r1580,r1581,r1582,r1583,r1584,r1585,r1586,r1587,r1588,r1589,r1590,r1591,r1592,r1593,r1594,r1595,r1596,r1597,r1598,r1599,r1600,r1601,r1602,r1603,r1604,r1605,r1606,r1607,r1608,r1609,r1610,r1611,r1612,r1613,r1614,r1615,r1616,r1617,r1618,r1619,r1620,r1621,r1622,r1623,r1624,r1625,r1626,r1627,r1628,r1629,r1630,r1631,r1632,r1633,r1634,r1635,r1636,r1637,r1638,r1639,r1640,r1641,r1642,r1643,r1644,r1645,r1646,r1647,r1648,r1649,r1650,r1651,r1652,r1653,r1654,r1655,r1656,r1657,r1658,r1659,r1660,r1661,r1662,r1663,r1664,r1665,r1666,r1667,r1668,r1669,r1670,r1671,r1672,r1673,r1674,r1675,r1676,r1677,r1678,r1679,r1680,r1681,r1682,r1683,r1684,r1685,r1686,r1687,r1688,r1689,r1690,r1691,r1692,r1693,r1694,r1695,r1696,r1697,r1698,r1699,r1700,r1701,r1702,r1703,r1704,r1705,r1706,r1707,r1708,r1709,r1710,r1711,r1712,r1713,r1714,r1715,r1716,r1717,r1718,r1719,r1720,r1721,r1722,r1723,r1724,r1725,r1726,r1727,r1728,r1729,r1730,r1731,r1732,r1733,r1734,r1735,r1736,r1737,r1738,r1739,r1740,r1741,r1742,r1743,r1744,r1745,r1746,r1747,r1748,r1749,r1750,r1751,r1752,r1753,r1754,r1755,r1756,r1757,r1758,r1759,r1760,r1761,r1762,r1763,r1764,r1765,r1766,r1767,r1768,r1769,r1770,r1771,r1772,r1773,r1774,r1775,r1776,r1777,r1778,r1779,r1780,r1781,r1782,r1783,r1784,r1785,r1786,r1787,r1788,r1789,r1790,r1791,r1792,r1793,r1794,r1795,r1796,r1797,r1798,r1799,r1800,r1801,r1802,r1803,r1804,r1805,r1806,r1807,r1808,r1809,r1810,r1811,r1812,r1813,r1814,r1815,r1816,r1817,r1818,r1819,r1820,r1821,r1822,r1823,r1824,r1825,r1826,r1827,r1828,r1829,r1830,r1831,r1832,r1833,r1834,r1835,r1836,r1837,r1838,r1839,r1840,r1841,r1842,r1843,r1844,r1845,r1846,r1847,r1848,r1849,r1850,r1851,r1852,r1853,r1854,r1855,r1856,r1857,r1858,r1859,r1860,r1861,r1862,r1863,r1864,r1865,r1866,r1867,r1868,r1869,r1870,r1871,r1872,r1873,r1874,r1875,r1876,r1877,r1878,r1879,r1880,r1881,r1882,r1883,r1884,r1885,r1886,r1887,r1888,r1889,r1890,r1891,r1892,r1893,r1894,r1895,r1896,r1897,r1898,r1899,r1900,r1901,r1902,r1903,r1904,r1905,r1906,r1907,r1908,r1909,r1910,r1911,r1912,r1913,r1914,r1915,r1916,r1917,r1918,r1919,r1920,r1921,r1922,r1923,r1924,r1925,r1926,r1927,r1928,r1929,r1930,r1931,r1932,r1933,r1934,r1935,r1936,r1937,r1938,r1939,r1940,r1941,r1942,r1943,r1944,r1945,r1946,r1947,r1948,r1949,r1950,r1951,r1952,r1953,r1954,r1955,r1956,r1957,r1958,r1959,r1960,r1961,r1962,r1963,r1964,r1965,r1966,r1967,r1968,r1969,r1970,r1971,r1972,r1973,r1974,r1975,r1976,r1977,r1978,r1979,r1980,r1981,r1982,r1983,r1984,r1985,r1986,r1987,r1988,r1989,r1990,r1991,r1992,r1993,r1994,r1995,r1996,r1997,r1998,r1999,r2000,r2001,r2002,r2003,r2004,r2005,r2006,r2007,r2008,r2009,r2010,r2011,r2012,r2013,r2014,r2015,r2016,r2017,r2018,r2019,r2020,r2021,r2022,r2023,r2024,r2025,r2026,r2027,r2028,r2029,r2030,r2031,r2032,r2033,r2034,r2035,r2036,r2037,r2038,r2039,r2040,r2041,r2042,r2043,r2044,r2045,r2046,r2047,r2048,r2049,r2050,r2051,r2052,r2053,r2054,r2055,r2056,r2057,r2058,r2059,r2060,r2061,r2062,r2063,r2064,r2065,r2066,r2067,r2068,r2069,r2070,r2071,r2072,r2073,r2074,r2075,r2076,r2077,r2078,r2079,r2080,r2081,r2082,r2083,r2084,r2085,r2086,r2087,r2088,r2089,r2090,r2091,r2092,r2093,r2094,r2095,r2096,r2097,r2098,r2099,r2100,r2101,r2102,r2103,r2104,r2105,r2106,r2107,r2108,r2109,r2110,r2111,r2112,r2113,r2114,r2115,r2116,r2117,r2118,r2119,r2120,r2121,r2122,r2123,r2124,r2125,r2126,r2127,r2128,r2129,r2130,r2131,r2132,r2133,r2134,r2135,r2136,r2137,r2138,r2139,r2140,r2141,r2142,r2143,r2144,r2145,r2146,r2147,r2148,r2149,r2150,r2151,r2152,r2153,r2154,r2155,r2156,r2157,r2158,r2159,r2160,r2161,r2162,r2163,r2164,r2165,r2166,r2167,r2168,r2169,r2170,r2171,r2172,r2173,r2174,r2175,r2176,r2177,r2178,r2179,r2180,r2181,r2182,r2183,r2184,r2185,r2186,r2187,r2188,r2189,r2190,r2191,r2192,r2193,r2194,r2195,r2196,r2197,r2198,r2199,r2200,r2201,r2202,r2203,r2204,r2205,r2206,r2207,r2208,r2209,r2210,r2211,r2212,r2213,r2214,r2215,r2216,r2217,r2218,r2219,r2220,r2221,r2222,r2223,r2224,r2225,r2226,r2227,r2228,r2229,r2230,r2231,r2232,r2233,r2234,r2235,r2236,r2237,r2238,r2239,r2240,r2241,r2242,r2243,r2244,r2245,r2246,r2247,r2248,r2249,r2250,r2251,r2252,r2253,r2254,r2255,r2256,r2257,r2258,r2259,r2260,r2261,r2262,r2263,r2264,r2265,r2266,r2267,r2268,r2269,r2270,r2271,r2272,r2273,r2274,r2275,r2276,r2277,r2278,r2279,r2280,r2281,r2282,r2283,r2284,r2285,r2286,r2287,r2288,r2289,r2290,r2291,r2292,r2293,r2294,r2295,r2296,r2297,r2298,r2299,r2300,r2301,r2302,r2303,r2304,r2305,r2306,r2307,r2308,r2309,r2310,r2311,r2312,r2313,r2314,r2315,r2316,r2317,r2318,r2319,r2320,r2321,r2322,r2323,r2324,r2325,r2326,r2327,r2328,r2329,r2330,r2331,r2332,r2333,r2334,r2335,r2336,r2337,r2338,r2339,r2340,r2341,r2342,r2343,r2344,r2345,r2346,r2347,r2348,r2349,r2350,r2351,r2352,r2353,r2354,r2355,r2356,r2357,r2358,r2359,r2360,r2361,r2362,r2363,r2364,r2365,r2366,r2367,r2368,r2369,r2370,r2371,r2372,r2373,r2374,r2375,r2376,r2377,r2378,r2379,r2380,r2381,r2382,r2383,r2384,r2385,r2386,r2387,r2388,r2389,r2390,r2391,r2392,r2393,r2394,r2395,r2396,r2397,r2398,r2399,r2400,r2401,r2402,r2403,r2404,r2405,r2406,r2407,r2408,r2409,r2410,r2411,r2412,r2413,r2414,r2415,r2416,r2417,r2418,r2419,r2420,r2421,r2422,r2423,r2424,r2425,r2426,r2427,r2428,r2429,r2430,r2431,r2432,r2433,r2434,r2435,r2436,r2437,r2438,r2439,r2440,r2441,r2442,r2443,r2444,r2445,r2446,r2447,r2448,r2449,r2450,r2451,r2452,r2453,r2454,r2455,r2456,r2457,r2458,r2459,r2460,r2461,r2462,r2463,r2464,r2465,r2466,r2467,r2468,r2469,r2470,r2471,r2472,r2473,r2474,r2475,r2476,r2477,r2478,r2479,r2480,r2481,r2482,r2483,r2484,r2485,r2486,r2487,r2488,r2489,r2490,r2491,r2492,r2493,r2494,r2495,r2496,r2497,r2498,r2499,r2500,r2501,r2502,r2503,r2504,r2505,r2506,r2507,r2508,r2509,r2510,r2511,r2512,r2513,r2514,r2515,r2516,r2517,r2518,r2519,r2520,r2521,r2522,r2523,r2524,r2525,r2526,r2527,r2528,r2529,r2530,r2531,r2532,r2533,r2534,r2535,r2536,r2537,r2538,r2539,r2540,r2541,r2542,r2543,r2544,r2545,r2546,r2547,r2548,r2549,r2550,r2551,r2552,r2553,r2554,r2555,r2556,r2557,r2558,r2559,r2560,r2561,r2562,r2563,r2564,r2565,r2566,r2567,r2568,r2569,r2570,r2571,r2572,r2573,r2574,r2575,r2576,r2577,r2578,r2579,r2580,r2581,r2582,r2583,r2584,r2585,r2586,r2587,r2588,r2589,r2590,r2591,r2592,r2593,r2594,r2595,r2596,r2597,r2598,r2599,r2600,r2601,r2602,r2603,r2604,r2605,r2606,r2607,r2608,r2609,r2610,r2611,r2612,r2613,r2614,r2615,r2616,r2617,r2618,r2619,r2620,r2621,r2622,r2623,r2624,r2625,r2626,r2627,r2628,r2629,r2630,r2631,r2632,r2633,r2634,r2635,r2636,r2637,r2638,r2639,r2640,r2641,r2642,r2643,r2644,r2645,r2646,r2647,r2648,r2649,r2650,r2651,r2652,r2653,r2654,r2655,r2656,r2657,r2658,r2659,r2660,r2661,r2662,r2663,r2664,r2665,r2666,r2667,r2668,r2669,r2670,r2671,r2672,r2673,r2674,r2675,r2676,r2677,r2678,r2679,r2680,r2681,r2682,r2683,r2684,r2685,r2686,r2687,r2688,r2689,r2690,r2691,r2692,r2693,r2694,r2695,r2696,r2697,r2698,r2699,r2700,r2701,r2702,r2703,r2704,r2705,r2706,r2707,r2708,r2709,r2710,r2711,r2712,r2713,r2714,r2715,r2716,r2717,r2718,r2719,r2720,r2721,r2722,r2723,r2724,r2725,r2726,r2727,r2728,r2729,r2730,r2731,r2732,r2733,r2734,r2735,r2736,r2737,r2738,r2739,r2740,r2741,r2742,r2743,r2744,r2745,r2746,r2747,r2748,r2749,r2750,r2751,r2752,r2753,r2754,r2755,r2756,r2757,r2758,r2759,r2760,r2761,r2762,r2763,r2764,r2765,r2766,r2767,r2768,r2769,r2770,r2771,r2772,r2773,r2774,r2775,r2776,r2777,r2778,r2779,r2780,r2781,r2782,r2783,r2784,r2785,r2786,r2787,r2788,r2789,r2790,r2791,r2792,r2793,r2794,r2795,r2796,r2797,r2798,r2799,r2800,r2801,r2802,r2803,r2804,r2805,r2806,r2807,r2808,r2809,r2810,r2811,r2812,r2813,r2814,r2815,r2816,r2817,r2818,r2819,r2820,r2821,r2822,r2823,r2824,r2825,r2826,r2827,r2828,r2829,r2830,r2831,r2832,r2833,r2834,r2835,r2836,r2837,r2838,r2839,r2840,r2841,r2842,r2843,r2844,r2845,r2846,r2847,r2848,r2849,r2850,r2851,r2852,r2853,r2854,r2855,r2856,r2857,r2858,r2859,r2860,r2861,r2862,r2863,r2864,r2865,r2866,r2867,r2868,r2869,r2870,r2871,r2872,r2873,r2874,r2875,r2876,r2877,r2878,r2879,r2880,r2881,r2882,r2883,r2884,r2885,r2886,r2887,r2888,r2889,r2890,r2891,r2892,r2893,r2894,r2895,r2896,r2897,r2898,r2899,r2900,r2901,r2902,r2903,r2904,r2905,r2906,r2907,r2908,r2909,r2910,r2911,r2912,r2913,r2914,r2915,r2916,r2917,r2918,r2919,r2920,r2921,r2922,r2923,r2924,r2925,r2926,r2927,r2928,r2929,r2930,r2931,r2932,r2933,r2934,r2935,r2936,r2937,r2938,r2939,r2940,r2941,r2942,r2943,r2944,r2945,r2946,r2947,r2948,r2949,r2950,r2951,r2952,r2953,r2954,r2955,r2956,r2957,r2958,r2959,r2960,r2961,r2962,r2963,r2964,r2965,r2966,r2967,r2968,r2969,r2970,r2971,r2972,r2973,r2974,r2975,r2976,r2977,r2978,r2979,r2980,r2981,r2982,r2983,r2984,r2985,r2986,r2987,r2988,r2989,r2990,r2991,r2992,r2993,r2994,r2995,r2996,r2997,r2998,r2999,r3000,r3001,r3002,r3003,r3004,r3005,r3006,r3007,r3008,r3009,r3010,r3011,r3012,r3013,r3014,r3015,r3016,r3017,r3018,r3019,r3020,r3021,r3022,r3023,r3024,r3025,r3026,r3027,r3028,r3029,r3030,r3031,r3032,r3033,r3034,r3035,r3036,r3037,r3038,r3039,r3040,r3041,r3042,r3043,r3044,r3045,r3046,r3047,r3048,r3049,r3050,r3051,r3052,r3053,r3054,r3055,r3056,r3057,r3058,r3059,r3060,r3061,r3062,r3063,r3064,r3065,r3066,r3067,r3068,r3069,r3070,r3071,r3072,r3073,r3074,r3075,r3076,r3077,r3078,r3079,r3080,r3081,r3082,r3083,r3084,r3085,r3086,r3087,r3088,r3089,r3090,r3091,r3092,r3093,r3094,r3095,r3096,r3097,r3098,r3099,r3100,r3101,r3102,r3103,r3104,r3105,r3106,r3107,r3108,r3109,r3110,r3111,r3112,r3113,r3114,r3115,r3116,r3117,r3118,r3119,r3120,r3121,r3122,r3123,r3124,r3125,r3126,r3127,r3128,r3129,r3130,r3131,r3132,r3133,r3134,r3135,r3136,r3137,r3138,r3139,r3140,r3141,r3142,r3143,r3144,r3145,r3146,r3147,r3148,r3149,r3150,r3151,r3152,r3153,r3154,r3155,r3156,r3157,r3158,r3159,r3160,r3161,r3162,r3163,r3164,r3165,r3166,r3167,r3168,r3169,r3170,r3171,r3172,r3173,r3174,r3175,r3176,r3177,r3178,r3179,r3180,r3181,r3182,r3183,r3184,r3185,r3186,r3187,r3188,r3189,r3190,r3191,r3192,r3193,r3194,r3195,r3196,r3197,r3198,r3199,r3200,r3201,r3202,r3203,r3204,r3205,r3206,r3207,r3208,r3209,r3210,r3211,r3212,r3213,r3214,r3215,r3216,r3217,r3218,r3219,r3220,r3221,r3222,r3223,r3224,r3225,r3226,r3227,r3228,r3229,r3230,r3231,r3232,r3233,r3234,r3235,r3236,r3237,r3238,r3239,r3240,r3241,r3242,r3243,r3244,r3245,r3246,r3247,r3248,r3249,r3250,r3251,r3252,r3253,r3254,r3255,r3256,r3257,r3258,r3259,r3260,r3261,r3262,r3263,r3264,r3265,r3266,r3267,r3268,r3269,r3270,r3271,r3272,r3273,r3274,r3275,r3276,r3277,r3278,r3279,r3280,r3281,r3282,r3283,r3284,r3285,r3286,r3287,r3288,r3289,r3290,r3291,r3292,r3293,r3294,r3295,r3296,r3297,r3298,r3299,r3300,r3301,r3302,r3303,r3304,r3305,r3306,r3307,r3308,r3309,r3310,r3311,r3312,r3313,r3314,r3315,r3316,r3317,r3318,r3319,r3320,r3321,r3322,r3323,r3324,r3325,r3326,r3327,r3328,r3329,r3330,r3331,r3332,r3333,r3334,r3335,r3336,r3337,r3338,r3339,r3340,r3341,r3342,r3343,r3344,r3345,r3346,r3347,r3348,r3349,r3350,r3351,r3352,r3353,r3354,r3355,r3356,r3357,r3358,r3359,r3360,r3361,r3362,r3363,r3364,r3365,r3366,r3367,r3368,r3369,r3370,r3371,r3372,r3373,r3374,r3375,r3376,r3377,r3378,r3379,r3380,r3381,r3382,r3383,r3384,r3385,r3386,r3387,r3388,r3389,r3390,r3391,r3392,r3393,r3394,r3395,r3396,r3397,r3398,r3399,r3400,r3401,r3402,r3403,r3404,r3405,r3406,r3407,r3408,r3409,r3410,r3411,r3412,r3413,r3414,r3415,r3416,r3417,r3418,r3419,r3420,r3421,r3422,r3423,r3424,r3425,r3426,r3427,r3428,r3429,r3430,r3431,r3432,r3433,r3434,r3435,r3436,r3437,r3438,r3439,r3440,r3441,r3442,r3443,r3444,r3445,r3446,r3447,r3448,r3449,r3450,r3451,r3452,r3453,r3454,r3455,r3456,r3457,r3458,r3459,r3460,r3461,r3462,r3463,r3464,r3465,r3466,r3467,r3468,r3469,r3470,r3471,r3472,r3473,r3474,r3475,r3476,r3477,r3478,r3479,r3480,r3481,r3482,r3483,r3484,r3485,r3486,r3487,r3488,r3489,r3490,r3491,r3492,r3493,r3494,r3495,r3496,r3497,r3498,r3499,r3500,r3501,r3502,r3503,r3504,r3505,r3506,r3507,r3508,r3509,r3510,r3511,r3512,r3513,r3514,r3515,r3516,r3517,r3518,r3519,r3520,r3521,r3522,r3523,r3524,r3525,r3526,r3527,r3528,r3529,r3530,r3531,r3532,r3533,r3534,r3535,r3536,r3537,r3538,r3539,r3540,r3541,r3542,r3543,r3544,r3545,r3546,r3547,r3548,r3549,r3550,r3551,r3552,r3553,r3554,r3555,r3556,r3557,r3558,r3559,r3560,r3561,r3562,r3563,r3564,r3565,r3566,r3567,r3568,r3569,r3570,r3571,r3572,r3573,r3574,r3575,r3576,r3577,r3578,r3579,r3580,r3581,r3582,r3583,r3584,r3585,r3586,r3587,r3588,r3589,r3590,r3591,r3592,r3593,r3594,r3595,r3596,r3597,r3598,r3599,r3600,r3601,r3602,r3603,r3604,r3605,r3606,r3607,r3608,r3609,r3610,r3611,r3612,r3613,r3614,r3615,r3616,r3617,r3618,r3619,r3620,r3621,r3622,r3623,r3624,r3625,r3626,r3627,r3628,r3629,r3630,r3631,r3632,r3633,r3634,r3635,r3636,r3637,r3638,r3639,r3640,r3641,r3642,r3643,r3644,r3645,r3646,r3647,r3648,r3649,r3650,r3651,r3652,r3653,r3654,r3655,r3656,r3657,r3658,r3659,r3660,r3661,r3662,r3663,r3664,r3665,r3666,r3667,r3668,r3669,r3670,r3671,r3672,r3673,r3674,r3675,r3676,r3677,r3678,r3679,r3680,r3681,r3682,r3683,r3684,r3685,r3686,r3687,r3688,r3689,r3690,r3691,r3692,r3693,r3694,r3695,r3696,r3697,r3698,r3699,r3700,r3701,r3702,r3703,r3704,r3705,r3706,r3707,r3708,r3709,r3710,r3711,r3712,r3713,r3714,r3715,r3716,r3717,r3718,r3719,r3720,r3721,r3722,r3723,r3724,r3725,r3726,r3727,r3728,r3729,r3730,r3731,r3732,r3733,r3734,r3735,r3736,r3737,r3738,r3739,r3740,r3741,r3742,r3743,r3744,r3745,r3746,r3747,r3748,r3749,r3750,r3751,r3752,r3753,r3754,r3755,r3756,r3757,r3758,r3759,r3760,r3761,r3762,r3763,r3764,r3765,r3766,r3767,r3768,r3769,r3770,r3771,r3772,r3773,r3774,r3775,r3776,r3777,r3778,r3779,r3780,r3781,r3782,r3783,r3784,r3785,r3786,r3787,r3788,r3789,r3790,r3791,r3792,r3793,r3794,r3795,r3796,r3797,r3798,r3799,r3800,r3801,r3802,r3803,r3804,r3805,r3806,r3807,r3808,r3809,r3810,r3811,r3812,r3813,r3814,r3815,r3816,r3817,r3818,r3819,r3820,r3821,r3822,r3823,r3824,r3825,r3826,r3827,r3828,r3829,r3830,r3831,r3832,r3833,r3834,r3835,r3836,r3837,r3838,r3839,r3840,r3841,r3842,r3843,r3844,r3845,r3846,r3847,r3848,r3849,r3850,r3851,r3852,r3853,r3854,r3855,r3856,r3857,r3858,r3859,r3860,r3861,r3862,r3863,r3864,r3865,r3866,r3867,r3868,r3869,r3870,r3871,r3872,r3873,r3874,r3875,r3876,r3877,r3878,r3879,r3880,r3881,r3882,r3883,r3884,r3885,r3886,r3887,r3888,r3889,r3890,r3891,r3892,r3893,r3894,r3895,r3896,r3897,r3898,r3899,r3900,r3901,r3902,r3903,r3904,r3905,r3906,r3907,r3908,r3909,r3910,r3911,r3912,r3913,r3914,r3915,r3916,r3917,r3918,r3919,r3920,r3921,r3922,r3923,r3924,r3925,r3926,r3927,r3928,r3929,r3930,r3931,r3932,r3933,r3934,r3935,r3936,r3937,r3938,r3939,r3940,r3941,r3942,r3943,r3944,r3945,r3946,r3947,r3948,r3949,r3950,r3951,r3952,r3953,r3954,r3955,r3956,r3957,r3958,r3959,r3960,r3961,r3962,r3963,r3964,r3965,r3966,r3967,r3968,r3969,r3970,r3971,r3972,r3973,r3974,r3975,r3976,r3977,r3978,r3979,r3980,r3981,r3982,r3983,r3984,r3985,r3986,r3987,r3988,r3989,r3990,r3991,r3992,r3993,r3994,r3995,r3996,r3997,r3998,r3999,r4000,r4001,r4002,r4003,r4004,r4005,r4006,r4007,r4008,r4009,r4010,r4011,r4012,r4013,r4014,r4015,r4016,r4017,r4018,r4019,r4020,r4021,r4022,r4023,r4024,r4025,r4026,r4027,r4028,r4029,r4030,r4031,r4032,r4033,r4034,r4035,r4036,r4037,r4038,r4039,r4040,r4041,r4042,r4043,r4044,r4045,r4046,r4047,r4048,r4049,r4050,r4051,r4052,r4053,r4054,r4055,r4056,r4057,r4058,r4059,r4060,r4061,r4062,r4063,r4064,r4065,r4066,r4067,r4068,r4069,r4070,r4071,r4072,r4073,r4074,r4075,r4076,r4077,r4078,r4079,r4080,r4081,r4082,r4083,r4084,r4085,r4086,r4087,r4088,r4089,r4090,r4091,r4092,r4093,r4094,r4095,r4096,r4097,r4098,r4099,r4100,r4101,r4102,r4103,r4104,r4105,r4106,r4107,r4108,r4109,r4110,r4111,r4112,r4113,r4114,r4115,r4116,r4117,r4118,r4119,r4120,r4121,r4122,r4123,r4124,r4125,r4126,r4127,r4128,r4129,r4130,r4131,r4132,r4133,r4134,r4135,r4136,r4137,r4138,r4139,r4140,r4141,r4142,r4143,r4144,r4145,r4146,r4147,r4148,r4149,r4150,r4151,r4152,r4153,r4154,r4155,r4156,r4157,r4158,r4159,r4160,r4161,r4162,r4163,r4164,r4165,r4166,r4167,r4168,r4169,r4170,r4171,r4172,r4173,r4174,r4175,r4176,r4177,r4178,r4179,r4180,r4181,r4182,r4183,r4184,r4185,r4186,r4187,r4188,r4189,r4190,r4191,r4192,r4193,r4194,r4195,r4196,r4197,r4198,r4199,r4200,r4201,r4202,r4203,r4204,r4205,r4206,r4207,r4208,r4209,r4210,r4211,r4212,r4213,r4214,r4215,r4216,r4217,r4218,r4219,r4220,r4221,r4222,r4223,r4224,r4225,r4226,r4227,r4228,r4229,r4230,r4231,r4232,r4233,r4234,r4235,r4236,r4237,r4238,r4239,r4240,r4241,r4242,r4243,r4244,r4245,r4246,r4247,r4248,r4249,r4250,r4251,r4252,r4253,r4254,r4255,r4256,r4257,r4258,r4259,r4260,r4261,r4262,r4263,r4264,r4265,r4266,r4267,r4268,r4269,r4270,r4271,r4272,r4273,r4274,r4275,r4276,r4277,r4278,r4279,r4280,r4281,r4282,r4283,r4284,r4285,r4286,r4287,r4288,r4289,r4290,r4291,r4292,r4293,r4294,r4295,r4296,r4297,r4298,r4299,r4300,r4301,r4302,r4303,r4304,r4305,r4306,r4307,r4308,r4309,r4310,r4311,r4312,r4313,r4314,r4315,r4316,r4317,r4318,r4319,r4320,r4321,r4322,r4323,r4324,r4325,r4326,r4327,r4328,r4329,r4330,r4331,r4332,r4333,r4334,r4335,r4336,r4337,r4338,r4339,r4340,r4341,r4342,r4343,r4344,r4345,r4346,r4347,r4348,r4349,r4350,r4351,r4352,r4353,r4354,r4355,r4356,r4357,r4358,r4359,r4360,r4361,r4362,r4363,r4364,r4365,r4366,r4367,r4368,r4369,r4370,r4371,r4372,r4373,r4374,r4375,r4376,r4377,r4378,r4379,r4380,r4381,r4382,r4383,r4384,r4385,r4386,r4387,r4388,r4389,r4390,r4391,r4392,r4393,r4394,r4395,r4396,r4397,r4398,r4399,r4400,r4401,r4402,r4403,r4404,r4405,r4406,r4407,r4408,r4409,r4410,r4411,r4412,r4413,r4414,r4415,r4416,r4417,r4418,r4419,r4420,r4421,r4422,r4423,r4424,r4425,r4426,r4427,r4428,r4429,r4430,r4431,r4432,r4433,r4434,r4435,r4436,r4437,r4438,r4439,r4440,r4441,r4442,r4443,r4444,r4445,r4446,r4447,r4448,r4449,r4450,r4451,r4452,r4453,r4454,r4455,r4456,r4457,r4458,r4459,r4460,r4461,r4462,r4463,r4464,r4465,r4466,r4467,r4468,r4469,r4470,r4471,r4472,r4473,r4474,r4475,r4476,r4477,r4478,r4479,r4480,r4481,r4482,r4483,r4484,r4485,r4486,r4487,r4488,r4489,r4490,r4491,r4492,r4493,r4494,r4495,r4496,r4497,r4498,r4499,r4500,r4501,r4502,r4503,r4504,r4505,r4506,r4507,r4508,r4509,r4510,r4511,r4512,r4513,r4514,r4515,r4516,r4517,r4518,r4519,r4520,r4521,r4522,r4523,r4524,r4525,r4526,r4527,r4528,r4529,r4530,r4531,r4532,r4533,r4534,r4535,r4536,r4537,r4538,r4539,r4540,r4541,r4542,r4543,r4544,r4545,r4546,r4547,r4548,r4549,r4550,r4551,r4552,r4553,r4554,r4555,r4556,r4557,r4558,r4559,r4560,r4561,r4562,r4563,r4564,r4565,r4566,r4567,r4568,r4569,r4570,r4571,r4572,r4573,r4574,r4575,r4576,r4577,r4578,r4579,r4580,r4581,r4582,r4583,r4584,r4585,r4586,r4587,r4588,r4589,r4590,r4591,r4592,r4593,r4594,r4595,r4596,r4597,r4598,r4599,r4600,r4601,r4602,r4603,r4604,r4605,r4606,r4607,r4608,r4609,r4610,r4611,r4612,r4613,r4614,r4615,r4616,r4617,r4618,r4619,r4620,r4621,r4622,r4623,r4624,r4625,r4626,r4627,r4628,r4629,r4630,r4631,r4632,r4633,r4634,r4635,r4636,r4637,r4638,r4639,r4640,r4641,r4642,r4643,r4644,r4645,r4646,r4647,r4648,r4649,r4650,r4651,r4652,r4653,r4654,r4655,r4656,r4657,r4658,r4659,r4660,r4661,r4662,r4663,r4664,r4665,r4666,r4667,r4668,r4669,r4670,r4671,r4672,r4673,r4674,r4675,r4676,r4677,r4678,r4679,r4680,r4681,r4682,r4683,r4684,r4685,r4686,r4687,r4688,r4689,r4690,r4691,r4692,r4693,r4694,r4695,r4696,r4697,r4698,r4699,r4700,r4701,r4702,r4703,r4704,r4705,r4706,r4707,r4708,r4709,r4710,r4711,r4712,r4713,r4714,r4715,r4716,r4717,r4718,r4719,r4720,r4721,r4722,r4723,r4724,r4725,r4726,r4727,r4728,r4729,r4730,r4731,r4732,r4733,r4734,r4735,r4736,r4737,r4738,r4739,r4740,r4741,r4742,r4743,r4744,r4745,r4746,r4747,r4748,r4749,r4750,r4751,r4752,r4753,r4754,r4755,r4756,r4757,r4758,r4759,r4760,r4761,r4762,r4763,r4764,r4765,r4766,r4767,r4768,r4769,r4770,r4771,r4772,r4773,r4774,r4775,r4776,r4777,r4778,r4779,r4780,r4781,r4782,r4783,r4784,r4785,r4786,r4787,r4788,r4789,r4790,r4791,r4792,r4793,r4794,r4795,r4796,r4797,r4798,r4799,r4800,r4801,r4802,r4803,r4804,r4805,r4806,r4807,r4808,r4809,r4810,r4811,r4812,r4813,r4814,r4815,r4816,r4817,r4818,r4819,r4820,r4821,r4822,r4823,r4824,r4825,r4826,r4827,r4828,r4829,r4830,r4831,r4832,r4833,r4834,r4835,r4836,r4837,r4838,r4839,r4840,r4841,r4842,r4843,r4844,r4845,r4846,r4847,r4848,r4849,r4850,r4851,r4852,r4853,r4854,r4855,r4856,r4857,r4858,r4859,r4860,r4861,r4862,r4863,r4864,r4865,r4866,r4867,r4868,r4869,r4870,r4871,r4872,r4873,r4874,r4875,r4876,r4877,r4878,r4879,r4880,r4881,r4882,r4883,r4884,r4885,r4886,r4887,r4888,r4889,r4890,r4891,r4892,r4893,r4894,r4895,r4896,r4897,r4898,r4899,r4900,r4901,r4902,r4903,r4904,r4905,r4906,r4907,r4908,r4909,r4910,r4911,r4912,r4913,r4914,r4915,r4916,r4917,r4918,r4919,r4920,r4921,r4922,r4923,r4924,r4925,r4926,r4927,r4928,r4929,r4930,r4931,r4932,r4933,r4934,r4935,r4936,r4937,r4938,r4939,r4940,r4941,r4942,r4943,r4944,r4945,r4946,r4947,r4948,r4949,r4950,r4951,r4952,r4953,r4954,r4955,r4956,r4957,r4958,r4959,r4960,r4961,r4962,r4963,r4964,r4965,r4966,r4967,r4968,r4969,r4970,r4971,r4972,r4973,r4974,r4975,r4976,r4977,r4978,r4979,r4980,r4981,r4982,r4983,r4984,r4985,r4986,r4987,r4988,r4989,r4990,r4991,r4992,r4993,r4994,r4995,r4996,r4997,r4998,r4999,r5000,r5001,r5002,r5003,r5004,r5005,r5006,r5007,r5008,r5009,r5010,r5011,r5012,r5013,r5014,r5015,r5016,r5017,r5018,r5019,r5020,r5021,r5022,r5023,r5024,r5025,r5026,r5027,r5028,r5029,r5030,r5031,r5032,r5033,r5034,r5035,r5036,r5037,r5038,r5039,r5040,r5041,r5042,r5043,r5044,r5045,r5046,r5047,r5048,r5049,r5050,r5051,r5052,r5053,r5054,r5055,r5056,r5057,r5058,r5059,r5060,r5061,r5062,r5063,r5064,r5065,r5066,r5067,r5068,r5069,r5070,r5071,r5072,r5073,r5074,r5075,r5076,r5077,r5078,r5079,r5080,r5081,r5082,r5083,r5084,r5085,r5086,r5087,r5088,r5089,r5090,r5091,r5092,r5093,r5094,r5095,r5096,r5097,r5098,r5099,r5100,r5101,r5102,r5103,r5104,r5105,r5106,r5107,r5108,r5109,r5110,r5111,r5112,r5113,r5114,r5115,r5116,r5117,r5118,r5119,r5120,r5121,r5122,r5123,r5124,r5125,r5126,r5127,r5128,r5129,r5130,r5131,r5132,r5133,r5134,r5135,r5136,r5137,r5138,r5139,r5140,r5141,r5142,r5143,r5144,r5145,r5146,r5147,r5148,r5149,r5150,r5151,r5152,r5153,r5154,r5155,r5156,r5157,r5158,r5159,r5160,r5161,r5162,r5163,r5164,r5165,r5166,r5167,r5168,r5169,r5170,r5171,r5172,r5173,r5174,r5175,r5176,r5177,r5178,r5179,r5180,r5181,r5182,r5183,r5184,r5185,r5186,r5187,r5188,r5189,r5190,r5191,r5192,r5193,r5194,r5195,r5196,r5197,r5198,r5199,r5200,r5201,r5202,r5203,r5204,r5205,r5206,r5207,r5208,r5209,r5210,r5211,r5212,r5213,r5214,r5215,r5216,r5217,r5218,r5219,r5220,r5221,r5222,r5223,r5224,r5225,r5226,r5227,r5228,r5229,r5230,r5231,r5232,r5233,r5234,r5235,r5236,r5237,r5238,r5239,r5240,r5241,r5242,r5243,r5244,r5245,r5246,r5247,r5248,r5249,r5250,r5251,r5252,r5253,r5254,r5255,r5256,r5257,r5258,r5259,r5260,r5261,r5262,r5263,r5264,r5265,r5266,r5267,r5268,r5269,r5270,r5271,r5272,r5273,r5274,r5275,r5276,r5277,r5278,r5279,r5280,r5281,r5282,r5283,r5284,r5285,r5286,r5287,r5288,r5289,r5290,r5291,r5292,r5293,r5294,r5295,r5296,r5297,r5298,r5299,r5300,r5301,r5302,r5303,r5304,r5305,r5306,r5307,r5308,r5309,r5310,r5311,r5312,r5313,r5314,r5315,r5316,r5317,r5318,r5319,r5320,r5321,r5322,r5323,r5324,r5325,r5326,r5327,r5328,r5329,r5330,r5331,r5332,r5333,r5334,r5335,r5336,r5337,r5338,r5339,r5340,r5341,r5342,r5343,r5344,r5345,r5346,r5347,r5348,r5349,r5350,r5351,r5352,r5353,r5354,r5355,r5356,r5357,r5358,r5359,r5360,r5361,r5362,r5363,r5364,r5365,r5366;r3=0;r4=STACKTOP;STACKTOP=STACKTOP+248|0;r5=r4;r6=r4+8;r7=r4+16;r8=r4+24;r9=r4+32;r10=r4+40;r11=r4+48;r12=r4+56;r13=r4+64;r14=r4+72;r15=r4+80;r16=r4+88;r17=r4+96;r18=r4+104;r19=r4+112;r20=r4+120;r21=r4+128;r22=r4+136;r23=r4+144;r24=r4+152;r25=r4+160;r26=r4+168;r27=r4+176;r28=r4+184;r29=r4+192;r30=r4+200;r31=r4+208;r32=r4+216;r33=r4+224;r34=r4+232;r35=r4+240;r36=r1+20|0;r37=HEAP32[r36>>2];r38=(r37|0)>0;if(!r38){r39=1;STACKTOP=r4;return r39}r40=r1+4|0;r41=r1+24|0;r42=r1+8|0;r43=r1+12|0;r44=r1+16|0;r45=r35;r46=r34;r47=r33;r48=r32;r49=r31;r50=r30;r51=r29;r52=r28;r53=r27;r54=r26;r55=r25;r56=r24;r57=r23;r58=r22;r59=r21;r60=r20;r61=r19;r62=r18;r63=r17;r64=r16;r65=r15;r66=r14;r67=r13;r68=r12;r69=r11;r70=r10;r71=r9;r72=r8;r73=r7;r74=r6;r75=r5;r76=r2;r77=0;L4:while(1){r78=HEAP32[r40>>2];r79=(r78|0)==0;r80=r79?32:r78;L6:do{switch(r80|0){case 2:{r81=HEAP32[r41>>2];r82=HEAP32[r42>>2];r83=HEAP32[r43>>2];r84=HEAP32[r44>>2];r85=4;r86=0;r87=__Znwj(48);r88=r87;__ZN9RCqsmodelC2Ebjjj(r88,0,7,16,1024);r89=r87;HEAP32[r35>>2]=r89;r90=__Znwj(12);r91=r90+4|0;r92=r91;HEAP32[r92>>2]=r81;r93=r90+8|0;r94=r93;HEAP32[r94>>2]=r35;r95=r82+1|0;r96=r83+1|0;r97=Math_imul(r96,r95)|0;r98=r97+r95|0;r99=r98;while(1){r100=r99+1|0;r101=r100&r99;r102=(r101|0)==0;r103=r100|r99;if(r102){break}else{r99=r103}}r104=_llvm_umul_with_overflow_i32(r100,4);r105=tempRet0;r106=r105;r107=r104;r108=r106?-1:r107;r109=__Znwj(r108);r110=r109;r111=r97;r112=0;while(1){r113=r112+1|0;r114=r112&r99;r115=r110+(r114<<2)|0;HEAPF32[r115>>2]=0;r116=r111-1|0;r117=(r116|0)==0;if(r117){break}else{r111=r116;r112=r113}}r118=(r84|0)==0;if(!r118){r119=(r83|0)==0;r120=(r82|0)==0;r121=r95+r83|0;r122=r97;r123=0;r124=r76;while(1){r125=r95;r126=r122;while(1){r127=r126+1|0;r128=r126&r99;r129=r110+(r128<<2)|0;HEAPF32[r129>>2]=0;r130=r125-1|0;r131=(r130|0)==0;if(r131){break}else{r125=r130;r126=r127}}r132=r122+r95|0;do{if(r119){r133=r132;r134=r124}else{if(r120){r135=r132;r136=0;while(1){r137=r135&r99;r138=r110+(r137<<2)|0;HEAPF32[r138>>2]=0;r139=r135+1|0;r140=r136+1|0;r141=r140>>>0<r83>>>0;if(r141){r135=r139;r136=r140}else{break}}r142=r121+r122|0;r133=r142;r134=r124;break}else{r143=r132;r144=0;r145=r124}while(1){r146=r143&r99;r147=r110+(r146<<2)|0;HEAPF32[r147>>2]=0;r148=r143+1|0;r149=r148;r150=0;r151=r145;while(1){r152=r149-1|0;r153=r152&r99;r154=r110+(r153<<2)|0;r155=HEAPF32[r154>>2];r156=r149-r95|0;r157=r156-r97|0;r158=r157&r99;r159=r110+(r158<<2)|0;r160=HEAPF32[r159>>2];r161=r155-r160;r162=r156&r99;r163=r110+(r162<<2)|0;r164=HEAPF32[r163>>2];r165=r161+r164;r166=r152-r97|0;r167=r166&r99;r168=r110+(r167<<2)|0;r169=HEAPF32[r168>>2];r170=r165-r169;r171=r149-r97|0;r172=r171&r99;r173=r110+(r172<<2)|0;r174=HEAPF32[r173>>2];r175=r170+r174;r176=r152-r95|0;r177=r176&r99;r178=r110+(r177<<2)|0;r179=HEAPF32[r178>>2];r180=r175-r179;r181=r176-r97|0;r182=r181&r99;r183=r110+(r182<<2)|0;r184=HEAPF32[r183>>2];r185=r180+r184;r186=(HEAPF32[tempDoublePtr>>2]=r185,HEAP32[tempDoublePtr>>2]);r187=r186>>>30;r188=r187^3;r189=HEAP32[r92>>2];r190=HEAP32[r94>>2];r191=HEAP32[r190>>2];r192=__ZN9RCdecoder6decodeEP7RCmodel(r189,r191);r193=r188>>>1;r194=-r193|0;r195=r194>>>31;r196=r195^r188;r197=r192-3|0;r198=r197+r196|0;r199=r198>>>1;r200=-r199|0;r201=r200>>>31;r202=r201^r198;r203=r202<<30;r204=r203^-1073741824;r205=(HEAP32[tempDoublePtr>>2]=r204,HEAPF32[tempDoublePtr>>2]);HEAPF32[r151>>2]=r205;r206=r149&r99;r207=r110+(r206<<2)|0;HEAPF32[r207>>2]=r205;r208=r151+4|0;r209=r149+1|0;r210=r150+1|0;r211=r210>>>0<r82>>>0;if(r211){r149=r209;r150=r210;r151=r208}else{break}}r212=r144+1|0;r213=r212>>>0<r83>>>0;if(r213){r143=r209;r144=r212;r145=r208}else{r133=r209;r134=r208;break}}}}while(0);r214=r123+1|0;r215=r214>>>0<r84>>>0;if(r215){r122=r133;r123=r214;r124=r134}else{break}}}r216=(r90|0)==0;if(!r216){_free(r90)}r217=HEAP32[r35>>2];r218=(r217|0)==0;if(!r218){r219=r217;r220=HEAP32[r219>>2];r221=r220+4|0;r222=HEAP32[r221>>2];FUNCTION_TABLE[r222](r217)}r223=(r109|0)==0;if(r223){break L6}_free(r109);break};case 3:{r224=HEAP32[r41>>2];r225=HEAP32[r42>>2];r226=HEAP32[r43>>2];r227=HEAP32[r44>>2];r228=4;r229=0;r230=__Znwj(48);r231=r230;__ZN9RCqsmodelC2Ebjjj(r231,0,15,16,1024);r232=r230;HEAP32[r34>>2]=r232;r233=__Znwj(12);r234=r233+4|0;r235=r234;HEAP32[r235>>2]=r224;r236=r233+8|0;r237=r236;HEAP32[r237>>2]=r34;r238=r225+1|0;r239=r226+1|0;r240=Math_imul(r239,r238)|0;r241=r240+r238|0;r242=r241;while(1){r243=r242+1|0;r244=r243&r242;r245=(r244|0)==0;r246=r243|r242;if(r245){break}else{r242=r246}}r247=_llvm_umul_with_overflow_i32(r243,4);r248=tempRet0;r249=r248;r250=r247;r251=r249?-1:r250;r252=__Znwj(r251);r253=r252;r254=r240;r255=0;while(1){r256=r255+1|0;r257=r255&r242;r258=r253+(r257<<2)|0;HEAPF32[r258>>2]=0;r259=r254-1|0;r260=(r259|0)==0;if(r260){break}else{r254=r259;r255=r256}}r261=(r227|0)==0;if(!r261){r262=(r226|0)==0;r263=(r225|0)==0;r264=r238+r226|0;r265=r240;r266=0;r267=r76;while(1){r268=r238;r269=r265;while(1){r270=r269+1|0;r271=r269&r242;r272=r253+(r271<<2)|0;HEAPF32[r272>>2]=0;r273=r268-1|0;r274=(r273|0)==0;if(r274){break}else{r268=r273;r269=r270}}r275=r265+r238|0;do{if(r262){r276=r275;r277=r267}else{if(r263){r278=r275;r279=0;while(1){r280=r278&r242;r281=r253+(r280<<2)|0;HEAPF32[r281>>2]=0;r282=r278+1|0;r283=r279+1|0;r284=r283>>>0<r226>>>0;if(r284){r278=r282;r279=r283}else{break}}r285=r264+r265|0;r276=r285;r277=r267;break}else{r286=r275;r287=0;r288=r267}while(1){r289=r286&r242;r290=r253+(r289<<2)|0;HEAPF32[r290>>2]=0;r291=r286+1|0;r292=r291;r293=0;r294=r288;while(1){r295=r292-1|0;r296=r295&r242;r297=r253+(r296<<2)|0;r298=HEAPF32[r297>>2];r299=r292-r238|0;r300=r299-r240|0;r301=r300&r242;r302=r253+(r301<<2)|0;r303=HEAPF32[r302>>2];r304=r298-r303;r305=r299&r242;r306=r253+(r305<<2)|0;r307=HEAPF32[r306>>2];r308=r304+r307;r309=r295-r240|0;r310=r309&r242;r311=r253+(r310<<2)|0;r312=HEAPF32[r311>>2];r313=r308-r312;r314=r292-r240|0;r315=r314&r242;r316=r253+(r315<<2)|0;r317=HEAPF32[r316>>2];r318=r313+r317;r319=r295-r238|0;r320=r319&r242;r321=r253+(r320<<2)|0;r322=HEAPF32[r321>>2];r323=r318-r322;r324=r319-r240|0;r325=r324&r242;r326=r253+(r325<<2)|0;r327=HEAPF32[r326>>2];r328=r323+r327;r329=(HEAPF32[tempDoublePtr>>2]=r328,HEAP32[tempDoublePtr>>2]);r330=r329>>>29;r331=r330^7;r332=HEAP32[r235>>2];r333=HEAP32[r237>>2];r334=HEAP32[r333>>2];r335=__ZN9RCdecoder6decodeEP7RCmodel(r332,r334);r336=r331>>>2;r337=-r336|0;r338=r337>>>30;r339=r338^r331;r340=r335-7|0;r341=r340+r339|0;r342=r341>>>2;r343=-r342|0;r344=r343>>>30;r345=r344^r341;r346=r345<<29;r347=r346^-536870912;r348=(HEAP32[tempDoublePtr>>2]=r347,HEAPF32[tempDoublePtr>>2]);HEAPF32[r294>>2]=r348;r349=r292&r242;r350=r253+(r349<<2)|0;HEAPF32[r350>>2]=r348;r351=r294+4|0;r352=r292+1|0;r353=r293+1|0;r354=r353>>>0<r225>>>0;if(r354){r292=r352;r293=r353;r294=r351}else{break}}r355=r287+1|0;r356=r355>>>0<r226>>>0;if(r356){r286=r352;r287=r355;r288=r351}else{r276=r352;r277=r351;break}}}}while(0);r357=r266+1|0;r358=r357>>>0<r227>>>0;if(r358){r265=r276;r266=r357;r267=r277}else{break}}}r359=(r233|0)==0;if(!r359){_free(r233)}r360=HEAP32[r34>>2];r361=(r360|0)==0;if(!r361){r362=r360;r363=HEAP32[r362>>2];r364=r363+4|0;r365=HEAP32[r364>>2];FUNCTION_TABLE[r365](r360)}r366=(r252|0)==0;if(r366){break L6}_free(r252);break};case 4:{r367=HEAP32[r41>>2];r368=HEAP32[r42>>2];r369=HEAP32[r43>>2];r370=HEAP32[r44>>2];r371=4;r372=0;r373=__Znwj(48);r374=r373;__ZN9RCqsmodelC2Ebjjj(r374,0,31,16,1024);r375=r373;HEAP32[r33>>2]=r375;r376=__Znwj(12);r377=r376+4|0;r378=r377;HEAP32[r378>>2]=r367;r379=r376+8|0;r380=r379;HEAP32[r380>>2]=r33;r381=r368+1|0;r382=r369+1|0;r383=Math_imul(r382,r381)|0;r384=r383+r381|0;r385=r384;while(1){r386=r385+1|0;r387=r386&r385;r388=(r387|0)==0;r389=r386|r385;if(r388){break}else{r385=r389}}r390=_llvm_umul_with_overflow_i32(r386,4);r391=tempRet0;r392=r391;r393=r390;r394=r392?-1:r393;r395=__Znwj(r394);r396=r395;r397=r383;r398=0;while(1){r399=r398+1|0;r400=r398&r385;r401=r396+(r400<<2)|0;HEAPF32[r401>>2]=0;r402=r397-1|0;r403=(r402|0)==0;if(r403){break}else{r397=r402;r398=r399}}r404=(r370|0)==0;if(!r404){r405=(r369|0)==0;r406=(r368|0)==0;r407=r383;r408=0;r409=r76;while(1){r410=r381;r411=r407;while(1){r412=r411+1|0;r413=r411&r385;r414=r396+(r413<<2)|0;HEAPF32[r414>>2]=0;r415=r410-1|0;r416=(r415|0)==0;if(r416){break}else{r410=r415;r411=r412}}r417=r407+r381|0;if(r405){r418=r417;r419=r409}else{r420=r417;r421=0;r422=r409;while(1){r423=r420&r385;r424=r396+(r423<<2)|0;HEAPF32[r424>>2]=0;r425=r420+1|0;if(r406){r426=r425;r427=r422}else{r428=r425;r429=0;r430=r422;while(1){r431=r428-1|0;r432=r431&r385;r433=r396+(r432<<2)|0;r434=HEAPF32[r433>>2];r435=r428-r381|0;r436=r435-r383|0;r437=r436&r385;r438=r396+(r437<<2)|0;r439=HEAPF32[r438>>2];r440=r434-r439;r441=r435&r385;r442=r396+(r441<<2)|0;r443=HEAPF32[r442>>2];r444=r440+r443;r445=r431-r383|0;r446=r445&r385;r447=r396+(r446<<2)|0;r448=HEAPF32[r447>>2];r449=r444-r448;r450=r428-r383|0;r451=r450&r385;r452=r396+(r451<<2)|0;r453=HEAPF32[r452>>2];r454=r449+r453;r455=r431-r381|0;r456=r455&r385;r457=r396+(r456<<2)|0;r458=HEAPF32[r457>>2];r459=r454-r458;r460=r455-r383|0;r461=r460&r385;r462=r396+(r461<<2)|0;r463=HEAPF32[r462>>2];r464=r459+r463;r465=(HEAPF32[tempDoublePtr>>2]=r464,HEAP32[tempDoublePtr>>2]);r466=r465>>>28;r467=r466^15;r468=HEAP32[r378>>2];r469=HEAP32[r380>>2];r470=HEAP32[r469>>2];r471=__ZN9RCdecoder6decodeEP7RCmodel(r468,r470);r472=r467>>>3;r473=-r472|0;r474=r473>>>29;r475=r474^r467;r476=r471-15|0;r477=r476+r475|0;r478=r477>>>3;r479=-r478|0;r480=r479>>>29;r481=r480^r477;r482=r481<<28;r483=r482^-268435456;r484=(HEAP32[tempDoublePtr>>2]=r483,HEAPF32[tempDoublePtr>>2]);HEAPF32[r430>>2]=r484;r485=r428&r385;r486=r396+(r485<<2)|0;HEAPF32[r486>>2]=r484;r487=r430+4|0;r488=r428+1|0;r489=r429+1|0;r490=r489>>>0<r368>>>0;if(r490){r428=r488;r429=r489;r430=r487}else{r426=r488;r427=r487;break}}}r491=r421+1|0;r492=r491>>>0<r369>>>0;if(r492){r420=r426;r421=r491;r422=r427}else{r418=r426;r419=r427;break}}}r493=r408+1|0;r494=r493>>>0<r370>>>0;if(r494){r407=r418;r408=r493;r409=r419}else{break}}}r495=(r376|0)==0;if(!r495){_free(r376)}r496=HEAP32[r33>>2];r497=(r496|0)==0;if(!r497){r498=r496;r499=HEAP32[r498>>2];r500=r499+4|0;r501=HEAP32[r500>>2];FUNCTION_TABLE[r501](r496)}r502=(r395|0)==0;if(r502){break L6}_free(r395);break};case 5:{r503=HEAP32[r41>>2];r504=HEAP32[r42>>2];r505=HEAP32[r43>>2];r506=HEAP32[r44>>2];r507=4;r508=0;r509=__Znwj(48);r510=r509;__ZN9RCqsmodelC2Ebjjj(r510,0,63,16,1024);r511=r509;HEAP32[r32>>2]=r511;r512=__Znwj(12);r513=r512+4|0;r514=r513;HEAP32[r514>>2]=r503;r515=r512+8|0;r516=r515;HEAP32[r516>>2]=r32;r517=r504+1|0;r518=r505+1|0;r519=Math_imul(r518,r517)|0;r520=r519+r517|0;r521=r520;while(1){r522=r521+1|0;r523=r522&r521;r524=(r523|0)==0;r525=r522|r521;if(r524){break}else{r521=r525}}r526=_llvm_umul_with_overflow_i32(r522,4);r527=tempRet0;r528=r527;r529=r526;r530=r528?-1:r529;r531=__Znwj(r530);r532=r531;r533=r519;r534=0;while(1){r535=r534+1|0;r536=r534&r521;r537=r532+(r536<<2)|0;HEAPF32[r537>>2]=0;r538=r533-1|0;r539=(r538|0)==0;if(r539){break}else{r533=r538;r534=r535}}r540=(r506|0)==0;if(!r540){r541=(r505|0)==0;r542=(r504|0)==0;r543=r519;r544=0;r545=r76;while(1){r546=r517;r547=r543;while(1){r548=r547+1|0;r549=r547&r521;r550=r532+(r549<<2)|0;HEAPF32[r550>>2]=0;r551=r546-1|0;r552=(r551|0)==0;if(r552){break}else{r546=r551;r547=r548}}r553=r543+r517|0;if(r541){r554=r553;r555=r545}else{r556=r553;r557=0;r558=r545;while(1){r559=r556&r521;r560=r532+(r559<<2)|0;HEAPF32[r560>>2]=0;r561=r556+1|0;if(r542){r562=r561;r563=r558}else{r564=r561;r565=0;r566=r558;while(1){r567=r564-1|0;r568=r567&r521;r569=r532+(r568<<2)|0;r570=HEAPF32[r569>>2];r571=r564-r517|0;r572=r571-r519|0;r573=r572&r521;r574=r532+(r573<<2)|0;r575=HEAPF32[r574>>2];r576=r570-r575;r577=r571&r521;r578=r532+(r577<<2)|0;r579=HEAPF32[r578>>2];r580=r576+r579;r581=r567-r519|0;r582=r581&r521;r583=r532+(r582<<2)|0;r584=HEAPF32[r583>>2];r585=r580-r584;r586=r564-r519|0;r587=r586&r521;r588=r532+(r587<<2)|0;r589=HEAPF32[r588>>2];r590=r585+r589;r591=r567-r517|0;r592=r591&r521;r593=r532+(r592<<2)|0;r594=HEAPF32[r593>>2];r595=r590-r594;r596=r591-r519|0;r597=r596&r521;r598=r532+(r597<<2)|0;r599=HEAPF32[r598>>2];r600=r595+r599;r601=(HEAPF32[tempDoublePtr>>2]=r600,HEAP32[tempDoublePtr>>2]);r602=r601>>>27;r603=r602^31;r604=HEAP32[r514>>2];r605=HEAP32[r516>>2];r606=HEAP32[r605>>2];r607=__ZN9RCdecoder6decodeEP7RCmodel(r604,r606);r608=r603>>>4;r609=-r608|0;r610=r609>>>28;r611=r610^r603;r612=r607-31|0;r613=r612+r611|0;r614=r613>>>4;r615=-r614|0;r616=r615>>>28;r617=r616^r613;r618=r617<<27;r619=r618^-134217728;r620=(HEAP32[tempDoublePtr>>2]=r619,HEAPF32[tempDoublePtr>>2]);HEAPF32[r566>>2]=r620;r621=r564&r521;r622=r532+(r621<<2)|0;HEAPF32[r622>>2]=r620;r623=r566+4|0;r624=r564+1|0;r625=r565+1|0;r626=r625>>>0<r504>>>0;if(r626){r564=r624;r565=r625;r566=r623}else{r562=r624;r563=r623;break}}}r627=r557+1|0;r628=r627>>>0<r505>>>0;if(r628){r556=r562;r557=r627;r558=r563}else{r554=r562;r555=r563;break}}}r629=r544+1|0;r630=r629>>>0<r506>>>0;if(r630){r543=r554;r544=r629;r545=r555}else{break}}}r631=(r512|0)==0;if(!r631){_free(r512)}r632=HEAP32[r32>>2];r633=(r632|0)==0;if(!r633){r634=r632;r635=HEAP32[r634>>2];r636=r635+4|0;r637=HEAP32[r636>>2];FUNCTION_TABLE[r637](r632)}r638=(r531|0)==0;if(r638){break L6}_free(r531);break};case 6:{r639=HEAP32[r41>>2];r640=HEAP32[r42>>2];r641=HEAP32[r43>>2];r642=HEAP32[r44>>2];r643=4;r644=0;r645=__Znwj(48);r646=r645;__ZN9RCqsmodelC2Ebjjj(r646,0,127,16,1024);r647=r645;HEAP32[r31>>2]=r647;r648=__Znwj(12);r649=r648+4|0;r650=r649;HEAP32[r650>>2]=r639;r651=r648+8|0;r652=r651;HEAP32[r652>>2]=r31;r653=r640+1|0;r654=r641+1|0;r655=Math_imul(r654,r653)|0;r656=r655+r653|0;r657=r656;while(1){r658=r657+1|0;r659=r658&r657;r660=(r659|0)==0;r661=r658|r657;if(r660){break}else{r657=r661}}r662=_llvm_umul_with_overflow_i32(r658,4);r663=tempRet0;r664=r663;r665=r662;r666=r664?-1:r665;r667=__Znwj(r666);r668=r667;r669=r655;r670=0;while(1){r671=r670+1|0;r672=r670&r657;r673=r668+(r672<<2)|0;HEAPF32[r673>>2]=0;r674=r669-1|0;r675=(r674|0)==0;if(r675){break}else{r669=r674;r670=r671}}r676=(r642|0)==0;if(!r676){r677=(r641|0)==0;r678=(r640|0)==0;r679=r655;r680=0;r681=r76;while(1){r682=r653;r683=r679;while(1){r684=r683+1|0;r685=r683&r657;r686=r668+(r685<<2)|0;HEAPF32[r686>>2]=0;r687=r682-1|0;r688=(r687|0)==0;if(r688){break}else{r682=r687;r683=r684}}r689=r679+r653|0;if(r677){r690=r689;r691=r681}else{r692=r689;r693=0;r694=r681;while(1){r695=r692&r657;r696=r668+(r695<<2)|0;HEAPF32[r696>>2]=0;r697=r692+1|0;if(r678){r698=r697;r699=r694}else{r700=r697;r701=0;r702=r694;while(1){r703=r700-1|0;r704=r703&r657;r705=r668+(r704<<2)|0;r706=HEAPF32[r705>>2];r707=r700-r653|0;r708=r707-r655|0;r709=r708&r657;r710=r668+(r709<<2)|0;r711=HEAPF32[r710>>2];r712=r706-r711;r713=r707&r657;r714=r668+(r713<<2)|0;r715=HEAPF32[r714>>2];r716=r712+r715;r717=r703-r655|0;r718=r717&r657;r719=r668+(r718<<2)|0;r720=HEAPF32[r719>>2];r721=r716-r720;r722=r700-r655|0;r723=r722&r657;r724=r668+(r723<<2)|0;r725=HEAPF32[r724>>2];r726=r721+r725;r727=r703-r653|0;r728=r727&r657;r729=r668+(r728<<2)|0;r730=HEAPF32[r729>>2];r731=r726-r730;r732=r727-r655|0;r733=r732&r657;r734=r668+(r733<<2)|0;r735=HEAPF32[r734>>2];r736=r731+r735;r737=(HEAPF32[tempDoublePtr>>2]=r736,HEAP32[tempDoublePtr>>2]);r738=r737>>>26;r739=r738^63;r740=HEAP32[r650>>2];r741=HEAP32[r652>>2];r742=HEAP32[r741>>2];r743=__ZN9RCdecoder6decodeEP7RCmodel(r740,r742);r744=r739>>>5;r745=-r744|0;r746=r745>>>27;r747=r746^r739;r748=r743-63|0;r749=r748+r747|0;r750=r749>>>5;r751=-r750|0;r752=r751>>>27;r753=r752^r749;r754=r753<<26;r755=r754^-67108864;r756=(HEAP32[tempDoublePtr>>2]=r755,HEAPF32[tempDoublePtr>>2]);HEAPF32[r702>>2]=r756;r757=r700&r657;r758=r668+(r757<<2)|0;HEAPF32[r758>>2]=r756;r759=r702+4|0;r760=r700+1|0;r761=r701+1|0;r762=r761>>>0<r640>>>0;if(r762){r700=r760;r701=r761;r702=r759}else{r698=r760;r699=r759;break}}}r763=r693+1|0;r764=r763>>>0<r641>>>0;if(r764){r692=r698;r693=r763;r694=r699}else{r690=r698;r691=r699;break}}}r765=r680+1|0;r766=r765>>>0<r642>>>0;if(r766){r679=r690;r680=r765;r681=r691}else{break}}}r767=(r648|0)==0;if(!r767){_free(r648)}r768=HEAP32[r31>>2];r769=(r768|0)==0;if(!r769){r770=r768;r771=HEAP32[r770>>2];r772=r771+4|0;r773=HEAP32[r772>>2];FUNCTION_TABLE[r773](r768)}r774=(r667|0)==0;if(r774){break L6}_free(r667);break};case 7:{r775=HEAP32[r41>>2];r776=HEAP32[r42>>2];r777=HEAP32[r43>>2];r778=HEAP32[r44>>2];r779=4;r780=0;r781=__Znwj(48);r782=r781;__ZN9RCqsmodelC2Ebjjj(r782,0,255,16,1024);r783=r781;HEAP32[r30>>2]=r783;r784=__Znwj(12);r785=r784+4|0;r786=r785;HEAP32[r786>>2]=r775;r787=r784+8|0;r788=r787;HEAP32[r788>>2]=r30;r789=r776+1|0;r790=r777+1|0;r791=Math_imul(r790,r789)|0;r792=r791+r789|0;r793=r792;while(1){r794=r793+1|0;r795=r794&r793;r796=(r795|0)==0;r797=r794|r793;if(r796){break}else{r793=r797}}r798=_llvm_umul_with_overflow_i32(r794,4);r799=tempRet0;r800=r799;r801=r798;r802=r800?-1:r801;r803=__Znwj(r802);r804=r803;r805=r791;r806=0;while(1){r807=r806+1|0;r808=r806&r793;r809=r804+(r808<<2)|0;HEAPF32[r809>>2]=0;r810=r805-1|0;r811=(r810|0)==0;if(r811){break}else{r805=r810;r806=r807}}r812=(r778|0)==0;if(!r812){r813=(r777|0)==0;r814=(r776|0)==0;r815=r791;r816=0;r817=r76;while(1){r818=r789;r819=r815;while(1){r820=r819+1|0;r821=r819&r793;r822=r804+(r821<<2)|0;HEAPF32[r822>>2]=0;r823=r818-1|0;r824=(r823|0)==0;if(r824){break}else{r818=r823;r819=r820}}r825=r815+r789|0;if(r813){r826=r825;r827=r817}else{r828=r825;r829=0;r830=r817;while(1){r831=r828&r793;r832=r804+(r831<<2)|0;HEAPF32[r832>>2]=0;r833=r828+1|0;if(r814){r834=r833;r835=r830}else{r836=r833;r837=0;r838=r830;while(1){r839=r836-1|0;r840=r839&r793;r841=r804+(r840<<2)|0;r842=HEAPF32[r841>>2];r843=r836-r789|0;r844=r843-r791|0;r845=r844&r793;r846=r804+(r845<<2)|0;r847=HEAPF32[r846>>2];r848=r842-r847;r849=r843&r793;r850=r804+(r849<<2)|0;r851=HEAPF32[r850>>2];r852=r848+r851;r853=r839-r791|0;r854=r853&r793;r855=r804+(r854<<2)|0;r856=HEAPF32[r855>>2];r857=r852-r856;r858=r836-r791|0;r859=r858&r793;r860=r804+(r859<<2)|0;r861=HEAPF32[r860>>2];r862=r857+r861;r863=r839-r789|0;r864=r863&r793;r865=r804+(r864<<2)|0;r866=HEAPF32[r865>>2];r867=r862-r866;r868=r863-r791|0;r869=r868&r793;r870=r804+(r869<<2)|0;r871=HEAPF32[r870>>2];r872=r867+r871;r873=(HEAPF32[tempDoublePtr>>2]=r872,HEAP32[tempDoublePtr>>2]);r874=r873>>>25;r875=r874^127;r876=HEAP32[r786>>2];r877=HEAP32[r788>>2];r878=HEAP32[r877>>2];r879=__ZN9RCdecoder6decodeEP7RCmodel(r876,r878);r880=r875>>>6;r881=-r880|0;r882=r881>>>26;r883=r882^r875;r884=r879-127|0;r885=r884+r883|0;r886=r885>>>6;r887=-r886|0;r888=r887>>>26;r889=r888^r885;r890=r889<<25;r891=r890^-33554432;r892=(HEAP32[tempDoublePtr>>2]=r891,HEAPF32[tempDoublePtr>>2]);HEAPF32[r838>>2]=r892;r893=r836&r793;r894=r804+(r893<<2)|0;HEAPF32[r894>>2]=r892;r895=r838+4|0;r896=r836+1|0;r897=r837+1|0;r898=r897>>>0<r776>>>0;if(r898){r836=r896;r837=r897;r838=r895}else{r834=r896;r835=r895;break}}}r899=r829+1|0;r900=r899>>>0<r777>>>0;if(r900){r828=r834;r829=r899;r830=r835}else{r826=r834;r827=r835;break}}}r901=r816+1|0;r902=r901>>>0<r778>>>0;if(r902){r815=r826;r816=r901;r817=r827}else{break}}}r903=(r784|0)==0;if(!r903){_free(r784)}r904=HEAP32[r30>>2];r905=(r904|0)==0;if(!r905){r906=r904;r907=HEAP32[r906>>2];r908=r907+4|0;r909=HEAP32[r908>>2];FUNCTION_TABLE[r909](r904)}r910=(r803|0)==0;if(r910){break L6}_free(r803);break};case 8:{r911=HEAP32[r41>>2];r912=HEAP32[r42>>2];r913=HEAP32[r43>>2];r914=HEAP32[r44>>2];r915=4;r916=0;r917=__Znwj(48);r918=r917;__ZN9RCqsmodelC2Ebjjj(r918,0,511,16,1024);r919=r917;HEAP32[r29>>2]=r919;r920=__Znwj(12);r921=r920+4|0;r922=r921;HEAP32[r922>>2]=r911;r923=r920+8|0;r924=r923;HEAP32[r924>>2]=r29;r925=r912+1|0;r926=r913+1|0;r927=Math_imul(r926,r925)|0;r928=r927+r925|0;r929=r928;while(1){r930=r929+1|0;r931=r930&r929;r932=(r931|0)==0;r933=r930|r929;if(r932){break}else{r929=r933}}r934=_llvm_umul_with_overflow_i32(r930,4);r935=tempRet0;r936=r935;r937=r934;r938=r936?-1:r937;r939=__Znwj(r938);r940=r939;r941=r927;r942=0;while(1){r943=r942+1|0;r944=r942&r929;r945=r940+(r944<<2)|0;HEAPF32[r945>>2]=0;r946=r941-1|0;r947=(r946|0)==0;if(r947){break}else{r941=r946;r942=r943}}r948=(r914|0)==0;if(!r948){r949=(r913|0)==0;r950=(r912|0)==0;r951=r927;r952=0;r953=r76;while(1){r954=r925;r955=r951;while(1){r956=r955+1|0;r957=r955&r929;r958=r940+(r957<<2)|0;HEAPF32[r958>>2]=0;r959=r954-1|0;r960=(r959|0)==0;if(r960){break}else{r954=r959;r955=r956}}r961=r951+r925|0;if(r949){r962=r961;r963=r953}else{r964=r961;r965=0;r966=r953;while(1){r967=r964&r929;r968=r940+(r967<<2)|0;HEAPF32[r968>>2]=0;r969=r964+1|0;if(r950){r970=r969;r971=r966}else{r972=r969;r973=0;r974=r966;while(1){r975=r972-1|0;r976=r975&r929;r977=r940+(r976<<2)|0;r978=HEAPF32[r977>>2];r979=r972-r925|0;r980=r979-r927|0;r981=r980&r929;r982=r940+(r981<<2)|0;r983=HEAPF32[r982>>2];r984=r978-r983;r985=r979&r929;r986=r940+(r985<<2)|0;r987=HEAPF32[r986>>2];r988=r984+r987;r989=r975-r927|0;r990=r989&r929;r991=r940+(r990<<2)|0;r992=HEAPF32[r991>>2];r993=r988-r992;r994=r972-r927|0;r995=r994&r929;r996=r940+(r995<<2)|0;r997=HEAPF32[r996>>2];r998=r993+r997;r999=r975-r925|0;r1000=r999&r929;r1001=r940+(r1000<<2)|0;r1002=HEAPF32[r1001>>2];r1003=r998-r1002;r1004=r999-r927|0;r1005=r1004&r929;r1006=r940+(r1005<<2)|0;r1007=HEAPF32[r1006>>2];r1008=r1003+r1007;r1009=(HEAPF32[tempDoublePtr>>2]=r1008,HEAP32[tempDoublePtr>>2]);r1010=r1009>>>24;r1011=r1010^255;r1012=HEAP32[r922>>2];r1013=HEAP32[r924>>2];r1014=HEAP32[r1013>>2];r1015=__ZN9RCdecoder6decodeEP7RCmodel(r1012,r1014);r1016=r1011>>>7;r1017=-r1016|0;r1018=r1017>>>25;r1019=r1018^r1011;r1020=r1015-255|0;r1021=r1020+r1019|0;r1022=r1021>>>7;r1023=-r1022|0;r1024=r1023>>>25;r1025=r1024^r1021;r1026=r1025<<24;r1027=r1026^-16777216;r1028=(HEAP32[tempDoublePtr>>2]=r1027,HEAPF32[tempDoublePtr>>2]);HEAPF32[r974>>2]=r1028;r1029=r972&r929;r1030=r940+(r1029<<2)|0;HEAPF32[r1030>>2]=r1028;r1031=r974+4|0;r1032=r972+1|0;r1033=r973+1|0;r1034=r1033>>>0<r912>>>0;if(r1034){r972=r1032;r973=r1033;r974=r1031}else{r970=r1032;r971=r1031;break}}}r1035=r965+1|0;r1036=r1035>>>0<r913>>>0;if(r1036){r964=r970;r965=r1035;r966=r971}else{r962=r970;r963=r971;break}}}r1037=r952+1|0;r1038=r1037>>>0<r914>>>0;if(r1038){r951=r962;r952=r1037;r953=r963}else{break}}}r1039=(r920|0)==0;if(!r1039){_free(r920)}r1040=HEAP32[r29>>2];r1041=(r1040|0)==0;if(!r1041){r1042=r1040;r1043=HEAP32[r1042>>2];r1044=r1043+4|0;r1045=HEAP32[r1044>>2];FUNCTION_TABLE[r1045](r1040)}r1046=(r939|0)==0;if(r1046){break L6}_free(r939);break};case 9:{r1047=HEAP32[r41>>2];r1048=HEAP32[r42>>2];r1049=HEAP32[r43>>2];r1050=HEAP32[r44>>2];r1051=4;r1052=0;r1053=__Znwj(48);r1054=r1053;__ZN9RCqsmodelC2Ebjjj(r1054,0,19,16,1024);r1055=r1053;HEAP32[r28>>2]=r1055;r1056=__Znwj(12);r1057=r1056+4|0;r1058=r1057;HEAP32[r1058>>2]=r1047;r1059=r1056+8|0;r1060=r1059;HEAP32[r1060>>2]=r28;r1061=r1048+1|0;r1062=r1049+1|0;r1063=Math_imul(r1062,r1061)|0;r1064=r1063+r1061|0;r1065=r1064;while(1){r1066=r1065+1|0;r1067=r1066&r1065;r1068=(r1067|0)==0;r1069=r1066|r1065;if(r1068){break}else{r1065=r1069}}r1070=_llvm_umul_with_overflow_i32(r1066,4);r1071=tempRet0;r1072=r1071;r1073=r1070;r1074=r1072?-1:r1073;r1075=__Znwj(r1074);r1076=r1075;r1077=r1063;r1078=0;while(1){r1079=r1078+1|0;r1080=r1078&r1065;r1081=r1076+(r1080<<2)|0;HEAPF32[r1081>>2]=0;r1082=r1077-1|0;r1083=(r1082|0)==0;if(r1083){break}else{r1077=r1082;r1078=r1079}}r1084=(r1050|0)==0;if(!r1084){r1085=(r1049|0)==0;r1086=(r1048|0)==0;r1087=r1063;r1088=0;r1089=r76;while(1){r1090=r1061;r1091=r1087;while(1){r1092=r1091+1|0;r1093=r1091&r1065;r1094=r1076+(r1093<<2)|0;HEAPF32[r1094>>2]=0;r1095=r1090-1|0;r1096=(r1095|0)==0;if(r1096){break}else{r1090=r1095;r1091=r1092}}r1097=r1087+r1061|0;if(r1085){r1098=r1097;r1099=r1089}else{r1100=r1097;r1101=0;r1102=r1089;while(1){r1103=r1100&r1065;r1104=r1076+(r1103<<2)|0;HEAPF32[r1104>>2]=0;r1105=r1100+1|0;if(r1086){r1106=r1105;r1107=r1102}else{r1108=r1105;r1109=0;r1110=r1102;while(1){r1111=r1108-1|0;r1112=r1111&r1065;r1113=r1076+(r1112<<2)|0;r1114=HEAPF32[r1113>>2];r1115=r1108-r1061|0;r1116=r1115-r1063|0;r1117=r1116&r1065;r1118=r1076+(r1117<<2)|0;r1119=HEAPF32[r1118>>2];r1120=r1114-r1119;r1121=r1115&r1065;r1122=r1076+(r1121<<2)|0;r1123=HEAPF32[r1122>>2];r1124=r1120+r1123;r1125=r1111-r1063|0;r1126=r1125&r1065;r1127=r1076+(r1126<<2)|0;r1128=HEAPF32[r1127>>2];r1129=r1124-r1128;r1130=r1108-r1063|0;r1131=r1130&r1065;r1132=r1076+(r1131<<2)|0;r1133=HEAPF32[r1132>>2];r1134=r1129+r1133;r1135=r1111-r1061|0;r1136=r1135&r1065;r1137=r1076+(r1136<<2)|0;r1138=HEAPF32[r1137>>2];r1139=r1134-r1138;r1140=r1135-r1063|0;r1141=r1140&r1065;r1142=r1076+(r1141<<2)|0;r1143=HEAPF32[r1142>>2];r1144=r1139+r1143;r1145=HEAP32[r1058>>2];r1146=HEAP32[r1060>>2];r1147=HEAP32[r1146>>2];r1148=__ZN9RCdecoder6decodeEP7RCmodel(r1145,r1147);r1149=r1148>>>0>9;do{if(r1149){r1150=r1148-10|0;r1151=1<<r1150;r1152=HEAP32[r1058>>2];r1153=r1150>>>0>16;if(r1153){r1154=__ZN9RCdecoder12decode_shiftEj(r1152,16);r1155=r1148-26|0;r1156=16;r1157=r1154;r1158=r1155}else{r1156=0;r1157=0;r1158=r1150}r1159=__ZN9RCdecoder12decode_shiftEj(r1152,r1158);r1160=r1159<<r1156;r1161=(HEAPF32[tempDoublePtr>>2]=r1144,HEAP32[tempDoublePtr>>2]);r1162=r1161>>>23;r1163=r1162^511;r1164=r1163>>>8;r1165=-r1164|0;r1166=r1165>>>24;r1167=r1166^r1163;r1168=r1151+r1167|0;r1169=r1168+r1157|0;r1170=r1169+r1160|0;r1171=r1170>>>8;r1172=-r1171|0;r1173=r1172>>>24;r1174=r1173^r1170;r1175=r1174<<23;r1176=r1175^-8388608;r1177=r1176}else{r1178=r1148>>>0<9;if(!r1178){r1179=(HEAPF32[tempDoublePtr>>2]=r1144,HEAP32[tempDoublePtr>>2]);r1180=r1179&-8388608;r1177=r1180;break}r1181=8-r1148|0;r1182=HEAP32[r1058>>2];r1183=r1181>>>0>16;if(r1183){r1184=__ZN9RCdecoder12decode_shiftEj(r1182,16);r1185=r1181-16|0;r1186=16;r1187=r1184;r1188=r1185}else{r1186=0;r1187=0;r1188=r1181}r1189=__ZN9RCdecoder12decode_shiftEj(r1182,r1188);r1190=r1189<<r1186;r1191=(HEAPF32[tempDoublePtr>>2]=r1144,HEAP32[tempDoublePtr>>2]);r1192=r1191>>>23;r1193=r1192^511;r1194=r1193>>>8;r1195=-r1194|0;r1196=r1195>>>24;r1197=r1196^r1193;r1198=-1<<r1181;r1199=r1198+r1197|0;r1200=r1199-r1187|0;r1201=r1200-r1190|0;r1202=r1201>>>8;r1203=-r1202|0;r1204=r1203>>>24;r1205=r1204^r1201;r1206=r1205<<23;r1207=r1206^-8388608;r1177=r1207}}while(0);r1208=(HEAP32[tempDoublePtr>>2]=r1177,HEAPF32[tempDoublePtr>>2]);HEAPF32[r1110>>2]=r1208;r1209=r1108&r1065;r1210=r1076+(r1209<<2)|0;HEAPF32[r1210>>2]=r1208;r1211=r1110+4|0;r1212=r1108+1|0;r1213=r1109+1|0;r1214=r1213>>>0<r1048>>>0;if(r1214){r1108=r1212;r1109=r1213;r1110=r1211}else{r1106=r1212;r1107=r1211;break}}}r1215=r1101+1|0;r1216=r1215>>>0<r1049>>>0;if(r1216){r1100=r1106;r1101=r1215;r1102=r1107}else{r1098=r1106;r1099=r1107;break}}}r1217=r1088+1|0;r1218=r1217>>>0<r1050>>>0;if(r1218){r1087=r1098;r1088=r1217;r1089=r1099}else{break}}}r1219=(r1056|0)==0;if(!r1219){_free(r1056)}r1220=HEAP32[r28>>2];r1221=(r1220|0)==0;if(!r1221){r1222=r1220;r1223=HEAP32[r1222>>2];r1224=r1223+4|0;r1225=HEAP32[r1224>>2];FUNCTION_TABLE[r1225](r1220)}r1226=(r1075|0)==0;if(r1226){break L6}_free(r1075);break};case 10:{r1227=HEAP32[r41>>2];r1228=HEAP32[r42>>2];r1229=HEAP32[r43>>2];r1230=HEAP32[r44>>2];r1231=4;r1232=0;r1233=__Znwj(48);r1234=r1233;__ZN9RCqsmodelC2Ebjjj(r1234,0,21,16,1024);r1235=r1233;HEAP32[r27>>2]=r1235;r1236=__Znwj(12);r1237=r1236+4|0;r1238=r1237;HEAP32[r1238>>2]=r1227;r1239=r1236+8|0;r1240=r1239;HEAP32[r1240>>2]=r27;r1241=r1228+1|0;r1242=r1229+1|0;r1243=Math_imul(r1242,r1241)|0;r1244=r1243+r1241|0;r1245=r1244;while(1){r1246=r1245+1|0;r1247=r1246&r1245;r1248=(r1247|0)==0;r1249=r1246|r1245;if(r1248){break}else{r1245=r1249}}r1250=_llvm_umul_with_overflow_i32(r1246,4);r1251=tempRet0;r1252=r1251;r1253=r1250;r1254=r1252?-1:r1253;r1255=__Znwj(r1254);r1256=r1255;r1257=r1243;r1258=0;while(1){r1259=r1258+1|0;r1260=r1258&r1245;r1261=r1256+(r1260<<2)|0;HEAPF32[r1261>>2]=0;r1262=r1257-1|0;r1263=(r1262|0)==0;if(r1263){break}else{r1257=r1262;r1258=r1259}}r1264=(r1230|0)==0;if(!r1264){r1265=(r1229|0)==0;r1266=(r1228|0)==0;r1267=r1243;r1268=0;r1269=r76;while(1){r1270=r1241;r1271=r1267;while(1){r1272=r1271+1|0;r1273=r1271&r1245;r1274=r1256+(r1273<<2)|0;HEAPF32[r1274>>2]=0;r1275=r1270-1|0;r1276=(r1275|0)==0;if(r1276){break}else{r1270=r1275;r1271=r1272}}r1277=r1267+r1241|0;if(r1265){r1278=r1277;r1279=r1269}else{r1280=r1277;r1281=0;r1282=r1269;while(1){r1283=r1280&r1245;r1284=r1256+(r1283<<2)|0;HEAPF32[r1284>>2]=0;r1285=r1280+1|0;if(r1266){r1286=r1285;r1287=r1282}else{r1288=r1285;r1289=0;r1290=r1282;while(1){r1291=r1288-1|0;r1292=r1291&r1245;r1293=r1256+(r1292<<2)|0;r1294=HEAPF32[r1293>>2];r1295=r1288-r1241|0;r1296=r1295-r1243|0;r1297=r1296&r1245;r1298=r1256+(r1297<<2)|0;r1299=HEAPF32[r1298>>2];r1300=r1294-r1299;r1301=r1295&r1245;r1302=r1256+(r1301<<2)|0;r1303=HEAPF32[r1302>>2];r1304=r1300+r1303;r1305=r1291-r1243|0;r1306=r1305&r1245;r1307=r1256+(r1306<<2)|0;r1308=HEAPF32[r1307>>2];r1309=r1304-r1308;r1310=r1288-r1243|0;r1311=r1310&r1245;r1312=r1256+(r1311<<2)|0;r1313=HEAPF32[r1312>>2];r1314=r1309+r1313;r1315=r1291-r1241|0;r1316=r1315&r1245;r1317=r1256+(r1316<<2)|0;r1318=HEAPF32[r1317>>2];r1319=r1314-r1318;r1320=r1315-r1243|0;r1321=r1320&r1245;r1322=r1256+(r1321<<2)|0;r1323=HEAPF32[r1322>>2];r1324=r1319+r1323;r1325=HEAP32[r1238>>2];r1326=HEAP32[r1240>>2];r1327=HEAP32[r1326>>2];r1328=__ZN9RCdecoder6decodeEP7RCmodel(r1325,r1327);r1329=r1328>>>0>10;do{if(r1329){r1330=r1328-11|0;r1331=1<<r1330;r1332=HEAP32[r1238>>2];r1333=r1330>>>0>16;if(r1333){r1334=__ZN9RCdecoder12decode_shiftEj(r1332,16);r1335=r1328-27|0;r1336=16;r1337=r1334;r1338=r1335}else{r1336=0;r1337=0;r1338=r1330}r1339=__ZN9RCdecoder12decode_shiftEj(r1332,r1338);r1340=r1339<<r1336;r1341=(HEAPF32[tempDoublePtr>>2]=r1324,HEAP32[tempDoublePtr>>2]);r1342=r1341>>>22;r1343=r1342^1023;r1344=r1343>>>9;r1345=-r1344|0;r1346=r1345>>>23;r1347=r1346^r1343;r1348=r1331+r1347|0;r1349=r1348+r1337|0;r1350=r1349+r1340|0;r1351=r1350>>>9;r1352=-r1351|0;r1353=r1352>>>23;r1354=r1353^r1350;r1355=r1354<<22;r1356=r1355^-4194304;r1357=r1356}else{r1358=r1328>>>0<10;if(!r1358){r1359=(HEAPF32[tempDoublePtr>>2]=r1324,HEAP32[tempDoublePtr>>2]);r1360=r1359&-4194304;r1357=r1360;break}r1361=9-r1328|0;r1362=HEAP32[r1238>>2];r1363=r1361>>>0>16;if(r1363){r1364=__ZN9RCdecoder12decode_shiftEj(r1362,16);r1365=r1361-16|0;r1366=16;r1367=r1364;r1368=r1365}else{r1366=0;r1367=0;r1368=r1361}r1369=__ZN9RCdecoder12decode_shiftEj(r1362,r1368);r1370=r1369<<r1366;r1371=(HEAPF32[tempDoublePtr>>2]=r1324,HEAP32[tempDoublePtr>>2]);r1372=r1371>>>22;r1373=r1372^1023;r1374=r1373>>>9;r1375=-r1374|0;r1376=r1375>>>23;r1377=r1376^r1373;r1378=-1<<r1361;r1379=r1378+r1377|0;r1380=r1379-r1367|0;r1381=r1380-r1370|0;r1382=r1381>>>9;r1383=-r1382|0;r1384=r1383>>>23;r1385=r1384^r1381;r1386=r1385<<22;r1387=r1386^-4194304;r1357=r1387}}while(0);r1388=(HEAP32[tempDoublePtr>>2]=r1357,HEAPF32[tempDoublePtr>>2]);HEAPF32[r1290>>2]=r1388;r1389=r1288&r1245;r1390=r1256+(r1389<<2)|0;HEAPF32[r1390>>2]=r1388;r1391=r1290+4|0;r1392=r1288+1|0;r1393=r1289+1|0;r1394=r1393>>>0<r1228>>>0;if(r1394){r1288=r1392;r1289=r1393;r1290=r1391}else{r1286=r1392;r1287=r1391;break}}}r1395=r1281+1|0;r1396=r1395>>>0<r1229>>>0;if(r1396){r1280=r1286;r1281=r1395;r1282=r1287}else{r1278=r1286;r1279=r1287;break}}}r1397=r1268+1|0;r1398=r1397>>>0<r1230>>>0;if(r1398){r1267=r1278;r1268=r1397;r1269=r1279}else{break}}}r1399=(r1236|0)==0;if(!r1399){_free(r1236)}r1400=HEAP32[r27>>2];r1401=(r1400|0)==0;if(!r1401){r1402=r1400;r1403=HEAP32[r1402>>2];r1404=r1403+4|0;r1405=HEAP32[r1404>>2];FUNCTION_TABLE[r1405](r1400)}r1406=(r1255|0)==0;if(r1406){break L6}_free(r1255);break};case 11:{r1407=HEAP32[r41>>2];r1408=HEAP32[r42>>2];r1409=HEAP32[r43>>2];r1410=HEAP32[r44>>2];r1411=4;r1412=0;r1413=__Znwj(48);r1414=r1413;__ZN9RCqsmodelC2Ebjjj(r1414,0,23,16,1024);r1415=r1413;HEAP32[r26>>2]=r1415;r1416=__Znwj(12);r1417=r1416+4|0;r1418=r1417;HEAP32[r1418>>2]=r1407;r1419=r1416+8|0;r1420=r1419;HEAP32[r1420>>2]=r26;r1421=r1408+1|0;r1422=r1409+1|0;r1423=Math_imul(r1422,r1421)|0;r1424=r1423+r1421|0;r1425=r1424;while(1){r1426=r1425+1|0;r1427=r1426&r1425;r1428=(r1427|0)==0;r1429=r1426|r1425;if(r1428){break}else{r1425=r1429}}r1430=_llvm_umul_with_overflow_i32(r1426,4);r1431=tempRet0;r1432=r1431;r1433=r1430;r1434=r1432?-1:r1433;r1435=__Znwj(r1434);r1436=r1435;r1437=r1423;r1438=0;while(1){r1439=r1438+1|0;r1440=r1438&r1425;r1441=r1436+(r1440<<2)|0;HEAPF32[r1441>>2]=0;r1442=r1437-1|0;r1443=(r1442|0)==0;if(r1443){break}else{r1437=r1442;r1438=r1439}}r1444=(r1410|0)==0;if(!r1444){r1445=(r1409|0)==0;r1446=(r1408|0)==0;r1447=r1423;r1448=0;r1449=r76;while(1){r1450=r1421;r1451=r1447;while(1){r1452=r1451+1|0;r1453=r1451&r1425;r1454=r1436+(r1453<<2)|0;HEAPF32[r1454>>2]=0;r1455=r1450-1|0;r1456=(r1455|0)==0;if(r1456){break}else{r1450=r1455;r1451=r1452}}r1457=r1447+r1421|0;if(r1445){r1458=r1457;r1459=r1449}else{r1460=r1457;r1461=0;r1462=r1449;while(1){r1463=r1460&r1425;r1464=r1436+(r1463<<2)|0;HEAPF32[r1464>>2]=0;r1465=r1460+1|0;if(r1446){r1466=r1465;r1467=r1462}else{r1468=r1465;r1469=0;r1470=r1462;while(1){r1471=r1468-1|0;r1472=r1471&r1425;r1473=r1436+(r1472<<2)|0;r1474=HEAPF32[r1473>>2];r1475=r1468-r1421|0;r1476=r1475-r1423|0;r1477=r1476&r1425;r1478=r1436+(r1477<<2)|0;r1479=HEAPF32[r1478>>2];r1480=r1474-r1479;r1481=r1475&r1425;r1482=r1436+(r1481<<2)|0;r1483=HEAPF32[r1482>>2];r1484=r1480+r1483;r1485=r1471-r1423|0;r1486=r1485&r1425;r1487=r1436+(r1486<<2)|0;r1488=HEAPF32[r1487>>2];r1489=r1484-r1488;r1490=r1468-r1423|0;r1491=r1490&r1425;r1492=r1436+(r1491<<2)|0;r1493=HEAPF32[r1492>>2];r1494=r1489+r1493;r1495=r1471-r1421|0;r1496=r1495&r1425;r1497=r1436+(r1496<<2)|0;r1498=HEAPF32[r1497>>2];r1499=r1494-r1498;r1500=r1495-r1423|0;r1501=r1500&r1425;r1502=r1436+(r1501<<2)|0;r1503=HEAPF32[r1502>>2];r1504=r1499+r1503;r1505=HEAP32[r1418>>2];r1506=HEAP32[r1420>>2];r1507=HEAP32[r1506>>2];r1508=__ZN9RCdecoder6decodeEP7RCmodel(r1505,r1507);r1509=r1508>>>0>11;do{if(r1509){r1510=r1508-12|0;r1511=1<<r1510;r1512=HEAP32[r1418>>2];r1513=r1510>>>0>16;if(r1513){r1514=__ZN9RCdecoder12decode_shiftEj(r1512,16);r1515=r1508-28|0;r1516=16;r1517=r1514;r1518=r1515}else{r1516=0;r1517=0;r1518=r1510}r1519=__ZN9RCdecoder12decode_shiftEj(r1512,r1518);r1520=r1519<<r1516;r1521=(HEAPF32[tempDoublePtr>>2]=r1504,HEAP32[tempDoublePtr>>2]);r1522=r1521>>>21;r1523=r1522^2047;r1524=r1523>>>10;r1525=-r1524|0;r1526=r1525>>>22;r1527=r1526^r1523;r1528=r1511+r1527|0;r1529=r1528+r1517|0;r1530=r1529+r1520|0;r1531=r1530>>>10;r1532=-r1531|0;r1533=r1532>>>22;r1534=r1533^r1530;r1535=r1534<<21;r1536=r1535^-2097152;r1537=r1536}else{r1538=r1508>>>0<11;if(!r1538){r1539=(HEAPF32[tempDoublePtr>>2]=r1504,HEAP32[tempDoublePtr>>2]);r1540=r1539&-2097152;r1537=r1540;break}r1541=10-r1508|0;r1542=HEAP32[r1418>>2];r1543=r1541>>>0>16;if(r1543){r1544=__ZN9RCdecoder12decode_shiftEj(r1542,16);r1545=r1541-16|0;r1546=16;r1547=r1544;r1548=r1545}else{r1546=0;r1547=0;r1548=r1541}r1549=__ZN9RCdecoder12decode_shiftEj(r1542,r1548);r1550=r1549<<r1546;r1551=(HEAPF32[tempDoublePtr>>2]=r1504,HEAP32[tempDoublePtr>>2]);r1552=r1551>>>21;r1553=r1552^2047;r1554=r1553>>>10;r1555=-r1554|0;r1556=r1555>>>22;r1557=r1556^r1553;r1558=-1<<r1541;r1559=r1558+r1557|0;r1560=r1559-r1547|0;r1561=r1560-r1550|0;r1562=r1561>>>10;r1563=-r1562|0;r1564=r1563>>>22;r1565=r1564^r1561;r1566=r1565<<21;r1567=r1566^-2097152;r1537=r1567}}while(0);r1568=(HEAP32[tempDoublePtr>>2]=r1537,HEAPF32[tempDoublePtr>>2]);HEAPF32[r1470>>2]=r1568;r1569=r1468&r1425;r1570=r1436+(r1569<<2)|0;HEAPF32[r1570>>2]=r1568;r1571=r1470+4|0;r1572=r1468+1|0;r1573=r1469+1|0;r1574=r1573>>>0<r1408>>>0;if(r1574){r1468=r1572;r1469=r1573;r1470=r1571}else{r1466=r1572;r1467=r1571;break}}}r1575=r1461+1|0;r1576=r1575>>>0<r1409>>>0;if(r1576){r1460=r1466;r1461=r1575;r1462=r1467}else{r1458=r1466;r1459=r1467;break}}}r1577=r1448+1|0;r1578=r1577>>>0<r1410>>>0;if(r1578){r1447=r1458;r1448=r1577;r1449=r1459}else{break}}}r1579=(r1416|0)==0;if(!r1579){_free(r1416)}r1580=HEAP32[r26>>2];r1581=(r1580|0)==0;if(!r1581){r1582=r1580;r1583=HEAP32[r1582>>2];r1584=r1583+4|0;r1585=HEAP32[r1584>>2];FUNCTION_TABLE[r1585](r1580)}r1586=(r1435|0)==0;if(r1586){break L6}_free(r1435);break};case 12:{r1587=HEAP32[r41>>2];r1588=HEAP32[r42>>2];r1589=HEAP32[r43>>2];r1590=HEAP32[r44>>2];r1591=4;r1592=0;r1593=__Znwj(48);r1594=r1593;__ZN9RCqsmodelC2Ebjjj(r1594,0,25,16,1024);r1595=r1593;HEAP32[r25>>2]=r1595;r1596=__Znwj(12);r1597=r1596+4|0;r1598=r1597;HEAP32[r1598>>2]=r1587;r1599=r1596+8|0;r1600=r1599;HEAP32[r1600>>2]=r25;r1601=r1588+1|0;r1602=r1589+1|0;r1603=Math_imul(r1602,r1601)|0;r1604=r1603+r1601|0;r1605=r1604;while(1){r1606=r1605+1|0;r1607=r1606&r1605;r1608=(r1607|0)==0;r1609=r1606|r1605;if(r1608){break}else{r1605=r1609}}r1610=_llvm_umul_with_overflow_i32(r1606,4);r1611=tempRet0;r1612=r1611;r1613=r1610;r1614=r1612?-1:r1613;r1615=__Znwj(r1614);r1616=r1615;r1617=r1603;r1618=0;while(1){r1619=r1618+1|0;r1620=r1618&r1605;r1621=r1616+(r1620<<2)|0;HEAPF32[r1621>>2]=0;r1622=r1617-1|0;r1623=(r1622|0)==0;if(r1623){break}else{r1617=r1622;r1618=r1619}}r1624=(r1590|0)==0;if(!r1624){r1625=(r1589|0)==0;r1626=(r1588|0)==0;r1627=r1603;r1628=0;r1629=r76;while(1){r1630=r1601;r1631=r1627;while(1){r1632=r1631+1|0;r1633=r1631&r1605;r1634=r1616+(r1633<<2)|0;HEAPF32[r1634>>2]=0;r1635=r1630-1|0;r1636=(r1635|0)==0;if(r1636){break}else{r1630=r1635;r1631=r1632}}r1637=r1627+r1601|0;if(r1625){r1638=r1637;r1639=r1629}else{r1640=r1637;r1641=0;r1642=r1629;while(1){r1643=r1640&r1605;r1644=r1616+(r1643<<2)|0;HEAPF32[r1644>>2]=0;r1645=r1640+1|0;if(r1626){r1646=r1645;r1647=r1642}else{r1648=r1645;r1649=0;r1650=r1642;while(1){r1651=r1648-1|0;r1652=r1651&r1605;r1653=r1616+(r1652<<2)|0;r1654=HEAPF32[r1653>>2];r1655=r1648-r1601|0;r1656=r1655-r1603|0;r1657=r1656&r1605;r1658=r1616+(r1657<<2)|0;r1659=HEAPF32[r1658>>2];r1660=r1654-r1659;r1661=r1655&r1605;r1662=r1616+(r1661<<2)|0;r1663=HEAPF32[r1662>>2];r1664=r1660+r1663;r1665=r1651-r1603|0;r1666=r1665&r1605;r1667=r1616+(r1666<<2)|0;r1668=HEAPF32[r1667>>2];r1669=r1664-r1668;r1670=r1648-r1603|0;r1671=r1670&r1605;r1672=r1616+(r1671<<2)|0;r1673=HEAPF32[r1672>>2];r1674=r1669+r1673;r1675=r1651-r1601|0;r1676=r1675&r1605;r1677=r1616+(r1676<<2)|0;r1678=HEAPF32[r1677>>2];r1679=r1674-r1678;r1680=r1675-r1603|0;r1681=r1680&r1605;r1682=r1616+(r1681<<2)|0;r1683=HEAPF32[r1682>>2];r1684=r1679+r1683;r1685=HEAP32[r1598>>2];r1686=HEAP32[r1600>>2];r1687=HEAP32[r1686>>2];r1688=__ZN9RCdecoder6decodeEP7RCmodel(r1685,r1687);r1689=r1688>>>0>12;do{if(r1689){r1690=r1688-13|0;r1691=1<<r1690;r1692=HEAP32[r1598>>2];r1693=r1690>>>0>16;if(r1693){r1694=__ZN9RCdecoder12decode_shiftEj(r1692,16);r1695=r1688-29|0;r1696=16;r1697=r1694;r1698=r1695}else{r1696=0;r1697=0;r1698=r1690}r1699=__ZN9RCdecoder12decode_shiftEj(r1692,r1698);r1700=r1699<<r1696;r1701=(HEAPF32[tempDoublePtr>>2]=r1684,HEAP32[tempDoublePtr>>2]);r1702=r1701>>>20;r1703=r1702^4095;r1704=r1703>>>11;r1705=-r1704|0;r1706=r1705>>>21;r1707=r1706^r1703;r1708=r1691+r1707|0;r1709=r1708+r1697|0;r1710=r1709+r1700|0;r1711=r1710>>>11;r1712=-r1711|0;r1713=r1712>>>21;r1714=r1713^r1710;r1715=r1714<<20;r1716=r1715^-1048576;r1717=r1716}else{r1718=r1688>>>0<12;if(!r1718){r1719=(HEAPF32[tempDoublePtr>>2]=r1684,HEAP32[tempDoublePtr>>2]);r1720=r1719&-1048576;r1717=r1720;break}r1721=11-r1688|0;r1722=HEAP32[r1598>>2];r1723=r1721>>>0>16;if(r1723){r1724=__ZN9RCdecoder12decode_shiftEj(r1722,16);r1725=r1721-16|0;r1726=16;r1727=r1724;r1728=r1725}else{r1726=0;r1727=0;r1728=r1721}r1729=__ZN9RCdecoder12decode_shiftEj(r1722,r1728);r1730=r1729<<r1726;r1731=(HEAPF32[tempDoublePtr>>2]=r1684,HEAP32[tempDoublePtr>>2]);r1732=r1731>>>20;r1733=r1732^4095;r1734=r1733>>>11;r1735=-r1734|0;r1736=r1735>>>21;r1737=r1736^r1733;r1738=-1<<r1721;r1739=r1738+r1737|0;r1740=r1739-r1727|0;r1741=r1740-r1730|0;r1742=r1741>>>11;r1743=-r1742|0;r1744=r1743>>>21;r1745=r1744^r1741;r1746=r1745<<20;r1747=r1746^-1048576;r1717=r1747}}while(0);r1748=(HEAP32[tempDoublePtr>>2]=r1717,HEAPF32[tempDoublePtr>>2]);HEAPF32[r1650>>2]=r1748;r1749=r1648&r1605;r1750=r1616+(r1749<<2)|0;HEAPF32[r1750>>2]=r1748;r1751=r1650+4|0;r1752=r1648+1|0;r1753=r1649+1|0;r1754=r1753>>>0<r1588>>>0;if(r1754){r1648=r1752;r1649=r1753;r1650=r1751}else{r1646=r1752;r1647=r1751;break}}}r1755=r1641+1|0;r1756=r1755>>>0<r1589>>>0;if(r1756){r1640=r1646;r1641=r1755;r1642=r1647}else{r1638=r1646;r1639=r1647;break}}}r1757=r1628+1|0;r1758=r1757>>>0<r1590>>>0;if(r1758){r1627=r1638;r1628=r1757;r1629=r1639}else{break}}}r1759=(r1596|0)==0;if(!r1759){_free(r1596)}r1760=HEAP32[r25>>2];r1761=(r1760|0)==0;if(!r1761){r1762=r1760;r1763=HEAP32[r1762>>2];r1764=r1763+4|0;r1765=HEAP32[r1764>>2];FUNCTION_TABLE[r1765](r1760)}r1766=(r1615|0)==0;if(r1766){break L6}_free(r1615);break};case 13:{r1767=HEAP32[r41>>2];r1768=HEAP32[r42>>2];r1769=HEAP32[r43>>2];r1770=HEAP32[r44>>2];r1771=4;r1772=0;r1773=__Znwj(48);r1774=r1773;__ZN9RCqsmodelC2Ebjjj(r1774,0,27,16,1024);r1775=r1773;HEAP32[r24>>2]=r1775;r1776=__Znwj(12);r1777=r1776+4|0;r1778=r1777;HEAP32[r1778>>2]=r1767;r1779=r1776+8|0;r1780=r1779;HEAP32[r1780>>2]=r24;r1781=r1768+1|0;r1782=r1769+1|0;r1783=Math_imul(r1782,r1781)|0;r1784=r1783+r1781|0;r1785=r1784;while(1){r1786=r1785+1|0;r1787=r1786&r1785;r1788=(r1787|0)==0;r1789=r1786|r1785;if(r1788){break}else{r1785=r1789}}r1790=_llvm_umul_with_overflow_i32(r1786,4);r1791=tempRet0;r1792=r1791;r1793=r1790;r1794=r1792?-1:r1793;r1795=__Znwj(r1794);r1796=r1795;r1797=r1783;r1798=0;while(1){r1799=r1798+1|0;r1800=r1798&r1785;r1801=r1796+(r1800<<2)|0;HEAPF32[r1801>>2]=0;r1802=r1797-1|0;r1803=(r1802|0)==0;if(r1803){break}else{r1797=r1802;r1798=r1799}}r1804=(r1770|0)==0;if(!r1804){r1805=(r1769|0)==0;r1806=(r1768|0)==0;r1807=r1783;r1808=0;r1809=r76;while(1){r1810=r1781;r1811=r1807;while(1){r1812=r1811+1|0;r1813=r1811&r1785;r1814=r1796+(r1813<<2)|0;HEAPF32[r1814>>2]=0;r1815=r1810-1|0;r1816=(r1815|0)==0;if(r1816){break}else{r1810=r1815;r1811=r1812}}r1817=r1807+r1781|0;if(r1805){r1818=r1817;r1819=r1809}else{r1820=r1817;r1821=0;r1822=r1809;while(1){r1823=r1820&r1785;r1824=r1796+(r1823<<2)|0;HEAPF32[r1824>>2]=0;r1825=r1820+1|0;if(r1806){r1826=r1825;r1827=r1822}else{r1828=r1825;r1829=0;r1830=r1822;while(1){r1831=r1828-1|0;r1832=r1831&r1785;r1833=r1796+(r1832<<2)|0;r1834=HEAPF32[r1833>>2];r1835=r1828-r1781|0;r1836=r1835-r1783|0;r1837=r1836&r1785;r1838=r1796+(r1837<<2)|0;r1839=HEAPF32[r1838>>2];r1840=r1834-r1839;r1841=r1835&r1785;r1842=r1796+(r1841<<2)|0;r1843=HEAPF32[r1842>>2];r1844=r1840+r1843;r1845=r1831-r1783|0;r1846=r1845&r1785;r1847=r1796+(r1846<<2)|0;r1848=HEAPF32[r1847>>2];r1849=r1844-r1848;r1850=r1828-r1783|0;r1851=r1850&r1785;r1852=r1796+(r1851<<2)|0;r1853=HEAPF32[r1852>>2];r1854=r1849+r1853;r1855=r1831-r1781|0;r1856=r1855&r1785;r1857=r1796+(r1856<<2)|0;r1858=HEAPF32[r1857>>2];r1859=r1854-r1858;r1860=r1855-r1783|0;r1861=r1860&r1785;r1862=r1796+(r1861<<2)|0;r1863=HEAPF32[r1862>>2];r1864=r1859+r1863;r1865=HEAP32[r1778>>2];r1866=HEAP32[r1780>>2];r1867=HEAP32[r1866>>2];r1868=__ZN9RCdecoder6decodeEP7RCmodel(r1865,r1867);r1869=r1868>>>0>13;do{if(r1869){r1870=r1868-14|0;r1871=1<<r1870;r1872=HEAP32[r1778>>2];r1873=r1870>>>0>16;if(r1873){r1874=__ZN9RCdecoder12decode_shiftEj(r1872,16);r1875=r1868-30|0;r1876=16;r1877=r1874;r1878=r1875}else{r1876=0;r1877=0;r1878=r1870}r1879=__ZN9RCdecoder12decode_shiftEj(r1872,r1878);r1880=r1879<<r1876;r1881=(HEAPF32[tempDoublePtr>>2]=r1864,HEAP32[tempDoublePtr>>2]);r1882=r1881>>>19;r1883=r1882^8191;r1884=r1883>>>12;r1885=-r1884|0;r1886=r1885>>>20;r1887=r1886^r1883;r1888=r1871+r1887|0;r1889=r1888+r1877|0;r1890=r1889+r1880|0;r1891=r1890>>>12;r1892=-r1891|0;r1893=r1892>>>20;r1894=r1893^r1890;r1895=r1894<<19;r1896=r1895^-524288;r1897=r1896}else{r1898=r1868>>>0<13;if(!r1898){r1899=(HEAPF32[tempDoublePtr>>2]=r1864,HEAP32[tempDoublePtr>>2]);r1900=r1899&-524288;r1897=r1900;break}r1901=12-r1868|0;r1902=HEAP32[r1778>>2];r1903=r1901>>>0>16;if(r1903){r1904=__ZN9RCdecoder12decode_shiftEj(r1902,16);r1905=r1901-16|0;r1906=16;r1907=r1904;r1908=r1905}else{r1906=0;r1907=0;r1908=r1901}r1909=__ZN9RCdecoder12decode_shiftEj(r1902,r1908);r1910=r1909<<r1906;r1911=(HEAPF32[tempDoublePtr>>2]=r1864,HEAP32[tempDoublePtr>>2]);r1912=r1911>>>19;r1913=r1912^8191;r1914=r1913>>>12;r1915=-r1914|0;r1916=r1915>>>20;r1917=r1916^r1913;r1918=-1<<r1901;r1919=r1918+r1917|0;r1920=r1919-r1907|0;r1921=r1920-r1910|0;r1922=r1921>>>12;r1923=-r1922|0;r1924=r1923>>>20;r1925=r1924^r1921;r1926=r1925<<19;r1927=r1926^-524288;r1897=r1927}}while(0);r1928=(HEAP32[tempDoublePtr>>2]=r1897,HEAPF32[tempDoublePtr>>2]);HEAPF32[r1830>>2]=r1928;r1929=r1828&r1785;r1930=r1796+(r1929<<2)|0;HEAPF32[r1930>>2]=r1928;r1931=r1830+4|0;r1932=r1828+1|0;r1933=r1829+1|0;r1934=r1933>>>0<r1768>>>0;if(r1934){r1828=r1932;r1829=r1933;r1830=r1931}else{r1826=r1932;r1827=r1931;break}}}r1935=r1821+1|0;r1936=r1935>>>0<r1769>>>0;if(r1936){r1820=r1826;r1821=r1935;r1822=r1827}else{r1818=r1826;r1819=r1827;break}}}r1937=r1808+1|0;r1938=r1937>>>0<r1770>>>0;if(r1938){r1807=r1818;r1808=r1937;r1809=r1819}else{break}}}r1939=(r1776|0)==0;if(!r1939){_free(r1776)}r1940=HEAP32[r24>>2];r1941=(r1940|0)==0;if(!r1941){r1942=r1940;r1943=HEAP32[r1942>>2];r1944=r1943+4|0;r1945=HEAP32[r1944>>2];FUNCTION_TABLE[r1945](r1940)}r1946=(r1795|0)==0;if(r1946){break L6}_free(r1795);break};case 14:{r1947=HEAP32[r41>>2];r1948=HEAP32[r42>>2];r1949=HEAP32[r43>>2];r1950=HEAP32[r44>>2];r1951=4;r1952=0;r1953=__Znwj(48);r1954=r1953;__ZN9RCqsmodelC2Ebjjj(r1954,0,29,16,1024);r1955=r1953;HEAP32[r23>>2]=r1955;r1956=__Znwj(12);r1957=r1956+4|0;r1958=r1957;HEAP32[r1958>>2]=r1947;r1959=r1956+8|0;r1960=r1959;HEAP32[r1960>>2]=r23;r1961=r1948+1|0;r1962=r1949+1|0;r1963=Math_imul(r1962,r1961)|0;r1964=r1963+r1961|0;r1965=r1964;while(1){r1966=r1965+1|0;r1967=r1966&r1965;r1968=(r1967|0)==0;r1969=r1966|r1965;if(r1968){break}else{r1965=r1969}}r1970=_llvm_umul_with_overflow_i32(r1966,4);r1971=tempRet0;r1972=r1971;r1973=r1970;r1974=r1972?-1:r1973;r1975=__Znwj(r1974);r1976=r1975;r1977=r1963;r1978=0;while(1){r1979=r1978+1|0;r1980=r1978&r1965;r1981=r1976+(r1980<<2)|0;HEAPF32[r1981>>2]=0;r1982=r1977-1|0;r1983=(r1982|0)==0;if(r1983){break}else{r1977=r1982;r1978=r1979}}r1984=(r1950|0)==0;if(!r1984){r1985=(r1949|0)==0;r1986=(r1948|0)==0;r1987=r1963;r1988=0;r1989=r76;while(1){r1990=r1961;r1991=r1987;while(1){r1992=r1991+1|0;r1993=r1991&r1965;r1994=r1976+(r1993<<2)|0;HEAPF32[r1994>>2]=0;r1995=r1990-1|0;r1996=(r1995|0)==0;if(r1996){break}else{r1990=r1995;r1991=r1992}}r1997=r1987+r1961|0;if(r1985){r1998=r1997;r1999=r1989}else{r2000=r1997;r2001=0;r2002=r1989;while(1){r2003=r2000&r1965;r2004=r1976+(r2003<<2)|0;HEAPF32[r2004>>2]=0;r2005=r2000+1|0;if(r1986){r2006=r2005;r2007=r2002}else{r2008=r2005;r2009=0;r2010=r2002;while(1){r2011=r2008-1|0;r2012=r2011&r1965;r2013=r1976+(r2012<<2)|0;r2014=HEAPF32[r2013>>2];r2015=r2008-r1961|0;r2016=r2015-r1963|0;r2017=r2016&r1965;r2018=r1976+(r2017<<2)|0;r2019=HEAPF32[r2018>>2];r2020=r2014-r2019;r2021=r2015&r1965;r2022=r1976+(r2021<<2)|0;r2023=HEAPF32[r2022>>2];r2024=r2020+r2023;r2025=r2011-r1963|0;r2026=r2025&r1965;r2027=r1976+(r2026<<2)|0;r2028=HEAPF32[r2027>>2];r2029=r2024-r2028;r2030=r2008-r1963|0;r2031=r2030&r1965;r2032=r1976+(r2031<<2)|0;r2033=HEAPF32[r2032>>2];r2034=r2029+r2033;r2035=r2011-r1961|0;r2036=r2035&r1965;r2037=r1976+(r2036<<2)|0;r2038=HEAPF32[r2037>>2];r2039=r2034-r2038;r2040=r2035-r1963|0;r2041=r2040&r1965;r2042=r1976+(r2041<<2)|0;r2043=HEAPF32[r2042>>2];r2044=r2039+r2043;r2045=HEAP32[r1958>>2];r2046=HEAP32[r1960>>2];r2047=HEAP32[r2046>>2];r2048=__ZN9RCdecoder6decodeEP7RCmodel(r2045,r2047);r2049=r2048>>>0>14;do{if(r2049){r2050=r2048-15|0;r2051=1<<r2050;r2052=HEAP32[r1958>>2];r2053=r2050>>>0>16;if(r2053){r2054=__ZN9RCdecoder12decode_shiftEj(r2052,16);r2055=r2048-31|0;r2056=16;r2057=r2054;r2058=r2055}else{r2056=0;r2057=0;r2058=r2050}r2059=__ZN9RCdecoder12decode_shiftEj(r2052,r2058);r2060=r2059<<r2056;r2061=(HEAPF32[tempDoublePtr>>2]=r2044,HEAP32[tempDoublePtr>>2]);r2062=r2061>>>18;r2063=r2062^16383;r2064=r2063>>>13;r2065=-r2064|0;r2066=r2065>>>19;r2067=r2066^r2063;r2068=r2051+r2067|0;r2069=r2068+r2057|0;r2070=r2069+r2060|0;r2071=r2070>>>13;r2072=-r2071|0;r2073=r2072>>>19;r2074=r2073^r2070;r2075=r2074<<18;r2076=r2075^-262144;r2077=r2076}else{r2078=r2048>>>0<14;if(!r2078){r2079=(HEAPF32[tempDoublePtr>>2]=r2044,HEAP32[tempDoublePtr>>2]);r2080=r2079&-262144;r2077=r2080;break}r2081=13-r2048|0;r2082=HEAP32[r1958>>2];r2083=r2081>>>0>16;if(r2083){r2084=__ZN9RCdecoder12decode_shiftEj(r2082,16);r2085=r2081-16|0;r2086=16;r2087=r2084;r2088=r2085}else{r2086=0;r2087=0;r2088=r2081}r2089=__ZN9RCdecoder12decode_shiftEj(r2082,r2088);r2090=r2089<<r2086;r2091=(HEAPF32[tempDoublePtr>>2]=r2044,HEAP32[tempDoublePtr>>2]);r2092=r2091>>>18;r2093=r2092^16383;r2094=r2093>>>13;r2095=-r2094|0;r2096=r2095>>>19;r2097=r2096^r2093;r2098=-1<<r2081;r2099=r2098+r2097|0;r2100=r2099-r2087|0;r2101=r2100-r2090|0;r2102=r2101>>>13;r2103=-r2102|0;r2104=r2103>>>19;r2105=r2104^r2101;r2106=r2105<<18;r2107=r2106^-262144;r2077=r2107}}while(0);r2108=(HEAP32[tempDoublePtr>>2]=r2077,HEAPF32[tempDoublePtr>>2]);HEAPF32[r2010>>2]=r2108;r2109=r2008&r1965;r2110=r1976+(r2109<<2)|0;HEAPF32[r2110>>2]=r2108;r2111=r2010+4|0;r2112=r2008+1|0;r2113=r2009+1|0;r2114=r2113>>>0<r1948>>>0;if(r2114){r2008=r2112;r2009=r2113;r2010=r2111}else{r2006=r2112;r2007=r2111;break}}}r2115=r2001+1|0;r2116=r2115>>>0<r1949>>>0;if(r2116){r2000=r2006;r2001=r2115;r2002=r2007}else{r1998=r2006;r1999=r2007;break}}}r2117=r1988+1|0;r2118=r2117>>>0<r1950>>>0;if(r2118){r1987=r1998;r1988=r2117;r1989=r1999}else{break}}}r2119=(r1956|0)==0;if(!r2119){_free(r1956)}r2120=HEAP32[r23>>2];r2121=(r2120|0)==0;if(!r2121){r2122=r2120;r2123=HEAP32[r2122>>2];r2124=r2123+4|0;r2125=HEAP32[r2124>>2];FUNCTION_TABLE[r2125](r2120)}r2126=(r1975|0)==0;if(r2126){break L6}_free(r1975);break};case 15:{r2127=HEAP32[r41>>2];r2128=HEAP32[r42>>2];r2129=HEAP32[r43>>2];r2130=HEAP32[r44>>2];r2131=4;r2132=0;r2133=__Znwj(48);r2134=r2133;__ZN9RCqsmodelC2Ebjjj(r2134,0,31,16,1024);r2135=r2133;HEAP32[r22>>2]=r2135;r2136=__Znwj(12);r2137=r2136+4|0;r2138=r2137;HEAP32[r2138>>2]=r2127;r2139=r2136+8|0;r2140=r2139;HEAP32[r2140>>2]=r22;r2141=r2128+1|0;r2142=r2129+1|0;r2143=Math_imul(r2142,r2141)|0;r2144=r2143+r2141|0;r2145=r2144;while(1){r2146=r2145+1|0;r2147=r2146&r2145;r2148=(r2147|0)==0;r2149=r2146|r2145;if(r2148){break}else{r2145=r2149}}r2150=_llvm_umul_with_overflow_i32(r2146,4);r2151=tempRet0;r2152=r2151;r2153=r2150;r2154=r2152?-1:r2153;r2155=__Znwj(r2154);r2156=r2155;r2157=r2143;r2158=0;while(1){r2159=r2158+1|0;r2160=r2158&r2145;r2161=r2156+(r2160<<2)|0;HEAPF32[r2161>>2]=0;r2162=r2157-1|0;r2163=(r2162|0)==0;if(r2163){break}else{r2157=r2162;r2158=r2159}}r2164=(r2130|0)==0;if(!r2164){r2165=(r2129|0)==0;r2166=(r2128|0)==0;r2167=r2143;r2168=0;r2169=r76;while(1){r2170=r2141;r2171=r2167;while(1){r2172=r2171+1|0;r2173=r2171&r2145;r2174=r2156+(r2173<<2)|0;HEAPF32[r2174>>2]=0;r2175=r2170-1|0;r2176=(r2175|0)==0;if(r2176){break}else{r2170=r2175;r2171=r2172}}r2177=r2167+r2141|0;if(r2165){r2178=r2177;r2179=r2169}else{r2180=r2177;r2181=0;r2182=r2169;while(1){r2183=r2180&r2145;r2184=r2156+(r2183<<2)|0;HEAPF32[r2184>>2]=0;r2185=r2180+1|0;if(r2166){r2186=r2185;r2187=r2182}else{r2188=r2185;r2189=0;r2190=r2182;while(1){r2191=r2188-1|0;r2192=r2191&r2145;r2193=r2156+(r2192<<2)|0;r2194=HEAPF32[r2193>>2];r2195=r2188-r2141|0;r2196=r2195-r2143|0;r2197=r2196&r2145;r2198=r2156+(r2197<<2)|0;r2199=HEAPF32[r2198>>2];r2200=r2194-r2199;r2201=r2195&r2145;r2202=r2156+(r2201<<2)|0;r2203=HEAPF32[r2202>>2];r2204=r2200+r2203;r2205=r2191-r2143|0;r2206=r2205&r2145;r2207=r2156+(r2206<<2)|0;r2208=HEAPF32[r2207>>2];r2209=r2204-r2208;r2210=r2188-r2143|0;r2211=r2210&r2145;r2212=r2156+(r2211<<2)|0;r2213=HEAPF32[r2212>>2];r2214=r2209+r2213;r2215=r2191-r2141|0;r2216=r2215&r2145;r2217=r2156+(r2216<<2)|0;r2218=HEAPF32[r2217>>2];r2219=r2214-r2218;r2220=r2215-r2143|0;r2221=r2220&r2145;r2222=r2156+(r2221<<2)|0;r2223=HEAPF32[r2222>>2];r2224=r2219+r2223;r2225=HEAP32[r2138>>2];r2226=HEAP32[r2140>>2];r2227=HEAP32[r2226>>2];r2228=__ZN9RCdecoder6decodeEP7RCmodel(r2225,r2227);r2229=r2228>>>0>15;do{if(r2229){r2230=r2228-16|0;r2231=1<<r2230;r2232=HEAP32[r2138>>2];r2233=r2230>>>0>16;if(r2233){r2234=__ZN9RCdecoder12decode_shiftEj(r2232,16);r2235=r2228-32|0;r2236=16;r2237=r2234;r2238=r2235}else{r2236=0;r2237=0;r2238=r2230}r2239=__ZN9RCdecoder12decode_shiftEj(r2232,r2238);r2240=r2239<<r2236;r2241=(HEAPF32[tempDoublePtr>>2]=r2224,HEAP32[tempDoublePtr>>2]);r2242=r2241>>>17;r2243=r2242^32767;r2244=r2243>>>14;r2245=-r2244|0;r2246=r2245>>>18;r2247=r2246^r2243;r2248=r2231+r2247|0;r2249=r2248+r2237|0;r2250=r2249+r2240|0;r2251=r2250>>>14;r2252=-r2251|0;r2253=r2252>>>18;r2254=r2253^r2250;r2255=r2254<<17;r2256=r2255^-131072;r2257=r2256}else{r2258=r2228>>>0<15;if(!r2258){r2259=(HEAPF32[tempDoublePtr>>2]=r2224,HEAP32[tempDoublePtr>>2]);r2260=r2259&-131072;r2257=r2260;break}r2261=14-r2228|0;r2262=HEAP32[r2138>>2];r2263=r2261>>>0>16;if(r2263){r2264=__ZN9RCdecoder12decode_shiftEj(r2262,16);r2265=r2261-16|0;r2266=16;r2267=r2264;r2268=r2265}else{r2266=0;r2267=0;r2268=r2261}r2269=__ZN9RCdecoder12decode_shiftEj(r2262,r2268);r2270=r2269<<r2266;r2271=(HEAPF32[tempDoublePtr>>2]=r2224,HEAP32[tempDoublePtr>>2]);r2272=r2271>>>17;r2273=r2272^32767;r2274=r2273>>>14;r2275=-r2274|0;r2276=r2275>>>18;r2277=r2276^r2273;r2278=-1<<r2261;r2279=r2278+r2277|0;r2280=r2279-r2267|0;r2281=r2280-r2270|0;r2282=r2281>>>14;r2283=-r2282|0;r2284=r2283>>>18;r2285=r2284^r2281;r2286=r2285<<17;r2287=r2286^-131072;r2257=r2287}}while(0);r2288=(HEAP32[tempDoublePtr>>2]=r2257,HEAPF32[tempDoublePtr>>2]);HEAPF32[r2190>>2]=r2288;r2289=r2188&r2145;r2290=r2156+(r2289<<2)|0;HEAPF32[r2290>>2]=r2288;r2291=r2190+4|0;r2292=r2188+1|0;r2293=r2189+1|0;r2294=r2293>>>0<r2128>>>0;if(r2294){r2188=r2292;r2189=r2293;r2190=r2291}else{r2186=r2292;r2187=r2291;break}}}r2295=r2181+1|0;r2296=r2295>>>0<r2129>>>0;if(r2296){r2180=r2186;r2181=r2295;r2182=r2187}else{r2178=r2186;r2179=r2187;break}}}r2297=r2168+1|0;r2298=r2297>>>0<r2130>>>0;if(r2298){r2167=r2178;r2168=r2297;r2169=r2179}else{break}}}r2299=(r2136|0)==0;if(!r2299){_free(r2136)}r2300=HEAP32[r22>>2];r2301=(r2300|0)==0;if(!r2301){r2302=r2300;r2303=HEAP32[r2302>>2];r2304=r2303+4|0;r2305=HEAP32[r2304>>2];FUNCTION_TABLE[r2305](r2300)}r2306=(r2155|0)==0;if(r2306){break L6}_free(r2155);break};case 16:{r2307=HEAP32[r41>>2];r2308=HEAP32[r42>>2];r2309=HEAP32[r43>>2];r2310=HEAP32[r44>>2];r2311=4;r2312=0;r2313=__Znwj(48);r2314=r2313;__ZN9RCqsmodelC2Ebjjj(r2314,0,33,16,1024);r2315=r2313;HEAP32[r21>>2]=r2315;r2316=__Znwj(12);r2317=r2316+4|0;r2318=r2317;HEAP32[r2318>>2]=r2307;r2319=r2316+8|0;r2320=r2319;HEAP32[r2320>>2]=r21;r2321=r2308+1|0;r2322=r2309+1|0;r2323=Math_imul(r2322,r2321)|0;r2324=r2323+r2321|0;r2325=r2324;while(1){r2326=r2325+1|0;r2327=r2326&r2325;r2328=(r2327|0)==0;r2329=r2326|r2325;if(r2328){break}else{r2325=r2329}}r2330=_llvm_umul_with_overflow_i32(r2326,4);r2331=tempRet0;r2332=r2331;r2333=r2330;r2334=r2332?-1:r2333;r2335=__Znwj(r2334);r2336=r2335;r2337=r2323;r2338=0;while(1){r2339=r2338+1|0;r2340=r2338&r2325;r2341=r2336+(r2340<<2)|0;HEAPF32[r2341>>2]=0;r2342=r2337-1|0;r2343=(r2342|0)==0;if(r2343){break}else{r2337=r2342;r2338=r2339}}r2344=(r2310|0)==0;if(!r2344){r2345=(r2309|0)==0;r2346=(r2308|0)==0;r2347=r2323;r2348=0;r2349=r76;while(1){r2350=r2321;r2351=r2347;while(1){r2352=r2351+1|0;r2353=r2351&r2325;r2354=r2336+(r2353<<2)|0;HEAPF32[r2354>>2]=0;r2355=r2350-1|0;r2356=(r2355|0)==0;if(r2356){break}else{r2350=r2355;r2351=r2352}}r2357=r2347+r2321|0;if(r2345){r2358=r2357;r2359=r2349}else{r2360=r2357;r2361=0;r2362=r2349;while(1){r2363=r2360&r2325;r2364=r2336+(r2363<<2)|0;HEAPF32[r2364>>2]=0;r2365=r2360+1|0;if(r2346){r2366=r2365;r2367=r2362}else{r2368=r2365;r2369=0;r2370=r2362;while(1){r2371=r2368-1|0;r2372=r2371&r2325;r2373=r2336+(r2372<<2)|0;r2374=HEAPF32[r2373>>2];r2375=r2368-r2321|0;r2376=r2375-r2323|0;r2377=r2376&r2325;r2378=r2336+(r2377<<2)|0;r2379=HEAPF32[r2378>>2];r2380=r2374-r2379;r2381=r2375&r2325;r2382=r2336+(r2381<<2)|0;r2383=HEAPF32[r2382>>2];r2384=r2380+r2383;r2385=r2371-r2323|0;r2386=r2385&r2325;r2387=r2336+(r2386<<2)|0;r2388=HEAPF32[r2387>>2];r2389=r2384-r2388;r2390=r2368-r2323|0;r2391=r2390&r2325;r2392=r2336+(r2391<<2)|0;r2393=HEAPF32[r2392>>2];r2394=r2389+r2393;r2395=r2371-r2321|0;r2396=r2395&r2325;r2397=r2336+(r2396<<2)|0;r2398=HEAPF32[r2397>>2];r2399=r2394-r2398;r2400=r2395-r2323|0;r2401=r2400&r2325;r2402=r2336+(r2401<<2)|0;r2403=HEAPF32[r2402>>2];r2404=r2399+r2403;r2405=HEAP32[r2318>>2];r2406=HEAP32[r2320>>2];r2407=HEAP32[r2406>>2];r2408=__ZN9RCdecoder6decodeEP7RCmodel(r2405,r2407);r2409=r2408>>>0>16;do{if(r2409){r2410=r2408-17|0;r2411=1<<r2410;r2412=HEAP32[r2318>>2];r2413=r2410>>>0>16;if(r2413){r2414=__ZN9RCdecoder12decode_shiftEj(r2412,16);r2415=r2408-33|0;r2416=16;r2417=r2414;r2418=r2415}else{r2416=0;r2417=0;r2418=r2410}r2419=__ZN9RCdecoder12decode_shiftEj(r2412,r2418);r2420=r2419<<r2416;r2421=(HEAPF32[tempDoublePtr>>2]=r2404,HEAP32[tempDoublePtr>>2]);r2422=r2421>>>16;r2423=r2422^65535;r2424=r2423>>>15;r2425=-r2424|0;r2426=r2425>>>17;r2427=r2426^r2423;r2428=r2411+r2427|0;r2429=r2428+r2417|0;r2430=r2429+r2420|0;r2431=r2430>>>15;r2432=-r2431|0;r2433=r2432>>>17;r2434=r2433^r2430;r2435=r2434<<16;r2436=r2435^-65536;r2437=r2436}else{r2438=r2408>>>0<16;if(!r2438){r2439=(HEAPF32[tempDoublePtr>>2]=r2404,HEAP32[tempDoublePtr>>2]);r2440=r2439&-65536;r2437=r2440;break}r2441=15-r2408|0;r2442=HEAP32[r2318>>2];r2443=r2441>>>0>16;if(r2443){r2444=__ZN9RCdecoder12decode_shiftEj(r2442,16);r2445=r2441-16|0;r2446=16;r2447=r2444;r2448=r2445}else{r2446=0;r2447=0;r2448=r2441}r2449=__ZN9RCdecoder12decode_shiftEj(r2442,r2448);r2450=r2449<<r2446;r2451=(HEAPF32[tempDoublePtr>>2]=r2404,HEAP32[tempDoublePtr>>2]);r2452=r2451>>>16;r2453=r2452^65535;r2454=r2453>>>15;r2455=-r2454|0;r2456=r2455>>>17;r2457=r2456^r2453;r2458=-1<<r2441;r2459=r2458+r2457|0;r2460=r2459-r2447|0;r2461=r2460-r2450|0;r2462=r2461>>>15;r2463=-r2462|0;r2464=r2463>>>17;r2465=r2464^r2461;r2466=r2465<<16;r2467=r2466^-65536;r2437=r2467}}while(0);r2468=(HEAP32[tempDoublePtr>>2]=r2437,HEAPF32[tempDoublePtr>>2]);HEAPF32[r2370>>2]=r2468;r2469=r2368&r2325;r2470=r2336+(r2469<<2)|0;HEAPF32[r2470>>2]=r2468;r2471=r2370+4|0;r2472=r2368+1|0;r2473=r2369+1|0;r2474=r2473>>>0<r2308>>>0;if(r2474){r2368=r2472;r2369=r2473;r2370=r2471}else{r2366=r2472;r2367=r2471;break}}}r2475=r2361+1|0;r2476=r2475>>>0<r2309>>>0;if(r2476){r2360=r2366;r2361=r2475;r2362=r2367}else{r2358=r2366;r2359=r2367;break}}}r2477=r2348+1|0;r2478=r2477>>>0<r2310>>>0;if(r2478){r2347=r2358;r2348=r2477;r2349=r2359}else{break}}}r2479=(r2316|0)==0;if(!r2479){_free(r2316)}r2480=HEAP32[r21>>2];r2481=(r2480|0)==0;if(!r2481){r2482=r2480;r2483=HEAP32[r2482>>2];r2484=r2483+4|0;r2485=HEAP32[r2484>>2];FUNCTION_TABLE[r2485](r2480)}r2486=(r2335|0)==0;if(r2486){break L6}_free(r2335);break};case 17:{r2487=HEAP32[r41>>2];r2488=HEAP32[r42>>2];r2489=HEAP32[r43>>2];r2490=HEAP32[r44>>2];r2491=4;r2492=0;r2493=__Znwj(48);r2494=r2493;__ZN9RCqsmodelC2Ebjjj(r2494,0,35,16,1024);r2495=r2493;HEAP32[r20>>2]=r2495;r2496=__Znwj(12);r2497=r2496+4|0;r2498=r2497;HEAP32[r2498>>2]=r2487;r2499=r2496+8|0;r2500=r2499;HEAP32[r2500>>2]=r20;r2501=r2488+1|0;r2502=r2489+1|0;r2503=Math_imul(r2502,r2501)|0;r2504=r2503+r2501|0;r2505=r2504;while(1){r2506=r2505+1|0;r2507=r2506&r2505;r2508=(r2507|0)==0;r2509=r2506|r2505;if(r2508){break}else{r2505=r2509}}r2510=_llvm_umul_with_overflow_i32(r2506,4);r2511=tempRet0;r2512=r2511;r2513=r2510;r2514=r2512?-1:r2513;r2515=__Znwj(r2514);r2516=r2515;r2517=r2503;r2518=0;while(1){r2519=r2518+1|0;r2520=r2518&r2505;r2521=r2516+(r2520<<2)|0;HEAPF32[r2521>>2]=0;r2522=r2517-1|0;r2523=(r2522|0)==0;if(r2523){break}else{r2517=r2522;r2518=r2519}}r2524=(r2490|0)==0;if(!r2524){r2525=(r2489|0)==0;r2526=(r2488|0)==0;r2527=r2503;r2528=0;r2529=r76;while(1){r2530=r2501;r2531=r2527;while(1){r2532=r2531+1|0;r2533=r2531&r2505;r2534=r2516+(r2533<<2)|0;HEAPF32[r2534>>2]=0;r2535=r2530-1|0;r2536=(r2535|0)==0;if(r2536){break}else{r2530=r2535;r2531=r2532}}r2537=r2527+r2501|0;if(r2525){r2538=r2537;r2539=r2529}else{r2540=r2537;r2541=0;r2542=r2529;while(1){r2543=r2540&r2505;r2544=r2516+(r2543<<2)|0;HEAPF32[r2544>>2]=0;r2545=r2540+1|0;if(r2526){r2546=r2545;r2547=r2542}else{r2548=r2545;r2549=0;r2550=r2542;while(1){r2551=r2548-1|0;r2552=r2551&r2505;r2553=r2516+(r2552<<2)|0;r2554=HEAPF32[r2553>>2];r2555=r2548-r2501|0;r2556=r2555-r2503|0;r2557=r2556&r2505;r2558=r2516+(r2557<<2)|0;r2559=HEAPF32[r2558>>2];r2560=r2554-r2559;r2561=r2555&r2505;r2562=r2516+(r2561<<2)|0;r2563=HEAPF32[r2562>>2];r2564=r2560+r2563;r2565=r2551-r2503|0;r2566=r2565&r2505;r2567=r2516+(r2566<<2)|0;r2568=HEAPF32[r2567>>2];r2569=r2564-r2568;r2570=r2548-r2503|0;r2571=r2570&r2505;r2572=r2516+(r2571<<2)|0;r2573=HEAPF32[r2572>>2];r2574=r2569+r2573;r2575=r2551-r2501|0;r2576=r2575&r2505;r2577=r2516+(r2576<<2)|0;r2578=HEAPF32[r2577>>2];r2579=r2574-r2578;r2580=r2575-r2503|0;r2581=r2580&r2505;r2582=r2516+(r2581<<2)|0;r2583=HEAPF32[r2582>>2];r2584=r2579+r2583;r2585=HEAP32[r2498>>2];r2586=HEAP32[r2500>>2];r2587=HEAP32[r2586>>2];r2588=__ZN9RCdecoder6decodeEP7RCmodel(r2585,r2587);r2589=r2588>>>0>17;do{if(r2589){r2590=r2588-18|0;r2591=1<<r2590;r2592=HEAP32[r2498>>2];r2593=r2590>>>0>16;if(r2593){r2594=__ZN9RCdecoder12decode_shiftEj(r2592,16);r2595=r2588-34|0;r2596=16;r2597=r2594;r2598=r2595}else{r2596=0;r2597=0;r2598=r2590}r2599=__ZN9RCdecoder12decode_shiftEj(r2592,r2598);r2600=r2599<<r2596;r2601=(HEAPF32[tempDoublePtr>>2]=r2584,HEAP32[tempDoublePtr>>2]);r2602=r2601>>>15;r2603=r2602^131071;r2604=r2603>>>16;r2605=-r2604|0;r2606=r2605>>>16;r2607=r2606^r2603;r2608=r2591+r2607|0;r2609=r2608+r2597|0;r2610=r2609+r2600|0;r2611=r2610>>>16;r2612=-r2611|0;r2613=r2612>>>16;r2614=r2613^r2610;r2615=r2614<<15;r2616=r2615^-32768;r2617=r2616}else{r2618=r2588>>>0<17;if(!r2618){r2619=(HEAPF32[tempDoublePtr>>2]=r2584,HEAP32[tempDoublePtr>>2]);r2620=r2619&-32768;r2617=r2620;break}r2621=16-r2588|0;r2622=HEAP32[r2498>>2];r2623=r2621>>>0>16;if(r2623){r2624=__ZN9RCdecoder12decode_shiftEj(r2622,16);r2625=r2621-16|0;r2626=16;r2627=r2624;r2628=r2625}else{r2626=0;r2627=0;r2628=r2621}r2629=__ZN9RCdecoder12decode_shiftEj(r2622,r2628);r2630=r2629<<r2626;r2631=(HEAPF32[tempDoublePtr>>2]=r2584,HEAP32[tempDoublePtr>>2]);r2632=r2631>>>15;r2633=r2632^131071;r2634=r2633>>>16;r2635=-r2634|0;r2636=r2635>>>16;r2637=r2636^r2633;r2638=-1<<r2621;r2639=r2638+r2637|0;r2640=r2639-r2627|0;r2641=r2640-r2630|0;r2642=r2641>>>16;r2643=-r2642|0;r2644=r2643>>>16;r2645=r2644^r2641;r2646=r2645<<15;r2647=r2646^-32768;r2617=r2647}}while(0);r2648=(HEAP32[tempDoublePtr>>2]=r2617,HEAPF32[tempDoublePtr>>2]);HEAPF32[r2550>>2]=r2648;r2649=r2548&r2505;r2650=r2516+(r2649<<2)|0;HEAPF32[r2650>>2]=r2648;r2651=r2550+4|0;r2652=r2548+1|0;r2653=r2549+1|0;r2654=r2653>>>0<r2488>>>0;if(r2654){r2548=r2652;r2549=r2653;r2550=r2651}else{r2546=r2652;r2547=r2651;break}}}r2655=r2541+1|0;r2656=r2655>>>0<r2489>>>0;if(r2656){r2540=r2546;r2541=r2655;r2542=r2547}else{r2538=r2546;r2539=r2547;break}}}r2657=r2528+1|0;r2658=r2657>>>0<r2490>>>0;if(r2658){r2527=r2538;r2528=r2657;r2529=r2539}else{break}}}r2659=(r2496|0)==0;if(!r2659){_free(r2496)}r2660=HEAP32[r20>>2];r2661=(r2660|0)==0;if(!r2661){r2662=r2660;r2663=HEAP32[r2662>>2];r2664=r2663+4|0;r2665=HEAP32[r2664>>2];FUNCTION_TABLE[r2665](r2660)}r2666=(r2515|0)==0;if(r2666){break L6}_free(r2515);break};case 18:{r2667=HEAP32[r41>>2];r2668=HEAP32[r42>>2];r2669=HEAP32[r43>>2];r2670=HEAP32[r44>>2];r2671=4;r2672=0;r2673=__Znwj(48);r2674=r2673;__ZN9RCqsmodelC2Ebjjj(r2674,0,37,16,1024);r2675=r2673;HEAP32[r19>>2]=r2675;r2676=__Znwj(12);r2677=r2676+4|0;r2678=r2677;HEAP32[r2678>>2]=r2667;r2679=r2676+8|0;r2680=r2679;HEAP32[r2680>>2]=r19;r2681=r2668+1|0;r2682=r2669+1|0;r2683=Math_imul(r2682,r2681)|0;r2684=r2683+r2681|0;r2685=r2684;while(1){r2686=r2685+1|0;r2687=r2686&r2685;r2688=(r2687|0)==0;r2689=r2686|r2685;if(r2688){break}else{r2685=r2689}}r2690=_llvm_umul_with_overflow_i32(r2686,4);r2691=tempRet0;r2692=r2691;r2693=r2690;r2694=r2692?-1:r2693;r2695=__Znwj(r2694);r2696=r2695;r2697=r2683;r2698=0;while(1){r2699=r2698+1|0;r2700=r2698&r2685;r2701=r2696+(r2700<<2)|0;HEAPF32[r2701>>2]=0;r2702=r2697-1|0;r2703=(r2702|0)==0;if(r2703){break}else{r2697=r2702;r2698=r2699}}r2704=(r2670|0)==0;if(!r2704){r2705=(r2669|0)==0;r2706=(r2668|0)==0;r2707=r2683;r2708=0;r2709=r76;while(1){r2710=r2681;r2711=r2707;while(1){r2712=r2711+1|0;r2713=r2711&r2685;r2714=r2696+(r2713<<2)|0;HEAPF32[r2714>>2]=0;r2715=r2710-1|0;r2716=(r2715|0)==0;if(r2716){break}else{r2710=r2715;r2711=r2712}}r2717=r2707+r2681|0;if(r2705){r2718=r2717;r2719=r2709}else{r2720=r2717;r2721=0;r2722=r2709;while(1){r2723=r2720&r2685;r2724=r2696+(r2723<<2)|0;HEAPF32[r2724>>2]=0;r2725=r2720+1|0;if(r2706){r2726=r2725;r2727=r2722}else{r2728=r2725;r2729=0;r2730=r2722;while(1){r2731=r2728-1|0;r2732=r2731&r2685;r2733=r2696+(r2732<<2)|0;r2734=HEAPF32[r2733>>2];r2735=r2728-r2681|0;r2736=r2735-r2683|0;r2737=r2736&r2685;r2738=r2696+(r2737<<2)|0;r2739=HEAPF32[r2738>>2];r2740=r2734-r2739;r2741=r2735&r2685;r2742=r2696+(r2741<<2)|0;r2743=HEAPF32[r2742>>2];r2744=r2740+r2743;r2745=r2731-r2683|0;r2746=r2745&r2685;r2747=r2696+(r2746<<2)|0;r2748=HEAPF32[r2747>>2];r2749=r2744-r2748;r2750=r2728-r2683|0;r2751=r2750&r2685;r2752=r2696+(r2751<<2)|0;r2753=HEAPF32[r2752>>2];r2754=r2749+r2753;r2755=r2731-r2681|0;r2756=r2755&r2685;r2757=r2696+(r2756<<2)|0;r2758=HEAPF32[r2757>>2];r2759=r2754-r2758;r2760=r2755-r2683|0;r2761=r2760&r2685;r2762=r2696+(r2761<<2)|0;r2763=HEAPF32[r2762>>2];r2764=r2759+r2763;r2765=HEAP32[r2678>>2];r2766=HEAP32[r2680>>2];r2767=HEAP32[r2766>>2];r2768=__ZN9RCdecoder6decodeEP7RCmodel(r2765,r2767);r2769=r2768>>>0>18;do{if(r2769){r2770=r2768-19|0;r2771=1<<r2770;r2772=HEAP32[r2678>>2];r2773=r2770>>>0>16;if(r2773){r2774=__ZN9RCdecoder12decode_shiftEj(r2772,16);r2775=r2768-35|0;r2776=16;r2777=r2774;r2778=r2775}else{r2776=0;r2777=0;r2778=r2770}r2779=__ZN9RCdecoder12decode_shiftEj(r2772,r2778);r2780=r2779<<r2776;r2781=(HEAPF32[tempDoublePtr>>2]=r2764,HEAP32[tempDoublePtr>>2]);r2782=r2781>>>14;r2783=r2782^262143;r2784=r2783>>>17;r2785=-r2784|0;r2786=r2785>>>15;r2787=r2786^r2783;r2788=r2771+r2787|0;r2789=r2788+r2777|0;r2790=r2789+r2780|0;r2791=r2790>>>17;r2792=-r2791|0;r2793=r2792>>>15;r2794=r2793^r2790;r2795=r2794<<14;r2796=r2795^-16384;r2797=r2796}else{r2798=r2768>>>0<18;if(!r2798){r2799=(HEAPF32[tempDoublePtr>>2]=r2764,HEAP32[tempDoublePtr>>2]);r2800=r2799&-16384;r2797=r2800;break}r2801=17-r2768|0;r2802=HEAP32[r2678>>2];r2803=r2801>>>0>16;if(r2803){r2804=__ZN9RCdecoder12decode_shiftEj(r2802,16);r2805=r2801-16|0;r2806=16;r2807=r2804;r2808=r2805}else{r2806=0;r2807=0;r2808=r2801}r2809=__ZN9RCdecoder12decode_shiftEj(r2802,r2808);r2810=r2809<<r2806;r2811=(HEAPF32[tempDoublePtr>>2]=r2764,HEAP32[tempDoublePtr>>2]);r2812=r2811>>>14;r2813=r2812^262143;r2814=r2813>>>17;r2815=-r2814|0;r2816=r2815>>>15;r2817=r2816^r2813;r2818=-1<<r2801;r2819=r2818+r2817|0;r2820=r2819-r2807|0;r2821=r2820-r2810|0;r2822=r2821>>>17;r2823=-r2822|0;r2824=r2823>>>15;r2825=r2824^r2821;r2826=r2825<<14;r2827=r2826^-16384;r2797=r2827}}while(0);r2828=(HEAP32[tempDoublePtr>>2]=r2797,HEAPF32[tempDoublePtr>>2]);HEAPF32[r2730>>2]=r2828;r2829=r2728&r2685;r2830=r2696+(r2829<<2)|0;HEAPF32[r2830>>2]=r2828;r2831=r2730+4|0;r2832=r2728+1|0;r2833=r2729+1|0;r2834=r2833>>>0<r2668>>>0;if(r2834){r2728=r2832;r2729=r2833;r2730=r2831}else{r2726=r2832;r2727=r2831;break}}}r2835=r2721+1|0;r2836=r2835>>>0<r2669>>>0;if(r2836){r2720=r2726;r2721=r2835;r2722=r2727}else{r2718=r2726;r2719=r2727;break}}}r2837=r2708+1|0;r2838=r2837>>>0<r2670>>>0;if(r2838){r2707=r2718;r2708=r2837;r2709=r2719}else{break}}}r2839=(r2676|0)==0;if(!r2839){_free(r2676)}r2840=HEAP32[r19>>2];r2841=(r2840|0)==0;if(!r2841){r2842=r2840;r2843=HEAP32[r2842>>2];r2844=r2843+4|0;r2845=HEAP32[r2844>>2];FUNCTION_TABLE[r2845](r2840)}r2846=(r2695|0)==0;if(r2846){break L6}_free(r2695);break};case 19:{r2847=HEAP32[r41>>2];r2848=HEAP32[r42>>2];r2849=HEAP32[r43>>2];r2850=HEAP32[r44>>2];r2851=4;r2852=0;r2853=__Znwj(48);r2854=r2853;__ZN9RCqsmodelC2Ebjjj(r2854,0,39,16,1024);r2855=r2853;HEAP32[r18>>2]=r2855;r2856=__Znwj(12);r2857=r2856+4|0;r2858=r2857;HEAP32[r2858>>2]=r2847;r2859=r2856+8|0;r2860=r2859;HEAP32[r2860>>2]=r18;r2861=r2848+1|0;r2862=r2849+1|0;r2863=Math_imul(r2862,r2861)|0;r2864=r2863+r2861|0;r2865=r2864;while(1){r2866=r2865+1|0;r2867=r2866&r2865;r2868=(r2867|0)==0;r2869=r2866|r2865;if(r2868){break}else{r2865=r2869}}r2870=_llvm_umul_with_overflow_i32(r2866,4);r2871=tempRet0;r2872=r2871;r2873=r2870;r2874=r2872?-1:r2873;r2875=__Znwj(r2874);r2876=r2875;r2877=r2863;r2878=0;while(1){r2879=r2878+1|0;r2880=r2878&r2865;r2881=r2876+(r2880<<2)|0;HEAPF32[r2881>>2]=0;r2882=r2877-1|0;r2883=(r2882|0)==0;if(r2883){break}else{r2877=r2882;r2878=r2879}}r2884=(r2850|0)==0;if(!r2884){r2885=(r2849|0)==0;r2886=(r2848|0)==0;r2887=r2863;r2888=0;r2889=r76;while(1){r2890=r2861;r2891=r2887;while(1){r2892=r2891+1|0;r2893=r2891&r2865;r2894=r2876+(r2893<<2)|0;HEAPF32[r2894>>2]=0;r2895=r2890-1|0;r2896=(r2895|0)==0;if(r2896){break}else{r2890=r2895;r2891=r2892}}r2897=r2887+r2861|0;if(r2885){r2898=r2897;r2899=r2889}else{r2900=r2897;r2901=0;r2902=r2889;while(1){r2903=r2900&r2865;r2904=r2876+(r2903<<2)|0;HEAPF32[r2904>>2]=0;r2905=r2900+1|0;if(r2886){r2906=r2905;r2907=r2902}else{r2908=r2905;r2909=0;r2910=r2902;while(1){r2911=r2908-1|0;r2912=r2911&r2865;r2913=r2876+(r2912<<2)|0;r2914=HEAPF32[r2913>>2];r2915=r2908-r2861|0;r2916=r2915-r2863|0;r2917=r2916&r2865;r2918=r2876+(r2917<<2)|0;r2919=HEAPF32[r2918>>2];r2920=r2914-r2919;r2921=r2915&r2865;r2922=r2876+(r2921<<2)|0;r2923=HEAPF32[r2922>>2];r2924=r2920+r2923;r2925=r2911-r2863|0;r2926=r2925&r2865;r2927=r2876+(r2926<<2)|0;r2928=HEAPF32[r2927>>2];r2929=r2924-r2928;r2930=r2908-r2863|0;r2931=r2930&r2865;r2932=r2876+(r2931<<2)|0;r2933=HEAPF32[r2932>>2];r2934=r2929+r2933;r2935=r2911-r2861|0;r2936=r2935&r2865;r2937=r2876+(r2936<<2)|0;r2938=HEAPF32[r2937>>2];r2939=r2934-r2938;r2940=r2935-r2863|0;r2941=r2940&r2865;r2942=r2876+(r2941<<2)|0;r2943=HEAPF32[r2942>>2];r2944=r2939+r2943;r2945=HEAP32[r2858>>2];r2946=HEAP32[r2860>>2];r2947=HEAP32[r2946>>2];r2948=__ZN9RCdecoder6decodeEP7RCmodel(r2945,r2947);r2949=r2948>>>0>19;do{if(r2949){r2950=r2948-20|0;r2951=1<<r2950;r2952=HEAP32[r2858>>2];r2953=r2950>>>0>16;if(r2953){r2954=__ZN9RCdecoder12decode_shiftEj(r2952,16);r2955=r2948-36|0;r2956=16;r2957=r2954;r2958=r2955}else{r2956=0;r2957=0;r2958=r2950}r2959=__ZN9RCdecoder12decode_shiftEj(r2952,r2958);r2960=r2959<<r2956;r2961=(HEAPF32[tempDoublePtr>>2]=r2944,HEAP32[tempDoublePtr>>2]);r2962=r2961>>>13;r2963=r2962^524287;r2964=r2963>>>18;r2965=-r2964|0;r2966=r2965>>>14;r2967=r2966^r2963;r2968=r2951+r2967|0;r2969=r2968+r2957|0;r2970=r2969+r2960|0;r2971=r2970>>>18;r2972=-r2971|0;r2973=r2972>>>14;r2974=r2973^r2970;r2975=r2974<<13;r2976=r2975^-8192;r2977=r2976}else{r2978=r2948>>>0<19;if(!r2978){r2979=(HEAPF32[tempDoublePtr>>2]=r2944,HEAP32[tempDoublePtr>>2]);r2980=r2979&-8192;r2977=r2980;break}r2981=18-r2948|0;r2982=HEAP32[r2858>>2];r2983=r2981>>>0>16;if(r2983){r2984=__ZN9RCdecoder12decode_shiftEj(r2982,16);r2985=r2981-16|0;r2986=16;r2987=r2984;r2988=r2985}else{r2986=0;r2987=0;r2988=r2981}r2989=__ZN9RCdecoder12decode_shiftEj(r2982,r2988);r2990=r2989<<r2986;r2991=(HEAPF32[tempDoublePtr>>2]=r2944,HEAP32[tempDoublePtr>>2]);r2992=r2991>>>13;r2993=r2992^524287;r2994=r2993>>>18;r2995=-r2994|0;r2996=r2995>>>14;r2997=r2996^r2993;r2998=-1<<r2981;r2999=r2998+r2997|0;r3000=r2999-r2987|0;r3001=r3000-r2990|0;r3002=r3001>>>18;r3003=-r3002|0;r3004=r3003>>>14;r3005=r3004^r3001;r3006=r3005<<13;r3007=r3006^-8192;r2977=r3007}}while(0);r3008=(HEAP32[tempDoublePtr>>2]=r2977,HEAPF32[tempDoublePtr>>2]);HEAPF32[r2910>>2]=r3008;r3009=r2908&r2865;r3010=r2876+(r3009<<2)|0;HEAPF32[r3010>>2]=r3008;r3011=r2910+4|0;r3012=r2908+1|0;r3013=r2909+1|0;r3014=r3013>>>0<r2848>>>0;if(r3014){r2908=r3012;r2909=r3013;r2910=r3011}else{r2906=r3012;r2907=r3011;break}}}r3015=r2901+1|0;r3016=r3015>>>0<r2849>>>0;if(r3016){r2900=r2906;r2901=r3015;r2902=r2907}else{r2898=r2906;r2899=r2907;break}}}r3017=r2888+1|0;r3018=r3017>>>0<r2850>>>0;if(r3018){r2887=r2898;r2888=r3017;r2889=r2899}else{break}}}r3019=(r2856|0)==0;if(!r3019){_free(r2856)}r3020=HEAP32[r18>>2];r3021=(r3020|0)==0;if(!r3021){r3022=r3020;r3023=HEAP32[r3022>>2];r3024=r3023+4|0;r3025=HEAP32[r3024>>2];FUNCTION_TABLE[r3025](r3020)}r3026=(r2875|0)==0;if(r3026){break L6}_free(r2875);break};case 20:{r3027=HEAP32[r41>>2];r3028=HEAP32[r42>>2];r3029=HEAP32[r43>>2];r3030=HEAP32[r44>>2];r3031=4;r3032=0;r3033=__Znwj(48);r3034=r3033;__ZN9RCqsmodelC2Ebjjj(r3034,0,41,16,1024);r3035=r3033;HEAP32[r17>>2]=r3035;r3036=__Znwj(12);r3037=r3036+4|0;r3038=r3037;HEAP32[r3038>>2]=r3027;r3039=r3036+8|0;r3040=r3039;HEAP32[r3040>>2]=r17;r3041=r3028+1|0;r3042=r3029+1|0;r3043=Math_imul(r3042,r3041)|0;r3044=r3043+r3041|0;r3045=r3044;while(1){r3046=r3045+1|0;r3047=r3046&r3045;r3048=(r3047|0)==0;r3049=r3046|r3045;if(r3048){break}else{r3045=r3049}}r3050=_llvm_umul_with_overflow_i32(r3046,4);r3051=tempRet0;r3052=r3051;r3053=r3050;r3054=r3052?-1:r3053;r3055=__Znwj(r3054);r3056=r3055;r3057=r3043;r3058=0;while(1){r3059=r3058+1|0;r3060=r3058&r3045;r3061=r3056+(r3060<<2)|0;HEAPF32[r3061>>2]=0;r3062=r3057-1|0;r3063=(r3062|0)==0;if(r3063){break}else{r3057=r3062;r3058=r3059}}r3064=(r3030|0)==0;if(!r3064){r3065=(r3029|0)==0;r3066=(r3028|0)==0;r3067=r3043;r3068=0;r3069=r76;while(1){r3070=r3041;r3071=r3067;while(1){r3072=r3071+1|0;r3073=r3071&r3045;r3074=r3056+(r3073<<2)|0;HEAPF32[r3074>>2]=0;r3075=r3070-1|0;r3076=(r3075|0)==0;if(r3076){break}else{r3070=r3075;r3071=r3072}}r3077=r3067+r3041|0;if(r3065){r3078=r3077;r3079=r3069}else{r3080=r3077;r3081=0;r3082=r3069;while(1){r3083=r3080&r3045;r3084=r3056+(r3083<<2)|0;HEAPF32[r3084>>2]=0;r3085=r3080+1|0;if(r3066){r3086=r3085;r3087=r3082}else{r3088=r3085;r3089=0;r3090=r3082;while(1){r3091=r3088-1|0;r3092=r3091&r3045;r3093=r3056+(r3092<<2)|0;r3094=HEAPF32[r3093>>2];r3095=r3088-r3041|0;r3096=r3095-r3043|0;r3097=r3096&r3045;r3098=r3056+(r3097<<2)|0;r3099=HEAPF32[r3098>>2];r3100=r3094-r3099;r3101=r3095&r3045;r3102=r3056+(r3101<<2)|0;r3103=HEAPF32[r3102>>2];r3104=r3100+r3103;r3105=r3091-r3043|0;r3106=r3105&r3045;r3107=r3056+(r3106<<2)|0;r3108=HEAPF32[r3107>>2];r3109=r3104-r3108;r3110=r3088-r3043|0;r3111=r3110&r3045;r3112=r3056+(r3111<<2)|0;r3113=HEAPF32[r3112>>2];r3114=r3109+r3113;r3115=r3091-r3041|0;r3116=r3115&r3045;r3117=r3056+(r3116<<2)|0;r3118=HEAPF32[r3117>>2];r3119=r3114-r3118;r3120=r3115-r3043|0;r3121=r3120&r3045;r3122=r3056+(r3121<<2)|0;r3123=HEAPF32[r3122>>2];r3124=r3119+r3123;r3125=HEAP32[r3038>>2];r3126=HEAP32[r3040>>2];r3127=HEAP32[r3126>>2];r3128=__ZN9RCdecoder6decodeEP7RCmodel(r3125,r3127);r3129=r3128>>>0>20;do{if(r3129){r3130=r3128-21|0;r3131=1<<r3130;r3132=HEAP32[r3038>>2];r3133=r3130>>>0>16;if(r3133){r3134=__ZN9RCdecoder12decode_shiftEj(r3132,16);r3135=r3128-37|0;r3136=16;r3137=r3134;r3138=r3135}else{r3136=0;r3137=0;r3138=r3130}r3139=__ZN9RCdecoder12decode_shiftEj(r3132,r3138);r3140=r3139<<r3136;r3141=(HEAPF32[tempDoublePtr>>2]=r3124,HEAP32[tempDoublePtr>>2]);r3142=r3141>>>12;r3143=r3142^1048575;r3144=r3143>>>19;r3145=-r3144|0;r3146=r3145>>>13;r3147=r3146^r3143;r3148=r3131+r3147|0;r3149=r3148+r3137|0;r3150=r3149+r3140|0;r3151=r3150>>>19;r3152=-r3151|0;r3153=r3152>>>13;r3154=r3153^r3150;r3155=r3154<<12;r3156=r3155^-4096;r3157=r3156}else{r3158=r3128>>>0<20;if(!r3158){r3159=(HEAPF32[tempDoublePtr>>2]=r3124,HEAP32[tempDoublePtr>>2]);r3160=r3159&-4096;r3157=r3160;break}r3161=19-r3128|0;r3162=HEAP32[r3038>>2];r3163=r3161>>>0>16;if(r3163){r3164=__ZN9RCdecoder12decode_shiftEj(r3162,16);r3165=r3161-16|0;r3166=16;r3167=r3164;r3168=r3165}else{r3166=0;r3167=0;r3168=r3161}r3169=__ZN9RCdecoder12decode_shiftEj(r3162,r3168);r3170=r3169<<r3166;r3171=(HEAPF32[tempDoublePtr>>2]=r3124,HEAP32[tempDoublePtr>>2]);r3172=r3171>>>12;r3173=r3172^1048575;r3174=r3173>>>19;r3175=-r3174|0;r3176=r3175>>>13;r3177=r3176^r3173;r3178=-1<<r3161;r3179=r3178+r3177|0;r3180=r3179-r3167|0;r3181=r3180-r3170|0;r3182=r3181>>>19;r3183=-r3182|0;r3184=r3183>>>13;r3185=r3184^r3181;r3186=r3185<<12;r3187=r3186^-4096;r3157=r3187}}while(0);r3188=(HEAP32[tempDoublePtr>>2]=r3157,HEAPF32[tempDoublePtr>>2]);HEAPF32[r3090>>2]=r3188;r3189=r3088&r3045;r3190=r3056+(r3189<<2)|0;HEAPF32[r3190>>2]=r3188;r3191=r3090+4|0;r3192=r3088+1|0;r3193=r3089+1|0;r3194=r3193>>>0<r3028>>>0;if(r3194){r3088=r3192;r3089=r3193;r3090=r3191}else{r3086=r3192;r3087=r3191;break}}}r3195=r3081+1|0;r3196=r3195>>>0<r3029>>>0;if(r3196){r3080=r3086;r3081=r3195;r3082=r3087}else{r3078=r3086;r3079=r3087;break}}}r3197=r3068+1|0;r3198=r3197>>>0<r3030>>>0;if(r3198){r3067=r3078;r3068=r3197;r3069=r3079}else{break}}}r3199=(r3036|0)==0;if(!r3199){_free(r3036)}r3200=HEAP32[r17>>2];r3201=(r3200|0)==0;if(!r3201){r3202=r3200;r3203=HEAP32[r3202>>2];r3204=r3203+4|0;r3205=HEAP32[r3204>>2];FUNCTION_TABLE[r3205](r3200)}r3206=(r3055|0)==0;if(r3206){break L6}_free(r3055);break};case 21:{r3207=HEAP32[r41>>2];r3208=HEAP32[r42>>2];r3209=HEAP32[r43>>2];r3210=HEAP32[r44>>2];r3211=4;r3212=0;r3213=__Znwj(48);r3214=r3213;__ZN9RCqsmodelC2Ebjjj(r3214,0,43,16,1024);r3215=r3213;HEAP32[r16>>2]=r3215;r3216=__Znwj(12);r3217=r3216+4|0;r3218=r3217;HEAP32[r3218>>2]=r3207;r3219=r3216+8|0;r3220=r3219;HEAP32[r3220>>2]=r16;r3221=r3208+1|0;r3222=r3209+1|0;r3223=Math_imul(r3222,r3221)|0;r3224=r3223+r3221|0;r3225=r3224;while(1){r3226=r3225+1|0;r3227=r3226&r3225;r3228=(r3227|0)==0;r3229=r3226|r3225;if(r3228){break}else{r3225=r3229}}r3230=_llvm_umul_with_overflow_i32(r3226,4);r3231=tempRet0;r3232=r3231;r3233=r3230;r3234=r3232?-1:r3233;r3235=__Znwj(r3234);r3236=r3235;r3237=r3223;r3238=0;while(1){r3239=r3238+1|0;r3240=r3238&r3225;r3241=r3236+(r3240<<2)|0;HEAPF32[r3241>>2]=0;r3242=r3237-1|0;r3243=(r3242|0)==0;if(r3243){break}else{r3237=r3242;r3238=r3239}}r3244=(r3210|0)==0;if(!r3244){r3245=(r3209|0)==0;r3246=(r3208|0)==0;r3247=r3223;r3248=0;r3249=r76;while(1){r3250=r3221;r3251=r3247;while(1){r3252=r3251+1|0;r3253=r3251&r3225;r3254=r3236+(r3253<<2)|0;HEAPF32[r3254>>2]=0;r3255=r3250-1|0;r3256=(r3255|0)==0;if(r3256){break}else{r3250=r3255;r3251=r3252}}r3257=r3247+r3221|0;if(r3245){r3258=r3257;r3259=r3249}else{r3260=r3257;r3261=0;r3262=r3249;while(1){r3263=r3260&r3225;r3264=r3236+(r3263<<2)|0;HEAPF32[r3264>>2]=0;r3265=r3260+1|0;if(r3246){r3266=r3265;r3267=r3262}else{r3268=r3265;r3269=0;r3270=r3262;while(1){r3271=r3268-1|0;r3272=r3271&r3225;r3273=r3236+(r3272<<2)|0;r3274=HEAPF32[r3273>>2];r3275=r3268-r3221|0;r3276=r3275-r3223|0;r3277=r3276&r3225;r3278=r3236+(r3277<<2)|0;r3279=HEAPF32[r3278>>2];r3280=r3274-r3279;r3281=r3275&r3225;r3282=r3236+(r3281<<2)|0;r3283=HEAPF32[r3282>>2];r3284=r3280+r3283;r3285=r3271-r3223|0;r3286=r3285&r3225;r3287=r3236+(r3286<<2)|0;r3288=HEAPF32[r3287>>2];r3289=r3284-r3288;r3290=r3268-r3223|0;r3291=r3290&r3225;r3292=r3236+(r3291<<2)|0;r3293=HEAPF32[r3292>>2];r3294=r3289+r3293;r3295=r3271-r3221|0;r3296=r3295&r3225;r3297=r3236+(r3296<<2)|0;r3298=HEAPF32[r3297>>2];r3299=r3294-r3298;r3300=r3295-r3223|0;r3301=r3300&r3225;r3302=r3236+(r3301<<2)|0;r3303=HEAPF32[r3302>>2];r3304=r3299+r3303;r3305=HEAP32[r3218>>2];r3306=HEAP32[r3220>>2];r3307=HEAP32[r3306>>2];r3308=__ZN9RCdecoder6decodeEP7RCmodel(r3305,r3307);r3309=r3308>>>0>21;do{if(r3309){r3310=r3308-22|0;r3311=1<<r3310;r3312=HEAP32[r3218>>2];r3313=r3310>>>0>16;if(r3313){r3314=__ZN9RCdecoder12decode_shiftEj(r3312,16);r3315=r3308-38|0;r3316=16;r3317=r3314;r3318=r3315}else{r3316=0;r3317=0;r3318=r3310}r3319=__ZN9RCdecoder12decode_shiftEj(r3312,r3318);r3320=r3319<<r3316;r3321=(HEAPF32[tempDoublePtr>>2]=r3304,HEAP32[tempDoublePtr>>2]);r3322=r3321>>>11;r3323=r3322^2097151;r3324=r3323>>>20;r3325=-r3324|0;r3326=r3325>>>12;r3327=r3326^r3323;r3328=r3311+r3327|0;r3329=r3328+r3317|0;r3330=r3329+r3320|0;r3331=r3330>>>20;r3332=-r3331|0;r3333=r3332>>>12;r3334=r3333^r3330;r3335=r3334<<11;r3336=r3335^-2048;r3337=r3336}else{r3338=r3308>>>0<21;if(!r3338){r3339=(HEAPF32[tempDoublePtr>>2]=r3304,HEAP32[tempDoublePtr>>2]);r3340=r3339&-2048;r3337=r3340;break}r3341=20-r3308|0;r3342=HEAP32[r3218>>2];r3343=r3341>>>0>16;if(r3343){r3344=__ZN9RCdecoder12decode_shiftEj(r3342,16);r3345=r3341-16|0;r3346=16;r3347=r3344;r3348=r3345}else{r3346=0;r3347=0;r3348=r3341}r3349=__ZN9RCdecoder12decode_shiftEj(r3342,r3348);r3350=r3349<<r3346;r3351=(HEAPF32[tempDoublePtr>>2]=r3304,HEAP32[tempDoublePtr>>2]);r3352=r3351>>>11;r3353=r3352^2097151;r3354=r3353>>>20;r3355=-r3354|0;r3356=r3355>>>12;r3357=r3356^r3353;r3358=-1<<r3341;r3359=r3358+r3357|0;r3360=r3359-r3347|0;r3361=r3360-r3350|0;r3362=r3361>>>20;r3363=-r3362|0;r3364=r3363>>>12;r3365=r3364^r3361;r3366=r3365<<11;r3367=r3366^-2048;r3337=r3367}}while(0);r3368=(HEAP32[tempDoublePtr>>2]=r3337,HEAPF32[tempDoublePtr>>2]);HEAPF32[r3270>>2]=r3368;r3369=r3268&r3225;r3370=r3236+(r3369<<2)|0;HEAPF32[r3370>>2]=r3368;r3371=r3270+4|0;r3372=r3268+1|0;r3373=r3269+1|0;r3374=r3373>>>0<r3208>>>0;if(r3374){r3268=r3372;r3269=r3373;r3270=r3371}else{r3266=r3372;r3267=r3371;break}}}r3375=r3261+1|0;r3376=r3375>>>0<r3209>>>0;if(r3376){r3260=r3266;r3261=r3375;r3262=r3267}else{r3258=r3266;r3259=r3267;break}}}r3377=r3248+1|0;r3378=r3377>>>0<r3210>>>0;if(r3378){r3247=r3258;r3248=r3377;r3249=r3259}else{break}}}r3379=(r3216|0)==0;if(!r3379){_free(r3216)}r3380=HEAP32[r16>>2];r3381=(r3380|0)==0;if(!r3381){r3382=r3380;r3383=HEAP32[r3382>>2];r3384=r3383+4|0;r3385=HEAP32[r3384>>2];FUNCTION_TABLE[r3385](r3380)}r3386=(r3235|0)==0;if(r3386){break L6}_free(r3235);break};case 22:{r3387=HEAP32[r41>>2];r3388=HEAP32[r42>>2];r3389=HEAP32[r43>>2];r3390=HEAP32[r44>>2];r3391=4;r3392=0;r3393=__Znwj(48);r3394=r3393;__ZN9RCqsmodelC2Ebjjj(r3394,0,45,16,1024);r3395=r3393;HEAP32[r15>>2]=r3395;r3396=__Znwj(12);r3397=r3396+4|0;r3398=r3397;HEAP32[r3398>>2]=r3387;r3399=r3396+8|0;r3400=r3399;HEAP32[r3400>>2]=r15;r3401=r3388+1|0;r3402=r3389+1|0;r3403=Math_imul(r3402,r3401)|0;r3404=r3403+r3401|0;r3405=r3404;while(1){r3406=r3405+1|0;r3407=r3406&r3405;r3408=(r3407|0)==0;r3409=r3406|r3405;if(r3408){break}else{r3405=r3409}}r3410=_llvm_umul_with_overflow_i32(r3406,4);r3411=tempRet0;r3412=r3411;r3413=r3410;r3414=r3412?-1:r3413;r3415=__Znwj(r3414);r3416=r3415;r3417=r3403;r3418=0;while(1){r3419=r3418+1|0;r3420=r3418&r3405;r3421=r3416+(r3420<<2)|0;HEAPF32[r3421>>2]=0;r3422=r3417-1|0;r3423=(r3422|0)==0;if(r3423){break}else{r3417=r3422;r3418=r3419}}r3424=(r3390|0)==0;if(!r3424){r3425=(r3389|0)==0;r3426=(r3388|0)==0;r3427=r3403;r3428=0;r3429=r76;while(1){r3430=r3401;r3431=r3427;while(1){r3432=r3431+1|0;r3433=r3431&r3405;r3434=r3416+(r3433<<2)|0;HEAPF32[r3434>>2]=0;r3435=r3430-1|0;r3436=(r3435|0)==0;if(r3436){break}else{r3430=r3435;r3431=r3432}}r3437=r3427+r3401|0;if(r3425){r3438=r3437;r3439=r3429}else{r3440=r3437;r3441=0;r3442=r3429;while(1){r3443=r3440&r3405;r3444=r3416+(r3443<<2)|0;HEAPF32[r3444>>2]=0;r3445=r3440+1|0;if(r3426){r3446=r3445;r3447=r3442}else{r3448=r3445;r3449=0;r3450=r3442;while(1){r3451=r3448-1|0;r3452=r3451&r3405;r3453=r3416+(r3452<<2)|0;r3454=HEAPF32[r3453>>2];r3455=r3448-r3401|0;r3456=r3455-r3403|0;r3457=r3456&r3405;r3458=r3416+(r3457<<2)|0;r3459=HEAPF32[r3458>>2];r3460=r3454-r3459;r3461=r3455&r3405;r3462=r3416+(r3461<<2)|0;r3463=HEAPF32[r3462>>2];r3464=r3460+r3463;r3465=r3451-r3403|0;r3466=r3465&r3405;r3467=r3416+(r3466<<2)|0;r3468=HEAPF32[r3467>>2];r3469=r3464-r3468;r3470=r3448-r3403|0;r3471=r3470&r3405;r3472=r3416+(r3471<<2)|0;r3473=HEAPF32[r3472>>2];r3474=r3469+r3473;r3475=r3451-r3401|0;r3476=r3475&r3405;r3477=r3416+(r3476<<2)|0;r3478=HEAPF32[r3477>>2];r3479=r3474-r3478;r3480=r3475-r3403|0;r3481=r3480&r3405;r3482=r3416+(r3481<<2)|0;r3483=HEAPF32[r3482>>2];r3484=r3479+r3483;r3485=HEAP32[r3398>>2];r3486=HEAP32[r3400>>2];r3487=HEAP32[r3486>>2];r3488=__ZN9RCdecoder6decodeEP7RCmodel(r3485,r3487);r3489=r3488>>>0>22;do{if(r3489){r3490=r3488-23|0;r3491=1<<r3490;r3492=HEAP32[r3398>>2];r3493=r3490>>>0>16;if(r3493){r3494=__ZN9RCdecoder12decode_shiftEj(r3492,16);r3495=r3488-39|0;r3496=16;r3497=r3494;r3498=r3495}else{r3496=0;r3497=0;r3498=r3490}r3499=__ZN9RCdecoder12decode_shiftEj(r3492,r3498);r3500=r3499<<r3496;r3501=(HEAPF32[tempDoublePtr>>2]=r3484,HEAP32[tempDoublePtr>>2]);r3502=r3501>>>10;r3503=r3502^4194303;r3504=r3503>>>21;r3505=-r3504|0;r3506=r3505>>>11;r3507=r3506^r3503;r3508=r3491+r3507|0;r3509=r3508+r3497|0;r3510=r3509+r3500|0;r3511=r3510>>>21;r3512=-r3511|0;r3513=r3512>>>11;r3514=r3513^r3510;r3515=r3514<<10;r3516=r3515^-1024;r3517=r3516}else{r3518=r3488>>>0<22;if(!r3518){r3519=(HEAPF32[tempDoublePtr>>2]=r3484,HEAP32[tempDoublePtr>>2]);r3520=r3519&-1024;r3517=r3520;break}r3521=21-r3488|0;r3522=HEAP32[r3398>>2];r3523=r3521>>>0>16;if(r3523){r3524=__ZN9RCdecoder12decode_shiftEj(r3522,16);r3525=r3521-16|0;r3526=16;r3527=r3524;r3528=r3525}else{r3526=0;r3527=0;r3528=r3521}r3529=__ZN9RCdecoder12decode_shiftEj(r3522,r3528);r3530=r3529<<r3526;r3531=(HEAPF32[tempDoublePtr>>2]=r3484,HEAP32[tempDoublePtr>>2]);r3532=r3531>>>10;r3533=r3532^4194303;r3534=r3533>>>21;r3535=-r3534|0;r3536=r3535>>>11;r3537=r3536^r3533;r3538=-1<<r3521;r3539=r3538+r3537|0;r3540=r3539-r3527|0;r3541=r3540-r3530|0;r3542=r3541>>>21;r3543=-r3542|0;r3544=r3543>>>11;r3545=r3544^r3541;r3546=r3545<<10;r3547=r3546^-1024;r3517=r3547}}while(0);r3548=(HEAP32[tempDoublePtr>>2]=r3517,HEAPF32[tempDoublePtr>>2]);HEAPF32[r3450>>2]=r3548;r3549=r3448&r3405;r3550=r3416+(r3549<<2)|0;HEAPF32[r3550>>2]=r3548;r3551=r3450+4|0;r3552=r3448+1|0;r3553=r3449+1|0;r3554=r3553>>>0<r3388>>>0;if(r3554){r3448=r3552;r3449=r3553;r3450=r3551}else{r3446=r3552;r3447=r3551;break}}}r3555=r3441+1|0;r3556=r3555>>>0<r3389>>>0;if(r3556){r3440=r3446;r3441=r3555;r3442=r3447}else{r3438=r3446;r3439=r3447;break}}}r3557=r3428+1|0;r3558=r3557>>>0<r3390>>>0;if(r3558){r3427=r3438;r3428=r3557;r3429=r3439}else{break}}}r3559=(r3396|0)==0;if(!r3559){_free(r3396)}r3560=HEAP32[r15>>2];r3561=(r3560|0)==0;if(!r3561){r3562=r3560;r3563=HEAP32[r3562>>2];r3564=r3563+4|0;r3565=HEAP32[r3564>>2];FUNCTION_TABLE[r3565](r3560)}r3566=(r3415|0)==0;if(r3566){break L6}_free(r3415);break};case 23:{r3567=HEAP32[r41>>2];r3568=HEAP32[r42>>2];r3569=HEAP32[r43>>2];r3570=HEAP32[r44>>2];r3571=4;r3572=0;r3573=__Znwj(48);r3574=r3573;__ZN9RCqsmodelC2Ebjjj(r3574,0,47,16,1024);r3575=r3573;HEAP32[r14>>2]=r3575;r3576=__Znwj(12);r3577=r3576+4|0;r3578=r3577;HEAP32[r3578>>2]=r3567;r3579=r3576+8|0;r3580=r3579;HEAP32[r3580>>2]=r14;r3581=r3568+1|0;r3582=r3569+1|0;r3583=Math_imul(r3582,r3581)|0;r3584=r3583+r3581|0;r3585=r3584;while(1){r3586=r3585+1|0;r3587=r3586&r3585;r3588=(r3587|0)==0;r3589=r3586|r3585;if(r3588){break}else{r3585=r3589}}r3590=_llvm_umul_with_overflow_i32(r3586,4);r3591=tempRet0;r3592=r3591;r3593=r3590;r3594=r3592?-1:r3593;r3595=__Znwj(r3594);r3596=r3595;r3597=r3583;r3598=0;while(1){r3599=r3598+1|0;r3600=r3598&r3585;r3601=r3596+(r3600<<2)|0;HEAPF32[r3601>>2]=0;r3602=r3597-1|0;r3603=(r3602|0)==0;if(r3603){break}else{r3597=r3602;r3598=r3599}}r3604=(r3570|0)==0;if(!r3604){r3605=(r3569|0)==0;r3606=(r3568|0)==0;r3607=r3583;r3608=0;r3609=r76;while(1){r3610=r3581;r3611=r3607;while(1){r3612=r3611+1|0;r3613=r3611&r3585;r3614=r3596+(r3613<<2)|0;HEAPF32[r3614>>2]=0;r3615=r3610-1|0;r3616=(r3615|0)==0;if(r3616){break}else{r3610=r3615;r3611=r3612}}r3617=r3607+r3581|0;if(r3605){r3618=r3617;r3619=r3609}else{r3620=r3617;r3621=0;r3622=r3609;while(1){r3623=r3620&r3585;r3624=r3596+(r3623<<2)|0;HEAPF32[r3624>>2]=0;r3625=r3620+1|0;if(r3606){r3626=r3625;r3627=r3622}else{r3628=r3625;r3629=0;r3630=r3622;while(1){r3631=r3628-1|0;r3632=r3631&r3585;r3633=r3596+(r3632<<2)|0;r3634=HEAPF32[r3633>>2];r3635=r3628-r3581|0;r3636=r3635-r3583|0;r3637=r3636&r3585;r3638=r3596+(r3637<<2)|0;r3639=HEAPF32[r3638>>2];r3640=r3634-r3639;r3641=r3635&r3585;r3642=r3596+(r3641<<2)|0;r3643=HEAPF32[r3642>>2];r3644=r3640+r3643;r3645=r3631-r3583|0;r3646=r3645&r3585;r3647=r3596+(r3646<<2)|0;r3648=HEAPF32[r3647>>2];r3649=r3644-r3648;r3650=r3628-r3583|0;r3651=r3650&r3585;r3652=r3596+(r3651<<2)|0;r3653=HEAPF32[r3652>>2];r3654=r3649+r3653;r3655=r3631-r3581|0;r3656=r3655&r3585;r3657=r3596+(r3656<<2)|0;r3658=HEAPF32[r3657>>2];r3659=r3654-r3658;r3660=r3655-r3583|0;r3661=r3660&r3585;r3662=r3596+(r3661<<2)|0;r3663=HEAPF32[r3662>>2];r3664=r3659+r3663;r3665=HEAP32[r3578>>2];r3666=HEAP32[r3580>>2];r3667=HEAP32[r3666>>2];r3668=__ZN9RCdecoder6decodeEP7RCmodel(r3665,r3667);r3669=r3668>>>0>23;do{if(r3669){r3670=r3668-24|0;r3671=1<<r3670;r3672=HEAP32[r3578>>2];r3673=r3670>>>0>16;if(r3673){r3674=__ZN9RCdecoder12decode_shiftEj(r3672,16);r3675=r3668-40|0;r3676=16;r3677=r3674;r3678=r3675}else{r3676=0;r3677=0;r3678=r3670}r3679=__ZN9RCdecoder12decode_shiftEj(r3672,r3678);r3680=r3679<<r3676;r3681=(HEAPF32[tempDoublePtr>>2]=r3664,HEAP32[tempDoublePtr>>2]);r3682=r3681>>>9;r3683=r3682^8388607;r3684=r3683>>>22;r3685=-r3684|0;r3686=r3685>>>10;r3687=r3686^r3683;r3688=r3671+r3687|0;r3689=r3688+r3677|0;r3690=r3689+r3680|0;r3691=r3690>>>22;r3692=-r3691|0;r3693=r3692>>>10;r3694=r3693^r3690;r3695=r3694<<9;r3696=r3695^-512;r3697=r3696}else{r3698=r3668>>>0<23;if(!r3698){r3699=(HEAPF32[tempDoublePtr>>2]=r3664,HEAP32[tempDoublePtr>>2]);r3700=r3699&-512;r3697=r3700;break}r3701=22-r3668|0;r3702=HEAP32[r3578>>2];r3703=r3701>>>0>16;if(r3703){r3704=__ZN9RCdecoder12decode_shiftEj(r3702,16);r3705=r3701-16|0;r3706=16;r3707=r3704;r3708=r3705}else{r3706=0;r3707=0;r3708=r3701}r3709=__ZN9RCdecoder12decode_shiftEj(r3702,r3708);r3710=r3709<<r3706;r3711=(HEAPF32[tempDoublePtr>>2]=r3664,HEAP32[tempDoublePtr>>2]);r3712=r3711>>>9;r3713=r3712^8388607;r3714=r3713>>>22;r3715=-r3714|0;r3716=r3715>>>10;r3717=r3716^r3713;r3718=-1<<r3701;r3719=r3718+r3717|0;r3720=r3719-r3707|0;r3721=r3720-r3710|0;r3722=r3721>>>22;r3723=-r3722|0;r3724=r3723>>>10;r3725=r3724^r3721;r3726=r3725<<9;r3727=r3726^-512;r3697=r3727}}while(0);r3728=(HEAP32[tempDoublePtr>>2]=r3697,HEAPF32[tempDoublePtr>>2]);HEAPF32[r3630>>2]=r3728;r3729=r3628&r3585;r3730=r3596+(r3729<<2)|0;HEAPF32[r3730>>2]=r3728;r3731=r3630+4|0;r3732=r3628+1|0;r3733=r3629+1|0;r3734=r3733>>>0<r3568>>>0;if(r3734){r3628=r3732;r3629=r3733;r3630=r3731}else{r3626=r3732;r3627=r3731;break}}}r3735=r3621+1|0;r3736=r3735>>>0<r3569>>>0;if(r3736){r3620=r3626;r3621=r3735;r3622=r3627}else{r3618=r3626;r3619=r3627;break}}}r3737=r3608+1|0;r3738=r3737>>>0<r3570>>>0;if(r3738){r3607=r3618;r3608=r3737;r3609=r3619}else{break}}}r3739=(r3576|0)==0;if(!r3739){_free(r3576)}r3740=HEAP32[r14>>2];r3741=(r3740|0)==0;if(!r3741){r3742=r3740;r3743=HEAP32[r3742>>2];r3744=r3743+4|0;r3745=HEAP32[r3744>>2];FUNCTION_TABLE[r3745](r3740)}r3746=(r3595|0)==0;if(r3746){break L6}_free(r3595);break};case 24:{r3747=HEAP32[r41>>2];r3748=HEAP32[r42>>2];r3749=HEAP32[r43>>2];r3750=HEAP32[r44>>2];r3751=4;r3752=0;r3753=__Znwj(48);r3754=r3753;__ZN9RCqsmodelC2Ebjjj(r3754,0,49,16,1024);r3755=r3753;HEAP32[r13>>2]=r3755;r3756=__Znwj(12);r3757=r3756+4|0;r3758=r3757;HEAP32[r3758>>2]=r3747;r3759=r3756+8|0;r3760=r3759;HEAP32[r3760>>2]=r13;r3761=r3748+1|0;r3762=r3749+1|0;r3763=Math_imul(r3762,r3761)|0;r3764=r3763+r3761|0;r3765=r3764;while(1){r3766=r3765+1|0;r3767=r3766&r3765;r3768=(r3767|0)==0;r3769=r3766|r3765;if(r3768){break}else{r3765=r3769}}r3770=_llvm_umul_with_overflow_i32(r3766,4);r3771=tempRet0;r3772=r3771;r3773=r3770;r3774=r3772?-1:r3773;r3775=__Znwj(r3774);r3776=r3775;r3777=r3763;r3778=0;while(1){r3779=r3778+1|0;r3780=r3778&r3765;r3781=r3776+(r3780<<2)|0;HEAPF32[r3781>>2]=0;r3782=r3777-1|0;r3783=(r3782|0)==0;if(r3783){break}else{r3777=r3782;r3778=r3779}}r3784=(r3750|0)==0;if(!r3784){r3785=(r3749|0)==0;r3786=(r3748|0)==0;r3787=r3763;r3788=0;r3789=r76;while(1){r3790=r3761;r3791=r3787;while(1){r3792=r3791+1|0;r3793=r3791&r3765;r3794=r3776+(r3793<<2)|0;HEAPF32[r3794>>2]=0;r3795=r3790-1|0;r3796=(r3795|0)==0;if(r3796){break}else{r3790=r3795;r3791=r3792}}r3797=r3787+r3761|0;if(r3785){r3798=r3797;r3799=r3789}else{r3800=r3797;r3801=0;r3802=r3789;while(1){r3803=r3800&r3765;r3804=r3776+(r3803<<2)|0;HEAPF32[r3804>>2]=0;r3805=r3800+1|0;if(r3786){r3806=r3805;r3807=r3802}else{r3808=r3805;r3809=0;r3810=r3802;while(1){r3811=r3808-1|0;r3812=r3811&r3765;r3813=r3776+(r3812<<2)|0;r3814=HEAPF32[r3813>>2];r3815=r3808-r3761|0;r3816=r3815-r3763|0;r3817=r3816&r3765;r3818=r3776+(r3817<<2)|0;r3819=HEAPF32[r3818>>2];r3820=r3814-r3819;r3821=r3815&r3765;r3822=r3776+(r3821<<2)|0;r3823=HEAPF32[r3822>>2];r3824=r3820+r3823;r3825=r3811-r3763|0;r3826=r3825&r3765;r3827=r3776+(r3826<<2)|0;r3828=HEAPF32[r3827>>2];r3829=r3824-r3828;r3830=r3808-r3763|0;r3831=r3830&r3765;r3832=r3776+(r3831<<2)|0;r3833=HEAPF32[r3832>>2];r3834=r3829+r3833;r3835=r3811-r3761|0;r3836=r3835&r3765;r3837=r3776+(r3836<<2)|0;r3838=HEAPF32[r3837>>2];r3839=r3834-r3838;r3840=r3835-r3763|0;r3841=r3840&r3765;r3842=r3776+(r3841<<2)|0;r3843=HEAPF32[r3842>>2];r3844=r3839+r3843;r3845=HEAP32[r3758>>2];r3846=HEAP32[r3760>>2];r3847=HEAP32[r3846>>2];r3848=__ZN9RCdecoder6decodeEP7RCmodel(r3845,r3847);r3849=r3848>>>0>24;do{if(r3849){r3850=r3848-25|0;r3851=1<<r3850;r3852=HEAP32[r3758>>2];r3853=r3850>>>0>16;if(r3853){r3854=__ZN9RCdecoder12decode_shiftEj(r3852,16);r3855=r3848-41|0;r3856=16;r3857=r3854;r3858=r3855}else{r3856=0;r3857=0;r3858=r3850}r3859=__ZN9RCdecoder12decode_shiftEj(r3852,r3858);r3860=r3859<<r3856;r3861=(HEAPF32[tempDoublePtr>>2]=r3844,HEAP32[tempDoublePtr>>2]);r3862=r3861>>>8;r3863=r3862^16777215;r3864=r3863>>>23;r3865=-r3864|0;r3866=r3865>>>9;r3867=r3866^r3863;r3868=r3851+r3867|0;r3869=r3868+r3857|0;r3870=r3869+r3860|0;r3871=r3870>>>23;r3872=-r3871|0;r3873=r3872>>>9;r3874=r3873^r3870;r3875=r3874<<8;r3876=r3875^-256;r3877=r3876}else{r3878=r3848>>>0<24;if(!r3878){r3879=(HEAPF32[tempDoublePtr>>2]=r3844,HEAP32[tempDoublePtr>>2]);r3880=r3879&-256;r3877=r3880;break}r3881=23-r3848|0;r3882=HEAP32[r3758>>2];r3883=r3881>>>0>16;if(r3883){r3884=__ZN9RCdecoder12decode_shiftEj(r3882,16);r3885=r3881-16|0;r3886=16;r3887=r3884;r3888=r3885}else{r3886=0;r3887=0;r3888=r3881}r3889=__ZN9RCdecoder12decode_shiftEj(r3882,r3888);r3890=r3889<<r3886;r3891=(HEAPF32[tempDoublePtr>>2]=r3844,HEAP32[tempDoublePtr>>2]);r3892=r3891>>>8;r3893=r3892^16777215;r3894=r3893>>>23;r3895=-r3894|0;r3896=r3895>>>9;r3897=r3896^r3893;r3898=-1<<r3881;r3899=r3898+r3897|0;r3900=r3899-r3887|0;r3901=r3900-r3890|0;r3902=r3901>>>23;r3903=-r3902|0;r3904=r3903>>>9;r3905=r3904^r3901;r3906=r3905<<8;r3907=r3906^-256;r3877=r3907}}while(0);r3908=(HEAP32[tempDoublePtr>>2]=r3877,HEAPF32[tempDoublePtr>>2]);HEAPF32[r3810>>2]=r3908;r3909=r3808&r3765;r3910=r3776+(r3909<<2)|0;HEAPF32[r3910>>2]=r3908;r3911=r3810+4|0;r3912=r3808+1|0;r3913=r3809+1|0;r3914=r3913>>>0<r3748>>>0;if(r3914){r3808=r3912;r3809=r3913;r3810=r3911}else{r3806=r3912;r3807=r3911;break}}}r3915=r3801+1|0;r3916=r3915>>>0<r3749>>>0;if(r3916){r3800=r3806;r3801=r3915;r3802=r3807}else{r3798=r3806;r3799=r3807;break}}}r3917=r3788+1|0;r3918=r3917>>>0<r3750>>>0;if(r3918){r3787=r3798;r3788=r3917;r3789=r3799}else{break}}}r3919=(r3756|0)==0;if(!r3919){_free(r3756)}r3920=HEAP32[r13>>2];r3921=(r3920|0)==0;if(!r3921){r3922=r3920;r3923=HEAP32[r3922>>2];r3924=r3923+4|0;r3925=HEAP32[r3924>>2];FUNCTION_TABLE[r3925](r3920)}r3926=(r3775|0)==0;if(r3926){break L6}_free(r3775);break};case 25:{r3927=HEAP32[r41>>2];r3928=HEAP32[r42>>2];r3929=HEAP32[r43>>2];r3930=HEAP32[r44>>2];r3931=4;r3932=0;r3933=__Znwj(48);r3934=r3933;__ZN9RCqsmodelC2Ebjjj(r3934,0,51,16,1024);r3935=r3933;HEAP32[r12>>2]=r3935;r3936=__Znwj(12);r3937=r3936+4|0;r3938=r3937;HEAP32[r3938>>2]=r3927;r3939=r3936+8|0;r3940=r3939;HEAP32[r3940>>2]=r12;r3941=r3928+1|0;r3942=r3929+1|0;r3943=Math_imul(r3942,r3941)|0;r3944=r3943+r3941|0;r3945=r3944;while(1){r3946=r3945+1|0;r3947=r3946&r3945;r3948=(r3947|0)==0;r3949=r3946|r3945;if(r3948){break}else{r3945=r3949}}r3950=_llvm_umul_with_overflow_i32(r3946,4);r3951=tempRet0;r3952=r3951;r3953=r3950;r3954=r3952?-1:r3953;r3955=__Znwj(r3954);r3956=r3955;r3957=r3943;r3958=0;while(1){r3959=r3958+1|0;r3960=r3958&r3945;r3961=r3956+(r3960<<2)|0;HEAPF32[r3961>>2]=0;r3962=r3957-1|0;r3963=(r3962|0)==0;if(r3963){break}else{r3957=r3962;r3958=r3959}}r3964=(r3930|0)==0;if(!r3964){r3965=(r3929|0)==0;r3966=(r3928|0)==0;r3967=r3943;r3968=0;r3969=r76;while(1){r3970=r3941;r3971=r3967;while(1){r3972=r3971+1|0;r3973=r3971&r3945;r3974=r3956+(r3973<<2)|0;HEAPF32[r3974>>2]=0;r3975=r3970-1|0;r3976=(r3975|0)==0;if(r3976){break}else{r3970=r3975;r3971=r3972}}r3977=r3967+r3941|0;if(r3965){r3978=r3977;r3979=r3969}else{r3980=r3977;r3981=0;r3982=r3969;while(1){r3983=r3980&r3945;r3984=r3956+(r3983<<2)|0;HEAPF32[r3984>>2]=0;r3985=r3980+1|0;if(r3966){r3986=r3985;r3987=r3982}else{r3988=r3985;r3989=0;r3990=r3982;while(1){r3991=r3988-1|0;r3992=r3991&r3945;r3993=r3956+(r3992<<2)|0;r3994=HEAPF32[r3993>>2];r3995=r3988-r3941|0;r3996=r3995-r3943|0;r3997=r3996&r3945;r3998=r3956+(r3997<<2)|0;r3999=HEAPF32[r3998>>2];r4000=r3994-r3999;r4001=r3995&r3945;r4002=r3956+(r4001<<2)|0;r4003=HEAPF32[r4002>>2];r4004=r4000+r4003;r4005=r3991-r3943|0;r4006=r4005&r3945;r4007=r3956+(r4006<<2)|0;r4008=HEAPF32[r4007>>2];r4009=r4004-r4008;r4010=r3988-r3943|0;r4011=r4010&r3945;r4012=r3956+(r4011<<2)|0;r4013=HEAPF32[r4012>>2];r4014=r4009+r4013;r4015=r3991-r3941|0;r4016=r4015&r3945;r4017=r3956+(r4016<<2)|0;r4018=HEAPF32[r4017>>2];r4019=r4014-r4018;r4020=r4015-r3943|0;r4021=r4020&r3945;r4022=r3956+(r4021<<2)|0;r4023=HEAPF32[r4022>>2];r4024=r4019+r4023;r4025=HEAP32[r3938>>2];r4026=HEAP32[r3940>>2];r4027=HEAP32[r4026>>2];r4028=__ZN9RCdecoder6decodeEP7RCmodel(r4025,r4027);r4029=r4028>>>0>25;do{if(r4029){r4030=r4028-26|0;r4031=1<<r4030;r4032=HEAP32[r3938>>2];r4033=r4030>>>0>16;if(r4033){r4034=__ZN9RCdecoder12decode_shiftEj(r4032,16);r4035=r4028-42|0;r4036=16;r4037=r4034;r4038=r4035}else{r4036=0;r4037=0;r4038=r4030}r4039=__ZN9RCdecoder12decode_shiftEj(r4032,r4038);r4040=r4039<<r4036;r4041=(HEAPF32[tempDoublePtr>>2]=r4024,HEAP32[tempDoublePtr>>2]);r4042=r4041>>>7;r4043=r4042^33554431;r4044=r4043>>>24;r4045=-r4044|0;r4046=r4045>>>8;r4047=r4046^r4043;r4048=r4031+r4047|0;r4049=r4048+r4037|0;r4050=r4049+r4040|0;r4051=r4050>>>24;r4052=-r4051|0;r4053=r4052>>>8;r4054=r4053^r4050;r4055=r4054<<7;r4056=r4055^-128;r4057=r4056}else{r4058=r4028>>>0<25;if(!r4058){r4059=(HEAPF32[tempDoublePtr>>2]=r4024,HEAP32[tempDoublePtr>>2]);r4060=r4059&-128;r4057=r4060;break}r4061=24-r4028|0;r4062=HEAP32[r3938>>2];r4063=r4061>>>0>16;if(r4063){r4064=__ZN9RCdecoder12decode_shiftEj(r4062,16);r4065=r4061-16|0;r4066=16;r4067=r4064;r4068=r4065}else{r4066=0;r4067=0;r4068=r4061}r4069=__ZN9RCdecoder12decode_shiftEj(r4062,r4068);r4070=r4069<<r4066;r4071=(HEAPF32[tempDoublePtr>>2]=r4024,HEAP32[tempDoublePtr>>2]);r4072=r4071>>>7;r4073=r4072^33554431;r4074=r4073>>>24;r4075=-r4074|0;r4076=r4075>>>8;r4077=r4076^r4073;r4078=-1<<r4061;r4079=r4078+r4077|0;r4080=r4079-r4067|0;r4081=r4080-r4070|0;r4082=r4081>>>24;r4083=-r4082|0;r4084=r4083>>>8;r4085=r4084^r4081;r4086=r4085<<7;r4087=r4086^-128;r4057=r4087}}while(0);r4088=(HEAP32[tempDoublePtr>>2]=r4057,HEAPF32[tempDoublePtr>>2]);HEAPF32[r3990>>2]=r4088;r4089=r3988&r3945;r4090=r3956+(r4089<<2)|0;HEAPF32[r4090>>2]=r4088;r4091=r3990+4|0;r4092=r3988+1|0;r4093=r3989+1|0;r4094=r4093>>>0<r3928>>>0;if(r4094){r3988=r4092;r3989=r4093;r3990=r4091}else{r3986=r4092;r3987=r4091;break}}}r4095=r3981+1|0;r4096=r4095>>>0<r3929>>>0;if(r4096){r3980=r3986;r3981=r4095;r3982=r3987}else{r3978=r3986;r3979=r3987;break}}}r4097=r3968+1|0;r4098=r4097>>>0<r3930>>>0;if(r4098){r3967=r3978;r3968=r4097;r3969=r3979}else{break}}}r4099=(r3936|0)==0;if(!r4099){_free(r3936)}r4100=HEAP32[r12>>2];r4101=(r4100|0)==0;if(!r4101){r4102=r4100;r4103=HEAP32[r4102>>2];r4104=r4103+4|0;r4105=HEAP32[r4104>>2];FUNCTION_TABLE[r4105](r4100)}r4106=(r3955|0)==0;if(r4106){break L6}_free(r3955);break};case 26:{r4107=HEAP32[r41>>2];r4108=HEAP32[r42>>2];r4109=HEAP32[r43>>2];r4110=HEAP32[r44>>2];r4111=4;r4112=0;r4113=__Znwj(48);r4114=r4113;__ZN9RCqsmodelC2Ebjjj(r4114,0,53,16,1024);r4115=r4113;HEAP32[r11>>2]=r4115;r4116=__Znwj(12);r4117=r4116+4|0;r4118=r4117;HEAP32[r4118>>2]=r4107;r4119=r4116+8|0;r4120=r4119;HEAP32[r4120>>2]=r11;r4121=r4108+1|0;r4122=r4109+1|0;r4123=Math_imul(r4122,r4121)|0;r4124=r4123+r4121|0;r4125=r4124;while(1){r4126=r4125+1|0;r4127=r4126&r4125;r4128=(r4127|0)==0;r4129=r4126|r4125;if(r4128){break}else{r4125=r4129}}r4130=_llvm_umul_with_overflow_i32(r4126,4);r4131=tempRet0;r4132=r4131;r4133=r4130;r4134=r4132?-1:r4133;r4135=__Znwj(r4134);r4136=r4135;r4137=r4123;r4138=0;while(1){r4139=r4138+1|0;r4140=r4138&r4125;r4141=r4136+(r4140<<2)|0;HEAPF32[r4141>>2]=0;r4142=r4137-1|0;r4143=(r4142|0)==0;if(r4143){break}else{r4137=r4142;r4138=r4139}}r4144=(r4110|0)==0;if(!r4144){r4145=(r4109|0)==0;r4146=(r4108|0)==0;r4147=r4123;r4148=0;r4149=r76;while(1){r4150=r4121;r4151=r4147;while(1){r4152=r4151+1|0;r4153=r4151&r4125;r4154=r4136+(r4153<<2)|0;HEAPF32[r4154>>2]=0;r4155=r4150-1|0;r4156=(r4155|0)==0;if(r4156){break}else{r4150=r4155;r4151=r4152}}r4157=r4147+r4121|0;if(r4145){r4158=r4157;r4159=r4149}else{r4160=r4157;r4161=0;r4162=r4149;while(1){r4163=r4160&r4125;r4164=r4136+(r4163<<2)|0;HEAPF32[r4164>>2]=0;r4165=r4160+1|0;if(r4146){r4166=r4165;r4167=r4162}else{r4168=r4165;r4169=0;r4170=r4162;while(1){r4171=r4168-1|0;r4172=r4171&r4125;r4173=r4136+(r4172<<2)|0;r4174=HEAPF32[r4173>>2];r4175=r4168-r4121|0;r4176=r4175-r4123|0;r4177=r4176&r4125;r4178=r4136+(r4177<<2)|0;r4179=HEAPF32[r4178>>2];r4180=r4174-r4179;r4181=r4175&r4125;r4182=r4136+(r4181<<2)|0;r4183=HEAPF32[r4182>>2];r4184=r4180+r4183;r4185=r4171-r4123|0;r4186=r4185&r4125;r4187=r4136+(r4186<<2)|0;r4188=HEAPF32[r4187>>2];r4189=r4184-r4188;r4190=r4168-r4123|0;r4191=r4190&r4125;r4192=r4136+(r4191<<2)|0;r4193=HEAPF32[r4192>>2];r4194=r4189+r4193;r4195=r4171-r4121|0;r4196=r4195&r4125;r4197=r4136+(r4196<<2)|0;r4198=HEAPF32[r4197>>2];r4199=r4194-r4198;r4200=r4195-r4123|0;r4201=r4200&r4125;r4202=r4136+(r4201<<2)|0;r4203=HEAPF32[r4202>>2];r4204=r4199+r4203;r4205=HEAP32[r4118>>2];r4206=HEAP32[r4120>>2];r4207=HEAP32[r4206>>2];r4208=__ZN9RCdecoder6decodeEP7RCmodel(r4205,r4207);r4209=r4208>>>0>26;do{if(r4209){r4210=r4208-27|0;r4211=1<<r4210;r4212=HEAP32[r4118>>2];r4213=r4210>>>0>16;if(r4213){r4214=__ZN9RCdecoder12decode_shiftEj(r4212,16);r4215=r4208-43|0;r4216=16;r4217=r4214;r4218=r4215}else{r4216=0;r4217=0;r4218=r4210}r4219=__ZN9RCdecoder12decode_shiftEj(r4212,r4218);r4220=r4219<<r4216;r4221=(HEAPF32[tempDoublePtr>>2]=r4204,HEAP32[tempDoublePtr>>2]);r4222=r4221>>>6;r4223=r4222^67108863;r4224=r4223>>>25;r4225=-r4224|0;r4226=r4225>>>7;r4227=r4226^r4223;r4228=r4211+r4227|0;r4229=r4228+r4217|0;r4230=r4229+r4220|0;r4231=r4230>>>25;r4232=-r4231|0;r4233=r4232>>>7;r4234=r4233^r4230;r4235=r4234<<6;r4236=r4235^-64;r4237=r4236}else{r4238=r4208>>>0<26;if(!r4238){r4239=(HEAPF32[tempDoublePtr>>2]=r4204,HEAP32[tempDoublePtr>>2]);r4240=r4239&-64;r4237=r4240;break}r4241=25-r4208|0;r4242=HEAP32[r4118>>2];r4243=r4241>>>0>16;if(r4243){r4244=__ZN9RCdecoder12decode_shiftEj(r4242,16);r4245=r4241-16|0;r4246=16;r4247=r4244;r4248=r4245}else{r4246=0;r4247=0;r4248=r4241}r4249=__ZN9RCdecoder12decode_shiftEj(r4242,r4248);r4250=r4249<<r4246;r4251=(HEAPF32[tempDoublePtr>>2]=r4204,HEAP32[tempDoublePtr>>2]);r4252=r4251>>>6;r4253=r4252^67108863;r4254=r4253>>>25;r4255=-r4254|0;r4256=r4255>>>7;r4257=r4256^r4253;r4258=-1<<r4241;r4259=r4258+r4257|0;r4260=r4259-r4247|0;r4261=r4260-r4250|0;r4262=r4261>>>25;r4263=-r4262|0;r4264=r4263>>>7;r4265=r4264^r4261;r4266=r4265<<6;r4267=r4266^-64;r4237=r4267}}while(0);r4268=(HEAP32[tempDoublePtr>>2]=r4237,HEAPF32[tempDoublePtr>>2]);HEAPF32[r4170>>2]=r4268;r4269=r4168&r4125;r4270=r4136+(r4269<<2)|0;HEAPF32[r4270>>2]=r4268;r4271=r4170+4|0;r4272=r4168+1|0;r4273=r4169+1|0;r4274=r4273>>>0<r4108>>>0;if(r4274){r4168=r4272;r4169=r4273;r4170=r4271}else{r4166=r4272;r4167=r4271;break}}}r4275=r4161+1|0;r4276=r4275>>>0<r4109>>>0;if(r4276){r4160=r4166;r4161=r4275;r4162=r4167}else{r4158=r4166;r4159=r4167;break}}}r4277=r4148+1|0;r4278=r4277>>>0<r4110>>>0;if(r4278){r4147=r4158;r4148=r4277;r4149=r4159}else{break}}}r4279=(r4116|0)==0;if(!r4279){_free(r4116)}r4280=HEAP32[r11>>2];r4281=(r4280|0)==0;if(!r4281){r4282=r4280;r4283=HEAP32[r4282>>2];r4284=r4283+4|0;r4285=HEAP32[r4284>>2];FUNCTION_TABLE[r4285](r4280)}r4286=(r4135|0)==0;if(r4286){break L6}_free(r4135);break};case 27:{r4287=HEAP32[r41>>2];r4288=HEAP32[r42>>2];r4289=HEAP32[r43>>2];r4290=HEAP32[r44>>2];r4291=4;r4292=0;r4293=__Znwj(48);r4294=r4293;__ZN9RCqsmodelC2Ebjjj(r4294,0,55,16,1024);r4295=r4293;HEAP32[r10>>2]=r4295;r4296=__Znwj(12);r4297=r4296+4|0;r4298=r4297;HEAP32[r4298>>2]=r4287;r4299=r4296+8|0;r4300=r4299;HEAP32[r4300>>2]=r10;r4301=r4288+1|0;r4302=r4289+1|0;r4303=Math_imul(r4302,r4301)|0;r4304=r4303+r4301|0;r4305=r4304;while(1){r4306=r4305+1|0;r4307=r4306&r4305;r4308=(r4307|0)==0;r4309=r4306|r4305;if(r4308){break}else{r4305=r4309}}r4310=_llvm_umul_with_overflow_i32(r4306,4);r4311=tempRet0;r4312=r4311;r4313=r4310;r4314=r4312?-1:r4313;r4315=__Znwj(r4314);r4316=r4315;r4317=r4303;r4318=0;while(1){r4319=r4318+1|0;r4320=r4318&r4305;r4321=r4316+(r4320<<2)|0;HEAPF32[r4321>>2]=0;r4322=r4317-1|0;r4323=(r4322|0)==0;if(r4323){break}else{r4317=r4322;r4318=r4319}}r4324=(r4290|0)==0;if(!r4324){r4325=(r4289|0)==0;r4326=(r4288|0)==0;r4327=r4303;r4328=0;r4329=r76;while(1){r4330=r4301;r4331=r4327;while(1){r4332=r4331+1|0;r4333=r4331&r4305;r4334=r4316+(r4333<<2)|0;HEAPF32[r4334>>2]=0;r4335=r4330-1|0;r4336=(r4335|0)==0;if(r4336){break}else{r4330=r4335;r4331=r4332}}r4337=r4327+r4301|0;if(r4325){r4338=r4337;r4339=r4329}else{r4340=r4337;r4341=0;r4342=r4329;while(1){r4343=r4340&r4305;r4344=r4316+(r4343<<2)|0;HEAPF32[r4344>>2]=0;r4345=r4340+1|0;if(r4326){r4346=r4345;r4347=r4342}else{r4348=r4345;r4349=0;r4350=r4342;while(1){r4351=r4348-1|0;r4352=r4351&r4305;r4353=r4316+(r4352<<2)|0;r4354=HEAPF32[r4353>>2];r4355=r4348-r4301|0;r4356=r4355-r4303|0;r4357=r4356&r4305;r4358=r4316+(r4357<<2)|0;r4359=HEAPF32[r4358>>2];r4360=r4354-r4359;r4361=r4355&r4305;r4362=r4316+(r4361<<2)|0;r4363=HEAPF32[r4362>>2];r4364=r4360+r4363;r4365=r4351-r4303|0;r4366=r4365&r4305;r4367=r4316+(r4366<<2)|0;r4368=HEAPF32[r4367>>2];r4369=r4364-r4368;r4370=r4348-r4303|0;r4371=r4370&r4305;r4372=r4316+(r4371<<2)|0;r4373=HEAPF32[r4372>>2];r4374=r4369+r4373;r4375=r4351-r4301|0;r4376=r4375&r4305;r4377=r4316+(r4376<<2)|0;r4378=HEAPF32[r4377>>2];r4379=r4374-r4378;r4380=r4375-r4303|0;r4381=r4380&r4305;r4382=r4316+(r4381<<2)|0;r4383=HEAPF32[r4382>>2];r4384=r4379+r4383;r4385=HEAP32[r4298>>2];r4386=HEAP32[r4300>>2];r4387=HEAP32[r4386>>2];r4388=__ZN9RCdecoder6decodeEP7RCmodel(r4385,r4387);r4389=r4388>>>0>27;do{if(r4389){r4390=r4388-28|0;r4391=1<<r4390;r4392=HEAP32[r4298>>2];r4393=r4390>>>0>16;if(r4393){r4394=__ZN9RCdecoder12decode_shiftEj(r4392,16);r4395=r4388-44|0;r4396=16;r4397=r4394;r4398=r4395}else{r4396=0;r4397=0;r4398=r4390}r4399=__ZN9RCdecoder12decode_shiftEj(r4392,r4398);r4400=r4399<<r4396;r4401=(HEAPF32[tempDoublePtr>>2]=r4384,HEAP32[tempDoublePtr>>2]);r4402=r4401>>>5;r4403=r4402^134217727;r4404=r4403>>>26;r4405=-r4404|0;r4406=r4405>>>6;r4407=r4406^r4403;r4408=r4391+r4407|0;r4409=r4408+r4397|0;r4410=r4409+r4400|0;r4411=r4410>>>26;r4412=-r4411|0;r4413=r4412>>>6;r4414=r4413^r4410;r4415=r4414<<5;r4416=r4415^-32;r4417=r4416}else{r4418=r4388>>>0<27;if(!r4418){r4419=(HEAPF32[tempDoublePtr>>2]=r4384,HEAP32[tempDoublePtr>>2]);r4420=r4419&-32;r4417=r4420;break}r4421=26-r4388|0;r4422=HEAP32[r4298>>2];r4423=r4421>>>0>16;if(r4423){r4424=__ZN9RCdecoder12decode_shiftEj(r4422,16);r4425=r4421-16|0;r4426=16;r4427=r4424;r4428=r4425}else{r4426=0;r4427=0;r4428=r4421}r4429=__ZN9RCdecoder12decode_shiftEj(r4422,r4428);r4430=r4429<<r4426;r4431=(HEAPF32[tempDoublePtr>>2]=r4384,HEAP32[tempDoublePtr>>2]);r4432=r4431>>>5;r4433=r4432^134217727;r4434=r4433>>>26;r4435=-r4434|0;r4436=r4435>>>6;r4437=r4436^r4433;r4438=-1<<r4421;r4439=r4438+r4437|0;r4440=r4439-r4427|0;r4441=r4440-r4430|0;r4442=r4441>>>26;r4443=-r4442|0;r4444=r4443>>>6;r4445=r4444^r4441;r4446=r4445<<5;r4447=r4446^-32;r4417=r4447}}while(0);r4448=(HEAP32[tempDoublePtr>>2]=r4417,HEAPF32[tempDoublePtr>>2]);HEAPF32[r4350>>2]=r4448;r4449=r4348&r4305;r4450=r4316+(r4449<<2)|0;HEAPF32[r4450>>2]=r4448;r4451=r4350+4|0;r4452=r4348+1|0;r4453=r4349+1|0;r4454=r4453>>>0<r4288>>>0;if(r4454){r4348=r4452;r4349=r4453;r4350=r4451}else{r4346=r4452;r4347=r4451;break}}}r4455=r4341+1|0;r4456=r4455>>>0<r4289>>>0;if(r4456){r4340=r4346;r4341=r4455;r4342=r4347}else{r4338=r4346;r4339=r4347;break}}}r4457=r4328+1|0;r4458=r4457>>>0<r4290>>>0;if(r4458){r4327=r4338;r4328=r4457;r4329=r4339}else{break}}}r4459=(r4296|0)==0;if(!r4459){_free(r4296)}r4460=HEAP32[r10>>2];r4461=(r4460|0)==0;if(!r4461){r4462=r4460;r4463=HEAP32[r4462>>2];r4464=r4463+4|0;r4465=HEAP32[r4464>>2];FUNCTION_TABLE[r4465](r4460)}r4466=(r4315|0)==0;if(r4466){break L6}_free(r4315);break};case 28:{r4467=HEAP32[r41>>2];r4468=HEAP32[r42>>2];r4469=HEAP32[r43>>2];r4470=HEAP32[r44>>2];r4471=4;r4472=0;r4473=__Znwj(48);r4474=r4473;__ZN9RCqsmodelC2Ebjjj(r4474,0,57,16,1024);r4475=r4473;HEAP32[r9>>2]=r4475;r4476=__Znwj(12);r4477=r4476+4|0;r4478=r4477;HEAP32[r4478>>2]=r4467;r4479=r4476+8|0;r4480=r4479;HEAP32[r4480>>2]=r9;r4481=r4468+1|0;r4482=r4469+1|0;r4483=Math_imul(r4482,r4481)|0;r4484=r4483+r4481|0;r4485=r4484;while(1){r4486=r4485+1|0;r4487=r4486&r4485;r4488=(r4487|0)==0;r4489=r4486|r4485;if(r4488){break}else{r4485=r4489}}r4490=_llvm_umul_with_overflow_i32(r4486,4);r4491=tempRet0;r4492=r4491;r4493=r4490;r4494=r4492?-1:r4493;r4495=__Znwj(r4494);r4496=r4495;r4497=r4483;r4498=0;while(1){r4499=r4498+1|0;r4500=r4498&r4485;r4501=r4496+(r4500<<2)|0;HEAPF32[r4501>>2]=0;r4502=r4497-1|0;r4503=(r4502|0)==0;if(r4503){break}else{r4497=r4502;r4498=r4499}}r4504=(r4470|0)==0;if(!r4504){r4505=(r4469|0)==0;r4506=(r4468|0)==0;r4507=r4483;r4508=0;r4509=r76;while(1){r4510=r4481;r4511=r4507;while(1){r4512=r4511+1|0;r4513=r4511&r4485;r4514=r4496+(r4513<<2)|0;HEAPF32[r4514>>2]=0;r4515=r4510-1|0;r4516=(r4515|0)==0;if(r4516){break}else{r4510=r4515;r4511=r4512}}r4517=r4507+r4481|0;if(r4505){r4518=r4517;r4519=r4509}else{r4520=r4517;r4521=0;r4522=r4509;while(1){r4523=r4520&r4485;r4524=r4496+(r4523<<2)|0;HEAPF32[r4524>>2]=0;r4525=r4520+1|0;if(r4506){r4526=r4525;r4527=r4522}else{r4528=r4525;r4529=0;r4530=r4522;while(1){r4531=r4528-1|0;r4532=r4531&r4485;r4533=r4496+(r4532<<2)|0;r4534=HEAPF32[r4533>>2];r4535=r4528-r4481|0;r4536=r4535-r4483|0;r4537=r4536&r4485;r4538=r4496+(r4537<<2)|0;r4539=HEAPF32[r4538>>2];r4540=r4534-r4539;r4541=r4535&r4485;r4542=r4496+(r4541<<2)|0;r4543=HEAPF32[r4542>>2];r4544=r4540+r4543;r4545=r4531-r4483|0;r4546=r4545&r4485;r4547=r4496+(r4546<<2)|0;r4548=HEAPF32[r4547>>2];r4549=r4544-r4548;r4550=r4528-r4483|0;r4551=r4550&r4485;r4552=r4496+(r4551<<2)|0;r4553=HEAPF32[r4552>>2];r4554=r4549+r4553;r4555=r4531-r4481|0;r4556=r4555&r4485;r4557=r4496+(r4556<<2)|0;r4558=HEAPF32[r4557>>2];r4559=r4554-r4558;r4560=r4555-r4483|0;r4561=r4560&r4485;r4562=r4496+(r4561<<2)|0;r4563=HEAPF32[r4562>>2];r4564=r4559+r4563;r4565=HEAP32[r4478>>2];r4566=HEAP32[r4480>>2];r4567=HEAP32[r4566>>2];r4568=__ZN9RCdecoder6decodeEP7RCmodel(r4565,r4567);r4569=r4568>>>0>28;do{if(r4569){r4570=r4568-29|0;r4571=1<<r4570;r4572=HEAP32[r4478>>2];r4573=r4570>>>0>16;if(r4573){r4574=__ZN9RCdecoder12decode_shiftEj(r4572,16);r4575=r4568-45|0;r4576=16;r4577=r4574;r4578=r4575}else{r4576=0;r4577=0;r4578=r4570}r4579=__ZN9RCdecoder12decode_shiftEj(r4572,r4578);r4580=r4579<<r4576;r4581=(HEAPF32[tempDoublePtr>>2]=r4564,HEAP32[tempDoublePtr>>2]);r4582=r4581>>>4;r4583=r4582^268435455;r4584=r4583>>>27;r4585=-r4584|0;r4586=r4585>>>5;r4587=r4586^r4583;r4588=r4571+r4587|0;r4589=r4588+r4577|0;r4590=r4589+r4580|0;r4591=r4590>>>27;r4592=-r4591|0;r4593=r4592>>>5;r4594=r4593^r4590;r4595=r4594<<4;r4596=r4595^-16;r4597=r4596}else{r4598=r4568>>>0<28;if(!r4598){r4599=(HEAPF32[tempDoublePtr>>2]=r4564,HEAP32[tempDoublePtr>>2]);r4600=r4599&-16;r4597=r4600;break}r4601=27-r4568|0;r4602=HEAP32[r4478>>2];r4603=r4601>>>0>16;if(r4603){r4604=__ZN9RCdecoder12decode_shiftEj(r4602,16);r4605=r4601-16|0;r4606=16;r4607=r4604;r4608=r4605}else{r4606=0;r4607=0;r4608=r4601}r4609=__ZN9RCdecoder12decode_shiftEj(r4602,r4608);r4610=r4609<<r4606;r4611=(HEAPF32[tempDoublePtr>>2]=r4564,HEAP32[tempDoublePtr>>2]);r4612=r4611>>>4;r4613=r4612^268435455;r4614=r4613>>>27;r4615=-r4614|0;r4616=r4615>>>5;r4617=r4616^r4613;r4618=-1<<r4601;r4619=r4618+r4617|0;r4620=r4619-r4607|0;r4621=r4620-r4610|0;r4622=r4621>>>27;r4623=-r4622|0;r4624=r4623>>>5;r4625=r4624^r4621;r4626=r4625<<4;r4627=r4626^-16;r4597=r4627}}while(0);r4628=(HEAP32[tempDoublePtr>>2]=r4597,HEAPF32[tempDoublePtr>>2]);HEAPF32[r4530>>2]=r4628;r4629=r4528&r4485;r4630=r4496+(r4629<<2)|0;HEAPF32[r4630>>2]=r4628;r4631=r4530+4|0;r4632=r4528+1|0;r4633=r4529+1|0;r4634=r4633>>>0<r4468>>>0;if(r4634){r4528=r4632;r4529=r4633;r4530=r4631}else{r4526=r4632;r4527=r4631;break}}}r4635=r4521+1|0;r4636=r4635>>>0<r4469>>>0;if(r4636){r4520=r4526;r4521=r4635;r4522=r4527}else{r4518=r4526;r4519=r4527;break}}}r4637=r4508+1|0;r4638=r4637>>>0<r4470>>>0;if(r4638){r4507=r4518;r4508=r4637;r4509=r4519}else{break}}}r4639=(r4476|0)==0;if(!r4639){_free(r4476)}r4640=HEAP32[r9>>2];r4641=(r4640|0)==0;if(!r4641){r4642=r4640;r4643=HEAP32[r4642>>2];r4644=r4643+4|0;r4645=HEAP32[r4644>>2];FUNCTION_TABLE[r4645](r4640)}r4646=(r4495|0)==0;if(r4646){break L6}_free(r4495);break};case 29:{r4647=HEAP32[r41>>2];r4648=HEAP32[r42>>2];r4649=HEAP32[r43>>2];r4650=HEAP32[r44>>2];r4651=4;r4652=0;r4653=__Znwj(48);r4654=r4653;__ZN9RCqsmodelC2Ebjjj(r4654,0,59,16,1024);r4655=r4653;HEAP32[r8>>2]=r4655;r4656=__Znwj(12);r4657=r4656+4|0;r4658=r4657;HEAP32[r4658>>2]=r4647;r4659=r4656+8|0;r4660=r4659;HEAP32[r4660>>2]=r8;r4661=r4648+1|0;r4662=r4649+1|0;r4663=Math_imul(r4662,r4661)|0;r4664=r4663+r4661|0;r4665=r4664;while(1){r4666=r4665+1|0;r4667=r4666&r4665;r4668=(r4667|0)==0;r4669=r4666|r4665;if(r4668){break}else{r4665=r4669}}r4670=_llvm_umul_with_overflow_i32(r4666,4);r4671=tempRet0;r4672=r4671;r4673=r4670;r4674=r4672?-1:r4673;r4675=__Znwj(r4674);r4676=r4675;r4677=r4663;r4678=0;while(1){r4679=r4678+1|0;r4680=r4678&r4665;r4681=r4676+(r4680<<2)|0;HEAPF32[r4681>>2]=0;r4682=r4677-1|0;r4683=(r4682|0)==0;if(r4683){break}else{r4677=r4682;r4678=r4679}}r4684=(r4650|0)==0;if(!r4684){r4685=(r4649|0)==0;r4686=(r4648|0)==0;r4687=r4663;r4688=0;r4689=r76;while(1){r4690=r4661;r4691=r4687;while(1){r4692=r4691+1|0;r4693=r4691&r4665;r4694=r4676+(r4693<<2)|0;HEAPF32[r4694>>2]=0;r4695=r4690-1|0;r4696=(r4695|0)==0;if(r4696){break}else{r4690=r4695;r4691=r4692}}r4697=r4687+r4661|0;if(r4685){r4698=r4697;r4699=r4689}else{r4700=r4697;r4701=0;r4702=r4689;while(1){r4703=r4700&r4665;r4704=r4676+(r4703<<2)|0;HEAPF32[r4704>>2]=0;r4705=r4700+1|0;if(r4686){r4706=r4705;r4707=r4702}else{r4708=r4705;r4709=0;r4710=r4702;while(1){r4711=r4708-1|0;r4712=r4711&r4665;r4713=r4676+(r4712<<2)|0;r4714=HEAPF32[r4713>>2];r4715=r4708-r4661|0;r4716=r4715-r4663|0;r4717=r4716&r4665;r4718=r4676+(r4717<<2)|0;r4719=HEAPF32[r4718>>2];r4720=r4714-r4719;r4721=r4715&r4665;r4722=r4676+(r4721<<2)|0;r4723=HEAPF32[r4722>>2];r4724=r4720+r4723;r4725=r4711-r4663|0;r4726=r4725&r4665;r4727=r4676+(r4726<<2)|0;r4728=HEAPF32[r4727>>2];r4729=r4724-r4728;r4730=r4708-r4663|0;r4731=r4730&r4665;r4732=r4676+(r4731<<2)|0;r4733=HEAPF32[r4732>>2];r4734=r4729+r4733;r4735=r4711-r4661|0;r4736=r4735&r4665;r4737=r4676+(r4736<<2)|0;r4738=HEAPF32[r4737>>2];r4739=r4734-r4738;r4740=r4735-r4663|0;r4741=r4740&r4665;r4742=r4676+(r4741<<2)|0;r4743=HEAPF32[r4742>>2];r4744=r4739+r4743;r4745=HEAP32[r4658>>2];r4746=HEAP32[r4660>>2];r4747=HEAP32[r4746>>2];r4748=__ZN9RCdecoder6decodeEP7RCmodel(r4745,r4747);r4749=r4748>>>0>29;do{if(r4749){r4750=r4748-30|0;r4751=1<<r4750;r4752=HEAP32[r4658>>2];r4753=r4750>>>0>16;if(r4753){r4754=__ZN9RCdecoder12decode_shiftEj(r4752,16);r4755=r4748-46|0;r4756=16;r4757=r4754;r4758=r4755}else{r4756=0;r4757=0;r4758=r4750}r4759=__ZN9RCdecoder12decode_shiftEj(r4752,r4758);r4760=r4759<<r4756;r4761=(HEAPF32[tempDoublePtr>>2]=r4744,HEAP32[tempDoublePtr>>2]);r4762=r4761>>>3;r4763=r4762^536870911;r4764=r4763>>>28;r4765=-r4764|0;r4766=r4765>>>4;r4767=r4766^r4763;r4768=r4751+r4767|0;r4769=r4768+r4757|0;r4770=r4769+r4760|0;r4771=r4770>>>28;r4772=-r4771|0;r4773=r4772>>>4;r4774=r4773^r4770;r4775=r4774<<3;r4776=r4775^-8;r4777=r4776}else{r4778=r4748>>>0<29;if(!r4778){r4779=(HEAPF32[tempDoublePtr>>2]=r4744,HEAP32[tempDoublePtr>>2]);r4780=r4779&-8;r4777=r4780;break}r4781=28-r4748|0;r4782=HEAP32[r4658>>2];r4783=r4781>>>0>16;if(r4783){r4784=__ZN9RCdecoder12decode_shiftEj(r4782,16);r4785=r4781-16|0;r4786=16;r4787=r4784;r4788=r4785}else{r4786=0;r4787=0;r4788=r4781}r4789=__ZN9RCdecoder12decode_shiftEj(r4782,r4788);r4790=r4789<<r4786;r4791=(HEAPF32[tempDoublePtr>>2]=r4744,HEAP32[tempDoublePtr>>2]);r4792=r4791>>>3;r4793=r4792^536870911;r4794=r4793>>>28;r4795=-r4794|0;r4796=r4795>>>4;r4797=r4796^r4793;r4798=-1<<r4781;r4799=r4798+r4797|0;r4800=r4799-r4787|0;r4801=r4800-r4790|0;r4802=r4801>>>28;r4803=-r4802|0;r4804=r4803>>>4;r4805=r4804^r4801;r4806=r4805<<3;r4807=r4806^-8;r4777=r4807}}while(0);r4808=(HEAP32[tempDoublePtr>>2]=r4777,HEAPF32[tempDoublePtr>>2]);HEAPF32[r4710>>2]=r4808;r4809=r4708&r4665;r4810=r4676+(r4809<<2)|0;HEAPF32[r4810>>2]=r4808;r4811=r4710+4|0;r4812=r4708+1|0;r4813=r4709+1|0;r4814=r4813>>>0<r4648>>>0;if(r4814){r4708=r4812;r4709=r4813;r4710=r4811}else{r4706=r4812;r4707=r4811;break}}}r4815=r4701+1|0;r4816=r4815>>>0<r4649>>>0;if(r4816){r4700=r4706;r4701=r4815;r4702=r4707}else{r4698=r4706;r4699=r4707;break}}}r4817=r4688+1|0;r4818=r4817>>>0<r4650>>>0;if(r4818){r4687=r4698;r4688=r4817;r4689=r4699}else{break}}}r4819=(r4656|0)==0;if(!r4819){_free(r4656)}r4820=HEAP32[r8>>2];r4821=(r4820|0)==0;if(!r4821){r4822=r4820;r4823=HEAP32[r4822>>2];r4824=r4823+4|0;r4825=HEAP32[r4824>>2];FUNCTION_TABLE[r4825](r4820)}r4826=(r4675|0)==0;if(r4826){break L6}_free(r4675);break};case 30:{r4827=HEAP32[r41>>2];r4828=HEAP32[r42>>2];r4829=HEAP32[r43>>2];r4830=HEAP32[r44>>2];r4831=4;r4832=0;r4833=__Znwj(48);r4834=r4833;__ZN9RCqsmodelC2Ebjjj(r4834,0,61,16,1024);r4835=r4833;HEAP32[r7>>2]=r4835;r4836=__Znwj(12);r4837=r4836+4|0;r4838=r4837;HEAP32[r4838>>2]=r4827;r4839=r4836+8|0;r4840=r4839;HEAP32[r4840>>2]=r7;r4841=r4828+1|0;r4842=r4829+1|0;r4843=Math_imul(r4842,r4841)|0;r4844=r4843+r4841|0;r4845=r4844;while(1){r4846=r4845+1|0;r4847=r4846&r4845;r4848=(r4847|0)==0;r4849=r4846|r4845;if(r4848){break}else{r4845=r4849}}r4850=_llvm_umul_with_overflow_i32(r4846,4);r4851=tempRet0;r4852=r4851;r4853=r4850;r4854=r4852?-1:r4853;r4855=__Znwj(r4854);r4856=r4855;r4857=r4843;r4858=0;while(1){r4859=r4858+1|0;r4860=r4858&r4845;r4861=r4856+(r4860<<2)|0;HEAPF32[r4861>>2]=0;r4862=r4857-1|0;r4863=(r4862|0)==0;if(r4863){break}else{r4857=r4862;r4858=r4859}}r4864=(r4830|0)==0;if(!r4864){r4865=(r4829|0)==0;r4866=(r4828|0)==0;r4867=r4843;r4868=0;r4869=r76;while(1){r4870=r4841;r4871=r4867;while(1){r4872=r4871+1|0;r4873=r4871&r4845;r4874=r4856+(r4873<<2)|0;HEAPF32[r4874>>2]=0;r4875=r4870-1|0;r4876=(r4875|0)==0;if(r4876){break}else{r4870=r4875;r4871=r4872}}r4877=r4867+r4841|0;if(r4865){r4878=r4877;r4879=r4869}else{r4880=r4877;r4881=0;r4882=r4869;while(1){r4883=r4880&r4845;r4884=r4856+(r4883<<2)|0;HEAPF32[r4884>>2]=0;r4885=r4880+1|0;if(r4866){r4886=r4885;r4887=r4882}else{r4888=r4885;r4889=0;r4890=r4882;while(1){r4891=r4888-1|0;r4892=r4891&r4845;r4893=r4856+(r4892<<2)|0;r4894=HEAPF32[r4893>>2];r4895=r4888-r4841|0;r4896=r4895-r4843|0;r4897=r4896&r4845;r4898=r4856+(r4897<<2)|0;r4899=HEAPF32[r4898>>2];r4900=r4894-r4899;r4901=r4895&r4845;r4902=r4856+(r4901<<2)|0;r4903=HEAPF32[r4902>>2];r4904=r4900+r4903;r4905=r4891-r4843|0;r4906=r4905&r4845;r4907=r4856+(r4906<<2)|0;r4908=HEAPF32[r4907>>2];r4909=r4904-r4908;r4910=r4888-r4843|0;r4911=r4910&r4845;r4912=r4856+(r4911<<2)|0;r4913=HEAPF32[r4912>>2];r4914=r4909+r4913;r4915=r4891-r4841|0;r4916=r4915&r4845;r4917=r4856+(r4916<<2)|0;r4918=HEAPF32[r4917>>2];r4919=r4914-r4918;r4920=r4915-r4843|0;r4921=r4920&r4845;r4922=r4856+(r4921<<2)|0;r4923=HEAPF32[r4922>>2];r4924=r4919+r4923;r4925=HEAP32[r4838>>2];r4926=HEAP32[r4840>>2];r4927=HEAP32[r4926>>2];r4928=__ZN9RCdecoder6decodeEP7RCmodel(r4925,r4927);r4929=r4928>>>0>30;do{if(r4929){r4930=r4928-31|0;r4931=1<<r4930;r4932=HEAP32[r4838>>2];r4933=r4930>>>0>16;if(r4933){r4934=__ZN9RCdecoder12decode_shiftEj(r4932,16);r4935=r4928-47|0;r4936=16;r4937=r4934;r4938=r4935}else{r4936=0;r4937=0;r4938=r4930}r4939=__ZN9RCdecoder12decode_shiftEj(r4932,r4938);r4940=r4939<<r4936;r4941=(HEAPF32[tempDoublePtr>>2]=r4924,HEAP32[tempDoublePtr>>2]);r4942=r4941>>>2;r4943=r4942^1073741823;r4944=r4943>>>29;r4945=-r4944|0;r4946=r4945>>>3;r4947=r4946^r4943;r4948=r4931+r4947|0;r4949=r4948+r4937|0;r4950=r4949+r4940|0;r4951=r4950>>>29;r4952=-r4951|0;r4953=r4952>>>3;r4954=r4953^r4950;r4955=r4954<<2;r4956=r4955^-4;r4957=r4956}else{r4958=r4928>>>0<30;if(!r4958){r4959=(HEAPF32[tempDoublePtr>>2]=r4924,HEAP32[tempDoublePtr>>2]);r4960=r4959&-4;r4957=r4960;break}r4961=29-r4928|0;r4962=HEAP32[r4838>>2];r4963=r4961>>>0>16;if(r4963){r4964=__ZN9RCdecoder12decode_shiftEj(r4962,16);r4965=r4961-16|0;r4966=16;r4967=r4964;r4968=r4965}else{r4966=0;r4967=0;r4968=r4961}r4969=__ZN9RCdecoder12decode_shiftEj(r4962,r4968);r4970=r4969<<r4966;r4971=(HEAPF32[tempDoublePtr>>2]=r4924,HEAP32[tempDoublePtr>>2]);r4972=r4971>>>2;r4973=r4972^1073741823;r4974=r4973>>>29;r4975=-r4974|0;r4976=r4975>>>3;r4977=r4976^r4973;r4978=-1<<r4961;r4979=r4978+r4977|0;r4980=r4979-r4967|0;r4981=r4980-r4970|0;r4982=r4981>>>29;r4983=-r4982|0;r4984=r4983>>>3;r4985=r4984^r4981;r4986=r4985<<2;r4987=r4986^-4;r4957=r4987}}while(0);r4988=(HEAP32[tempDoublePtr>>2]=r4957,HEAPF32[tempDoublePtr>>2]);HEAPF32[r4890>>2]=r4988;r4989=r4888&r4845;r4990=r4856+(r4989<<2)|0;HEAPF32[r4990>>2]=r4988;r4991=r4890+4|0;r4992=r4888+1|0;r4993=r4889+1|0;r4994=r4993>>>0<r4828>>>0;if(r4994){r4888=r4992;r4889=r4993;r4890=r4991}else{r4886=r4992;r4887=r4991;break}}}r4995=r4881+1|0;r4996=r4995>>>0<r4829>>>0;if(r4996){r4880=r4886;r4881=r4995;r4882=r4887}else{r4878=r4886;r4879=r4887;break}}}r4997=r4868+1|0;r4998=r4997>>>0<r4830>>>0;if(r4998){r4867=r4878;r4868=r4997;r4869=r4879}else{break}}}r4999=(r4836|0)==0;if(!r4999){_free(r4836)}r5000=HEAP32[r7>>2];r5001=(r5000|0)==0;if(!r5001){r5002=r5000;r5003=HEAP32[r5002>>2];r5004=r5003+4|0;r5005=HEAP32[r5004>>2];FUNCTION_TABLE[r5005](r5000)}r5006=(r4855|0)==0;if(r5006){break L6}_free(r4855);break};case 31:{r5007=HEAP32[r41>>2];r5008=HEAP32[r42>>2];r5009=HEAP32[r43>>2];r5010=HEAP32[r44>>2];r5011=4;r5012=0;r5013=__Znwj(48);r5014=r5013;__ZN9RCqsmodelC2Ebjjj(r5014,0,63,16,1024);r5015=r5013;HEAP32[r6>>2]=r5015;r5016=__Znwj(12);r5017=r5016+4|0;r5018=r5017;HEAP32[r5018>>2]=r5007;r5019=r5016+8|0;r5020=r5019;HEAP32[r5020>>2]=r6;r5021=r5008+1|0;r5022=r5009+1|0;r5023=Math_imul(r5022,r5021)|0;r5024=r5023+r5021|0;r5025=r5024;while(1){r5026=r5025+1|0;r5027=r5026&r5025;r5028=(r5027|0)==0;r5029=r5026|r5025;if(r5028){break}else{r5025=r5029}}r5030=_llvm_umul_with_overflow_i32(r5026,4);r5031=tempRet0;r5032=r5031;r5033=r5030;r5034=r5032?-1:r5033;r5035=__Znwj(r5034);r5036=r5035;r5037=r5023;r5038=0;while(1){r5039=r5038+1|0;r5040=r5038&r5025;r5041=r5036+(r5040<<2)|0;HEAPF32[r5041>>2]=0;r5042=r5037-1|0;r5043=(r5042|0)==0;if(r5043){break}else{r5037=r5042;r5038=r5039}}r5044=(r5010|0)==0;if(!r5044){r5045=(r5009|0)==0;r5046=(r5008|0)==0;r5047=r5023;r5048=0;r5049=r76;while(1){r5050=r5021;r5051=r5047;while(1){r5052=r5051+1|0;r5053=r5051&r5025;r5054=r5036+(r5053<<2)|0;HEAPF32[r5054>>2]=0;r5055=r5050-1|0;r5056=(r5055|0)==0;if(r5056){break}else{r5050=r5055;r5051=r5052}}r5057=r5047+r5021|0;if(r5045){r5058=r5057;r5059=r5049}else{r5060=r5057;r5061=0;r5062=r5049;while(1){r5063=r5060&r5025;r5064=r5036+(r5063<<2)|0;HEAPF32[r5064>>2]=0;r5065=r5060+1|0;if(r5046){r5066=r5065;r5067=r5062}else{r5068=r5065;r5069=0;r5070=r5062;while(1){r5071=r5068-1|0;r5072=r5071&r5025;r5073=r5036+(r5072<<2)|0;r5074=HEAPF32[r5073>>2];r5075=r5068-r5021|0;r5076=r5075-r5023|0;r5077=r5076&r5025;r5078=r5036+(r5077<<2)|0;r5079=HEAPF32[r5078>>2];r5080=r5074-r5079;r5081=r5075&r5025;r5082=r5036+(r5081<<2)|0;r5083=HEAPF32[r5082>>2];r5084=r5080+r5083;r5085=r5071-r5023|0;r5086=r5085&r5025;r5087=r5036+(r5086<<2)|0;r5088=HEAPF32[r5087>>2];r5089=r5084-r5088;r5090=r5068-r5023|0;r5091=r5090&r5025;r5092=r5036+(r5091<<2)|0;r5093=HEAPF32[r5092>>2];r5094=r5089+r5093;r5095=r5071-r5021|0;r5096=r5095&r5025;r5097=r5036+(r5096<<2)|0;r5098=HEAPF32[r5097>>2];r5099=r5094-r5098;r5100=r5095-r5023|0;r5101=r5100&r5025;r5102=r5036+(r5101<<2)|0;r5103=HEAPF32[r5102>>2];r5104=r5099+r5103;r5105=HEAP32[r5018>>2];r5106=HEAP32[r5020>>2];r5107=HEAP32[r5106>>2];r5108=__ZN9RCdecoder6decodeEP7RCmodel(r5105,r5107);r5109=r5108>>>0>31;do{if(r5109){r5110=r5108-32|0;r5111=1<<r5110;r5112=HEAP32[r5018>>2];r5113=r5110>>>0>16;if(r5113){r5114=__ZN9RCdecoder12decode_shiftEj(r5112,16);r5115=r5108-48|0;r5116=16;r5117=r5114;r5118=r5115}else{r5116=0;r5117=0;r5118=r5110}r5119=__ZN9RCdecoder12decode_shiftEj(r5112,r5118);r5120=r5119<<r5116;r5121=(HEAPF32[tempDoublePtr>>2]=r5104,HEAP32[tempDoublePtr>>2]);r5122=r5121>>>1;r5123=r5122^2147483647;r5124=r5123>>>30;r5125=-r5124|0;r5126=r5125>>>2;r5127=r5126^r5123;r5128=r5111+r5127|0;r5129=r5128+r5117|0;r5130=r5129+r5120|0;r5131=r5130>>>30;r5132=-r5131|0;r5133=r5132>>>2;r5134=r5133^r5130;r5135=r5134<<1;r5136=r5135^-2;r5137=r5136}else{r5138=r5108>>>0<31;if(!r5138){r5139=(HEAPF32[tempDoublePtr>>2]=r5104,HEAP32[tempDoublePtr>>2]);r5140=r5139&-2;r5137=r5140;break}r5141=30-r5108|0;r5142=HEAP32[r5018>>2];r5143=r5141>>>0>16;if(r5143){r5144=__ZN9RCdecoder12decode_shiftEj(r5142,16);r5145=r5141-16|0;r5146=16;r5147=r5144;r5148=r5145}else{r5146=0;r5147=0;r5148=r5141}r5149=__ZN9RCdecoder12decode_shiftEj(r5142,r5148);r5150=r5149<<r5146;r5151=(HEAPF32[tempDoublePtr>>2]=r5104,HEAP32[tempDoublePtr>>2]);r5152=r5151>>>1;r5153=r5152^2147483647;r5154=r5153>>>30;r5155=-r5154|0;r5156=r5155>>>2;r5157=r5156^r5153;r5158=-1<<r5141;r5159=r5158+r5157|0;r5160=r5159-r5147|0;r5161=r5160-r5150|0;r5162=r5161>>>30;r5163=-r5162|0;r5164=r5163>>>2;r5165=r5164^r5161;r5166=r5165<<1;r5167=r5166^-2;r5137=r5167}}while(0);r5168=(HEAP32[tempDoublePtr>>2]=r5137,HEAPF32[tempDoublePtr>>2]);HEAPF32[r5070>>2]=r5168;r5169=r5068&r5025;r5170=r5036+(r5169<<2)|0;HEAPF32[r5170>>2]=r5168;r5171=r5070+4|0;r5172=r5068+1|0;r5173=r5069+1|0;r5174=r5173>>>0<r5008>>>0;if(r5174){r5068=r5172;r5069=r5173;r5070=r5171}else{r5066=r5172;r5067=r5171;break}}}r5175=r5061+1|0;r5176=r5175>>>0<r5009>>>0;if(r5176){r5060=r5066;r5061=r5175;r5062=r5067}else{r5058=r5066;r5059=r5067;break}}}r5177=r5048+1|0;r5178=r5177>>>0<r5010>>>0;if(r5178){r5047=r5058;r5048=r5177;r5049=r5059}else{break}}}r5179=(r5016|0)==0;if(!r5179){_free(r5016)}r5180=HEAP32[r6>>2];r5181=(r5180|0)==0;if(!r5181){r5182=r5180;r5183=HEAP32[r5182>>2];r5184=r5183+4|0;r5185=HEAP32[r5184>>2];FUNCTION_TABLE[r5185](r5180)}r5186=(r5035|0)==0;if(r5186){break L6}_free(r5035);break};case 32:{r5187=HEAP32[r41>>2];r5188=HEAP32[r42>>2];r5189=HEAP32[r43>>2];r5190=HEAP32[r44>>2];r5191=4;r5192=0;r5193=__Znwj(48);r5194=r5193;__ZN9RCqsmodelC2Ebjjj(r5194,0,65,16,1024);r5195=r5193;HEAP32[r5>>2]=r5195;r5196=__Znwj(12);r5197=r5196+4|0;r5198=r5197;HEAP32[r5198>>2]=r5187;r5199=r5196+8|0;r5200=r5199;HEAP32[r5200>>2]=r5;r5201=r5188+1|0;r5202=r5189+1|0;r5203=Math_imul(r5202,r5201)|0;r5204=r5203+r5201|0;r5205=r5204;while(1){r5206=r5205+1|0;r5207=r5206&r5205;r5208=(r5207|0)==0;r5209=r5206|r5205;if(r5208){break}else{r5205=r5209}}r5210=_llvm_umul_with_overflow_i32(r5206,4);r5211=tempRet0;r5212=r5211;r5213=r5210;r5214=r5212?-1:r5213;r5215=__Znwj(r5214);r5216=r5215;r5217=r5203;r5218=0;while(1){r5219=r5218+1|0;r5220=r5218&r5205;r5221=r5216+(r5220<<2)|0;HEAPF32[r5221>>2]=0;r5222=r5217-1|0;r5223=(r5222|0)==0;if(r5223){break}else{r5217=r5222;r5218=r5219}}r5224=(r5190|0)==0;if(!r5224){r5225=(r5189|0)==0;r5226=(r5188|0)==0;r5227=r5203;r5228=0;r5229=r76;while(1){r5230=r5201;r5231=r5227;while(1){r5232=r5231+1|0;r5233=r5231&r5205;r5234=r5216+(r5233<<2)|0;HEAPF32[r5234>>2]=0;r5235=r5230-1|0;r5236=(r5235|0)==0;if(r5236){break}else{r5230=r5235;r5231=r5232}}r5237=r5227+r5201|0;if(r5225){r5238=r5237;r5239=r5229}else{r5240=r5237;r5241=0;r5242=r5229;while(1){r5243=r5240&r5205;r5244=r5216+(r5243<<2)|0;HEAPF32[r5244>>2]=0;r5245=r5240+1|0;if(r5226){r5246=r5245;r5247=r5242}else{r5248=r5245;r5249=0;r5250=r5242;while(1){r5251=r5248-1|0;r5252=r5251&r5205;r5253=r5216+(r5252<<2)|0;r5254=HEAPF32[r5253>>2];r5255=r5248-r5201|0;r5256=r5255-r5203|0;r5257=r5256&r5205;r5258=r5216+(r5257<<2)|0;r5259=HEAPF32[r5258>>2];r5260=r5254-r5259;r5261=r5255&r5205;r5262=r5216+(r5261<<2)|0;r5263=HEAPF32[r5262>>2];r5264=r5260+r5263;r5265=r5251-r5203|0;r5266=r5265&r5205;r5267=r5216+(r5266<<2)|0;r5268=HEAPF32[r5267>>2];r5269=r5264-r5268;r5270=r5248-r5203|0;r5271=r5270&r5205;r5272=r5216+(r5271<<2)|0;r5273=HEAPF32[r5272>>2];r5274=r5269+r5273;r5275=r5251-r5201|0;r5276=r5275&r5205;r5277=r5216+(r5276<<2)|0;r5278=HEAPF32[r5277>>2];r5279=r5274-r5278;r5280=r5275-r5203|0;r5281=r5280&r5205;r5282=r5216+(r5281<<2)|0;r5283=HEAPF32[r5282>>2];r5284=r5279+r5283;r5285=HEAP32[r5198>>2];r5286=HEAP32[r5200>>2];r5287=HEAP32[r5286>>2];r5288=__ZN9RCdecoder6decodeEP7RCmodel(r5285,r5287);r5289=r5288>>>0>32;do{if(r5289){r5290=r5288-33|0;r5291=1<<r5290;r5292=HEAP32[r5198>>2];r5293=r5290>>>0>16;if(r5293){r5294=__ZN9RCdecoder12decode_shiftEj(r5292,16);r5295=r5288-49|0;r5296=16;r5297=r5294;r5298=r5295}else{r5296=0;r5297=0;r5298=r5290}r5299=__ZN9RCdecoder12decode_shiftEj(r5292,r5298);r5300=r5299<<r5296;r5301=(HEAPF32[tempDoublePtr>>2]=r5284,HEAP32[tempDoublePtr>>2]);r5302=~r5301;r5303=r5302>>31;r5304=r5303>>>1;r5305=r5304^r5302;r5306=r5291+r5305|0;r5307=r5306+r5297|0;r5308=r5307+r5300|0;r5309=r5308>>31;r5310=r5309>>>1;r5311=~r5308;r5312=r5310^r5311;r5313=(HEAP32[tempDoublePtr>>2]=r5312,HEAPF32[tempDoublePtr>>2]);r5314=r5313}else{r5315=r5288>>>0<32;if(!r5315){r5314=r5284;break}r5316=31-r5288|0;r5317=HEAP32[r5198>>2];r5318=r5316>>>0>16;if(r5318){r5319=__ZN9RCdecoder12decode_shiftEj(r5317,16);r5320=r5316-16|0;r5321=16;r5322=r5319;r5323=r5320}else{r5321=0;r5322=0;r5323=r5316}r5324=__ZN9RCdecoder12decode_shiftEj(r5317,r5323);r5325=r5324<<r5321;r5326=(HEAPF32[tempDoublePtr>>2]=r5284,HEAP32[tempDoublePtr>>2]);r5327=~r5326;r5328=r5327>>31;r5329=r5328>>>1;r5330=r5329^r5327;r5331=-1<<r5316;r5332=r5331+r5330|0;r5333=r5332-r5322|0;r5334=r5333-r5325|0;r5335=r5334>>31;r5336=r5335>>>1;r5337=~r5334;r5338=r5336^r5337;r5339=(HEAP32[tempDoublePtr>>2]=r5338,HEAPF32[tempDoublePtr>>2]);r5314=r5339}}while(0);HEAPF32[r5250>>2]=r5314;r5340=r5248&r5205;r5341=r5216+(r5340<<2)|0;HEAPF32[r5341>>2]=r5314;r5342=r5250+4|0;r5343=r5248+1|0;r5344=r5249+1|0;r5345=r5344>>>0<r5188>>>0;if(r5345){r5248=r5343;r5249=r5344;r5250=r5342}else{r5246=r5343;r5247=r5342;break}}}r5346=r5241+1|0;r5347=r5346>>>0<r5189>>>0;if(r5347){r5240=r5246;r5241=r5346;r5242=r5247}else{r5238=r5246;r5239=r5247;break}}}r5348=r5228+1|0;r5349=r5348>>>0<r5190>>>0;if(r5349){r5227=r5238;r5228=r5348;r5229=r5239}else{break}}}r5350=(r5196|0)==0;if(!r5350){_free(r5196)}r5351=HEAP32[r5>>2];r5352=(r5351|0)==0;if(!r5352){r5353=r5351;r5354=HEAP32[r5353>>2];r5355=r5354+4|0;r5356=HEAP32[r5355>>2];FUNCTION_TABLE[r5356](r5351)}r5357=(r5215|0)==0;if(r5357){break L6}_free(r5215);break};default:{break L4}}}while(0);r5358=HEAP32[r42>>2];r5359=HEAP32[r43>>2];r5360=Math_imul(r5359,r5358)|0;r5361=HEAP32[r44>>2];r5362=Math_imul(r5360,r5361)|0;r5363=r76+(r5362<<2)|0;r5364=r77+1|0;r5365=HEAP32[r36>>2];r5366=(r5364|0)<(r5365|0);if(r5366){r76=r5363;r77=r5364}else{r39=1;r3=1253;break}}if(r3==1253){STACKTOP=r4;return r39}HEAP32[_fpzip_errno>>2]=5;r39=0;STACKTOP=r4;return r39}



function __ZN9RCdecoder6decodeEP7RCmodel(r1,r2){var r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13;r3=STACKTOP;STACKTOP=STACKTOP+16|0;r4=r3;r5=r3+8;r6=r1+12|0;FUNCTION_TABLE[HEAP32[HEAP32[r2>>2]+16>>2]](r2,r6);r7=r1+16|0;r8=r1+8|0;HEAP32[r4>>2]=((HEAP32[r7>>2]-HEAP32[r8>>2]|0)>>>0)/(HEAP32[r6>>2]>>>0)&-1;r9=FUNCTION_TABLE[HEAP32[HEAP32[r2>>2]+12>>2]](r2,r4,r5);r2=HEAP32[r6>>2];r10=Math_imul(HEAP32[r4>>2],r2)|0;r4=HEAP32[r8>>2]+r10|0;HEAP32[r8>>2]=r4;r10=Math_imul(r2,HEAP32[r5>>2])|0;HEAP32[r6>>2]=r10;if((r10+r4^r4)>>>0<16777216){r4=r1;r5=HEAP32[r7>>2];while(1){HEAP32[r7>>2]=r5<<8;r2=FUNCTION_TABLE[HEAP32[HEAP32[r4>>2]+8>>2]](r1);r11=HEAP32[r7>>2]|r2;HEAP32[r7>>2]=r11;r2=HEAP32[r8>>2]<<8;HEAP32[r8>>2]=r2;r12=HEAP32[r6>>2]<<8;HEAP32[r6>>2]=r12;if((r12+r2^r2)>>>0<16777216){r5=r11}else{r13=r12;break}}}else{r13=r10}if(r13>>>0>65535){STACKTOP=r3;return r9}r13=r1;HEAP32[r7>>2]=HEAP32[r7>>2]<<8;r10=FUNCTION_TABLE[HEAP32[HEAP32[r13>>2]+8>>2]](r1);r5=HEAP32[r7>>2]|r10;HEAP32[r8>>2]=HEAP32[r8>>2]<<8;HEAP32[r7>>2]=r5<<8;r5=FUNCTION_TABLE[HEAP32[HEAP32[r13>>2]+8>>2]](r1);HEAP32[r7>>2]=HEAP32[r7>>2]|r5;r5=HEAP32[r8>>2]<<8;HEAP32[r8>>2]=r5;HEAP32[r6>>2]=-r5;STACKTOP=r3;return r9}function __ZN9RCdecoder12decode_shiftEj(r1,r2){var r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14;r3=r1+12|0;r4=HEAP32[r3>>2]>>>(r2>>>0);HEAP32[r3>>2]=r4;r2=r1+16|0;r5=HEAP32[r2>>2];r6=r1+8|0;r7=HEAP32[r6>>2];r8=((r5-r7|0)>>>0)/(r4>>>0)&-1;r9=Math_imul(r8,r4)+r7|0;HEAP32[r6>>2]=r9;if((r9+r4^r9)>>>0<16777216){r9=r1;r7=r5;while(1){HEAP32[r2>>2]=r7<<8;r10=FUNCTION_TABLE[HEAP32[HEAP32[r9>>2]+8>>2]](r1);r11=HEAP32[r2>>2]|r10;HEAP32[r2>>2]=r11;r10=HEAP32[r6>>2]<<8;HEAP32[r6>>2]=r10;r12=HEAP32[r3>>2]<<8;HEAP32[r3>>2]=r12;if((r12+r10^r10)>>>0<16777216){r7=r11}else{r13=r12;r14=r11;break}}}else{r13=r4;r14=r5}if(r13>>>0>65535){return r8}r13=r1;HEAP32[r2>>2]=r14<<8;r14=FUNCTION_TABLE[HEAP32[HEAP32[r13>>2]+8>>2]](r1);r5=HEAP32[r2>>2]|r14;HEAP32[r6>>2]=HEAP32[r6>>2]<<8;HEAP32[r2>>2]=r5<<8;r5=FUNCTION_TABLE[HEAP32[HEAP32[r13>>2]+8>>2]](r1);HEAP32[r2>>2]=HEAP32[r2>>2]|r5;r5=HEAP32[r6>>2]<<8;HEAP32[r6>>2]=r5;HEAP32[r3>>2]=-r5;return r8}function __ZN9RCqsmodelC2Ebjjj(r1,r2,r3,r4,r5){var r6,r7,r8,r9,r10,r11;HEAP32[r1+4>>2]=r3;HEAP32[r1>>2]=552;HEAP32[r1+8>>2]=r4;HEAP32[r1+28>>2]=r5;if(r4>>>0>=17){___assert_fail(40,208,9,408)}if(1<<r4+1>>>0<=r5>>>0){___assert_fail(144,208,10,408)}r5=_llvm_umul_with_overflow_i32(r3+1|0,4);r6=tempRet0?-1:r5;r5=__Znwj(r6);r7=r1+32|0;HEAP32[r7>>2]=r5;r8=__Znwj(r6);HEAP32[r1+36>>2]=r8;HEAP32[r8>>2]=0;r6=1<<r4;HEAP32[r8+(r3<<2)>>2]=r6;if(r2){HEAP32[r1+44>>2]=0}else{HEAP32[r1+40>>2]=r4-7;HEAP32[r1+44>>2]=__Znwj(516)}HEAP32[r1+24>>2]=r3>>>4|2;HEAP32[r1+16>>2]=0;r4=(r6>>>0)/(r3>>>0)&-1;r2=(r6>>>0)%(r3>>>0)&-1;L14:do{if((r2|0)==0){r9=0}else{r6=r4+1|0;r8=0;r10=r5;while(1){HEAP32[r10+(r8<<2)>>2]=r6;r11=r8+1|0;if(r11>>>0>=r2>>>0){r9=r2;break L14}r8=r11;r10=HEAP32[r7>>2]}}}while(0);while(1){HEAP32[HEAP32[r7>>2]+(r9<<2)>>2]=r4;r2=r9+1|0;if(r2>>>0<r3>>>0){r9=r2}else{break}}__ZN9RCqsmodel6updateEv(r1);return}function __ZN9RCqsmodelD0Ev(r1){var r2;HEAP32[r1>>2]=552;r2=HEAP32[r1+32>>2];if((r2|0)!=0){_free(r2)}r2=HEAP32[r1+36>>2];if((r2|0)!=0){_free(r2)}r2=HEAP32[r1+44>>2];if((r2|0)!=0){_free(r2)}if((r1|0)==0){return}_free(r1);return}function __ZN9RCqsmodelD2Ev(r1){var r2;HEAP32[r1>>2]=552;r2=HEAP32[r1+32>>2];if((r2|0)!=0){_free(r2)}r2=HEAP32[r1+36>>2];if((r2|0)!=0){_free(r2)}r2=HEAP32[r1+44>>2];if((r2|0)==0){return}_free(r2);return}function __ZN9RCqsmodel6updateEv(r1){var r2,r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18,r19,r20,r21;r2=r1+16|0;r3=HEAP32[r2>>2];if((r3|0)!=0){HEAP32[r1+12>>2]=r3;HEAP32[r2>>2]=0;r3=r1+20|0;HEAP32[r3>>2]=HEAP32[r3>>2]+1;return}r3=r1+24|0;r4=HEAP32[r3>>2];r5=HEAP32[r1+28>>2];if((r4|0)==(r5|0)){r6=r4}else{r7=r4<<1;r4=r7>>>0>r5>>>0?r5:r7;HEAP32[r3>>2]=r4;r6=r4}r4=HEAP32[r1+4>>2];r7=r1+36|0;r5=HEAP32[r7>>2];r8=HEAP32[r5+(r4<<2)>>2];r9=(r4|0)==0;if(r9){r10=r8;r11=r6}else{r6=r1+32|0;r12=r8;r13=r8;r8=r4;r14=r5;while(1){r5=r8-1|0;r15=HEAP32[HEAP32[r6>>2]+(r5<<2)>>2];r16=r13-r15|0;HEAP32[r14+(r5<<2)>>2]=r16;r17=r15>>>1|1;r18=r12-r17|0;HEAP32[HEAP32[r6>>2]+(r5<<2)>>2]=r17;if((r5|0)==0){break}r12=r18;r13=r16;r8=r5;r14=HEAP32[r7>>2]}r10=r18;r11=HEAP32[r3>>2]}HEAP32[r1+20>>2]=(r10>>>0)/(r11>>>0)&-1;r3=(r10>>>0)%(r11>>>0)&-1;HEAP32[r2>>2]=r3;HEAP32[r1+12>>2]=r11-r3;r3=r1+44|0;if((HEAP32[r3>>2]|0)==0|r9){return}r9=r1+40|0;r1=128;r11=r4;r4=HEAP32[r7>>2];r2=HEAP32[r9>>2];while(1){r10=r11-1|0;r18=HEAP32[r4+(r10<<2)>>2];r14=r18>>>(r2>>>0);if(r14>>>0>r1>>>0){r19=r4;r20=r18;r21=r2}else{r18=r14;while(1){HEAP32[HEAP32[r3>>2]+(r18<<2)>>2]=r10;r14=r18+1|0;if(r14>>>0>r1>>>0){break}else{r18=r14}}r18=HEAP32[r7>>2];r19=r18;r20=HEAP32[r18+(r10<<2)>>2];r21=HEAP32[r9>>2]}if((r10|0)==0){break}else{r1=r20>>>(r21>>>0);r11=r10;r4=r19;r2=r21}}return}function __ZN9RCqsmodel6decodeERjS0_(r1,r2,r3){var r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17;r4=HEAP32[r2>>2];r5=r4>>>(HEAP32[r1+40>>2]>>>0);r6=HEAP32[r1+44>>2];r7=HEAP32[r6+(r5<<2)>>2];r8=HEAP32[r6+(r5+1<<2)>>2]+1|0;r5=r7+1|0;r6=r1+36|0;r9=HEAP32[r6>>2];if(r5>>>0<r8>>>0){r10=r8;r8=r7;while(1){r11=(r8+r10|0)>>>1;r12=r4>>>0<HEAP32[r9+(r11<<2)>>2]>>>0;r13=r12?r11:r10;r14=r12?r8:r11;r11=r14+1|0;if(r11>>>0<r13>>>0){r10=r13;r8=r14}else{r15=r14;r16=r11;break}}}else{r15=r7;r16=r5}r5=HEAP32[r9+(r15<<2)>>2];HEAP32[r2>>2]=r5;HEAP32[r3>>2]=HEAP32[HEAP32[r6>>2]+(r16<<2)>>2]-r5;r5=r1+12|0;r16=HEAP32[r5>>2];if((r16|0)==0){__ZN9RCqsmodel6updateEv(r1);r17=HEAP32[r5>>2]}else{r17=r16}HEAP32[r5>>2]=r17-1;r17=HEAP32[r1+32>>2]+(r15<<2)|0;HEAP32[r17>>2]=HEAP32[r17>>2]+HEAP32[r1+20>>2];return r15}function __ZN9RCqsmodel6encodeEjRjS0_(r1,r2,r3,r4){var r5,r6,r7;r5=r1+36|0;r6=HEAP32[HEAP32[r5>>2]+(r2<<2)>>2];HEAP32[r3>>2]=r6;HEAP32[r4>>2]=HEAP32[HEAP32[r5>>2]+(r2+1<<2)>>2]-r6;r6=r1+12|0;r5=HEAP32[r6>>2];if((r5|0)==0){__ZN9RCqsmodel6updateEv(r1);r7=HEAP32[r6>>2]}else{r7=r5}HEAP32[r6>>2]=r7-1;r7=HEAP32[r1+32>>2]+(r2<<2)|0;HEAP32[r7>>2]=HEAP32[r7>>2]+HEAP32[r1+20>>2];return}function __ZN9RCqsmodel9normalizeERj(r1,r2){HEAP32[r2>>2]=HEAP32[r2>>2]>>>(HEAP32[r1+8>>2]>>>0);return}function ___getTypeName(r1){return _strdup(HEAP32[r1+4>>2])}function __ZN53EmscriptenBindingInitializer_native_and_builtin_typesC2Ev(){__embind_register_void(1376,312);__embind_register_bool(1384,320,1,0);__embind_register_integer(__ZTIc,184,-128,127);__embind_register_integer(__ZTIa,112,-128,127);__embind_register_integer(__ZTIh,80,0,255);__embind_register_integer(__ZTIs,72,-32768,32767);__embind_register_integer(__ZTIt,56,0,65535);__embind_register_integer(__ZTIi,32,-2147483648,2147483647);__embind_register_integer(__ZTIj,16,0,-1);__embind_register_integer(__ZTIl,8,-2147483648,2147483647);__embind_register_integer(__ZTIm,336,0,-1);__embind_register_float(__ZTIf,328);__embind_register_float(__ZTId,304);__embind_register_std_string(1496,288);__embind_register_std_wstring(1472,4,272);__embind_register_emval(1520,256);__embind_register_memory_view(1528,232);return}function __GLOBAL__I_a19(){__ZN53EmscriptenBindingInitializer_native_and_builtin_typesC2Ev();return}function __ZNK10__cxxabiv116__shim_type_info5noop1Ev(r1){return}function __ZNK10__cxxabiv116__shim_type_info5noop2Ev(r1){return}function __ZN10__cxxabiv123__fundamental_type_infoD0Ev(r1){if((r1|0)==0){return}_free(r1);return}function __ZN10__cxxabiv123__fundamental_type_infoD2Ev(r1){return}function __ZN10__cxxabiv117__class_type_infoD0Ev(r1){if((r1|0)==0){return}_free(r1);return}function __ZN10__cxxabiv117__class_type_infoD2Ev(r1){return}function __ZN10__cxxabiv120__si_class_type_infoD0Ev(r1){if((r1|0)==0){return}_free(r1);return}function __ZN10__cxxabiv120__si_class_type_infoD2Ev(r1){return}function __ZN10__cxxabiv121__vmi_class_type_infoD0Ev(r1){if((r1|0)==0){return}_free(r1);return}function __ZN10__cxxabiv121__vmi_class_type_infoD2Ev(r1){return}function __ZN10__cxxabiv119__pointer_type_infoD0Ev(r1){if((r1|0)==0){return}_free(r1);return}function __ZN10__cxxabiv119__pointer_type_infoD2Ev(r1){return}function __ZNK10__cxxabiv123__fundamental_type_info9can_catchEPKNS_16__shim_type_infoERPv(r1,r2,r3){return(r1|0)==(r2|0)}function __ZNK10__cxxabiv117__class_type_info9can_catchEPKNS_16__shim_type_infoERPv(r1,r2,r3){var r4,r5,r6,r7;r4=STACKTOP;STACKTOP=STACKTOP+56|0;r5=r4;if((r1|0)==(r2|0)){r6=1;STACKTOP=r4;return r6}if((r2|0)==0){r6=0;STACKTOP=r4;return r6}r7=___dynamic_cast(r2,1616);r2=r7;if((r7|0)==0){r6=0;STACKTOP=r4;return r6}_memset(r5,0,56)|0;HEAP32[r5>>2]=r2;HEAP32[r5+8>>2]=r1;HEAP32[r5+12>>2]=-1;HEAP32[r5+48>>2]=1;FUNCTION_TABLE[HEAP32[HEAP32[r7>>2]+28>>2]](r2,r5,HEAP32[r3>>2],1);if((HEAP32[r5+24>>2]|0)!=1){r6=0;STACKTOP=r4;return r6}HEAP32[r3>>2]=HEAP32[r5+16>>2];r6=1;STACKTOP=r4;return r6}function __ZNK10__cxxabiv117__class_type_info27has_unambiguous_public_baseEPNS_19__dynamic_cast_infoEPvi(r1,r2,r3,r4){var r5;if((HEAP32[r2+8>>2]|0)!=(r1|0)){return}r1=r2+16|0;r5=HEAP32[r1>>2];if((r5|0)==0){HEAP32[r1>>2]=r3;HEAP32[r2+24>>2]=r4;HEAP32[r2+36>>2]=1;return}if((r5|0)!=(r3|0)){r3=r2+36|0;HEAP32[r3>>2]=HEAP32[r3>>2]+1;HEAP32[r2+24>>2]=2;HEAP8[r2+54|0]=1;return}r3=r2+24|0;if((HEAP32[r3>>2]|0)!=2){return}HEAP32[r3>>2]=r4;return}function __ZNK10__cxxabiv120__si_class_type_info27has_unambiguous_public_baseEPNS_19__dynamic_cast_infoEPvi(r1,r2,r3,r4){var r5;if((r1|0)!=(HEAP32[r2+8>>2]|0)){r5=HEAP32[r1+8>>2];FUNCTION_TABLE[HEAP32[HEAP32[r5>>2]+28>>2]](r5,r2,r3,r4);return}r5=r2+16|0;r1=HEAP32[r5>>2];if((r1|0)==0){HEAP32[r5>>2]=r3;HEAP32[r2+24>>2]=r4;HEAP32[r2+36>>2]=1;return}if((r1|0)!=(r3|0)){r3=r2+36|0;HEAP32[r3>>2]=HEAP32[r3>>2]+1;HEAP32[r2+24>>2]=2;HEAP8[r2+54|0]=1;return}r3=r2+24|0;if((HEAP32[r3>>2]|0)!=2){return}HEAP32[r3>>2]=r4;return}function __ZNK10__cxxabiv121__vmi_class_type_info27has_unambiguous_public_baseEPNS_19__dynamic_cast_infoEPvi(r1,r2,r3,r4){var r5,r6,r7,r8,r9,r10,r11;r5=0;if((r1|0)==(HEAP32[r2+8>>2]|0)){r6=r2+16|0;r7=HEAP32[r6>>2];if((r7|0)==0){HEAP32[r6>>2]=r3;HEAP32[r2+24>>2]=r4;HEAP32[r2+36>>2]=1;return}if((r7|0)!=(r3|0)){r7=r2+36|0;HEAP32[r7>>2]=HEAP32[r7>>2]+1;HEAP32[r2+24>>2]=2;HEAP8[r2+54|0]=1;return}r7=r2+24|0;if((HEAP32[r7>>2]|0)!=2){return}HEAP32[r7>>2]=r4;return}r7=HEAP32[r1+12>>2];r6=r1+16+(r7<<3)|0;r8=HEAP32[r1+20>>2];r9=r8>>8;if((r8&1|0)==0){r10=r9}else{r10=HEAP32[HEAP32[r3>>2]+r9>>2]}r9=HEAP32[r1+16>>2];FUNCTION_TABLE[HEAP32[HEAP32[r9>>2]+28>>2]](r9,r2,r3+r10|0,(r8&2|0)!=0?r4:2);if((r7|0)<=1){return}r7=r2+54|0;r8=r3;r10=r1+24|0;while(1){r1=HEAP32[r10+4>>2];r9=r1>>8;if((r1&1|0)==0){r11=r9}else{r11=HEAP32[HEAP32[r8>>2]+r9>>2]}r9=HEAP32[r10>>2];FUNCTION_TABLE[HEAP32[HEAP32[r9>>2]+28>>2]](r9,r2,r3+r11|0,(r1&2|0)!=0?r4:2);if((HEAP8[r7]&1)!=0){r5=16;break}r1=r10+8|0;if(r1>>>0<r6>>>0){r10=r1}else{r5=16;break}}if(r5==16){return}}function __ZNK10__cxxabiv119__pointer_type_info9can_catchEPKNS_16__shim_type_infoERPv(r1,r2,r3){var r4,r5,r6,r7,r8,r9,r10;r4=STACKTOP;STACKTOP=STACKTOP+56|0;r5=r4;HEAP32[r3>>2]=HEAP32[HEAP32[r3>>2]>>2];r6=r2|0;do{if((r1|0)==(r6|0)|(r6|0)==1648){r7=1}else{if((r2|0)==0){r7=0;break}r8=___dynamic_cast(r2,1584);if((r8|0)==0){r7=0;break}if((HEAP32[r8+8>>2]&~HEAP32[r1+8>>2]|0)!=0){r7=0;break}r9=HEAP32[r1+12>>2];r10=r8+12|0;if((r9|0)==(HEAP32[r10>>2]|0)|(r9|0)==1376){r7=1;break}if((r9|0)==0){r7=0;break}r8=___dynamic_cast(r9,1616);if((r8|0)==0){r7=0;break}r9=HEAP32[r10>>2];if((r9|0)==0){r7=0;break}r10=___dynamic_cast(r9,1616);r9=r10;if((r10|0)==0){r7=0;break}_memset(r5,0,56)|0;HEAP32[r5>>2]=r9;HEAP32[r5+8>>2]=r8;HEAP32[r5+12>>2]=-1;HEAP32[r5+48>>2]=1;FUNCTION_TABLE[HEAP32[HEAP32[r10>>2]+28>>2]](r9,r5,HEAP32[r3>>2],1);if((HEAP32[r5+24>>2]|0)!=1){r7=0;break}HEAP32[r3>>2]=HEAP32[r5+16>>2];r7=1}}while(0);STACKTOP=r4;return r7}function ___dynamic_cast(r1,r2){var r3,r4,r5,r6,r7,r8,r9,r10,r11,r12;r3=STACKTOP;STACKTOP=STACKTOP+56|0;r4=r3;r5=HEAP32[r1>>2];r6=r1+HEAP32[r5-8>>2]|0;r7=HEAP32[r5-4>>2];r5=r7;HEAP32[r4>>2]=r2;HEAP32[r4+4>>2]=r1;HEAP32[r4+8>>2]=1632;r1=r4+16|0;r8=r4+24|0;r9=r4+28|0;r10=r4+32|0;r11=r4+40|0;_memset(r4+12|0,0,43)|0;if((r7|0)==(r2|0)){HEAP32[r4+48>>2]=1;FUNCTION_TABLE[HEAP32[HEAP32[r7>>2]+20>>2]](r5,r4,r6,r6,1,0);STACKTOP=r3;return(HEAP32[r8>>2]|0)==1?r6:0}FUNCTION_TABLE[HEAP32[HEAP32[r7>>2]+24>>2]](r5,r4,r6,1,0);r6=HEAP32[r4+36>>2];if((r6|0)==0){STACKTOP=r3;return(HEAP32[r11>>2]|0)==1&(HEAP32[r9>>2]|0)==1&(HEAP32[r10>>2]|0)==1?HEAP32[r4+20>>2]:0}else if((r6|0)==1){do{if((HEAP32[r8>>2]|0)!=1){if((HEAP32[r11>>2]|0)==0&(HEAP32[r9>>2]|0)==1&(HEAP32[r10>>2]|0)==1){break}else{r12=0}STACKTOP=r3;return r12}}while(0);r12=HEAP32[r1>>2];STACKTOP=r3;return r12}else{r12=0;STACKTOP=r3;return r12}}function __ZNK10__cxxabiv121__vmi_class_type_info16search_below_dstEPNS_19__dynamic_cast_infoEPKvib(r1,r2,r3,r4,r5){var r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18,r19,r20,r21,r22,r23,r24,r25,r26,r27,r28,r29,r30,r31,r32;r6=0;r7=r1|0;if((r7|0)==(HEAP32[r2+8>>2]|0)){if((HEAP32[r2+4>>2]|0)!=(r3|0)){return}r8=r2+28|0;if((HEAP32[r8>>2]|0)==1){return}HEAP32[r8>>2]=r4;return}if((r7|0)==(HEAP32[r2>>2]|0)){do{if((HEAP32[r2+16>>2]|0)!=(r3|0)){r7=r2+20|0;if((HEAP32[r7>>2]|0)==(r3|0)){break}HEAP32[r2+32>>2]=r4;r8=r2+44|0;if((HEAP32[r8>>2]|0)==4){return}r9=HEAP32[r1+12>>2];r10=r1+16+(r9<<3)|0;L19:do{if((r9|0)>0){r11=r2+52|0;r12=r2+53|0;r13=r2+54|0;r14=r1+8|0;r15=r2+24|0;r16=r3;r17=0;r18=r1+16|0;r19=0;L21:while(1){HEAP8[r11]=0;HEAP8[r12]=0;r20=HEAP32[r18+4>>2];r21=r20>>8;if((r20&1|0)==0){r22=r21}else{r22=HEAP32[HEAP32[r16>>2]+r21>>2]}r21=HEAP32[r18>>2];FUNCTION_TABLE[HEAP32[HEAP32[r21>>2]+20>>2]](r21,r2,r3,r3+r22|0,2-(r20>>>1&1)|0,r5);if((HEAP8[r13]&1)!=0){r23=r19;r24=r17;break}do{if((HEAP8[r12]&1)==0){r25=r19;r26=r17}else{if((HEAP8[r11]&1)==0){if((HEAP32[r14>>2]&1|0)==0){r23=1;r24=r17;break L21}else{r25=1;r26=r17;break}}if((HEAP32[r15>>2]|0)==1){r6=27;break L19}if((HEAP32[r14>>2]&2|0)==0){r6=27;break L19}else{r25=1;r26=1}}}while(0);r20=r18+8|0;if(r20>>>0<r10>>>0){r17=r26;r18=r20;r19=r25}else{r23=r25;r24=r26;break}}if(r24){r27=r23;r6=26}else{r28=r23;r6=23}}else{r28=0;r6=23}}while(0);do{if(r6==23){HEAP32[r7>>2]=r3;r10=r2+40|0;HEAP32[r10>>2]=HEAP32[r10>>2]+1;if((HEAP32[r2+36>>2]|0)!=1){r27=r28;r6=26;break}if((HEAP32[r2+24>>2]|0)!=2){r27=r28;r6=26;break}HEAP8[r2+54|0]=1;if(r28){r6=27}else{r6=28}}}while(0);if(r6==26){if(r27){r6=27}else{r6=28}}if(r6==27){HEAP32[r8>>2]=3;return}else if(r6==28){HEAP32[r8>>2]=4;return}}}while(0);if((r4|0)!=1){return}HEAP32[r2+32>>2]=1;return}r27=HEAP32[r1+12>>2];r28=r1+16+(r27<<3)|0;r23=HEAP32[r1+20>>2];r24=r23>>8;if((r23&1|0)==0){r29=r24}else{r29=HEAP32[HEAP32[r3>>2]+r24>>2]}r24=HEAP32[r1+16>>2];FUNCTION_TABLE[HEAP32[HEAP32[r24>>2]+24>>2]](r24,r2,r3+r29|0,(r23&2|0)!=0?r4:2,r5);r23=r1+24|0;if((r27|0)<=1){return}r27=HEAP32[r1+8>>2];do{if((r27&2|0)==0){r1=r2+36|0;if((HEAP32[r1>>2]|0)==1){break}if((r27&1|0)==0){r29=r2+54|0;r24=r3;r26=r23;while(1){if((HEAP8[r29]&1)!=0){r6=53;break}if((HEAP32[r1>>2]|0)==1){r6=53;break}r25=HEAP32[r26+4>>2];r22=r25>>8;if((r25&1|0)==0){r30=r22}else{r30=HEAP32[HEAP32[r24>>2]+r22>>2]}r22=HEAP32[r26>>2];FUNCTION_TABLE[HEAP32[HEAP32[r22>>2]+24>>2]](r22,r2,r3+r30|0,(r25&2|0)!=0?r4:2,r5);r25=r26+8|0;if(r25>>>0<r28>>>0){r26=r25}else{r6=53;break}}if(r6==53){return}}r26=r2+24|0;r24=r2+54|0;r29=r3;r8=r23;while(1){if((HEAP8[r24]&1)!=0){r6=53;break}if((HEAP32[r1>>2]|0)==1){if((HEAP32[r26>>2]|0)==1){r6=53;break}}r25=HEAP32[r8+4>>2];r22=r25>>8;if((r25&1|0)==0){r31=r22}else{r31=HEAP32[HEAP32[r29>>2]+r22>>2]}r22=HEAP32[r8>>2];FUNCTION_TABLE[HEAP32[HEAP32[r22>>2]+24>>2]](r22,r2,r3+r31|0,(r25&2|0)!=0?r4:2,r5);r25=r8+8|0;if(r25>>>0<r28>>>0){r8=r25}else{r6=53;break}}if(r6==53){return}}}while(0);r31=r2+54|0;r30=r3;r27=r23;while(1){if((HEAP8[r31]&1)!=0){r6=53;break}r23=HEAP32[r27+4>>2];r8=r23>>8;if((r23&1|0)==0){r32=r8}else{r32=HEAP32[HEAP32[r30>>2]+r8>>2]}r8=HEAP32[r27>>2];FUNCTION_TABLE[HEAP32[HEAP32[r8>>2]+24>>2]](r8,r2,r3+r32|0,(r23&2|0)!=0?r4:2,r5);r23=r27+8|0;if(r23>>>0<r28>>>0){r27=r23}else{r6=53;break}}if(r6==53){return}}function __ZNK10__cxxabiv120__si_class_type_info16search_below_dstEPNS_19__dynamic_cast_infoEPKvib(r1,r2,r3,r4,r5){var r6,r7,r8,r9,r10,r11,r12;r6=0;r7=r1|0;if((r7|0)==(HEAP32[r2+8>>2]|0)){if((HEAP32[r2+4>>2]|0)!=(r3|0)){return}r8=r2+28|0;if((HEAP32[r8>>2]|0)==1){return}HEAP32[r8>>2]=r4;return}if((r7|0)!=(HEAP32[r2>>2]|0)){r7=HEAP32[r1+8>>2];FUNCTION_TABLE[HEAP32[HEAP32[r7>>2]+24>>2]](r7,r2,r3,r4,r5);return}do{if((HEAP32[r2+16>>2]|0)!=(r3|0)){r7=r2+20|0;if((HEAP32[r7>>2]|0)==(r3|0)){break}HEAP32[r2+32>>2]=r4;r8=r2+44|0;if((HEAP32[r8>>2]|0)==4){return}r9=r2+52|0;HEAP8[r9]=0;r10=r2+53|0;HEAP8[r10]=0;r11=HEAP32[r1+8>>2];FUNCTION_TABLE[HEAP32[HEAP32[r11>>2]+20>>2]](r11,r2,r3,r3,1,r5);if((HEAP8[r10]&1)==0){r12=0;r6=13}else{if((HEAP8[r9]&1)==0){r12=1;r6=13}}L23:do{if(r6==13){HEAP32[r7>>2]=r3;r9=r2+40|0;HEAP32[r9>>2]=HEAP32[r9>>2]+1;do{if((HEAP32[r2+36>>2]|0)==1){if((HEAP32[r2+24>>2]|0)!=2){r6=16;break}HEAP8[r2+54|0]=1;if(r12){break L23}}else{r6=16}}while(0);if(r6==16){if(r12){break}}HEAP32[r8>>2]=4;return}}while(0);HEAP32[r8>>2]=3;return}}while(0);if((r4|0)!=1){return}HEAP32[r2+32>>2]=1;return}function __ZNK10__cxxabiv117__class_type_info16search_below_dstEPNS_19__dynamic_cast_infoEPKvib(r1,r2,r3,r4,r5){if((HEAP32[r2+8>>2]|0)==(r1|0)){if((HEAP32[r2+4>>2]|0)!=(r3|0)){return}r5=r2+28|0;if((HEAP32[r5>>2]|0)==1){return}HEAP32[r5>>2]=r4;return}if((HEAP32[r2>>2]|0)!=(r1|0)){return}do{if((HEAP32[r2+16>>2]|0)!=(r3|0)){r1=r2+20|0;if((HEAP32[r1>>2]|0)==(r3|0)){break}HEAP32[r2+32>>2]=r4;HEAP32[r1>>2]=r3;r1=r2+40|0;HEAP32[r1>>2]=HEAP32[r1>>2]+1;do{if((HEAP32[r2+36>>2]|0)==1){if((HEAP32[r2+24>>2]|0)!=2){break}HEAP8[r2+54|0]=1}}while(0);HEAP32[r2+44>>2]=4;return}}while(0);if((r4|0)!=1){return}HEAP32[r2+32>>2]=1;return}function __ZNK10__cxxabiv121__vmi_class_type_info16search_above_dstEPNS_19__dynamic_cast_infoEPKvS4_ib(r1,r2,r3,r4,r5,r6){var r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18,r19,r20,r21;if((r1|0)!=(HEAP32[r2+8>>2]|0)){r7=r2+52|0;r8=HEAP8[r7]&1;r9=r2+53|0;r10=HEAP8[r9]&1;r11=HEAP32[r1+12>>2];r12=r1+16+(r11<<3)|0;HEAP8[r7]=0;HEAP8[r9]=0;r13=HEAP32[r1+20>>2];r14=r13>>8;if((r13&1|0)==0){r15=r14}else{r15=HEAP32[HEAP32[r4>>2]+r14>>2]}r14=HEAP32[r1+16>>2];FUNCTION_TABLE[HEAP32[HEAP32[r14>>2]+20>>2]](r14,r2,r3,r4+r15|0,(r13&2|0)!=0?r5:2,r6);L6:do{if((r11|0)>1){r13=r2+24|0;r15=r1+8|0;r14=r2+54|0;r16=r4;r17=r1+24|0;while(1){if((HEAP8[r14]&1)!=0){break L6}do{if((HEAP8[r7]&1)==0){if((HEAP8[r9]&1)==0){break}if((HEAP32[r15>>2]&1|0)==0){break L6}}else{if((HEAP32[r13>>2]|0)==1){break L6}if((HEAP32[r15>>2]&2|0)==0){break L6}}}while(0);HEAP8[r7]=0;HEAP8[r9]=0;r18=HEAP32[r17+4>>2];r19=r18>>8;if((r18&1|0)==0){r20=r19}else{r20=HEAP32[HEAP32[r16>>2]+r19>>2]}r19=HEAP32[r17>>2];FUNCTION_TABLE[HEAP32[HEAP32[r19>>2]+20>>2]](r19,r2,r3,r4+r20|0,(r18&2|0)!=0?r5:2,r6);r18=r17+8|0;if(r18>>>0<r12>>>0){r17=r18}else{break}}}}while(0);HEAP8[r7]=r8;HEAP8[r9]=r10;return}HEAP8[r2+53|0]=1;if((HEAP32[r2+4>>2]|0)!=(r4|0)){return}HEAP8[r2+52|0]=1;r4=r2+16|0;r10=HEAP32[r4>>2];if((r10|0)==0){HEAP32[r4>>2]=r3;HEAP32[r2+24>>2]=r5;HEAP32[r2+36>>2]=1;if(!((HEAP32[r2+48>>2]|0)==1&(r5|0)==1)){return}HEAP8[r2+54|0]=1;return}if((r10|0)!=(r3|0)){r3=r2+36|0;HEAP32[r3>>2]=HEAP32[r3>>2]+1;HEAP8[r2+54|0]=1;return}r3=r2+24|0;r10=HEAP32[r3>>2];if((r10|0)==2){HEAP32[r3>>2]=r5;r21=r5}else{r21=r10}if(!((HEAP32[r2+48>>2]|0)==1&(r21|0)==1)){return}HEAP8[r2+54|0]=1;return}function __ZNK10__cxxabiv120__si_class_type_info16search_above_dstEPNS_19__dynamic_cast_infoEPKvS4_ib(r1,r2,r3,r4,r5,r6){var r7,r8;if((r1|0)!=(HEAP32[r2+8>>2]|0)){r7=HEAP32[r1+8>>2];FUNCTION_TABLE[HEAP32[HEAP32[r7>>2]+20>>2]](r7,r2,r3,r4,r5,r6);return}HEAP8[r2+53|0]=1;if((HEAP32[r2+4>>2]|0)!=(r4|0)){return}HEAP8[r2+52|0]=1;r4=r2+16|0;r6=HEAP32[r4>>2];if((r6|0)==0){HEAP32[r4>>2]=r3;HEAP32[r2+24>>2]=r5;HEAP32[r2+36>>2]=1;if(!((HEAP32[r2+48>>2]|0)==1&(r5|0)==1)){return}HEAP8[r2+54|0]=1;return}if((r6|0)!=(r3|0)){r3=r2+36|0;HEAP32[r3>>2]=HEAP32[r3>>2]+1;HEAP8[r2+54|0]=1;return}r3=r2+24|0;r6=HEAP32[r3>>2];if((r6|0)==2){HEAP32[r3>>2]=r5;r8=r5}else{r8=r6}if(!((HEAP32[r2+48>>2]|0)==1&(r8|0)==1)){return}HEAP8[r2+54|0]=1;return}function __ZNK10__cxxabiv117__class_type_info16search_above_dstEPNS_19__dynamic_cast_infoEPKvS4_ib(r1,r2,r3,r4,r5,r6){var r7;if((HEAP32[r2+8>>2]|0)!=(r1|0)){return}HEAP8[r2+53|0]=1;if((HEAP32[r2+4>>2]|0)!=(r4|0)){return}HEAP8[r2+52|0]=1;r4=r2+16|0;r1=HEAP32[r4>>2];if((r1|0)==0){HEAP32[r4>>2]=r3;HEAP32[r2+24>>2]=r5;HEAP32[r2+36>>2]=1;if(!((HEAP32[r2+48>>2]|0)==1&(r5|0)==1)){return}HEAP8[r2+54|0]=1;return}if((r1|0)!=(r3|0)){r3=r2+36|0;HEAP32[r3>>2]=HEAP32[r3>>2]+1;HEAP8[r2+54|0]=1;return}r3=r2+24|0;r1=HEAP32[r3>>2];if((r1|0)==2){HEAP32[r3>>2]=r5;r7=r5}else{r7=r1}if(!((HEAP32[r2+48>>2]|0)==1&(r7|0)==1)){return}HEAP8[r2+54|0]=1;return}function _malloc(r1){var r2,r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18,r19,r20,r21,r22,r23,r24,r25,r26,r27,r28,r29,r30,r31,r32,r33,r34,r35,r36,r37,r38,r39,r40,r41,r42,r43,r44,r45,r46,r47,r48,r49,r50,r51,r52,r53,r54,r55,r56,r57,r58,r59,r60,r61,r62,r63,r64,r65,r66,r67,r68,r69,r70,r71,r72,r73,r74,r75,r76,r77,r78,r79,r80,r81,r82,r83,r84,r85,r86,r87,r88,r89;r2=0;do{if(r1>>>0<245){if(r1>>>0<11){r3=16}else{r3=r1+11&-8}r4=r3>>>3;r5=HEAP32[1744>>2];r6=r5>>>(r4>>>0);if((r6&3|0)!=0){r7=(r6&1^1)+r4|0;r8=r7<<1;r9=1784+(r8<<2)|0;r10=1784+(r8+2<<2)|0;r8=HEAP32[r10>>2];r11=r8+8|0;r12=HEAP32[r11>>2];do{if((r9|0)==(r12|0)){HEAP32[1744>>2]=r5&~(1<<r7)}else{if(r12>>>0<HEAP32[1760>>2]>>>0){_abort()}r13=r12+12|0;if((HEAP32[r13>>2]|0)==(r8|0)){HEAP32[r13>>2]=r9;HEAP32[r10>>2]=r12;break}else{_abort()}}}while(0);r12=r7<<3;HEAP32[r8+4>>2]=r12|3;r10=r8+(r12|4)|0;HEAP32[r10>>2]=HEAP32[r10>>2]|1;r14=r11;return r14}if(r3>>>0<=HEAP32[1752>>2]>>>0){r15=r3;break}if((r6|0)!=0){r10=2<<r4;r12=r6<<r4&(r10|-r10);r10=(r12&-r12)-1|0;r12=r10>>>12&16;r9=r10>>>(r12>>>0);r10=r9>>>5&8;r13=r9>>>(r10>>>0);r9=r13>>>2&4;r16=r13>>>(r9>>>0);r13=r16>>>1&2;r17=r16>>>(r13>>>0);r16=r17>>>1&1;r18=(r10|r12|r9|r13|r16)+(r17>>>(r16>>>0))|0;r16=r18<<1;r17=1784+(r16<<2)|0;r13=1784+(r16+2<<2)|0;r16=HEAP32[r13>>2];r9=r16+8|0;r12=HEAP32[r9>>2];do{if((r17|0)==(r12|0)){HEAP32[1744>>2]=r5&~(1<<r18)}else{if(r12>>>0<HEAP32[1760>>2]>>>0){_abort()}r10=r12+12|0;if((HEAP32[r10>>2]|0)==(r16|0)){HEAP32[r10>>2]=r17;HEAP32[r13>>2]=r12;break}else{_abort()}}}while(0);r12=r18<<3;r13=r12-r3|0;HEAP32[r16+4>>2]=r3|3;r17=r16;r5=r17+r3|0;HEAP32[r17+(r3|4)>>2]=r13|1;HEAP32[r17+r12>>2]=r13;r12=HEAP32[1752>>2];if((r12|0)!=0){r17=HEAP32[1764>>2];r4=r12>>>3;r12=r4<<1;r6=1784+(r12<<2)|0;r11=HEAP32[1744>>2];r8=1<<r4;do{if((r11&r8|0)==0){HEAP32[1744>>2]=r11|r8;r19=r6;r20=1784+(r12+2<<2)|0}else{r4=1784+(r12+2<<2)|0;r7=HEAP32[r4>>2];if(r7>>>0>=HEAP32[1760>>2]>>>0){r19=r7;r20=r4;break}_abort()}}while(0);HEAP32[r20>>2]=r17;HEAP32[r19+12>>2]=r17;HEAP32[r17+8>>2]=r19;HEAP32[r17+12>>2]=r6}HEAP32[1752>>2]=r13;HEAP32[1764>>2]=r5;r14=r9;return r14}r12=HEAP32[1748>>2];if((r12|0)==0){r15=r3;break}r8=(r12&-r12)-1|0;r12=r8>>>12&16;r11=r8>>>(r12>>>0);r8=r11>>>5&8;r16=r11>>>(r8>>>0);r11=r16>>>2&4;r18=r16>>>(r11>>>0);r16=r18>>>1&2;r4=r18>>>(r16>>>0);r18=r4>>>1&1;r7=HEAP32[2048+((r8|r12|r11|r16|r18)+(r4>>>(r18>>>0))<<2)>>2];r18=r7;r4=r7;r16=(HEAP32[r7+4>>2]&-8)-r3|0;while(1){r7=HEAP32[r18+16>>2];if((r7|0)==0){r11=HEAP32[r18+20>>2];if((r11|0)==0){break}else{r21=r11}}else{r21=r7}r7=(HEAP32[r21+4>>2]&-8)-r3|0;r11=r7>>>0<r16>>>0;r18=r21;r4=r11?r21:r4;r16=r11?r7:r16}r18=r4;r9=HEAP32[1760>>2];if(r18>>>0<r9>>>0){_abort()}r5=r18+r3|0;r13=r5;if(r18>>>0>=r5>>>0){_abort()}r5=HEAP32[r4+24>>2];r6=HEAP32[r4+12>>2];do{if((r6|0)==(r4|0)){r17=r4+20|0;r7=HEAP32[r17>>2];if((r7|0)==0){r11=r4+16|0;r12=HEAP32[r11>>2];if((r12|0)==0){r22=0;break}else{r23=r12;r24=r11}}else{r23=r7;r24=r17}while(1){r17=r23+20|0;r7=HEAP32[r17>>2];if((r7|0)!=0){r23=r7;r24=r17;continue}r17=r23+16|0;r7=HEAP32[r17>>2];if((r7|0)==0){break}else{r23=r7;r24=r17}}if(r24>>>0<r9>>>0){_abort()}else{HEAP32[r24>>2]=0;r22=r23;break}}else{r17=HEAP32[r4+8>>2];if(r17>>>0<r9>>>0){_abort()}r7=r17+12|0;if((HEAP32[r7>>2]|0)!=(r4|0)){_abort()}r11=r6+8|0;if((HEAP32[r11>>2]|0)==(r4|0)){HEAP32[r7>>2]=r6;HEAP32[r11>>2]=r17;r22=r6;break}else{_abort()}}}while(0);L78:do{if((r5|0)!=0){r6=r4+28|0;r9=2048+(HEAP32[r6>>2]<<2)|0;do{if((r4|0)==(HEAP32[r9>>2]|0)){HEAP32[r9>>2]=r22;if((r22|0)!=0){break}HEAP32[1748>>2]=HEAP32[1748>>2]&~(1<<HEAP32[r6>>2]);break L78}else{if(r5>>>0<HEAP32[1760>>2]>>>0){_abort()}r17=r5+16|0;if((HEAP32[r17>>2]|0)==(r4|0)){HEAP32[r17>>2]=r22}else{HEAP32[r5+20>>2]=r22}if((r22|0)==0){break L78}}}while(0);if(r22>>>0<HEAP32[1760>>2]>>>0){_abort()}HEAP32[r22+24>>2]=r5;r6=HEAP32[r4+16>>2];do{if((r6|0)!=0){if(r6>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r22+16>>2]=r6;HEAP32[r6+24>>2]=r22;break}}}while(0);r6=HEAP32[r4+20>>2];if((r6|0)==0){break}if(r6>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r22+20>>2]=r6;HEAP32[r6+24>>2]=r22;break}}}while(0);if(r16>>>0<16){r5=r16+r3|0;HEAP32[r4+4>>2]=r5|3;r6=r18+(r5+4)|0;HEAP32[r6>>2]=HEAP32[r6>>2]|1}else{HEAP32[r4+4>>2]=r3|3;HEAP32[r18+(r3|4)>>2]=r16|1;HEAP32[r18+(r16+r3)>>2]=r16;r6=HEAP32[1752>>2];if((r6|0)!=0){r5=HEAP32[1764>>2];r9=r6>>>3;r6=r9<<1;r17=1784+(r6<<2)|0;r11=HEAP32[1744>>2];r7=1<<r9;do{if((r11&r7|0)==0){HEAP32[1744>>2]=r11|r7;r25=r17;r26=1784+(r6+2<<2)|0}else{r9=1784+(r6+2<<2)|0;r12=HEAP32[r9>>2];if(r12>>>0>=HEAP32[1760>>2]>>>0){r25=r12;r26=r9;break}_abort()}}while(0);HEAP32[r26>>2]=r5;HEAP32[r25+12>>2]=r5;HEAP32[r5+8>>2]=r25;HEAP32[r5+12>>2]=r17}HEAP32[1752>>2]=r16;HEAP32[1764>>2]=r13}r14=r4+8|0;return r14}else{if(r1>>>0>4294967231){r15=-1;break}r6=r1+11|0;r7=r6&-8;r11=HEAP32[1748>>2];if((r11|0)==0){r15=r7;break}r18=-r7|0;r9=r6>>>8;do{if((r9|0)==0){r27=0}else{if(r7>>>0>16777215){r27=31;break}r6=(r9+1048320|0)>>>16&8;r12=r9<<r6;r8=(r12+520192|0)>>>16&4;r10=r12<<r8;r12=(r10+245760|0)>>>16&2;r28=14-(r8|r6|r12)+(r10<<r12>>>15)|0;r27=r7>>>((r28+7|0)>>>0)&1|r28<<1}}while(0);r9=HEAP32[2048+(r27<<2)>>2];L126:do{if((r9|0)==0){r29=0;r30=r18;r31=0}else{if((r27|0)==31){r32=0}else{r32=25-(r27>>>1)|0}r4=0;r13=r18;r16=r9;r17=r7<<r32;r5=0;while(1){r28=HEAP32[r16+4>>2]&-8;r12=r28-r7|0;if(r12>>>0<r13>>>0){if((r28|0)==(r7|0)){r29=r16;r30=r12;r31=r16;break L126}else{r33=r16;r34=r12}}else{r33=r4;r34=r13}r12=HEAP32[r16+20>>2];r28=HEAP32[r16+16+(r17>>>31<<2)>>2];r10=(r12|0)==0|(r12|0)==(r28|0)?r5:r12;if((r28|0)==0){r29=r33;r30=r34;r31=r10;break}else{r4=r33;r13=r34;r16=r28;r17=r17<<1;r5=r10}}}}while(0);if((r31|0)==0&(r29|0)==0){r9=2<<r27;r18=r11&(r9|-r9);if((r18|0)==0){r15=r7;break}r9=(r18&-r18)-1|0;r18=r9>>>12&16;r5=r9>>>(r18>>>0);r9=r5>>>5&8;r17=r5>>>(r9>>>0);r5=r17>>>2&4;r16=r17>>>(r5>>>0);r17=r16>>>1&2;r13=r16>>>(r17>>>0);r16=r13>>>1&1;r35=HEAP32[2048+((r9|r18|r5|r17|r16)+(r13>>>(r16>>>0))<<2)>>2]}else{r35=r31}if((r35|0)==0){r36=r30;r37=r29}else{r16=r35;r13=r30;r17=r29;while(1){r5=(HEAP32[r16+4>>2]&-8)-r7|0;r18=r5>>>0<r13>>>0;r9=r18?r5:r13;r5=r18?r16:r17;r18=HEAP32[r16+16>>2];if((r18|0)!=0){r16=r18;r13=r9;r17=r5;continue}r18=HEAP32[r16+20>>2];if((r18|0)==0){r36=r9;r37=r5;break}else{r16=r18;r13=r9;r17=r5}}}if((r37|0)==0){r15=r7;break}if(r36>>>0>=(HEAP32[1752>>2]-r7|0)>>>0){r15=r7;break}r17=r37;r13=HEAP32[1760>>2];if(r17>>>0<r13>>>0){_abort()}r16=r17+r7|0;r11=r16;if(r17>>>0>=r16>>>0){_abort()}r5=HEAP32[r37+24>>2];r9=HEAP32[r37+12>>2];do{if((r9|0)==(r37|0)){r18=r37+20|0;r4=HEAP32[r18>>2];if((r4|0)==0){r10=r37+16|0;r28=HEAP32[r10>>2];if((r28|0)==0){r38=0;break}else{r39=r28;r40=r10}}else{r39=r4;r40=r18}while(1){r18=r39+20|0;r4=HEAP32[r18>>2];if((r4|0)!=0){r39=r4;r40=r18;continue}r18=r39+16|0;r4=HEAP32[r18>>2];if((r4|0)==0){break}else{r39=r4;r40=r18}}if(r40>>>0<r13>>>0){_abort()}else{HEAP32[r40>>2]=0;r38=r39;break}}else{r18=HEAP32[r37+8>>2];if(r18>>>0<r13>>>0){_abort()}r4=r18+12|0;if((HEAP32[r4>>2]|0)!=(r37|0)){_abort()}r10=r9+8|0;if((HEAP32[r10>>2]|0)==(r37|0)){HEAP32[r4>>2]=r9;HEAP32[r10>>2]=r18;r38=r9;break}else{_abort()}}}while(0);L176:do{if((r5|0)!=0){r9=r37+28|0;r13=2048+(HEAP32[r9>>2]<<2)|0;do{if((r37|0)==(HEAP32[r13>>2]|0)){HEAP32[r13>>2]=r38;if((r38|0)!=0){break}HEAP32[1748>>2]=HEAP32[1748>>2]&~(1<<HEAP32[r9>>2]);break L176}else{if(r5>>>0<HEAP32[1760>>2]>>>0){_abort()}r18=r5+16|0;if((HEAP32[r18>>2]|0)==(r37|0)){HEAP32[r18>>2]=r38}else{HEAP32[r5+20>>2]=r38}if((r38|0)==0){break L176}}}while(0);if(r38>>>0<HEAP32[1760>>2]>>>0){_abort()}HEAP32[r38+24>>2]=r5;r9=HEAP32[r37+16>>2];do{if((r9|0)!=0){if(r9>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r38+16>>2]=r9;HEAP32[r9+24>>2]=r38;break}}}while(0);r9=HEAP32[r37+20>>2];if((r9|0)==0){break}if(r9>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r38+20>>2]=r9;HEAP32[r9+24>>2]=r38;break}}}while(0);L204:do{if(r36>>>0<16){r5=r36+r7|0;HEAP32[r37+4>>2]=r5|3;r9=r17+(r5+4)|0;HEAP32[r9>>2]=HEAP32[r9>>2]|1}else{HEAP32[r37+4>>2]=r7|3;HEAP32[r17+(r7|4)>>2]=r36|1;HEAP32[r17+(r36+r7)>>2]=r36;r9=r36>>>3;if(r36>>>0<256){r5=r9<<1;r13=1784+(r5<<2)|0;r18=HEAP32[1744>>2];r10=1<<r9;do{if((r18&r10|0)==0){HEAP32[1744>>2]=r18|r10;r41=r13;r42=1784+(r5+2<<2)|0}else{r9=1784+(r5+2<<2)|0;r4=HEAP32[r9>>2];if(r4>>>0>=HEAP32[1760>>2]>>>0){r41=r4;r42=r9;break}_abort()}}while(0);HEAP32[r42>>2]=r11;HEAP32[r41+12>>2]=r11;HEAP32[r17+(r7+8)>>2]=r41;HEAP32[r17+(r7+12)>>2]=r13;break}r5=r16;r10=r36>>>8;do{if((r10|0)==0){r43=0}else{if(r36>>>0>16777215){r43=31;break}r18=(r10+1048320|0)>>>16&8;r9=r10<<r18;r4=(r9+520192|0)>>>16&4;r28=r9<<r4;r9=(r28+245760|0)>>>16&2;r12=14-(r4|r18|r9)+(r28<<r9>>>15)|0;r43=r36>>>((r12+7|0)>>>0)&1|r12<<1}}while(0);r10=2048+(r43<<2)|0;HEAP32[r17+(r7+28)>>2]=r43;HEAP32[r17+(r7+20)>>2]=0;HEAP32[r17+(r7+16)>>2]=0;r13=HEAP32[1748>>2];r12=1<<r43;if((r13&r12|0)==0){HEAP32[1748>>2]=r13|r12;HEAP32[r10>>2]=r5;HEAP32[r17+(r7+24)>>2]=r10;HEAP32[r17+(r7+12)>>2]=r5;HEAP32[r17+(r7+8)>>2]=r5;break}r12=HEAP32[r10>>2];if((r43|0)==31){r44=0}else{r44=25-(r43>>>1)|0}L225:do{if((HEAP32[r12+4>>2]&-8|0)==(r36|0)){r45=r12}else{r10=r12;r13=r36<<r44;while(1){r46=r10+16+(r13>>>31<<2)|0;r9=HEAP32[r46>>2];if((r9|0)==0){break}if((HEAP32[r9+4>>2]&-8|0)==(r36|0)){r45=r9;break L225}else{r10=r9;r13=r13<<1}}if(r46>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r46>>2]=r5;HEAP32[r17+(r7+24)>>2]=r10;HEAP32[r17+(r7+12)>>2]=r5;HEAP32[r17+(r7+8)>>2]=r5;break L204}}}while(0);r12=r45+8|0;r13=HEAP32[r12>>2];r9=HEAP32[1760>>2];if(r45>>>0>=r9>>>0&r13>>>0>=r9>>>0){HEAP32[r13+12>>2]=r5;HEAP32[r12>>2]=r5;HEAP32[r17+(r7+8)>>2]=r13;HEAP32[r17+(r7+12)>>2]=r45;HEAP32[r17+(r7+24)>>2]=0;break}else{_abort()}}}while(0);r14=r37+8|0;return r14}}while(0);r37=HEAP32[1752>>2];if(r37>>>0>=r15>>>0){r45=r37-r15|0;r46=HEAP32[1764>>2];if(r45>>>0>15){r36=r46;HEAP32[1764>>2]=r36+r15;HEAP32[1752>>2]=r45;HEAP32[r36+(r15+4)>>2]=r45|1;HEAP32[r36+r37>>2]=r45;HEAP32[r46+4>>2]=r15|3}else{HEAP32[1752>>2]=0;HEAP32[1764>>2]=0;HEAP32[r46+4>>2]=r37|3;r45=r46+(r37+4)|0;HEAP32[r45>>2]=HEAP32[r45>>2]|1}r14=r46+8|0;return r14}r46=HEAP32[1756>>2];if(r46>>>0>r15>>>0){r45=r46-r15|0;HEAP32[1756>>2]=r45;r46=HEAP32[1768>>2];r37=r46;HEAP32[1768>>2]=r37+r15;HEAP32[r37+(r15+4)>>2]=r45|1;HEAP32[r46+4>>2]=r15|3;r14=r46+8|0;return r14}do{if((HEAP32[1712>>2]|0)==0){r46=_sysconf(30);if((r46-1&r46|0)==0){HEAP32[1720>>2]=r46;HEAP32[1716>>2]=r46;HEAP32[1724>>2]=-1;HEAP32[1728>>2]=-1;HEAP32[1732>>2]=0;HEAP32[2188>>2]=0;HEAP32[1712>>2]=_time(0)&-16^1431655768;break}else{_abort()}}}while(0);r46=r15+48|0;r45=HEAP32[1720>>2];r37=r15+47|0;r36=r45+r37|0;r44=-r45|0;r45=r36&r44;if(r45>>>0<=r15>>>0){r14=0;return r14}r43=HEAP32[2184>>2];do{if((r43|0)!=0){r41=HEAP32[2176>>2];r42=r41+r45|0;if(r42>>>0<=r41>>>0|r42>>>0>r43>>>0){r14=0}else{break}return r14}}while(0);L266:do{if((HEAP32[2188>>2]&4|0)==0){r43=HEAP32[1768>>2];L268:do{if((r43|0)==0){r2=181}else{r42=r43;r41=2192;while(1){r47=r41|0;r38=HEAP32[r47>>2];if(r38>>>0<=r42>>>0){r48=r41+4|0;if((r38+HEAP32[r48>>2]|0)>>>0>r42>>>0){break}}r38=HEAP32[r41+8>>2];if((r38|0)==0){r2=181;break L268}else{r41=r38}}if((r41|0)==0){r2=181;break}r42=r36-HEAP32[1756>>2]&r44;if(r42>>>0>=2147483647){r49=0;break}r5=_sbrk(r42);if((r5|0)==(HEAP32[r47>>2]+HEAP32[r48>>2]|0)){r50=r5;r51=r42;r2=190}else{r52=r42;r53=r5;r2=191}}}while(0);do{if(r2==181){r43=_sbrk(0);if((r43|0)==-1){r49=0;break}r5=r43;r42=HEAP32[1716>>2];r38=r42-1|0;if((r38&r5|0)==0){r54=r45}else{r54=r45-r5+(r38+r5&-r42)|0}r42=HEAP32[2176>>2];r5=r42+r54|0;if(!(r54>>>0>r15>>>0&r54>>>0<2147483647)){r49=0;break}r38=HEAP32[2184>>2];if((r38|0)!=0){if(r5>>>0<=r42>>>0|r5>>>0>r38>>>0){r49=0;break}}r38=_sbrk(r54);if((r38|0)==(r43|0)){r50=r43;r51=r54;r2=190}else{r52=r54;r53=r38;r2=191}}}while(0);L288:do{if(r2==190){if((r50|0)==-1){r49=r51}else{r55=r51;r56=r50;r2=201;break L266}}else if(r2==191){r38=-r52|0;do{if((r53|0)!=-1&r52>>>0<2147483647&r46>>>0>r52>>>0){r43=HEAP32[1720>>2];r5=r37-r52+r43&-r43;if(r5>>>0>=2147483647){r57=r52;break}if((_sbrk(r5)|0)==-1){_sbrk(r38);r49=0;break L288}else{r57=r5+r52|0;break}}else{r57=r52}}while(0);if((r53|0)==-1){r49=0}else{r55=r57;r56=r53;r2=201;break L266}}}while(0);HEAP32[2188>>2]=HEAP32[2188>>2]|4;r58=r49;r2=198}else{r58=0;r2=198}}while(0);do{if(r2==198){if(r45>>>0>=2147483647){break}r49=_sbrk(r45);r53=_sbrk(0);if(!((r49|0)!=-1&(r53|0)!=-1&r49>>>0<r53>>>0)){break}r57=r53-r49|0;r53=r57>>>0>(r15+40|0)>>>0;if(r53){r55=r53?r57:r58;r56=r49;r2=201}}}while(0);do{if(r2==201){r58=HEAP32[2176>>2]+r55|0;HEAP32[2176>>2]=r58;if(r58>>>0>HEAP32[2180>>2]>>>0){HEAP32[2180>>2]=r58}r58=HEAP32[1768>>2];L308:do{if((r58|0)==0){r45=HEAP32[1760>>2];if((r45|0)==0|r56>>>0<r45>>>0){HEAP32[1760>>2]=r56}HEAP32[2192>>2]=r56;HEAP32[2196>>2]=r55;HEAP32[2204>>2]=0;HEAP32[1780>>2]=HEAP32[1712>>2];HEAP32[1776>>2]=-1;r45=0;while(1){r49=r45<<1;r57=1784+(r49<<2)|0;HEAP32[1784+(r49+3<<2)>>2]=r57;HEAP32[1784+(r49+2<<2)>>2]=r57;r57=r45+1|0;if(r57>>>0<32){r45=r57}else{break}}r45=r56+8|0;if((r45&7|0)==0){r59=0}else{r59=-r45&7}r45=r55-40-r59|0;HEAP32[1768>>2]=r56+r59;HEAP32[1756>>2]=r45;HEAP32[r56+(r59+4)>>2]=r45|1;HEAP32[r56+(r55-36)>>2]=40;HEAP32[1772>>2]=HEAP32[1728>>2]}else{r45=2192;while(1){r60=HEAP32[r45>>2];r61=r45+4|0;r62=HEAP32[r61>>2];if((r56|0)==(r60+r62|0)){r2=213;break}r57=HEAP32[r45+8>>2];if((r57|0)==0){break}else{r45=r57}}do{if(r2==213){if((HEAP32[r45+12>>2]&8|0)!=0){break}r57=r58;if(!(r57>>>0>=r60>>>0&r57>>>0<r56>>>0)){break}HEAP32[r61>>2]=r62+r55;r57=HEAP32[1768>>2];r49=HEAP32[1756>>2]+r55|0;r53=r57;r52=r57+8|0;if((r52&7|0)==0){r63=0}else{r63=-r52&7}r52=r49-r63|0;HEAP32[1768>>2]=r53+r63;HEAP32[1756>>2]=r52;HEAP32[r53+(r63+4)>>2]=r52|1;HEAP32[r53+(r49+4)>>2]=40;HEAP32[1772>>2]=HEAP32[1728>>2];break L308}}while(0);if(r56>>>0<HEAP32[1760>>2]>>>0){HEAP32[1760>>2]=r56}r45=r56+r55|0;r49=2192;while(1){r64=r49|0;if((HEAP32[r64>>2]|0)==(r45|0)){r2=223;break}r53=HEAP32[r49+8>>2];if((r53|0)==0){break}else{r49=r53}}do{if(r2==223){if((HEAP32[r49+12>>2]&8|0)!=0){break}HEAP32[r64>>2]=r56;r45=r49+4|0;HEAP32[r45>>2]=HEAP32[r45>>2]+r55;r45=r56+8|0;if((r45&7|0)==0){r65=0}else{r65=-r45&7}r45=r56+(r55+8)|0;if((r45&7|0)==0){r66=0}else{r66=-r45&7}r45=r56+(r66+r55)|0;r53=r45;r52=r65+r15|0;r57=r56+r52|0;r37=r57;r46=r45-(r56+r65)-r15|0;HEAP32[r56+(r65+4)>>2]=r15|3;L335:do{if((r53|0)==(HEAP32[1768>>2]|0)){r50=HEAP32[1756>>2]+r46|0;HEAP32[1756>>2]=r50;HEAP32[1768>>2]=r37;HEAP32[r56+(r52+4)>>2]=r50|1}else{if((r53|0)==(HEAP32[1764>>2]|0)){r50=HEAP32[1752>>2]+r46|0;HEAP32[1752>>2]=r50;HEAP32[1764>>2]=r37;HEAP32[r56+(r52+4)>>2]=r50|1;HEAP32[r56+(r50+r52)>>2]=r50;break}r50=r55+4|0;r51=HEAP32[r56+(r50+r66)>>2];if((r51&3|0)==1){r54=r51&-8;r48=r51>>>3;L343:do{if(r51>>>0<256){r47=HEAP32[r56+((r66|8)+r55)>>2];r44=HEAP32[r56+(r55+12+r66)>>2];r36=1784+(r48<<1<<2)|0;do{if((r47|0)!=(r36|0)){if(r47>>>0<HEAP32[1760>>2]>>>0){_abort()}if((HEAP32[r47+12>>2]|0)==(r53|0)){break}_abort()}}while(0);if((r44|0)==(r47|0)){HEAP32[1744>>2]=HEAP32[1744>>2]&~(1<<r48);break}do{if((r44|0)==(r36|0)){r67=r44+8|0}else{if(r44>>>0<HEAP32[1760>>2]>>>0){_abort()}r38=r44+8|0;if((HEAP32[r38>>2]|0)==(r53|0)){r67=r38;break}_abort()}}while(0);HEAP32[r47+12>>2]=r44;HEAP32[r67>>2]=r47}else{r36=r45;r38=HEAP32[r56+((r66|24)+r55)>>2];r41=HEAP32[r56+(r55+12+r66)>>2];do{if((r41|0)==(r36|0)){r5=r66|16;r43=r56+(r50+r5)|0;r42=HEAP32[r43>>2];if((r42|0)==0){r39=r56+(r5+r55)|0;r5=HEAP32[r39>>2];if((r5|0)==0){r68=0;break}else{r69=r5;r70=r39}}else{r69=r42;r70=r43}while(1){r43=r69+20|0;r42=HEAP32[r43>>2];if((r42|0)!=0){r69=r42;r70=r43;continue}r43=r69+16|0;r42=HEAP32[r43>>2];if((r42|0)==0){break}else{r69=r42;r70=r43}}if(r70>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r70>>2]=0;r68=r69;break}}else{r43=HEAP32[r56+((r66|8)+r55)>>2];if(r43>>>0<HEAP32[1760>>2]>>>0){_abort()}r42=r43+12|0;if((HEAP32[r42>>2]|0)!=(r36|0)){_abort()}r39=r41+8|0;if((HEAP32[r39>>2]|0)==(r36|0)){HEAP32[r42>>2]=r41;HEAP32[r39>>2]=r43;r68=r41;break}else{_abort()}}}while(0);if((r38|0)==0){break}r41=r56+(r55+28+r66)|0;r47=2048+(HEAP32[r41>>2]<<2)|0;do{if((r36|0)==(HEAP32[r47>>2]|0)){HEAP32[r47>>2]=r68;if((r68|0)!=0){break}HEAP32[1748>>2]=HEAP32[1748>>2]&~(1<<HEAP32[r41>>2]);break L343}else{if(r38>>>0<HEAP32[1760>>2]>>>0){_abort()}r44=r38+16|0;if((HEAP32[r44>>2]|0)==(r36|0)){HEAP32[r44>>2]=r68}else{HEAP32[r38+20>>2]=r68}if((r68|0)==0){break L343}}}while(0);if(r68>>>0<HEAP32[1760>>2]>>>0){_abort()}HEAP32[r68+24>>2]=r38;r36=r66|16;r41=HEAP32[r56+(r36+r55)>>2];do{if((r41|0)!=0){if(r41>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r68+16>>2]=r41;HEAP32[r41+24>>2]=r68;break}}}while(0);r41=HEAP32[r56+(r50+r36)>>2];if((r41|0)==0){break}if(r41>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r68+20>>2]=r41;HEAP32[r41+24>>2]=r68;break}}}while(0);r71=r56+((r54|r66)+r55)|0;r72=r54+r46|0}else{r71=r53;r72=r46}r50=r71+4|0;HEAP32[r50>>2]=HEAP32[r50>>2]&-2;HEAP32[r56+(r52+4)>>2]=r72|1;HEAP32[r56+(r72+r52)>>2]=r72;r50=r72>>>3;if(r72>>>0<256){r48=r50<<1;r51=1784+(r48<<2)|0;r41=HEAP32[1744>>2];r38=1<<r50;do{if((r41&r38|0)==0){HEAP32[1744>>2]=r41|r38;r73=r51;r74=1784+(r48+2<<2)|0}else{r50=1784+(r48+2<<2)|0;r47=HEAP32[r50>>2];if(r47>>>0>=HEAP32[1760>>2]>>>0){r73=r47;r74=r50;break}_abort()}}while(0);HEAP32[r74>>2]=r37;HEAP32[r73+12>>2]=r37;HEAP32[r56+(r52+8)>>2]=r73;HEAP32[r56+(r52+12)>>2]=r51;break}r48=r57;r38=r72>>>8;do{if((r38|0)==0){r75=0}else{if(r72>>>0>16777215){r75=31;break}r41=(r38+1048320|0)>>>16&8;r54=r38<<r41;r50=(r54+520192|0)>>>16&4;r47=r54<<r50;r54=(r47+245760|0)>>>16&2;r44=14-(r50|r41|r54)+(r47<<r54>>>15)|0;r75=r72>>>((r44+7|0)>>>0)&1|r44<<1}}while(0);r38=2048+(r75<<2)|0;HEAP32[r56+(r52+28)>>2]=r75;HEAP32[r56+(r52+20)>>2]=0;HEAP32[r56+(r52+16)>>2]=0;r51=HEAP32[1748>>2];r44=1<<r75;if((r51&r44|0)==0){HEAP32[1748>>2]=r51|r44;HEAP32[r38>>2]=r48;HEAP32[r56+(r52+24)>>2]=r38;HEAP32[r56+(r52+12)>>2]=r48;HEAP32[r56+(r52+8)>>2]=r48;break}r44=HEAP32[r38>>2];if((r75|0)==31){r76=0}else{r76=25-(r75>>>1)|0}L432:do{if((HEAP32[r44+4>>2]&-8|0)==(r72|0)){r77=r44}else{r38=r44;r51=r72<<r76;while(1){r78=r38+16+(r51>>>31<<2)|0;r54=HEAP32[r78>>2];if((r54|0)==0){break}if((HEAP32[r54+4>>2]&-8|0)==(r72|0)){r77=r54;break L432}else{r38=r54;r51=r51<<1}}if(r78>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r78>>2]=r48;HEAP32[r56+(r52+24)>>2]=r38;HEAP32[r56+(r52+12)>>2]=r48;HEAP32[r56+(r52+8)>>2]=r48;break L335}}}while(0);r44=r77+8|0;r51=HEAP32[r44>>2];r36=HEAP32[1760>>2];if(r77>>>0>=r36>>>0&r51>>>0>=r36>>>0){HEAP32[r51+12>>2]=r48;HEAP32[r44>>2]=r48;HEAP32[r56+(r52+8)>>2]=r51;HEAP32[r56+(r52+12)>>2]=r77;HEAP32[r56+(r52+24)>>2]=0;break}else{_abort()}}}while(0);r14=r56+(r65|8)|0;return r14}}while(0);r49=r58;r52=2192;while(1){r79=HEAP32[r52>>2];if(r79>>>0<=r49>>>0){r80=HEAP32[r52+4>>2];r81=r79+r80|0;if(r81>>>0>r49>>>0){break}}r52=HEAP32[r52+8>>2]}r52=r79+(r80-39)|0;if((r52&7|0)==0){r82=0}else{r82=-r52&7}r52=r79+(r80-47+r82)|0;r57=r52>>>0<(r58+16|0)>>>0?r49:r52;r52=r57+8|0;r37=r56+8|0;if((r37&7|0)==0){r83=0}else{r83=-r37&7}r37=r55-40-r83|0;HEAP32[1768>>2]=r56+r83;HEAP32[1756>>2]=r37;HEAP32[r56+(r83+4)>>2]=r37|1;HEAP32[r56+(r55-36)>>2]=40;HEAP32[1772>>2]=HEAP32[1728>>2];HEAP32[r57+4>>2]=27;HEAP32[r52>>2]=HEAP32[2192>>2];HEAP32[r52+4>>2]=HEAP32[2196>>2];HEAP32[r52+8>>2]=HEAP32[2200>>2];HEAP32[r52+12>>2]=HEAP32[2204>>2];HEAP32[2192>>2]=r56;HEAP32[2196>>2]=r55;HEAP32[2204>>2]=0;HEAP32[2200>>2]=r52;r52=r57+28|0;HEAP32[r52>>2]=7;if((r57+32|0)>>>0<r81>>>0){r37=r52;while(1){r52=r37+4|0;HEAP32[r52>>2]=7;if((r37+8|0)>>>0<r81>>>0){r37=r52}else{break}}}if((r57|0)==(r49|0)){break}r37=r57-r58|0;r52=r49+(r37+4)|0;HEAP32[r52>>2]=HEAP32[r52>>2]&-2;HEAP32[r58+4>>2]=r37|1;HEAP32[r49+r37>>2]=r37;r52=r37>>>3;if(r37>>>0<256){r46=r52<<1;r53=1784+(r46<<2)|0;r45=HEAP32[1744>>2];r10=1<<r52;do{if((r45&r10|0)==0){HEAP32[1744>>2]=r45|r10;r84=r53;r85=1784+(r46+2<<2)|0}else{r52=1784+(r46+2<<2)|0;r51=HEAP32[r52>>2];if(r51>>>0>=HEAP32[1760>>2]>>>0){r84=r51;r85=r52;break}_abort()}}while(0);HEAP32[r85>>2]=r58;HEAP32[r84+12>>2]=r58;HEAP32[r58+8>>2]=r84;HEAP32[r58+12>>2]=r53;break}r46=r58;r10=r37>>>8;do{if((r10|0)==0){r86=0}else{if(r37>>>0>16777215){r86=31;break}r45=(r10+1048320|0)>>>16&8;r49=r10<<r45;r57=(r49+520192|0)>>>16&4;r52=r49<<r57;r49=(r52+245760|0)>>>16&2;r51=14-(r57|r45|r49)+(r52<<r49>>>15)|0;r86=r37>>>((r51+7|0)>>>0)&1|r51<<1}}while(0);r10=2048+(r86<<2)|0;HEAP32[r58+28>>2]=r86;HEAP32[r58+20>>2]=0;HEAP32[r58+16>>2]=0;r53=HEAP32[1748>>2];r51=1<<r86;if((r53&r51|0)==0){HEAP32[1748>>2]=r53|r51;HEAP32[r10>>2]=r46;HEAP32[r58+24>>2]=r10;HEAP32[r58+12>>2]=r58;HEAP32[r58+8>>2]=r58;break}r51=HEAP32[r10>>2];if((r86|0)==31){r87=0}else{r87=25-(r86>>>1)|0}L483:do{if((HEAP32[r51+4>>2]&-8|0)==(r37|0)){r88=r51}else{r10=r51;r53=r37<<r87;while(1){r89=r10+16+(r53>>>31<<2)|0;r49=HEAP32[r89>>2];if((r49|0)==0){break}if((HEAP32[r49+4>>2]&-8|0)==(r37|0)){r88=r49;break L483}else{r10=r49;r53=r53<<1}}if(r89>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r89>>2]=r46;HEAP32[r58+24>>2]=r10;HEAP32[r58+12>>2]=r58;HEAP32[r58+8>>2]=r58;break L308}}}while(0);r37=r88+8|0;r51=HEAP32[r37>>2];r53=HEAP32[1760>>2];if(r88>>>0>=r53>>>0&r51>>>0>=r53>>>0){HEAP32[r51+12>>2]=r46;HEAP32[r37>>2]=r46;HEAP32[r58+8>>2]=r51;HEAP32[r58+12>>2]=r88;HEAP32[r58+24>>2]=0;break}else{_abort()}}}while(0);r58=HEAP32[1756>>2];if(r58>>>0<=r15>>>0){break}r51=r58-r15|0;HEAP32[1756>>2]=r51;r58=HEAP32[1768>>2];r37=r58;HEAP32[1768>>2]=r37+r15;HEAP32[r37+(r15+4)>>2]=r51|1;HEAP32[r58+4>>2]=r15|3;r14=r58+8|0;return r14}}while(0);HEAP32[___errno_location()>>2]=12;r14=0;return r14}function _free(r1){var r2,r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18,r19,r20,r21,r22,r23,r24,r25,r26,r27,r28,r29,r30,r31,r32,r33,r34,r35,r36,r37,r38,r39,r40;if((r1|0)==0){return}r2=r1-8|0;r3=r2;r4=HEAP32[1760>>2];if(r2>>>0<r4>>>0){_abort()}r5=HEAP32[r1-4>>2];r6=r5&3;if((r6|0)==1){_abort()}r7=r5&-8;r8=r1+(r7-8)|0;r9=r8;L10:do{if((r5&1|0)==0){r10=HEAP32[r2>>2];if((r6|0)==0){return}r11=-8-r10|0;r12=r1+r11|0;r13=r12;r14=r10+r7|0;if(r12>>>0<r4>>>0){_abort()}if((r13|0)==(HEAP32[1764>>2]|0)){r15=r1+(r7-4)|0;if((HEAP32[r15>>2]&3|0)!=3){r16=r13;r17=r14;break}HEAP32[1752>>2]=r14;HEAP32[r15>>2]=HEAP32[r15>>2]&-2;HEAP32[r1+(r11+4)>>2]=r14|1;HEAP32[r8>>2]=r14;return}r15=r10>>>3;if(r10>>>0<256){r10=HEAP32[r1+(r11+8)>>2];r18=HEAP32[r1+(r11+12)>>2];r19=1784+(r15<<1<<2)|0;do{if((r10|0)!=(r19|0)){if(r10>>>0<r4>>>0){_abort()}if((HEAP32[r10+12>>2]|0)==(r13|0)){break}_abort()}}while(0);if((r18|0)==(r10|0)){HEAP32[1744>>2]=HEAP32[1744>>2]&~(1<<r15);r16=r13;r17=r14;break}do{if((r18|0)==(r19|0)){r20=r18+8|0}else{if(r18>>>0<r4>>>0){_abort()}r21=r18+8|0;if((HEAP32[r21>>2]|0)==(r13|0)){r20=r21;break}_abort()}}while(0);HEAP32[r10+12>>2]=r18;HEAP32[r20>>2]=r10;r16=r13;r17=r14;break}r19=r12;r15=HEAP32[r1+(r11+24)>>2];r21=HEAP32[r1+(r11+12)>>2];do{if((r21|0)==(r19|0)){r22=r1+(r11+20)|0;r23=HEAP32[r22>>2];if((r23|0)==0){r24=r1+(r11+16)|0;r25=HEAP32[r24>>2];if((r25|0)==0){r26=0;break}else{r27=r25;r28=r24}}else{r27=r23;r28=r22}while(1){r22=r27+20|0;r23=HEAP32[r22>>2];if((r23|0)!=0){r27=r23;r28=r22;continue}r22=r27+16|0;r23=HEAP32[r22>>2];if((r23|0)==0){break}else{r27=r23;r28=r22}}if(r28>>>0<r4>>>0){_abort()}else{HEAP32[r28>>2]=0;r26=r27;break}}else{r22=HEAP32[r1+(r11+8)>>2];if(r22>>>0<r4>>>0){_abort()}r23=r22+12|0;if((HEAP32[r23>>2]|0)!=(r19|0)){_abort()}r24=r21+8|0;if((HEAP32[r24>>2]|0)==(r19|0)){HEAP32[r23>>2]=r21;HEAP32[r24>>2]=r22;r26=r21;break}else{_abort()}}}while(0);if((r15|0)==0){r16=r13;r17=r14;break}r21=r1+(r11+28)|0;r12=2048+(HEAP32[r21>>2]<<2)|0;do{if((r19|0)==(HEAP32[r12>>2]|0)){HEAP32[r12>>2]=r26;if((r26|0)!=0){break}HEAP32[1748>>2]=HEAP32[1748>>2]&~(1<<HEAP32[r21>>2]);r16=r13;r17=r14;break L10}else{if(r15>>>0<HEAP32[1760>>2]>>>0){_abort()}r10=r15+16|0;if((HEAP32[r10>>2]|0)==(r19|0)){HEAP32[r10>>2]=r26}else{HEAP32[r15+20>>2]=r26}if((r26|0)==0){r16=r13;r17=r14;break L10}}}while(0);if(r26>>>0<HEAP32[1760>>2]>>>0){_abort()}HEAP32[r26+24>>2]=r15;r19=HEAP32[r1+(r11+16)>>2];do{if((r19|0)!=0){if(r19>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r26+16>>2]=r19;HEAP32[r19+24>>2]=r26;break}}}while(0);r19=HEAP32[r1+(r11+20)>>2];if((r19|0)==0){r16=r13;r17=r14;break}if(r19>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r26+20>>2]=r19;HEAP32[r19+24>>2]=r26;r16=r13;r17=r14;break}}else{r16=r3;r17=r7}}while(0);r3=r16;if(r3>>>0>=r8>>>0){_abort()}r26=r1+(r7-4)|0;r4=HEAP32[r26>>2];if((r4&1|0)==0){_abort()}do{if((r4&2|0)==0){if((r9|0)==(HEAP32[1768>>2]|0)){r27=HEAP32[1756>>2]+r17|0;HEAP32[1756>>2]=r27;HEAP32[1768>>2]=r16;HEAP32[r16+4>>2]=r27|1;if((r16|0)!=(HEAP32[1764>>2]|0)){return}HEAP32[1764>>2]=0;HEAP32[1752>>2]=0;return}if((r9|0)==(HEAP32[1764>>2]|0)){r27=HEAP32[1752>>2]+r17|0;HEAP32[1752>>2]=r27;HEAP32[1764>>2]=r16;HEAP32[r16+4>>2]=r27|1;HEAP32[r3+r27>>2]=r27;return}r27=(r4&-8)+r17|0;r28=r4>>>3;L113:do{if(r4>>>0<256){r20=HEAP32[r1+r7>>2];r6=HEAP32[r1+(r7|4)>>2];r2=1784+(r28<<1<<2)|0;do{if((r20|0)!=(r2|0)){if(r20>>>0<HEAP32[1760>>2]>>>0){_abort()}if((HEAP32[r20+12>>2]|0)==(r9|0)){break}_abort()}}while(0);if((r6|0)==(r20|0)){HEAP32[1744>>2]=HEAP32[1744>>2]&~(1<<r28);break}do{if((r6|0)==(r2|0)){r29=r6+8|0}else{if(r6>>>0<HEAP32[1760>>2]>>>0){_abort()}r5=r6+8|0;if((HEAP32[r5>>2]|0)==(r9|0)){r29=r5;break}_abort()}}while(0);HEAP32[r20+12>>2]=r6;HEAP32[r29>>2]=r20}else{r2=r8;r5=HEAP32[r1+(r7+16)>>2];r19=HEAP32[r1+(r7|4)>>2];do{if((r19|0)==(r2|0)){r15=r1+(r7+12)|0;r21=HEAP32[r15>>2];if((r21|0)==0){r12=r1+(r7+8)|0;r10=HEAP32[r12>>2];if((r10|0)==0){r30=0;break}else{r31=r10;r32=r12}}else{r31=r21;r32=r15}while(1){r15=r31+20|0;r21=HEAP32[r15>>2];if((r21|0)!=0){r31=r21;r32=r15;continue}r15=r31+16|0;r21=HEAP32[r15>>2];if((r21|0)==0){break}else{r31=r21;r32=r15}}if(r32>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r32>>2]=0;r30=r31;break}}else{r15=HEAP32[r1+r7>>2];if(r15>>>0<HEAP32[1760>>2]>>>0){_abort()}r21=r15+12|0;if((HEAP32[r21>>2]|0)!=(r2|0)){_abort()}r12=r19+8|0;if((HEAP32[r12>>2]|0)==(r2|0)){HEAP32[r21>>2]=r19;HEAP32[r12>>2]=r15;r30=r19;break}else{_abort()}}}while(0);if((r5|0)==0){break}r19=r1+(r7+20)|0;r20=2048+(HEAP32[r19>>2]<<2)|0;do{if((r2|0)==(HEAP32[r20>>2]|0)){HEAP32[r20>>2]=r30;if((r30|0)!=0){break}HEAP32[1748>>2]=HEAP32[1748>>2]&~(1<<HEAP32[r19>>2]);break L113}else{if(r5>>>0<HEAP32[1760>>2]>>>0){_abort()}r6=r5+16|0;if((HEAP32[r6>>2]|0)==(r2|0)){HEAP32[r6>>2]=r30}else{HEAP32[r5+20>>2]=r30}if((r30|0)==0){break L113}}}while(0);if(r30>>>0<HEAP32[1760>>2]>>>0){_abort()}HEAP32[r30+24>>2]=r5;r2=HEAP32[r1+(r7+8)>>2];do{if((r2|0)!=0){if(r2>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r30+16>>2]=r2;HEAP32[r2+24>>2]=r30;break}}}while(0);r2=HEAP32[r1+(r7+12)>>2];if((r2|0)==0){break}if(r2>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r30+20>>2]=r2;HEAP32[r2+24>>2]=r30;break}}}while(0);HEAP32[r16+4>>2]=r27|1;HEAP32[r3+r27>>2]=r27;if((r16|0)!=(HEAP32[1764>>2]|0)){r33=r27;break}HEAP32[1752>>2]=r27;return}else{HEAP32[r26>>2]=r4&-2;HEAP32[r16+4>>2]=r17|1;HEAP32[r3+r17>>2]=r17;r33=r17}}while(0);r17=r33>>>3;if(r33>>>0<256){r3=r17<<1;r4=1784+(r3<<2)|0;r26=HEAP32[1744>>2];r30=1<<r17;do{if((r26&r30|0)==0){HEAP32[1744>>2]=r26|r30;r34=r4;r35=1784+(r3+2<<2)|0}else{r17=1784+(r3+2<<2)|0;r7=HEAP32[r17>>2];if(r7>>>0>=HEAP32[1760>>2]>>>0){r34=r7;r35=r17;break}_abort()}}while(0);HEAP32[r35>>2]=r16;HEAP32[r34+12>>2]=r16;HEAP32[r16+8>>2]=r34;HEAP32[r16+12>>2]=r4;return}r4=r16;r34=r33>>>8;do{if((r34|0)==0){r36=0}else{if(r33>>>0>16777215){r36=31;break}r35=(r34+1048320|0)>>>16&8;r3=r34<<r35;r30=(r3+520192|0)>>>16&4;r26=r3<<r30;r3=(r26+245760|0)>>>16&2;r17=14-(r30|r35|r3)+(r26<<r3>>>15)|0;r36=r33>>>((r17+7|0)>>>0)&1|r17<<1}}while(0);r34=2048+(r36<<2)|0;HEAP32[r16+28>>2]=r36;HEAP32[r16+20>>2]=0;HEAP32[r16+16>>2]=0;r17=HEAP32[1748>>2];r3=1<<r36;L199:do{if((r17&r3|0)==0){HEAP32[1748>>2]=r17|r3;HEAP32[r34>>2]=r4;HEAP32[r16+24>>2]=r34;HEAP32[r16+12>>2]=r16;HEAP32[r16+8>>2]=r16}else{r26=HEAP32[r34>>2];if((r36|0)==31){r37=0}else{r37=25-(r36>>>1)|0}L205:do{if((HEAP32[r26+4>>2]&-8|0)==(r33|0)){r38=r26}else{r35=r26;r30=r33<<r37;while(1){r39=r35+16+(r30>>>31<<2)|0;r7=HEAP32[r39>>2];if((r7|0)==0){break}if((HEAP32[r7+4>>2]&-8|0)==(r33|0)){r38=r7;break L205}else{r35=r7;r30=r30<<1}}if(r39>>>0<HEAP32[1760>>2]>>>0){_abort()}else{HEAP32[r39>>2]=r4;HEAP32[r16+24>>2]=r35;HEAP32[r16+12>>2]=r16;HEAP32[r16+8>>2]=r16;break L199}}}while(0);r26=r38+8|0;r27=HEAP32[r26>>2];r30=HEAP32[1760>>2];if(r38>>>0>=r30>>>0&r27>>>0>=r30>>>0){HEAP32[r27+12>>2]=r4;HEAP32[r26>>2]=r4;HEAP32[r16+8>>2]=r27;HEAP32[r16+12>>2]=r38;HEAP32[r16+24>>2]=0;break}else{_abort()}}}while(0);r16=HEAP32[1776>>2]-1|0;HEAP32[1776>>2]=r16;if((r16|0)==0){r40=2200}else{return}while(1){r16=HEAP32[r40>>2];if((r16|0)==0){break}else{r40=r16+8|0}}HEAP32[1776>>2]=-1;return}function __Znwj(r1){var r2,r3,r4;r2=0;r3=(r1|0)==0?1:r1;while(1){r4=_malloc(r3);if((r4|0)!=0){r2=10;break}r1=(tempValue=HEAP32[2216>>2],HEAP32[2216>>2]=tempValue+0,tempValue);if((r1|0)==0){break}FUNCTION_TABLE[r1]()}if(r2==10){return r4}r4=___cxa_allocate_exception(4);HEAP32[r4>>2]=432;___cxa_throw(r4,1400,60)}function __ZNSt9bad_allocD0Ev(r1){if((r1|0)==0){return}_free(r1);return}function __ZNSt9bad_allocD2Ev(r1){return}function __ZNKSt9bad_alloc4whatEv(r1){return 96}function _i64Add(r1,r2,r3,r4){var r5,r6;r1=r1|0;r2=r2|0;r3=r3|0;r4=r4|0;r5=0,r6=0;r5=r1+r3>>>0;r6=r2+r4+(r5>>>0<r1>>>0|0)>>>0;return tempRet0=r6,r5|0}function _i64Subtract(r1,r2,r3,r4){var r5,r6;r1=r1|0;r2=r2|0;r3=r3|0;r4=r4|0;r5=0,r6=0;r5=r1-r3>>>0;r6=r2-r4>>>0;r6=r2-r4-(r3>>>0>r1>>>0|0)>>>0;return tempRet0=r6,r5|0}function _bitshift64Shl(r1,r2,r3){var r4;r1=r1|0;r2=r2|0;r3=r3|0;r4=0;if((r3|0)<32){r4=(1<<r3)-1|0;tempRet0=r2<<r3|(r1&r4<<32-r3)>>>32-r3;return r1<<r3}tempRet0=r1<<r3-32;return 0}function _bitshift64Lshr(r1,r2,r3){var r4;r1=r1|0;r2=r2|0;r3=r3|0;r4=0;if((r3|0)<32){r4=(1<<r3)-1|0;tempRet0=r2>>>r3;return r1>>>r3|(r2&r4)<<32-r3}tempRet0=0;return r2>>>r3-32|0}function _bitshift64Ashr(r1,r2,r3){var r4;r1=r1|0;r2=r2|0;r3=r3|0;r4=0;if((r3|0)<32){r4=(1<<r3)-1|0;tempRet0=r2>>r3;return r1>>>r3|(r2&r4)<<32-r3}tempRet0=(r2|0)<0?-1:0;return r2>>r3-32|0}function _llvm_ctlz_i32(r1){var r2;r1=r1|0;r2=0;r2=HEAP8[ctlz_i8+(r1>>>24)|0];if((r2|0)<8)return r2|0;r2=HEAP8[ctlz_i8+(r1>>16&255)|0];if((r2|0)<8)return r2+8|0;r2=HEAP8[ctlz_i8+(r1>>8&255)|0];if((r2|0)<8)return r2+16|0;return HEAP8[ctlz_i8+(r1&255)|0]+24|0}var ctlz_i8=allocate([8,7,6,6,5,5,5,5,4,4,4,4,4,4,4,4,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"i8",ALLOC_DYNAMIC);function _llvm_cttz_i32(r1){var r2;r1=r1|0;r2=0;r2=HEAP8[cttz_i8+(r1&255)|0];if((r2|0)<8)return r2|0;r2=HEAP8[cttz_i8+(r1>>8&255)|0];if((r2|0)<8)return r2+8|0;r2=HEAP8[cttz_i8+(r1>>16&255)|0];if((r2|0)<8)return r2+16|0;return HEAP8[cttz_i8+(r1>>>24)|0]+24|0}var cttz_i8=allocate([8,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,5,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,6,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,5,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,7,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,5,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,6,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,5,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0],"i8",ALLOC_DYNAMIC);function ___muldsi3(r1,r2){var r3,r4,r5,r6,r7,r8,r9;r1=r1|0;r2=r2|0;r3=0,r4=0,r5=0,r6=0,r7=0,r8=0,r9=0;r3=r1&65535;r4=r2&65535;r5=Math_imul(r4,r3)|0;r6=r1>>>16;r7=(r5>>>16)+Math_imul(r4,r6)|0;r8=r2>>>16;r9=Math_imul(r8,r3)|0;return(tempRet0=(r7>>>16)+Math_imul(r8,r6)+(((r7&65535)+r9|0)>>>16)|0,r7+r9<<16|r5&65535|0)|0}function ___divdi3(r1,r2,r3,r4){var r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15;r1=r1|0;r2=r2|0;r3=r3|0;r4=r4|0;r5=0,r6=0,r7=0,r8=0,r9=0,r10=0,r11=0,r12=0,r13=0,r14=0,r15=0;r5=r2>>31|((r2|0)<0?-1:0)<<1;r6=((r2|0)<0?-1:0)>>31|((r2|0)<0?-1:0)<<1;r7=r4>>31|((r4|0)<0?-1:0)<<1;r8=((r4|0)<0?-1:0)>>31|((r4|0)<0?-1:0)<<1;r9=_i64Subtract(r5^r1,r6^r2,r5,r6)|0;r10=tempRet0;r11=_i64Subtract(r7^r3,r8^r4,r7,r8)|0;r12=r7^r5;r13=r8^r6;r14=___udivmoddi4(r9,r10,r11,tempRet0,0)|0;r15=_i64Subtract(r14^r12,tempRet0^r13,r12,r13)|0;return(tempRet0=tempRet0,r15)|0}function ___remdi3(r1,r2,r3,r4){var r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15;r1=r1|0;r2=r2|0;r3=r3|0;r4=r4|0;r5=0,r6=0,r7=0,r8=0,r9=0,r10=0,r11=0,r12=0,r13=0,r14=0,r15=0;r15=STACKTOP;STACKTOP=STACKTOP+8|0;r5=r15|0;r6=r2>>31|((r2|0)<0?-1:0)<<1;r7=((r2|0)<0?-1:0)>>31|((r2|0)<0?-1:0)<<1;r8=r4>>31|((r4|0)<0?-1:0)<<1;r9=((r4|0)<0?-1:0)>>31|((r4|0)<0?-1:0)<<1;r10=_i64Subtract(r6^r1,r7^r2,r6,r7)|0;r11=tempRet0;r12=_i64Subtract(r8^r3,r9^r4,r8,r9)|0;___udivmoddi4(r10,r11,r12,tempRet0,r5)|0;r13=_i64Subtract(HEAP32[r5>>2]^r6,HEAP32[r5+4>>2]^r7,r6,r7)|0;r14=tempRet0;STACKTOP=r15;return(tempRet0=r14,r13)|0}function ___muldi3(r1,r2,r3,r4){var r5,r6,r7,r8,r9;r1=r1|0;r2=r2|0;r3=r3|0;r4=r4|0;r5=0,r6=0,r7=0,r8=0,r9=0;r5=r1;r6=r3;r7=___muldsi3(r5,r6)|0;r8=tempRet0;r9=Math_imul(r2,r6)|0;return(tempRet0=Math_imul(r4,r5)+r9+r8|r8&0,r7&-1|0)|0}function ___udivdi3(r1,r2,r3,r4){var r5;r1=r1|0;r2=r2|0;r3=r3|0;r4=r4|0;r5=0;r5=___udivmoddi4(r1,r2,r3,r4,0)|0;return(tempRet0=tempRet0,r5)|0}function ___uremdi3(r1,r2,r3,r4){var r5,r6;r1=r1|0;r2=r2|0;r3=r3|0;r4=r4|0;r5=0,r6=0;r6=STACKTOP;STACKTOP=STACKTOP+8|0;r5=r6|0;___udivmoddi4(r1,r2,r3,r4,r5)|0;STACKTOP=r6;return(tempRet0=HEAP32[r5+4>>2]|0,HEAP32[r5>>2]|0)|0}function ___udivmoddi4(r1,r2,r3,r4,r5){var r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18,r19,r20,r21,r22,r23,r24,r25,r26,r27,r28,r29,r30,r31,r32,r33,r34,r35,r36,r37,r38,r39,r40,r41,r42,r43,r44,r45,r46,r47,r48,r49,r50,r51,r52,r53,r54,r55,r56,r57,r58,r59,r60,r61,r62,r63,r64,r65,r66,r67,r68,r69;r1=r1|0;r2=r2|0;r3=r3|0;r4=r4|0;r5=r5|0;r6=0,r7=0,r8=0,r9=0,r10=0,r11=0,r12=0,r13=0,r14=0,r15=0,r16=0,r17=0,r18=0,r19=0,r20=0,r21=0,r22=0,r23=0,r24=0,r25=0,r26=0,r27=0,r28=0,r29=0,r30=0,r31=0,r32=0,r33=0,r34=0,r35=0,r36=0,r37=0,r38=0,r39=0,r40=0,r41=0,r42=0,r43=0,r44=0,r45=0,r46=0,r47=0,r48=0,r49=0,r50=0,r51=0,r52=0,r53=0,r54=0,r55=0,r56=0,r57=0,r58=0,r59=0,r60=0,r61=0,r62=0,r63=0,r64=0,r65=0,r66=0,r67=0,r68=0,r69=0;r6=r1;r7=r2;r8=r7;r9=r3;r10=r4;r11=r10;if((r8|0)==0){r12=(r5|0)!=0;if((r11|0)==0){if(r12){HEAP32[r5>>2]=(r6>>>0)%(r9>>>0);HEAP32[r5+4>>2]=0}r69=0;r68=(r6>>>0)/(r9>>>0)>>>0;return(tempRet0=r69,r68)|0}else{if(!r12){r69=0;r68=0;return(tempRet0=r69,r68)|0}HEAP32[r5>>2]=r1&-1;HEAP32[r5+4>>2]=r2&0;r69=0;r68=0;return(tempRet0=r69,r68)|0}}r13=(r11|0)==0;do{if((r9|0)==0){if(r13){if((r5|0)!=0){HEAP32[r5>>2]=(r8>>>0)%(r9>>>0);HEAP32[r5+4>>2]=0}r69=0;r68=(r8>>>0)/(r9>>>0)>>>0;return(tempRet0=r69,r68)|0}if((r6|0)==0){if((r5|0)!=0){HEAP32[r5>>2]=0;HEAP32[r5+4>>2]=(r8>>>0)%(r11>>>0)}r69=0;r68=(r8>>>0)/(r11>>>0)>>>0;return(tempRet0=r69,r68)|0}r14=r11-1|0;if((r14&r11|0)==0){if((r5|0)!=0){HEAP32[r5>>2]=r1&-1;HEAP32[r5+4>>2]=r14&r8|r2&0}r69=0;r68=r8>>>((_llvm_cttz_i32(r11|0)|0)>>>0);return(tempRet0=r69,r68)|0}r15=_llvm_ctlz_i32(r11|0)|0;r16=r15-_llvm_ctlz_i32(r8|0)|0;if(r16>>>0<=30){r17=r16+1|0;r18=31-r16|0;r37=r17;r36=r8<<r18|r6>>>(r17>>>0);r35=r8>>>(r17>>>0);r34=0;r33=r6<<r18;break}if((r5|0)==0){r69=0;r68=0;return(tempRet0=r69,r68)|0}HEAP32[r5>>2]=r1&-1;HEAP32[r5+4>>2]=r7|r2&0;r69=0;r68=0;return(tempRet0=r69,r68)|0}else{if(!r13){r28=_llvm_ctlz_i32(r11|0)|0;r29=r28-_llvm_ctlz_i32(r8|0)|0;if(r29>>>0<=31){r30=r29+1|0;r31=31-r29|0;r32=r29-31>>31;r37=r30;r36=r6>>>(r30>>>0)&r32|r8<<r31;r35=r8>>>(r30>>>0)&r32;r34=0;r33=r6<<r31;break}if((r5|0)==0){r69=0;r68=0;return(tempRet0=r69,r68)|0}HEAP32[r5>>2]=r1&-1;HEAP32[r5+4>>2]=r7|r2&0;r69=0;r68=0;return(tempRet0=r69,r68)|0}r19=r9-1|0;if((r19&r9|0)!=0){r21=_llvm_ctlz_i32(r9|0)+33|0;r22=r21-_llvm_ctlz_i32(r8|0)|0;r23=64-r22|0;r24=32-r22|0;r25=r24>>31;r26=r22-32|0;r27=r26>>31;r37=r22;r36=r24-1>>31&r8>>>(r26>>>0)|(r8<<r24|r6>>>(r22>>>0))&r27;r35=r27&r8>>>(r22>>>0);r34=r6<<r23&r25;r33=(r8<<r23|r6>>>(r26>>>0))&r25|r6<<r24&r22-33>>31;break}if((r5|0)!=0){HEAP32[r5>>2]=r19&r6;HEAP32[r5+4>>2]=0}if((r9|0)==1){r69=r7|r2&0;r68=r1&-1|0;return(tempRet0=r69,r68)|0}else{r20=_llvm_cttz_i32(r9|0)|0;r69=r8>>>(r20>>>0)|0;r68=r8<<32-r20|r6>>>(r20>>>0)|0;return(tempRet0=r69,r68)|0}}}while(0);if((r37|0)==0){r64=r33;r63=r34;r62=r35;r61=r36;r60=0;r59=0}else{r38=r3&-1|0;r39=r10|r4&0;r40=_i64Add(r38,r39,-1,-1)|0;r41=tempRet0;r47=r33;r46=r34;r45=r35;r44=r36;r43=r37;r42=0;while(1){r48=r46>>>31|r47<<1;r49=r42|r46<<1;r50=r44<<1|r47>>>31|0;r51=r44>>>31|r45<<1|0;_i64Subtract(r40,r41,r50,r51)|0;r52=tempRet0;r53=r52>>31|((r52|0)<0?-1:0)<<1;r54=r53&1;r55=_i64Subtract(r50,r51,r53&r38,(((r52|0)<0?-1:0)>>31|((r52|0)<0?-1:0)<<1)&r39)|0;r56=r55;r57=tempRet0;r58=r43-1|0;if((r58|0)==0){break}else{r47=r48;r46=r49;r45=r57;r44=r56;r43=r58;r42=r54}}r64=r48;r63=r49;r62=r57;r61=r56;r60=0;r59=r54}r65=r63;r66=0;r67=r64|r66;if((r5|0)!=0){HEAP32[r5>>2]=r61;HEAP32[r5+4>>2]=r62}r69=(r65|0)>>>31|r67<<1|(r66<<1|r65>>>31)&0|r60;r68=(r65<<1|0>>>31)&-2|r59;return(tempRet0=r69,r68)|0}




// EMSCRIPTEN_END_FUNCS
Module["___getTypeName"] = ___getTypeName;
Module["_malloc"] = _malloc;
Module["_free"] = _free;

// TODO: strip out parts of this we do not need

//======= begin closure i64 code =======

// Copyright 2009 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Defines a Long class for representing a 64-bit two's-complement
 * integer value, which faithfully simulates the behavior of a Java "long". This
 * implementation is derived from LongLib in GWT.
 *
 */

var i64Math = (function() { // Emscripten wrapper
  var goog = { math: {} };


  /**
   * Constructs a 64-bit two's-complement integer, given its low and high 32-bit
   * values as *signed* integers.  See the from* functions below for more
   * convenient ways of constructing Longs.
   *
   * The internal representation of a long is the two given signed, 32-bit values.
   * We use 32-bit pieces because these are the size of integers on which
   * Javascript performs bit-operations.  For operations like addition and
   * multiplication, we split each number into 16-bit pieces, which can easily be
   * multiplied within Javascript's floating-point representation without overflow
   * or change in sign.
   *
   * In the algorithms below, we frequently reduce the negative case to the
   * positive case by negating the input(s) and then post-processing the result.
   * Note that we must ALWAYS check specially whether those values are MIN_VALUE
   * (-2^63) because -MIN_VALUE == MIN_VALUE (since 2^63 cannot be represented as
   * a positive number, it overflows back into a negative).  Not handling this
   * case would often result in infinite recursion.
   *
   * @param {number} low  The low (signed) 32 bits of the long.
   * @param {number} high  The high (signed) 32 bits of the long.
   * @constructor
   */
  goog.math.Long = function(low, high) {
    /**
     * @type {number}
     * @private
     */
    this.low_ = low | 0;  // force into 32 signed bits.

    /**
     * @type {number}
     * @private
     */
    this.high_ = high | 0;  // force into 32 signed bits.
  };


  // NOTE: Common constant values ZERO, ONE, NEG_ONE, etc. are defined below the
  // from* methods on which they depend.


  /**
   * A cache of the Long representations of small integer values.
   * @type {!Object}
   * @private
   */
  goog.math.Long.IntCache_ = {};


  /**
   * Returns a Long representing the given (32-bit) integer value.
   * @param {number} value The 32-bit integer in question.
   * @return {!goog.math.Long} The corresponding Long value.
   */
  goog.math.Long.fromInt = function(value) {
    if (-128 <= value && value < 128) {
      var cachedObj = goog.math.Long.IntCache_[value];
      if (cachedObj) {
        return cachedObj;
      }
    }

    var obj = new goog.math.Long(value | 0, value < 0 ? -1 : 0);
    if (-128 <= value && value < 128) {
      goog.math.Long.IntCache_[value] = obj;
    }
    return obj;
  };


  /**
   * Returns a Long representing the given value, provided that it is a finite
   * number.  Otherwise, zero is returned.
   * @param {number} value The number in question.
   * @return {!goog.math.Long} The corresponding Long value.
   */
  goog.math.Long.fromNumber = function(value) {
    if (isNaN(value) || !isFinite(value)) {
      return goog.math.Long.ZERO;
    } else if (value <= -goog.math.Long.TWO_PWR_63_DBL_) {
      return goog.math.Long.MIN_VALUE;
    } else if (value + 1 >= goog.math.Long.TWO_PWR_63_DBL_) {
      return goog.math.Long.MAX_VALUE;
    } else if (value < 0) {
      return goog.math.Long.fromNumber(-value).negate();
    } else {
      return new goog.math.Long(
          (value % goog.math.Long.TWO_PWR_32_DBL_) | 0,
          (value / goog.math.Long.TWO_PWR_32_DBL_) | 0);
    }
  };


  /**
   * Returns a Long representing the 64-bit integer that comes by concatenating
   * the given high and low bits.  Each is assumed to use 32 bits.
   * @param {number} lowBits The low 32-bits.
   * @param {number} highBits The high 32-bits.
   * @return {!goog.math.Long} The corresponding Long value.
   */
  goog.math.Long.fromBits = function(lowBits, highBits) {
    return new goog.math.Long(lowBits, highBits);
  };


  /**
   * Returns a Long representation of the given string, written using the given
   * radix.
   * @param {string} str The textual representation of the Long.
   * @param {number=} opt_radix The radix in which the text is written.
   * @return {!goog.math.Long} The corresponding Long value.
   */
  goog.math.Long.fromString = function(str, opt_radix) {
    if (str.length == 0) {
      throw Error('number format error: empty string');
    }

    var radix = opt_radix || 10;
    if (radix < 2 || 36 < radix) {
      throw Error('radix out of range: ' + radix);
    }

    if (str.charAt(0) == '-') {
      return goog.math.Long.fromString(str.substring(1), radix).negate();
    } else if (str.indexOf('-') >= 0) {
      throw Error('number format error: interior "-" character: ' + str);
    }

    // Do several (8) digits each time through the loop, so as to
    // minimize the calls to the very expensive emulated div.
    var radixToPower = goog.math.Long.fromNumber(Math.pow(radix, 8));

    var result = goog.math.Long.ZERO;
    for (var i = 0; i < str.length; i += 8) {
      var size = Math.min(8, str.length - i);
      var value = parseInt(str.substring(i, i + size), radix);
      if (size < 8) {
        var power = goog.math.Long.fromNumber(Math.pow(radix, size));
        result = result.multiply(power).add(goog.math.Long.fromNumber(value));
      } else {
        result = result.multiply(radixToPower);
        result = result.add(goog.math.Long.fromNumber(value));
      }
    }
    return result;
  };


  // NOTE: the compiler should inline these constant values below and then remove
  // these variables, so there should be no runtime penalty for these.


  /**
   * Number used repeated below in calculations.  This must appear before the
   * first call to any from* function below.
   * @type {number}
   * @private
   */
  goog.math.Long.TWO_PWR_16_DBL_ = 1 << 16;


  /**
   * @type {number}
   * @private
   */
  goog.math.Long.TWO_PWR_24_DBL_ = 1 << 24;


  /**
   * @type {number}
   * @private
   */
  goog.math.Long.TWO_PWR_32_DBL_ =
      goog.math.Long.TWO_PWR_16_DBL_ * goog.math.Long.TWO_PWR_16_DBL_;


  /**
   * @type {number}
   * @private
   */
  goog.math.Long.TWO_PWR_31_DBL_ =
      goog.math.Long.TWO_PWR_32_DBL_ / 2;


  /**
   * @type {number}
   * @private
   */
  goog.math.Long.TWO_PWR_48_DBL_ =
      goog.math.Long.TWO_PWR_32_DBL_ * goog.math.Long.TWO_PWR_16_DBL_;


  /**
   * @type {number}
   * @private
   */
  goog.math.Long.TWO_PWR_64_DBL_ =
      goog.math.Long.TWO_PWR_32_DBL_ * goog.math.Long.TWO_PWR_32_DBL_;


  /**
   * @type {number}
   * @private
   */
  goog.math.Long.TWO_PWR_63_DBL_ =
      goog.math.Long.TWO_PWR_64_DBL_ / 2;


  /** @type {!goog.math.Long} */
  goog.math.Long.ZERO = goog.math.Long.fromInt(0);


  /** @type {!goog.math.Long} */
  goog.math.Long.ONE = goog.math.Long.fromInt(1);


  /** @type {!goog.math.Long} */
  goog.math.Long.NEG_ONE = goog.math.Long.fromInt(-1);


  /** @type {!goog.math.Long} */
  goog.math.Long.MAX_VALUE =
      goog.math.Long.fromBits(0xFFFFFFFF | 0, 0x7FFFFFFF | 0);


  /** @type {!goog.math.Long} */
  goog.math.Long.MIN_VALUE = goog.math.Long.fromBits(0, 0x80000000 | 0);


  /**
   * @type {!goog.math.Long}
   * @private
   */
  goog.math.Long.TWO_PWR_24_ = goog.math.Long.fromInt(1 << 24);


  /** @return {number} The value, assuming it is a 32-bit integer. */
  goog.math.Long.prototype.toInt = function() {
    return this.low_;
  };


  /** @return {number} The closest floating-point representation to this value. */
  goog.math.Long.prototype.toNumber = function() {
    return this.high_ * goog.math.Long.TWO_PWR_32_DBL_ +
           this.getLowBitsUnsigned();
  };


  /**
   * @param {number=} opt_radix The radix in which the text should be written.
   * @return {string} The textual representation of this value.
   */
  goog.math.Long.prototype.toString = function(opt_radix) {
    var radix = opt_radix || 10;
    if (radix < 2 || 36 < radix) {
      throw Error('radix out of range: ' + radix);
    }

    if (this.isZero()) {
      return '0';
    }

    if (this.isNegative()) {
      if (this.equals(goog.math.Long.MIN_VALUE)) {
        // We need to change the Long value before it can be negated, so we remove
        // the bottom-most digit in this base and then recurse to do the rest.
        var radixLong = goog.math.Long.fromNumber(radix);
        var div = this.div(radixLong);
        var rem = div.multiply(radixLong).subtract(this);
        return div.toString(radix) + rem.toInt().toString(radix);
      } else {
        return '-' + this.negate().toString(radix);
      }
    }

    // Do several (6) digits each time through the loop, so as to
    // minimize the calls to the very expensive emulated div.
    var radixToPower = goog.math.Long.fromNumber(Math.pow(radix, 6));

    var rem = this;
    var result = '';
    while (true) {
      var remDiv = rem.div(radixToPower);
      var intval = rem.subtract(remDiv.multiply(radixToPower)).toInt();
      var digits = intval.toString(radix);

      rem = remDiv;
      if (rem.isZero()) {
        return digits + result;
      } else {
        while (digits.length < 6) {
          digits = '0' + digits;
        }
        result = '' + digits + result;
      }
    }
  };


  /** @return {number} The high 32-bits as a signed value. */
  goog.math.Long.prototype.getHighBits = function() {
    return this.high_;
  };


  /** @return {number} The low 32-bits as a signed value. */
  goog.math.Long.prototype.getLowBits = function() {
    return this.low_;
  };


  /** @return {number} The low 32-bits as an unsigned value. */
  goog.math.Long.prototype.getLowBitsUnsigned = function() {
    return (this.low_ >= 0) ?
        this.low_ : goog.math.Long.TWO_PWR_32_DBL_ + this.low_;
  };


  /**
   * @return {number} Returns the number of bits needed to represent the absolute
   *     value of this Long.
   */
  goog.math.Long.prototype.getNumBitsAbs = function() {
    if (this.isNegative()) {
      if (this.equals(goog.math.Long.MIN_VALUE)) {
        return 64;
      } else {
        return this.negate().getNumBitsAbs();
      }
    } else {
      var val = this.high_ != 0 ? this.high_ : this.low_;
      for (var bit = 31; bit > 0; bit--) {
        if ((val & (1 << bit)) != 0) {
          break;
        }
      }
      return this.high_ != 0 ? bit + 33 : bit + 1;
    }
  };


  /** @return {boolean} Whether this value is zero. */
  goog.math.Long.prototype.isZero = function() {
    return this.high_ == 0 && this.low_ == 0;
  };


  /** @return {boolean} Whether this value is negative. */
  goog.math.Long.prototype.isNegative = function() {
    return this.high_ < 0;
  };


  /** @return {boolean} Whether this value is odd. */
  goog.math.Long.prototype.isOdd = function() {
    return (this.low_ & 1) == 1;
  };


  /**
   * @param {goog.math.Long} other Long to compare against.
   * @return {boolean} Whether this Long equals the other.
   */
  goog.math.Long.prototype.equals = function(other) {
    return (this.high_ == other.high_) && (this.low_ == other.low_);
  };


  /**
   * @param {goog.math.Long} other Long to compare against.
   * @return {boolean} Whether this Long does not equal the other.
   */
  goog.math.Long.prototype.notEquals = function(other) {
    return (this.high_ != other.high_) || (this.low_ != other.low_);
  };


  /**
   * @param {goog.math.Long} other Long to compare against.
   * @return {boolean} Whether this Long is less than the other.
   */
  goog.math.Long.prototype.lessThan = function(other) {
    return this.compare(other) < 0;
  };


  /**
   * @param {goog.math.Long} other Long to compare against.
   * @return {boolean} Whether this Long is less than or equal to the other.
   */
  goog.math.Long.prototype.lessThanOrEqual = function(other) {
    return this.compare(other) <= 0;
  };


  /**
   * @param {goog.math.Long} other Long to compare against.
   * @return {boolean} Whether this Long is greater than the other.
   */
  goog.math.Long.prototype.greaterThan = function(other) {
    return this.compare(other) > 0;
  };


  /**
   * @param {goog.math.Long} other Long to compare against.
   * @return {boolean} Whether this Long is greater than or equal to the other.
   */
  goog.math.Long.prototype.greaterThanOrEqual = function(other) {
    return this.compare(other) >= 0;
  };


  /**
   * Compares this Long with the given one.
   * @param {goog.math.Long} other Long to compare against.
   * @return {number} 0 if they are the same, 1 if the this is greater, and -1
   *     if the given one is greater.
   */
  goog.math.Long.prototype.compare = function(other) {
    if (this.equals(other)) {
      return 0;
    }

    var thisNeg = this.isNegative();
    var otherNeg = other.isNegative();
    if (thisNeg && !otherNeg) {
      return -1;
    }
    if (!thisNeg && otherNeg) {
      return 1;
    }

    // at this point, the signs are the same, so subtraction will not overflow
    if (this.subtract(other).isNegative()) {
      return -1;
    } else {
      return 1;
    }
  };


  /** @return {!goog.math.Long} The negation of this value. */
  goog.math.Long.prototype.negate = function() {
    if (this.equals(goog.math.Long.MIN_VALUE)) {
      return goog.math.Long.MIN_VALUE;
    } else {
      return this.not().add(goog.math.Long.ONE);
    }
  };


  /**
   * Returns the sum of this and the given Long.
   * @param {goog.math.Long} other Long to add to this one.
   * @return {!goog.math.Long} The sum of this and the given Long.
   */
  goog.math.Long.prototype.add = function(other) {
    // Divide each number into 4 chunks of 16 bits, and then sum the chunks.

    var a48 = this.high_ >>> 16;
    var a32 = this.high_ & 0xFFFF;
    var a16 = this.low_ >>> 16;
    var a00 = this.low_ & 0xFFFF;

    var b48 = other.high_ >>> 16;
    var b32 = other.high_ & 0xFFFF;
    var b16 = other.low_ >>> 16;
    var b00 = other.low_ & 0xFFFF;

    var c48 = 0, c32 = 0, c16 = 0, c00 = 0;
    c00 += a00 + b00;
    c16 += c00 >>> 16;
    c00 &= 0xFFFF;
    c16 += a16 + b16;
    c32 += c16 >>> 16;
    c16 &= 0xFFFF;
    c32 += a32 + b32;
    c48 += c32 >>> 16;
    c32 &= 0xFFFF;
    c48 += a48 + b48;
    c48 &= 0xFFFF;
    return goog.math.Long.fromBits((c16 << 16) | c00, (c48 << 16) | c32);
  };


  /**
   * Returns the difference of this and the given Long.
   * @param {goog.math.Long} other Long to subtract from this.
   * @return {!goog.math.Long} The difference of this and the given Long.
   */
  goog.math.Long.prototype.subtract = function(other) {
    return this.add(other.negate());
  };


  /**
   * Returns the product of this and the given long.
   * @param {goog.math.Long} other Long to multiply with this.
   * @return {!goog.math.Long} The product of this and the other.
   */
  goog.math.Long.prototype.multiply = function(other) {
    if (this.isZero()) {
      return goog.math.Long.ZERO;
    } else if (other.isZero()) {
      return goog.math.Long.ZERO;
    }

    if (this.equals(goog.math.Long.MIN_VALUE)) {
      return other.isOdd() ? goog.math.Long.MIN_VALUE : goog.math.Long.ZERO;
    } else if (other.equals(goog.math.Long.MIN_VALUE)) {
      return this.isOdd() ? goog.math.Long.MIN_VALUE : goog.math.Long.ZERO;
    }

    if (this.isNegative()) {
      if (other.isNegative()) {
        return this.negate().multiply(other.negate());
      } else {
        return this.negate().multiply(other).negate();
      }
    } else if (other.isNegative()) {
      return this.multiply(other.negate()).negate();
    }

    // If both longs are small, use float multiplication
    if (this.lessThan(goog.math.Long.TWO_PWR_24_) &&
        other.lessThan(goog.math.Long.TWO_PWR_24_)) {
      return goog.math.Long.fromNumber(this.toNumber() * other.toNumber());
    }

    // Divide each long into 4 chunks of 16 bits, and then add up 4x4 products.
    // We can skip products that would overflow.

    var a48 = this.high_ >>> 16;
    var a32 = this.high_ & 0xFFFF;
    var a16 = this.low_ >>> 16;
    var a00 = this.low_ & 0xFFFF;

    var b48 = other.high_ >>> 16;
    var b32 = other.high_ & 0xFFFF;
    var b16 = other.low_ >>> 16;
    var b00 = other.low_ & 0xFFFF;

    var c48 = 0, c32 = 0, c16 = 0, c00 = 0;
    c00 += a00 * b00;
    c16 += c00 >>> 16;
    c00 &= 0xFFFF;
    c16 += a16 * b00;
    c32 += c16 >>> 16;
    c16 &= 0xFFFF;
    c16 += a00 * b16;
    c32 += c16 >>> 16;
    c16 &= 0xFFFF;
    c32 += a32 * b00;
    c48 += c32 >>> 16;
    c32 &= 0xFFFF;
    c32 += a16 * b16;
    c48 += c32 >>> 16;
    c32 &= 0xFFFF;
    c32 += a00 * b32;
    c48 += c32 >>> 16;
    c32 &= 0xFFFF;
    c48 += a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48;
    c48 &= 0xFFFF;
    return goog.math.Long.fromBits((c16 << 16) | c00, (c48 << 16) | c32);
  };


  /**
   * Returns this Long divided by the given one.
   * @param {goog.math.Long} other Long by which to divide.
   * @return {!goog.math.Long} This Long divided by the given one.
   */
  goog.math.Long.prototype.div = function(other) {
    if (other.isZero()) {
      throw Error('division by zero');
    } else if (this.isZero()) {
      return goog.math.Long.ZERO;
    }

    if (this.equals(goog.math.Long.MIN_VALUE)) {
      if (other.equals(goog.math.Long.ONE) ||
          other.equals(goog.math.Long.NEG_ONE)) {
        return goog.math.Long.MIN_VALUE;  // recall that -MIN_VALUE == MIN_VALUE
      } else if (other.equals(goog.math.Long.MIN_VALUE)) {
        return goog.math.Long.ONE;
      } else {
        // At this point, we have |other| >= 2, so |this/other| < |MIN_VALUE|.
        var halfThis = this.shiftRight(1);
        var approx = halfThis.div(other).shiftLeft(1);
        if (approx.equals(goog.math.Long.ZERO)) {
          return other.isNegative() ? goog.math.Long.ONE : goog.math.Long.NEG_ONE;
        } else {
          var rem = this.subtract(other.multiply(approx));
          var result = approx.add(rem.div(other));
          return result;
        }
      }
    } else if (other.equals(goog.math.Long.MIN_VALUE)) {
      return goog.math.Long.ZERO;
    }

    if (this.isNegative()) {
      if (other.isNegative()) {
        return this.negate().div(other.negate());
      } else {
        return this.negate().div(other).negate();
      }
    } else if (other.isNegative()) {
      return this.div(other.negate()).negate();
    }

    // Repeat the following until the remainder is less than other:  find a
    // floating-point that approximates remainder / other *from below*, add this
    // into the result, and subtract it from the remainder.  It is critical that
    // the approximate value is less than or equal to the real value so that the
    // remainder never becomes negative.
    var res = goog.math.Long.ZERO;
    var rem = this;
    while (rem.greaterThanOrEqual(other)) {
      // Approximate the result of division. This may be a little greater or
      // smaller than the actual value.
      var approx = Math.max(1, Math.floor(rem.toNumber() / other.toNumber()));

      // We will tweak the approximate result by changing it in the 48-th digit or
      // the smallest non-fractional digit, whichever is larger.
      var log2 = Math.ceil(Math.log(approx) / Math.LN2);
      var delta = (log2 <= 48) ? 1 : Math.pow(2, log2 - 48);

      // Decrease the approximation until it is smaller than the remainder.  Note
      // that if it is too large, the product overflows and is negative.
      var approxRes = goog.math.Long.fromNumber(approx);
      var approxRem = approxRes.multiply(other);
      while (approxRem.isNegative() || approxRem.greaterThan(rem)) {
        approx -= delta;
        approxRes = goog.math.Long.fromNumber(approx);
        approxRem = approxRes.multiply(other);
      }

      // We know the answer can't be zero... and actually, zero would cause
      // infinite recursion since we would make no progress.
      if (approxRes.isZero()) {
        approxRes = goog.math.Long.ONE;
      }

      res = res.add(approxRes);
      rem = rem.subtract(approxRem);
    }
    return res;
  };


  /**
   * Returns this Long modulo the given one.
   * @param {goog.math.Long} other Long by which to mod.
   * @return {!goog.math.Long} This Long modulo the given one.
   */
  goog.math.Long.prototype.modulo = function(other) {
    return this.subtract(this.div(other).multiply(other));
  };


  /** @return {!goog.math.Long} The bitwise-NOT of this value. */
  goog.math.Long.prototype.not = function() {
    return goog.math.Long.fromBits(~this.low_, ~this.high_);
  };


  /**
   * Returns the bitwise-AND of this Long and the given one.
   * @param {goog.math.Long} other The Long with which to AND.
   * @return {!goog.math.Long} The bitwise-AND of this and the other.
   */
  goog.math.Long.prototype.and = function(other) {
    return goog.math.Long.fromBits(this.low_ & other.low_,
                                   this.high_ & other.high_);
  };


  /**
   * Returns the bitwise-OR of this Long and the given one.
   * @param {goog.math.Long} other The Long with which to OR.
   * @return {!goog.math.Long} The bitwise-OR of this and the other.
   */
  goog.math.Long.prototype.or = function(other) {
    return goog.math.Long.fromBits(this.low_ | other.low_,
                                   this.high_ | other.high_);
  };


  /**
   * Returns the bitwise-XOR of this Long and the given one.
   * @param {goog.math.Long} other The Long with which to XOR.
   * @return {!goog.math.Long} The bitwise-XOR of this and the other.
   */
  goog.math.Long.prototype.xor = function(other) {
    return goog.math.Long.fromBits(this.low_ ^ other.low_,
                                   this.high_ ^ other.high_);
  };


  /**
   * Returns this Long with bits shifted to the left by the given amount.
   * @param {number} numBits The number of bits by which to shift.
   * @return {!goog.math.Long} This shifted to the left by the given amount.
   */
  goog.math.Long.prototype.shiftLeft = function(numBits) {
    numBits &= 63;
    if (numBits == 0) {
      return this;
    } else {
      var low = this.low_;
      if (numBits < 32) {
        var high = this.high_;
        return goog.math.Long.fromBits(
            low << numBits,
            (high << numBits) | (low >>> (32 - numBits)));
      } else {
        return goog.math.Long.fromBits(0, low << (numBits - 32));
      }
    }
  };


  /**
   * Returns this Long with bits shifted to the right by the given amount.
   * @param {number} numBits The number of bits by which to shift.
   * @return {!goog.math.Long} This shifted to the right by the given amount.
   */
  goog.math.Long.prototype.shiftRight = function(numBits) {
    numBits &= 63;
    if (numBits == 0) {
      return this;
    } else {
      var high = this.high_;
      if (numBits < 32) {
        var low = this.low_;
        return goog.math.Long.fromBits(
            (low >>> numBits) | (high << (32 - numBits)),
            high >> numBits);
      } else {
        return goog.math.Long.fromBits(
            high >> (numBits - 32),
            high >= 0 ? 0 : -1);
      }
    }
  };


  /**
   * Returns this Long with bits shifted to the right by the given amount, with
   * the new top bits matching the current sign bit.
   * @param {number} numBits The number of bits by which to shift.
   * @return {!goog.math.Long} This shifted to the right by the given amount, with
   *     zeros placed into the new leading bits.
   */
  goog.math.Long.prototype.shiftRightUnsigned = function(numBits) {
    numBits &= 63;
    if (numBits == 0) {
      return this;
    } else {
      var high = this.high_;
      if (numBits < 32) {
        var low = this.low_;
        return goog.math.Long.fromBits(
            (low >>> numBits) | (high << (32 - numBits)),
            high >>> numBits);
      } else if (numBits == 32) {
        return goog.math.Long.fromBits(high, 0);
      } else {
        return goog.math.Long.fromBits(high >>> (numBits - 32), 0);
      }
    }
  };

  //======= begin jsbn =======

  var navigator = { appName: 'Modern Browser' }; // polyfill a little

  // Copyright (c) 2005  Tom Wu
  // All Rights Reserved.
  // http://www-cs-students.stanford.edu/~tjw/jsbn/

  /*
   * Copyright (c) 2003-2005  Tom Wu
   * All Rights Reserved.
   *
   * Permission is hereby granted, free of charge, to any person obtaining
   * a copy of this software and associated documentation files (the
   * "Software"), to deal in the Software without restriction, including
   * without limitation the rights to use, copy, modify, merge, publish,
   * distribute, sublicense, and/or sell copies of the Software, and to
   * permit persons to whom the Software is furnished to do so, subject to
   * the following conditions:
   *
   * The above copyright notice and this permission notice shall be
   * included in all copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS-IS" AND WITHOUT WARRANTY OF ANY KIND, 
   * EXPRESS, IMPLIED OR OTHERWISE, INCLUDING WITHOUT LIMITATION, ANY 
   * WARRANTY OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.  
   *
   * IN NO EVENT SHALL TOM WU BE LIABLE FOR ANY SPECIAL, INCIDENTAL,
   * INDIRECT OR CONSEQUENTIAL DAMAGES OF ANY KIND, OR ANY DAMAGES WHATSOEVER
   * RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER OR NOT ADVISED OF
   * THE POSSIBILITY OF DAMAGE, AND ON ANY THEORY OF LIABILITY, ARISING OUT
   * OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
   *
   * In addition, the following condition applies:
   *
   * All redistributions must retain an intact copy of this copyright notice
   * and disclaimer.
   */

  // Basic JavaScript BN library - subset useful for RSA encryption.

  // Bits per digit
  var dbits;

  // JavaScript engine analysis
  var canary = 0xdeadbeefcafe;
  var j_lm = ((canary&0xffffff)==0xefcafe);

  // (public) Constructor
  function BigInteger(a,b,c) {
    if(a != null)
      if("number" == typeof a) this.fromNumber(a,b,c);
      else if(b == null && "string" != typeof a) this.fromString(a,256);
      else this.fromString(a,b);
  }

  // return new, unset BigInteger
  function nbi() { return new BigInteger(null); }

  // am: Compute w_j += (x*this_i), propagate carries,
  // c is initial carry, returns final carry.
  // c < 3*dvalue, x < 2*dvalue, this_i < dvalue
  // We need to select the fastest one that works in this environment.

  // am1: use a single mult and divide to get the high bits,
  // max digit bits should be 26 because
  // max internal value = 2*dvalue^2-2*dvalue (< 2^53)
  function am1(i,x,w,j,c,n) {
    while(--n >= 0) {
      var v = x*this[i++]+w[j]+c;
      c = Math.floor(v/0x4000000);
      w[j++] = v&0x3ffffff;
    }
    return c;
  }
  // am2 avoids a big mult-and-extract completely.
  // Max digit bits should be <= 30 because we do bitwise ops
  // on values up to 2*hdvalue^2-hdvalue-1 (< 2^31)
  function am2(i,x,w,j,c,n) {
    var xl = x&0x7fff, xh = x>>15;
    while(--n >= 0) {
      var l = this[i]&0x7fff;
      var h = this[i++]>>15;
      var m = xh*l+h*xl;
      l = xl*l+((m&0x7fff)<<15)+w[j]+(c&0x3fffffff);
      c = (l>>>30)+(m>>>15)+xh*h+(c>>>30);
      w[j++] = l&0x3fffffff;
    }
    return c;
  }
  // Alternately, set max digit bits to 28 since some
  // browsers slow down when dealing with 32-bit numbers.
  function am3(i,x,w,j,c,n) {
    var xl = x&0x3fff, xh = x>>14;
    while(--n >= 0) {
      var l = this[i]&0x3fff;
      var h = this[i++]>>14;
      var m = xh*l+h*xl;
      l = xl*l+((m&0x3fff)<<14)+w[j]+c;
      c = (l>>28)+(m>>14)+xh*h;
      w[j++] = l&0xfffffff;
    }
    return c;
  }
  if(j_lm && (navigator.appName == "Microsoft Internet Explorer")) {
    BigInteger.prototype.am = am2;
    dbits = 30;
  }
  else if(j_lm && (navigator.appName != "Netscape")) {
    BigInteger.prototype.am = am1;
    dbits = 26;
  }
  else { // Mozilla/Netscape seems to prefer am3
    BigInteger.prototype.am = am3;
    dbits = 28;
  }

  BigInteger.prototype.DB = dbits;
  BigInteger.prototype.DM = ((1<<dbits)-1);
  BigInteger.prototype.DV = (1<<dbits);

  var BI_FP = 52;
  BigInteger.prototype.FV = Math.pow(2,BI_FP);
  BigInteger.prototype.F1 = BI_FP-dbits;
  BigInteger.prototype.F2 = 2*dbits-BI_FP;

  // Digit conversions
  var BI_RM = "0123456789abcdefghijklmnopqrstuvwxyz";
  var BI_RC = new Array();
  var rr,vv;
  rr = "0".charCodeAt(0);
  for(vv = 0; vv <= 9; ++vv) BI_RC[rr++] = vv;
  rr = "a".charCodeAt(0);
  for(vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;
  rr = "A".charCodeAt(0);
  for(vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;

  function int2char(n) { return BI_RM.charAt(n); }
  function intAt(s,i) {
    var c = BI_RC[s.charCodeAt(i)];
    return (c==null)?-1:c;
  }

  // (protected) copy this to r
  function bnpCopyTo(r) {
    for(var i = this.t-1; i >= 0; --i) r[i] = this[i];
    r.t = this.t;
    r.s = this.s;
  }

  // (protected) set from integer value x, -DV <= x < DV
  function bnpFromInt(x) {
    this.t = 1;
    this.s = (x<0)?-1:0;
    if(x > 0) this[0] = x;
    else if(x < -1) this[0] = x+DV;
    else this.t = 0;
  }

  // return bigint initialized to value
  function nbv(i) { var r = nbi(); r.fromInt(i); return r; }

  // (protected) set from string and radix
  function bnpFromString(s,b) {
    var k;
    if(b == 16) k = 4;
    else if(b == 8) k = 3;
    else if(b == 256) k = 8; // byte array
    else if(b == 2) k = 1;
    else if(b == 32) k = 5;
    else if(b == 4) k = 2;
    else { this.fromRadix(s,b); return; }
    this.t = 0;
    this.s = 0;
    var i = s.length, mi = false, sh = 0;
    while(--i >= 0) {
      var x = (k==8)?s[i]&0xff:intAt(s,i);
      if(x < 0) {
        if(s.charAt(i) == "-") mi = true;
        continue;
      }
      mi = false;
      if(sh == 0)
        this[this.t++] = x;
      else if(sh+k > this.DB) {
        this[this.t-1] |= (x&((1<<(this.DB-sh))-1))<<sh;
        this[this.t++] = (x>>(this.DB-sh));
      }
      else
        this[this.t-1] |= x<<sh;
      sh += k;
      if(sh >= this.DB) sh -= this.DB;
    }
    if(k == 8 && (s[0]&0x80) != 0) {
      this.s = -1;
      if(sh > 0) this[this.t-1] |= ((1<<(this.DB-sh))-1)<<sh;
    }
    this.clamp();
    if(mi) BigInteger.ZERO.subTo(this,this);
  }

  // (protected) clamp off excess high words
  function bnpClamp() {
    var c = this.s&this.DM;
    while(this.t > 0 && this[this.t-1] == c) --this.t;
  }

  // (public) return string representation in given radix
  function bnToString(b) {
    if(this.s < 0) return "-"+this.negate().toString(b);
    var k;
    if(b == 16) k = 4;
    else if(b == 8) k = 3;
    else if(b == 2) k = 1;
    else if(b == 32) k = 5;
    else if(b == 4) k = 2;
    else return this.toRadix(b);
    var km = (1<<k)-1, d, m = false, r = "", i = this.t;
    var p = this.DB-(i*this.DB)%k;
    if(i-- > 0) {
      if(p < this.DB && (d = this[i]>>p) > 0) { m = true; r = int2char(d); }
      while(i >= 0) {
        if(p < k) {
          d = (this[i]&((1<<p)-1))<<(k-p);
          d |= this[--i]>>(p+=this.DB-k);
        }
        else {
          d = (this[i]>>(p-=k))&km;
          if(p <= 0) { p += this.DB; --i; }
        }
        if(d > 0) m = true;
        if(m) r += int2char(d);
      }
    }
    return m?r:"0";
  }

  // (public) -this
  function bnNegate() { var r = nbi(); BigInteger.ZERO.subTo(this,r); return r; }

  // (public) |this|
  function bnAbs() { return (this.s<0)?this.negate():this; }

  // (public) return + if this > a, - if this < a, 0 if equal
  function bnCompareTo(a) {
    var r = this.s-a.s;
    if(r != 0) return r;
    var i = this.t;
    r = i-a.t;
    if(r != 0) return (this.s<0)?-r:r;
    while(--i >= 0) if((r=this[i]-a[i]) != 0) return r;
    return 0;
  }

  // returns bit length of the integer x
  function nbits(x) {
    var r = 1, t;
    if((t=x>>>16) != 0) { x = t; r += 16; }
    if((t=x>>8) != 0) { x = t; r += 8; }
    if((t=x>>4) != 0) { x = t; r += 4; }
    if((t=x>>2) != 0) { x = t; r += 2; }
    if((t=x>>1) != 0) { x = t; r += 1; }
    return r;
  }

  // (public) return the number of bits in "this"
  function bnBitLength() {
    if(this.t <= 0) return 0;
    return this.DB*(this.t-1)+nbits(this[this.t-1]^(this.s&this.DM));
  }

  // (protected) r = this << n*DB
  function bnpDLShiftTo(n,r) {
    var i;
    for(i = this.t-1; i >= 0; --i) r[i+n] = this[i];
    for(i = n-1; i >= 0; --i) r[i] = 0;
    r.t = this.t+n;
    r.s = this.s;
  }

  // (protected) r = this >> n*DB
  function bnpDRShiftTo(n,r) {
    for(var i = n; i < this.t; ++i) r[i-n] = this[i];
    r.t = Math.max(this.t-n,0);
    r.s = this.s;
  }

  // (protected) r = this << n
  function bnpLShiftTo(n,r) {
    var bs = n%this.DB;
    var cbs = this.DB-bs;
    var bm = (1<<cbs)-1;
    var ds = Math.floor(n/this.DB), c = (this.s<<bs)&this.DM, i;
    for(i = this.t-1; i >= 0; --i) {
      r[i+ds+1] = (this[i]>>cbs)|c;
      c = (this[i]&bm)<<bs;
    }
    for(i = ds-1; i >= 0; --i) r[i] = 0;
    r[ds] = c;
    r.t = this.t+ds+1;
    r.s = this.s;
    r.clamp();
  }

  // (protected) r = this >> n
  function bnpRShiftTo(n,r) {
    r.s = this.s;
    var ds = Math.floor(n/this.DB);
    if(ds >= this.t) { r.t = 0; return; }
    var bs = n%this.DB;
    var cbs = this.DB-bs;
    var bm = (1<<bs)-1;
    r[0] = this[ds]>>bs;
    for(var i = ds+1; i < this.t; ++i) {
      r[i-ds-1] |= (this[i]&bm)<<cbs;
      r[i-ds] = this[i]>>bs;
    }
    if(bs > 0) r[this.t-ds-1] |= (this.s&bm)<<cbs;
    r.t = this.t-ds;
    r.clamp();
  }

  // (protected) r = this - a
  function bnpSubTo(a,r) {
    var i = 0, c = 0, m = Math.min(a.t,this.t);
    while(i < m) {
      c += this[i]-a[i];
      r[i++] = c&this.DM;
      c >>= this.DB;
    }
    if(a.t < this.t) {
      c -= a.s;
      while(i < this.t) {
        c += this[i];
        r[i++] = c&this.DM;
        c >>= this.DB;
      }
      c += this.s;
    }
    else {
      c += this.s;
      while(i < a.t) {
        c -= a[i];
        r[i++] = c&this.DM;
        c >>= this.DB;
      }
      c -= a.s;
    }
    r.s = (c<0)?-1:0;
    if(c < -1) r[i++] = this.DV+c;
    else if(c > 0) r[i++] = c;
    r.t = i;
    r.clamp();
  }

  // (protected) r = this * a, r != this,a (HAC 14.12)
  // "this" should be the larger one if appropriate.
  function bnpMultiplyTo(a,r) {
    var x = this.abs(), y = a.abs();
    var i = x.t;
    r.t = i+y.t;
    while(--i >= 0) r[i] = 0;
    for(i = 0; i < y.t; ++i) r[i+x.t] = x.am(0,y[i],r,i,0,x.t);
    r.s = 0;
    r.clamp();
    if(this.s != a.s) BigInteger.ZERO.subTo(r,r);
  }

  // (protected) r = this^2, r != this (HAC 14.16)
  function bnpSquareTo(r) {
    var x = this.abs();
    var i = r.t = 2*x.t;
    while(--i >= 0) r[i] = 0;
    for(i = 0; i < x.t-1; ++i) {
      var c = x.am(i,x[i],r,2*i,0,1);
      if((r[i+x.t]+=x.am(i+1,2*x[i],r,2*i+1,c,x.t-i-1)) >= x.DV) {
        r[i+x.t] -= x.DV;
        r[i+x.t+1] = 1;
      }
    }
    if(r.t > 0) r[r.t-1] += x.am(i,x[i],r,2*i,0,1);
    r.s = 0;
    r.clamp();
  }

  // (protected) divide this by m, quotient and remainder to q, r (HAC 14.20)
  // r != q, this != m.  q or r may be null.
  function bnpDivRemTo(m,q,r) {
    var pm = m.abs();
    if(pm.t <= 0) return;
    var pt = this.abs();
    if(pt.t < pm.t) {
      if(q != null) q.fromInt(0);
      if(r != null) this.copyTo(r);
      return;
    }
    if(r == null) r = nbi();
    var y = nbi(), ts = this.s, ms = m.s;
    var nsh = this.DB-nbits(pm[pm.t-1]);	// normalize modulus
    if(nsh > 0) { pm.lShiftTo(nsh,y); pt.lShiftTo(nsh,r); }
    else { pm.copyTo(y); pt.copyTo(r); }
    var ys = y.t;
    var y0 = y[ys-1];
    if(y0 == 0) return;
    var yt = y0*(1<<this.F1)+((ys>1)?y[ys-2]>>this.F2:0);
    var d1 = this.FV/yt, d2 = (1<<this.F1)/yt, e = 1<<this.F2;
    var i = r.t, j = i-ys, t = (q==null)?nbi():q;
    y.dlShiftTo(j,t);
    if(r.compareTo(t) >= 0) {
      r[r.t++] = 1;
      r.subTo(t,r);
    }
    BigInteger.ONE.dlShiftTo(ys,t);
    t.subTo(y,y);	// "negative" y so we can replace sub with am later
    while(y.t < ys) y[y.t++] = 0;
    while(--j >= 0) {
      // Estimate quotient digit
      var qd = (r[--i]==y0)?this.DM:Math.floor(r[i]*d1+(r[i-1]+e)*d2);
      if((r[i]+=y.am(0,qd,r,j,0,ys)) < qd) {	// Try it out
        y.dlShiftTo(j,t);
        r.subTo(t,r);
        while(r[i] < --qd) r.subTo(t,r);
      }
    }
    if(q != null) {
      r.drShiftTo(ys,q);
      if(ts != ms) BigInteger.ZERO.subTo(q,q);
    }
    r.t = ys;
    r.clamp();
    if(nsh > 0) r.rShiftTo(nsh,r);	// Denormalize remainder
    if(ts < 0) BigInteger.ZERO.subTo(r,r);
  }

  // (public) this mod a
  function bnMod(a) {
    var r = nbi();
    this.abs().divRemTo(a,null,r);
    if(this.s < 0 && r.compareTo(BigInteger.ZERO) > 0) a.subTo(r,r);
    return r;
  }

  // Modular reduction using "classic" algorithm
  function Classic(m) { this.m = m; }
  function cConvert(x) {
    if(x.s < 0 || x.compareTo(this.m) >= 0) return x.mod(this.m);
    else return x;
  }
  function cRevert(x) { return x; }
  function cReduce(x) { x.divRemTo(this.m,null,x); }
  function cMulTo(x,y,r) { x.multiplyTo(y,r); this.reduce(r); }
  function cSqrTo(x,r) { x.squareTo(r); this.reduce(r); }

  Classic.prototype.convert = cConvert;
  Classic.prototype.revert = cRevert;
  Classic.prototype.reduce = cReduce;
  Classic.prototype.mulTo = cMulTo;
  Classic.prototype.sqrTo = cSqrTo;

  // (protected) return "-1/this % 2^DB"; useful for Mont. reduction
  // justification:
  //         xy == 1 (mod m)
  //         xy =  1+km
  //   xy(2-xy) = (1+km)(1-km)
  // x[y(2-xy)] = 1-k^2m^2
  // x[y(2-xy)] == 1 (mod m^2)
  // if y is 1/x mod m, then y(2-xy) is 1/x mod m^2
  // should reduce x and y(2-xy) by m^2 at each step to keep size bounded.
  // JS multiply "overflows" differently from C/C++, so care is needed here.
  function bnpInvDigit() {
    if(this.t < 1) return 0;
    var x = this[0];
    if((x&1) == 0) return 0;
    var y = x&3;		// y == 1/x mod 2^2
    y = (y*(2-(x&0xf)*y))&0xf;	// y == 1/x mod 2^4
    y = (y*(2-(x&0xff)*y))&0xff;	// y == 1/x mod 2^8
    y = (y*(2-(((x&0xffff)*y)&0xffff)))&0xffff;	// y == 1/x mod 2^16
    // last step - calculate inverse mod DV directly;
    // assumes 16 < DB <= 32 and assumes ability to handle 48-bit ints
    y = (y*(2-x*y%this.DV))%this.DV;		// y == 1/x mod 2^dbits
    // we really want the negative inverse, and -DV < y < DV
    return (y>0)?this.DV-y:-y;
  }

  // Montgomery reduction
  function Montgomery(m) {
    this.m = m;
    this.mp = m.invDigit();
    this.mpl = this.mp&0x7fff;
    this.mph = this.mp>>15;
    this.um = (1<<(m.DB-15))-1;
    this.mt2 = 2*m.t;
  }

  // xR mod m
  function montConvert(x) {
    var r = nbi();
    x.abs().dlShiftTo(this.m.t,r);
    r.divRemTo(this.m,null,r);
    if(x.s < 0 && r.compareTo(BigInteger.ZERO) > 0) this.m.subTo(r,r);
    return r;
  }

  // x/R mod m
  function montRevert(x) {
    var r = nbi();
    x.copyTo(r);
    this.reduce(r);
    return r;
  }

  // x = x/R mod m (HAC 14.32)
  function montReduce(x) {
    while(x.t <= this.mt2)	// pad x so am has enough room later
      x[x.t++] = 0;
    for(var i = 0; i < this.m.t; ++i) {
      // faster way of calculating u0 = x[i]*mp mod DV
      var j = x[i]&0x7fff;
      var u0 = (j*this.mpl+(((j*this.mph+(x[i]>>15)*this.mpl)&this.um)<<15))&x.DM;
      // use am to combine the multiply-shift-add into one call
      j = i+this.m.t;
      x[j] += this.m.am(0,u0,x,i,0,this.m.t);
      // propagate carry
      while(x[j] >= x.DV) { x[j] -= x.DV; x[++j]++; }
    }
    x.clamp();
    x.drShiftTo(this.m.t,x);
    if(x.compareTo(this.m) >= 0) x.subTo(this.m,x);
  }

  // r = "x^2/R mod m"; x != r
  function montSqrTo(x,r) { x.squareTo(r); this.reduce(r); }

  // r = "xy/R mod m"; x,y != r
  function montMulTo(x,y,r) { x.multiplyTo(y,r); this.reduce(r); }

  Montgomery.prototype.convert = montConvert;
  Montgomery.prototype.revert = montRevert;
  Montgomery.prototype.reduce = montReduce;
  Montgomery.prototype.mulTo = montMulTo;
  Montgomery.prototype.sqrTo = montSqrTo;

  // (protected) true iff this is even
  function bnpIsEven() { return ((this.t>0)?(this[0]&1):this.s) == 0; }

  // (protected) this^e, e < 2^32, doing sqr and mul with "r" (HAC 14.79)
  function bnpExp(e,z) {
    if(e > 0xffffffff || e < 1) return BigInteger.ONE;
    var r = nbi(), r2 = nbi(), g = z.convert(this), i = nbits(e)-1;
    g.copyTo(r);
    while(--i >= 0) {
      z.sqrTo(r,r2);
      if((e&(1<<i)) > 0) z.mulTo(r2,g,r);
      else { var t = r; r = r2; r2 = t; }
    }
    return z.revert(r);
  }

  // (public) this^e % m, 0 <= e < 2^32
  function bnModPowInt(e,m) {
    var z;
    if(e < 256 || m.isEven()) z = new Classic(m); else z = new Montgomery(m);
    return this.exp(e,z);
  }

  // protected
  BigInteger.prototype.copyTo = bnpCopyTo;
  BigInteger.prototype.fromInt = bnpFromInt;
  BigInteger.prototype.fromString = bnpFromString;
  BigInteger.prototype.clamp = bnpClamp;
  BigInteger.prototype.dlShiftTo = bnpDLShiftTo;
  BigInteger.prototype.drShiftTo = bnpDRShiftTo;
  BigInteger.prototype.lShiftTo = bnpLShiftTo;
  BigInteger.prototype.rShiftTo = bnpRShiftTo;
  BigInteger.prototype.subTo = bnpSubTo;
  BigInteger.prototype.multiplyTo = bnpMultiplyTo;
  BigInteger.prototype.squareTo = bnpSquareTo;
  BigInteger.prototype.divRemTo = bnpDivRemTo;
  BigInteger.prototype.invDigit = bnpInvDigit;
  BigInteger.prototype.isEven = bnpIsEven;
  BigInteger.prototype.exp = bnpExp;

  // public
  BigInteger.prototype.toString = bnToString;
  BigInteger.prototype.negate = bnNegate;
  BigInteger.prototype.abs = bnAbs;
  BigInteger.prototype.compareTo = bnCompareTo;
  BigInteger.prototype.bitLength = bnBitLength;
  BigInteger.prototype.mod = bnMod;
  BigInteger.prototype.modPowInt = bnModPowInt;

  // "constants"
  BigInteger.ZERO = nbv(0);
  BigInteger.ONE = nbv(1);

  // jsbn2 stuff

  // (protected) convert from radix string
  function bnpFromRadix(s,b) {
    this.fromInt(0);
    if(b == null) b = 10;
    var cs = this.chunkSize(b);
    var d = Math.pow(b,cs), mi = false, j = 0, w = 0;
    for(var i = 0; i < s.length; ++i) {
      var x = intAt(s,i);
      if(x < 0) {
        if(s.charAt(i) == "-" && this.signum() == 0) mi = true;
        continue;
      }
      w = b*w+x;
      if(++j >= cs) {
        this.dMultiply(d);
        this.dAddOffset(w,0);
        j = 0;
        w = 0;
      }
    }
    if(j > 0) {
      this.dMultiply(Math.pow(b,j));
      this.dAddOffset(w,0);
    }
    if(mi) BigInteger.ZERO.subTo(this,this);
  }

  // (protected) return x s.t. r^x < DV
  function bnpChunkSize(r) { return Math.floor(Math.LN2*this.DB/Math.log(r)); }

  // (public) 0 if this == 0, 1 if this > 0
  function bnSigNum() {
    if(this.s < 0) return -1;
    else if(this.t <= 0 || (this.t == 1 && this[0] <= 0)) return 0;
    else return 1;
  }

  // (protected) this *= n, this >= 0, 1 < n < DV
  function bnpDMultiply(n) {
    this[this.t] = this.am(0,n-1,this,0,0,this.t);
    ++this.t;
    this.clamp();
  }

  // (protected) this += n << w words, this >= 0
  function bnpDAddOffset(n,w) {
    if(n == 0) return;
    while(this.t <= w) this[this.t++] = 0;
    this[w] += n;
    while(this[w] >= this.DV) {
      this[w] -= this.DV;
      if(++w >= this.t) this[this.t++] = 0;
      ++this[w];
    }
  }

  // (protected) convert to radix string
  function bnpToRadix(b) {
    if(b == null) b = 10;
    if(this.signum() == 0 || b < 2 || b > 36) return "0";
    var cs = this.chunkSize(b);
    var a = Math.pow(b,cs);
    var d = nbv(a), y = nbi(), z = nbi(), r = "";
    this.divRemTo(d,y,z);
    while(y.signum() > 0) {
      r = (a+z.intValue()).toString(b).substr(1) + r;
      y.divRemTo(d,y,z);
    }
    return z.intValue().toString(b) + r;
  }

  // (public) return value as integer
  function bnIntValue() {
    if(this.s < 0) {
      if(this.t == 1) return this[0]-this.DV;
      else if(this.t == 0) return -1;
    }
    else if(this.t == 1) return this[0];
    else if(this.t == 0) return 0;
    // assumes 16 < DB < 32
    return ((this[1]&((1<<(32-this.DB))-1))<<this.DB)|this[0];
  }

  // (protected) r = this + a
  function bnpAddTo(a,r) {
    var i = 0, c = 0, m = Math.min(a.t,this.t);
    while(i < m) {
      c += this[i]+a[i];
      r[i++] = c&this.DM;
      c >>= this.DB;
    }
    if(a.t < this.t) {
      c += a.s;
      while(i < this.t) {
        c += this[i];
        r[i++] = c&this.DM;
        c >>= this.DB;
      }
      c += this.s;
    }
    else {
      c += this.s;
      while(i < a.t) {
        c += a[i];
        r[i++] = c&this.DM;
        c >>= this.DB;
      }
      c += a.s;
    }
    r.s = (c<0)?-1:0;
    if(c > 0) r[i++] = c;
    else if(c < -1) r[i++] = this.DV+c;
    r.t = i;
    r.clamp();
  }

  BigInteger.prototype.fromRadix = bnpFromRadix;
  BigInteger.prototype.chunkSize = bnpChunkSize;
  BigInteger.prototype.signum = bnSigNum;
  BigInteger.prototype.dMultiply = bnpDMultiply;
  BigInteger.prototype.dAddOffset = bnpDAddOffset;
  BigInteger.prototype.toRadix = bnpToRadix;
  BigInteger.prototype.intValue = bnIntValue;
  BigInteger.prototype.addTo = bnpAddTo;

  //======= end jsbn =======

  // Emscripten wrapper
  var Wrapper = {
    abs: function(l, h) {
      var x = new goog.math.Long(l, h);
      var ret;
      if (x.isNegative()) {
        ret = x.negate();
      } else {
        ret = x;
      }
      HEAP32[tempDoublePtr>>2] = ret.low_;
      HEAP32[tempDoublePtr+4>>2] = ret.high_;
    },
    ensureTemps: function() {
      if (Wrapper.ensuredTemps) return;
      Wrapper.ensuredTemps = true;
      Wrapper.two32 = new BigInteger();
      Wrapper.two32.fromString('4294967296', 10);
      Wrapper.two64 = new BigInteger();
      Wrapper.two64.fromString('18446744073709551616', 10);
      Wrapper.temp1 = new BigInteger();
      Wrapper.temp2 = new BigInteger();
    },
    lh2bignum: function(l, h) {
      var a = new BigInteger();
      a.fromString(h.toString(), 10);
      var b = new BigInteger();
      a.multiplyTo(Wrapper.two32, b);
      var c = new BigInteger();
      c.fromString(l.toString(), 10);
      var d = new BigInteger();
      c.addTo(b, d);
      return d;
    },
    stringify: function(l, h, unsigned) {
      var ret = new goog.math.Long(l, h).toString();
      if (unsigned && ret[0] == '-') {
        // unsign slowly using jsbn bignums
        Wrapper.ensureTemps();
        var bignum = new BigInteger();
        bignum.fromString(ret, 10);
        ret = new BigInteger();
        Wrapper.two64.addTo(bignum, ret);
        ret = ret.toString(10);
      }
      return ret;
    },
    fromString: function(str, base, min, max, unsigned) {
      Wrapper.ensureTemps();
      var bignum = new BigInteger();
      bignum.fromString(str, base);
      var bigmin = new BigInteger();
      bigmin.fromString(min, 10);
      var bigmax = new BigInteger();
      bigmax.fromString(max, 10);
      if (unsigned && bignum.compareTo(BigInteger.ZERO) < 0) {
        var temp = new BigInteger();
        bignum.addTo(Wrapper.two64, temp);
        bignum = temp;
      }
      var error = false;
      if (bignum.compareTo(bigmin) < 0) {
        bignum = bigmin;
        error = true;
      } else if (bignum.compareTo(bigmax) > 0) {
        bignum = bigmax;
        error = true;
      }
      var ret = goog.math.Long.fromString(bignum.toString()); // min-max checks should have clamped this to a range goog.math.Long can handle well
      HEAP32[tempDoublePtr>>2] = ret.low_;
      HEAP32[tempDoublePtr+4>>2] = ret.high_;
      if (error) throw 'range error';
    }
  };
  return Wrapper;
})();

//======= end closure i64 code =======


/*
  Copyright (C) 2013

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.

  https://github.com/johnmccutchan/ecmascript_simd/blob/master/src/ecmascript_simd.js
*/

"use strict";

/**
  * Construct a new instance of float32x4 number.
  * @param {double} value used for x lane.
  * @param {double} value used for y lane.
  * @param {double} value used for z lane.
  * @param {double} value used for w lane.
  * @constructor
  */
function float32x4(x, y, z, w) {
  if (!(this instanceof float32x4)) {
    return new float32x4(x, y, z, w);
  }
  this.storage_ = new Float32Array(4);
  this.storage_[0] = x;
  this.storage_[1] = y;
  this.storage_[2] = z;
  this.storage_[3] = w;
}

/**
  * Construct a new instance of float32x4 number with 0.0 in all lanes.
  * @constructor
  */
float32x4.zero = function() {
  return float32x4(0.0, 0.0, 0.0, 0.0);
}

/**
  * Construct a new instance of float32x4 number with the same value
  * in all lanes.
  * @param {double} value used for all lanes.
  * @constructor
  */
float32x4.splat = function(s) {
  return float32x4(s, s, s, s);
}

Object.defineProperty(float32x4.prototype, 'x', {
  get: function() { return this.storage_[0]; }
});

Object.defineProperty(float32x4.prototype, 'y', {
  get: function() { return this.storage_[1]; }
});

Object.defineProperty(float32x4.prototype, 'z', {
  get: function() { return this.storage_[2]; }
});

Object.defineProperty(float32x4.prototype, 'w',
  { get: function() { return this.storage_[3]; }
});

/**
  * Extract the sign bit from each lane return them in the first 4 bits.
  */
Object.defineProperty(float32x4.prototype, 'signMask', {
  get: function() {
    var mx = this.x < 0.0 ? 1 : 0;
    var my = this.y < 0.0 ? 1 : 0;
    var mz = this.z < 0.0 ? 1 : 0;
    var mw = this.w < 0.0 ? 1 : 0;
    return mx | my << 1 | mz << 2 | mw << 3;
  }
});

/**
  * Construct a new instance of int32x4 number.
  * @param {integer} 32-bit unsigned value used for x lane.
  * @param {integer} 32-bit unsigned value used for y lane.
  * @param {integer} 32-bit unsigned value used for z lane.
  * @param {integer} 32-bit unsigned value used for w lane.
  * @constructor
  */
function int32x4(x, y, z, w) {
  if (!(this instanceof int32x4)) {
    return new int32x4(x, y, z, w);
  }
  this.storage_ = new Int32Array(4);
  this.storage_[0] = x;
  this.storage_[1] = y;
  this.storage_[2] = z;
  this.storage_[3] = w;
}

/**
  * Construct a new instance of int32x4 number with 0xFFFFFFFF or 0x0 in each
  * lane, depending on the truth value in x, y, z, and w.
  * @param {boolean} flag used for x lane.
  * @param {boolean} flag used for y lane.
  * @param {boolean} flag used for z lane.
  * @param {boolean} flag used for w lane.
  * @constructor
  */
int32x4.bool = function(x, y, z, w) {
  return int32x4(x ? -1 : 0x0,
                  y ? -1 : 0x0,
                  z ? -1 : 0x0,
                  w ? -1 : 0x0);
}

/**
  * Construct a new instance of int32x4 number with the same value
  * in all lanes.
  * @param {integer} value used for all lanes.
  * @constructor
  */
int32x4.splat = function(s) {
  return int32x4(s, s, s, s);
}

Object.defineProperty(int32x4.prototype, 'x', {
  get: function() { return this.storage_[0]; }
});

Object.defineProperty(int32x4.prototype, 'y', {
  get: function() { return this.storage_[1]; }
});

Object.defineProperty(int32x4.prototype, 'z', {
  get: function() { return this.storage_[2]; }
});

Object.defineProperty(int32x4.prototype, 'w',
  { get: function() { return this.storage_[3]; }
});

Object.defineProperty(int32x4.prototype, 'flagX', {
  get: function() { return this.storage_[0] != 0x0; }
});

Object.defineProperty(int32x4.prototype, 'flagY', {
  get: function() { return this.storage_[1] != 0x0; }
});

Object.defineProperty(int32x4.prototype, 'flagZ', {
  get: function() { return this.storage_[2] != 0x0; }
});

Object.defineProperty(int32x4.prototype, 'flagW',
  { get: function() { return this.storage_[3] != 0x0; }
});

/**
  * Extract the sign bit from each lane return them in the first 4 bits.
  */
Object.defineProperty(int32x4.prototype, 'signMask', {
  get: function() {
    var mx = (this.storage_[0] & 0x80000000) >>> 31;
    var my = (this.storage_[1] & 0x80000000) >>> 31;
    var mz = (this.storage_[2] & 0x80000000) >>> 31;
    var mw = (this.storage_[3] & 0x80000000) >>> 31;
    return mx | my << 1 | mz << 2 | mw << 3;
  }
});

function isNumber(o) {
    return typeof o == "number" || (typeof o == "object" && o.constructor === Number);
}

function isTypedArray(o) {
  return (o instanceof Int8Array) ||
         (o instanceof Uint8Array) ||
         (o instanceof Uint8ClampedArray) ||
         (o instanceof Int16Array) ||
         (o instanceof Uint16Array) ||
         (o instanceof Int32Array) ||
         (o instanceof Uint32Array) ||
         (o instanceof Float32Array) ||
         (o instanceof Float64Array) ||
         (o instanceof Float32x4Array);
}

function isArrayBuffer(o) {
  return (o instanceof ArrayBuffer);
}

function Float32x4Array(a, b, c) {
  if (isNumber(a)) {
    this.storage_ = new Float32Array(a*4);
    this.length_ = a;
    this.byteOffset_ = 0;
    return;
  } else if (isTypedArray(a)) {
    if (!(a instanceof Float32x4Array)) {
      throw "Copying typed array of non-Float32x4Array is unimplemented.";
    }
    this.storage_ = new Float32Array(a.length * 4);
    this.length_ = a.length;
    this.byteOffset_ = 0;
    // Copy floats.
    for (var i = 0; i < a.length*4; i++) {
      this.storage_[i] = a.storage_[i];
    }
  } else if (isArrayBuffer(a)) {
    if ((b != undefined) && (b % Float32x4Array.BYTES_PER_ELEMENT) != 0) {
      throw "byteOffset must be a multiple of 16.";
    }
    if (c != undefined) {
      c *= 4;
      this.storage_ = new Float32Array(a, b, c);
    }
    else {
      // Note: new Float32Array(a, b) is NOT equivalent to new Float32Array(a, b, undefined)
      this.storage_ = new Float32Array(a, b);
    }
    this.length_ = this.storage_.length / 4;
    this.byteOffset_ = b != undefined ? b : 0;
  } else {
    throw "Unknown type of first argument.";
  }
}

Object.defineProperty(Float32x4Array.prototype, 'length',
  { get: function() { return this.length_; }
});

Object.defineProperty(Float32x4Array.prototype, 'byteLength',
  { get: function() { return this.length_ * Float32x4Array.BYTES_PER_ELEMENT; }
});

Object.defineProperty(Float32x4Array, 'BYTES_PER_ELEMENT',
  { get: function() { return 16; }
});

Object.defineProperty(Float32x4Array.prototype, 'BYTES_PER_ELEMENT',
  { get: function() { return 16; }
});

Object.defineProperty(Float32x4Array.prototype, 'byteOffset',
  { get: function() { return this.byteOffset_; }
});

Object.defineProperty(Float32x4Array.prototype, 'buffer',
  { get: function() { return this.storage_.buffer; }
});

Float32x4Array.prototype.getAt = function(i) {
  if (i < 0) {
    throw "Index must be >= 0.";
  }
  if (i >= this.length) {
    throw "Index out of bounds.";
  }
  var x = this.storage_[i*4+0];
  var y = this.storage_[i*4+1];
  var z = this.storage_[i*4+2];
  var w = this.storage_[i*4+3];
  return float32x4(x, y, z, w);
}

Float32x4Array.prototype.setAt = function(i, v) {
  if (i < 0) {
    throw "Index must be >= 0.";
  }
  if (i >= this.length) {
    throw "Index out of bounds.";
  }
  if (!(v instanceof float32x4)) {
    throw "Value is not a float32x4.";
  }
  this.storage_[i*4+0] = v.x;
  this.storage_[i*4+1] = v.y;
  this.storage_[i*4+2] = v.z;
  this.storage_[i*4+3] = v.w;
}


function Int32x4Array(a, b, c) {

  function isNumber(o) {
      return typeof o == "number" || (typeof o == "object" && o.constructor === Number);
  }

  function isTypedArray(o) {
    return (o instanceof Int8Array) ||
           (o instanceof Uint8Array) ||
           (o instanceof Uint8ClampedArray) ||
           (o instanceof Int16Array) ||
           (o instanceof Uint16Array) ||
           (o instanceof Int32Array) ||
           (o instanceof Uint32Array) ||
           (o instanceof Float32Array) ||
           (o instanceof Float64Array) ||
           (o instanceof Int32x4Array) ||
           (o instanceof Float32x4Array);
  }

  function isArrayBuffer(o) {
    return (o instanceof ArrayBuffer);
  }

  if (isNumber(a)) {
    this.storage_ = new Int32Array(a*4);
    this.length_ = a;
    this.byteOffset_ = 0;
    return;
  } else if (isTypedArray(a)) {
    if (!(a instanceof Int32x4Array)) {
      throw "Copying typed array of non-Int32x4Array is unimplemented.";
    }
    this.storage_ = new Int32Array(a.length * 4);
    this.length_ = a.length;
    this.byteOffset_ = 0;
    // Copy floats.
    for (var i = 0; i < a.length*4; i++) {
      this.storage_[i] = a.storage_[i];
    }
  } else if (isArrayBuffer(a)) {
    if ((b != undefined) && (b % Int32x4Array.BYTES_PER_ELEMENT) != 0) {
      throw "byteOffset must be a multiple of 16.";
    }
    if (c != undefined) {
      c *= 4;
      this.storage_ = new Int32Array(a, b, c);
    }
    else {
      // Note: new Int32Array(a, b) is NOT equivalent to new Float32Array(a, b, undefined)
      this.storage_ = new Int32Array(a, b);
    }
    this.length_ = this.storage_.length / 4;
    this.byteOffset_ = b != undefined ? b : 0;
  } else {
    throw "Unknown type of first argument.";
  }
}

Object.defineProperty(Int32x4Array.prototype, 'length',
  { get: function() { return this.length_; }
});

Object.defineProperty(Int32x4Array.prototype, 'byteLength',
  { get: function() { return this.length_ * Int32x4Array.BYTES_PER_ELEMENT; }
});

Object.defineProperty(Int32x4Array, 'BYTES_PER_ELEMENT',
  { get: function() { return 16; }
});

Object.defineProperty(Int32x4Array.prototype, 'BYTES_PER_ELEMENT',
  { get: function() { return 16; }
});

Object.defineProperty(Int32x4Array.prototype, 'byteOffset',
  { get: function() { return this.byteOffset_; }
});

Object.defineProperty(Int32x4Array.prototype, 'buffer',
  { get: function() { return this.storage_.buffer; }
});

Int32x4Array.prototype.getAt = function(i) {
  if (i < 0) {
    throw "Index must be >= 0.";
  }
  if (i >= this.length) {
    throw "Index out of bounds.";
  }
  var x = this.storage_[i*4+0];
  var y = this.storage_[i*4+1];
  var z = this.storage_[i*4+2];
  var w = this.storage_[i*4+3];
  return float32x4(x, y, z, w);
}

Int32x4Array.prototype.setAt = function(i, v) {
  if (i < 0) {
    throw "Index must be >= 0.";
  }
  if (i >= this.length) {
    throw "Index out of bounds.";
  }
  if (!(v instanceof int32x4)) {
    throw "Value is not a int32x4.";
  }
  this.storage_[i*4+0] = v.x;
  this.storage_[i*4+1] = v.y;
  this.storage_[i*4+2] = v.z;
  this.storage_[i*4+3] = v.w;
}

var SIMD = (function () {
  return {
    float32x4: {
        /**
        * @return {float32x4} New instance of float32x4 with absolute values of
        * t.
        */
      abs: function(t) {
        return new float32x4(Math.abs(t.x), Math.abs(t.y), Math.abs(t.z),
                             Math.abs(t.w));
      },
      /**
        * @return {float32x4} New instance of float32x4 with negated values of
        * t.
        */
      neg: function(t) {
        return new float32x4(-t.x, -t.y, -t.z, -t.w);
      },
      /**
        * @return {float32x4} New instance of float32x4 with a + b.
        */
      add: function(a, b) {
        return new float32x4(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w);
      },
      /**
        * @return {float32x4} New instance of float32x4 with a - b.
        */
      sub: function(a, b) {
        return new float32x4(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w);
      },
      /**
        * @return {float32x4} New instance of float32x4 with a * b.
        */
      mul: function(a, b) {
        return new float32x4(a.x * b.x, a.y * b.y, a.z * b.z, a.w * b.w);
      },
      /**
        * @return {float32x4} New instance of float32x4 with a / b.
        */
      div: function(a, b) {
        return new float32x4(a.x / b.x, a.y / b.y, a.z / b.z, a.w / b.w);
      },
      /**
        * @return {float32x4} New instance of float32x4 with t's values clamped
        * between lowerLimit and upperLimit.
        */
      clamp: function(t, lowerLimit, upperLimit) {
        var cx = t.x < lowerLimit.x ? lowerLimit.x : t.x;
        var cy = t.y < lowerLimit.y ? lowerLimit.y : t.y;
        var cz = t.z < lowerLimit.z ? lowerLimit.z : t.z;
        var cw = t.w < lowerLimit.w ? lowerLimit.w : t.w;
        cx = cx > upperLimit.x ? upperLimit.x : cx;
        cy = cy > upperLimit.y ? upperLimit.y : cy;
        cz = cz > upperLimit.z ? upperLimit.z : cz;
        cw = cw > upperLimit.w ? upperLimit.w : cw;
        return new float32x4(cx, cy, cz, cw);
      },
      /**
        * @return {float32x4} New instance of float32x4 with the minimum value of
        * t and other.
        */
      min: function(t, other) {
        var cx = t.x > other.x ? other.x : t.x;
        var cy = t.y > other.y ? other.y : t.y;
        var cz = t.z > other.z ? other.z : t.z;
        var cw = t.w > other.w ? other.w : t.w;
        return new float32x4(cx, cy, cz, cw);
      },
      /**
        * @return {float32x4} New instance of float32x4 with the maximum value of
        * t and other.
        */
      max: function(t, other) {
        var cx = t.x < other.x ? other.x : t.x;
        var cy = t.y < other.y ? other.y : t.y;
        var cz = t.z < other.z ? other.z : t.z;
        var cw = t.w < other.w ? other.w : t.w;
        return new float32x4(cx, cy, cz, cw);
      },
      /**
        * @return {float32x4} New instance of float32x4 with reciprocal value of
        * t.
        */
      reciprocal: function(t) {
        return new float32x4(1.0 / t.x, 1.0 / t.y, 1.0 / t.z, 1.0 / t.w);
      },
      /**
        * @return {float32x4} New instance of float32x4 with square root of the
        * reciprocal value of t.
        */
      reciprocalSqrt: function(t) {
        return new float32x4(Math.sqrt(1.0 / t.x), Math.sqrt(1.0 / t.y),
                             Math.sqrt(1.0 / t.z), Math.sqrt(1.0 / t.w));
      },
      /**
        * @return {float32x4} New instance of float32x4 with values of t
        * scaled by s.
        */
      scale: function(t, s) {
        return new float32x4(s * t.x, s * t.y, s * t.z, s * t.w);
      },
      /**
        * @return {float32x4} New instance of float32x4 with square root of
        * values of t.
        */
      sqrt: function(t) {
        return new float32x4(Math.sqrt(t.x), Math.sqrt(t.y),
                             Math.sqrt(t.z), Math.sqrt(t.w));
      },
      /**
        * @param {float32x4} t An instance of float32x4 to be shuffled.
        * @param {integer} mask One of the 256 shuffle masks, for example, SIMD.XXXX.
        * @return {float32x4} New instance of float32x4 with lanes shuffled.
        */
      shuffle: function(t, mask) {
        var _x = (mask) & 0x3;
        var _y = (mask >> 2) & 0x3;
        var _z = (mask >> 4) & 0x3;
        var _w = (mask >> 6) & 0x3;
        return new float32x4(t.storage_[_x], t.storage_[_y], t.storage_[_z],
                             t.storage_[_w]);
      },
      /**
        * @param {float32x4} t1 An instance of float32x4 to be shuffled. XY lanes in result
        * @param {float32x4} t2 An instance of float32x4 to be shuffled. ZW lanes in result
        * @param {integer} mask One of the 256 shuffle masks, for example, SIMD.XXXX.
        * @return {float32x4} New instance of float32x4 with lanes shuffled.
        */
      shuffleMix: function(t1, t2, mask) {
        var _x = (mask) & 0x3;
        var _y = (mask >> 2) & 0x3;
        var _z = (mask >> 4) & 0x3;
        var _w = (mask >> 6) & 0x3;
        return new float32x4(t1.storage_[_x], t1.storage_[_y], t2.storage_[_z],
                             t2.storage_[_w]);
      },
      /**
        * @param {double} value used for x lane.
        * @return {float32x4} New instance of float32x4 with the values in t and
        * x replaced with {x}.
        */
      withX: function(t, x) {
        return new float32x4(x, t.y, t.z, t.w);
      },
      /**
        * @param {double} value used for y lane.
        * @return {float32x4} New instance of float32x4 with the values in t and
        * y replaced with {y}.
        */
      withY: function(t, y) {
        return new float32x4(t.x, y, t.z, t.w);
      },
      /**
        * @param {double} value used for z lane.
        * @return {float32x4} New instance of float32x4 with the values in t and
        * z replaced with {z}.
        */
      withZ: function(t, z) {
        return new float32x4(t.x, t.y, z, t.w);
      },
      /**
        * @param {double} value used for w lane.
        * @return {float32x4} New instance of float32x4 with the values in t and
        * w replaced with {w}.
        */
      withW: function(t, w) {
        return new float32x4(t.x, t.y, t.z, w);
      },
      /**
        * @param {float32x4} t An instance of float32x4.
        * @param {float32x4} other An instance of float32x4.
        * @return {int32x4} 0xFFFFFFFF or 0x0 in each lane depending on
        * the result of t < other.
        */
      lessThan: function(t, other) {
        var cx = t.x < other.x;
        var cy = t.y < other.y;
        var cz = t.z < other.z;
        var cw = t.w < other.w;
        return int32x4.bool(cx, cy, cz, cw);
      },
      /**
        * @param {float32x4} t An instance of float32x4.
        * @param {float32x4} other An instance of float32x4.
        * @return {int32x4} 0xFFFFFFFF or 0x0 in each lane depending on
        * the result of t <= other.
        */
      lessThanOrEqual: function(t, other) {
        var cx = t.x <= other.x;
        var cy = t.y <= other.y;
        var cz = t.z <= other.z;
        var cw = t.w <= other.w;
        return int32x4.bool(cx, cy, cz, cw);
      },
      /**
        * @param {float32x4} t An instance of float32x4.
        * @param {float32x4} other An instance of float32x4.
        * @return {int32x4} 0xFFFFFFFF or 0x0 in each lane depending on
        * the result of t == other.
        */
      equal: function(t, other) {
        var cx = t.x == other.x;
        var cy = t.y == other.y;
        var cz = t.z == other.z;
        var cw = t.w == other.w;
        return int32x4.bool(cx, cy, cz, cw);
      },
      /**
        * @param {float32x4} t An instance of float32x4.
        * @param {float32x4} other An instance of float32x4.
        * @return {int32x4} 0xFFFFFFFF or 0x0 in each lane depending on
        * the result of t != other.
        */
      notEqual: function(t, other) {
        var cx = t.x != other.x;
        var cy = t.y != other.y;
        var cz = t.z != other.z;
        var cw = t.w != other.w;
        return int32x4.bool(cx, cy, cz, cw);
      },
      /**
        * @param {float32x4} t An instance of float32x4.
        * @param {float32x4} other An instance of float32x4.
        * @return {int32x4} 0xFFFFFFFF or 0x0 in each lane depending on
        * the result of t >= other.
        */
      greaterThanOrEqual: function(t, other) {
        var cx = t.x >= other.x;
        var cy = t.y >= other.y;
        var cz = t.z >= other.z;
        var cw = t.w >= other.w;
        return int32x4.bool(cx, cy, cz, cw);
      },
      /**
        * @param {float32x4} t An instance of float32x4.
        * @param {float32x4} other An instance of float32x4.
        * @return {int32x4} 0xFFFFFFFF or 0x0 in each lane depending on
        * the result of t > other.
        */
      greaterThan: function(t, other) {
        var cx = t.x > other.x;
        var cy = t.y > other.y;
        var cz = t.z > other.z;
        var cw = t.w > other.w;
        return int32x4.bool(cx, cy, cz, cw);
      },
      /**
        * @param {float32x4} t An instance of float32x4.
        * @return {int32x4} a bit-wise copy of t as a int32x4.
        */
      bitsToInt32x4: function(t) {
        var alias = new Int32Array(t.storage_.buffer);
        return new int32x4(alias[0], alias[1], alias[2], alias[3]);
      },
      /**
        * @param {float32x4} t An instance of float32x4.
        * @return {int32x4} with a integer to float conversion of t.
        */
      toInt32x4: function(t) {
        var a = new int32x4(t.storage_[0], t.storage_[1], t.storage_[2],
                             t.storage_[3]);
        return a;
      }
    },
    int32x4: {
      /**
        * @param {int32x4} a An instance of int32x4.
        * @param {int32x4} b An instance of int32x4.
        * @return {int32x4} New instance of int32x4 with values of a & b.
        */
      and: function(a, b) {
        return new int32x4(a.x & b.x, a.y & b.y, a.z & b.z, a.w & b.w);
      },
      /**
        * @param {int32x4} a An instance of int32x4.
        * @param {int32x4} b An instance of int32x4.
        * @return {int32x4} New instance of int32x4 with values of a | b.
        */
      or: function(a, b) {
        return new int32x4(a.x | b.x, a.y | b.y, a.z | b.z, a.w | b.w);
      },
      /**
        * @param {int32x4} a An instance of int32x4.
        * @param {int32x4} b An instance of int32x4.
        * @return {int32x4} New instance of int32x4 with values of a ^ b.
        */
      xor: function(a, b) {
        return new int32x4(a.x ^ b.x, a.y ^ b.y, a.z ^ b.z, a.w ^ b.w);
      },
      /**
        * @param {int32x4} t An instance of int32x4.
        * @return {int32x4} New instance of int32x4 with values of ~t
        */
      not: function(t) {
        return new int32x4(~t.x, ~t.y, ~t.z, ~t.w);
      },
      /**
        * @param {int32x4} t An instance of int32x4.
        * @return {int32x4} New instance of int32x4 with values of -t
        */
      neg: function(t) {
        return new int32x4(-t.x, -t.y, -t.z, -t.w);
      },
      /**
        * @param {int32x4} a An instance of int32x4.
        * @param {int32x4} b An instance of int32x4.
        * @return {int32x4} New instance of int32x4 with values of a + b.
        */
      add: function(a, b) {
        return new int32x4(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w);
      },
      /**
        * @param {int32x4} a An instance of int32x4.
        * @param {int32x4} b An instance of int32x4.
        * @return {int32x4} New instance of int32x4 with values of a - b.
        */
      sub: function(a, b) {
        return new int32x4(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w);
      },
      /**
        * @param {int32x4} a An instance of int32x4.
        * @param {int32x4} b An instance of int32x4.
        * @return {int32x4} New instance of int32x4 with values of a * b.
        */
      mul: function(a, b) {
        return new int32x4(Math.imul(a.x, b.x), Math.imul(a.y, b.y),
                           Math.imul(a.z, b.z), Math.imul(a.w, b.w));
      },
      /**
        * @param {int32x4} t An instance of float32x4 to be shuffled.
        * @param {integer} mask One of the 256 shuffle masks, for example, SIMD.XXXX.
        * @return {int32x4} New instance of float32x4 with lanes shuffled.
        */
      shuffle: function(t, mask) {
        var _x = (mask) & 0x3;
        var _y = (mask >> 2) & 0x3;
        var _z = (mask >> 4) & 0x3;
        var _w = (mask >> 6) & 0x3;
        return new int32x4(t.storage_[_x], t.storage_[_y], t.storage_[_z],
                             t.storage_[_w]);
      },
      /**
        * @param {int32x4} t1 An instance of float32x4 to be shuffled. XY lanes in result
        * @param {int32x4} t2 An instance of float32x4 to be shuffled. ZW lanes in result
        * @param {integer} mask One of the 256 shuffle masks, for example, SIMD.XXXX.
        * @return {int32x4} New instance of float32x4 with lanes shuffled.
        */
      shuffleMix: function(t1, t2, mask) {
        var _x = (mask) & 0x3;
        var _y = (mask >> 2) & 0x3;
        var _z = (mask >> 4) & 0x3;
        var _w = (mask >> 6) & 0x3;
        return new int32x4(t1.storage_[_x], t1.storage_[_y], t2.storage_[_z],
                             t2.storage_[_w]);
      },
      /**
        * @param {float32x4}
        */
      select: function(t, trueValue, falseValue) {
        var tv = SIMD.float32x4.bitsToInt32x4(trueValue);
        var fv = SIMD.float32x4.bitsToInt32x4(falseValue);
        var tr = SIMD.int32x4.and(t, tv);
        var fr = SIMD.int32x4.and(SIMD.int32x4.not(t), fv);
        return SIMD.int32x4.bitsToFloat32x4(SIMD.int32x4.or(tr, fr));
      },
      /**
        * @param {int32x4} t An instance of int32x4.
        * @param {integer} 32-bit value used for x lane.
        * @return {int32x4} New instance of int32x4 with the values in t and
        * x lane replaced with {x}.
        */
      withX: function(t, x) {
        return new int32x4(x, t.y, t.z, t.w);
      },
      /**
        * param {int32x4} t An instance of int32x4.
        * @param {integer} 32-bit value used for y lane.
        * @return {int32x4} New instance of int32x4 with the values in t and
        * y lane replaced with {y}.
        */
      withY: function(t, y) {
        return new int32x4(t.x, y, t.z, t.w);
      },
      /**
        * @param {int32x4} t An instance of int32x4.
        * @param {integer} 32-bit value used for z lane.
        * @return {int32x4} New instance of int32x4 with the values in t and
        * z lane replaced with {z}.
        */
      withZ: function(t, z) {
        return new int32x4(t.x, t.y, z, t.w);
      },
      /**
        * @param {integer} 32-bit value used for w lane.
        * @return {int32x4} New instance of int32x4 with the values in t and
        * w lane replaced with {w}.
        */
      withW: function(t, w) {
        return new int32x4(t.x, t.y, t.z, w);
      },
      /**
        * @param {int32x4} t An instance of int32x4.
        * @param {boolean} x flag used for x lane.
        * @return {int32x4} New instance of int32x4 with the values in t and
        * x lane replaced with {x}.
        */
      withFlagX: function(t, flagX) {
        var x = flagX ? 0xFFFFFFFF : 0x0;
        return new int32x4(x, t.y, t.z, t.w);
      },
      /**
        * @param {int32x4} t An instance of int32x4.
        * @param {boolean} y flag used for y lane.
        * @return {int32x4} New instance of int32x4 with the values in t and
        * y lane replaced with {y}.
        */
      withFlagY: function(t, flagY) {
        var y = flagY ? 0xFFFFFFFF : 0x0;
        return new int32x4(t.x, y, t.z, t.w);
      },
      /**
        * @param {int32x4} t An instance of int32x4.
        * @param {boolean} z flag used for z lane.
        * @return {int32x4} New instance of int32x4 with the values in t and
        * z lane replaced with {z}.
        */
      withFlagZ: function(t, flagZ) {
        var z = flagZ ? 0xFFFFFFFF : 0x0;
        return new int32x4(t.x, t.y, z, t.w);
      },
      /**
        * @param {int32x4} t An instance of int32x4.
        * @param {boolean} w flag used for w lane.
        * @return {int32x4} New instance of int32x4 with the values in t and
        * w lane replaced with {w}.
        */
      withFlagW: function(t, flagW) {
        var w = flagW ? 0xFFFFFFFF : 0x0;
        return new int32x4(t.x, t.y, t.z, w);
      },
      /**
        * @param {int32x4} t An instance of int32x4.
        * @return {float32x4} a bit-wise copy of t as a float32x4.
        */
      bitsToFloat32x4: function(t) {
        var temp_storage = new Int32Array([t.storage_[0], t.storage_[1], t.storage_[2], t.storage_[3]]);
        var alias = new Float32Array(temp_storage.buffer);
        var fx4 = float32x4.zero();
        fx4.storage_ = alias;
        return fx4;      
      },
      /**
        * @param {int32x4} t An instance of int32x4.
        * @return {float32x4} with a float to integer conversion copy of t.
        */
      toFloat32x4: function(t) {
        var a = float32x4.zero();
        a.storage_[0] = t.storage_[0];
        a.storage_[1] = t.storage_[1];
        a.storage_[2] = t.storage_[2];
        a.storage_[3] = t.storage_[3];
        return a;
      }
    }
  }
})();

Object.defineProperty(SIMD, 'XXXX', { get: function() { return 0x0; } });
Object.defineProperty(SIMD, 'XXXY', { get: function() { return 0x40; } });
Object.defineProperty(SIMD, 'XXXZ', { get: function() { return 0x80; } });
Object.defineProperty(SIMD, 'XXXW', { get: function() { return 0xC0; } });
Object.defineProperty(SIMD, 'XXYX', { get: function() { return 0x10; } });
Object.defineProperty(SIMD, 'XXYY', { get: function() { return 0x50; } });
Object.defineProperty(SIMD, 'XXYZ', { get: function() { return 0x90; } });
Object.defineProperty(SIMD, 'XXYW', { get: function() { return 0xD0; } });
Object.defineProperty(SIMD, 'XXZX', { get: function() { return 0x20; } });
Object.defineProperty(SIMD, 'XXZY', { get: function() { return 0x60; } });
Object.defineProperty(SIMD, 'XXZZ', { get: function() { return 0xA0; } });
Object.defineProperty(SIMD, 'XXZW', { get: function() { return 0xE0; } });
Object.defineProperty(SIMD, 'XXWX', { get: function() { return 0x30; } });
Object.defineProperty(SIMD, 'XXWY', { get: function() { return 0x70; } });
Object.defineProperty(SIMD, 'XXWZ', { get: function() { return 0xB0; } });
Object.defineProperty(SIMD, 'XXWW', { get: function() { return 0xF0; } });
Object.defineProperty(SIMD, 'XYXX', { get: function() { return 0x4; } });
Object.defineProperty(SIMD, 'XYXY', { get: function() { return 0x44; } });
Object.defineProperty(SIMD, 'XYXZ', { get: function() { return 0x84; } });
Object.defineProperty(SIMD, 'XYXW', { get: function() { return 0xC4; } });
Object.defineProperty(SIMD, 'XYYX', { get: function() { return 0x14; } });
Object.defineProperty(SIMD, 'XYYY', { get: function() { return 0x54; } });
Object.defineProperty(SIMD, 'XYYZ', { get: function() { return 0x94; } });
Object.defineProperty(SIMD, 'XYYW', { get: function() { return 0xD4; } });
Object.defineProperty(SIMD, 'XYZX', { get: function() { return 0x24; } });
Object.defineProperty(SIMD, 'XYZY', { get: function() { return 0x64; } });
Object.defineProperty(SIMD, 'XYZZ', { get: function() { return 0xA4; } });
Object.defineProperty(SIMD, 'XYZW', { get: function() { return 0xE4; } });
Object.defineProperty(SIMD, 'XYWX', { get: function() { return 0x34; } });
Object.defineProperty(SIMD, 'XYWY', { get: function() { return 0x74; } });
Object.defineProperty(SIMD, 'XYWZ', { get: function() { return 0xB4; } });
Object.defineProperty(SIMD, 'XYWW', { get: function() { return 0xF4; } });
Object.defineProperty(SIMD, 'XZXX', { get: function() { return 0x8; } });
Object.defineProperty(SIMD, 'XZXY', { get: function() { return 0x48; } });
Object.defineProperty(SIMD, 'XZXZ', { get: function() { return 0x88; } });
Object.defineProperty(SIMD, 'XZXW', { get: function() { return 0xC8; } });
Object.defineProperty(SIMD, 'XZYX', { get: function() { return 0x18; } });
Object.defineProperty(SIMD, 'XZYY', { get: function() { return 0x58; } });
Object.defineProperty(SIMD, 'XZYZ', { get: function() { return 0x98; } });
Object.defineProperty(SIMD, 'XZYW', { get: function() { return 0xD8; } });
Object.defineProperty(SIMD, 'XZZX', { get: function() { return 0x28; } });
Object.defineProperty(SIMD, 'XZZY', { get: function() { return 0x68; } });
Object.defineProperty(SIMD, 'XZZZ', { get: function() { return 0xA8; } });
Object.defineProperty(SIMD, 'XZZW', { get: function() { return 0xE8; } });
Object.defineProperty(SIMD, 'XZWX', { get: function() { return 0x38; } });
Object.defineProperty(SIMD, 'XZWY', { get: function() { return 0x78; } });
Object.defineProperty(SIMD, 'XZWZ', { get: function() { return 0xB8; } });
Object.defineProperty(SIMD, 'XZWW', { get: function() { return 0xF8; } });
Object.defineProperty(SIMD, 'XWXX', { get: function() { return 0xC; } });
Object.defineProperty(SIMD, 'XWXY', { get: function() { return 0x4C; } });
Object.defineProperty(SIMD, 'XWXZ', { get: function() { return 0x8C; } });
Object.defineProperty(SIMD, 'XWXW', { get: function() { return 0xCC; } });
Object.defineProperty(SIMD, 'XWYX', { get: function() { return 0x1C; } });
Object.defineProperty(SIMD, 'XWYY', { get: function() { return 0x5C; } });
Object.defineProperty(SIMD, 'XWYZ', { get: function() { return 0x9C; } });
Object.defineProperty(SIMD, 'XWYW', { get: function() { return 0xDC; } });
Object.defineProperty(SIMD, 'XWZX', { get: function() { return 0x2C; } });
Object.defineProperty(SIMD, 'XWZY', { get: function() { return 0x6C; } });
Object.defineProperty(SIMD, 'XWZZ', { get: function() { return 0xAC; } });
Object.defineProperty(SIMD, 'XWZW', { get: function() { return 0xEC; } });
Object.defineProperty(SIMD, 'XWWX', { get: function() { return 0x3C; } });
Object.defineProperty(SIMD, 'XWWY', { get: function() { return 0x7C; } });
Object.defineProperty(SIMD, 'XWWZ', { get: function() { return 0xBC; } });
Object.defineProperty(SIMD, 'XWWW', { get: function() { return 0xFC; } });
Object.defineProperty(SIMD, 'YXXX', { get: function() { return 0x1; } });
Object.defineProperty(SIMD, 'YXXY', { get: function() { return 0x41; } });
Object.defineProperty(SIMD, 'YXXZ', { get: function() { return 0x81; } });
Object.defineProperty(SIMD, 'YXXW', { get: function() { return 0xC1; } });
Object.defineProperty(SIMD, 'YXYX', { get: function() { return 0x11; } });
Object.defineProperty(SIMD, 'YXYY', { get: function() { return 0x51; } });
Object.defineProperty(SIMD, 'YXYZ', { get: function() { return 0x91; } });
Object.defineProperty(SIMD, 'YXYW', { get: function() { return 0xD1; } });
Object.defineProperty(SIMD, 'YXZX', { get: function() { return 0x21; } });
Object.defineProperty(SIMD, 'YXZY', { get: function() { return 0x61; } });
Object.defineProperty(SIMD, 'YXZZ', { get: function() { return 0xA1; } });
Object.defineProperty(SIMD, 'YXZW', { get: function() { return 0xE1; } });
Object.defineProperty(SIMD, 'YXWX', { get: function() { return 0x31; } });
Object.defineProperty(SIMD, 'YXWY', { get: function() { return 0x71; } });
Object.defineProperty(SIMD, 'YXWZ', { get: function() { return 0xB1; } });
Object.defineProperty(SIMD, 'YXWW', { get: function() { return 0xF1; } });
Object.defineProperty(SIMD, 'YYXX', { get: function() { return 0x5; } });
Object.defineProperty(SIMD, 'YYXY', { get: function() { return 0x45; } });
Object.defineProperty(SIMD, 'YYXZ', { get: function() { return 0x85; } });
Object.defineProperty(SIMD, 'YYXW', { get: function() { return 0xC5; } });
Object.defineProperty(SIMD, 'YYYX', { get: function() { return 0x15; } });
Object.defineProperty(SIMD, 'YYYY', { get: function() { return 0x55; } });
Object.defineProperty(SIMD, 'YYYZ', { get: function() { return 0x95; } });
Object.defineProperty(SIMD, 'YYYW', { get: function() { return 0xD5; } });
Object.defineProperty(SIMD, 'YYZX', { get: function() { return 0x25; } });
Object.defineProperty(SIMD, 'YYZY', { get: function() { return 0x65; } });
Object.defineProperty(SIMD, 'YYZZ', { get: function() { return 0xA5; } });
Object.defineProperty(SIMD, 'YYZW', { get: function() { return 0xE5; } });
Object.defineProperty(SIMD, 'YYWX', { get: function() { return 0x35; } });
Object.defineProperty(SIMD, 'YYWY', { get: function() { return 0x75; } });
Object.defineProperty(SIMD, 'YYWZ', { get: function() { return 0xB5; } });
Object.defineProperty(SIMD, 'YYWW', { get: function() { return 0xF5; } });
Object.defineProperty(SIMD, 'YZXX', { get: function() { return 0x9; } });
Object.defineProperty(SIMD, 'YZXY', { get: function() { return 0x49; } });
Object.defineProperty(SIMD, 'YZXZ', { get: function() { return 0x89; } });
Object.defineProperty(SIMD, 'YZXW', { get: function() { return 0xC9; } });
Object.defineProperty(SIMD, 'YZYX', { get: function() { return 0x19; } });
Object.defineProperty(SIMD, 'YZYY', { get: function() { return 0x59; } });
Object.defineProperty(SIMD, 'YZYZ', { get: function() { return 0x99; } });
Object.defineProperty(SIMD, 'YZYW', { get: function() { return 0xD9; } });
Object.defineProperty(SIMD, 'YZZX', { get: function() { return 0x29; } });
Object.defineProperty(SIMD, 'YZZY', { get: function() { return 0x69; } });
Object.defineProperty(SIMD, 'YZZZ', { get: function() { return 0xA9; } });
Object.defineProperty(SIMD, 'YZZW', { get: function() { return 0xE9; } });
Object.defineProperty(SIMD, 'YZWX', { get: function() { return 0x39; } });
Object.defineProperty(SIMD, 'YZWY', { get: function() { return 0x79; } });
Object.defineProperty(SIMD, 'YZWZ', { get: function() { return 0xB9; } });
Object.defineProperty(SIMD, 'YZWW', { get: function() { return 0xF9; } });
Object.defineProperty(SIMD, 'YWXX', { get: function() { return 0xD; } });
Object.defineProperty(SIMD, 'YWXY', { get: function() { return 0x4D; } });
Object.defineProperty(SIMD, 'YWXZ', { get: function() { return 0x8D; } });
Object.defineProperty(SIMD, 'YWXW', { get: function() { return 0xCD; } });
Object.defineProperty(SIMD, 'YWYX', { get: function() { return 0x1D; } });
Object.defineProperty(SIMD, 'YWYY', { get: function() { return 0x5D; } });
Object.defineProperty(SIMD, 'YWYZ', { get: function() { return 0x9D; } });
Object.defineProperty(SIMD, 'YWYW', { get: function() { return 0xDD; } });
Object.defineProperty(SIMD, 'YWZX', { get: function() { return 0x2D; } });
Object.defineProperty(SIMD, 'YWZY', { get: function() { return 0x6D; } });
Object.defineProperty(SIMD, 'YWZZ', { get: function() { return 0xAD; } });
Object.defineProperty(SIMD, 'YWZW', { get: function() { return 0xED; } });
Object.defineProperty(SIMD, 'YWWX', { get: function() { return 0x3D; } });
Object.defineProperty(SIMD, 'YWWY', { get: function() { return 0x7D; } });
Object.defineProperty(SIMD, 'YWWZ', { get: function() { return 0xBD; } });
Object.defineProperty(SIMD, 'YWWW', { get: function() { return 0xFD; } });
Object.defineProperty(SIMD, 'ZXXX', { get: function() { return 0x2; } });
Object.defineProperty(SIMD, 'ZXXY', { get: function() { return 0x42; } });
Object.defineProperty(SIMD, 'ZXXZ', { get: function() { return 0x82; } });
Object.defineProperty(SIMD, 'ZXXW', { get: function() { return 0xC2; } });
Object.defineProperty(SIMD, 'ZXYX', { get: function() { return 0x12; } });
Object.defineProperty(SIMD, 'ZXYY', { get: function() { return 0x52; } });
Object.defineProperty(SIMD, 'ZXYZ', { get: function() { return 0x92; } });
Object.defineProperty(SIMD, 'ZXYW', { get: function() { return 0xD2; } });
Object.defineProperty(SIMD, 'ZXZX', { get: function() { return 0x22; } });
Object.defineProperty(SIMD, 'ZXZY', { get: function() { return 0x62; } });
Object.defineProperty(SIMD, 'ZXZZ', { get: function() { return 0xA2; } });
Object.defineProperty(SIMD, 'ZXZW', { get: function() { return 0xE2; } });
Object.defineProperty(SIMD, 'ZXWX', { get: function() { return 0x32; } });
Object.defineProperty(SIMD, 'ZXWY', { get: function() { return 0x72; } });
Object.defineProperty(SIMD, 'ZXWZ', { get: function() { return 0xB2; } });
Object.defineProperty(SIMD, 'ZXWW', { get: function() { return 0xF2; } });
Object.defineProperty(SIMD, 'ZYXX', { get: function() { return 0x6; } });
Object.defineProperty(SIMD, 'ZYXY', { get: function() { return 0x46; } });
Object.defineProperty(SIMD, 'ZYXZ', { get: function() { return 0x86; } });
Object.defineProperty(SIMD, 'ZYXW', { get: function() { return 0xC6; } });
Object.defineProperty(SIMD, 'ZYYX', { get: function() { return 0x16; } });
Object.defineProperty(SIMD, 'ZYYY', { get: function() { return 0x56; } });
Object.defineProperty(SIMD, 'ZYYZ', { get: function() { return 0x96; } });
Object.defineProperty(SIMD, 'ZYYW', { get: function() { return 0xD6; } });
Object.defineProperty(SIMD, 'ZYZX', { get: function() { return 0x26; } });
Object.defineProperty(SIMD, 'ZYZY', { get: function() { return 0x66; } });
Object.defineProperty(SIMD, 'ZYZZ', { get: function() { return 0xA6; } });
Object.defineProperty(SIMD, 'ZYZW', { get: function() { return 0xE6; } });
Object.defineProperty(SIMD, 'ZYWX', { get: function() { return 0x36; } });
Object.defineProperty(SIMD, 'ZYWY', { get: function() { return 0x76; } });
Object.defineProperty(SIMD, 'ZYWZ', { get: function() { return 0xB6; } });
Object.defineProperty(SIMD, 'ZYWW', { get: function() { return 0xF6; } });
Object.defineProperty(SIMD, 'ZZXX', { get: function() { return 0xA; } });
Object.defineProperty(SIMD, 'ZZXY', { get: function() { return 0x4A; } });
Object.defineProperty(SIMD, 'ZZXZ', { get: function() { return 0x8A; } });
Object.defineProperty(SIMD, 'ZZXW', { get: function() { return 0xCA; } });
Object.defineProperty(SIMD, 'ZZYX', { get: function() { return 0x1A; } });
Object.defineProperty(SIMD, 'ZZYY', { get: function() { return 0x5A; } });
Object.defineProperty(SIMD, 'ZZYZ', { get: function() { return 0x9A; } });
Object.defineProperty(SIMD, 'ZZYW', { get: function() { return 0xDA; } });
Object.defineProperty(SIMD, 'ZZZX', { get: function() { return 0x2A; } });
Object.defineProperty(SIMD, 'ZZZY', { get: function() { return 0x6A; } });
Object.defineProperty(SIMD, 'ZZZZ', { get: function() { return 0xAA; } });
Object.defineProperty(SIMD, 'ZZZW', { get: function() { return 0xEA; } });
Object.defineProperty(SIMD, 'ZZWX', { get: function() { return 0x3A; } });
Object.defineProperty(SIMD, 'ZZWY', { get: function() { return 0x7A; } });
Object.defineProperty(SIMD, 'ZZWZ', { get: function() { return 0xBA; } });
Object.defineProperty(SIMD, 'ZZWW', { get: function() { return 0xFA; } });
Object.defineProperty(SIMD, 'ZWXX', { get: function() { return 0xE; } });
Object.defineProperty(SIMD, 'ZWXY', { get: function() { return 0x4E; } });
Object.defineProperty(SIMD, 'ZWXZ', { get: function() { return 0x8E; } });
Object.defineProperty(SIMD, 'ZWXW', { get: function() { return 0xCE; } });
Object.defineProperty(SIMD, 'ZWYX', { get: function() { return 0x1E; } });
Object.defineProperty(SIMD, 'ZWYY', { get: function() { return 0x5E; } });
Object.defineProperty(SIMD, 'ZWYZ', { get: function() { return 0x9E; } });
Object.defineProperty(SIMD, 'ZWYW', { get: function() { return 0xDE; } });
Object.defineProperty(SIMD, 'ZWZX', { get: function() { return 0x2E; } });
Object.defineProperty(SIMD, 'ZWZY', { get: function() { return 0x6E; } });
Object.defineProperty(SIMD, 'ZWZZ', { get: function() { return 0xAE; } });
Object.defineProperty(SIMD, 'ZWZW', { get: function() { return 0xEE; } });
Object.defineProperty(SIMD, 'ZWWX', { get: function() { return 0x3E; } });
Object.defineProperty(SIMD, 'ZWWY', { get: function() { return 0x7E; } });
Object.defineProperty(SIMD, 'ZWWZ', { get: function() { return 0xBE; } });
Object.defineProperty(SIMD, 'ZWWW', { get: function() { return 0xFE; } });
Object.defineProperty(SIMD, 'WXXX', { get: function() { return 0x3; } });
Object.defineProperty(SIMD, 'WXXY', { get: function() { return 0x43; } });
Object.defineProperty(SIMD, 'WXXZ', { get: function() { return 0x83; } });
Object.defineProperty(SIMD, 'WXXW', { get: function() { return 0xC3; } });
Object.defineProperty(SIMD, 'WXYX', { get: function() { return 0x13; } });
Object.defineProperty(SIMD, 'WXYY', { get: function() { return 0x53; } });
Object.defineProperty(SIMD, 'WXYZ', { get: function() { return 0x93; } });
Object.defineProperty(SIMD, 'WXYW', { get: function() { return 0xD3; } });
Object.defineProperty(SIMD, 'WXZX', { get: function() { return 0x23; } });
Object.defineProperty(SIMD, 'WXZY', { get: function() { return 0x63; } });
Object.defineProperty(SIMD, 'WXZZ', { get: function() { return 0xA3; } });
Object.defineProperty(SIMD, 'WXZW', { get: function() { return 0xE3; } });
Object.defineProperty(SIMD, 'WXWX', { get: function() { return 0x33; } });
Object.defineProperty(SIMD, 'WXWY', { get: function() { return 0x73; } });
Object.defineProperty(SIMD, 'WXWZ', { get: function() { return 0xB3; } });
Object.defineProperty(SIMD, 'WXWW', { get: function() { return 0xF3; } });
Object.defineProperty(SIMD, 'WYXX', { get: function() { return 0x7; } });
Object.defineProperty(SIMD, 'WYXY', { get: function() { return 0x47; } });
Object.defineProperty(SIMD, 'WYXZ', { get: function() { return 0x87; } });
Object.defineProperty(SIMD, 'WYXW', { get: function() { return 0xC7; } });
Object.defineProperty(SIMD, 'WYYX', { get: function() { return 0x17; } });
Object.defineProperty(SIMD, 'WYYY', { get: function() { return 0x57; } });
Object.defineProperty(SIMD, 'WYYZ', { get: function() { return 0x97; } });
Object.defineProperty(SIMD, 'WYYW', { get: function() { return 0xD7; } });
Object.defineProperty(SIMD, 'WYZX', { get: function() { return 0x27; } });
Object.defineProperty(SIMD, 'WYZY', { get: function() { return 0x67; } });
Object.defineProperty(SIMD, 'WYZZ', { get: function() { return 0xA7; } });
Object.defineProperty(SIMD, 'WYZW', { get: function() { return 0xE7; } });
Object.defineProperty(SIMD, 'WYWX', { get: function() { return 0x37; } });
Object.defineProperty(SIMD, 'WYWY', { get: function() { return 0x77; } });
Object.defineProperty(SIMD, 'WYWZ', { get: function() { return 0xB7; } });
Object.defineProperty(SIMD, 'WYWW', { get: function() { return 0xF7; } });
Object.defineProperty(SIMD, 'WZXX', { get: function() { return 0xB; } });
Object.defineProperty(SIMD, 'WZXY', { get: function() { return 0x4B; } });
Object.defineProperty(SIMD, 'WZXZ', { get: function() { return 0x8B; } });
Object.defineProperty(SIMD, 'WZXW', { get: function() { return 0xCB; } });
Object.defineProperty(SIMD, 'WZYX', { get: function() { return 0x1B; } });
Object.defineProperty(SIMD, 'WZYY', { get: function() { return 0x5B; } });
Object.defineProperty(SIMD, 'WZYZ', { get: function() { return 0x9B; } });
Object.defineProperty(SIMD, 'WZYW', { get: function() { return 0xDB; } });
Object.defineProperty(SIMD, 'WZZX', { get: function() { return 0x2B; } });
Object.defineProperty(SIMD, 'WZZY', { get: function() { return 0x6B; } });
Object.defineProperty(SIMD, 'WZZZ', { get: function() { return 0xAB; } });
Object.defineProperty(SIMD, 'WZZW', { get: function() { return 0xEB; } });
Object.defineProperty(SIMD, 'WZWX', { get: function() { return 0x3B; } });
Object.defineProperty(SIMD, 'WZWY', { get: function() { return 0x7B; } });
Object.defineProperty(SIMD, 'WZWZ', { get: function() { return 0xBB; } });
Object.defineProperty(SIMD, 'WZWW', { get: function() { return 0xFB; } });
Object.defineProperty(SIMD, 'WWXX', { get: function() { return 0xF; } });
Object.defineProperty(SIMD, 'WWXY', { get: function() { return 0x4F; } });
Object.defineProperty(SIMD, 'WWXZ', { get: function() { return 0x8F; } });
Object.defineProperty(SIMD, 'WWXW', { get: function() { return 0xCF; } });
Object.defineProperty(SIMD, 'WWYX', { get: function() { return 0x1F; } });
Object.defineProperty(SIMD, 'WWYY', { get: function() { return 0x5F; } });
Object.defineProperty(SIMD, 'WWYZ', { get: function() { return 0x9F; } });
Object.defineProperty(SIMD, 'WWYW', { get: function() { return 0xDF; } });
Object.defineProperty(SIMD, 'WWZX', { get: function() { return 0x2F; } });
Object.defineProperty(SIMD, 'WWZY', { get: function() { return 0x6F; } });
Object.defineProperty(SIMD, 'WWZZ', { get: function() { return 0xAF; } });
Object.defineProperty(SIMD, 'WWZW', { get: function() { return 0xEF; } });
Object.defineProperty(SIMD, 'WWWX', { get: function() { return 0x3F; } });
Object.defineProperty(SIMD, 'WWWY', { get: function() { return 0x7F; } });
Object.defineProperty(SIMD, 'WWWZ', { get: function() { return 0xBF; } });
Object.defineProperty(SIMD, 'WWWW', { get: function() { return 0xFF; } });


// === Auto-generated postamble setup entry stuff ===

if (memoryInitializer) {
  function applyData(data) {
    HEAPU8.set(data, STATIC_BASE);
  }
  if (ENVIRONMENT_IS_NODE || ENVIRONMENT_IS_SHELL) {
    applyData(Module['readBinary'](memoryInitializer));
  } else {
    addRunDependency('memory initializer');
    Browser.asyncLoad(memoryInitializer, function(data) {
      applyData(data);
      removeRunDependency('memory initializer');
    }, function(data) {
      throw 'could not load memory initializer ' + memoryInitializer;
    });
  }
}

function ExitStatus(status) {
  this.name = "ExitStatus";
  this.message = "Program terminated with exit(" + status + ")";
  this.status = status;
};
ExitStatus.prototype = new Error();
ExitStatus.prototype.constructor = ExitStatus;

var initialStackTop;
var preloadStartTime = null;
var calledMain = false;

dependenciesFulfilled = function runCaller() {
  // If run has never been called, and we should call run (INVOKE_RUN is true, and Module.noInitialRun is not false)
  if (!Module['calledRun'] && shouldRunNow) run();
  if (!Module['calledRun']) dependenciesFulfilled = runCaller; // try this again later, after new deps are fulfilled
}

Module['callMain'] = Module.callMain = function callMain(args) {
  assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on __ATMAIN__)');
  assert(__ATPRERUN__.length == 0, 'cannot call main when preRun functions remain to be called');

  args = args || [];

  if (ENVIRONMENT_IS_WEB && preloadStartTime !== null) {
    Module.printErr('preload time: ' + (Date.now() - preloadStartTime) + ' ms');
  }

  ensureInitRuntime();

  var argc = args.length+1;
  function pad() {
    for (var i = 0; i < 4-1; i++) {
      argv.push(0);
    }
  }
  var argv = [allocate(intArrayFromString("/bin/this.program"), 'i8', ALLOC_NORMAL) ];
  pad();
  for (var i = 0; i < argc-1; i = i + 1) {
    argv.push(allocate(intArrayFromString(args[i]), 'i8', ALLOC_NORMAL));
    pad();
  }
  argv.push(0);
  argv = allocate(argv, 'i32', ALLOC_NORMAL);

  initialStackTop = STACKTOP;

  try {

    var ret = Module['_main'](argc, argv, 0);


    // if we're not running an evented main loop, it's time to exit
    if (!Module['noExitRuntime']) {
      exit(ret);
    }
  }
  catch(e) {
    if (e instanceof ExitStatus) {
      // exit() throws this once it's done to make sure execution
      // has been stopped completely
      return;
    } else if (e == 'SimulateInfiniteLoop') {
      // running an evented main loop, don't immediately exit
      Module['noExitRuntime'] = true;
      return;
    } else {
      if (e && typeof e === 'object' && e.stack) Module.printErr('exception thrown: ' + [e, e.stack]);
      throw e;
    }
  } finally {
    calledMain = true;
  }
}




function run(args) {
  args = args || Module['arguments'];

  if (preloadStartTime === null) preloadStartTime = Date.now();

  if (runDependencies > 0) {
    Module.printErr('run() called, but dependencies remain, so not running');
    return;
  }

  preRun();

  if (runDependencies > 0) return; // a preRun added a dependency, run will be called later
  if (Module['calledRun']) return; // run may have just been called through dependencies being fulfilled just in this very frame

  function doRun() {
    if (Module['calledRun']) return; // run may have just been called while the async setStatus time below was happening
    Module['calledRun'] = true;

    ensureInitRuntime();

    preMain();

    if (Module['_main'] && shouldRunNow) {
      Module['callMain'](args);
    }

    postRun();
  }

  if (Module['setStatus']) {
    Module['setStatus']('Running...');
    setTimeout(function() {
      setTimeout(function() {
        Module['setStatus']('');
      }, 1);
      if (!ABORT) doRun();
    }, 1);
  } else {
    doRun();
  }
}
Module['run'] = Module.run = run;

function exit(status) {
  ABORT = true;
  EXITSTATUS = status;
  STACKTOP = initialStackTop;

  // exit the runtime
  exitRuntime();

  // TODO We should handle this differently based on environment.
  // In the browser, the best we can do is throw an exception
  // to halt execution, but in node we could process.exit and
  // I'd imagine SM shell would have something equivalent.
  // This would let us set a proper exit status (which
  // would be great for checking test exit statuses).
  // https://github.com/kripken/emscripten/issues/1371

  // throw an exception to halt the current execution
  throw new ExitStatus(status);
}
Module['exit'] = Module.exit = exit;

function abort(text) {
  if (text) {
    Module.print(text);
    Module.printErr(text);
  }

  ABORT = true;
  EXITSTATUS = 1;

  throw 'abort() at ' + stackTrace();
}
Module['abort'] = Module.abort = abort;

// {{PRE_RUN_ADDITIONS}}
/*global Module*/
/*global _malloc, _free, _memcpy*/
/*global FUNCTION_TABLE, HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32*/
/*global readLatin1String*/
/*global __emval_register, _emval_handle_array, __emval_decref*/
/*global ___getTypeName*/
/*jslint sub:true*/ /* The symbols 'fromWireType' and 'toWireType' must be accessed via array notation to be closure-safe since craftInvokerFunction crafts functions as strings that can't be closured. */
var InternalError = Module['InternalError'] = extendError(Error, 'InternalError');
var BindingError = Module['BindingError'] = extendError(Error, 'BindingError');
var UnboundTypeError = Module['UnboundTypeError'] = extendError(BindingError, 'UnboundTypeError');

function throwInternalError(message) {
    throw new InternalError(message);
}

function throwBindingError(message) {
    throw new BindingError(message);
}

function throwUnboundTypeError(message, types) {
    var unboundTypes = [];
    var seen = {};
    function visit(type) {
        if (seen[type]) {
            return;
        }
        if (registeredTypes[type]) {
            return;
        }
        if (typeDependencies[type]) {
            typeDependencies[type].forEach(visit);
            return;
        }
        unboundTypes.push(type);
        seen[type] = true;
    }
    types.forEach(visit);
    
    throw new UnboundTypeError(message + ': ' + unboundTypes.map(getTypeName).join([', ']));
}

// Creates a function overload resolution table to the given method 'methodName' in the given prototype,
// if the overload table doesn't yet exist.
function ensureOverloadTable(proto, methodName, humanName) {
    if (undefined === proto[methodName].overloadTable) {
        var prevFunc = proto[methodName];
        // Inject an overload resolver function that routes to the appropriate overload based on the number of arguments.
        proto[methodName] = function() {
            // TODO This check can be removed in -O3 level "unsafe" optimizations.
            if (!proto[methodName].overloadTable.hasOwnProperty(arguments.length)) {
                throwBindingError("Function '" + humanName + "' called with an invalid number of arguments (" + arguments.length + ") - expects one of (" + proto[methodName].overloadTable + ")!");
            }
            return proto[methodName].overloadTable[arguments.length].apply(this, arguments);
        };
        // Move the previous function into the overload table.
        proto[methodName].overloadTable = [];
        proto[methodName].overloadTable[prevFunc.argCount] = prevFunc;
    }            
}

/* Registers a symbol (function, class, enum, ...) as part of the Module JS object so that
   hand-written code is able to access that symbol via 'Module.name'.
   name: The name of the symbol that's being exposed.
   value: The object itself to expose (function, class, ...)
   numArguments: For functions, specifies the number of arguments the function takes in. For other types, unused and undefined.

   To implement support for multiple overloads of a function, an 'overload selector' function is used. That selector function chooses
   the appropriate overload to call from an function overload table. This selector function is only used if multiple overloads are
   actually registered, since it carries a slight performance penalty. */
function exposePublicSymbol(name, value, numArguments) {
    if (Module.hasOwnProperty(name)) {
        if (undefined === numArguments || (undefined !== Module[name].overloadTable && undefined !== Module[name].overloadTable[numArguments])) {
            throwBindingError("Cannot register public name '" + name + "' twice");
        }
        
        // We are exposing a function with the same name as an existing function. Create an overload table and a function selector
        // that routes between the two.
        ensureOverloadTable(Module, name, name);
        if (Module.hasOwnProperty(numArguments)) {
            throwBindingError("Cannot register multiple overloads of a function with the same number of arguments (" + numArguments + ")!");
        }
        // Add the new function into the overload table.
        Module[name].overloadTable[numArguments] = value;
    }
    else {
        Module[name] = value;
        if (undefined !== numArguments) {
            Module[name].numArguments = numArguments;
        }
    }
}

function replacePublicSymbol(name, value, numArguments) {
    if (!Module.hasOwnProperty(name)) {
        throwInternalError('Replacing nonexistant public symbol');
    }
    // If there's an overload table for this symbol, replace the symbol in the overload table instead.
    if (undefined !== Module[name].overloadTable && undefined !== numArguments) {
        Module[name].overloadTable[numArguments] = value;
    }
    else {
        Module[name] = value;
    }
}

// from https://github.com/imvu/imvujs/blob/master/src/error.js
function extendError(baseErrorType, errorName) {
    var errorClass = createNamedFunction(errorName, function(message) {
        this.name = errorName;
        this.message = message;

        var stack = (new Error(message)).stack;
        if (stack !== undefined) {
            this.stack = this.toString() + '\n' +
                stack.replace(/^Error(:[^\n]*)?\n/, '');
        }
    });
    errorClass.prototype = Object.create(baseErrorType.prototype);
    errorClass.prototype.constructor = errorClass;
    errorClass.prototype.toString = function() {
        if (this.message === undefined) {
            return this.name;
        } else {
            return this.name + ': ' + this.message;
        }
    };

    return errorClass;
}


// from https://github.com/imvu/imvujs/blob/master/src/function.js
function createNamedFunction(name, body) {
    name = makeLegalFunctionName(name);
    /*jshint evil:true*/
    return new Function(
        "body",
        "return function " + name + "() {\n" +
        "    \"use strict\";" +
        "    return body.apply(this, arguments);\n" +
        "};\n"
    )(body);
}

function _embind_repr(v) {
    var t = typeof v;
    if (t === 'object' || t === 'array' || t === 'function') {
        return v.toString();
    } else {
        return '' + v;
    }
}

// typeID -> { toWireType: ..., fromWireType: ... }
var registeredTypes = {};

// typeID -> [callback]
var awaitingDependencies = {};

// typeID -> [dependentTypes]
var typeDependencies = {};

// class typeID -> {pointerType: ..., constPointerType: ...}
var registeredPointers = {};

function registerType(rawType, registeredInstance) {
    var name = registeredInstance.name;
    if (!rawType) {
        throwBindingError('type "' + name + '" must have a positive integer typeid pointer');
    }
    if (registeredTypes.hasOwnProperty(rawType)) {
        throwBindingError("Cannot register type '" + name + "' twice");
    }

    registeredTypes[rawType] = registeredInstance;
    delete typeDependencies[rawType];

    if (awaitingDependencies.hasOwnProperty(rawType)) {
        var callbacks = awaitingDependencies[rawType];
        delete awaitingDependencies[rawType];
        callbacks.forEach(function(cb) {
            cb();
        });
    }
}

function whenDependentTypesAreResolved(myTypes, dependentTypes, getTypeConverters) {
    myTypes.forEach(function(type) {
        typeDependencies[type] = dependentTypes;
    });

    function onComplete(typeConverters) {
        var myTypeConverters = getTypeConverters(typeConverters);
        if (myTypeConverters.length !== myTypes.length) {
            throwInternalError('Mismatched type converter count');
        }
        for (var i = 0; i < myTypes.length; ++i) {
            registerType(myTypes[i], myTypeConverters[i]);
        }
    }

    var typeConverters = new Array(dependentTypes.length);
    var unregisteredTypes = [];
    var registered = 0;
    dependentTypes.forEach(function(dt, i) {
        if (registeredTypes.hasOwnProperty(dt)) {
            typeConverters[i] = registeredTypes[dt];
        } else {
            unregisteredTypes.push(dt);
            if (!awaitingDependencies.hasOwnProperty(dt)) {
                awaitingDependencies[dt] = [];
            }
            awaitingDependencies[dt].push(function() {
                typeConverters[i] = registeredTypes[dt];
                ++registered;
                if (registered === unregisteredTypes.length) {
                    onComplete(typeConverters);
                }
            });
        }
    });
    if (0 === unregisteredTypes.length) {
        onComplete(typeConverters);
    }
}

var __charCodes = (function() {
    var codes = new Array(256);
    for (var i = 0; i < 256; ++i) {
        codes[i] = String.fromCharCode(i);
    }
    return codes;
})();

function readLatin1String(ptr) {
    var ret = "";
    var c = ptr;
    while (HEAPU8[c]) {
        ret += __charCodes[HEAPU8[c++]];
    }
    return ret;
}

function getTypeName(type) {
    var ptr = ___getTypeName(type);
    var rv = readLatin1String(ptr);
    _free(ptr);
    return rv;
}

function heap32VectorToArray(count, firstElement) {
    var array = [];
    for (var i = 0; i < count; i++) {
        array.push(HEAP32[(firstElement >> 2) + i]);
    }
    return array;
}

function requireRegisteredType(rawType, humanName) {
    var impl = registeredTypes[rawType];
    if (undefined === impl) {
        throwBindingError(humanName + " has unknown type " + getTypeName(rawType));
    }
    return impl;
}

function __embind_register_void(rawType, name) {
    name = readLatin1String(name);
    registerType(rawType, {
        name: name,
        'fromWireType': function() {
            return undefined;
        },
        'toWireType': function(destructors, o) {
            // TODO: assert if anything else is given?
            return undefined;
        },
    });
}

function __embind_register_bool(rawType, name, trueValue, falseValue) {
    name = readLatin1String(name);
    registerType(rawType, {
        name: name,
        'fromWireType': function(wt) {
            // ambiguous emscripten ABI: sometimes return values are
            // true or false, and sometimes integers (0 or 1)
            return !!wt;
        },
        'toWireType': function(destructors, o) {
            return o ? trueValue : falseValue;
        },
        destructorFunction: null, // This type does not need a destructor
    });
}

// When converting a number from JS to C++ side, the valid range of the number is
// [minRange, maxRange], inclusive.
function __embind_register_integer(primitiveType, name, minRange, maxRange) {
    name = readLatin1String(name);
    if (maxRange === -1) { // LLVM doesn't have signed and unsigned 32-bit types, so u32 literals come out as 'i32 -1'. Always treat those as max u32.
        maxRange = 4294967295;
    }
    registerType(primitiveType, {
        name: name,
        minRange: minRange,
        maxRange: maxRange,
        'fromWireType': function(value) {
            return value;
        },
        'toWireType': function(destructors, value) {
            // todo: Here we have an opportunity for -O3 level "unsafe" optimizations: we could
            // avoid the following two if()s and assume value is of proper type.
            if (typeof value !== "number" && typeof value !== "boolean") {
                throw new TypeError('Cannot convert "' + _embind_repr(value) + '" to ' + this.name);
            }
            if (value < minRange || value > maxRange) {
                throw new TypeError('Passing a number "' + _embind_repr(value) + '" from JS side to C/C++ side to an argument of type "' + name + '", which is outside the valid range [' + minRange + ', ' + maxRange + ']!');
            }
            return value | 0;
        },
        destructorFunction: null, // This type does not need a destructor
    });
}

function __embind_register_float(rawType, name) {
    name = readLatin1String(name);
    registerType(rawType, {
        name: name,
        'fromWireType': function(value) {
            return value;
        },
        'toWireType': function(destructors, value) {
            // todo: Here we have an opportunity for -O3 level "unsafe" optimizations: we could
            // avoid the following if() and assume value is of proper type.
            if (typeof value !== "number" && typeof value !== "boolean") {
                throw new TypeError('Cannot convert "' + _embind_repr(value) + '" to ' + this.name);
            }
            return value;
        },
        destructorFunction: null, // This type does not need a destructor
    });
}

function __embind_register_std_string(rawType, name) {
    name = readLatin1String(name);
    registerType(rawType, {
        name: name,
        'fromWireType': function(value) {
            var length = HEAPU32[value >> 2];
            var a = new Array(length);
            for (var i = 0; i < length; ++i) {
                a[i] = String.fromCharCode(HEAPU8[value + 4 + i]);
            }
            _free(value);
            return a.join('');
        },
        'toWireType': function(destructors, value) {
            if (value instanceof ArrayBuffer) {
                value = new Uint8Array(value);
            }

            function getTAElement(ta, index) {
                return ta[index];
            }
            function getStringElement(string, index) {
                return string.charCodeAt(index);
            }
            var getElement;
            if (value instanceof Uint8Array) {
                getElement = getTAElement;
            } else if (value instanceof Int8Array) {
                getElement = getTAElement;
            } else if (typeof value === 'string') {
                getElement = getStringElement;
            } else {
                throwBindingError('Cannot pass non-string to std::string');
            }

            // assumes 4-byte alignment
            var length = value.length;
            var ptr = _malloc(4 + length);
            HEAPU32[ptr >> 2] = length;
            for (var i = 0; i < length; ++i) {
                var charCode = getElement(value, i);
                if (charCode > 255) {
                    _free(ptr);
                    throwBindingError('String has UTF-16 code units that do not fit in 8 bits');
                }
                HEAPU8[ptr + 4 + i] = charCode;
            }
            if (destructors !== null) {
                destructors.push(_free, ptr);
            }
            return ptr;
        },
        destructorFunction: function(ptr) { _free(ptr); },
    });
}

function __embind_register_std_wstring(rawType, charSize, name) {
    name = readLatin1String(name);
    var HEAP, shift;
    if (charSize === 2) {
        HEAP = HEAPU16;
        shift = 1;
    } else if (charSize === 4) {
        HEAP = HEAPU32;
        shift = 2;
    }
    registerType(rawType, {
        name: name,
        'fromWireType': function(value) {
            var length = HEAPU32[value >> 2];
            var a = new Array(length);
            var start = (value + 4) >> shift;
            for (var i = 0; i < length; ++i) {
                a[i] = String.fromCharCode(HEAP[start + i]);
            }
            _free(value);
            return a.join('');
        },
        'toWireType': function(destructors, value) {
            // assumes 4-byte alignment
            var length = value.length;
            var ptr = _malloc(4 + length * charSize);
            HEAPU32[ptr >> 2] = length;
            var start = (ptr + 4) >> shift;
            for (var i = 0; i < length; ++i) {
                HEAP[start + i] = value.charCodeAt(i);
            }
            if (destructors !== null) {
                destructors.push(_free, ptr);
            }
            return ptr;
        },
        destructorFunction: function(ptr) { _free(ptr); },
    });
}

function __embind_register_emval(rawType, name) {
    name = readLatin1String(name);
    registerType(rawType, {
        name: name,
        'fromWireType': function(handle) {
            var rv = _emval_handle_array[handle].value;
            __emval_decref(handle);
            return rv;
        },
        'toWireType': function(destructors, value) {
            return __emval_register(value);
        },
        destructorFunction: null, // This type does not need a destructor
    });
}

function __embind_register_memory_view(rawType, name) {
    var typeMapping = [
        Int8Array,
        Uint8Array,
        Int16Array,
        Uint16Array,
        Int32Array,
        Uint32Array,
        Float32Array,
        Float64Array,        
    ];

    name = readLatin1String(name);
    registerType(rawType, {
        name: name,
        'fromWireType': function(handle) {
            var type = HEAPU32[handle >> 2];
            var size = HEAPU32[(handle >> 2) + 1]; // in elements
            var data = HEAPU32[(handle >> 2) + 2]; // byte offset into emscripten heap
            var TA = typeMapping[type];
            return new TA(HEAP8.buffer, data, size);
        },
    });
}

function runDestructors(destructors) {
    while (destructors.length) {
        var ptr = destructors.pop();
        var del = destructors.pop();
        del(ptr);
    }
}

// Function implementation of operator new, per
// http://www.ecma-international.org/publications/files/ECMA-ST/Ecma-262.pdf
// 13.2.2
// ES3
function new_(constructor, argumentList) {
    if (!(constructor instanceof Function)) {
        throw new TypeError('new_ called with constructor type ' + typeof(constructor) + " which is not a function");
    }

    /*
     * Previously, the following line was just:

     function dummy() {};

     * Unfortunately, Chrome was preserving 'dummy' as the object's name, even though at creation, the 'dummy' has the
     * correct constructor name.  Thus, objects created with IMVU.new would show up in the debugger as 'dummy', which
     * isn't very helpful.  Using IMVU.createNamedFunction addresses the issue.  Doublely-unfortunately, there's no way
     * to write a test for this behavior.  -NRD 2013.02.22
     */
    var dummy = createNamedFunction(constructor.name, function(){});
    dummy.prototype = constructor.prototype;
    var obj = new dummy;

    var r = constructor.apply(obj, argumentList);
    return (r instanceof Object) ? r : obj;
}

// The path to interop from JS code to C++ code:
// (hand-written JS code) -> (autogenerated JS invoker) -> (template-generated C++ invoker) -> (target C++ function)
// craftInvokerFunction generates the JS invoker function for each function exposed to JS through embind.
function craftInvokerFunction(humanName, argTypes, classType, cppInvokerFunc, cppTargetFunc) {
    // humanName: a human-readable string name for the function to be generated.
    // argTypes: An array that contains the embind type objects for all types in the function signature.
    //    argTypes[0] is the type object for the function return value.
    //    argTypes[1] is the type object for function this object/class type, or null if not crafting an invoker for a class method.
    //    argTypes[2...] are the actual function parameters.
    // classType: The embind type object for the class to be bound, or null if this is not a method of a class.
    // cppInvokerFunc: JS Function object to the C++-side function that interops into C++ code.
    // cppTargetFunc: Function pointer (an integer to FUNCTION_TABLE) to the target C++ function the cppInvokerFunc will end up calling.
    var argCount = argTypes.length;

    if (argCount < 2) {
        throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!");
    }
    
    var isClassMethodFunc = (argTypes[1] !== null && classType !== null);

    if (!isClassMethodFunc && !FUNCTION_TABLE[cppTargetFunc]) {
        throwBindingError('Global function '+humanName+' is not defined!');
    }

    // Free functions with signature "void function()" do not need an invoker that marshalls between wire types.
// TODO: This omits argument count check - enable only at -O3 or similar.
//    if (ENABLE_UNSAFE_OPTS && argCount == 2 && argTypes[0].name == "void" && !isClassMethodFunc) {
//       return FUNCTION_TABLE[fn];
//    }

    var argsList = "";
    var argsListWired = "";
    for(var i = 0; i < argCount-2; ++i) {
        argsList += (i!==0?", ":"")+"arg"+i;
        argsListWired += (i!==0?", ":"")+"arg"+i+"Wired";
    }

    var invokerFnBody =
        "return function "+makeLegalFunctionName(humanName)+"("+argsList+") {\n" +
        "if (arguments.length !== "+(argCount - 2)+") {\n" +
            "throwBindingError('function "+humanName+" called with ' + arguments.length + ' arguments, expected "+(argCount - 2)+" args!');\n" +
        "}\n";

    // Determine if we need to use a dynamic stack to store the destructors for the function parameters.
    // TODO: Remove this completely once all function invokers are being dynamically generated.
    var needsDestructorStack = false;
    
    for(var i = 1; i < argTypes.length; ++i) { // Skip return value at index 0 - it's not deleted here.
        if (argTypes[i] !== null && argTypes[i].destructorFunction === undefined) { // The type does not define a destructor function - must use dynamic stack
            needsDestructorStack = true;
            break;
        }
    }

    if (needsDestructorStack) {
        invokerFnBody +=
            "var destructors = [];\n";
    }

    var dtorStack = needsDestructorStack ? "destructors" : "null";
    var args1 = ["throwBindingError", "classType", "invoker", "fn", "runDestructors", "retType", "classParam"];
    var args2 = [throwBindingError, classType, cppInvokerFunc, cppTargetFunc, runDestructors, argTypes[0], argTypes[1]];

    if (isClassMethodFunc) {
        invokerFnBody += "var thisWired = classParam.toWireType("+dtorStack+", this);\n";
    }

    for(var i = 0; i < argCount-2; ++i) {
        invokerFnBody += "var arg"+i+"Wired = argType"+i+".toWireType("+dtorStack+", arg"+i+"); // "+argTypes[i+2].name+"\n";
        args1.push("argType"+i);
        args2.push(argTypes[i+2]);
    }

    if (isClassMethodFunc) {
        argsListWired = "thisWired" + (argsListWired.length > 0 ? ", " : "") + argsListWired;
    }

    var returns = (argTypes[0].name !== "void");

    invokerFnBody +=
        (returns?"var rv = ":"") + "invoker(fn"+(argsListWired.length>0?", ":"")+argsListWired+");\n";
    
    if (needsDestructorStack) {
        invokerFnBody += "runDestructors(destructors);\n";
    } else {
        for(var i = isClassMethodFunc?1:2; i < argTypes.length; ++i) { // Skip return value at index 0 - it's not deleted here. Also skip class type if not a method.
            var paramName = (i === 1 ? "thisWired" : ("arg"+(i-2)+"Wired"));
            if (argTypes[i].destructorFunction !== null) {
                invokerFnBody += paramName+"_dtor("+paramName+"); // "+argTypes[i].name+"\n";
                args1.push(paramName+"_dtor");
                args2.push(argTypes[i].destructorFunction);
            }
        }
    }
    
    if (returns) {
        invokerFnBody += "return retType.fromWireType(rv);\n";
    }
    invokerFnBody += "}\n";

    args1.push(invokerFnBody);

    var invokerFunction = new_(Function, args1).apply(null, args2);
    return invokerFunction;
}

function __embind_register_function(name, argCount, rawArgTypesAddr, rawInvoker, fn) {
    var argTypes = heap32VectorToArray(argCount, rawArgTypesAddr);
    name = readLatin1String(name);
    rawInvoker = FUNCTION_TABLE[rawInvoker];

    exposePublicSymbol(name, function() {
        throwUnboundTypeError('Cannot call ' + name + ' due to unbound types', argTypes);
    }, argCount - 1);

    whenDependentTypesAreResolved([], argTypes, function(argTypes) {
        var invokerArgsArray = [argTypes[0] /* return value */, null /* no class 'this'*/].concat(argTypes.slice(1) /* actual params */);
        replacePublicSymbol(name, craftInvokerFunction(name, invokerArgsArray, null /* no class 'this'*/, rawInvoker, fn), argCount - 1);
        return [];
    });
}

var tupleRegistrations = {};

function __embind_register_value_array(rawType, name, rawConstructor, rawDestructor) {
    tupleRegistrations[rawType] = {
        name: readLatin1String(name),
        rawConstructor: FUNCTION_TABLE[rawConstructor],
        rawDestructor: FUNCTION_TABLE[rawDestructor],
        elements: [],
    };
}

function __embind_register_value_array_element(
    rawTupleType,
    getterReturnType,
    getter,
    getterContext,
    setterArgumentType,
    setter,
    setterContext
) {
    tupleRegistrations[rawTupleType].elements.push({
        getterReturnType: getterReturnType,
        getter: FUNCTION_TABLE[getter],
        getterContext: getterContext,
        setterArgumentType: setterArgumentType,
        setter: FUNCTION_TABLE[setter],
        setterContext: setterContext,
    });
}

function __embind_finalize_value_array(rawTupleType) {
    var reg = tupleRegistrations[rawTupleType];
    delete tupleRegistrations[rawTupleType];
    var elements = reg.elements;
    var elementsLength = elements.length;
    var elementTypes = elements.map(function(elt) { return elt.getterReturnType; }).
                concat(elements.map(function(elt) { return elt.setterArgumentType; }));

    var rawConstructor = reg.rawConstructor;
    var rawDestructor = reg.rawDestructor;
 
    whenDependentTypesAreResolved([rawTupleType], elementTypes, function(elementTypes) {
        elements.forEach(function(elt, i) {
            var getterReturnType = elementTypes[i];
            var getter = elt.getter;
            var getterContext = elt.getterContext;
            var setterArgumentType = elementTypes[i + elementsLength];
            var setter = elt.setter;
            var setterContext = elt.setterContext;
            elt.read = function(ptr) {
                return getterReturnType['fromWireType'](getter(getterContext, ptr));
            };
            elt.write = function(ptr, o) {
                var destructors = [];
                setter(setterContext, ptr, setterArgumentType['toWireType'](destructors, o));
                runDestructors(destructors);
            };
        });

        return [{
            name: reg.name,
            'fromWireType': function(ptr) {
                var rv = new Array(elementsLength);
                for (var i = 0; i < elementsLength; ++i) {
                    rv[i] = elements[i].read(ptr);
                }
                rawDestructor(ptr);
                return rv;
            },
            'toWireType': function(destructors, o) {
                if (elementsLength !== o.length) {
                    throw new TypeError("Incorrect number of tuple elements for " + reg.name + ": expected=" + elementsLength + ", actual=" + o.length);
                }
                var ptr = rawConstructor();
                for (var i = 0; i < elementsLength; ++i) {
                    elements[i].write(ptr, o[i]);
                }
                if (destructors !== null) {
                    destructors.push(rawDestructor, ptr);
                }
                return ptr;
            },
            destructorFunction: rawDestructor,
        }];
    });
}

var structRegistrations = {};

function __embind_register_value_object(
    rawType,
    name,
    rawConstructor,
    rawDestructor
) {
    structRegistrations[rawType] = {
        name: readLatin1String(name),
        rawConstructor: FUNCTION_TABLE[rawConstructor],
        rawDestructor: FUNCTION_TABLE[rawDestructor],
        fields: [],
    };
}

function __embind_register_value_object_field(
    structType,
    fieldName,
    getterReturnType,
    getter,
    getterContext,
    setterArgumentType,
    setter,
    setterContext
) {
    structRegistrations[structType].fields.push({
        fieldName: readLatin1String(fieldName),
        getterReturnType: getterReturnType,
        getter: FUNCTION_TABLE[getter],
        getterContext: getterContext,
        setterArgumentType: setterArgumentType,
        setter: FUNCTION_TABLE[setter],
        setterContext: setterContext,
    });
}

function __embind_finalize_value_object(structType) {
    var reg = structRegistrations[structType];
    delete structRegistrations[structType];

    var rawConstructor = reg.rawConstructor;
    var rawDestructor = reg.rawDestructor;
    var fieldRecords = reg.fields;
    var fieldTypes = fieldRecords.map(function(field) { return field.getterReturnType; }).
              concat(fieldRecords.map(function(field) { return field.setterArgumentType; }));
    whenDependentTypesAreResolved([structType], fieldTypes, function(fieldTypes) {
        var fields = {};
        fieldRecords.forEach(function(field, i) {
            var fieldName = field.fieldName;
            var getterReturnType = fieldTypes[i];
            var getter = field.getter;
            var getterContext = field.getterContext;
            var setterArgumentType = fieldTypes[i + fieldRecords.length];
            var setter = field.setter;
            var setterContext = field.setterContext;
            fields[fieldName] = {
                read: function(ptr) {
                    return getterReturnType['fromWireType'](
                        getter(getterContext, ptr));
                },
                write: function(ptr, o) {
                    var destructors = [];
                    setter(setterContext, ptr, setterArgumentType['toWireType'](destructors, o));
                    runDestructors(destructors);
                }
            };
        });

        return [{
            name: reg.name,
            'fromWireType': function(ptr) {
                var rv = {};
                for (var i in fields) {
                    rv[i] = fields[i].read(ptr);
                }
                rawDestructor(ptr);
                return rv;
            },
            'toWireType': function(destructors, o) {
                // todo: Here we have an opportunity for -O3 level "unsafe" optimizations:
                // assume all fields are present without checking.
                for (var fieldName in fields) {
                    if (!(fieldName in o)) {
                        throw new TypeError('Missing field');
                    }
                }
                var ptr = rawConstructor();
                for (fieldName in fields) {
                    fields[fieldName].write(ptr, o[fieldName]);
                }
                if (destructors !== null) {
                    destructors.push(rawDestructor, ptr);
                }
                return ptr;
            },
            destructorFunction: rawDestructor,
        }];
    });
}

var genericPointerToWireType = function(destructors, handle) {
    if (handle === null) {
        if (this.isReference) {
            throwBindingError('null is not a valid ' + this.name);
        }

        if (this.isSmartPointer) {
            var ptr = this.rawConstructor();
            if (destructors !== null) {
                destructors.push(this.rawDestructor, ptr);
            }
            return ptr;
        } else {
            return 0;
        }
    }

    if (!handle.$$) {
        throwBindingError('Cannot pass "' + _embind_repr(handle) + '" as a ' + this.name);
    }
    if (!handle.$$.ptr) {
        throwBindingError('Cannot pass deleted object as a pointer of type ' + this.name);
    }
    if (!this.isConst && handle.$$.ptrType.isConst) {
        throwBindingError('Cannot convert argument of type ' + (handle.$$.smartPtrType ? handle.$$.smartPtrType.name : handle.$$.ptrType.name) + ' to parameter type ' + this.name);
    }
    var handleClass = handle.$$.ptrType.registeredClass;
    var ptr = upcastPointer(handle.$$.ptr, handleClass, this.registeredClass);

    if (this.isSmartPointer) {
        // TODO: this is not strictly true
        // We could support BY_EMVAL conversions from raw pointers to smart pointers
        // because the smart pointer can hold a reference to the handle
        if (undefined === handle.$$.smartPtr) {
            throwBindingError('Passing raw pointer to smart pointer is illegal');
        }
        
        switch (this.sharingPolicy) {
            case 0: // NONE
                // no upcasting
                if (handle.$$.smartPtrType === this) {
                    ptr = handle.$$.smartPtr;
                } else {
                    throwBindingError('Cannot convert argument of type ' + (handle.$$.smartPtrType ? handle.$$.smartPtrType.name : handle.$$.ptrType.name) + ' to parameter type ' + this.name);
                }
                break;
            
            case 1: // INTRUSIVE
                ptr = handle.$$.smartPtr;
                break;
            
            case 2: // BY_EMVAL
                if (handle.$$.smartPtrType === this) {
                    ptr = handle.$$.smartPtr;
                } else {
                    var clonedHandle = handle['clone']();
                    ptr = this.rawShare(
                        ptr,
                        __emval_register(function() {
                            clonedHandle['delete']();
                        })
                    );
                    if (destructors !== null) {
                        destructors.push(this.rawDestructor, ptr);
                    }
                }
                break;
            
            default:
                throwBindingError('Unsupporting sharing policy');
        }
    }
    return ptr;
};

// If we know a pointer type is not going to have SmartPtr logic in it, we can
// special-case optimize it a bit (compare to genericPointerToWireType)
var constNoSmartPtrRawPointerToWireType = function(destructors, handle) {
    if (handle === null) {
        if (this.isReference) {
            throwBindingError('null is not a valid ' + this.name);
        }
        return 0;
    }

    if (!handle.$$) {
        throwBindingError('Cannot pass "' + _embind_repr(handle) + '" as a ' + this.name);
    }
    if (!handle.$$.ptr) {
        throwBindingError('Cannot pass deleted object as a pointer of type ' + this.name);
    }
    var handleClass = handle.$$.ptrType.registeredClass;
    var ptr = upcastPointer(handle.$$.ptr, handleClass, this.registeredClass);
    return ptr;
};

// An optimized version for non-const method accesses - there we must additionally restrict that
// the pointer is not a const-pointer.
var nonConstNoSmartPtrRawPointerToWireType = function(destructors, handle) {
    if (handle === null) {
        if (this.isReference) {
            throwBindingError('null is not a valid ' + this.name);
        }
        return 0;
    }

    if (!handle.$$) {
        throwBindingError('Cannot pass "' + _embind_repr(handle) + '" as a ' + this.name);
    }
    if (!handle.$$.ptr) {
        throwBindingError('Cannot pass deleted object as a pointer of type ' + this.name);
    }
    if (handle.$$.ptrType.isConst) {
        throwBindingError('Cannot convert argument of type ' + handle.$$.ptrType.name + ' to parameter type ' + this.name);
    }
    var handleClass = handle.$$.ptrType.registeredClass;
    var ptr = upcastPointer(handle.$$.ptr, handleClass, this.registeredClass);
    return ptr;
};

function RegisteredPointer(
    name,
    registeredClass,
    isReference,
    isConst,

    // smart pointer properties
    isSmartPointer,
    pointeeType,
    sharingPolicy,
    rawGetPointee,
    rawConstructor,
    rawShare,
    rawDestructor
) {
    this.name = name;
    this.registeredClass = registeredClass;
    this.isReference = isReference;
    this.isConst = isConst;

    // smart pointer properties
    this.isSmartPointer = isSmartPointer;
    this.pointeeType = pointeeType;
    this.sharingPolicy = sharingPolicy;
    this.rawGetPointee = rawGetPointee;
    this.rawConstructor = rawConstructor;
    this.rawShare = rawShare;
    this.rawDestructor = rawDestructor;

    if (!isSmartPointer && registeredClass.baseClass === undefined) {
        if (isConst) {
            this['toWireType'] = constNoSmartPtrRawPointerToWireType;
            this.destructorFunction = null;
        } else {
            this['toWireType'] = nonConstNoSmartPtrRawPointerToWireType;
            this.destructorFunction = null;
        }
    } else {
        this['toWireType'] = genericPointerToWireType;
        // Here we must leave this.destructorFunction undefined, since whether genericPointerToWireType returns
        // a pointer that needs to be freed up is runtime-dependent, and cannot be evaluated at registration time.
        // TODO: Create an alternative mechanism that allows removing the use of var destructors = []; array in 
        //       craftInvokerFunction altogether.
    }
}

RegisteredPointer.prototype.getPointee = function(ptr) {
    if (this.rawGetPointee) {
        ptr = this.rawGetPointee(ptr);
    }
    return ptr;
};

RegisteredPointer.prototype.destructor = function(ptr) {
    if (this.rawDestructor) {
        this.rawDestructor(ptr);
    }
};

RegisteredPointer.prototype['fromWireType'] = function(ptr) {
    // ptr is a raw pointer (or a raw smartpointer)

    // rawPointer is a maybe-null raw pointer
    var rawPointer = this.getPointee(ptr);
    if (!rawPointer) {
        this.destructor(ptr);
        return null;
    }

    function makeDefaultHandle() {
        if (this.isSmartPointer) {
            return makeClassHandle(this.registeredClass.instancePrototype, {
                ptrType: this.pointeeType,
                ptr: rawPointer,
                smartPtrType: this,
                smartPtr: ptr,
            });
        } else {
            return makeClassHandle(this.registeredClass.instancePrototype, {
                ptrType: this,
                ptr: ptr,
            });
        }
    }

    var actualType = this.registeredClass.getActualType(rawPointer);
    var registeredPointerRecord = registeredPointers[actualType];
    if (!registeredPointerRecord) {
        return makeDefaultHandle.call(this);
    }

    var toType;
    if (this.isConst) {
        toType = registeredPointerRecord.constPointerType;
    } else {
        toType = registeredPointerRecord.pointerType;
    }
    var dp = downcastPointer(
        rawPointer,
        this.registeredClass,
        toType.registeredClass);
    if (dp === null) {
        return makeDefaultHandle.call(this);
    }
    if (this.isSmartPointer) {
        return makeClassHandle(toType.registeredClass.instancePrototype, {
            ptrType: toType,
            ptr: dp,
            smartPtrType: this,
            smartPtr: ptr,
        });
    } else {
        return makeClassHandle(toType.registeredClass.instancePrototype, {
            ptrType: toType,
            ptr: dp,
        });
    }
};

function makeClassHandle(prototype, record) {
    if (!record.ptrType || !record.ptr) {
        throwInternalError('makeClassHandle requires ptr and ptrType');
    }
    var hasSmartPtrType = !!record.smartPtrType;
    var hasSmartPtr = !!record.smartPtr;
    if (hasSmartPtrType !== hasSmartPtr) {
        throwInternalError('Both smartPtrType and smartPtr must be specified');
    }
    record.count = { value: 1 };
    return Object.create(prototype, {
        $$: {
            value: record,
        },
    });
}

// root of all pointer and smart pointer handles in embind
function ClassHandle() {
}

function getInstanceTypeName(handle) {
    return handle.$$.ptrType.registeredClass.name;
}

ClassHandle.prototype['isAliasOf'] = function(other) {
    if (!(this instanceof ClassHandle)) {
        return false;
    }
    if (!(other instanceof ClassHandle)) {
        return false;
    }

    var leftClass = this.$$.ptrType.registeredClass;
    var left = this.$$.ptr;
    var rightClass = other.$$.ptrType.registeredClass;
    var right = other.$$.ptr;

    while (leftClass.baseClass) {
        left = leftClass.upcast(left);
        leftClass = leftClass.baseClass;
    }

    while (rightClass.baseClass) {
        right = rightClass.upcast(right);
        rightClass = rightClass.baseClass;
    }
    
    return leftClass === rightClass && left === right;
};

function throwInstanceAlreadyDeleted(obj) {
    throwBindingError(getInstanceTypeName(obj) + ' instance already deleted');
}

ClassHandle.prototype['clone'] = function() {
    if (!this.$$.ptr) {
        throwInstanceAlreadyDeleted(this);
    }

    var clone = Object.create(Object.getPrototypeOf(this), {
        $$: {
            value: shallowCopy(this.$$),
        }
    });

    clone.$$.count.value += 1;
    return clone;
};

function runDestructor(handle) {
    var $$ = handle.$$;
    if ($$.smartPtr) {
        $$.smartPtrType.rawDestructor($$.smartPtr);
    } else {
        $$.ptrType.registeredClass.rawDestructor($$.ptr);
    }
}

ClassHandle.prototype['delete'] = function ClassHandle_delete() {
    if (!this.$$.ptr) {
        throwInstanceAlreadyDeleted(this);
    }
    if (this.$$.deleteScheduled) {
        throwBindingError('Object already scheduled for deletion');
    }

    this.$$.count.value -= 1;
    if (0 === this.$$.count.value) {
        runDestructor(this);
    }
    this.$$.smartPtr = undefined;
    this.$$.ptr = undefined;
};

var deletionQueue = [];

ClassHandle.prototype['isDeleted'] = function isDeleted() {
    return !this.$$.ptr;
};

ClassHandle.prototype['deleteLater'] = function deleteLater() {
    if (!this.$$.ptr) {
        throwInstanceAlreadyDeleted(this);
    }
    if (this.$$.deleteScheduled) {
        throwBindingError('Object already scheduled for deletion');
    }
    deletionQueue.push(this);
    if (deletionQueue.length === 1 && delayFunction) {
        delayFunction(flushPendingDeletes);
    }
    this.$$.deleteScheduled = true;
    return this;
};

function flushPendingDeletes() {
    while (deletionQueue.length) {
        var obj = deletionQueue.pop();
        obj.$$.deleteScheduled = false;
        obj['delete']();
    }
}
Module['flushPendingDeletes'] = flushPendingDeletes;

var delayFunction;
Module['setDelayFunction'] = function setDelayFunction(fn) {
    delayFunction = fn;
    if (deletionQueue.length && delayFunction) {
        delayFunction(flushPendingDeletes);
    }
};
        
function RegisteredClass(
    name,
    constructor,
    instancePrototype,
    rawDestructor,
    baseClass,
    getActualType,
    upcast,
    downcast
) {
    this.name = name;
    this.constructor = constructor;
    this.instancePrototype = instancePrototype;
    this.rawDestructor = rawDestructor;
    this.baseClass = baseClass;
    this.getActualType = getActualType;
    this.upcast = upcast;
    this.downcast = downcast;
}

function shallowCopy(o) {
    var rv = {};
    for (var k in o) {
        rv[k] = o[k];
    }
    return rv;
}

function __embind_register_class(
    rawType,
    rawPointerType,
    rawConstPointerType,
    baseClassRawType,
    getActualType,
    upcast,
    downcast,
    name,
    rawDestructor
) {
    name = readLatin1String(name);
    rawDestructor = FUNCTION_TABLE[rawDestructor];
    getActualType = FUNCTION_TABLE[getActualType];
    upcast = FUNCTION_TABLE[upcast];
    downcast = FUNCTION_TABLE[downcast];
    var legalFunctionName = makeLegalFunctionName(name);

    exposePublicSymbol(legalFunctionName, function() {
        // this code cannot run if baseClassRawType is zero
        throwUnboundTypeError('Cannot construct ' + name + ' due to unbound types', [baseClassRawType]);
    });

    whenDependentTypesAreResolved(
        [rawType, rawPointerType, rawConstPointerType],
        baseClassRawType ? [baseClassRawType] : [],
        function(base) {
            base = base[0];

            var baseClass;
            var basePrototype;
            if (baseClassRawType) {
                baseClass = base.registeredClass;
                basePrototype = baseClass.instancePrototype;
            } else {
                basePrototype = ClassHandle.prototype;
            }

            var constructor = createNamedFunction(legalFunctionName, function() {
                if (Object.getPrototypeOf(this) !== instancePrototype) {
                    throw new BindingError("Use 'new' to construct " + name);
                }
                if (undefined === registeredClass.constructor_body) {
                    throw new BindingError(name + " has no accessible constructor");
                }
                var body = registeredClass.constructor_body[arguments.length];
                if (undefined === body) {
                    throw new BindingError("Tried to invoke ctor of " + name + " with invalid number of parameters (" + arguments.length + ") - expected (" + Object.keys(registeredClass.constructor_body).toString() + ") parameters instead!");
                }
                return body.apply(this, arguments);
            });

            var instancePrototype = Object.create(basePrototype, {
                constructor: { value: constructor },
            });

            constructor.prototype = instancePrototype;

            var registeredClass = new RegisteredClass(
                name,
                constructor,
                instancePrototype,
                rawDestructor,
                baseClass,
                getActualType,
                upcast,
                downcast);

            var referenceConverter = new RegisteredPointer(
                name,
                registeredClass,
                true,
                false,
                false);
        
            var pointerConverter = new RegisteredPointer(
                name + '*',
                registeredClass,
                false,
                false,
                false);

            var constPointerConverter = new RegisteredPointer(
                name + ' const*',
                registeredClass,
                false,
                true,
                false);

            registeredPointers[rawType] = {
                pointerType: pointerConverter,
                constPointerType: constPointerConverter
            };

            replacePublicSymbol(legalFunctionName, constructor);

            return [referenceConverter, pointerConverter, constPointerConverter];
        }
    );
}

function __embind_register_class_constructor(
    rawClassType,
    argCount,
    rawArgTypesAddr,
    invoker,
    rawConstructor
) {
    var rawArgTypes = heap32VectorToArray(argCount, rawArgTypesAddr);
    invoker = FUNCTION_TABLE[invoker];

    whenDependentTypesAreResolved([], [rawClassType], function(classType) {
        classType = classType[0];
        var humanName = 'constructor ' + classType.name;

        if (undefined === classType.registeredClass.constructor_body) {
            classType.registeredClass.constructor_body = [];
        }
        if (undefined !== classType.registeredClass.constructor_body[argCount - 1]) {
            throw new BindingError("Cannot register multiple constructors with identical number of parameters (" + (argCount-1) + ") for class '" + classType.name + "'! Overload resolution is currently only performed using the parameter count, not actual type info!");
        }
        classType.registeredClass.constructor_body[argCount - 1] = function() {
            throwUnboundTypeError('Cannot construct ' + classType.name + ' due to unbound types', rawArgTypes);
        };

        whenDependentTypesAreResolved([], rawArgTypes, function(argTypes) {
            classType.registeredClass.constructor_body[argCount - 1] = function() {
                if (arguments.length !== argCount - 1) {
                    throwBindingError(humanName + ' called with ' + arguments.length + ' arguments, expected ' + (argCount-1));
                }
                var destructors = [];
                var args = new Array(argCount);
                args[0] = rawConstructor;
                for (var i = 1; i < argCount; ++i) {
                    args[i] = argTypes[i]['toWireType'](destructors, arguments[i - 1]);
                }
                
                var ptr = invoker.apply(null, args);
                runDestructors(destructors);
                
                return argTypes[0]['fromWireType'](ptr);
            };
            return [];
        });
        return [];
    });
}

function downcastPointer(ptr, ptrClass, desiredClass) {
    if (ptrClass === desiredClass) {
        return ptr;
    }
    if (undefined === desiredClass.baseClass) {
        return null; // no conversion
    }
    // O(depth) stack space used
    return desiredClass.downcast(
        downcastPointer(ptr, ptrClass, desiredClass.baseClass));
}

function upcastPointer(ptr, ptrClass, desiredClass) {
    while (ptrClass !== desiredClass) {
        if (!ptrClass.upcast) {
            throwBindingError("Expected null or instance of " + desiredClass.name + ", got an instance of " + ptrClass.name);
        }
        ptr = ptrClass.upcast(ptr);
        ptrClass = ptrClass.baseClass;
    }
    return ptr;
}

function validateThis(this_, classType, humanName) {
    if (!(this_ instanceof Object)) {
        throwBindingError(humanName + ' with invalid "this": ' + this_);
    }
    if (!(this_ instanceof classType.registeredClass.constructor)) {
        throwBindingError(humanName + ' incompatible with "this" of type ' + this_.constructor.name);
    }
    if (!this_.$$.ptr) {
        throwBindingError('cannot call emscripten binding method ' + humanName + ' on deleted object');
    }

    // todo: kill this
    return upcastPointer(
        this_.$$.ptr,
        this_.$$.ptrType.registeredClass,
        classType.registeredClass);
}

function __embind_register_class_function(
    rawClassType,
    methodName,
    argCount,
    rawArgTypesAddr, // [ReturnType, ThisType, Args...]
    rawInvoker,
    context
) {
    var rawArgTypes = heap32VectorToArray(argCount, rawArgTypesAddr);
    methodName = readLatin1String(methodName);
    rawInvoker = FUNCTION_TABLE[rawInvoker];

    whenDependentTypesAreResolved([], [rawClassType], function(classType) {
        classType = classType[0];
        var humanName = classType.name + '.' + methodName;

        var unboundTypesHandler = function() {
            throwUnboundTypeError('Cannot call ' + humanName + ' due to unbound types', rawArgTypes);
        };

        var proto = classType.registeredClass.instancePrototype;
        var method = proto[methodName];
        if (undefined === method || (undefined === method.overloadTable && method.className !== classType.name && method.argCount === argCount-2)) {
            // This is the first overload to be registered, OR we are replacing a function in the base class with a function in the derived class.
            unboundTypesHandler.argCount = argCount-2;
            unboundTypesHandler.className = classType.name;
            proto[methodName] = unboundTypesHandler;
        } else {
            // There was an existing function with the same name registered. Set up a function overload routing table.
            ensureOverloadTable(proto, methodName, humanName);
            proto[methodName].overloadTable[argCount-2] = unboundTypesHandler;
        }

        whenDependentTypesAreResolved([], rawArgTypes, function(argTypes) {
        
            var memberFunction = craftInvokerFunction(humanName, argTypes, classType, rawInvoker, context);

            // Replace the initial unbound-handler-stub function with the appropriate member function, now that all types
            // are resolved. If multiple overloads are registered for this function, the function goes into an overload table.
            if (undefined === proto[methodName].overloadTable) {
                proto[methodName] = memberFunction;
            } else {
                proto[methodName].overloadTable[argCount-2] = memberFunction;
            }

            return [];
        });
        return [];
    });
}

function __embind_register_class_class_function(
    rawClassType,
    methodName,
    argCount,
    rawArgTypesAddr,
    rawInvoker,
    fn
) {
    var rawArgTypes = heap32VectorToArray(argCount, rawArgTypesAddr);
    methodName = readLatin1String(methodName);
    rawInvoker = FUNCTION_TABLE[rawInvoker];
    whenDependentTypesAreResolved([], [rawClassType], function(classType) {
        classType = classType[0];
        var humanName = classType.name + '.' + methodName;

        var unboundTypesHandler = function() {
                throwUnboundTypeError('Cannot call ' + humanName + ' due to unbound types', rawArgTypes);
            };

        var proto = classType.registeredClass.constructor;
        if (undefined === proto[methodName]) {
            // This is the first function to be registered with this name.
            unboundTypesHandler.argCount = argCount-1;
            proto[methodName] = unboundTypesHandler;
        } else {
            // There was an existing function with the same name registered. Set up a function overload routing table.
            ensureOverloadTable(proto, methodName, humanName);
            proto[methodName].overloadTable[argCount-1] = unboundTypesHandler;
        }

        whenDependentTypesAreResolved([], rawArgTypes, function(argTypes) {
            // Replace the initial unbound-types-handler stub with the proper function. If multiple overloads are registered,
            // the function handlers go into an overload table.
            var invokerArgsArray = [argTypes[0] /* return value */, null /* no class 'this'*/].concat(argTypes.slice(1) /* actual params */);
            var func = craftInvokerFunction(humanName, invokerArgsArray, null /* no class 'this'*/, rawInvoker, fn);
            if (undefined === proto[methodName].overloadTable) {
                proto[methodName] = func;
            } else {
                proto[methodName].overloadTable[argCount-1] = func;
            }
            return [];
        });
        return [];
    });
}

function __embind_register_class_property(
    classType,
    fieldName,
    getterReturnType,
    getter,
    getterContext,
    setterArgumentType,
    setter,
    setterContext
) {
    fieldName = readLatin1String(fieldName);
    getter = FUNCTION_TABLE[getter];

    whenDependentTypesAreResolved([], [classType], function(classType) {
        classType = classType[0];
        var humanName = classType.name + '.' + fieldName;
        var desc = {
            get: function() {
                throwUnboundTypeError('Cannot access ' + humanName + ' due to unbound types', [getterReturnType, setterArgumentType]);
            },
            enumerable: true,
            configurable: true
        };
        if (setter) {
            desc.set = function() {
                throwUnboundTypeError('Cannot access ' + humanName + ' due to unbound types', [getterReturnType, setterArgumentType]);
            };
        } else {
            desc.set = function(v) {
                throwBindingError(humanName + ' is a read-only property');
            };
        }

        Object.defineProperty(classType.registeredClass.instancePrototype, fieldName, desc);

        whenDependentTypesAreResolved(
            [],
            (setter ? [getterReturnType, setterArgumentType] : [getterReturnType]),
        function(types) {
            var getterReturnType = types[0];
            var desc = {
                get: function() {
                    var ptr = validateThis(this, classType, humanName + ' getter');
                    return getterReturnType['fromWireType'](getter(getterContext, ptr));
                },
                enumerable: true
            };

            if (setter) {
                setter = FUNCTION_TABLE[setter];
                var setterArgumentType = types[1];
                desc.set = function(v) {
                    var ptr = validateThis(this, classType, humanName + ' setter');
                    var destructors = [];
                    setter(setterContext, ptr, setterArgumentType['toWireType'](destructors, v));
                    runDestructors(destructors);
                };
            }

            Object.defineProperty(classType.registeredClass.instancePrototype, fieldName, desc);
            return [];
        });

        return [];
    });
}

var char_0 = '0'.charCodeAt(0);
var char_9 = '9'.charCodeAt(0);
function makeLegalFunctionName(name) {
    name = name.replace(/[^a-zA-Z0-9_]/g, '$');
    var f = name.charCodeAt(0);
    if (f >= char_0 && f <= char_9) {
        return '_' + name;
    } else {
        return name;
    }
}

function __embind_register_smart_ptr(
    rawType,
    rawPointeeType,
    name,
    sharingPolicy,
    rawGetPointee,
    rawConstructor,
    rawShare,
    rawDestructor
) {
    name = readLatin1String(name);
    rawGetPointee = FUNCTION_TABLE[rawGetPointee];
    rawConstructor = FUNCTION_TABLE[rawConstructor];
    rawShare = FUNCTION_TABLE[rawShare];
    rawDestructor = FUNCTION_TABLE[rawDestructor];

    whenDependentTypesAreResolved([rawType], [rawPointeeType], function(pointeeType) {
        pointeeType = pointeeType[0];

        var registeredPointer = new RegisteredPointer(
            name,
            pointeeType.registeredClass,
            false,
            false,
            // smart pointer properties
            true,
            pointeeType,
            sharingPolicy,
            rawGetPointee,
            rawConstructor,
            rawShare,
            rawDestructor);
        return [registeredPointer];
    });
}

function __embind_register_enum(
    rawType,
    name
) {
    name = readLatin1String(name);

    function constructor() {
    }
    constructor.values = {};

    registerType(rawType, {
        name: name,
        constructor: constructor,
        'fromWireType': function(c) {
            return this.constructor.values[c];
        },
        'toWireType': function(destructors, c) {
            return c.value;
        },
        destructorFunction: null,
    });
    exposePublicSymbol(name, constructor);
}

function __embind_register_enum_value(
    rawEnumType,
    name,
    enumValue
) {
    var enumType = requireRegisteredType(rawEnumType, 'enum');
    name = readLatin1String(name);

    var Enum = enumType.constructor;

    var Value = Object.create(enumType.constructor.prototype, {
        value: {value: enumValue},
        constructor: {value: createNamedFunction(enumType.name + '_' + name, function() {})},
    });
    Enum.values[enumValue] = Value;
    Enum[name] = Value;
}

function __embind_register_constant(name, type, value) {
    name = readLatin1String(name);
    whenDependentTypesAreResolved([], [type], function(type) {
        type = type[0];
        Module[name] = type['fromWireType'](value);
        return [];
    });
}
/*global Module:true, Runtime*/
/*global HEAP32*/
/*global new_*/
/*global createNamedFunction*/
/*global readLatin1String, writeStringToMemory*/
/*global requireRegisteredType, throwBindingError*/
/*jslint sub:true*/ /* The symbols 'fromWireType' and 'toWireType' must be accessed via array notation to be closure-safe since craftInvokerFunction crafts functions as strings that can't be closured. */

var Module = Module || {};

var _emval_handle_array = [{}]; // reserve zero
var _emval_free_list = [];

// Public JS API

/** @expose */
Module.count_emval_handles = function() {
    var count = 0;
    for (var i = 1; i < _emval_handle_array.length; ++i) {
        if (_emval_handle_array[i] !== undefined) {
            ++count;
        }
    }
    return count;
};

/** @expose */
Module.get_first_emval = function() {
    for (var i = 1; i < _emval_handle_array.length; ++i) {
        if (_emval_handle_array[i] !== undefined) {
            return _emval_handle_array[i];
        }
    }
    return null;
};

// Private C++ API

var _emval_symbols = {}; // address -> string

function __emval_register_symbol(address) {
    _emval_symbols[address] = readLatin1String(address);
}

function getStringOrSymbol(address) {
    var symbol = _emval_symbols[address];
    if (symbol === undefined) {
        return readLatin1String(address);
    } else {
        return symbol;
    }
}

function requireHandle(handle) {
    if (!handle) {
        throwBindingError('Cannot use deleted val. handle = ' + handle);
    }
}

function __emval_register(value) {
    var handle = _emval_free_list.length ?
        _emval_free_list.pop() :
        _emval_handle_array.length;

    _emval_handle_array[handle] = {refcount: 1, value: value};
    return handle;
}

function __emval_incref(handle) {
    if (handle) {
        _emval_handle_array[handle].refcount += 1;
    }
}

function __emval_decref(handle) {
    if (handle && 0 === --_emval_handle_array[handle].refcount) {
        _emval_handle_array[handle] = undefined;
        _emval_free_list.push(handle);
    }
}

function __emval_new_array() {
    return __emval_register([]);
}

function __emval_new_object() {
    return __emval_register({});
}

function __emval_undefined() {
    return __emval_register(undefined);
}

function __emval_null() {
    return __emval_register(null);
}

function __emval_new_cstring(v) {
    return __emval_register(getStringOrSymbol(v));
}

function __emval_take_value(type, v) {
    type = requireRegisteredType(type, '_emval_take_value');
    v = type['fromWireType'](v);
    return __emval_register(v);
}

var __newers = {}; // arity -> function


function craftEmvalAllocator(argCount) {
    /*This function returns a new function that looks like this:
    function emval_allocator_3(handle, argTypes, arg0Wired, arg1Wired, arg2Wired) {
        var argType0 = requireRegisteredType(HEAP32[(argTypes >> 2)], "parameter 0");
        var arg0 = argType0.fromWireType(arg0Wired);
        var argType1 = requireRegisteredType(HEAP32[(argTypes >> 2) + 1], "parameter 1");
        var arg1 = argType1.fromWireType(arg1Wired);
        var argType2 = requireRegisteredType(HEAP32[(argTypes >> 2) + 2], "parameter 2");
        var arg2 = argType2.fromWireType(arg2Wired);
        var constructor = _emval_handle_array[handle].value;
        var emval = new constructor(arg0, arg1, arg2);
        return emval;
    } */

    var args1 = ["requireRegisteredType", "HEAP32", "_emval_handle_array", "__emval_register"];
    var args2 = [requireRegisteredType, HEAP32, _emval_handle_array, __emval_register];

    var argsList = "";
    var argsListWired = "";
    for(var i = 0; i < argCount; ++i) {
        argsList += (i!==0?", ":"")+"arg"+i; // 'arg0, arg1, ..., argn'
        argsListWired += ", arg"+i+"Wired"; // ', arg0Wired, arg1Wired, ..., argnWired'
    }

    var invokerFnBody =
        "return function emval_allocator_"+argCount+"(handle, argTypes " + argsListWired + ") {\n";

    for(var i = 0; i < argCount; ++i) {
        invokerFnBody += 
            "var argType"+i+" = requireRegisteredType(HEAP32[(argTypes >> 2) + "+i+"], \"parameter "+i+"\");\n" +
            "var arg"+i+" = argType"+i+".fromWireType(arg"+i+"Wired);\n";
    }
    invokerFnBody +=
        "var constructor = _emval_handle_array[handle].value;\n" +
        "var obj = new constructor("+argsList+");\n" +
        "return __emval_register(obj);\n" +
        "}\n";

    args1.push(invokerFnBody);
    var invokerFunction = new_(Function, args1).apply(null, args2);
    return invokerFunction;
}

function __emval_new(handle, argCount, argTypes) {
    requireHandle(handle);
    
    var newer = __newers[argCount];
    if (!newer) {
        newer = craftEmvalAllocator(argCount);
        __newers[argCount] = newer;
    }

    if (argCount === 0) {
        return newer(handle, argTypes);
    } else if (argCount === 1) {
        return newer(handle, argTypes, arguments[3]);
    } else if (argCount === 2) {
        return newer(handle, argTypes, arguments[3], arguments[4]);
    } else if (argCount === 3) {
        return newer(handle, argTypes, arguments[3], arguments[4], arguments[5]);
    } else if (argCount === 4) {
        return newer(handle, argTypes, arguments[3], arguments[4], arguments[5], arguments[6]);
    } else {
        // This is a slow path! (.apply and .splice are slow), so a few specializations are present above.
        return newer.apply(null, arguments.splice(1));
    }
}

// appease jshint (technically this code uses eval)
var global = (function(){return Function;})()('return this')();

function __emval_get_global(name) {
    name = getStringOrSymbol(name);
    return __emval_register(global[name]);
}

function __emval_get_module_property(name) {
    name = getStringOrSymbol(name);
    return __emval_register(Module[name]);
}

function __emval_get_property(handle, key) {
    requireHandle(handle);
    return __emval_register(_emval_handle_array[handle].value[_emval_handle_array[key].value]);
}

function __emval_set_property(handle, key, value) {
    requireHandle(handle);
    _emval_handle_array[handle].value[_emval_handle_array[key].value] = _emval_handle_array[value].value;
}

function __emval_as(handle, returnType) {
    requireHandle(handle);
    returnType = requireRegisteredType(returnType, 'emval::as');
    var destructors = [];
    // caller owns destructing
    return returnType['toWireType'](destructors, _emval_handle_array[handle].value);
}

function parseParameters(argCount, argTypes, argWireTypes) {
    var a = new Array(argCount);
    for (var i = 0; i < argCount; ++i) {
        var argType = requireRegisteredType(
            HEAP32[(argTypes >> 2) + i],
            "parameter " + i);
        a[i] = argType['fromWireType'](argWireTypes[i]);
    }
    return a;
}

function __emval_call(handle, argCount, argTypes) {
    requireHandle(handle);
    var types = lookupTypes(argCount, argTypes);

    var args = new Array(argCount);
    for (var i = 0; i < argCount; ++i) {
        args[i] = types[i]['fromWireType'](arguments[3 + i]);
    }

    var fn = _emval_handle_array[handle].value;
    var rv = fn.apply(undefined, args);
    return __emval_register(rv);
}

function lookupTypes(argCount, argTypes, argWireTypes) {
    var a = new Array(argCount);
    for (var i = 0; i < argCount; ++i) {
        a[i] = requireRegisteredType(
            HEAP32[(argTypes >> 2) + i],
            "parameter " + i);
    }
    return a;
}

function __emval_get_method_caller(argCount, argTypes) {
    var types = lookupTypes(argCount, argTypes);

    var retType = types[0];
    var signatureName = retType.name + "_$" + types.slice(1).map(function (t) { return t.name; }).join("_") + "$";

    var args1 = ["addFunction", "createNamedFunction", "requireHandle", "getStringOrSymbol", "_emval_handle_array", "retType"];
    var args2 = [Runtime.addFunction, createNamedFunction, requireHandle, getStringOrSymbol, _emval_handle_array, retType];

    var argsList = ""; // 'arg0, arg1, arg2, ... , argN'
    var argsListWired = ""; // 'arg0Wired, ..., argNWired'
    for (var i = 0; i < argCount - 1; ++i) {
        argsList += (i !== 0 ? ", " : "") + "arg" + i;
        argsListWired += ", arg" + i + "Wired";
        args1.push("argType" + i);
        args2.push(types[1 + i]);
    }

    var invokerFnBody =
        "return addFunction(createNamedFunction('" + signatureName + "', function (handle, name" + argsListWired + ") {\n" +
        "requireHandle(handle);\n" +
        "name = getStringOrSymbol(name);\n";

    for (var i = 0; i < argCount - 1; ++i) {
        invokerFnBody += "var arg" + i + " = argType" + i + ".fromWireType(arg" + i + "Wired);\n";
    }
    invokerFnBody +=
        "var obj = _emval_handle_array[handle].value;\n" +
        "return retType.toWireType(null, obj[name](" + argsList + "));\n" + 
        "}));\n";

    args1.push(invokerFnBody);
    var invokerFunction = new_(Function, args1).apply(null, args2);
    return invokerFunction;
}

function __emval_has_function(handle, name) {
    name = getStringOrSymbol(name);
    return _emval_handle_array[handle].value[name] instanceof Function;
}


if (Module['preInit']) {
  if (typeof Module['preInit'] == 'function') Module['preInit'] = [Module['preInit']];
  while (Module['preInit'].length > 0) {
    Module['preInit'].pop()();
  }
}

// shouldRunNow refers to calling main(), not run().
var shouldRunNow = true;
if (Module['noInitialRun']) {
  shouldRunNow = false;
}

run();

// {{POST_RUN_ADDITIONS}}






// {{MODULE_ADDITIONS}}






