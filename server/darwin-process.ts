/**
 * What macOS's kernel keeps about a process, read in the server's own thread through libSystem:
 * `ps` asked the same kernel, but as a child the event loop had to wait for, and that wait stalled
 * every connection (#1404). Each read takes microseconds and never starts a process.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

/** libSystem's sysctl(3) and devname(3), opened once, on macOS only. */
let libSystem: ReturnType<typeof openLibSystem> | undefined;

function openLibSystem() {
  // a system library's C functions: nothing native of node's is loaded into Bun
  return dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    devname: { args: [FFIType.i32, FFIType.u16], returns: FFIType.cstring },
  }).symbols;
}

/** sysctl(3) for `name`, into `out`: the answer's length, or null when the call failed. */
export function sysctlCall(): (name: Int32Array, out: Uint8Array) => number | null {
  const symbols = libSystem ??= openLibSystem();
  return (name, out) => {
    const size = new BigUint64Array([BigInt(out.byteLength)]);
    return symbols.sysctl(ptr(name), name.length, ptr(out), ptr(size), null, 0) === 0 ? Number(size[0]) : null;
  };
}

/** kern.proc.pid begins with extern_proc.p_starttime, a 64-bit Darwin timeval. */
export function procStartTime(answer: Uint8Array): bigint | null {
  if (answer.byteLength < 16) return null;
  const view = new DataView(answer.buffer, answer.byteOffset, answer.byteLength);
  const seconds = view.getBigInt64(0, true);
  const micros = view.getInt32(8, true);
  return seconds > 0n && micros >= 0 && micros < 1_000_000 ? seconds * 1_000_000n + BigInt(micros) : null;
}

/** Where kinfo_proc keeps kp_eproc.e_tdev, the controlling terminal's device (648-byte kinfo_proc, arm64 and x86_64). */
const E_TDEV_OFFSET = 572;
/** dev_t's NODEV: the process has no controlling terminal (`ps` prints `??`). */
const NODEV = -1;

/** The controlling terminal's device in a kern.proc.pid answer, or null when it has none. */
export function procTerminalDevice(answer: Uint8Array): number | null {
  if (answer.byteLength < E_TDEV_OFFSET + 4) return null;
  const device = new DataView(answer.buffer, answer.byteOffset, answer.byteLength).getInt32(E_TDEV_OFFSET, true);
  return device === NODEV ? null : device;
}

/** CTL_KERN, KERN_PROC, KERN_PROC_PID: the process's kinfo_proc, empty when no such process runs. */
function kinfoProc(pid: number): Uint8Array | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const answer = new Uint8Array(4096);
  const length = sysctlCall()(new Int32Array([1, 14, 1, pid]), answer);
  return length === null ? null : answer.subarray(0, length);
}

/** The kernel's process birth time in microseconds, including those `ps -o lstart` drops. */
export function darwinStartTime(pid: number): bigint | null {
  const answer = kinfoProc(pid);
  return answer === null ? null : procStartTime(answer);
}

/** A character device's name under /dev (`ttys003`), or null when it has none. */
function deviceName(device: number): string | null {
  const symbols = libSystem ??= openLibSystem();
  const name = symbols.devname(device, 0o020000); // S_IFCHR
  return name === null ? null : String(name) || null;
}

/**
 * The process's controlling terminal under /dev (`ttys003`, as `ps -o tty=` prints it) and its start
 * in ms, both from one kinfo_proc: two reads could describe two processes when the PID is reused
 * between them. Null when no such process runs or it has no terminal. `read` and `name` stand in for
 * the kernel in tests.
 */
export function darwinTerminal(
  pid: number,
  read: (pid: number) => Uint8Array | null = kinfoProc,
  name: (device: number) => string | null = deviceName,
): { tty: string; startedAt: number } | null {
  const answer = read(pid);
  if (answer === null) return null;
  const started = procStartTime(answer);
  const device = procTerminalDevice(answer);
  const tty = started === null || device === null ? null : name(device);
  return tty === null ? null : { tty, startedAt: Number(started! / 1000n) };
}
