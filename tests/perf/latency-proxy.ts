/**
 * Test-only TCP proxy that delays every chunk by a fixed one-way latency, so a localhost Firestore
 * emulator behaves like a remote backend (round trip ≈ 2 × oneWayMs). Equal timers fire in order, so
 * per-direction ordering is preserved. Used only by tests/perf; never part of the app.
 */
import net from "node:net";

export interface LatencyProxy {
  port: number;
  close: () => Promise<void>;
}

export function startLatencyProxy(listenPort: number, targetPort: number, oneWayMs: number): Promise<LatencyProxy> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    const pipe = (from: net.Socket, to: net.Socket) => {
      from.on("data", (chunk) => {
        setTimeout(() => {
          if (!to.destroyed) to.write(chunk);
        }, oneWayMs);
      });
      from.on("end", () => setTimeout(() => !to.destroyed && to.end(), oneWayMs));
      from.on("error", () => to.destroy());
    };
    pipe(client, upstream);
    pipe(upstream, client);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  return new Promise((resolve) => {
    server.listen(listenPort, "127.0.0.1", () =>
      resolve({
        port: listenPort,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}
