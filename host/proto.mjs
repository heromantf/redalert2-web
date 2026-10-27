// Shared layout of the host's control memory (a SharedArrayBuffer apart from
// the wasm memory), between the process (run.mjs), the game-thread workers and
// the I/O worker.
//
// After nfsu2-web's web/src/host/proto.ts (MIT; see ../NOTICE.md): the same
// control block, RPC slots and operations, without its movie operations.

export const MAX_THREADS = 64;

// ctl: Int32Array over the control SAB
export const CTL_NEXT_TID = 0;       // next thread id handed out by thread-spawn
export const CTL_IO_DOORBELL = 1;    // bumped by a thread that posted an I/O request
export const CTL_EXIT = 2;           // 1 once the process exited (proc_exit / _start returned)
export const CTL_EXIT_CODE = 3;
export const CTL_SLEEP = 4;          // a word nobody notifies: Atomics.wait on it = sleep
export const CTL_TIMER_LATE = 5;     // how late a short timed wait wakes (µs), as the timer probe saw it lately (0: none)
export const CTL_POOL = 64;          // pool slot i: [CTL_POOL + 4*i + 0] state, +1 tid, +2 start arg
export const POOL_IDLE = 0, POOL_CLAIMED = 1, POOL_RUN_THREAD = 2, POOL_RUN_MAIN = -1;
export const CTL_INTS = CTL_POOL + 4 * MAX_THREADS + 64;

// rpc: one slot per pool slot (a thread only ever uses its own slot)
//   i32[0] state  (0 idle, 1 posted, 2 taken by the I/O worker, 3 done)
//   i32[1] op     i32[2] result (WASI errno)   i32[3] nargs
//   i64[2..9] args (BigInt64Array index 2 = byte 16)
export const RPC_SLOT = 256;
export const RPC_BYTES = RPC_SLOT * MAX_THREADS;
export const RPC_IDLE = 0, RPC_POSTED = 1, RPC_TAKEN = 2, RPC_DONE = 3;

// file operations forwarded to the I/O worker (WASI preview1 semantics)
export const Op = {
  FdClose: 1, FdRead: 2, FdPread: 3, FdWrite: 4, FdPwrite: 5, FdSeek: 6, FdTell: 7, FdSync: 8, FdFdstatGet: 9,
  FdFdstatSetFlags: 10, FdFilestatGet: 11, FdFilestatSetSize: 12, FdReaddir: 13, FdPrestatGet: 14,
  FdPrestatDirName: 15, FdAdvise: 16, FdAllocate: 17, PathOpen: 18, PathFilestatGet: 19, PathCreateDirectory: 20,
  PathRemoveDirectory: 21, PathUnlinkFile: 22, PathRename: 23, PathFilestatSetTimes: 24, FdFilestatSetTimes: 25,
  FdRenumber: 26,
};

// WASI errno values used by the host
export const E = {
  SUCCESS: 0, ACCES: 2, AGAIN: 6, BADF: 8, EXIST: 20, FAULT: 21, INVAL: 28, IO: 29, ISDIR: 31, MFILE: 33,
  NAMETOOLONG: 37, NOENT: 44, NOSPC: 51, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, PERM: 63, ROFS: 69, SPIPE: 70,
};
