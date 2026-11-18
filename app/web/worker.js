// app/worker.js — hosts the C app (app.js + app.wasm) in a module worker.
//
// Started by dom/main.js. It loads the Emscripten module, asks the C side to
// create the bridge block, sends the page the shared memory and the block's
// address, and then hands this thread over to the C run loop for good.
//
// Messages to the page:
//   {type: 'ready', memory: SharedArrayBuffer, bridgePtr: number}
//   {type: 'error', message: string}
// Messages from the page: none. Once app_run() starts, this worker never
// returns to its event loop, so it could not receive them anyway; all input
// reaches the app through the bridge block.

import createApp from './app.js';

function fail(err) {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  console.error('[app]', message);
  self.postMessage({ type: 'error', message: `app worker: ${message}` });
}

try {
  const app = await createApp({
    // C's stdout / stderr, one line per call. These are synchronous console
    // calls, so they keep working while the C loop below owns the thread.
    print: (line) => console.log('[app]', line),
    printErr: (line) => console.error('[app]', line),
  });

  // wasm returns pointers as signed 32-bit numbers; make it unsigned.
  const bridgePtr = app._app_start() >>> 0;
  if (bridgePtr === 0) {
    throw new Error('app_start() failed to create the bridge block (see console)');
  }

  const memory = app.wasmMemory.buffer;
  if (!(memory instanceof SharedArrayBuffer)) {
    throw new Error('the app memory is not shared; was it built with -pthread?');
  }

  self.postMessage({ type: 'ready', memory, bridgePtr });

  // Blocks forever: wakes once per rendered frame, steps, sleeps again.
  // Returning (or throwing) means the app stopped.
  app._app_run();
  throw new Error('app_run() returned');
} catch (err) {
  fail(err);
}
