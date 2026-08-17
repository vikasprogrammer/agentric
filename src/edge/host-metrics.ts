/**
 * HOST METRICS — the box's own CPU/RAM pressure, for the console's sidebar chip.
 *
 * Why the OS needs to show this at all: a governed effect is only as fast as the box under it. When a
 * live tenant went "suddenly slow" — every gate check, task write and console load seconds late — the
 * cause was 86 leaked ttyd processes pinning 12 cores (load 92), and NOTHING in the product said so. The
 * console reported healthy sessions on a box that was 8x oversubscribed. One number next to the version
 * turns that from an ssh investigation into a glance.
 *
 * `cpu` is real utilisation, not load: we diff `os.cpus()` tick counters between calls, so the answer is
 * "percent of all cores busy since you last asked". `load` rides along because the two diverge in the way
 * that matters — a fork-bomb of short-lived processes shows modest CPU and enormous load, which is exactly
 * the shape a process leak has.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';

/** How long an available-memory reading is reused, so a room full of open tabs can't exec `vm_stat` per poll. */
const MEM_TTL_MS = 5_000;
let memCache: { at: number; availableBytes: number } | undefined;

/**
 * Bytes of memory that could be handed to a new process — NOT `os.freemem()`.
 *
 * `os.freemem()` counts only pages that are free RIGHT NOW, which on a healthy box is almost none: both
 * kernels spend spare RAM on reclaimable file cache on purpose. It reads as an emergency on a machine with
 * plenty of headroom. Measured while writing this: the Mac Mini reported `freemem` 0.08 GB of 24 GB — the
 * chip said **98% ram** — while `memory_pressure` put actual availability at 59%. instawp is the same story
 * from the other side: `free -g` shows 6 GB free but 46 GB *available* of 62 GB, so `freemem` would claim
 * 90% used where the kernel says 26%.
 *
 * So ask each kernel for its own availability estimate:
 *   - **Linux**: `MemAvailable` in /proc/meminfo — the kernel's own answer, no parsing heuristics.
 *   - **macOS**: `vm_stat` pages that are free or reclaimable (free + inactive + speculative + purgeable).
 *   - anything else: fall back to `os.freemem()` and accept the pessimism.
 */
export function availableBytes(): number {
  const cached = memCache;
  if (cached && Date.now() - cached.at < MEM_TTL_MS) return cached.availableBytes;
  let available = os.freemem();
  try {
    if (process.platform === 'linux') {
      const m = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (m) available = Number(m[1]) * 1024;
    } else if (process.platform === 'darwin') {
      const r = spawnSync('vm_stat', [], { encoding: 'utf8' });
      if (!r.error && r.status === 0 && r.stdout) {
        const pageSize = Number(/page size of (\d+) bytes/.exec(r.stdout)?.[1] ?? 4096);
        const pages = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)\\.`).exec(r.stdout)?.[1] ?? 0);
        const reclaimable = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
        if (reclaimable > 0) available = reclaimable * pageSize;
      }
    }
  } catch {
    // keep the os.freemem() fallback — a metric must never throw into a request handler
  }
  memCache = { at: Date.now(), availableBytes: available };
  return available;
}

export interface HostMetrics {
  /** Busy percent across all cores since the previous sample (0-100). `null` on the first call. */
  cpu: number | null;
  /** In-use memory percent (0-100), where "in use" = total minus what the kernel calls AVAILABLE. */
  mem: number;
  /** Available (allocatable/reclaimable) memory in MB — the raw number behind `mem`. */
  availableMemMb: number;
  /** 1-minute load average per core — 1.0 means "as much runnable work as cores". */
  load: number;
  cores: number;
  totalMemMb: number;
}

let prev: { idle: number; total: number } | undefined;

function cpuTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const [k, v] of Object.entries(c.times)) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total };
}

export function hostMetrics(): HostMetrics {
  const now = cpuTicks();
  let cpu: number | null = null;
  if (prev) {
    const dTotal = now.total - prev.total;
    const dIdle = now.idle - prev.idle;
    // A zero delta means two samples inside the same tick — report the previous answer's absence rather
    // than dividing by zero into a fake 0%/100%.
    if (dTotal > 0) cpu = Math.min(100, Math.max(0, Math.round(((dTotal - dIdle) / dTotal) * 100)));
  }
  prev = now;
  const total = os.totalmem();
  const available = Math.min(total, availableBytes());
  return {
    cpu,
    mem: Math.round(((total - available) / total) * 100),
    availableMemMb: Math.round(available / 1048576),
    load: Math.round((os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100) / 100,
    cores: os.cpus().length,
    totalMemMb: Math.round(total / 1048576),
  };
}
