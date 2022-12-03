/**
 * @license
 * Copyright 2015 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

// Pthread Web Worker startup routine:
// This is the entry point file that is loaded first by each Web Worker
// that executes pthreads on the Emscripten application.

'use strict';

var Module = {};

#if ENVIRONMENT_MAY_BE_NODE
// Node.js support
var ENVIRONMENT_IS_NODE = typeof process == 'object' && typeof process.versions == 'object' && typeof process.versions.node == 'string';
if (ENVIRONMENT_IS_NODE) {
  // Create as web-worker-like an environment as we can.

  var nodeWorkerThreads = require('worker_threads');

  var parentPort = nodeWorkerThreads.parentPort;

  parentPort.on('message', (data) => onmessage({ data: data }));

  var fs = require('fs');

  Object.assign(global, {
    self: global,
    require: require,
    Module: Module,
    location: {
      href: __filename
    },
    Worker: nodeWorkerThreads.Worker,
    importScripts: function(f) {
      (0, eval)(fs.readFileSync(f, 'utf8') + '//# sourceURL=' + f);
    },
    postMessage: function(msg) {
      parentPort.postMessage(msg);
    },
    performance: global.performance || {
      now: function() {
        return Date.now();
      }
    },
  });
}
#endif // ENVIRONMENT_MAY_BE_NODE

// Thread-local guard variable for one-time init of the JS state
var initializedJS = false;

// Proxying queues that were notified before the thread started and need to be
// executed as part of startup.
var pendingNotifiedProxyingQueues = [];

#if ASSERTIONS
function assert(condition, text) {
  if (!condition) abort('Assertion failed: ' + text);
}
#endif

function threadPrintErr() {
  var text = Array.prototype.slice.call(arguments).join(' ');
#if ENVIRONMENT_MAY_BE_NODE
  // See https://github.com/emscripten-core/emscripten/issues/14804
  if (ENVIRONMENT_IS_NODE) {
    fs.writeSync(2, text + '\n');
    return;
  }
#endif
  console.error(text);
}
function threadAlert() {
  var text = Array.prototype.slice.call(arguments).join(' ');
  postMessage({cmd: 'alert', text: text, threadId: Module['_pthread_self']()});
}
#if ASSERTIONS
// We don't need out() for now, but may need to add it if we want to use it
// here. Or, if this code all moves into the main JS, that problem will go
// away. (For now, adding it here increases code size for no benefit.)
var out = () => { throw 'out() is not defined in worker.js.'; }
#endif
var err = threadPrintErr;
self.alert = threadAlert;
#if RUNTIME_DEBUG
var dbg = threadPrintErr;
#endif

#if !MINIMAL_RUNTIME
Module['instantiateWasm'] = (info, receiveInstance) => {
  // Instantiate from the module posted from the main thread.
  // We can just use sync instantiation in the worker.
  var instance = new WebAssembly.Instance(Module['wasmModule'], info);
#if RELOCATABLE || MAIN_MODULE
  receiveInstance(instance, Module['wasmModule']);
#else
  // TODO: Due to Closure regression https://github.com/google/closure-compiler/issues/3193,
  // the above line no longer optimizes out down to the following line.
  // When the regression is fixed, we can remove this if/else.
  receiveInstance(instance);
#endif
  // We don't need the module anymore; new threads will be spawned from the main thread.
  Module['wasmModule'] = null;
  return instance.exports;
}
#endif

// Turn unhandled rejected promises into errors so that the main thread will be
// notified about them.
self.onunhandledrejection = (e) => {
  throw e.reason ?? e;
};

function handleMessage(e) {
  try {
    if (e.data.cmd === 'load') { // Preload command that is called once per worker to parse and load the Emscripten code.
#if PTHREADS_DEBUG
      dbg('worker.js: loading module')
#endif
#if MINIMAL_RUNTIME
      var imports = {};
#endif

    // Until we initialize the runtime, queue up any further incoming messages.
    let messageQueue = [];
    self.onmessage = (e) => messageQueue.push(e);

    // And add a callback for when the runtime is initialized.
    self.startWorker = (instance) => {
#if MODULARIZE
      Module = instance;
#endif
      // Notify the main thread that this thread has loaded.
      postMessage({ 'cmd': 'loaded' });
      // Process any messages that were queued before the thread was ready.
      for (let msg of messageQueue) {
        handleMessage(msg);
      }
      // Restore the real message handler.
      self.onmessage = handleMessage;
    };

      // Module and memory were sent from main thread
#if MINIMAL_RUNTIME
#if MODULARIZE
      imports['wasm'] = e.data.wasmModule; // Pass the shared Wasm module in an imports object for the MODULARIZEd build.
#else
      Module['wasm'] = e.data.wasmModule; // Pass the shared Wasm module in the Module object for MINIMAL_RUNTIME.
#endif
#else
      Module['wasmModule'] = e.data.wasmModule;
#endif // MINIMAL_RUNTIME

#if MAIN_MODULE
      Module['dynamicLibraries'] = e.data.dynamicLibraries;
#endif

      // Use `const` here to ensure that the variable is scoped only to
      // that iteration, allowing safe reference from a closure.
      for (const handler of e.data.handlers) {
        Module[handler] = function() {
          postMessage({ cmd: 'callHandler', handler, args: [...arguments] });
        }
      }

      {{{ makeAsmImportsAccessInPthread('wasmMemory') }}} = e.data.wasmMemory;

#if LOAD_SOURCE_MAP
      Module['wasmSourceMapData'] = e.data.wasmSourceMap;
#endif
#if USE_OFFSET_CONVERTER
      Module['wasmOffsetData'] = e.data.wasmOffsetConverter;
#endif

      {{{ makeAsmImportsAccessInPthread('buffer') }}} = {{{ makeAsmImportsAccessInPthread('wasmMemory') }}}.buffer;

#if PTHREADS_DEBUG
      Module['workerID'] = e.data.workerID;
#endif

#if !MINIMAL_RUNTIME || MODULARIZE
      {{{ makeAsmImportsAccessInPthread('ENVIRONMENT_IS_PTHREAD') }}} = true;
#endif

#if MODULARIZE && EXPORT_ES6
      (e.data.urlOrBlob ? import(e.data.urlOrBlob) : import('./{{{ TARGET_JS_NAME }}}'))
      .then(exports => exports.default(Module));
#else
      if (typeof e.data.urlOrBlob == 'string') {
#if TRUSTED_TYPES
        if (typeof self.trustedTypes != 'undefined' && self.trustedTypes.createPolicy) {
          var p = self.trustedTypes.createPolicy('emscripten#workerPolicy3', { createScriptURL: function(ignored) { return e.data.urlOrBlob } });
          importScripts(p.createScriptURL('ignored'));
        } else
#endif
        importScripts(e.data.urlOrBlob);
      } else {
        var objectUrl = URL.createObjectURL(e.data.urlOrBlob);
#if TRUSTED_TYPES
        if (typeof self.trustedTypes != 'undefined' && self.trustedTypes.createPolicy) {
          var p = self.trustedTypes.createPolicy('emscripten#workerPolicy3', { createScriptURL: function(ignored) { return objectUrl } });
          importScripts(p.createScriptURL('ignored'));
        } else
#endif
        importScripts(objectUrl);
        URL.revokeObjectURL(objectUrl);
      }
#if MODULARIZE
#if MINIMAL_RUNTIME
      {{{ EXPORT_NAME }}}(imports);
#else
      {{{ EXPORT_NAME }}}(Module);
#endif
#endif
#endif // MODULARIZE && EXPORT_ES6
    } else if (e.data.cmd === 'run') {
      // Pass the thread address to wasm to store it for fast access.
      Module['__emscripten_thread_init'](e.data.pthread_ptr, /*isMainBrowserThread=*/0, /*isMainRuntimeThread=*/0, /*canBlock=*/1);

#if ASSERTIONS
      assert(e.data.pthread_ptr);
#endif
      // Also call inside JS module to set up the stack frame for this pthread in JS module scope
      Module['establishStackSpace']();
      Module['PThread'].receiveObjectTransfer(e.data);
      Module['PThread'].threadInitTLS();

      if (!initializedJS) {
#if EMBIND
#if PTHREADS_DEBUG
        dbg('Pthread 0x' + Module['_pthread_self']().toString(16) + ' initializing embind.');
#endif
        // Embind must initialize itself on all threads, as it generates support JS.
        // We only do this once per worker since they get reused
        Module['__embind_initialize_bindings']();
#endif // EMBIND

        // Execute any proxied work that came in before the thread was
        // initialized. Only do this once because it is only possible for
        // proxying notifications to arrive before thread initialization on
        // fresh workers.
        pendingNotifiedProxyingQueues.forEach(queue => {
          Module['executeNotifiedProxyingQueue'](queue);
        });
        pendingNotifiedProxyingQueues = [];
        initializedJS = true;
      }

      try {
        Module['invokeEntryPoint'](e.data.start_routine, e.data.arg);
      } catch(ex) {
        if (ex != 'unwind') {
          // ExitStatus not present in MINIMAL_RUNTIME
#if !MINIMAL_RUNTIME
          if (ex instanceof Module['ExitStatus']) {
            if (Module['keepRuntimeAlive']()) {
#if ASSERTIONS
              err('Pthread 0x' + Module['_pthread_self']().toString(16) + ' called exit(), staying alive due to noExitRuntime.');
#endif
            } else {
#if ASSERTIONS
              err('Pthread 0x' + Module['_pthread_self']().toString(16) + ' called exit(), calling _emscripten_thread_exit.');
#endif
              Module['__emscripten_thread_exit'](ex.status);
            }
          }
          else
#endif // !MINIMAL_RUNTIME
          {
            // The pthread "crashed".  Do not call `_emscripten_thread_exit` (which
            // would make this thread joinable.  Instead, re-throw the exception
            // and let the top level handler propagate it back to the main thread.
            throw ex;
          }
#if ASSERTIONS
        } else {
          // else e == 'unwind', and we should fall through here and keep the pthread alive for asynchronous events.
          err('Pthread 0x' + Module['_pthread_self']().toString(16) + ' completed its main entry point with an `unwind`, keeping the worker alive for asynchronous operation.');
#endif
        }
      }
    } else if (e.data.cmd === 'cancel') { // Main thread is asking for a pthread_cancel() on this thread.
      if (Module['_pthread_self']()) {
        Module['__emscripten_thread_exit']({{{ cDefine('PTHREAD_CANCELED') }}});
      }
    } else if (e.data.target === 'setimmediate') {
      // no-op
    } else if (e.data.cmd === 'processProxyingQueue') {
      if (initializedJS) {
        Module['executeNotifiedProxyingQueue'](e.data.queue);
      } else {
        // Defer executing this queue until the runtime is initialized.
        pendingNotifiedProxyingQueues.push(e.data.queue);
      }
    } else if (e.data.cmd) {
      // The received message looks like something that should be handled by this message
      // handler, (since there is a e.data.cmd field present), but is not one of the
      // recognized commands:
      err('worker.js received unknown command ' + e.data.cmd);
      err(e.data);
    }
  } catch(ex) {
#if ASSERTIONS
    err('worker.js onmessage() captured an uncaught exception: ' + ex);
    if (ex && ex.stack) err(ex.stack);
#endif
    if (Module['__emscripten_thread_crashed']) {
      Module['__emscripten_thread_crashed']();
    }
    throw ex;
  }
};

self.onmessage = handleMessage;
