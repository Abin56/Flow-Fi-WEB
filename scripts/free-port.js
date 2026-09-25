const { execSync } = require("child_process");

const port = process.env.PORT || 3000;

try {
  const output = execSync(`netstat -ano -p tcp`, { encoding: "utf8" });
  const pids = new Set();

  for (const line of output.split("\n")) {
    const match = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (match && Number(match[1]) === Number(port)) {
      pids.add(match[2]);
    }
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      console.log(`Freed port ${port} (killed PID ${pid})`);
    } catch {
      // process already gone
    }
  }
} catch {
  // netstat unavailable or no matches; nothing to do
}
